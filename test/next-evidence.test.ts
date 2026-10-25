import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { decodePmTableRows } from "@unbrained/pm-cli/sdk";
import { init, isPmCliExpectedError, PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { createFreshnessReader, encodeNextEvidencePlan, parseNextEvidencePacket, planNextEvidence, readNextEvidenceJson, validateNextEvidencePlan } from "../index.ts";
import type { NextEvidencePacket } from "../index.ts";
import builtExtension from "../dist/index.js";

/** Three overlapping alternatives expose the difference between greedy ranking and exact cover. */
function packet(): NextEvidencePacket {
  return { contract_revision: "criteria-v1", missing: ["A", "B", "C"], tool_call_tokens: 10, reads: [
    { id: "ab", source: "tracker", revision: "r1", covers: ["A", "B"], estimated_tokens: 20, estimated_tool_calls: 1 },
    { id: "bc", source: "tracker", revision: "r1", covers: ["B", "C"], estimated_tokens: 20, estimated_tool_calls: 1 },
    { id: "all", source: "tracker", revision: "r1", covers: ["A", "B", "C"], estimated_tokens: 45, estimated_tool_calls: 1 },
  ] };
}
/** Expected errors carry safe actionable host-compatible metadata. */
function code(expected: string) { return (error: unknown) => isPmCliExpectedError(error) && error.code === expected && error.exitCode === 2 && "remedy" in error && typeof error.remedy === "string" && error.remedy.length > 0; }
/** Observe every tracker file, including records belonging to foreign writers. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    hash.update(entry.name); hash.update(entry.isSymbolicLink() ? "link" : entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}

test("exact cover beats greedy selection; deterministic marginal ranking, cost units and uncovered criteria", () => {
  const input = packet(); const original = structuredClone(input);
  const plan = planNextEvidence(input);
  assert.deepEqual(plan.steps.map((row) => row.read), ["all"]);
  assert.equal(plan.cost, 55); assert.equal(plan.estimated_tokens, 45); assert.equal(plan.estimated_tool_calls, 1);
  assert.deepEqual(plan.uncovered, []); assert.equal(plan.reads_executed, 0);
  assert.deepEqual(input, original);
  assert.deepEqual(planNextEvidence({ ...input, reads: [...input.reads].reverse(), missing: [...input.missing].reverse() }), plan);
  input.reads[2]!.estimated_tokens = 100;
  const pair = planNextEvidence(input);
  assert.deepEqual(pair.steps.map((row) => [row.read, row.adds]), [["ab", ["A", "B"]], ["bc", ["C"]]]);
  input.reads[1]!.estimated_tokens = 1;
  assert.equal(planNextEvidence(input).steps[0]!.read, "bc");
  input.reads = input.reads.slice(0, 1);
  assert.deepEqual(planNextEvidence(input).uncovered, ["C"]);
  assert.match(planNextEvidence(input).remedy, /uncovered/);
  assert.equal(planNextEvidence({ ...input, missing: [], reads: [] }).cost, 0);
  assert.deepEqual(planNextEvidence({ ...input, reads: [] }).uncovered, ["A", "B", "C"]);
  input.reads.push({ ...input.reads[0]!, id: "irrelevant", covers: [] });
  assert.equal(planNextEvidence(input).steps.length, 1);
  const zero = { ...input, reads: [{ ...input.reads[0]!, estimated_tokens: 0 }] };
  assert.equal(planNextEvidence(zero).cost, 10);
  zero.reads[0]!.estimated_tokens = 5; zero.reads[0]!.estimated_tool_calls = 0;
  assert.equal(planNextEvidence(zero).cost, 5);
  assert.equal(planNextEvidence({ ...zero, reads: [...zero.reads, { ...zero.reads[0]!, id: "aa" }] }).steps[0]!.read, "aa");
});

test("strict bounded declarations refuse malformed inputs without truncation or normalization", () => {
  const p = packet(); const row = p.reads[0]!; const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const badReads = [null, [], {}, { ...row, extra: 1 }, { ...row, id: "../x" }, { ...row, source: " " }, { ...row, revision: " " }, { ...row, revision: "x".repeat(257) }, { ...row, covers: null }, { ...row, covers: ["unknown"] }, { ...row, covers: ["A", "A"] }, { ...row, estimated_tokens: -1 }, { ...row, estimated_tokens: 1000001 }, { ...row, estimated_tool_calls: 1001 }, { ...row, estimated_tool_calls: 1.5 }, { ...row, estimated_tokens: 0, estimated_tool_calls: 0 }];
  for (const value of [undefined, null, [], {}, cyclic, { ...p, extra: 1 }, { ...p, contract_revision: " " }, { ...p, tool_call_tokens: 0 }, { ...p, tool_call_tokens: Infinity }, { ...p, missing: null }, { ...p, missing: ["A", "A"] }, { ...p, missing: [null] }, { ...p, missing: Array.from({ length: 13 }, (_, i) => `a${i}`) }, { ...p, reads: null }, { ...p, reads: Array.from({ length: 65 }, (_, i) => ({ ...row, id: `r${i}` })) }, { ...p, reads: [row, row] }, { ...p, reads: [row, { ...row, id: "other", revision: "different" }] }, { ...p, contract_revision: "x".repeat(262145) }, ...badReads.map((read) => ({ ...p, reads: [read] }))]) assert.throws(() => parseNextEvidencePacket(value), code("INVALID_PACKET"));
  const exact = { ...p, contract_revision: " r1\r\n ", reads: [{ ...row, revision: " r2\r\n ", covers: ["B", "A"] }] };
  assert.equal(parseNextEvidencePacket(exact).contract_revision, exact.contract_revision);
  assert.equal(parseNextEvidencePacket(exact).reads[0]!.revision, exact.reads[0]!.revision);
  assert.deepEqual(parseNextEvidencePacket(exact).reads[0]!.covers, ["A", "B"]);
});

test("saved JSON plans bind every source contract and estimate; malformed or modified plans refuse", () => {
  const input = packet(); const plan = planNextEvidence(input);
  assert.deepEqual(validateNextEvidencePlan(JSON.parse(encodeNextEvidencePlan(plan, "json")), input), plan);
  for (const value of [null, [], {}, { ...plan, protocol: "other" }, { ...plan, contract: 3 }]) assert.throws(() => validateNextEvidencePlan(value, input), code("INVALID_PLAN"));
  for (const value of [{ ...plan, cost: 0 }, { ...plan, steps: [] }, { ...plan, extra: 1 }]) assert.throws(() => validateNextEvidencePlan(value, input), code("INVALID_PLAN"));
  const variants = [ { ...input, contract_revision: "v2" }, { ...input, tool_call_tokens: 11 }, { ...input, missing: ["A", "B", "C", "D"] }, { ...input, reads: input.reads.slice(0, 2) }, ...["source", "revision", "estimated_tokens", "estimated_tool_calls", "covers"].map((field) => ({ ...input, reads: input.reads.map((row) => ({ ...row, [field]: field === "covers" ? ["A"] : field === "source" ? "other" : field === "revision" ? "r2" : 2 })) })) ];
  for (const variant of variants) assert.throws(() => validateNextEvidencePlan(plan, variant), code("STALE_PLAN"));
  assert.throws(() => encodeNextEvidencePlan(plan, "xml" as "toon"), code("INVALID_ARGUMENT"));
  assert.deepEqual(decodePlanToon(encodeNextEvidencePlan(plan)), plan);
});

/** Restore nested cells using the SDK's explicit table encoding metadata. */
function decodePlanToon(encoded: string) {
  const { steps, steps_encoding, ...summary } = decodeToon(encoded) as Record<string, unknown>;
  return { ...summary, steps: decodePmTableRows({ rows: steps, encoding: steps_encoding } as Parameters<typeof decodePmTableRows>[0]) };
}

/** Exhaustive subset model independent of the production dynamic-programming optimizer. */
function reference(input: NextEvidencePacket) {
  const coverable = new Set(input.reads.flatMap((row) => row.covers));
  let best = Infinity;
  for (let subset = 0; subset < 2 ** input.reads.length; subset++) {
    const reads = input.reads.filter((_, index) => subset & (1 << index));
    const covered = new Set(reads.flatMap((row) => row.covers));
    if ([...coverable].every((entry) => covered.has(entry))) best = Math.min(best, reads.reduce((sum, row) => sum + row.estimated_tokens + input.tool_call_tokens * row.estimated_tool_calls, 0));
  }
  return { cost: best, uncovered: input.missing.filter((entry) => !coverable.has(entry)).sort() };
}

test("500 seeded operation sequences: replay, whitespace, revisions and serialization preserve optimal plans and SDK-read tracker state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "next-evidence-model-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("acquisition", { defaults: true, author: "fixture-agent", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const client = new PmClient({ cwd: root, pmRoot, author: "fixture-agent" });
  const parent = (await client.create({ title: "Parent" })).item;
  const child = (await client.create({ title: " Title \r\n ", description: " Description \r\n ", body: " Body\r\n ", parent: parent.id, tags: "test", acceptanceCriteria: "explicit" })).item;
  await client.update(child.id, { dep: [`id=${parent.id},kind=related_to`] });
  // Full native SDK state is the reference: no handwritten normalization of fields or relationships.
  const read = createFreshnessReader(pmRoot, root);
  const model = [await read({ kind: "item", id: parent.id }), await read({ kind: "item", id: child.id })]; const before = fingerprint(pmRoot);
  let seed = 0x2a105eed;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const file = join(root, "packet.json");
  for (let sequence = 0; sequence < 500; sequence++) {
    const input: NextEvidencePacket = { contract_revision: `revision-${sequence} \r\n`, missing: Array.from({ length: 1 + random(6) }, (_, i) => `C${i}`), reads: [], tool_call_tokens: 1 + random(20) };
    input.reads = Array.from({ length: random(8) }, (_, i) => ({ id: `R${i}`, source: `S${i}`, revision: `r${random(10)} \r\n`, covers: input.missing.filter(() => random(3) === 0), estimated_tokens: 1 + random(100), estimated_tool_calls: random(3) }));
    const old = structuredClone(input); const saved = planNextEvidence(input);
    for (let operation = 0; operation < 4; operation++) {
      if (operation === 1) input.contract_revision += "new";
      if (operation === 2) Object.assign(input, structuredClone(old)); // replay an older input after a newer revision
      if (operation === 3) { input.reads.reverse(); input.missing.reverse(); }
      writeFileSync(file, JSON.stringify(input, null, operation % 2 ? 2 : 0).replace(/\n/g, "\r\n"));
      const parsed = parseNextEvidencePacket(readNextEvidenceJson(file)); const actual = planNextEvidence(parsed); const expected = reference(parsed);
      assert.equal(actual.cost, expected.cost); assert.deepEqual(actual.uncovered, expected.uncovered);
      assert.equal(actual.reads_executed, 0);
      if (operation === 1) assert.throws(() => validateNextEvidencePlan(saved, parsed), code("STALE_PLAN"));
      else assert.deepEqual(validateNextEvidencePlan(saved, parsed), actual);
      assert.deepEqual(JSON.parse(encodeNextEvidencePlan(actual, "json")), actual);
      assert.deepEqual(decodePlanToon(encodeNextEvidencePlan(actual, "toon")), actual);
      // Read back through the real SDK after every operation, including relationships and every native field.
      assert.deepEqual([await read({ kind: "item", id: parent.id }), await read({ kind: "item", id: child.id })], model);
    }
  }
  assert.equal(fingerprint(pmRoot), before);
});

test("installed CLI and SDK work without Git, write nothing, and revalidate saved plans with typed remedies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "next-evidence-cli-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm"); await init("acquisition", { defaults: true, author: "fixture-agent", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const packageRoot = resolve(import.meta.dirname, ".."); const installed = join(pmRoot, "extensions", "pm-context"); mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json")); cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true }); symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const path = join(root, "packet.json"); const saved = join(root, "plan.json"); const input = packet(); writeFileSync(path, JSON.stringify(input)); writeFileSync(saved, encodeNextEvidencePlan(planNextEvidence(input), "json"));
  assert.throws(() => readNextEvidenceJson(join(root, "absent")), code("INPUT_UNAVAILABLE"));
  const bad = join(root, "bad.json"); writeFileSync(bad, "bad"); assert.throws(() => readNextEvidenceJson(bad), code("INPUT_UNAVAILABLE"));
  const noGit = join(root, "no-git"); mkdirSync(noGit);
  const before = fingerprint(pmRoot);
  const run = (args: string[]) => spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-next-evidence", ...args], { cwd: root, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM_"))), PM_PATH: pmRoot, PM_AUTHOR: "fixture-agent", PATH: noGit, GIT_CEILING_DIRECTORIES: tmpdir() } });
  for (const format of ["json", "toon"] as const) {
    const result = run(["--packet", path, "--format", format]); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, encodeNextEvidencePlan(planNextEvidence(input), format));
  }
  const checked = run(["--packet", path, "--check", saved, "--json"]); assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).cost, 55);
  for (const args of [[], ["--packet", path, "--format", "bad"], ["--packet", path, "extra"]]) {
    const result = run([...args, "--json"]); assert.equal(result.status, 2); const error = JSON.parse(result.stderr); assert.equal(error.code, "INVALID_ARGUMENT"); assert.ok(error.next_steps.length); assert.ok(!JSON.stringify({ detail: error.detail, next_steps: error.next_steps }).includes(root));
  }
  for (const module of [extension, builtExtension]) {
    const harness = await createExtensionTestHarness(module, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] }); t.after(() => harness.deactivate());
    for (const options of [{ packet: path }, { packet: path, format: "json", check: saved }]) {
      const result = await harness.runCommand({ command: "context-next-evidence", pmRoot, options, global: {} }); assert.equal(result.errorMessage, undefined);
    }
    const handler = harness.activation.commands.handlers.find((entry) => entry.command === "context-next-evidence")!;
    for (const global of [{}, { json: true }]) {
      const result = await handler.run({ command: "context-next-evidence", args: [], pm_root: pmRoot, options: { packet: path }, global }) as { output: string };
      assert.equal(result.output, encodeNextEvidencePlan(planNextEvidence(input), global.json ? "json" : "toon"));
    }
    for (const options of [{}, { packet: path, format: "bad" }]) await assert.rejects(harness.runCommand({ command: "context-next-evidence", pmRoot, options, global: {} }), code("INVALID_ARGUMENT"));
    await assert.rejects(harness.runCommand({ command: "context-next-evidence", pmRoot, args: ["extra"], options: { packet: path }, global: {} }), code("INVALID_ARGUMENT"));
  }
  input.contract_revision = "v2"; writeFileSync(path, JSON.stringify(input)); const stale = run(["--packet", path, "--check", saved, "--json"]); assert.equal(stale.status, 2); assert.equal(JSON.parse(stale.stderr).code, "STALE_PLAN");
  assert.equal(fingerprint(pmRoot), before);
});

