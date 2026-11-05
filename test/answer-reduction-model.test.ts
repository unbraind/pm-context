import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, focus, get, init, readSettings, resolveRuntimeStatusRegistry, schemaAddStatus, update } from "@unbrained/pm-cli/sdk";
import type { PmClientOptions } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { runWithActiveExtensions } from "@unbrained/pm-cli/sdk/runtime";
import { createFreshnessReader, createSharedEvidenceReader, encodeAnswerReduction, parseAnswerReduction, reduceAnswerContext, validateAnswerReduction } from "../index.ts";
import type { AnswerReductionRequest } from "../index.ts";
import { assertAnswers, fingerprint, routingRequest } from "./answer-reduction-fixture.ts";

process.env.GIT_CEILING_DIRECTORIES = tmpdir();

/** Reference state comes exclusively from native SDK get with no handwritten normalization. */
async function state(client: PmClientOptions, id: string): Promise<Record<string, unknown>> {
  const result = await get(id, { full: true, outputBudget: "unbounded", outputLimit: "unbounded" }, client);
  assert.ok("item" in result); return JSON.parse(JSON.stringify(result.item)) as Record<string, unknown>;
}

test("500 seeded sequences model native SDK fields, custom statuses, relationships, ambient focus and older packet replays", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "answer-model-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("answer", { defaults: true, agentGuidance: "skip", author: "fixture" }, client);
  const scope = { author: "fixture", unset: ["parent", "goal", "objective", "sprint", "release", "assignee"], clearDeps: true };
  const peer = (await create({ title: "Peer", ...scope }, client)).item;
  const item = (await create({ title: "Original", type: "Issue", ...scope }, client)).item;
  await update(item.id, {
    author: "fixture", parent: peer.id, goal: "Goal", objective: "Objective", assignee: "fixture", reviewer: "reviewer", priority: 0, tags: "one,two", deadline: "2030-01-01", estimatedMinutes: "13", description: "Description", body: "Body\r\n", acceptanceCriteria: "One; Two", definitionOfReady: "Ready", order: "12", risk: "medium", confidence: "85", sprint: "future", release: "future", value: "Value", impact: "Impact", outcome: "Outcome", whyNow: "Reason", blockedBy: peer.id, blockedReason: "Wait", reporter: "fixture", severity: "high", environment: "test", reproSteps: "Reproduce", resolution: "Pending", expectedResult: "Expected", actualResult: "Actual", affectedVersion: "old", fixedVersion: "new", component: "context", regression: "true", customerImpact: "Bounded", comment: ["text=Comment"], note: ["text=Note"], learning: ["text=Learning"], file: ["path=index.ts"], test: ["command=node --version"], doc: ["path=README.md"], reminder: ["at=2030-01-01T00:00:00Z,text=Reminder"], event: ["start=2030-01-01T00:00:00Z,end=2030-01-01T01:00:00Z,title=Event"], replaceDeps: true, dep: [`id=${peer.id},kind=related_to`],
  }, client);
  let seed = 0x5a11c026;
  /** Seeded selection keeps failed sequences reproducible without timing dependencies. */
  function random(max: number): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; }
  const statuses: string[] = [];
  for (const role of ["active", "blocked", "terminal_done", "terminal_canceled"] as const) {
    const name = `stage_${random(1000000)}`; statuses.push(name);
    await schemaAddStatus(name, { role: [role], author: "fixture" }, client);
  }
  const registry = resolveRuntimeStatusRegistry((await readSettings(client.pmRoot)).schema);
  assert.ok(registry.active_statuses.has(statuses[0]!)); assert.ok(registry.terminal_statuses.has(statuses[2]!));
  const native = await createFreshnessReader(client.pmRoot, root)({ kind: "item", id: item.id }) as Record<string, unknown>;
  const fields = Object.keys(JSON.parse(JSON.stringify(native)) as Record<string, unknown>); const seen = new Set<string>();
  const read = createSharedEvidenceReader(client.pmRoot); const saved: AnswerReductionRequest[] = [];
  // Status transitions can legitimately clear terminal-result fields through the
  // SDK. Prove every populated native field first, then model those later absences.
  const baselineModel = await state(client, item.id);
  const baselineRequest = routingRequest(item.id);
  baselineRequest.fragments = fields.map((field, i) => ({ id: `native-${i}`, item: item.id, field, variables: ["urgent"] }));
  const baseline = await reduceAnswerContext(baselineRequest, read, "full");
  for (const [index, fragment] of baseline.fragments.entries()) {
    assert.equal(fragment.state, "retained"); assert.deepEqual(JSON.parse(fragment.value_json!), baselineModel[fields[index]!]); seen.add(fields[index]!);
  }
  for (const format of ["json", "toon"] as const) {
    const encoded = encodeAnswerReduction(baseline, format);
    assert.deepEqual(parseAnswerReduction(format === "json" ? JSON.parse(encoded) : decodeToon(encoded)), baseline);
  }
  let roundtrips = 0; let checked = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    await focus(random(2) ? peer.id : item.id, {}, client);
    const variant = [" text ", "\r\nparagraph\r\n", "\nparagraph\n", "", "é📚,\"\\"][random(5)]!;
    await update(item.id, { author: "fixture", description: variant, body: variant, status: statuses[random(4)]!, priority: random(5), ...(random(2) ? { parent: peer.id } : { unset: ["parent"] }), goal: "Goal", objective: "Objective", sprint: "future", release: "future", replaceDeps: true, dep: [`id=${peer.id},kind=${random(2) ? "related_to" : "blocked_by"}`] }, client);
    const model = await state(client, item.id);
    const input = routingRequest(item.id);
    input.contract_revision = `revision-${sequence}`;
    const field = fields[sequence % fields.length]!;
    input.fragments = [{ id: "current", item: item.id, field, variables: ["urgent"] }];
    input.rules = Array.from({ length: random(5) }, () => ({ when: Array.from({ length: random(4) }, () => {
      const variable = input.variables[random(2)]!;
      return { variable: variable.id, op: random(2) ? "eq" : "neq", value: variable.values[random(2)]! };
    }), answer: `route-${random(3)}` }));
    saved.push(input);
    for (const request of [input, saved[random(saved.length)]!]) {
      // Whitespace variants affect transport, never the exact declared scalar values.
      const replay = JSON.parse(JSON.stringify(request, null, 2).replaceAll("\n", "\r\n")) as AnswerReductionRequest;
      const before = fingerprint(client.pmRoot);
      const full = await reduceAnswerContext(replay, read, "full"); const reduced = await reduceAnswerContext(replay, read);
      checked += assertAnswers(full) + assertAnswers(reduced);
      for (const packet of [full, reduced]) for (const format of ["json", "toon"] as const) {
        const text = encodeAnswerReduction(packet, format);
        const decoded = format === "json" ? JSON.parse(text) : decodeToon(text);
        assert.deepEqual(parseAnswerReduction(decoded), packet);
        roundtrips++;
      }
      await validateAnswerReduction(reduced, replay, read);
      const field = replay.fragments[0]!.field;
      if (Object.hasOwn(model, field)) {
        assert.equal(full.fragments[0]!.state, "retained", field);
        assert.deepEqual(JSON.parse(full.fragments[0]!.value_json!), model[field]); seen.add(field);
      } else assert.equal(full.fragments[0]!.state, "unavailable");
      assert.equal(fingerprint(client.pmRoot), before);
      assert.deepEqual(await state(client, item.id), model);
    }
  }
  assert.ok(fields.length >= 45); assert.deepEqual([...seen].sort(), fields.sort());
  t.diagnostic(`500 seeded sequences; ${fields.length} native fields; ${roundtrips} JSON/TOON round trips; ${checked} independently checked routing answers; current and older inputs; SDK read-back unchanged`);
});

