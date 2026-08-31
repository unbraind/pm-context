/**
 * Tokenises shell text into the commands it would actually run.
 *
 * A guard that decides "does any publish here omit `--provenance`" is only as
 * good as its idea of what a command is. The previous scan answered that
 * question with a regular expression: it blanked every quoted span so an
 * advisory `echo "npm publish"` could not read as an invocation, then split the
 * remainder on `&&`, `||`, `;` and a space-surrounded `|`.
 *
 * Both halves of that shortcut are wrong in the same direction -- they make the
 * gate report a pass it has not earned:
 *
 * - Blanking quoted spans deletes the argument being audited. `npm publish
 *   "--provenance"` runs with an attestation but scans as one without, and the
 *   reverse case is worse: `eval "npm publish"` and `bash -c 'npm publish'` are
 *   real unattested publishes that vanish entirely, leaving a conventional
 *   attested sibling elsewhere in the file to carry the audit to green.
 * - Splitting on three operators misses a backgrounding `&`, a pipe written
 *   without surrounding spaces (`true|npm publish`), and command substitution.
 *
 * So the text is tokenised the way a shell does it -- quotes resolved rather
 * than erased, operators recognised as operators, `$(...)`, backticks, `eval`
 * and `sh -c` payloads recursed into -- and each command records whether its
 * words were quoted. Nothing downstream has to guess.
 *
 * This is deliberately not a shell. It does not expand variables, globs or
 * arithmetic, and it does not track redirections. It exists to enumerate
 * candidate command invocations for auditing, where missing one is a security
 * failure and inventing one is merely noise.
 *
 * @packageDocumentation
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One word of a command, after quote resolution. */
export interface ShellToken {
  /** The word's text with its quoting removed. */
  value: string;
  /** True when any part of the word came from inside quotes. */
  quoted: boolean;
  /**
   * True when the word's FIRST character came from inside quotes.
   *
   * `quoted` alone cannot tell an assignment apart from a literal that merely
   * looks like one. `NPM_CONFIG_REGISTRY="https://example"` is a real
   * assignment whose value happens to be quoted, while `"FOO=bar"` is a single
   * quoted word that the shell does not treat as an assignment at all. Both set
   * `quoted`; only the second starts inside quotes.
   */
  startsQuoted: boolean;
}

/** One simple command: the words it would run, in order. */
export type ShellCommand = ShellToken[];

/**
 * Words that precede a command without being the command.
 *
 * `env FOO=bar npm publish` runs npm, not env, so a scan that reads the first
 * word as the command name would classify it as an `env` invocation and let the
 * publish through unaudited.
 *
 * The package runners (`npx`, `bunx`, `pnpx`) belong here for the same reason,
 * and they bring their own options: `npx --yes npm publish` runs npm behind two
 * words, not one. Option words following a prefix are therefore skipped too --
 * see `skipCommandPrefix`, which is where that rule is applied and bounded.
 *
 * Runners spelled as two words live in `TWO_WORD_PREFIXES` instead, because
 * their head word is only a wrapper in combination with the word after it.
 */
const COMMAND_PREFIXES = new Set([
  "env",
  "exec",
  "nohup",
  "command",
  "builtin",
  "sudo",
  "doas",
  "nice",
  "ionice",
  "time",
  "stdbuf",
  "setsid",
  "xargs",
  "npx",
  "bunx",
  "pnpx",
  "corepack",
  // Shell keywords introduce a command rather than being one. `if npm publish`
  // runs npm; a scan that reads `if` as the program audits nothing.
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
  "(",
]);

/**
 * Wrappers spelled as two words, mapped to the second word that completes them.
 *
 * `pnpm dlx npm publish` runs npm, but `pnpm publish` runs pnpm's own publish
 * and `pnpm install` runs no wrapper at all. Consuming the head word
 * unconditionally would therefore re-point an unrelated `pnpm` command at its
 * first argument, so the pair is only consumed when the second word matches.
 */
const TWO_WORD_PREFIXES = new Map([
  ["npm", new Set(["exec", "x"])],
  ["pnpm", new Set(["dlx", "exec"])],
  ["yarn", new Set(["dlx", "exec"])],
  ["bun", new Set(["x", "run"])],
]);

/**
 * Reduce a program word to the name it runs.
 *
 * `/usr/local/bin/npm publish` runs npm, so a check against the whole word
 * would miss it. `String.prototype.split` always yields at least one element,
 * including for the empty string, so no fallback is needed or reachable here.
 *
 * @param word - The program word as written.
 * @returns The final path segment.
 */
function basename(word: string): string {
  const segments = word.split("/");
  return segments[segments.length - 1]!;
}

/** Commands whose string argument is itself shell text to be scanned. */
const SHELL_EVALUATORS = new Set(["eval", "bash", "sh", "dash", "zsh", "ksh"]);

/** True when the character ends a word outside of quotes. */
function isOperatorStart(character: string): boolean {
  return character === ";"
    || character === "&"
    || character === "|"
    || character === "\n"
    || character === "("
    || character === ")"
    || character === "{"
    || character === "}";
}

/**
 * Read a `$(...)` or backtick substitution and return its inner text.
 *
 * Nesting is counted so `$(echo $(npm publish))` yields the whole inner body
 * rather than stopping at the first `)`; a truncated body would drop the
 * invocation it contains.
 *
 * @param text - The full text being scanned.
 * @param start - Index of the character that opens the substitution.
 * @returns The inner text and the index just past the closing delimiter.
 */
