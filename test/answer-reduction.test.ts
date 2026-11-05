import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, init, isPmCliExpectedError, update } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { createSharedEvidenceReader } from "../index.ts";
import builtExtension from "../dist/index.js";
import * as api from "../answer-reduction.ts";
import * as built from "../dist/answer-reduction.js";
import { assertAnswers, fingerprint, routingRequest } from "./answer-reduction-fixture.ts";

process.env.GIT_CEILING_DIRECTORIES = tmpdir();

/** Refusals must expose stable categories and concrete remedies through the host contract. */
function code(expected: string) { return (error: unknown) => isPmCliExpectedError(error) && error.code === expected && error.exitCode === 2 && "remedy" in error && typeof error.remedy === "string" && error.remedy.length > 0; }
/** Native tracker fixture with explicit scope clearing and no enclosing git repository. */
async function tracker() {
  const root = mkdtempSync(join(tmpdir(), "answer-reduction-"));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("answer", { defaults: true, author: "fixture", agentGuidance: "skip" }, client);
  const { item } = await create({ title: "Route café 📚", description: "Original\r\nparagraph \"quoted\". ".repeat(400), author: "fixture", unset: ["parent", "goal", "objective", "sprint", "release", "assignee"], clearDeps: true }, client);
  return { root, client, item, read: createSharedEvidenceReader(client.pmRoot) };
}
/** Both transports must validate and round-trip through exactly the producer schema. */
function roundtrip(packet: api.AnswerReduction) {
  for (const format of ["json", "toon"] as const) {
    const encoded = api.encodeAnswerReduction(packet, format);
    const decoded = format === "json" ? JSON.parse(encoded) : decodeToon(encoded);
    assert.deepEqual(api.parseAnswerReduction(decoded), packet);
  }
}

test("exhaustive routing reduction keeps every answer, with at least half the bytes including proofs", async (t) => {
  const { root, client, item, read } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = fingerprint(client.pmRoot); const request = routingRequest(item.id);
  for (const implementation of [api, built]) {
    const full = await implementation.reduceAnswerContext(request, read, "full");
    const reduced = await implementation.reduceAnswerContext(request, read);
    roundtrip(full); roundtrip(reduced); assertAnswers(full); assertAnswers(reduced);
    assert.deepEqual(reduced.relevant_variables, ["urgent"]);
    assert.equal(reduced.fragments[1]!.state, "omitted"); assert.equal(reduced.fragments[0]!.state, "retained");
    assert.equal(reduced.proofs[0]!.contexts, 2);
    assert.equal(new Set(reduced.proofs[0]!.branches.map((branch) => branch.answers_sha256)).size, 1);
    assert.deepEqual(await implementation.validateAnswerReduction(reduced, request, read), reduced);
    for (const format of ["json", "toon"] as const) assert.ok(Buffer.byteLength(implementation.encodeAnswerReduction(reduced, format)) * 2 <= Buffer.byteLength(implementation.encodeAnswerReduction(full, format)));
    await assert.rejects(implementation.reduceAnswerContext(request, read, "bad" as "full"), code("INVALID_ARGUMENT"));
  }
  assert.equal(fingerprint(client.pmRoot), before);
  const old = await api.reduceAnswerContext(request, read);
  await update(item.id, { description: "Intermediate", author: "fixture", unset: ["parent", "goal", "objective", "sprint", "release"], clearDeps: true }, client);
  await update(item.id, { description: item.description, author: "fixture", unset: ["parent", "goal", "objective", "sprint", "release"], clearDeps: true }, client);
  await assert.rejects(api.validateAnswerReduction(old, request, read), code("STALE_PACKET"));
  assert.notEqual((await api.reduceAnswerContext(request, read)).fragments[1]!.revision, old.fragments[1]!.revision, "ABA replay is revision-bound");
});

