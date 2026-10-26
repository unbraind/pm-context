import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { encode } from "@toon-format/toon";
import { create, init, isPmCliExpectedError, readLocatedItem, readSettings, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildAgentHandoff, buildContextPack, buildPhaseContext, buildSuggestedAgentCommandArgv, buildSuggestedCommand, commandExamples, encodePhaseContext, quotePosixArgument } from "../index.ts";
import type { SuggestedCommand, SuggestedAgentCommandInput } from "../index.ts";
import { SinceError } from "../since.ts";
import { FileFocusError, fileLinkCommand } from "../file-focus.ts";

/** Ask a real POSIX shell to split the display, then print each argument with NUL framing. */
function shellRoundtrip(value: SuggestedCommand, root: string) {
  const result = spawnSync("/bin/sh", ["-c", `/bin/sh -c 'for a; do printf "%s\\0" "$a"; done' sh ${value.command}`], { cwd: root, encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), value.argv, value.command);
  assert.equal(existsSync(join(root, "shell-side-effect")), false);
}

/** Require companion argv for every package command-bearing field, including error recovery. */
function commands(value: unknown): SuggestedCommand[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(commands);
  const row = value as Record<string, unknown>;
  const result: SuggestedCommand[] = [];
  for (const [display, args] of [["command", "argv"], ["restore_with", "restore_argv"], ["suggestedCommand", "suggestedArgv"], ["suggested_retry", "suggested_retry_args"]]) {
    if (typeof row[display] === "string") { assert.ok(Array.isArray(row[args]), `missing ${args}`); result.push({ command: row[display] as string, argv: row[args] as string[] }); }
  }
  return [...result, ...Object.values(row).flatMap(commands)];
}

