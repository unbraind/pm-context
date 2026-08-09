/**
 * Guards the release workflow's changelog generate and check steps against the
 * exact desynchronization that broke pm-context's daily release from
 * 2026-08-08 onward.
 *
 * The release job bumps `package.json` to the pending version long before it
 * pushes the release tag, so the generate step cannot derive the section name
 * from a tag that does not exist yet. The fix names the section after the tag
 * being created by passing `--version "$RELEASE_TAG"` (the pending tag, flowing
 * through `env` from `steps.decide.outputs.tag`) to the generate, check AND
 * notes invocations, all of which expand a single shared `common=(...)` options
 * array so the three cannot drift. This test parses the workflow YAML (a real
 * structural parse, not a loose regex) and asserts:
 *
 *   - the generate step runs BEFORE the release-checks step (order matters);
 *   - the generate and check invocations are byte-identical apart from the
 *     terminal flag (`--github-step-summary` on generate, `--check` on verify);
 *   - both expand the same shared `common` array;
 *   - the `--version` that follows in that array is the pending-tag expression
 *     (`"$RELEASE_TAG"`), locking in the actual root-cause fix rather than just
 *     the presence of the flag;
 *   - the notes invocation expands the same `common` array too.
 *
 * The YAML parser below is a small, dependency-free recursive-descent parser
 * scoped to the subset of YAML that GitHub Actions workflow files use: block
 * mappings, block sequences (including the `- key: value` inline form), literal
 * block scalars (`run: |`), plain scalars, and quoted scalars. It exists only
 * to navigate to a step's `run` block scalar; it is intentionally not a
 * general-purpose YAML implementation.
 *
 * No maintained YAML parser is available in this project's dependency tree
 * (`node_modules` exposes neither `js-yaml` nor `yaml`), so importing one would
 * add a new dependency for a single test. This scoped parser is the smaller
 * cost and is confined to this file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/** Path to the release workflow under test, relative to this test file. */
const WORKFLOW_PATH = join(import.meta.dirname, "..", ".github", "workflows", "release.yml");

/** A parsed YAML node: an object, an array, a scalar string, or null. */
type YamlNode = null | string | YamlNode[] | { [key: string]: YamlNode };

/**
 * Parses a GitHub Actions workflow YAML document into a tree of plain objects,
 * arrays, and strings.
 *
 * @param text - The raw YAML document text.
 * @returns The parsed document root node.
 */