test("peer transitions at every planning boundary on one non-git tracker preserve foreign state and invalidate old snapshots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "next-evidence-peer-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm"); await init("peers", { defaults: true, author: "fixture-agent", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const peer = new PmClient({ cwd: root, pmRoot, author: "peer-agent" });
  const item = (await peer.create({ title: "Peer-owned revision", body: "Foreign content" })).item;
  const foreign = join(pmRoot, "foreign-plan.json"); const foreignBytes = "unrecognized external record\r\n"; writeFileSync(foreign, foreignBytes);
  const read = createFreshnessReader(pmRoot, root);
  const current = async () => createHash("sha256").update(JSON.stringify(await read({ kind: "item", id: item.id }))).digest("hex");
  for (let boundary = 0; boundary < 5; boundary++) {
    let peerSucceeded = false;
    const compete = async (step: number) => {
      if (step === boundary) { await peer.update(item.id, { description: `peer revision ${boundary}` }); peerSucceeded = true; }
    };
    await compete(0);
    const input = packet(); input.contract_revision = await current(); // snapshot boundary
    await compete(1);
    const plan = planNextEvidence(input); // optimization boundary
    await compete(2);
    const saved = JSON.parse(encodeNextEvidencePlan(plan, "json")); // serialization boundary
    await compete(3);
    const now = { ...input, contract_revision: await current() };
    if (boundary > 0 && boundary < 4) assert.throws(() => validateNextEvidencePlan(saved, now), code("STALE_PLAN"));
    else assert.deepEqual(validateNextEvidencePlan(saved, now), plan);
    await compete(4); // a later peer write does not retroactively change a value snapshot
    assert.equal(peerSucceeded, true);
    const state = await read({ kind: "item", id: item.id }) as Record<string, unknown>;
    assert.equal(state.description, `peer revision ${boundary}`);
    assert.equal(state.body, "Foreign content");
    assert.equal(readFileSync(foreign, "utf8"), foreignBytes);
    assert.equal(plan.reads_executed, 0);
  }
});
