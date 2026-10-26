import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, get, init, isPmCliExpectedError, isReadOutputSessionReference, readSettings, resolveRuntimeStatusRegistry, schemaAddStatus, update } from "@unbrained/pm-cli/sdk";
import type { PmClientOptions, PmReadOutputSessionState } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildPhaseContext, encodePhaseContext, parsePhaseContextRequest, readPhaseContextJson, TASK_PHASES } from "../index.ts";
import type { PhaseContextPacket, PhaseContextRequest, TaskPhase } from "../index.ts";
import builtExtension from "../dist/index.js";

/** A bounded contract with both overlapping and disjoint mandatory field groups. */
function request(id = "fixture-task"): PhaseContextRequest {
  return { phase: "investigation", items: [id], contracts: { investigation: ["title", "description"], implementation: ["title", "body"], review: ["title", "acceptance_criteria"], handoff: ["title", "status"] } };
}
/** Each refusal carries a stable code and a concrete host-compatible remedy. */
function code(expected: string) { return (error: unknown) => isPmCliExpectedError(error) && error.code === expected && error.exitCode === 2 && "remedy" in error && typeof error.remedy === "string" && error.remedy.length > 0; }
/** Hash the complete tracker tree, including runtime, to detect accidental writes. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isSymbolicLink() ? readlinkSync(join(root, entry.name)) : entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}
/** Test fixtures are plain directories, never repositories or SDK mocks. */
async function tracker() {
  const root = mkdtempSync(join(tmpdir(), "task-phase-"));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("phase", { defaults: true, agentGuidance: "skip", author: "fixture" }, client);
  const { item } = await create({ title: "Quoted \"task\", café 📚", description: "  Original\r\nquestion  ", body: "  body\r\nparagraph\n", acceptanceCriteria: "Checks preserved", author: "fixture" }, client);
  return { root, client, item };
}
/** Compare both agent transports to the typed result, including exact inclusive size. */
function roundtrip(packet: PhaseContextPacket) {
  const encoded = encodePhaseContext(packet);
  assert.deepEqual(packet.format === "json" ? JSON.parse(encoded) : decodeToon(encoded), packet);
  assert.equal(Buffer.byteLength(encoded), packet.bytes);
  assert.ok(packet.bytes <= packet.byte_budget);
  if (packet.read_session) assert.equal(packet.read_session.spent_this_call_tokens, Math.ceil(Buffer.byteLength(JSON.stringify(packet)) / 4));
}

test("one strict request schema rejects sparse arrays, nonfinite numbers, unknown qualifiers and every bounded domain", () => {
  const base = request(); const cyclic: Record<string, unknown> = {}; cyclic.loop = cyclic;
  const session = { version: 1, id: "session", token_budget: 10000, spent_tokens: 0, seen_item_ids: [] };
  const values: unknown[] = [undefined, null, [], cyclic, new Date(), {}, { ...base, extra: true },
    { ...base, phase: "plan" }, { ...base, previous_phase: null }, { ...base, items: [] }, { ...base, items: new Array(1) },
    { ...base, items: ["x", "x"] }, { ...base, items: ["../private"] }, { ...base, items: Array.from({ length: 33 }, (_, i) => `i${i}`) },
    { ...base, contracts: [] }, { ...base, contracts: { ...base.contracts, extra: ["title"] } }, { ...base, contracts: { investigation: ["title"] } },
    { ...base, contracts: { ...base.contracts, review: [] } }, { ...base, contracts: { ...base.contracts, review: new Array(2) } },
    { ...base, contracts: { ...base.contracts, review: ["/metadata/title"] } }, { ...base, contracts: { ...base.contracts, review: ["title", "title"] } },
    { ...base, contracts: { ...base.contracts, review: Array.from({ length: 33 }, (_, i) => `f${i}`) } },
    { ...base, include_fields: ["title", "title"] }, { ...base, include_fields: ["x".repeat(65)] }, { ...base, include_fields: "body" },
    { ...base, format: "markdown" }, { ...base, format: undefined }, { ...base, session: null }, { ...base, session: "session" },
    { ...base, session: { ...session, seen_item_ids: new Array(1) } }, { ...base, session: { ...session, spent_tokens: 10001 } },
    { ...base, session: { ...session, version: 2 } }, { ...base, session: { ...session, id: "../private" } }, { ...base, session: { ...session, extra: true } },
    { ...base, session: { ...session, seen_item_ids: Array.from({ length: 10001 }, (_, i) => `f${i}`) } },
    { ...base, extra: "x".repeat(262145) }, { ...base, extra: Array.from({ length: 20001 }, () => 0) },
  ];
  const extraKeys = ["tag"]; Object.assign(extraKeys, { surprise: "title" });
  values.push({ ...base, items: extraKeys });
  for (const byte_budget of [-1, 0, 511, 262145, 513.5, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE]) values.push({ ...base, byte_budget });
  for (const value of values) assert.throws(() => parsePhaseContextRequest(value), code("INVALID_REQUEST"));
  assert.deepEqual(parsePhaseContextRequest({ ...base, session }).session, session);
  const reordered = { ...base, items: ["z", "a"], include_fields: ["tags", "id"], byte_budget: 512, format: "json" as const, previous_phase: "review" as const };
  assert.deepEqual(parsePhaseContextRequest(reordered).items, ["a", "z"]);
  assert.deepEqual(parsePhaseContextRequest(reordered).include_fields, ["id", "tags"]);
  assert.equal(parsePhaseContextRequest(base).byte_budget, 16000);
  assert.equal(parsePhaseContextRequest(base).format, "toon");
});

