import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { create } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { createFreshnessReader, packCriterionEvidence, encodeEvidencePack, parseEvidencePacket, readEvidencePacket } from "../index.ts";
import type { EvidencePacket } from "../index.ts";
import builtExtension from "../dist/index.js";

/** Safe typed errors include a concrete remedy and host usage exit code. */
function code(expected: string) { return (error: unknown) => isPmCliExpectedError(error) && error.code === expected && error.exitCode === 2 && "remedy" in error && typeof error.remedy === "string" && error.remedy.length > 0; }
/** Detect every tracker write, including runtime files and source links. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    hash.update(entry.name);
    hash.update(entry.isSymbolicLink() ? "link" : entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}
/** Small declaration used to test strict untrusted input validation. */
function packet(): EvidencePacket { return { criteria: [{ id: "AC1", text: "Recorded title", evidence: [{ item: "sample-task", field: "title" }] }] }; }

test("strict declarations reject unsupported, duplicate, ambiguous and unbounded input before reading", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const row = packet().criteria[0]!;
  for (const value of [undefined, null, [], {}, cyclic, { criteria: [] }, { ...packet(), extra: true },
    { criteria: [row, row] }, { criteria: Array.from({ length: 129 }, (_, i) => ({ ...row, id: `ac${i}` })) },
    { criteria: [null] }, { criteria: [{ ...row, extra: true }] }, { criteria: [{ ...row, id: "../bad" }] },
    { criteria: [{ ...row, text: 1 }] }, { criteria: [{ ...row, text: " " }] }, { criteria: [{ ...row, text: "x".repeat(1025) }] },
    { criteria: [{ ...row, evidence: null }] }, { criteria: [{ ...row, evidence: [null] }] },
    { criteria: [{ ...row, evidence: [{ item: "sample-task", field: "title", extra: true }] }] },
    { criteria: [{ ...row, evidence: [{ item: "../private", field: "title" }] }] },
    { criteria: [{ ...row, evidence: [{ item: "sample-task", field: "/metadata/title" }] }] },
    { criteria: [{ ...row, evidence: [...row.evidence, ...row.evidence] }] },
    { criteria: [{ ...row, evidence: Array.from({ length: 513 }, (_, i) => ({ item: `task${i}`, field: "title" })) }] },
    { criteria: [{ ...row, text: "x".repeat(262145) }] },
  ]) assert.throws(() => parseEvidencePacket(value), code("INVALID_PACKET"));
  const normalized = parseEvidencePacket({ criteria: [{ ...row, id: "z", evidence: [{ item: "z", field: "title" }, { item: "a", field: "title" }] }, { ...row, id: "A" }] });
  assert.deepEqual(normalized.criteria.map((criterion) => criterion.id), ["A", "z"]);
  assert.deepEqual(normalized.criteria[1]!.evidence.map((binding) => binding.item), ["a", "z"]);
  assert.deepEqual(parseEvidencePacket(packet()), packet());
});

