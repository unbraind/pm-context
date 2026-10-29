import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, focus, init, isPmCliExpectedError, readSettings, resolveRuntimeStatusRegistry, schemaAddStatus, update } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { runWithActiveExtensions } from "@unbrained/pm-cli/sdk/runtime";
import extension, { createFreshnessReader, createSharedEvidenceReader, encodeSharedEvidence, packCriterionEvidence, packSharedEvidence, parseSharedEvidenceRequest } from "../index.ts";
import type { SharedEvidencePack, SharedEvidenceRequest } from "../index.ts";
import builtExtension from "../dist/index.js";

/** Typed refusal assertions also require the host remedy contract. */
function code(expected: string) { return (error: unknown) => isPmCliExpectedError(error) && error.code === expected && error.exitCode === 2 && "remedy" in error && typeof error.remedy === "string" && error.remedy.length > 0; }
/** Read-only packet operations must preserve all tracker bytes, including runtime files. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const row of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    hash.update(row.name).update(row.isSymbolicLink() ? readlinkSync(join(root, row.name)) : row.isDirectory() ? fingerprint(join(root, row.name)) : readFileSync(join(root, row.name)));
  }
  return hash.digest("hex");
}
/** Scratch trackers are deliberately outside Git and contain no SDK mocks. */
async function tracker() {
  const root = mkdtempSync(join(tmpdir(), "shared-evidence-"));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("shared", { defaults: true, author: "fixture", agentGuidance: "skip" }, client);
  const { item } = await create({ title: "Shared source", description: "Exact 📚 fragment, with quotes \" and CRLF\r\n".repeat(50), author: "fixture", parent: "none", goal: "none", objective: "none", assignee: "none", clearDeps: true }, client);
  return { root, client, item };
}
/** One criterion can be repeated without losing its independent binding. */
function request(item = "shared-task", count = 1): SharedEvidenceRequest {
  return { criteria: Array.from({ length: count }, (_, i) => ({ id: `AC${i}`, text: `Criterion ${i}`, evidence: [{ item, field: "description" }] })), byte_budget: 262144, format: "json" };
}
/** Reconstruct each binding by joining its packet-local fragment identity. */
function expanded(pack: SharedEvidencePack) {
  const fragments = new Map(pack.fragments.map((row) => [row.id, row]));
  return pack.representation === "expanded" ? pack.evidence : pack.bindings.map((row) => ({ ...row, revision: fragments.get(row.id)!.revision, value_json: fragments.get(row.id)!.value_json }));
}
/** Both encoders preserve exact native values and self-inclusive finite byte ceilings. */
function roundtrip(pack: SharedEvidencePack, format: "json" | "toon") {
  const output = encodeSharedEvidence(pack, format);
  assert.deepEqual(format === "json" ? JSON.parse(output) : decodeToon(output), pack);
  assert.ok(Buffer.byteLength(output) <= pack.byte_upper_bound && pack.byte_upper_bound <= pack.byte_budget);
}