function parseWorkflowYaml(text: string): YamlNode {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let pos = 0;

  /** Counts leading spaces on a line. */
  const indentOf = (line: string): number => {
    let i = 0;
    while (i < line.length && line[i] === " ") i++;
    return i;
  };

  /** True for blank lines and full-line comments (structural context only). */
  const isBlankOrComment = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith("#");
  };

  /** Returns the next significant (non-blank, non-comment) line, or null. */
  const peek = (): { line: string; indent: number } | null => {
    while (pos < lines.length && isBlankOrComment(lines[pos])) pos++;
    if (pos >= lines.length) return null;
    return { line: lines[pos], indent: indentOf(lines[pos]) };
  };

  /** Splits a `key: value` entry, keeping the key verbatim. */
  const splitEntry = (content: string): { key: string; valuePart: string } => {
    const colon = content.indexOf(":");
    if (colon === -1) return { key: content.trim(), valuePart: "" };
    const key = content.slice(0, colon).trim();
    let valuePart = content.slice(colon + 1);
    if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);
    return { key, valuePart };
  };

  /** Unquotes and de-comments a scalar value. */
  const parseScalar = (raw: string): string => {
    const s = raw.trim();
    if (s === "") return "";
    if (s.startsWith('"')) {
      let out = "";
      for (let i = 1; i < s.length; i++) {
        if (s[i] === "\\" && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
        if (s[i] === '"') break;
        out += s[i];
      }
      return out;
    }
    if (s.startsWith("'")) {
      let out = "";
      for (let i = 1; i < s.length; i++) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") { out += "'"; i++; continue; }
          break;
        }
        out += s[i];
      }
      return out;
    }
    const comment = s.indexOf(" #");
    return (comment === -1 ? s : s.slice(0, comment)).trimEnd();
  };

  /** True when a scalar value marks a literal/folded block scalar. */
  const isBlockScalarMarker = (value: string): boolean => /^[>|][+-]?$/.test(value.trim());

  /**
   * Reads a literal/folded block scalar following a `key: |` line, consuming
   * every more-indented raw line (block content preserves `#` and `>` verbatim)
   * and returning it dedented and joined with newlines.
   *
   * @param keyIndent - The indent of the `key:` line that introduced the block.
   */
  const readBlockScalar = (keyIndent: number): string => {
    const collected: string[] = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.trim() === "") { collected.push(""); pos++; continue; }
      if (indentOf(line) <= keyIndent) break;
      collected.push(line);
      pos++;
    }
    let contentIndent = Infinity;
    for (const line of collected) {
      if (line.trim() === "") continue;
      contentIndent = Math.min(contentIndent, indentOf(line));
    }
    if (!Number.isFinite(contentIndent)) contentIndent = keyIndent + 2;
    return collected
      .map((line) => (line.trim() === "" ? "" : line.slice(contentIndent)))
      .join("\n")
      .replace(/\n+$/, "");
  };

  /** Parses a node (mapping or sequence) whose first entry is at `indent`. */
  const parseNode = (indent: number): YamlNode => {
    const next = peek();
    if (next === null) return null;
    const content = next.line.slice(next.indent);
    if (content === "-" || content.startsWith("- ")) return parseSequence(next.indent);
    return parseMapping(next.indent);
  };

  /**
   * Resolves a mapping value that follows a `key:` with no inline value:
   * a nested block at a deeper indent, or null when nothing follows.
   *
   * @param keyIndent - The indent of the owning `key:` line.
   */
  const resolveNestedValue = (keyIndent: number): YamlNode => {
    const next = peek();
    if (next === null || next.indent <= keyIndent) return null;
    return parseNode(next.indent);
  };

  /**
   * Parses a block mapping at `indent`, optionally seeded with an inline first
   * entry (the `- key: value` sequence-item form). The inline entry seeds the
   * loop's pending content and is consumed on the first iteration.
   *
   * @param indent - The indent of every key in this mapping.
   * @param firstEntry - Optional inline `key: value` text from a sequence item.
   */
  const parseMapping = (indent: number, firstEntry?: string): { [key: string]: YamlNode } => {
    const obj: { [key: string]: YamlNode } = {};
    let pending: string | undefined = firstEntry;
    while (true) {
      let content: string;
      if (pending !== undefined) {
        content = pending;
        pending = undefined;
      } else {
        const next = peek();
        if (next === null || next.indent !== indent) break;
        const c = next.line.slice(next.indent);
        if (c === "-" || c.startsWith("- ")) break;
        pos++;
        content = c;
      }
      const { key, valuePart } = splitEntry(content);
      if (valuePart === "") {
        obj[key] = resolveNestedValue(indent);
      } else if (isBlockScalarMarker(valuePart)) {
        obj[key] = readBlockScalar(indent);
      } else {
        obj[key] = parseScalar(valuePart);
      }
    }
    return obj;
  };

  /**
   * Parses a block sequence at `indent`. Each item is either an inline mapping
   * (`- key: value`), a nested block (`- ` then a deeper mapping/sequence), or
   * a scalar (`- value`).
   *
   * @param indent - The indent of every `- ` marker in this sequence.
   */
  const parseSequence = (indent: number): YamlNode[] => {
    const arr: YamlNode[] = [];
    while (true) {
      const next = peek();
      if (next === null || next.indent !== indent) break;
      const content = next.line.slice(next.indent);
      if (content !== "-" && !content.startsWith("- ")) break;
      pos++;
      const rest = content === "-" ? "" : content.slice(2);
      const inlineMapping = rest.match(/^[A-Za-z_][\w.-]*:(\s|$)/);
      if (rest.trim() === "" || rest.trim().startsWith("#")) {
        arr.push(resolveNestedValue(indent));
      } else if (inlineMapping) {
        arr.push(parseMapping(indent + 2, rest));
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  };

  return parseNode(0);
}

/** True when a logical bash line is a pm-changelog invocation. */
const isPmChangelogLine = (line: string): boolean => /\bpm-changelog\b/.test(line);

/**
 * Reconstructs logical bash lines from a `run` block scalar by collapsing
 * backslash line continuations, so each multi-line command becomes one string.
 *
 * @param runScript - The literal `run` block scalar text.
 * @returns One string per logical command line.
 */
function logicalLines(runScript: string): string[] {
  const out: string[] = [];
  let buffer = "";
  for (const line of runScript.split("\n")) {
    const trimmedEnd = line.replace(/\s+$/, "");
    if (trimmedEnd.endsWith("\\")) {
      buffer += `${trimmedEnd.slice(0, -1)} `;
    } else {
      buffer += trimmedEnd;
      out.push(buffer);
      buffer = "";
    }
  }
  if (buffer.trim() !== "") out.push(buffer);
  return out;
}

/**
 * Tokenizes a logical bash line on whitespace. Both pm-changelog invocations
 * under test share identical quoting, so a whitespace split is sufficient to
 * compare them for equality.
 *
 * @param line - A single logical bash line.
 * @returns The non-empty whitespace-delimited tokens.
 */
function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter((token) => token !== "");
}