test("interactions, first-match rules, exact scalar boundaries, empty domains and unknown predicates", async (t) => {
  const { root, item, read } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = routingRequest(item.id);
  input.rules[1]!.answer = "different";
  const interacting = await api.reduceAnswerContext(input, read); assertAnswers(interacting);
  assert.deepEqual(interacting.proofs, []); assert.ok(interacting.fragments.every((row) => row.state === "retained"));
  input.rules.unshift({ when: [], answer: "constant" });
  const constant = await api.reduceAnswerContext(input, read); assertAnswers(constant);
  assert.equal(constant.proofs.length, 2); assert.deepEqual(constant.routing, [{ inputs: [], answer: "constant" }]);
  input.rules[1]!.when[0]!.op = "regex";
  const unknown = await api.reduceAnswerContext(input, read); roundtrip(unknown);
  assert.equal(unknown.state, "unknown"); assert.deepEqual(unknown.proofs, []); assert.deepEqual(unknown.routing, []);
  assert.ok(unknown.fragments.every((row) => row.state === "retained"), "even unreachable unknown predicates retain evidence");
  const empty = { contract_revision: " legacy\r\n ", variables: [], rules: [], fallback: "constant", fragments: [{ id: "constructor", item: item.id, field: "description", variables: [] }] };
  const vacuous = await api.reduceAnswerContext(empty, read); roundtrip(vacuous); assertAnswers(vacuous);
  assert.equal(vacuous.fragments[0]!.state, "omitted"); assert.equal(vacuous.combinations, 1);
  for (const value of [null, true, false, "", "  \r\n ", -1e12, 1e12, Number.MIN_VALUE]) {
    const exact: api.AnswerReductionRequest = { ...empty, variables: [{ id: "constructor", values: [value, "other"] }], rules: [{ when: [{ variable: "constructor", op: "neq", value }], answer: "not-equal" }] };
    const result = await api.reduceAnswerContext(exact, read); assertAnswers(result); roundtrip(result);
  }
  const maximum = { ...empty, variables: Array.from({ length: 4 }, (_, i) => ({ id: `v${i}`, values: Array.from({ length: 8 }, (_, j) => j) })) };
  assert.equal((await api.reduceAnswerContext(maximum, read)).combinations, 4096);
});

test("strict request schema refuses sparse, exotic, nonfinite and oversized inputs before reads", async () => {
  const p = routingRequest("answer-task"); const v = p.variables[0]!; const r = p.rules[0]!; const pred = r.when[0]!; const f = p.fragments[0]!;
  const hook = Object.defineProperty({ ...p }, "toJSON", { value() { throw new Error("must not serialize"); } });
  const accessor = Object.defineProperty({ ...p }, "fallback", { get() { throw new Error("must not read"); } });
  const invalid: unknown[] = [undefined, null, [], new Date(), {}, hook, accessor, { ...p, surprise: true }, { ...p, fallback: " " }, { ...p, contract_revision: "x".repeat(257) },
    { ...p, variables: new Array(2) }, { ...p, rules: new Array(1) }, { ...p, fragments: new Array(1) },
    ...[null, {}, { ...v, id: "../bad" }, { ...v, values: [] }, { ...v, values: new Array(1) }, { ...v, values: [true, true] }, { ...v, values: [undefined] }, { ...v, extra: true }].map((variable) => ({ ...p, variables: [variable] })),
    { ...p, variables: [v, v] }, { ...p, variables: Array.from({ length: 9 }, (_, i) => ({ id: `v${i}`, values: [0] })) },
    { ...p, variables: Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, values: [0, 1, 2, 3, 4, 5, 6, 7] })) },
    ...[null, {}, { ...r, extra: true }, { ...r, answer: " " }, { ...r, when: new Array(1) }, { ...r, when: new Array(9).fill(pred) }].map((rule) => ({ ...p, rules: [rule] })),
    ...[null, {}, { ...pred, op: " " }, { ...pred, variable: "absent" }, { ...pred, extra: true }, { ...pred, value: "not-in-domain" }].map((predicate) => ({ ...p, rules: [{ ...r, when: [predicate] }] })),
    ...[null, {}, { ...f, extra: true }, { ...f, item: ".." }, { ...f, field: " " }, { ...f, variables: ["absent"] }, { ...f, variables: ["urgent", "urgent"] }, { ...f, variables: new Array(1) }].map((fragment) => ({ ...p, fragments: [fragment] })),
    { ...p, fragments: [f, f] }, { ...p, fragments: new Array(65).fill(f) }, { ...p, rules: new Array(65).fill(r) },
  ];
  for (const value of [NaN, Infinity, -Infinity, 1e12 + 1, -1e12 - 1, {}, [], 1n, "x".repeat(257)]) invalid.push({ ...p, variables: [{ ...v, values: [value] }] });
  const extras = [v]; Object.assign(extras, { extra: v }); invalid.push({ ...p, variables: extras });
  const inherited = new Array(1); Object.setPrototypeOf(inherited, { 0: v }); invalid.push({ ...p, variables: inherited });
  const oversized: api.AnswerReductionRequest = { ...p, variables: [{ id: "x".repeat(128), values: ["é".repeat(256)] }], rules: Array.from({ length: 64 }, () => ({ answer: "é".repeat(256), when: Array.from({ length: 8 }, () => ({ variable: "x".repeat(128), op: "eq", value: "é".repeat(256) })) })), fragments: [] };
  invalid.push(oversized);
  for (const implementation of [api, built]) for (const value of invalid) {
    assert.throws(() => implementation.parseAnswerReductionRequest(value), code("INVALID_REQUEST"));
    await assert.rejects(implementation.reduceAnswerContext(value as api.AnswerReductionRequest, async () => { assert.fail("read before validation"); }), code("INVALID_REQUEST"));
  }
});