test("every native read boundary reports peer transitions conservatively and preserves foreign records", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "answer-interleaving-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("answer", { defaults: true, agentGuidance: "skip", author: "fixture" }, client);
  const item = (await create({ title: "Before peer", description: "Context", author: "fixture", unset: ["parent", "goal", "objective", "sprint", "release"], clearDeps: true }, client)).item;
  const fixture = join(client.pmRoot, "extensions", "race-fixture"); mkdirSync(fixture, { recursive: true });
  symlinkSync(join(resolve(import.meta.dirname, ".."), "node_modules"), join(fixture, "node_modules"), "dir");
  writeFileSync(join(fixture, "manifest.json"), JSON.stringify({ name: "race-fixture", version: "1.0.0", entry: "index.mjs", capabilities: ["hooks"] }));
  const control = join(root, "control.json");
  writeFileSync(join(fixture, "index.mjs"), `import {readFileSync,writeFileSync} from 'node:fs';
import {update} from '@unbrained/pm-cli/sdk';
export function activate(api) {
  let reads=0, fired=false;
  api.hooks.onRead(async ({path}) => {
    const control=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
    if (!path.endsWith(control.id+'.toon') && !path.endsWith(control.id+'.jsonl')) return;
    if (++reads!==control.boundary || fired) return;
    fired=true;
    await update(control.id,{title:'Peer result',author:'peer',unset:['parent','goal','objective','sprint','release'],clearDeps:true},{cwd:${JSON.stringify(root)},pmRoot:${JSON.stringify(client.pmRoot)},noExtensions:true});
    writeFileSync(${JSON.stringify(control)},JSON.stringify({...control,fired:true}));
  });
}`);
  const foreign = join(client.pmRoot, "foreign.json"); writeFileSync(foreign, "foreign-owned\n");
  const request = routingRequest(item.id); request.fragments = request.fragments.slice(0, 1);
  for (let boundary = 1; boundary <= 4; boundary++) {
    await update(item.id, { title: "Before peer", author: "fixture", unset: ["parent", "goal", "objective", "sprint", "release"], clearDeps: true }, client);
    const before = await reduceAnswerContext(request, createSharedEvidenceReader(client.pmRoot));
    writeFileSync(control, JSON.stringify({ id: item.id, boundary, fired: false }));
    const packet = await runWithActiveExtensions({ cwd: root, path: client.pmRoot }, () => reduceAnswerContext(request, createSharedEvidenceReader(client.pmRoot)));
    if (boundary < 4) { assert.equal(packet.state, "unknown"); assert.equal(packet.fragments[0]!.state, "unavailable"); }
    else assert.deepEqual(packet, before, "last observation is a revision receipt, never a lock or future guarantee");
    assert.equal((await state(client, item.id)).title, "Peer result");
    assert.equal(JSON.parse(readFileSync(control, "utf8")).fired, true);
    await assert.rejects(validateAnswerReduction(packet, request, createSharedEvidenceReader(client.pmRoot)), { code: "STALE_PACKET" });
    assert.equal(readFileSync(foreign, "utf8"), "foreign-owned\n");
  }
});