test("strict shared request schema rejects malformed, sparse, exotic and extreme inputs before reads", async () => {
  const base = request(); const row = base.criteria[0]!;
  const extra = [row]; Object.assign(extra, { surprise: true });
  const exotic = new Array(1); Object.assign(exotic, { surprising: row });
  const bad: unknown[] = [null, undefined, [], {}, new Date(), Object.create(null), { ...base, extra: 1 }, { ...base, format: "bad" }, { ...base, representation: "bad" },
    { ...base, format: undefined }, { ...base, representation: undefined }, { ...base, criteria: new Array(1) }, { ...base, criteria: new Array(4294967295) }, { ...base, criteria: extra }, { ...base, criteria: exotic },
    { criteria: [{ ...row, evidence: new Array(4294967295) }] },
    { criteria: [{ ...row, evidence: new Array(1) }] }, { criteria: [new Date()] }, { criteria: [{ ...row, id: "../private" }] },
    { criteria: [{ ...row, text: "x".repeat(262145) }] }, { criteria: [row, row] },
  ];
  const large = { criteria: Array.from({ length: 128 }, (_, i) => ({ id: `c${i}`, text: "x".repeat(1024), evidence: Array.from({ length: 4 }, (_, j) => ({ item: "i".repeat(128), field: `${j}${"f".repeat(127)}` })) })) };
  bad.push(structuredClone(large));
  let excess = Buffer.byteLength(JSON.stringify(large)) - 262140;
  for (const criterion of large.criteria) { const cut = Math.min(excess, criterion.text.length - 1); criterion.text = criterion.text.slice(cut); excess -= cut; }
  assert.equal(excess, 0); assert.equal(parseSharedEvidenceRequest(large).criteria.length, 128);
  bad.push({ ...large, byte_budget: 262144 });
  for (const byte_budget of [0, -1, 511, 262145, 512.1, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, undefined]) bad.push({ ...base, byte_budget });
  for (const value of bad) {
    assert.throws(() => parseSharedEvidenceRequest(value), code("INVALID_REQUEST"));
    await assert.rejects(packSharedEvidence(value as SharedEvidenceRequest, async () => { assert.fail("invalid input read a source"); }), code("INVALID_REQUEST"));
  }
  const defaults = parseSharedEvidenceRequest({ criteria: [row] });
  assert.equal(defaults.byte_budget, 4000); assert.equal(defaults.format, "toon"); assert.equal(defaults.representation, "factored");
  assert.equal(parseSharedEvidenceRequest({ ...base, byte_budget: 512, format: "toon", representation: "expanded" }).byte_budget, 512);
});

test("twenty real SDK bindings retain twenty citation paths, one text copy and equivalent expanded coverage", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const read = createSharedEvidenceReader(client.pmRoot);
  const input = request(item.id, 20); const original = JSON.stringify(input); const before = fingerprint(client.pmRoot);
  for (const format of ["json", "toon"] as const) {
    const factored = await packSharedEvidence({ ...input, format }, read); roundtrip(factored, format);
    const full = await packSharedEvidence({ ...input, format, representation: "expanded" }, read); roundtrip(full, format);
    const legacy = await packCriterionEvidence({ criteria: input.criteria }, createFreshnessReader(client.pmRoot, root), { byteBudget: 262144, format });
    assert.equal(factored.bindings.length, 20); assert.equal(factored.fragments.length, 1); assert.equal(factored.source_fields_read, 1);
    assert.equal(new Set(factored.bindings.map((row) => row.criterion)).size, 20);
    assert.ok(factored.bindings.every((row) => row.item === item.id && row.field === "description" && row.context_ref === `packet:fragments:${factored.fragments[0]!.id}`));
    assert.deepEqual(expanded(factored), full.evidence); assert.deepEqual(factored.criteria, full.criteria); assert.deepEqual(factored.criteria, legacy.criteria);
    assert.ok(Buffer.byteLength(encodeSharedEvidence(factored, format)) < Buffer.byteLength(encodeSharedEvidence(full, format)));
    const cut = await packSharedEvidence({ ...input, format, byte_budget: factored.byte_upper_bound }, read);
    assert.deepEqual(cut.criteria, factored.criteria, "inclusive byte bound retains all bindings");
    const tight = await packSharedEvidence({ ...input, format, byte_budget: factored.byte_upper_bound - 300 }, read); roundtrip(tight, format);
    assert.ok(tight.criteria.some((row) => row.state === "budget_omitted"));
    assert.ok(tight.criteria.every((row) => row.packed === 0 || row.packed === row.required));
    const permuted = { ...input, format, criteria: input.criteria.slice().reverse() };
    assert.deepEqual(await packSharedEvidence(permuted, read), factored);
  }
  const empty = await packSharedEvidence({ criteria: [{ id: "none", text: "No declared evidence", evidence: [] }] }, read); roundtrip(empty, "toon");
  assert.equal(empty.criteria[0]!.state, "unlinked"); assert.deepEqual(empty.fragments, []);
  await assert.rejects(packSharedEvidence({ ...input, byte_budget: 512 }, read), code("BUDGET_TOO_SMALL"));
  assert.equal(JSON.stringify(input), original); assert.equal(fingerprint(client.pmRoot), before);
  const first = await read({ item: item.id, field: "description" });
  await update(item.id, { description: "Changed away", author: "fixture", parent: "none", goal: "none", objective: "none" }, client);
  await update(item.id, { description: first.value as string, author: "fixture", parent: "none", goal: "none", objective: "none" }, client);
  const restored = await read({ item: item.id, field: "description" });
  assert.equal(restored.value, first.value); assert.notEqual(restored.revision, first.revision, "ABA never reuses the historical revision");
  const both = { criteria: [{ id: "old", text: "Old revision", evidence: [{ item: "old", field: "body" }] }, { id: "new", text: "New revision", evidence: [{ item: "new", field: "body" }] }], byte_budget: 20000 };
  const historical = await packSharedEvidence(both, async (binding) => binding.item === "old" ? first : restored);
  assert.equal(historical.fragments.length, 2);
  const sharedAcrossItems = await packSharedEvidence(both, async () => first);
  assert.equal(sharedAcrossItems.fragments.length, 1); assert.equal(sharedAcrossItems.bindings.length, 2);
  for (const order of [["a", "b", "c"], ["a", "c", "b"], ["b", "a", "c"], ["b", "c", "a"], ["c", "a", "b"], ["c", "b", "a"]]) {
    const input = { criteria: order.map((item, i) => ({ id: `c${i}`, text: "Distinct fragment", evidence: [{ item, field: "body" }] })), byte_budget: 20000 };
    const pack = await packSharedEvidence(input, async ({ item }) => ({ revision: "revision", value: item }));
    assert.deepEqual(pack.fragments.map((row) => row.id), pack.fragments.map((row) => row.id).sort());
    assert.equal(pack.fragments.length, 3);
  }
});