test("one bad source remains unknown without discarding healthy fragments or fabricating proofs", async (t) => {
  const { root, item, read } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = routingRequest(item.id);
  input.fragments[0]!.field = "missing_native_field";
  const missing = await api.reduceAnswerContext(input, read); roundtrip(missing);
  assert.equal(missing.state, "unknown"); assert.equal(missing.fragments[0]!.state, "unavailable"); assert.equal(missing.fragments[1]!.state, "omitted");
  const cyclic: Record<string, unknown> = {}; cyclic.loop = cyclic;
  const deep = Array.from({ length: 26 }).reduce<unknown>((value) => ({ value }), null);
  const badSources: unknown[] = [null, {}, { revision: " " }, { revision: "r1", value: Infinity }, { revision: "r1", value: undefined }, { revision: "r1", value: cyclic }, { revision: "r1", value: deep }, { revision: "r1", value: new Array(1) }, { revision: "r1", value: "x".repeat(4000001) }, { revision: "r1", value: Array.from({ length: 100000 }, () => null) }, { revision: "r1", value: { x: null }, extra: true }];
  for (const source of badSources) {
    let index = 0;
    const packet = await api.reduceAnswerContext(routingRequest(item.id), async (binding) => ++index === 1 ? source as Awaited<ReturnType<typeof read>> : read(binding));
    assert.equal(packet.fragments[0]!.state, "unavailable"); assert.equal(packet.fragments[1]!.state, "omitted"); roundtrip(packet);
  }
  const values = [null, true, 0, [1, "x"], { nested: [1, null], optional: undefined }];
  for (const value of values) roundtrip(await api.reduceAnswerContext(routingRequest(item.id), async () => ({ revision: "r1", value }), "full"));
});