test("real no-git SDK tracker packs whole criterion groups, counts citations and discloses exact budget losses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "criterion-pack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("criterion", { defaults: true, author: "fixture-agent", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const item = (await create({ title: "Unicode 📚, quoted \"title\"", description: "Complete recorded details ".repeat(100), body: "Body\nwith café", author: "fixture-agent" }, { cwd: root, pmRoot })).item;
  const input: EvidencePacket = { criteria: [
    { id: "AC2", text: "Retain complete details", evidence: [{ item: item.id, field: "description" }, { item: item.id, field: "body" }] },
    { id: "AC1", text: "Retain title", evidence: [{ item: item.id, field: "title" }] },
    { id: "AC0", text: "No producer supplied evidence", evidence: [] },
    { id: "AC3", text: "Shared title binding", evidence: [{ item: item.id, field: "title" }] },
  ] };
  const read = createFreshnessReader(pmRoot, root);
  const before = fingerprint(pmRoot); const original = JSON.stringify(input);
  for (const format of ["json", "toon"] as const) {
    const full = await packCriterionEvidence(input, read, { byteBudget: 20000, format });
    assert.deepEqual(full.criteria.map((row) => row.state), ["unlinked", "linked", "linked", "linked"]);
    assert.equal(full.source_fields_read, 3, "shared citations read once");
    assert.equal(full.evidence.length, 4);
    assert.equal(JSON.parse(full.evidence.find((row) => row.field === "title")!.value_json), item.title);
    const encoded = encodeEvidencePack(full, format);
    assert.ok(Buffer.byteLength(encoded) <= full.byte_upper_bound && full.byte_upper_bound <= full.byte_budget);
    assert.deepEqual(format === "json" ? JSON.parse(encoded) : decodeToon(encoded), full);
    const cut = await packCriterionEvidence(input, read, { format, byteBudget: full.byte_upper_bound - 1000 });
    assert.deepEqual(cut.criteria.map((row) => [row.id, row.state]), [["AC0", "unlinked"], ["AC1", "linked"], ["AC2", "budget_omitted"], ["AC3", "linked"]]);
    assert.equal(cut.evidence.some((row) => row.criterion === "AC2"), false, "no partial groups");
    assert.equal(cut.content_reviewed, false);
    assert.match(cut.omitted_evidence, /read-for-sizing-only/);
    assert.equal(cut.source_fields_read, 3, "sizing reads explicitly disclosed, never review");
    assert.ok(Buffer.byteLength(encodeEvidencePack(cut, format)) <= cut.byte_upper_bound && cut.byte_upper_bound <= cut.byte_budget);
    assert.deepEqual(await packCriterionEvidence({ criteria: input.criteria.slice().reverse().map((row) => ({ ...row, evidence: row.evidence.slice().reverse() })) }, read, { format, byteBudget: cut.byte_budget }), cut);
    // A receipt-only budget remains useful and does not drop a criterion.
    const receiptOnly = await packCriterionEvidence(input, read, { format, byteBudget: 1250 });
    assert.equal(receiptOnly.criteria.length, 4);
    assert.ok(receiptOnly.evidence.length < full.evidence.length);
  }
  assert.equal(JSON.stringify(input), original);
  const defaults = await packCriterionEvidence({ criteria: [input.criteria[1]!] }, read);
  assert.equal(defaults.byte_budget, 4000);
  assert.equal(defaults.criteria[0]!.state, "linked");
  const unlinked = { criteria: [input.criteria[2]!] };
  const empty = await packCriterionEvidence(unlinked, read, { format: "json" });
  assert.deepEqual(empty.evidence, []);
  assert.equal(empty.source_fields_read, 0);
  // Stable budget digits let this hit the exact receipt boundary.
  const receiptBudget = Buffer.byteLength(encodeEvidencePack({ ...empty, byte_budget: 999, byte_upper_bound: 999 }, "json"));
  const exact = await packCriterionEvidence(unlinked, read, { format: "json", byteBudget: receiptBudget });
  assert.ok(exact.byte_upper_bound <= receiptBudget);
  await assert.rejects(packCriterionEvidence(input, read, { byteBudget: 512 }), code("BUDGET_TOO_SMALL"));
  for (const byteBudget of [0, 511, 262145, NaN, Infinity, 512.5]) await assert.rejects(packCriterionEvidence(input, read, { byteBudget }), code("INVALID_ARGUMENT"));
  await assert.rejects(packCriterionEvidence(input, read, { format: "bad" as "toon" }), code("INVALID_ARGUMENT"));
  assert.throws(() => encodeEvidencePack(empty, "bad" as "toon"), code("INVALID_ARGUMENT"));
  for (const binding of [{ item: "missing-item", field: "title" }, { item: item.id, field: "absent_field" }]) {
    await assert.rejects(packCriterionEvidence({ criteria: [{ id: "missing", text: "Unavailable binding", evidence: [binding] }] }, read), code("SOURCE_UNAVAILABLE"));
  }
  // Validate the backend adapter boundary; these are not replacements for SDK storage tests.
  for (const value of [null, { title: null }, { title: { present: false } }, { title: { present: true } }, { title: { present: true, value: "x".repeat(8388609) } }, { title: { present: true, value: 1n } }]) {
    await assert.rejects(packCriterionEvidence(packet(), async () => value), code("SOURCE_UNAVAILABLE"));
  }
  assert.equal(fingerprint(pmRoot), before);
});

test("installed command and compiled SDK return bounded lossless JSON/TOON with no Git executable or tracker writes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "criterion-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("criterion", { defaults: true, author: "fixture-agent", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const item = (await create({ title: "CLI recorded title", author: "fixture-agent" }, { cwd: root, pmRoot })).item;
  const input = packet(); input.criteria[0]!.evidence[0]!.item = item.id;
  const packetPath = join(root, "packet.json"); writeFileSync(packetPath, JSON.stringify(input));
  assert.deepEqual(readEvidencePacket(packetPath), input);
  assert.throws(() => readEvidencePacket(join(root, "missing.json")), code("INPUT_UNAVAILABLE"));
  const invalid = join(root, "invalid.json"); writeFileSync(invalid, "invalid");
  assert.throws(() => readEvidencePacket(invalid), code("INPUT_UNAVAILABLE"));
  writeFileSync(invalid, "{}"); assert.throws(() => readEvidencePacket(invalid), code("INVALID_PACKET"));
  const packageRoot = resolve(import.meta.dirname, "..");
  const installed = join(pmRoot, "extensions", "pm-context"); mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const noGit = join(root, "no-git"); mkdirSync(noGit);
  /** Exercise the installed package through the real parser without a Git executable. */
  function run(args: string[]) {
    return spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-evidence", ...args], {
      cwd: root, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM_"))), PM_PATH: pmRoot, PM_AUTHOR: "fixture-agent", PATH: noGit, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
  }
  const before = fingerprint(pmRoot);
  for (const format of ["json", "toon"] as const) {
    const result = run(["--packet", packetPath, "--format", format]);
    assert.equal(result.status, 0, result.stderr);
    const expected = await packCriterionEvidence(input, createFreshnessReader(pmRoot, root), { format });
    assert.equal(result.stdout, encodeEvidencePack(expected, format));
    assert.ok(Buffer.byteLength(result.stdout) <= 4000);
  }
  const global = run(["--packet", packetPath, "--json"]);
  assert.equal(global.status, 0, global.stderr);
  assert.equal(JSON.parse(global.stdout).criteria[0].state, "linked");
  for (const args of [[], ["--packet", packetPath, "--format", "bad"], ["--packet", packetPath, "extra"], ["--packet", packetPath, "--byte-budget", "NaN"], ["--packet", packetPath, "--byte-budget", "512"]]) {
    const result = run([...args, "--json"]);
    assert.equal(result.status, 2, result.stderr);
    const error = JSON.parse(result.stderr) as { code: string; detail: string; next_steps: string[] };
    assert.match(error.code, /INVALID_ARGUMENT|BUDGET_TOO_SMALL/);
    assert.ok(error.next_steps.length > 0);
    assert.ok(!JSON.stringify({ detail: error.detail, remedies: error.next_steps }).includes(root));
  }
  for (const module of [extension, builtExtension]) {
    const harness = await createExtensionTestHarness(module, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
    t.after(() => harness.deactivate());
    const handler = harness.activation.commands.handlers.find((entry) => entry.command === "context-evidence")!;
    for (const global of [{}, { json: true }]) {
      const result = await handler.run({ command: "context-evidence", args: [], pm_root: pmRoot, options: { packet: packetPath }, global }) as { output: string };
      assert.ok(Buffer.byteLength(result.output) <= 4000);
    }
    const explicit = await harness.runCommand({ command: "context-evidence", pmRoot, options: { packet: packetPath, format: "toon", "byte-budget": "4000" }, global: {} });
    assert.equal(explicit.errorMessage, undefined);
    for (const options of [{}, { packet: packetPath, format: "bad" }]) await assert.rejects(harness.runCommand({ command: "context-evidence", pmRoot, options, global: {} }), code("INVALID_ARGUMENT"));
    await assert.rejects(harness.runCommand({ command: "context-evidence", pmRoot, args: ["extra"], options: { packet: packetPath }, global: {} }), code("INVALID_ARGUMENT"));
  }
  assert.equal(fingerprint(pmRoot), before);
});