test("four real SDK phase fixtures preserve every mandatory field or refuse, with executable restoration and no writes", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = await state(client, item.id);
  const before = fingerprint(client.pmRoot);
  for (const phase of TASK_PHASES) for (const format of ["json", "toon"] as const) {
    const input = { ...request(item.id), phase, format, byte_budget: 16000 };
    const packet = await buildPhaseContext(input, client.pmRoot); roundtrip(packet);
    assert.deepEqual(packet.mandatory_fields, input.contracts[phase].slice().sort());
    assert.equal(packet.bindings.length, input.contracts[phase].length);
    for (const binding of packet.bindings) {
      const fact = packet.facts.find((row) => row.id === binding.fact)!;
      assert.ok("value_json" in fact);
      assert.deepEqual(JSON.parse(fact.value_json), original[binding.field]);
      assert.ok(binding.mandatory);
    }
    assert.equal(packet.bindings.some((row) => row.field === "tags"), false);
    const omitted = packet.omission_receipt.omitted_field_groups.find((row) => row.name === `${item.id}.tags`)!;
    assert.equal(omitted.restore_with, `pm get ${item.id} --fields tags --output-budget unbounded`);
    const restored = await buildPhaseContext({ ...input, include_fields: ["tags"] }, client.pmRoot);
    assert.ok(restored.bindings.some((row) => row.field === "tags" && !row.mandatory));
    const missing = { ...input, contracts: { ...input.contracts, [phase]: ["missing_native_field"] } };
    await assert.rejects(buildPhaseContext(missing, client.pmRoot), code("MISSING_FIELD"));
    await assert.rejects(buildPhaseContext({ ...input, byte_budget: 512 }, client.pmRoot), code("BUDGET_TOO_SMALL"));
  }
  const switched = await buildPhaseContext({ ...request(item.id), phase: "implementation", previous_phase: "investigation", include_fields: ["description"] }, client.pmRoot);
  assert.deepEqual(switched.changes.map(({ field, change }) => [field, change]), [["body", "added"], ["description", "removed"], ["title", "retained"]]);
  assert.match(switched.changes[1]!.reason, /investigation; optional in implementation/);
  assert.ok(switched.bindings.find((row) => row.field === "description" && !row.mandatory), "removed mandatory requirement can still be explicitly restored");
  assert.equal(fingerprint(client.pmRoot), before);
  await assert.rejects(buildPhaseContext(request("phase-absent"), client.pmRoot), code("SOURCE_UNAVAILABLE"));
  writeFileSync(join(client.pmRoot, "settings.json"), "invalid");
  await assert.rejects(buildPhaseContext(request(item.id), client.pmRoot), code("SOURCE_UNAVAILABLE"));
});