test("finite JSON source and output fuzz refuses lossy values and preserves previous-version compatible values", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const read = createSharedEvidenceReader(client.pmRoot);
  await assert.rejects(packSharedEvidence(request("missing"), read), code("SOURCE_UNAVAILABLE"));
  const missing = request(item.id); missing.criteria[0]!.evidence[0]!.field = "missing";
  await assert.rejects(packSharedEvidence(missing, read), code("SOURCE_UNAVAILABLE"));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let deep: unknown = null; for (let i = 0; i < 26; i++) deep = { child: deep };
  const source = { revision: "revision-1", value: "native" };
  const bad: unknown[] = [null, [], {}, { ...source, extra: true }, { ...source, revision: 1 }, { ...source, revision: " " }, { ...source, revision: "x".repeat(257) }];
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol(), () => 1, new Date(), new Array(1), cyclic, deep, Array.from({ length: 100001 }, () => 1), "x".repeat(8388609)]) bad.push({ ...source, value });
  for (const value of bad) await assert.rejects(packSharedEvidence(request(), async () => value as typeof source), code("SOURCE_UNAVAILABLE"));
  const prototypeKeys = JSON.parse('{"constructor":"valid","__proto__":"valid"}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(prototypeKeys), Object.prototype);
  assert.equal(Object.hasOwn(prototypeKeys, "__proto__"), true);
  assert.equal(prototypeKeys["__proto__"], "valid");
  for (const value of [null, true, false, 0, Number.MIN_VALUE, Number.MAX_VALUE, -1.5, "  body\r\n", [], {}, { nested: [1, "x", null], optional: undefined }, prototypeKeys]) {
    const pack = await packSharedEvidence(request(), async () => ({ revision: "revision-1", value }));
    roundtrip(pack, "json"); assert.deepEqual(JSON.parse(pack.fragments[0]!.value_json), JSON.parse(JSON.stringify(value)));
  }
  const pack = await packSharedEvidence(request(item.id), read);
  for (const value of [NaN, Infinity, -1, 0.5, 262145]) {
    assert.throws(() => encodeSharedEvidence({ ...pack, source_fields_read: value }, "json"), code("INVALID_OUTPUT"));
    assert.throws(() => encodeSharedEvidence({ ...pack, criteria: [{ ...pack.criteria[0]!, required: value }] }, "json"), code("INVALID_OUTPUT"));
  }
  for (const changed of [{ byte_budget: 511 }, { byte_upper_bound: 262145 }, { source_fields_read: 513 }, { criteria: [{ ...pack.criteria[0]!, required: 513 }] }, { criteria: [{ ...pack.criteria[0]!, packed: 2 }] }]) assert.throws(() => encodeSharedEvidence({ ...pack, ...changed }, "json"), code("INVALID_OUTPUT"));
  assert.throws(() => encodeSharedEvidence(pack, "bad" as "json"), code("INVALID_OUTPUT"));
});

