import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import * as api from "../answer-reduction.ts";
import * as built from "../dist/answer-reduction.js";
import type { SharedEvidenceReader } from "../shared-evidence.ts";
import { routingRequest } from "./answer-reduction-fixture.ts";

/** Mutate just one nested container in an otherwise ordinary JSON fixture. */
function at(value: unknown, path: (string | number)[], change: (entry: object) => object): unknown {
  const copy: unknown = structuredClone(value);
  if (!path.length) return change(copy as object);
  let parent = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  const key = path.at(-1)!;
  parent[key] = change(parent[key] as object);
  return copy;
}

/** Enumerate every container, including empty arrays, through ordinary fixture data only. */
function containers(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (value === null || typeof value !== "object") return [];
  return [prefix, ...Object.entries(value).flatMap(([key, entry]) => containers(entry, [...prefix, key]))];
}

/** Malformed containers exercise the same boundary classes at every nesting level. */
function shapes(trapped: () => never): ((value: object) => object)[] {
  return [
    (value) => Object.setPrototypeOf(value, null),
    (value) => Object.setPrototypeOf(value, Object.assign(Object.create(Array.isArray(value) ? Array.prototype : Object.prototype) as object, { toJSON: trapped })),
    (value) => new Proxy(value, {}),
    // Async reader resolution probes then before the validator receives a value.
    (value) => new Proxy(value, { get: (_target, key) => key === "then" ? undefined : trapped(), getPrototypeOf: trapped, ownKeys: trapped, getOwnPropertyDescriptor: trapped }),
    (value) => { const proxy = Proxy.revocable(value, {}); proxy.revoke(); return proxy.proxy; },
    (value) => Object.defineProperty(value, Symbol("extra"), { value: true }),
    (value) => Object.defineProperty(value, "toJSON", { get: trapped }),
    ...[false, true].map((accessor) => (value: object) => {
      const key = Object.keys(value)[0];
      // Empty arrays still reject an unexpected own accessor/hidden addition.
      return Object.defineProperty(value, key ?? "extra", accessor ? { get: trapped } : { value: key ? Reflect.get(value, key) : true, enumerable: false });
    }),
    (value) => {
      if (Array.isArray(value)) { if (value.length) delete value[0]; else value.length = 1; }
      else Object.defineProperty(value, "extra", { value: true });
      return value;
    },
  ];
}

test("request shape matrix rejects prototypes, proxies, accessors, hidden keys and sparse arrays before reads", async () => {
  const request = routingRequest("answer-task");
  let traps = 0;
  const malformed = shapes(() => { traps++; throw new Error("hook invoked"); });
  for (const implementation of [api, built]) {
    for (const path of containers(request)) for (const change of malformed) {
      const input = at(request, path, change);
      const category = { code: "INVALID_REQUEST" };
      assert.throws(() => implementation.parseAnswerReductionRequest(input), category, JSON.stringify(path));
      await assert.rejects(implementation.reduceAnswerContext(input as api.AnswerReductionRequest, async () => assert.fail("read before refusal")), category);
    }
    const subclass = routingRequest("answer-task");
    class Domain extends Array<boolean> { /** A subclass must never rewrite the declared domain. */ toJSON() { traps++; return [true]; } }
    subclass.variables[0]!.values = new Domain(false, true);
    assert.throws(() => implementation.parseAnswerReductionRequest(subclass), { code: "INVALID_REQUEST" });
    const frozen = routingRequest("answer-task");
    for (const row of frozen.variables) { Object.freeze(row.values); Object.freeze(row); }
    Object.freeze(frozen.variables); Object.freeze(frozen);
    assert.deepEqual(implementation.parseAnswerReductionRequest(frozen), request, "ordinary immutable declarations remain supported");
  }
  assert.equal(traps, 0);
});