function readSubstitution(text: string, start: number): { inner: string; end: number } {
  if (text[start] === "`") {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === "`") {
        return {
          inner: text.slice(start + 1, index).replace(/\\`/g, "`"),
          end: index + 1,
        };
      }
      index += 1;
    }
    return { inner: text.slice(start + 1), end: text.length };
  }
  // A parenthesis inside quotes is a literal, not a delimiter. Counting it
  // closes the substitution early and truncates the body, so
  // `$(echo ")" && npm publish)` loses the publish entirely.
  let depth = 1;
  let index = start + 2;
  let single = false;
  let double = false;
  while (index < text.length && depth > 0) {
    const character = text[index]!;
    if (character === "\\") index += 2;
    else {
      // Quote state follows shell semantics across line breaks. A quoted
      // parenthesis after a newline is still literal, so resetting either
      // state here would truncate the substitution and hide later commands.
      if (character === "'" && !double) single = !single;
      else if (character === '"' && !single) double = !double;
      else if (!single && !double && character === "(") depth += 1;
      else if (!single && !double && character === ")") depth -= 1;
      if (depth === 0) break;
      index += 1;
    }
  }
  return { inner: text.slice(start + 2, index), end: index + 1 };
}

/**
 * Split shell text into the simple commands it contains.
 *
 * Command substitutions are scanned as well as the command containing them,
 * because `VERSION=$(npm publish)` runs a publish however unusual that is, and a
 * gate that only looked at the outer assignment would miss it.
 *
 * `eval`, `bash -c` and their siblings receive the same treatment one level
 * deeper: their string argument is re-tokenised, so a publish smuggled through
 * an interpreter is enumerated alongside a plain one. Recursion is bounded --
 * shell text that nests evaluators more than a handful of levels deep is not
 * something this repository writes, and an unbounded walk over hostile input is
 * a denial of service rather than a stronger audit.
 *
 * @param text - Shell text, typically one file or one manifest script body.
 * @param depth - Current evaluator recursion depth; callers pass nothing.
 * @returns Every simple command found, outermost first.
 */
export function tokenizeCommands(text: string, depth = 0): ShellCommand[] {
  if (depth > 8) return [];
  const commands: ShellCommand[] = [];
  const nested: string[] = [];
  let command: ShellCommand = [];
  let value = "";
  let quoted = false;
  let startsQuoted = false;
  let started = false;

  const endWord = (): void => {
    if (!started) return;
    command.push({ value, quoted, startsQuoted });
    value = "";
    quoted = false;
    startsQuoted = false;
    started = false;
  };
  const endCommand = (): void => {
    endWord();
    if (command.length > 0) commands.push(command);
    command = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "#" && !started) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      endCommand();
      continue;
    }
    if (character === "\\") {
      const next = text[index + 1];
      index += 1;
      if (next === undefined) break;
      if (next === "\n") continue;
      value += next;
      if (!started) startsQuoted = false;
      started = true;
      continue;
    }
    if (character === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      value += text.slice(index + 1, end);
      quoted = true;
      if (!started) startsQuoted = true;
      started = true;
      index = end;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        const inner = text[index]!;
        if (inner === "\\") {
          const next = text[index + 1];
          if (next !== undefined) {
            if (next !== "\n") value += next;
            index += 2;
            continue;
          }
          index += 1;
          continue;
        }
        if (inner === "`" || (inner === "$" && text[index + 1] === "(")) {
          const { inner: body, end } = readSubstitution(text, index);
          nested.push(body);
          index = end;
          continue;
        }
        value += inner;
        index += 1;
      }
      quoted = true;
      if (!started) startsQuoted = true;
      started = true;
      continue;
    }
    if (character === "`" || (character === "$" && text[index + 1] === "(")) {
      const { inner, end } = readSubstitution(text, index);
      nested.push(inner);
      index = end - 1;
      if (!started) startsQuoted = false;
      started = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      endWord();
      continue;
    }
    if (isOperatorStart(character)) {
      // `2>&1` is one redirection, not a command ended by a backgrounding `&`.
      // The `&` belongs to the word only while that word is still an operator
      // awaiting its target.
      if (character === "&" && /^[0-9]*[<>]>?$/.test(value)) {
        value += character;
        started = true;
        continue;
      }
      endCommand();
      continue;
    }
    value += character;
    if (!started) startsQuoted = false;
    started = true;
  }
  endCommand();

  for (const body of nested) commands.push(...tokenizeCommands(body, depth + 1));
  for (const found of [...commands]) {
    // A wrapper option can make the first reading point at its value rather
    // than the real evaluator: `sudo -u root bash -c 'npm publish'`. Audit
    // every possible reading so evaluator recursion cannot be skipped by the
    // same ambiguity that commandCandidates exists to close.
    for (const candidate of commandCandidates(found)) {
      const name = commandName(candidate);
      if (name === undefined || !SHELL_EVALUATORS.has(name)) continue;
      // The shell joins an evaluator's words with a space and evaluates the
      // result, so `eval "npm pub" "lish"` runs a publish that scanning each
      // argument on its own never sees.
      const payload = candidate.slice(1)
        .filter((argument) => !argument.value.startsWith("-"))
        .map((argument) => argument.value);
      for (const body of new Set([...payload, payload.join(" ")])) {
        commands.push(...tokenizeCommands(body, depth + 1));
      }
    }
  }
  return commands;
}

