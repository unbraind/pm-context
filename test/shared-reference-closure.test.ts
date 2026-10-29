import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import * as source from "../index.ts";
import * as built from "../dist/index.js";
import type { SharedEvidencePack } from "../index.ts";
import { removeBunFixture } from "./bun-fixture.ts";
import { assertSharedReferenceClosure } from "./shared-reference-closure.ts";

/** Output refusals retain the public typed error and actionable remedy. */
function invalidOutput(error: unknown): boolean {
  return isPmCliExpectedError(error) && error.code === "INVALID_OUTPUT" && error.exitCode === 2 && "remedy" in error && typeof error.remedy === "string" && error.remedy.length > 0;
}
/** Decode the real transport instead of checking a pre-serialization projection. */
function decoded(text: string, format: "json" | "toon"): SharedEvidencePack {
  return (format === "json" ? JSON.parse(text) : decodeToon(text)) as SharedEvidencePack;
}

test("500 seeded reference graphs resolve every SDK and wire binding under full and constrained budgets", async () => {
  let seed = 1962;
  /** Stable seeds cover shared values, distinct revisions, escaped text and omitted groups. */
  function random(max: number): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
  for (let sequence = 0; sequence < 500; sequence++) {
    const format = sequence % 2 ? "json" : "toon";
    const entries = Array.from({ length: 6 }, (_, i) => ({ revision: `revision-${sequence}-${i}`, value: { text: `${i}: quotes \", CRLF\r\n and 📚 ${"value ".repeat(5 + random(20))}`, relationships: [{ id: `related-${i}` }] } }));
    entries[1] = entries[0]!;
    entries[2] = { ...entries[0]!, revision: `other-${sequence}` };
    const criteria = Array.from({ length: 1 + random(8) }, (_, i) => {
      const start = random(6);
      return { id: i === 0 ? "constructor" : `c${i}`, text: `Criterion ${i}`, evidence: [start, (start + 1) % 6].map((n) => ({ item: `item-${n % 3}`, field: `field${Math.floor(n / 3)}` })) };
    });
    const read = async ({ item, field }: { item: string; field: string }) => entries[Number(item.slice(5)) + Number(field.slice(5)) * 3]!;
    for (const api of [source, built]) for (const representation of ["factored", "expanded"] as const) {
      const full = await api.packSharedEvidence({ criteria, format, representation, byte_budget: 262144 }, read);
      for (const budget of [262144, Math.max(512, Math.floor(full.byte_upper_bound * 0.75))]) {
        let pack: SharedEvidencePack;
        try { pack = budget === 262144 ? full : await api.packSharedEvidence({ criteria, format, representation, byte_budget: budget }, read); }
        catch (error) { assert.ok(isPmCliExpectedError(error) && error.code === "BUDGET_TOO_SMALL"); continue; }
        const output = api.encodeSharedEvidence(pack, format); const wire = decoded(output, format);
        assert.deepEqual(wire, pack); assertSharedReferenceClosure(wire);
        assert.ok(Buffer.byteLength(output) <= pack.byte_upper_bound && pack.byte_upper_bound <= budget);
        const rows = [...wire.bindings, ...wire.evidence];
        for (const criterion of wire.criteria) {
          assert.equal(rows.filter((row) => row.criterion === criterion.id).length, criterion.packed);
          assert.ok(criterion.packed === 0 || criterion.packed === criterion.required);
        }
        for (const row of rows) {
          const target = wire.fragments.find((fragment) => fragment.id === row.id)!;
          const expected = await read(row);
          assert.equal(target.revision, expected.revision); assert.deepEqual(JSON.parse(target.value_json), expected.value);
        }
      }
    }
  }
});