test("source and saved-packet shape matrices refuse exotic containers without invoking hooks", async () => {
  const request = routingRequest("answer-task");
  const source = { revision: "r1", value: { nested: ["old", { optional: null }] } };
  let traps = 0;
  const malformed = shapes(() => { traps++; throw new Error("hook invoked"); });
  for (const implementation of [api, built]) {
    for (const path of containers(source)) for (const change of malformed) {
      const invalid = at(source, path, change);
      let reads = 0;
      const packet = await implementation.reduceAnswerContext(request, async () => (++reads === 1 ? invalid : source) as Awaited<ReturnType<SharedEvidenceReader>>, "full");
      assert.equal(traps, 0, `source path ${JSON.stringify(path)} shape ${malformed.indexOf(change)}`);
      assert.equal(packet.fragments[0]!.state, "unavailable", JSON.stringify(path));
      assert.equal(packet.fragments[1]!.state, "retained");
      assert.equal(packet.fragments[1]!.value_json, JSON.stringify(source.value));
    }
    const packet = await implementation.reduceAnswerContext(request, async () => source);
    for (const path of containers(packet)) for (const change of malformed) {
      assert.throws(() => implementation.parseAnswerReduction(at(packet, path, change)), { code: "INVALID_OUTPUT" }, JSON.stringify(path));
      assert.equal(traps, 0, `output path ${JSON.stringify(path)} shape ${malformed.indexOf(change)}`);
    }
    assert.throws(() => implementation.parseAnswerReduction({ ...packet, representation: { toString: 1, valueOf: 1 } }), { code: "INVALID_OUTPUT" });
    assert.deepEqual(implementation.parseAnswerReduction(structuredClone(packet)), packet);
    const ordinary = Object.freeze({ revision: "legacy-r1", value: Object.freeze({ old: [1, null], optional: undefined }) });
    const accepted = await implementation.reduceAnswerContext(request, async () => ordinary, "full");
    assert.equal(accepted.state, "proved");
    assert.equal(accepted.fragments[0]!.value_json, '{"old":[1,null]}');
  }
  assert.equal(traps, 0);
});

test("escaped source strings stay local on individual and cumulative packet overflow and leave budget for peers", async () => {
  const request = routingRequest("answer-task");
  request.fragments = Array.from({ length: 4 }, (_, i) => ({ ...request.fragments[0]!, id: `fragment-${i}` }));
  for (const implementation of [api, built]) for (const representation of ["full", "reduced"] as const) {
    for (const values of [
      ["\0".repeat(1500000), "healthy", "tail", "last"],
      ["\0".repeat(700000), "\0".repeat(700000), "healthy", "last"],
      ["x".repeat(3000000), "\0".repeat(950000), "x".repeat(999900), "last"],
    ]) {
      let index = 0;
      const packet = await implementation.reduceAnswerContext(request, async () => ({ revision: "r1", value: values[index++] }), representation);
      const overflow = values[0]!.length === 1500000 ? 0 : 1;
      assert.equal(packet.state, "unknown");
      assert.deepEqual(packet.fragments.map((row) => row.state), values.map((_, i) => i === overflow ? "unavailable" : "retained"));
      assert.equal(packet.fragments[overflow]!.revision, null);
      assert.equal(packet.fragments[2]!.value_json, JSON.stringify(values[2]));
      assert.deepEqual(implementation.parseAnswerReduction(JSON.parse(implementation.encodeAnswerReduction(packet, "json"))), packet);
    }
  }
});