/**
 * True when an unquoted word is a redirection operator rather than a command word.
 *
 * A redirection and its target are not part of the command the shell runs, so
 * `> /dev/null npm publish` runs npm. A scan that reads words in order sees `>`
 * as the program and audits nothing. The forms accepted here are the ones a
 * workflow actually writes: the plain operators, a file-descriptor prefix
 * (`2>`, `2>>`), the duplicating forms (`>&`, `2>&1`, `&>`), and the read-write
 * form `<>`. `<>` has to be named explicitly: it is not `<` followed by `>`, so
 * without it the operator was read as a joined redirection that consumes no
 * target, its target `/dev/null` became the command word, and the real
 * `npm publish` after it was never audited.
 *
 * @param token - One command word.
 * @returns True when the word is a redirection operator.
 */
function isRedirection(token: ShellToken): boolean {
  if (token.startsQuoted) return false;
  return /^(?:[0-9]*(?:>>?|<>|<<?<?)&?[0-9-]*|&>>?)$/.test(token.value);
}

/**
 * Drop a command's redirections, so only the words it runs remain.
 *
 * An operator written apart from its target (`> file`) consumes the word after
 * it; one written joined to it (`>file`, `2>&1`) consumes nothing further.
 *
 * @param command - One simple command's tokens.
 * @returns The command without its redirections.
 */
function withoutRedirections(command: ShellCommand): ShellCommand {
  const kept: ShellCommand = [];
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    if (!isRedirection(token)) {
      // A joined form such as `>file` or `2>&1` is one word and takes no target.
      if (!token.startsQuoted && /^(?:[0-9]*>>?|[0-9]*<<?<?|&>>?)[^\s]/.test(token.value)) continue;
      kept.push(token);
      continue;
    }
    // A bare operator takes the next word as its target.
    if (!/&[0-9-]$/.test(token.value)) index += 1;
  }
  return kept;
}

/**
 * Walk past the words that precede the program a command runs.
 *
 * Three kinds of word are not the program: a leading `NAME=value` assignment, a
 * wrapper listed in `COMMAND_PREFIXES`, and -- only once a wrapper has been
 * seen -- that wrapper's own options. The last rule is what reaches the publish
 * in `npx --yes npm publish`; it stays behind the wrapper condition so that a
 * command whose own first word is an option is still reported as written rather
 * than silently re-pointed at one of its arguments.
 *
 * An option's separate value (`sudo -u root npm publish`) is not skipped,
 * because which options take a value differs per wrapper, and guessing wrong
 * would move the reported program rather than merely widen the search.
 *
 * @param command - One simple command's tokens.
 * @returns The index of the program word, or the command's length when there is none.
 */