test("500 seeded state sequences preserve all native fields, relationships, old-request replays and whitespace through SDK read-back", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const peer = (await create({ title: "Related peer", author: "fixture", parent: "none", goal: "none", objective: "none", assignee: "none", clearDeps: true }, client)).item;
  await update(item.id, {
    author: "fixture", parent: peer.id, goal: "Goal", objective: "Objective", assignee: "fixture", reviewer: "reviewer", priority: 0, tags: "one,two", deadline: "2030-01-01", estimatedMinutes: "13", body: "Body\r\n", acceptanceCriteria: "One; Two", definitionOfReady: "Ready", order: "12", risk: "medium", confidence: "85", sprint: "future", release: "future", value: "Value", impact: "Impact", outcome: "Outcome", whyNow: "Reason", blockedBy: peer.id, blockedReason: "Wait", reporter: "fixture", severity: "high", environment: "test", reproSteps: "Reproduce", resolution: "Pending", expectedResult: "Expected", actualResult: "Actual", affectedVersion: "old", fixedVersion: "new", component: "context", regression: "true", customerImpact: "Bounded", comment: ["text=Comment"], note: ["text=Note"], learning: ["text=Learning"], file: ["path=index.ts"], test: ["command=node --version"], doc: ["path=README.md"], reminder: ["at=2030-01-01T00:00:00Z,text=Reminder"], event: ["start=2030-01-01T00:00:00Z,end=2030-01-01T01:00:00Z,title=Event"], replaceDeps: true, dep: [`id=${peer.id},kind=related_to`],
  }, client);
  const sdkRead = createFreshnessReader(client.pmRoot, root); const read = createSharedEvidenceReader(client.pmRoot);
  const initial = await sdkRead({ kind: "item", id: item.id }) as Record<string, unknown>;
  const fields = Object.keys(initial); assert.ok(fields.length >= 45);
  let seed = 0x29fa2026;
  /** Deterministic operation selection provides a reproducible model transcript. */
  function random(max: number) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; }
  const custom: string[] = [];
  for (let i = 0; i < 5; i++) {
    const name = `stage_${random(100000)}_${i}`; custom.push(name);
    await schemaAddStatus(name, { role: ["active"], author: "fixture" }, client);
  }
  const registry = resolveRuntimeStatusRegistry((await readSettings(client.pmRoot)).schema);
  assert.ok(custom.every((name) => registry.active_statuses.has(name)));
  const saved: SharedEvidenceRequest[] = []; const seen = new Set<string>(); let roundtrips = 0; let refusals = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    await focus(random(2) ? peer.id : item.id, {}, client);
    const variant = [" text ", "\r\nparagraph\r\n", "\nparagraph\n", "", "é📚,\"\\"][random(5)]!;
    await update(item.id, { author: "fixture", description: variant, body: variant, priority: random(5), status: custom[random(5)]!, parent: random(2) ? peer.id : "none", goal: "Goal", objective: "Objective", replaceDeps: true, dep: [`id=${peer.id},kind=${random(2) ? "related_to" : "blocked_by"}`] }, client);
    // The reference model stores authoritative SDK state, never a handwritten
    // approximation of native trimming, status aliases or relationship parsing.
    const model = await sdkRead({ kind: "item", id: item.id }) as Record<string, unknown>;
    const selected = [...new Set([fields[sequence % fields.length]!, fields[random(fields.length)]!])];
    const fresh: SharedEvidenceRequest = { criteria: [{ id: "A", text: "Current fields", evidence: selected.map((field) => ({ item: item.id, field })) }, { id: "B", text: "Shared field", evidence: [{ item: item.id, field: selected[0]! }] }], byte_budget: 262144 };
    saved.push(fresh);
    for (const input of [fresh, saved[random(saved.length)]!]) {
      const format = random(2) ? "json" : "toon";
      const replay = JSON.parse(JSON.stringify(input, null, 2).replaceAll("\n", "\r\n")) as SharedEvidenceRequest;
      const before = fingerprint(client.pmRoot);
      if (replay.criteria.some((criterion) => criterion.evidence.some((binding) => !Object.hasOwn(model, binding.field)))) {
        for (const representation of ["factored", "expanded"] as const) { await assert.rejects(packSharedEvidence({ ...replay, format, representation }, read), code("SOURCE_UNAVAILABLE")); refusals++; }
        assert.equal(fingerprint(client.pmRoot), before); continue;
      }
      const factored = await packSharedEvidence({ ...replay, format }, read); roundtrip(factored, format);
      const full = await packSharedEvidence({ ...replay, format, representation: "expanded" }, read); roundtrip(full, format);
      roundtrips += 2;
      assert.deepEqual(expanded(factored), full.evidence); assert.deepEqual(factored.criteria, full.criteria);
      for (const row of expanded(factored)) { seen.add(row.field); assert.deepEqual(JSON.parse(row.value_json), JSON.parse(JSON.stringify(model[row.field]))); }
      assert.deepEqual(await sdkRead({ kind: "item", id: item.id }), model);
      assert.equal(fingerprint(client.pmRoot), before);
    }
    const reread = await sdkRead({ kind: "item", id: item.id }) as Record<string, unknown>; assert.equal(reread.id, item.id);
  }
  assert.deepEqual([...seen].sort(), fields.sort());
  t.diagnostic(`500 sequences; ${fields.length} native fields; ${roundtrips} representation round trips; ${refusals} matching missing-field refusals; current and older inputs; no writes`);
});