test("both output encoders refuse broken, ambiguous and cross-wired references while allowing valid packet round trips", async () => {
  for (const api of [source, built]) for (const format of ["json", "toon"] as const) for (const representation of ["factored", "expanded"] as const) {
    const pack = await api.packSharedEvidence({ criteria: [{ id: "A", text: "Native citation", evidence: [{ item: "item", field: "body" }] }], representation, format, byte_budget: 262144 }, async () => ({ revision: "revision", value: " exact\r\nvalue " }));
    assertSharedReferenceClosure(decoded(api.encodeSharedEvidence(pack, format), format));
    const rows = (value: SharedEvidencePack) => value.representation === "expanded" ? value.evidence : value.bindings;
    const corruptions: Array<(value: SharedEvidencePack) => void> = [
      (value) => { value.fragments = []; },
      (value) => { value.fragments.push({ ...value.fragments[0]! }); },
      (value) => { value.fragments.push({ id: "unused", revision: "r", value_json: "null" }); },
      (value) => { rows(value)[0]!.context_ref = "packet:fragments:absent"; },
      (value) => { rows(value)[0]!.id = "absent"; },
      (value) => { rows(value)[0]!.criterion = "absent"; },
      (value) => { value.criteria.push({ ...value.criteria[0]! }); },
      (value) => { Reflect.set(value.criteria[0]!, "id", 1); },
      (value) => { Reflect.set(value.fragments[0]!, "id", 1); },
      (value) => { Reflect.set(value.fragments[0]!, "revision", 1); },
      (value) => { Reflect.set(value.fragments[0]!, "value_json", 1); },
      (value) => { Reflect.set(value.fragments, "0", null); },
      (value) => { Reflect.set(rows(value), "0", null); },
      (value) => { Reflect.set(value, "reference_scope", "elsewhere"); },
      ...["criteria", "fragments", "bindings", "evidence"].map((key) => (value: SharedEvidencePack) => { Reflect.set(value, key, {}); }),
      (value) => { Reflect.set(value.criteria, "0", 1); },
    ];
    if (representation === "expanded") corruptions.push((value) => { value.evidence[0]!.revision = "other"; }, (value) => { value.evidence[0]!.value_json = "null"; });
    for (const change of corruptions) { const bad = structuredClone(pack); change(bad); assert.throws(() => api.encodeSharedEvidence(bad, format), invalidOutput); }
    for (const bad of [null, [], { ...pack, criteria: new Array(4294967295) }]) assert.throws(() => Reflect.apply(api.encodeSharedEvidence, undefined, [bad, format]), invalidOutput);
    const empty = await api.packSharedEvidence({ criteria: [{ id: "empty", text: "No evidence", evidence: [] }], format, representation }, async () => { assert.fail("empty packet read a source"); });
    assertSharedReferenceClosure(decoded(api.encodeSharedEvidence(empty, format), format));
  }
});

test("expanded and factored native SDK and installed Node/Bun CLI references resolve without Git", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "shared-reference-")); t.after(() => removeBunFixture(root));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("refs", { defaults: true, author: "fixture", agentGuidance: "skip" }, client);
  const { item } = await create({ title: "Reference source", body: "Native quoted \" evidence\r\n📚 ".repeat(30), author: "fixture", parent: "none", goal: "none", objective: "none", assignee: "none", clearDeps: true }, client);
  const criteria = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, text: `Criterion ${i}`, evidence: [{ item: item.id, field: "body" }] }));
  const observed = await source.createSharedEvidenceReader(client.pmRoot)({ item: item.id, field: "body" });
  const packageRoot = resolve(import.meta.dirname, ".."); const extension = join(client.pmRoot, "extensions", "pm-context"); mkdirSync(extension, { recursive: true });
  cpSync(join(packageRoot, "dist"), join(extension, "dist"), { recursive: true }); cpSync(join(packageRoot, "manifest.json"), join(extension, "manifest.json"));
  symlinkSync(join(packageRoot, "node_modules"), join(extension, "node_modules"), "dir");
  const noGit = join(root, "no-git"); mkdirSync(noGit); const packet = join(root, "packet.json");
  const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }); assert.equal(bun.status, 0);
  for (const format of ["json", "toon"] as const) for (const representation of ["factored", "expanded"] as const) {
    const input = { criteria, format, representation, byte_budget: 262144 }; writeFileSync(packet, JSON.stringify(input));
    for (const api of [source, built]) {
      const pack = await api.packSharedEvidence(input, api.createSharedEvidenceReader(client.pmRoot));
      assertSharedReferenceClosure(decoded(api.encodeSharedEvidence(pack, format), format));
      assert.equal(pack.fragments.length, 1); assert.deepEqual(JSON.parse(pack.fragments[0]!.value_json), observed.value);
    }
    for (const runtime of [process.execPath, bun.stdout]) {
      const output = spawnSync(runtime, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-evidence-shared", "--packet", packet], { cwd: root, encoding: "utf8", env: { PATH: noGit, HOME: root, PM_PATH: client.pmRoot, GIT_CEILING_DIRECTORIES: tmpdir() } });
      assert.equal(output.status, 0, output.stderr); const pack = decoded(output.stdout, format); assertSharedReferenceClosure(pack);
      assert.equal(pack.representation, representation); assert.equal((representation === "expanded" ? pack.evidence : pack.bindings).length, 20);
      assert.deepEqual(JSON.parse(pack.fragments[0]!.value_json), observed.value);
    }
  }
});