function skipCommandPrefix(command: ShellCommand): number {
  let index = 0;
  let sawPrefix = false;
  while (index < command.length) {
    const token = command[index]!;
    if (!token.startsQuoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      index += 1;
      continue;
    }
    const base = basename(token.value);
    if (COMMAND_PREFIXES.has(base)) {
      sawPrefix = true;
      index += 1;
      continue;
    }
    const second = command[index + 1];
    if (second !== undefined && TWO_WORD_PREFIXES.get(base)?.has(second.value) === true) {
      sawPrefix = true;
      index += 2;
      continue;
    }
    if (sawPrefix && !token.startsQuoted && token.value.startsWith("-")) {
      index += 1;
      continue;
    }
    // A YAML key carries the command as its value: `run: npm publish` runs npm,
    // and reading `run:` as the program audits nothing. Workflow files are
    // scanned as raw text, so the key is a word like any other. Only a leading
    // key is consumed, and only one, so an argument that merely ends in a colon
    // is untouched.
    // A YAML list marker precedes the key on the same line: `- run: npm publish`.
    if (index === 0 && !token.startsQuoted && token.value === "-") {
      sawPrefix = true;
      index += 1;
      continue;
    }
    if (index <= 1 && !token.startsQuoted && /^[A-Za-z_][A-Za-z0-9_-]*:$/.test(token.value)) {
      sawPrefix = true;
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

/**
 * Name the program a command runs, or nothing when it runs none.
 *
 * Leading `NAME=value` assignments and wrapper words are skipped, and a path is
 * reduced to its basename so `/usr/local/bin/npm publish` is recognised. The
 * distinction this exists to draw is command *position*: `echo npm publish`
 * prints three words and publishes nothing, while the previous scan searched
 * the whole line for the word `npm` and counted it as an invocation.
 *
 * @param command - One simple command's tokens.
 * @returns The program's basename, or undefined for an empty or assignment-only command.
 */
export function commandName(input: ShellCommand): string | undefined {
  const command = withoutRedirections(input);
  const token = command[skipCommandPrefix(command)];
  return token === undefined ? undefined : basename(token.value);
}

/**
 * Enumerate every reading of a command that could name a program.
 *
 * `commandName` answers "what does this command run" and answers it once. That
 * is right for reporting and wrong for auditing, because a wrapper's options
 * are not all known: `sudo -u root npm publish` stops at `root`, since `-u`
 * takes a value and nothing here knows that. Enumerating the value-taking
 * options of every wrapper would be a list that silently goes stale, and each
 * omission is a publish that disappears from the audit.
 *
 * So once a wrapper has been consumed, every later word is also offered as a
 * possible program, with the words after it as its arguments. An auditor asking
 * "does any publish here lack an attestation" then cannot miss one behind a
 * wrapper option it has never heard of.
 *
 * The cost is noise, never a miss: `sudo -u npm publish` -- a user actually
 * named `npm` -- is offered as a publish that no shell would run. For a gate
 * whose failure mode is an unattested release, a spurious finding an operator
 * dismisses is the cheaper error.
 *
 * A command with no wrapper yields exactly one reading, so ordinary commands
 * are unaffected.
 *
 * @param command - One simple command's tokens.
 * @returns Each candidate reading, the command's own first.
 */
export function commandCandidates(input: ShellCommand): ShellCommand[] {
  const command = withoutRedirections(input);
  const start = skipCommandPrefix(command);
  const candidates: ShellCommand[] = [];
  if (start < command.length) candidates.push(command.slice(start));
  if (start === 0) return candidates;
  for (let index = start + 1; index < command.length; index += 1) {
    const token = command[index]!;
    if (token.value.startsWith("-")) continue;
    candidates.push(command.slice(index));
  }
  return candidates;
}

/**
 * List a command's arguments -- everything after its program name.
 *
 * @param command - One simple command's tokens.
 * @returns The argument tokens, in order.
 */
export function commandArguments(input: ShellCommand): ShellToken[] {
  const command = withoutRedirections(input);
  return command.slice(skipCommandPrefix(command) + 1);
}

/** A tracked file's path and contents. */
export interface SourceFile {
  /** Repository-relative path. */
  file: string;
  /** File contents. */
  text: string;
}

/**
 * Collapse shell and YAML line continuations so one logical command is one string.
 *
 * A backslash at end of line joins the next line; without this every multi-line
 * invocation looks like a set of fragments, none of which carries both the
 * version input and the date flag.
 *
 * @param text - Raw file contents.
 * @returns The same text with continuations joined.
 */
export function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, " ");
}

/** A `run:` block-scalar header: the key, an indicator, and nothing else. */
const RUN_BLOCK_HEADER =
  /^([ \t]*)(?:-[ \t]+)?run:[ \t]*[|>][+-]?(?:[ \t]+#.*)?\r?$/;

/** Leading whitespace, which YAML never mixes between a block and its parent. */
const LEADING_WHITESPACE = /^[ \t]*/;

/** A line that is blank, including the carriage return a CRLF file leaves. */
const BLANK_LINE = /^[ \t\r]*$/;

/**
 * Strip the YAML block indentation from `run:` block scalars.
 *
 * GitHub Actions takes a `run:` block's text, removes the indentation YAML
 * gave it, and hands the result to bash -- so the shell never sees the leading
 * whitespace the raw workflow file carries. The scanner reads the raw file,
 * and exactly one of its rules is whitespace-sensitive: a heredoc terminator
 * is recognised only at the start of the line the shell sees. A terminator
 * compared against a YAML-indented line therefore never matches, the heredoc
 * swallows the rest of the file, every later assignment is payload, and a
 * `$NPM publish` after the heredoc is omitted from the audit while an
 * attested sibling elsewhere satisfies the non-vacuity guard -- the scan
 * reports clean over an unattested publish.
 *
 * Dedenting the block content restores the text bash actually receives. Every
 * other rule in the scanner already tolerates leading whitespace
 * (`STANDALONE_ASSIGNMENT` opens with `^[ \t]*`, control closers and function
 * openers are matched against trimmed syntax, a comment starts after any
 * separator or whitespace, and `bashArrays` anchors on a word boundary), so
 * this function changes nothing else about what the scanner sees.
 *
 * Only `run:` blocks are dedented, because `run` is the key GitHub Actions
 * executes; a block scalar under any other key is data no shell runs, and
 * stripping its indentation would be rewriting prose. The block's indentation
 * is learned from its first non-blank line, as YAML itself learns it, a line
 * keeps any indentation beyond the block's own, and the block ends at the
 * first non-blank line indented less -- which is where YAML ends it too. A
 * `run:`-shaped line inside another block's content is content, not a header,
 * because the scanner walks the file once, forward, consuming each block
 * before looking for the next.
 *
 * @param text - A workflow file's raw contents.
 * @returns The same text with each `run:` block's content dedented.
 */
export function dedentRunBlocks(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = RUN_BLOCK_HEADER.exec(lines[index]!);
    if (header === null) {
      output.push(lines[index]!);
      index += 1;
      continue;
    }
    // The block's indentation comes from its first non-blank line, so blank
    // lines between the header and the content decide nothing here.
    let content = index + 1;
    while (content < lines.length && BLANK_LINE.test(lines[content]!)) content += 1;
    // A header with no more-indented line after it holds an empty block: YAML
    // ends it immediately, and so does this scan.
    const indent = content < lines.length ? LEADING_WHITESPACE.exec(lines[content]!)![0] : "";
    if (indent.length <= header[1]!.length) {
      output.push(lines[index]!);
      index += 1;
      continue;
    }
    output.push(lines[index]!);
    index += 1;
    while (index < lines.length) {
      const body = lines[index]!;
      // A blank line is block content YAML keeps as an empty line; anything
      // else must carry the block's own indentation to belong to it.
      if (!BLANK_LINE.test(body) && !body.startsWith(indent)) break;
      output.push(BLANK_LINE.test(body) ? body : body.slice(indent.length));
      index += 1;
    }
  }
  return output.join("\n");
}

/**
 * Index bash array assignments so a shared options array can be expanded.
 *
 * The release workflows declare `common=( ... )` once and pass `"${common[@]}"`
 * to each invocation, precisely so the invocations cannot drift. A scan that
 * reads only the invocation line therefore sees none of the shared flags.
 *
 * @param text - File contents with continuations already joined.
 * @returns Array name mapped to the flag text it holds.
 */
export function bashArrays(text: string): Map<string, string> {
  const arrays = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=\(([\s\S]*?)\)/g)) {
    arrays.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return arrays;
}