/** The single pm-changelog logical line whose final token is `flag`. */
function lineEndingWith(lines: string[], flag: string): string {
  const matches = lines.filter((line) => {
    const tokens = tokenize(line);
    return tokens.length > 0 && tokens[tokens.length - 1] === flag && isPmChangelogLine(line);
  });
  assert.strictEqual(
    matches.length,
    1,
    `expected exactly one pm-changelog line ending in ${flag}, found ${matches.length}`,
  );
  return matches[0];
}

/**
 * Extracts the whitespace-delimited tokens of the shared `common=(...)` bash
 * array that the generate, check and notes invocations expand. The array is the
 * single source of truth for the pending-tag pair, so asserting the options it
 * carries once covers every invocation that expands it.
 *
 * @param runScript - The literal `run` block scalar text of the generate step.
 * @returns The array element tokens, in order.
 */
function extractCommonArray(runScript: string): string[] {
  const rawLines = runScript.split("\n");
  const start = rawLines.findIndex((line) => /^\s*common=\(\s*$/.test(line));
  assert.ok(start !== -1, "expected a common=(...) pm-changelog options array in the generate step");
  const elements: string[] = [];
  for (let i = start + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (/^\s*\)\s*$/.test(line)) break;
    elements.push(line.trim());
  }
  return elements.join(" ").split(/\s+/).filter((token) => token !== "");
}

test("release workflow names the changelog section after the tag in both generate and check", () => {
  const doc = parseWorkflowYaml(readFileSync(WORKFLOW_PATH, "utf8")) as {
    jobs?: { release?: { steps?: Array<{ name?: string; run?: string }> } };
  };

  // Sanity-check the parser navigated the document structure correctly before
  // relying on it: the workflow must expose its release steps.
  const steps = doc.jobs?.release?.steps;
  assert.ok(Array.isArray(steps), "parser must expose jobs.release.steps as an array");
  const names = steps.map((step) => step.name).filter((name): name is string => typeof name === "string");

  const generateName = "Generate changelog and release notes";
  const releaseChecksName = "Run release checks";
  assert.ok(names.includes(generateName), "generate step must exist");
  assert.ok(names.includes(releaseChecksName), "release-checks step must exist");

  // The release depends on step ORDER, not just step existence: the generate
  // step must run before the release checks. Asserting only the names would let
  // a future edit that reorders them pass silently.
  const generateIndex = steps.findIndex((step) => step.name === generateName);
  const releaseChecksIndex = steps.findIndex((step) => step.name === releaseChecksName);
  assert.ok(
    generateIndex >= 0 && releaseChecksIndex >= 0 && generateIndex < releaseChecksIndex,
    "generate must run before the release checks",
  );

  const generateStep = steps[generateIndex];
  assert.ok(typeof generateStep?.run === "string", "generate step must have a run block");
  const run = generateStep.run as string;

  const lines = logicalLines(run);
  const generateLine = lineEndingWith(lines, "--github-step-summary");
  const checkLine = lineEndingWith(lines, "--check");

  const generateTokens = tokenize(generateLine);
  const checkTokens = tokenize(checkLine);
  // Strip the terminal flag so the remainder can be compared for equality.
  const generateCore = generateTokens.slice(0, -1);
  const checkCore = checkTokens.slice(0, -1);

  assert.deepStrictEqual(
    generateCore,
    checkCore,
    "generate and check must be byte-identical apart from --github-step-summary vs --check",
  );

  // The shared options must come from ONE definition (the `common` array) so
  // generate, check and notes cannot drift apart. Both invocations expand it.
  assert.ok(
    generateCore.includes('"${common[@]}"'),
    "generate and check must expand a shared common=(...) options array",
  );

  // Lock in the actual root-cause fix, not just the presence of the flag: the
  // token that FOLLOWS --version must be the pending-tag expression. The common
  // array is the single source of truth, and generate/check are already proven
  // byte-identical and both expand the array, so this one assertion covers both.
  const common = extractCommonArray(run);
  const versionIndex = common.indexOf("--version");
  assert.ok(versionIndex !== -1, "the release pair must pass --version explicitly (the root-cause fix)");
  assert.strictEqual(
    common[versionIndex + 1],
    '"$RELEASE_TAG"',
    "--version must be followed by the pending tag ($RELEASE_TAG), not a stale package-derived value",
  );
  assert.ok(
    common.includes("--all-release-tags"),
    "the release pair must rebuild full history with --all-release-tags",
  );

  // The notes invocation must share the same common array so release notes can
  // never diverge from the generated changelog section.
  const notesLine = lines.find((line) => isPmChangelogLine(line) && line.includes("--stdout"));
  assert.ok(notesLine, "a notes (stdout) pm-changelog invocation must exist");
  assert.ok(
    tokenize(notesLine).includes('"${common[@]}"'),
    "the notes invocation must expand the same common options array as generate and check",
  );
});