test("measurement refuses linked export roots before copying or changing original modes", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "answer-measure-review-"));
  const source = join(scratch, "export"); const link = join(scratch, "linked"); const child = join(source, "nested");
  mkdirSync(child, { recursive: true }); const file = join(child, "original.txt"); writeFileSync(file, "unchanged");
  chmodSync(source, 0o751); chmodSync(child, 0o750); chmodSync(file, 0o640); symlinkSync(source, link, "dir");
  const modes = [source, child, file].map((path) => lstatSync(path).mode);
  t.after(() => { chmodSync(source, 0o751); chmodSync(child, 0o750); chmodSync(file, 0o640); rmSync(scratch, { recursive: true, force: true }); });
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "measure-answer-reduction.ts"), link], { encoding: "utf8", timeout: 30000 });
  assert.deepEqual([source, child, file].map((path) => lstatSync(path).mode), modes, "the original export modes are unchanged");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Supply a real export directory, not a symlink/);
  // The ordinary directory path still reaches the existing snapshot validation.
  const copy = join(scratch, "ordinary"); cpSync(source, copy, { recursive: true });
  const regular = spawnSync(process.execPath, [resolve(import.meta.dirname, "measure-answer-reduction.ts"), copy], { encoding: "utf8", timeout: 30000 });
  assert.notEqual(regular.status, 0); assert.doesNotMatch(regular.stderr, /not a symlink/);
});

/** Keep all eight variables relevant across 4096 rows, varying only scalar width/escaping. */
function wideRouting(width: number, fill = "x"): api.AnswerReductionRequest {
  const request = routingRequest("answer-task");
  request.variables = [8, 8, 2, 2, 2, 2, 2, 2].map((count, i) => ({ id: `v${i}`, values: Array.from({ length: count }, (_, j) => `${i}-${j}`.padEnd(width, fill)) }));
  request.rules = request.variables.map((variable, i) => ({ when: [{ variable: variable.id, op: "eq", value: variable.values[0]! }], answer: `route-${i}`.padEnd(256, "y") }));
  request.fallback = "fallback".padEnd(256, "y");
  request.fragments = [{ id: "routing", item: "answer-task", field: "title", variables: ["v0"] }];
  return request;
}

/** Construct a complete valid packet independently of the producer's size guard. */
function wirePacket(): api.AnswerReduction {
  const contract = wideRouting(158, "\0");
  const rows = contract.variables.reduce<api.AnswerValue[][]>((rows, variable) => rows.flatMap((row) => variable.values.map((value) => [...row, value])), [[]]);
  const routing = rows.map((inputs) => {
    const first = inputs.findIndex((value, i) => value === contract.variables[i]!.values[0]);
    return { inputs, answer: first < 0 ? contract.fallback : contract.rules[first]!.answer };
  });
  return {
    protocol: "pm-context-answer-reduction/v1", basis: "declared-domains-and-fragment-dependencies;not-inferred-semantics",
    contract, representation: "full", state: "proved", combinations: rows.length,
    relevant_variables: contract.variables.map((variable) => variable.id), routing, proofs: [],
    fragments: [{ id: "routing", revision: "r1", state: "retained", proof_variables: [], value_json: JSON.stringify("") }],
    remedy: "Proof applies only to declared domains and fragment dependencies. Revalidate after source or contract changes.",
  };
}

/** Fill a retained string to an exact wire byte size, including escaped JSON and newline. */
function fillWirePacket(packet: api.AnswerReduction, fill: string, target: number): void {
  packet.fragments[0]!.value_json = JSON.stringify("");
  const room = target - Buffer.byteLength(JSON.stringify(packet)) - 1;
  const unit = Buffer.byteLength(JSON.stringify(JSON.stringify(fill))) - Buffer.byteLength(JSON.stringify(JSON.stringify("")));
  assert.ok(room >= 0);
  packet.fragments[0]!.value_json = JSON.stringify(fill.repeat(Math.floor(room / unit)) + "x".repeat(room % unit));
  assert.equal(Buffer.byteLength(JSON.stringify(packet)) + 1, target);
}

test("public packet parsing and encoding enforce exact UTF-8 byte boundaries for multibyte and astral text", () => {
  const packet = wirePacket();
  for (const implementation of [api, built]) for (const fill of ["é", "界", "😀"]) {
    fillWirePacket(packet, fill, 33554432);
    assert.ok(JSON.stringify(packet).length + 1 < 33554432, "UTF-16 length cannot decide the wire budget");
    assert.equal(implementation.parseAnswerReduction(packet).fragments[0]!.value_json, packet.fragments[0]!.value_json);
    assert.equal(Buffer.byteLength(implementation.encodeAnswerReduction(packet, "json")), 33554432, "the final newline fits exactly");
    fillWirePacket(packet, fill, 33554433);
    assert.throws(() => implementation.parseAnswerReduction(packet), { code: "INVALID_OUTPUT" });
    for (const format of ["json", "toon"] as const) assert.throws(() => implementation.encodeAnswerReduction(packet, format), { code: "INVALID_OUTPUT" });
  }
});