test("producer-derived validation rejects tampered proofs, source encodings and extreme emitted numbers", async (t) => {
  const { root, item, read } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const packet = await api.reduceAnswerContext(routingRequest(item.id), read);
  const invalid: unknown[] = [null, [], {}, { ...packet, extra: true }, { ...packet, representation: "other" }, { ...packet, contract: {} }, { ...packet, fragments: [] }, { ...packet, fragments: new Array(2) },
    { ...packet, proofs: [] }, { ...packet, relevant_variables: [] }, { ...packet, routing: [{ inputs: [false], answer: "wrong" }] },
  ];
  for (const row of [null, {}, { ...packet.fragments[0]!, extra: true }, { ...packet.fragments[0]!, revision: " " }, { ...packet.fragments[0]!, value_json: null }, { ...packet.fragments[0]!, value_json: "invalid" }, { ...packet.fragments[0]!, value_json: "1e999" }, { ...packet.fragments[0]!, revision: null }, { ...packet.fragments[0]!, state: "omitted" }]) invalid.push({ ...packet, fragments: [row, packet.fragments[1]] });
  for (const number of [NaN, Infinity, -Infinity, -1, 0, 4097, Number.MAX_VALUE, Number.MIN_VALUE, 1.5]) {
    invalid.push({ ...packet, combinations: number });
    invalid.push({ ...packet, proofs: [{ ...packet.proofs[0]!, contexts: number }] });
  }
  invalid.push({ ...packet, fragments: [{ ...packet.fragments[0]!, value_json: "x".repeat(8388609) }, packet.fragments[1]] });
  for (const implementation of [api, built]) for (const value of invalid) assert.throws(() => implementation.encodeAnswerReduction(value as api.AnswerReduction, "json"), code("INVALID_OUTPUT"));
  assert.throws(() => api.encodeAnswerReduction(packet, "bad" as "json"), code("INVALID_ARGUMENT"));
  const changed = { ...routingRequest(item.id), contract_revision: "v2" };
  await assert.rejects(api.validateAnswerReduction(packet, changed, read), code("STALE_PACKET"));
});

test("compiled CLI and SDK work with no Git and actionable guards, file errors and stale checks", async (t) => {
  const { root, client, item, read } = await tracker(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = routingRequest(item.id); const path = join(root, "request.json"); const saved = join(root, "saved.json");
  writeFileSync(path, JSON.stringify(request)); writeFileSync(saved, api.encodeAnswerReduction(await api.reduceAnswerContext(request, read), "json"));
  for (const module of [extension, builtExtension]) {
    const harness = await createExtensionTestHarness(module, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] }); t.after(() => harness.deactivate());
    for (const options of [{}, { packet: " " }, { packet: path, check: " " }, { packet: path, format: " " }, { packet: path, representation: " " }, { packet: path, format: "yaml" }, { packet: path, representation: "other" }, { packet: path, check: saved, representation: "full" }]) await assert.rejects(harness.runCommand({ command: "context-reduce", pmRoot: client.pmRoot, options }), code("INVALID_ARGUMENT"));
    await assert.rejects(harness.runCommand({ command: "context-reduce", pmRoot: client.pmRoot, options: { packet: path }, args: ["extra"] }), code("INVALID_ARGUMENT"));
    for (const options of [{ packet: path }, { packet: path, format: "toon" }, { packet: path, representation: "full" }, { packet: path, check: saved }]) for (const global of [{ json: true }, { json: false }]) {
      const result = await harness.runCommand({ command: "context-reduce", pmRoot: client.pmRoot, options, global }); assert.equal(result.errorMessage, undefined);
    }
  }
  const packageRoot = resolve(import.meta.dirname, ".."); const installed = join(client.pmRoot, "extensions", "pm-context"); mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json")); cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true }); symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const noGit = join(root, "no-git"); mkdirSync(noGit); const before = fingerprint(client.pmRoot);
  for (const format of ["json", "toon"] as const) {
    const result = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-reduce", "--packet", path, "--format", format], { cwd: root, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PM_|TOKEN|SECRET|PASSWORD|CREDENTIAL|API.?KEY|NPM_MEDIA_SERVER/i.test(key))), PM_PATH: client.pmRoot, PM_AUTHOR: "fixture", PATH: noGit, GIT_CEILING_DIRECTORIES: tmpdir() } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, api.encodeAnswerReduction(await api.reduceAnswerContext(request, read), format));
  }
  assert.equal(fingerprint(client.pmRoot), before);
  for (const contents of ["invalid", Buffer.from([0xff])]) { writeFileSync(path, contents); assert.throws(() => api.readAnswerReductionJson(path), code("INPUT_UNAVAILABLE")); }
  assert.throws(() => api.readAnswerReductionJson(root), code("INPUT_UNAVAILABLE"));
  assert.throws(() => api.readAnswerReductionJson(join(root, "absent")), code("INPUT_UNAVAILABLE"));
});