/**
 * Shell list/pipe operator characters that separate commands.
 *
 * `;`, `&` and `|` are the characters that end one command and begin another
 * on the same line. Enumerating them once keeps every place that terminates a
 * token in step: a hand-listed subset in one place and a complete set in
 * another is exactly how `NPM=npm && true` went unindexed and how
 * `fi&&echo done` left a stale control scope.
 */
const OPERATOR_CHARS = ";&|";
/**
 * Characters that end a shell token: whitespace, an operator, or a comment.
 *
 * Used after a control closer (`fi`, `done`, `esac`, `}`) to decide whether the
 * closer was actually reached. A closer followed by `&&` or `||` is still a
 * closer, and excluding `&` or `|` from this set is the bug that left a stale
 * scope suppressing later file-scope assignments.
 */
const SEPARATORS = `[\\s${OPERATOR_CHARS}#]`;

/** A line opening with one assignment of a fully literal value, ending at a separator. */
const STANDALONE_ASSIGNMENT =
  new RegExp(`^[ \\t]*(?:export[ \\t]+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:\\\\.|[^"\\\\$\`])*)"|'([^']*)'|((?:\\\\.|[^\\s${OPERATOR_CHARS}"'\`$()\\\\])+))(?:[ \\t]*[${OPERATOR_CHARS}]|[ \\t]+#.*|[ \\t]*\\r?$)`);

/** One word read as an assignment: the name, and the value when it is literal. */
interface AssignmentWord {
  /** The variable name the word assigns. */
  readonly name: string;
  /**
   * The value with quoting resolved, or nothing when the word assigns a name
   * whose value this scanner cannot reproduce exactly.
   */
  readonly value: string | undefined;
  /** True for `NAME+=value`, whose result depends on the binding it appends to. */
  readonly append: boolean;
}

/** One assignment word: an optional append marker, then a value of any form. */
const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=(.*)$/;