test("phase switches reuse unchanged SDK field references, deliver new fields and reread current state after old-request replay", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const session: PmReadOutputSessionState = { version: 1, id: "phase-session", token_budget: 50000, spent_tokens: 0, seen_item_ids: [] };
  const input = { ...request(item.id), session };
  const before = JSON.stringify(input);
  const first = await buildPhaseContext(input, client.pmRoot); roundtrip(first);
  const second = await buildPhaseContext({ ...input, phase: "implementation", previous_phase: "investigation", session: first.read_session!.next_state }, client.pmRoot); roundtrip(second);
  const shared = second.bindings.find((row) => row.field === "title")!;
  const newField = second.bindings.find((row) => row.field === "body")!;
  assert.ok(isReadOutputSessionReference(second.facts.find((row) => row.id === shared.fact)));
  assert.ok(!isReadOutputSessionReference(second.facts.find((row) => row.id === newField.fact)));
  assert.equal(second.read_session!.suppressed_repeat_count, 1);
  assert.equal(second.read_session!.new_item_count, 1);
  assert.equal(JSON.stringify(input), before, "caller state is immutable");
  await update(item.id, { title: "Changed after earlier session", author: "fixture" }, client);
  const replay = await buildPhaseContext({ ...input, session: second.read_session!.next_state }, client.pmRoot);
  const changed = replay.bindings.find((row) => row.field === "title")!;
  const current = await state(client, item.id);
  const fact = replay.facts.find((row) => row.id === changed.fact)!;
  assert.ok("value_json" in fact); assert.equal(JSON.parse(fact.value_json), current.title);
  assert.notEqual(changed.fact, shared.fact);
  const exhausted = { ...session, spent_tokens: session.token_budget };
  await assert.rejects(buildPhaseContext({ ...input, session: exhausted }, client.pmRoot), code("BUDGET_TOO_SMALL"));
});

test("deep source data and aggregate source limits refuse before producing a packet", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(client.pmRoot, "tasks", `${item.id}.toon`);
  appendFileSync(path, `\ncustom_tree:\n${Array.from({ length: 22 }, (_, i) => `${"  ".repeat(i + 1)}level:\n`).join("")}${"  ".repeat(23)}value: true\n`);
  await assert.rejects(buildPhaseContext(request(item.id), client.pmRoot), code("SOURCE_UNAVAILABLE"));
  const ids: string[] = [];
  for (let i = 0; i < 32; i++) {
    const created = await create({ title: `Large source ${i}`, body: "x".repeat(248000), comment: Array.from({ length: 200 }, () => "text=x"), author: "fixture", allowDuplicate: true }, client);
    ids.push(created.item.id);
  }
  const contracts = Object.fromEntries(TASK_PHASES.map((phase) => [phase, ["title"]])) as Record<TaskPhase, string[]>;
  await assert.rejects(buildPhaseContext({ items: ids, phase: "review", contracts, byte_budget: 262144 }, client.pmRoot), code("SOURCE_UNAVAILABLE"));
});

test("independent concurrent readers preserve foreign records and all configured status roles", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(client.pmRoot, "runtime"), { recursive: true });
  writeFileSync(join(client.pmRoot, "runtime", "foreign-record.json"), '{"owner":"peer","revision":7}\n');
  const roles = [["active"], ["active", "blocked"], ["terminal", "terminal_done"], ["terminal", "terminal_canceled"]];
  for (let i = 0; i < roles.length; i++) {
    const status = `custom_${(Math.imul(i + 7, 2654435761) >>> 0).toString(16)}`;
    await schemaAddStatus(status, { role: roles[i], author: "fixture" }, client);
    await update(item.id, { status, closeReason: "Fixture terminal transition", force: true, author: "fixture" }, client);
    const current = await state(client, item.id, ["status", "title"]);
    const before = fingerprint(client.pmRoot);
    const input = { ...request(item.id), phase: "handoff" as const };
    const packets = await Promise.all(Array.from({ length: 8 }, (_, j) => buildPhaseContext({ ...input, session: { version: 1, id: `reader-${j}`, token_budget: 50000, spent_tokens: 0, seen_item_ids: [] } }, client.pmRoot)));
    for (const packet of packets) {
      const binding = packet.bindings.find((row) => row.field === "status")!;
      const fact = packet.facts.find((row) => row.id === binding.fact)!; assert.ok("value_json" in fact);
      assert.equal(JSON.parse(fact.value_json), current.status); roundtrip(packet);
    }
    assert.equal(fingerprint(client.pmRoot), before);
  }
});