test("one POSIX renderer round-trips 500 seeded arbitrary keys and values without shell effects", (t) => {
  const root = mkdtempSync(join(tmpdir(), "command-argv-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixed = ["a;printf X", "a;printf injected > shell-side-effect", "$(printf hit > shell-side-effect)", "`printf hit > shell-side-effect`", "", " ", "'", '"', ";|&$()<>", "\n", "\t", "-leading", "é📚", "plain_field"];
  let seed = 0x181c0de;
  /** Deterministic generator includes shell syntax as data rather than executable test setup. */
  function random(max: number) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
  for (let i = 0; i < 500; i++) {
    const key = i < fixed.length ? fixed[i]! : Array.from({ length: random(8) }, () => fixed[random(fixed.length)]!).join("");
    const value = fixed[random(fixed.length)]! + fixed[random(fixed.length)]!;
    const command = buildSuggestedCommand(["pm", "get", value, "--fields", key, "--output-budget", "unbounded"]);
    shellRoundtrip(command, root);
    for (const format of ["json", "toon"] as const) {
      // The native source codecs, rather than custom string normalization, own round trips.
      const encoded = format === "json" ? JSON.stringify(command) : encode(command);
      assert.deepEqual(format === "json" ? JSON.parse(encoded) : decodeToon(encoded), command);
    }
  }
  assert.equal(quotePosixArgument("plain_field"), "plain_field");
  assert.equal(buildSuggestedCommand(["pm", "get", "task-1", "--fields", "title"]).command, "pm get task-1 --fields title");
  assert.equal(quotePosixArgument("it's"), "'it'\\''s'");
  const argv = ["pm", "get", "task-1"]; const suggestion = buildSuggestedCommand(argv); argv[1] = "delete";
  assert.equal(suggestion.argv[1], "get");
  const sparse = ["pm", "value"]; delete sparse[1]; Object.assign(sparse, { extra: "value" });
  for (const invalid of [sparse, [], new Array(2), ["pm", 1], Array.from({ length: 4097 }, () => "x"), ["pm", "x".repeat(262145)], null]) {
    assert.throws(() => Reflect.apply(buildSuggestedCommand, undefined, [invalid]), (error: unknown) => isPmCliExpectedError(error) && error.code === "INVALID_COMMAND_ARGUMENT");
  }
  assert.throws(() => quotePosixArgument("NUL\0argument"), /NUL/);
  assert.throws(() => buildSuggestedCommand(["pm", "get", "\ud800"]), /well-formed Unicode/);
});

test("fixed review key and admitted native metadata emit safe restore argv in JSON and TOON on a non-git tracker", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "command-packet-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("safe", { defaults: true, agentGuidance: "skip", author: "fixture" }, client);
  const { item } = await create({ title: "Command safety", author: "fixture" }, client);
  const path = join(client.pmRoot, "tasks", `${item.id}.toon`);
  const { document } = await readLocatedItem({ id: item.id, type: "Task", itemPath: path, item_format: "toon" }, { schema: (await readSettings(client.pmRoot)).schema });
  const keys = ["a;printf X", "a;printf hit > shell-side-effect", "spaces key", "'quoted'", '"double"', "$()|&<>`", "line\nbreak", "tab\tkey", "-leading", "é📚", ""];
  for (const key of keys) Object.assign(document.metadata, { [key]: "literal\r\nvalue ' ;|&$()<>`" });
  writeFileSync(path, serializeItemDocument(document, { format: "toon" }));
  const admitted = (await readLocatedItem({ id: item.id, type: "Task", itemPath: path, item_format: "toon" }, { schema: (await readSettings(client.pmRoot)).schema })).document.metadata;
  assert.ok(Object.hasOwn(admitted, "a;printf X"));
  const before = readFileSync(path);
  for (const format of ["json", "toon"] as const) {
    const packet = await buildPhaseContext({ phase: "review", items: [item.id], contracts: { investigation: ["title"], implementation: ["title"], review: ["title"], handoff: ["title"] }, format, byte_budget: 50000, session: { version: 1, id: "safe", token_budget: 50000, spent_tokens: 0, seen_item_ids: [] } }, client.pmRoot);
    const encoded = encodePhaseContext(packet); const decoded = format === "json" ? JSON.parse(encoded) : decodeToon(encoded);
    assert.deepEqual(decoded, packet);
    for (const key of keys.filter((key) => Object.hasOwn(admitted, key))) {
      const row = packet.omission_receipt.omitted_field_groups.find((group) => group.name === `${item.id}.${key}`)!;
      assert.deepEqual(row.restore_argv, ["pm", "get", item.id, "--fields", key, "--output-budget", "unbounded"]);
    }
    const review = packet.omission_receipt.omitted_field_groups.find((group) => group.name === `${item.id}.a;printf X`)!;
    shellRoundtrip({ command: review.restore_with, argv: review.restore_argv }, root);
    const suggestions = commands(decoded); assert.ok(suggestions.length >= keys.length);
    for (const command of suggestions) shellRoundtrip(command, root);
    assert.equal("restore_reference_with" in packet.read_session!, false, "unsafe SDK legacy template stays out of the package wire format");
  }
  assert.deepEqual(readFileSync(path), before);
});

test("handoff ids, selectors, free-form override refusal, registered examples and recovery hints all share the argv builder", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "command-surfaces-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = "a;printf hit > shell-side-effect";
  const pack = buildContextPack([{ id: payload, title: "Literal id" }], { includeClosed: true });
  for (const command of commands(buildAgentHandoff(pack))) shellRoundtrip(command, root);
  assert.throws(() => Reflect.apply(buildAgentHandoff, undefined, [pack, { suggestedCommand: payload }]), /suggestedArgv/);
  const input: SuggestedAgentCommandInput = { commandName: "context-pack", selection: { ids: [], status: payload, type: "custom 'type'", tag: "$(printf hit > shell-side-effect)", inferredStatus: false }, limit: 25, defaultLimit: 25, recentLimit: 5, defaultRecentLimit: 5, includeClosed: false, neighborhood: true, neighborhoodDepth: 1, sections: ["a\nb"] };
  const argv = buildSuggestedAgentCommandArgv(input); shellRoundtrip(buildSuggestedCommand(argv), root);
  assert.equal(argv[argv.indexOf("--status") + 1], payload);
  shellRoundtrip(fileLinkCommand(), root);
  for (const error of [new SinceError("HISTORY_EXPIRED", "Reorient", ["pm", "context", "--for", payload]), new FileFocusError("TRACKER_READ_FAILED", "Repair", undefined, ["pm", "validate", payload])]) {
    assert.ok(isPmCliExpectedError(error), "preserve the SDK expected-error marker so wire recovery includes argv");
    const hints = commands(error.context); assert.equal(hints.length, 1);
    for (const hint of hints) shellRoundtrip(hint, root);
  }
  const harness = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] }); t.after(() => harness.deactivate());
  for (const command of Object.values(commandExamples()).flat()) shellRoundtrip(command, root);
  // Examples are constants, but still go through the same builder at registration.
  assert.ok(harness.activation.registrations.commands.length > 0);
  // Exercise host serialization of an actual unreadable tracker, rather than a
  // simulated SDK exception. Git is needed only for this file-focus command.
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("wire", { defaults: true, agentGuidance: "skip", author: "fixture" }, client);
  const created = await create({ title: "Wire refusal", author: "fixture" }, client);
  writeFileSync(join(client.pmRoot, "tasks", `${created.item.id}.toon`), "[invalid");
  assert.equal(spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" }).status, 0);
  const packageRoot = resolve(import.meta.dirname, "..");
  const installed = join(client.pmRoot, "extensions", "pm-context"); mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const args = [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-pack", "--files", "source.ts", "--json"];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { ...process.env, PM_PATH: client.pmRoot, PM_AUTHOR: "fixture" } });
  assert.equal(result.status, 2, result.stderr);
  const wire: unknown = JSON.parse(result.stderr);
  for (const decoded of [wire, decodeToon(encode(wire))]) {
    const hints = commands(decoded); assert.equal(hints.length, 1);
    assert.deepEqual(hints[0]!.argv, ["pm", "validate"]); shellRoundtrip(hints[0]!, root);
  }
});