test("seeded packet fuzz accepts iff serialized UTF-8 bytes plus newline fit the limit", (t) => {
  const packet = wirePacket();
  const fills = ["é", "界", "😀", "\0", "\\", "\"\n", "é😀\0"];
  let seed = 0x213b17e;
  /** Deterministic samples mix Unicode, escapes and byte offsets around the ceiling. */
  function random(max: number): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; }
  let accepted = 0; let refused = 0;
  for (let sample = 0; sample < 24; sample++) {
    fillWirePacket(packet, fills[random(fills.length)]!, 33554432 + random(257) - 128);
    const fits = Buffer.byteLength(`${JSON.stringify(packet)}\n`) <= 33554432;
    for (const implementation of [api, built]) {
      if (fits) {
        assert.equal(implementation.parseAnswerReduction(packet).fragments[0]!.value_json, packet.fragments[0]!.value_json); accepted++;
      } else { assert.throws(() => implementation.parseAnswerReduction(packet), { code: "INVALID_OUTPUT" }); refused++; }
    }
  }
  assert.ok(accepted > 0 && refused > 0);
  t.diagnostic(`24 seeded Unicode/escape boundary packets; source and built SDK: ${accepted} accepted, ${refused} refused by independent byte oracle`);
});

test("routing overhead is bounded before source reads while nearby declarations remain supported", async () => {
  for (const implementation of [api, built]) for (const width of [200, 256]) {
    const request = wideRouting(width);
    assert.deepEqual(implementation.parseAnswerReductionRequest(request), request);
    let reads = 0;
    const read = async () => { reads++; return { revision: "r1", value: "healthy" }; };
    if (width === 256) {
      await assert.rejects(implementation.reduceAnswerContext(request, read), { code: "INVALID_REQUEST" });
      assert.equal(reads, 0);
    } else {
      const packet = await implementation.reduceAnswerContext(request, read);
      assert.equal(packet.state, "proved"); assert.equal(packet.combinations, 4096);
      assert.equal(packet.fragments[0]!.value_json, JSON.stringify("healthy")); assert.equal(reads, 1);
    }
  }
});

test("JSON wire bytes include escaped routing and source values and always fit the saved-file reader", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "answer-wire-review-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  for (const implementation of [api, built]) {
    let reads = 0;
    const oversized = wideRouting(200, "\0");
    assert.deepEqual(implementation.parseAnswerReductionRequest(oversized), oversized);
    await assert.rejects(implementation.reduceAnswerContext(oversized, async () => { reads++; return { revision: "r1", value: "healthy" }; }), { code: "INVALID_REQUEST" });
    assert.equal(reads, 0);
    const request = wideRouting(158, "\0");
    request.fragments.push({ ...request.fragments[0]!, id: "peer" });
    const packet = await implementation.reduceAnswerContext(request, async () => ({ revision: "r1", value: ++reads === 1 ? "x".repeat(2000000) : "healthy" }));
    assert.equal(packet.fragments[0]!.state, "unavailable");
    assert.equal(packet.fragments[1]!.state, "retained");
    assert.equal(packet.fragments[1]!.value_json, JSON.stringify("healthy"));
    const encoded = implementation.encodeAnswerReduction(packet, "json");
    assert.ok(Buffer.byteLength(encoded) <= 33554432);
    const path = join(scratch, "saved.json"); writeFileSync(path, encoded);
    assert.deepEqual(implementation.readAnswerReductionJson(path), packet);
  }
});