test("strict emitted counters and extreme serialized values cannot produce a successful invalid envelope", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const packet = await buildPhaseContext(request(item.id), client.pmRoot);
  for (const bytes of [NaN, Infinity, -Infinity, -1, 0.1, Number.MAX_VALUE, 262145]) assert.throws(() => encodePhaseContext({ ...packet, bytes }), code("INVALID_OUTPUT"));
  for (const byte_budget of [511, 262145]) assert.throws(() => encodePhaseContext({ ...packet, byte_budget }), code("INVALID_OUTPUT"));
  assert.throws(() => encodePhaseContext({ ...packet, format: "bad" as "json" }), code("INVALID_OUTPUT"));
  // Output fuzz covers both encodings, Unicode growth and exact boundary budgets.
  let seed = 99173;
  for (let i = 0; i < 40; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    await update(item.id, { description: ["📚\r\n", "\"\\", " ", "é"][seed % 4]!.repeat(seed % 2500), author: "fixture" }, client);
    const input = { ...request(item.id), format: i % 2 ? "json" as const : "toon" as const, byte_budget: 262144 };
    const full = await buildPhaseContext(input, client.pmRoot); roundtrip(full);
    const exact = await buildPhaseContext({ ...input, byte_budget: full.bytes }, client.pmRoot); roundtrip(exact);
    await assert.rejects(buildPhaseContext({ ...input, byte_budget: full.bytes - 8 }, client.pmRoot), code("BUDGET_TOO_SMALL"));
  }
});

test("installed CLI and compiled SDK work with Git absent and expose typed private-path-free refusals", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  await update(item.id, { body: "Complete mandatory body. ".repeat(250), author: "fixture" }, client);
  const packageRoot = resolve(import.meta.dirname, "..");
  const installed = join(client.pmRoot, "extensions", "pm-context"); mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const path = join(root, "packet.json"); writeFileSync(path, JSON.stringify(request(item.id)));
  assert.deepEqual(readPhaseContextJson(path), request(item.id));
  for (const invalid of [join(root, "absent"), root]) assert.throws(() => readPhaseContextJson(invalid), code("INPUT_UNAVAILABLE"));
  const bad = join(root, "bad.json"); writeFileSync(bad, "{"); assert.throws(() => readPhaseContextJson(bad), code("INPUT_UNAVAILABLE"));
  const noGit = join(root, "no-git"); mkdirSync(noGit);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM_"))), PM_PATH: client.pmRoot, PM_AUTHOR: "fixture", PATH: noGit, GIT_CEILING_DIRECTORIES: tmpdir() };
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  /** Invoke the real installed parser with no executable named git on PATH. */
  function run(args: string[]) { return spawnSync(process.execPath, [cli, "context-phase", ...args], { cwd: root, env, encoding: "utf8" }); }
  // Warm only host-owned discovery before checking the feature's read-only path.
  const warm = run(["--packet", path]); assert.equal(warm.status, 0, warm.stderr);
  const before = fingerprint(client.pmRoot);
  for (const format of ["json", "toon"] as const) {
    const result = run(["--packet", path, "--phase", "implementation", "--previous-phase", "investigation", "--include-fields", "description", "--byte-budget", "16000", "--format", format]);
    assert.equal(result.status, 0, result.stderr);
    const packet = await buildPhaseContext({ ...request(item.id), phase: "implementation", previous_phase: "investigation", include_fields: ["description"], byte_budget: 16000, format }, client.pmRoot);
    assert.equal(result.stdout, encodePhaseContext(packet));
  }
  assert.equal(JSON.parse(run(["--packet", path, "--json"]).stdout).ok, true);
  for (const args of [[], ["--packet", path, "extra"], ["--packet", path, "--format", "bad"], ["--packet", path, "--byte-budget", "Infinity"], ["--packet", path, "--byte-budget", "512"], ["--packet", bad]]) {
    const result = run([...args, "--json"]); assert.equal(result.status, 2, result.stderr);
    const error = JSON.parse(result.stderr) as { code: string; detail: string; next_steps: string[] };
    assert.match(error.code, /INVALID_REQUEST|INPUT_UNAVAILABLE|BUDGET_TOO_SMALL/);
    assert.ok(error.next_steps.length > 0); assert.ok(!JSON.stringify({ detail: error.detail, remedies: error.next_steps }).includes(root));
  }
  for (const invalid of [null, [], 2]) { writeFileSync(bad, JSON.stringify(invalid)); assert.equal(run(["--packet", bad, "--json"]).status, 2); }
  for (const module of [extension, builtExtension]) {
    const harness = await createExtensionTestHarness(module, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] }); t.after(() => harness.deactivate());
    for (const global of [{}, { json: true }]) {
      const out = await harness.runCommand({ command: "context-phase", pmRoot: client.pmRoot, options: { packet: path }, global }); assert.equal(out.errorMessage, undefined);
    }
    for (const options of [
      { packet: path, phase: "implementation", "previous-phase": "investigation", "include-fields": "description", "byte-budget": "16000", format: "toon" },
      { packet: path, phase: "implementation", previousPhase: "investigation", includeFields: "description", byteBudget: "16000", format: "json" },
    ]) {
      const out = await harness.runCommand({ command: "context-phase", pmRoot: client.pmRoot, options, global: { json: true } });
      assert.equal(out.errorMessage, undefined);
    }
    await assert.rejects(harness.runCommand({ command: "context-phase", pmRoot: client.pmRoot, options: {}, global: {} }), code("INVALID_REQUEST"));
    for (const invalid of [null, [], 2]) {
      writeFileSync(bad, JSON.stringify(invalid));
      await assert.rejects(harness.runCommand({ command: "context-phase", pmRoot: client.pmRoot, options: { packet: bad }, global: {} }), code("INVALID_REQUEST"));
    }
  }
  assert.equal(fingerprint(client.pmRoot), before);
});