/** A double-quoted value: no expansions, backslashes only before specials. */
const DOUBLE_QUOTED_VALUE = /^"((?:\\.|[^"\\$\`])*)"$/;

/** A single-quoted value: every character is literal, including backslashes. */
const SINGLE_QUOTED_VALUE = /^'([^']*)'$/;

/** An unquoted value: escapes allowed, no shell syntax the scanner re-reads. */
const UNQUOTED_VALUE = /^(?:\\.|[^\s;&|"'\`$()\\])*$/;

/** Characters that would become scanner syntax if a value were inlined. */
const VALUE_SYNTAX = /[$\`"'();&#|<>{}]/;

/**
 * Read one word as a shell assignment, or nothing when it is not one.
 *
 * The grammar is the one `STANDALONE_ASSIGNMENT` applies to a whole line,
 * reduced to the single word a command actually holds: a name, an optional
 * `+` append marker, and a value that is fully double-quoted, fully
 * single-quoted, or unquoted. A word that merely starts inside quotes is not
 * an assignment at all (`"NPM=npm"` is a command name), and a value that
 * mixes forms or carries an expansion is still an assignment -- the shell
 * binds the name -- but one whose value is reported as not literal, because
 * inlining a value the scanner cannot reproduce exactly is how a publish
 * reads as attested when it is not.
 *
 * @param raw - The word exactly as written, quoting and escapes included.
 * @param startsQuoted - True when the word's first character was inside quotes.
 * @returns The assignment the word performs, or nothing for a non-assignment.
 */
function parseAssignmentWord(raw: string, startsQuoted: boolean): AssignmentWord | undefined {
  if (startsQuoted) return undefined;
  const match = ASSIGNMENT_WORD.exec(raw);
  if (match === null) return undefined;
  const text = match[3]!;
  let value: string | undefined;
  const doubleQuoted = DOUBLE_QUOTED_VALUE.exec(text);
  const singleQuoted = SINGLE_QUOTED_VALUE.exec(text);
  if (doubleQuoted !== null) {
    // The shell removes a backslash inside double quotes only before the
    // characters that still mean something there.
    value = doubleQuoted[1]!.replace(/\\([$\`"\\])/g, "$1");
  } else if (singleQuoted !== null) {
    value = singleQuoted[1]!;
  } else if (UNQUOTED_VALUE.test(text)) {
    value = text.replace(/\\(.)/g, "$1");
  }
  if (value !== undefined && (VALUE_SYNTAX.test(value) || match[2] === "+")) value = undefined;
  return { name: match[1]!, value, append: match[2] === "+" };
}

/**
 * Words that make a segment part of a compound command.
 *
 * A reassignment behind one of these (`then NPM=npm`, `{ NPM=npm; }`) runs or
 * not as a property of the whole construct, not of the line, so its result is
 * refused rather than guessed -- the same refusal a multi-line conditional
 * body already receives.
 */
const COMPOUND_KEYWORDS = new Set([
  "if", "while", "until", "for", "case", "then", "else", "elif", "do", "function", "select", "{", "}",
]);

/** A redirection operator written alone, which consumes the word after it. */
const BARE_REDIRECTION = /^(?:[0-9]*(?:>>?|<<?|<>|&>>?))$/;

/** A redirection operator written joined to its target, which consumes none. */
const JOINED_REDIRECTION = /^(?:[0-9]*(?:>>?|<<?|<>|&>>?)|&>>?)/;

/** What one line's own commands leave a named scalar bound to. */
type ScalarBinding =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "unset" }
  | { readonly kind: "opaque" };

/**
 * Decide the binding one line of shell leaves on a scalar name.
 *
 * `STANDALONE_ASSIGNMENT` decides whether a line OPENS with a literal
 * assignment; this function decides what the WHOLE line leaves behind,
 * because a line may assign the same name more than once and the shell keeps
 * only the last binding that runs in the current shell environment:
 *
 * - `NPM=ignored; NPM=npm` ends with `NPM=npm`. Deleting the name instead left
 *   `$NPM publish` unresolved, and a publish the audit cannot see is a clean
 *   gate, not a blocked one. The separators that keep the shell in the current
 *   environment (`;`, `&&`, and a `&` that ends an earlier background job)
 *   all take the later value, because every assignment left of the last one
 *   has already run by the time the line finishes.
 * - An assignment the shell does not persist still indexes nothing: a pipeline
 *   component (`NPM=npm | cmd` -- each segment of a pipeline runs in a
 *   subshell), a background job (`NPM=npm & cmd`), and a command prefix
 *   (`NPM=npm cmd`) never reach the parent environment. Indexing any of them
 *   let a `FLAG=--provenance | cat` lend a flag to a later publish the shell
 *   runs without it.
 * - A reassignment on the right of `||` never runs when the left side is an
 *   assignment (an assignment always succeeds), so the earlier value stands;
 *   and when the left side is a real command, whether the right side runs is
 *   the command's exit status, which a static scan cannot know. The binding
 *   is then refused (`opaque`) rather than guessed in either direction,
 *   because guessing the earlier value can attest a publish the line
 *   actually unflagged, and guessing the later value can hide one it left
 *   unresolved.
 * - A reassignment inside a compound command (`then FLAG=x`, `{ FLAG=x; }`)
 *   is refused for the same reason a multi-line conditional body is: whether
 *   it runs is a property of the construct.
 * - `NAME+=value` and any value this scanner cannot reproduce exactly also
 *   refuse, because the real binding differs from every literal candidate.
 *
 * Redirections are skipped rather than read as separators, so `NPM=npm 2>&1`
 * is an assignment with a redirection and not a background job. Quoted spans,
 * `$(...)` and backticks are traversed as words rather than split, so a
 * substitution on the same line can neither end a segment nor contribute a
 * binding -- its assignments belong to the subshell.
 *
 * @param line - One line of shell text.
 * @param name - The scalar the caller's gate matched at the line's start.
 * @returns What the line leaves `name` bound to: a literal value, no binding
 *          at all, or a binding that exists but cannot be known statically.
 */
function lineScalarBinding(line: string, name: string): ScalarBinding {
  let binding: ScalarBinding = { kind: "unset" };
  let previous: ";" | "&&" | "||" | "&" | "|" | "start" = "start";
  let previousDeterministic = true;
  let index = /^[ \t]*(?:export[ \t]+)?/.exec(line)![0].length;
  while (index < line.length) {
    const words: Array<{ raw: string; startsQuoted: boolean }> = [];
    let raw = "";
    let startsQuoted = false;
    let started = false;
    let depth = 0;
    let quote: "'" | '"' | undefined;
    let backtick = false;
    let escaped = false;
    let operator: ";" | "&&" | "||" | "&" | "|" | "end" = "end";
    const endWord = (): void => {
      if (!started) return;
      words.push({ raw, startsQuoted });
      raw = "";
      startsQuoted = false;
      started = false;
    };
    while (index < line.length) {
      const character = line[index]!;
      if (escaped) {
        raw += character;
        escaped = false;
        index += 1;
        continue;
      }
      if (character === "\\" && quote !== "'") {
        raw += character;
        escaped = true;
        started = true;
        index += 1;
        continue;
      }
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        raw += character;
        index += 1;
        continue;
      }
      if (character === "\`") {
        backtick = !backtick;
        raw += character;
        started = true;
        index += 1;
        continue;
      }
      if (backtick) {
        raw += character;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        if (!started) startsQuoted = true;
        raw += character;
        started = true;
        index += 1;
        continue;
      }
      // Parentheses are traversed, not split: a substitution's separators and
      // assignments belong to its subshell, and neither may reach this line's
      // segments.
      if (character === "(" || character === ")") {
        depth = character === "(" ? depth + 1 : Math.max(0, depth - 1);
        raw += character;
        started = true;
        index += 1;
        continue;
      }
      if (depth > 0) {
        raw += character;
        index += 1;
        continue;
      }
      if (character === " " || character === "\t" || character === "\r") {
        endWord();
        index += 1;
        continue;
      }
      // A comment starts at a word boundary and owns the rest of the line.
      if (character === "#" && !started) break;
      // `2>&1` is one redirection, not an assignment followed by a background
      // job; `&>` is a redirection that happens to begin with the operator.
      if (character === "&" && (/^[0-9]*[<>]>?$/.test(raw) || (raw === "" && line[index + 1] === ">"))) {
        raw += character;
        started = true;
        index += 1;
        continue;
      }
      if (character === ";" || character === "&" || character === "|") {
        endWord();
        if (character === ";") {
          operator = ";";
          index += 1;
        } else if (character === "&") {
          operator = line[index + 1] === "&" ? "&&" : "&";
          index += operator === "&&" ? 2 : 1;
        } else {
          // `||` is conditional; `|&` pipes both streams and, like `|`, puts
          // its segments in subshells.
          operator = line[index + 1] === "|" ? "||" : "|";
          index += line[index + 1] === "|" || line[index + 1] === "&" ? 2 : 1;
        }
        break;
      }
      raw += character;
      started = true;
      index += 1;
    }
    endWord();
    let assigns: AssignmentWord | undefined;
    let assignmentOnly = true;
    let allLiteral = true;
    let compound = false;
    for (let position = 0; position < words.length; position += 1) {
      const word = words[position]!;
      if (position === 0 && word.raw === "export") continue;
      if (!word.startsQuoted && BARE_REDIRECTION.test(word.raw)) {
        position += 1;
        continue;
      }
      if (!word.startsQuoted && JOINED_REDIRECTION.test(word.raw)) continue;
      if (!word.startsQuoted && COMPOUND_KEYWORDS.has(word.raw)) {
        compound = true;
        assignmentOnly = false;
        continue;
      }
      const assignment = parseAssignmentWord(word.raw, word.startsQuoted);
      if (assignment === undefined) {
        assignmentOnly = false;
        continue;
      }
      if (assignment.name === name) assigns = assignment;
      if (assignment.value === undefined) allLiteral = false;
    }
    if (assigns !== undefined) {
      const pipelinedOrBackgrounded = operator === "|" || operator === "&" || previous === "|";
      const neverRuns = previous === "||" && previousDeterministic;
      const cannotProve = (previous === "&&" || previous === "||") && !previousDeterministic;
      if (compound) binding = { kind: "opaque" };
      else if (!assignmentOnly) {
        // A command-prefix assignment (`NPM=npm cmd`) binds only for its
        // command, so it leaves whatever binding the line had already made.
      } else if (pipelinedOrBackgrounded || neverRuns) {
        // A pipeline component, a background job, or the right side of an `||`
        // whose left side already succeeded: the shell never runs it in the
        // current environment, so the binding the line had still stands.
      } else if (cannotProve) {
        // Whether this runs is the exit status of a real command. Keeping the
        // earlier value can attest a publish the line actually unflagged, and
        // taking this value can hide one it left unresolved, so refuse both.
        binding = { kind: "opaque" };
      } else {
        binding = assigns.value !== undefined ? { kind: "value", value: assigns.value } : { kind: "opaque" };
      }
    }
    if (operator === "end") break;
    previous = operator;
    // Only a segment made entirely of literal assignments provably succeeds,
    // so only it decides whether `&&` or `||` provably reaches the next one.
    previousDeterministic = assignmentOnly && !compound && allLiteral;
  }
  return binding;
}

/**
 * Index scalar assignments so a command held in a variable can be audited.
 *
 * `CMD="npm publish"` followed by `$CMD` runs a publish that no scan of the
 * invocation line can see, because the invocation line contains no publish. The
 * assignment is where the command actually is. `NPM=npm` followed by
 * `$NPM publish` hides one the same way, so unquoted values are indexed too.
 *
 * A name is taken only where a line OPENS with one assignment carrying a fully
 * literal value and holds nothing else before its end or a `;`. `NPM=npm; cmd`
 * therefore binds, because the semicolon ends the assignment and the shell keeps
 * it afterwards, while `NPM=npm cmd` does not, because that binding lasts only
 * for the command it precedes. Requiring the line to OPEN with the assignment is
 * what keeps a `;` inside a comment from exposing one. That single rule keeps
 * the scan from inventing
 * bindings the shell never makes, each of which let an unattested publish
 * borrow a flag and pass the gate:
 *
 * - `# FLAG=--provenance` is a comment, and a comment is not a line that is
 *   only an assignment.
 * - `echo "config NPM=npm"` is a command with an argument, not an assignment.
 * - `FLAG=--provenance some-command` binds only for that one command; the shell
 *   does not keep it afterwards, so neither does this map.
 * - `$(FLAG=--provenance)` binds inside a subshell that the outer shell never
 *   sees.
 * - `NPM=npm$SUFFIX` and `NPM=npm$(printf foo)` are not literal. The value must
 *   match to the end of the line, so a prefix is never mistaken for the whole
 *   value -- the mistake that let a scan analyse a different command from the
 *   one the shell runs.
 *
 * `export NPM=npm`, a trailing `# comment` and a CRLF line ending are all still
 * assignments: refusing them left `$NPM` unresolved, and an attested publish
 * elsewhere in the file then satisfied the non-vacuity guard, so being too
 * strict here passes an unattested publish just as being too loose does.
 *
 * A line that assigns the same name more than once is resolved the way the
 * shell resolves it -- by `lineScalarBinding`, which keeps the last binding
 * that runs in the current shell environment, refuses a binding whose value
 * or execution cannot be known statically, and ignores bindings a pipeline,
 * a background job or a command prefix never persist. A refusal deletes the
 * name: the shell's own last write has already replaced any earlier line's
 * binding, so keeping the earlier value would be lending evidence the line
 * removed.
 *
 * Escapes are honoured outside single quotes, so `NPM=npm\\ publish` is one word
 * holding a command while `CMD='"'"'a\\b'"'"' keeps its backslash as the shell does.
 * A value that still carries a substitution, backtick, quote or parenthesis
 * after unescaping is refused: inlining `pkg_name="$(node -p …)"` injects an
 * unbalanced parenthesis into an unrelated command, and the scan then reports
 * invocations that are not there while losing the one that is -- a false
 * verdict in both directions, which is worse than not resolving the variable.
 *
 * @param text - File contents with continuations already joined.
 * @returns Variable name mapped to the literal text it holds.
 */
export function shellScalars(text: string): Map<string, string> {
  const scalars = new Map<string, string>();
  const controlClosers: string[] = [];
  let subshellDepth = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let backtick = false;
  let pendingFunction = false;
  const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (const line of text.split("\n")) {
    const heredoc = heredocs[0];
    if (heredoc !== undefined) {
      const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate.replace(/\r$/, "") === heredoc.delimiter) heredocs.shift();
      continue;
    }

    const atFileScope = subshellDepth === 0 && quote === undefined && !backtick && controlClosers.length === 0;
    let code = line;
    const heredocStarts: number[] = [];
    // Track grouping across lines before considering the next line. Bindings in
    // subshells, functions, and conditional bodies cannot be promoted into the
    // file-global map because static scanning cannot prove those bodies ran.
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === "`") {
        backtick = !backtick;
        continue;
      }
      if (backtick) continue;
      // A comment begins only at a shell word boundary. Its quotes and
      // parentheses are prose and must not change the scope of later lines.
      if (character === "#" && (index === 0 || /[\s;&|(){}]/.test(line[index - 1]!))) {
        code = line.slice(0, index);
        break;
      }
      if (character === "<" && line[index + 1] === "<" && line[index + 2] !== "<") {
        heredocStarts.push(index);
      }
      if (character === "'" || character === '"') quote = character;
      else if (character === "(") subshellDepth += 1;
      else if (character === ")") subshellDepth = Math.max(0, subshellDepth - 1);
    }

    for (const start of heredocStarts) {
      const match = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([^\s;&|<>]+))/.exec(code.slice(start));
      if (match !== null) {
        heredocs.push({
          delimiter: match[2] ?? match[3] ?? match[4]!,
          stripTabs: match[1] === "-",
        });
      }
    }
    const syntax = code.trim();
    const closer = controlClosers[controlClosers.length - 1];
    if (closer !== undefined && new RegExp(`^${closer}(?:${SEPARATORS}|$)`).test(syntax)) controlClosers.pop();
    const closesBrace = new RegExp(`}(?:${SEPARATORS}|$)`).test(syntax);
    if (pendingFunction && new RegExp(`^\\{(?:${SEPARATORS}|$)`).test(syntax)) {
      if (!closesBrace) controlClosers.push("\\}");
      pendingFunction = false;
    } else if (new RegExp(`^\\{(?:${SEPARATORS}|$)`).test(syntax) && controlClosers.includes("\\}")) {
      if (!closesBrace) controlClosers.push("\\}");
    } else if (/^(?:function[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*\([ \t]*\))?[ \t]*\{/.test(syntax)) {
      if (!closesBrace) controlClosers.push("\\}");
    } else if (/^(?:function[ \t]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*\([ \t]*\))?|[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\))[ \t]*$/.test(syntax)) {
      pendingFunction = true;
    } else {
      pendingFunction = false;
      const opener = new RegExp(`(?:^|[${OPERATOR_CHARS}][ \\t]*)(if|while|until|for|select|case)\\b`).exec(syntax)?.[1];
      if (opener !== undefined) {
        const expected = opener === "if" ? "fi" : opener === "case" ? "esac" : "done";
        if (!new RegExp(`(?:^|[${OPERATOR_CHARS}][ \\t]*)${expected}(?:${SEPARATORS}|$)`).test(syntax)) controlClosers.push(expected);
      }
    }

    if (!atFileScope) continue;
    const assignment = STANDALONE_ASSIGNMENT.exec(line);
    if (assignment === null) continue;
    // Exactly one of the three value alternatives matches, so the last is the
    // only case left rather than a fallback that could be undefined.
    const name = assignment[1]!;
    const binding = lineScalarBinding(line, name);
    if (binding.kind === "unset") continue;
    if (binding.kind === "opaque") {
      scalars.delete(name);
      continue;
    }
    scalars.set(name, binding.value);
  }
  return scalars;
}