test("native reader detects competing SDK transitions at every item/history boundary and supports absent legacy history", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const extensionPath = join(client.pmRoot, "extensions", "race-fixture"); mkdirSync(extensionPath, { recursive: true });
  const packageRoot = resolve(import.meta.dirname, ".."); symlinkSync(join(packageRoot, "node_modules"), join(extensionPath, "node_modules"), "dir");
  writeFileSync(join(extensionPath, "manifest.json"), JSON.stringify({ name: "race-fixture", version: "1.0.0", entry: "index.mjs", capabilities: ["hooks"] }));
  const controlPath = join(root, "race.json");
  writeFileSync(join(extensionPath, "index.mjs"), `import {readFileSync,writeFileSync} from 'node:fs';
import {update} from '@unbrained/pm-cli/sdk';
export function activate(api) {
  let reads=0, fired=false;
  api.hooks.onRead(async ({path}) => {
    const control=JSON.parse(readFileSync(${JSON.stringify(controlPath)},'utf8'));
    if (!path.endsWith(control.id+'.toon') && !path.endsWith(control.id+'.jsonl')) return;
    if (++reads!==control.boundary || fired) return;
    fired=true;
    await update(control.id,{description:'Competing transition',author:'peer',parent:'none',goal:'none',objective:'none'}, {cwd:${JSON.stringify(root)},pmRoot:${JSON.stringify(client.pmRoot)},noExtensions:true});
    writeFileSync(${JSON.stringify(controlPath)},JSON.stringify({...control,fired:true}));
  });
}`);
  for (let boundary = 1; boundary <= 4; boundary++) {
    await update(item.id, { description: "Before peer", author: "fixture", parent: "none", goal: "none", objective: "none" }, client);
    const original = await createSharedEvidenceReader(client.pmRoot)({ item: item.id, field: "description" });
    writeFileSync(controlPath, JSON.stringify({ id: item.id, boundary, fired: false }));
    const result = runWithActiveExtensions({ cwd: root, path: client.pmRoot }, () => packSharedEvidence(request(item.id), createSharedEvidenceReader(client.pmRoot)));
    if (boundary < 4) await assert.rejects(result, code("SOURCE_UNAVAILABLE"));
    else {
      // History observers run after bytes were read. A writer after the last
      // read is the explicitly documented remaining optimistic-read window.
      const pack = await result;
      assert.equal(pack.fragments[0]!.revision, original.revision);
      assert.equal(JSON.parse(pack.fragments[0]!.value_json), original.value);
    }
    assert.equal(JSON.parse(readFileSync(controlPath, "utf8")).fired, true, `missed boundary ${boundary}`);
  }
  unlinkSync(join(client.pmRoot, "history", `${item.id}.jsonl`));
  const legacy = await packSharedEvidence(request(item.id), createSharedEvidenceReader(client.pmRoot));
  assert.equal(legacy.fragments.length, 1);
  appendFileSync(join(client.pmRoot, "tasks", `${item.id}.toon`), `\nforeign_tree:\n${Array.from({ length: 26 }, (_, i) => `${"  ".repeat(i + 1)}level:\n`).join("")}${"  ".repeat(27)}value: true\n`);
  await assert.rejects(packSharedEvidence(request(item.id), createSharedEvidenceReader(client.pmRoot)), code("SOURCE_UNAVAILABLE"));
});