/** Read the reference state through SDK get, never through local normalization rules. */
async function state(client: PmClientOptions, id: string, fields?: string[]): Promise<Record<string, unknown>> {
  const projection = fields ? { fields: fields.join(",") } : { full: true };
  const result = await get(id, { ...projection, outputBudget: "unbounded", outputLimit: "unbounded" }, client);
  assert.ok("item" in result);
  return JSON.parse(JSON.stringify(result.item)) as Record<string, unknown>;
}

test("500 seeded operation sequences model JSON/TOON export, old-input replay, CRLF, native fields and relationships against SDK-read state", async (t) => {
  const { root, client, item } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const peer = (await create({ title: "Related native item", author: "fixture" }, client)).item;
  // Seed every family of native field available to metadata mutation, including
  // nested collections. Packet round trips never mutate or normalize this state.
  await update(item.id, {
    author: "fixture", priority: 0, tags: "a,b", deadline: "2030-01-01", estimatedMinutes: "13", assignee: "fixture", parent: peer.id,
    reviewer: "reviewer", risk: "medium", confidence: "85", sprint: "2026.10", release: "2026.10.25", definitionOfReady: "Ready",
    order: "12", goal: "Goal", objective: "Objective", value: "Value", impact: "Impact", outcome: "Outcome", whyNow: "Reason",
    blockedBy: peer.id, blockedReason: "Wait for peer", reporter: "fixture", severity: "high", environment: "test", reproSteps: "Reproduce",
    resolution: "Pending", expectedResult: "Expected", actualResult: "Actual", affectedVersion: "2026.10.1", fixedVersion: "2026.10.25", component: "context", regression: "true", customerImpact: "Bounded",
    comment: ["text=Comment"], note: ["text=Note"], learning: ["text=Learning"], file: ["path=index.ts"], test: ["command=node --version"], doc: ["path=README.md"],
    reminder: ["at=2030-01-01T00:00:00Z,text=Reminder"], event: ["start=2030-01-01T00:00:00Z,end=2030-01-01T01:00:00Z,title=Event"], dep: [`id=${peer.id},kind=related_to`],
  }, client);
  const seeded = await state(client, item.id);
  const fields = Object.keys(seeded).filter((name) => !["notes_count", "tests_count", "collection_counts"].includes(name));
  assert.ok(fields.length >= 45, `expected broad native scope, received ${fields.length}`);
  let seed = 0x21facade;
  /** Deterministic PRNG keeps failures replayable without timing-based seeds. */
  function random(max: number) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; }
  const saved: PhaseContextRequest[] = [];
  const delivered = new Map<string, string>();
  const coordinates = new Map<string, { id: string; value: unknown }>();
  let session: PmReadOutputSessionState = { version: 1, id: "model", token_budget: Number.MAX_SAFE_INTEGER, spent_tokens: 0, seen_item_ids: [] };
  const seenFields = new Set<string>();
  const custom: string[] = [];
  for (let i = 0; i < 8; i++) {
    const name = `state_${random(1_000_000)}_${i}`;
    await schemaAddStatus(name, { role: ["active"], author: "fixture" }, client); custom.push(name);
  }
  const registry = resolveRuntimeStatusRegistry((await readSettings(client.pmRoot)).schema);
  assert.ok(custom.every((name) => registry.active_statuses.has(name)));
  for (let sequence = 0; sequence < 500; sequence++) {
    const variant = [" text ", "\r\nparagraph\r\n", "\nparagraph\n", "", "é📚,\"\\", "replayed"][random(6)]!;
    await update(item.id, { author: "fixture", description: variant, body: variant, priority: random(5), status: custom[random(custom.length)]!, replaceDeps: true, dep: [`id=${peer.id},kind=${random(2) ? "related_to" : "blocked_by"}`] }, client);
    const selectedFields = [fields[sequence % fields.length]!, fields[random(fields.length)]!, "title"];
    const contracts = Object.fromEntries(TASK_PHASES.map((phase) => [phase, [...new Set([selectedFields[random(selectedFields.length)]!, "title"])]])) as Record<TaskPhase, string[]>;
    const fresh: PhaseContextRequest = { items: [item.id], phase: TASK_PHASES[random(4)]!, contracts, format: random(2) ? "json" : "toon", byte_budget: 262144 };
    saved.push(fresh);
    // Five operations per sequence: current request, phase switch, old request
    // replay, explicit native-field restore, and replay of an older session.
    const operations: PhaseContextRequest[] = [fresh, { ...fresh, phase: TASK_PHASES[random(4)]!, previous_phase: fresh.phase }, saved[random(saved.length)]!, { ...fresh, include_fields: [...new Set(selectedFields)] }, { ...fresh }];
    const olderSession = structuredClone(session);
    const current = await state(client, item.id, fields);
    for (let op = 0; op < operations.length; op++) {
      const input = JSON.parse(JSON.stringify({ ...operations[op]!, session: op === 4 ? olderSession : session }, null, 2).replaceAll("\n", "\r\n")) as PhaseContextRequest;
      const snapshot = fingerprint(client.pmRoot);
      const output = await buildPhaseContext(input, client.pmRoot); roundtrip(output);
      assert.equal(fingerprint(client.pmRoot), snapshot, "export/replay must leave tracker bytes unchanged");
      const expected = new Set([...input.contracts[input.phase], ...(input.include_fields ?? [])]);
      assert.deepEqual(new Set(output.bindings.map((binding) => binding.field)), expected);
      for (const binding of output.bindings) {
        seenFields.add(binding.field);
        const row = output.facts.find((fact) => fact.id === binding.fact)!;
        const coordinate = `${binding.item}/${binding.field}`;
        if (isReadOutputSessionReference(row)) {
          assert.ok(input.session!.seen_item_ids.includes(row.id));
          assert.deepEqual(JSON.parse(delivered.get(row.id)!), current[binding.field], `stale reference at sequence ${sequence}`);
        } else {
          assert.deepEqual(JSON.parse(row.value_json), current[binding.field]);
          delivered.set(row.id, row.value_json);
        }
        const prior = coordinates.get(coordinate);
        if (prior && JSON.stringify(prior.value) === JSON.stringify(current[binding.field]) && input.session!.seen_item_ids.includes(prior.id)) assert.ok(isReadOutputSessionReference(row));
        coordinates.set(coordinate, { id: row.id, value: current[binding.field] });
      }
      assert.deepEqual(await state(client, item.id, fields), current, "SDK read-back agrees after every import/export/replay");
      session = output.read_session!.next_state;
    }
  }
  assert.deepEqual([...seenFields].sort(), fields.sort(), "every seeded native field participates in the model");
});