/**
 * Expand `$name` and `${name}` references against the file's scalar assignments.
 *
 * An unknown name is left in place for the same reason an unknown array is:
 * erasing it would turn "not understood" into "carries no flags", which reads
 * as a pass.
 *
 * @param line - One logical command.
 * @param scalars - Scalar assignments from the same file.
 * @returns The command with known scalar references inlined.
 */
export function expandScalars(line: string, scalars: Map<string, string>): string {
  // One of the two alternatives always captures the name, so there is no
  // nameless match to guard against.
  return line.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced: string | undefined, bare: string | undefined, offset: number) => {
    let single = false;
    let double = false;
    let escaped = false;
    for (const character of line.slice(0, offset)) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && !single) {
        escaped = true;
        continue;
      }
      if (character === "'" && !double) single = !single;
      else if (character === '"' && !single) double = !double;
    }
    if (single) return whole;
    const value = scalars.get(braced ?? bare!);
    // Quote removal happens before parameter expansion: a backslash produced by
    // expansion is data, not syntax. Double it in the scanner input so the one
    // tokenisation pass preserves the shell's literal backslash.
    return value?.replace(/\\/g, "\\\\") ?? whole;
  });
}

/**
 * Expand `"${name[@]}"` references against the file's array declarations.
 *
 * An unknown name is left untouched rather than erased: silently dropping it
 * would turn "this scan does not understand the command" into "this command has
 * no flags", which reads as a pass.
 *
 * @param line - One logical command.
 * @param arrays - Array declarations from the same file.
 * @returns The command with referenced array contents inlined.
 */
export function expandArrays(line: string, arrays: Map<string, string>): string {
  return line.replace(/"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"?/g, (whole, name: string) =>
    arrays.get(name) ?? whole);
}

/** The outcome of one verifier run. */
export interface VerifierResult {
  /** Reasons the run failed; empty means it passed. */
  failures: string[];
  /** Lines describing what was checked, for the operator. */
  notes: string[];
}