test("installed CLI and compiled SDK work without Git and refuse malformed guards without side effects", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = resolve(import.meta.dirname, ".."); const installed = join(client.pmRoot, "extensions", "pm-context");
  mkdirSync(installed, { recursive: true }); cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json")); cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true }); symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const noGit = join(root, "no-git"); mkdirSync(noGit);
  const path = join(root, "packet.json"); const input = request(item.id, 3); writeFileSync(path, JSON.stringify(input));
  const before = fingerprint(client.pmRoot);
  for (const module of [extension, builtExtension]) {
    const harness = await createExtensionTestHarness(module, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
    t.after(() => harness.deactivate());
    for (const options of [{}, { packet: " " }]) await assert.rejects(harness.runCommand({ command: "context-evidence-shared", pmRoot: client.pmRoot, options }), code("INVALID_REQUEST"));
    await assert.rejects(harness.runCommand({ command: "context-evidence-shared", pmRoot: client.pmRoot, options: { packet: path }, args: ["extra"] }), code("INVALID_REQUEST"));
    for (const global of [{ json: false }, { json: true }]) {
      const result = await harness.runCommand({ command: "context-evidence-shared", pmRoot: client.pmRoot, options: { packet: path }, global }); assert.equal(result.errorMessage, undefined);
    }
    await harness.runCommand({ command: "context-evidence-shared", pmRoot: client.pmRoot, options: { packet: path, format: "toon" }, global: {} });
    await assert.rejects(harness.runCommand({ command: "context-evidence-shared", pmRoot: client.pmRoot, options: { packet: path, format: " " } }), code("INVALID_REQUEST"));
    for (const invalid of ["null", "[]", "0"]) {
      writeFileSync(path, invalid);
      await assert.rejects(harness.runCommand({ command: "context-evidence-shared", pmRoot: client.pmRoot, options: { packet: path } }), code("INVALID_REQUEST"));
    }
    writeFileSync(path, JSON.stringify({ criteria: input.criteria, byte_budget: input.byte_budget }));
    await harness.runCommand({ command: "context-evidence-shared", pmRoot: client.pmRoot, options: { packet: path }, global: { json: false } });
    writeFileSync(path, JSON.stringify(input));
  }
  for (const format of ["json", "toon"] as const) {
    writeFileSync(path, JSON.stringify({ ...input, format }));
    const result = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-evidence-shared", "--packet", path], { cwd: root, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM_"))), PM_PATH: client.pmRoot, PM_AUTHOR: "fixture", PATH: noGit, GIT_CEILING_DIRECTORIES: tmpdir() } });
    assert.equal(result.status, 0, result.stderr); const pack = await packSharedEvidence({ ...input, format }, createSharedEvidenceReader(client.pmRoot)); assert.equal(result.stdout, encodeSharedEvidence(pack, format));
  }
  assert.equal(fingerprint(client.pmRoot), before);
});
