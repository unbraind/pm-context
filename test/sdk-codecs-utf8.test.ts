import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { create, decodePmTableRows, encodePmTableRows, estimatePmOutputTokens, init, update } from "@unbrained/pm-cli/sdk";
import { decodeToon, encodeToon } from "@unbrained/pm-cli/sdk/testing";
import { serveContextReceipt, RECEIPTS_RELATIVE_PATH } from "../context-receipts.ts";
import { createSdkPacker, readPmItems } from "../index.ts";
import { encodeNextEvidencePlan, planNextEvidence } from "../next-evidence.ts";
import { checkContextWitnesses, encodeWitnessReport } from "../witnesses.ts";
import { createFreshnessReader, encodeFreshness, recordFreshness, resumeFreshness } from "../freshness.ts";
import type { FreshnessResult } from "../freshness.ts";
import { encodeEvidencePack, packCriterionEvidence } from "../evidence-packing.ts";

/** Initialize real SDK storage without Git, retaining escaped multibyte source values. */
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "context-codec-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("codec", { defaults: true, agentGuidance: "skip" }, client);
  const { item } = await create({ title: "界".repeat(400), body: '漢字 😀 "quoted" \\slash\nnext\tline', author: "fixture" }, client);
  assert.equal(existsSync(join(root, ".git")), false);
  return { client, item, read: createFreshnessReader(client.pmRoot, root) };
}

test("SDK UTF-8 fact accounting retains escaped JSON and repeated Unicode facts", async (t) => {
  const { client, item } = await fixture(t);
  const identity = { author: "fixture", command: "context-pack" };
  for (const format of ["json", "text"] as const) {
    const fragment = format === "json" ? JSON.stringify({ id: item.id, body: item.body }) : `- ${item.id} ${item.title} 😀`;
    const original = format === "json" ? `{"focus":[${fragment},${fragment}]}\n` : `## Focus\n${fragment}\n${fragment}\n`;
    const served = await serveContextReceipt(client.pmRoot, original, format, { item_ids: [item.id], files: [] }, identity);
    const fact = served.receipt.facts[0]!;
    assert.equal(fact.estimated_tokens, 2 * estimatePmOutputTokens(Buffer.byteLength(fragment)));
    assert.deepEqual(fact.item_ids, [item.id]);
    const stored = JSON.parse(readFileSync(join(client.pmRoot, RECEIPTS_RELATIVE_PATH, `${served.receipt.receipt_id}.json`), "utf8"));
    assert.deepEqual(stored.facts, served.receipt.facts);
  }
});

test("SDK receipt overhead includes final self digits, escapes and newline", async (t) => {
  const { client, item } = await fixture(t);
  // Sweep rounding and decimal boundaries; padded input may shrink on reserialization.
  for (const width of [0, 1, 2, 3, 4, 40, 400, 4000]) {
    const original = `${JSON.stringify({ focus: [{ id: item.id, title: item.title }] })}${" ".repeat(width)}\n`;
    const served = await serveContextReceipt(client.pmRoot, original, "json", { item_ids: [item.id], files: [] }, {
      author: "fixture", command: "context-pack", session: `😀漢字\\\"\n${"界".repeat(width)}`,
    });
    assert.equal(served.receipt.protocol_tokens, estimatePmOutputTokens(Math.max(0, Buffer.byteLength(served.output) - Buffer.byteLength(original))));
    assert.equal(JSON.parse(served.output).context_receipt.protocol_tokens, served.receipt.protocol_tokens);
    assert.ok(served.output.endsWith("\n"));
  }
});

test("SDK projection costs use UTF-8 tokens while the item ceiling stays an item ceiling", async (t) => {
  const { client } = await fixture(t);
  const items = await readPmItems(client.pmRoot);
  const pack = createSdkPacker([], items)([], items, 1);
  assert.deepEqual(pack.neighbors, [], "a multibyte identity alone exceeds the 220-token slot");
  const ascii = items.map((item) => ({ ...item, title: "a".repeat(400) }));
  assert.equal(createSdkPacker([], ascii)([], ascii, 1).neighbors.length, 1);
});

test("SDK next-evidence codec keeps table metadata and declared domain costs", async (t) => {
  const { item } = await fixture(t);
  const plan = planNextEvidence({ contract_revision: '漢字😀 "\\\n', missing: ["criterion"], tool_call_tokens: 17,
    reads: [{ id: "read", source: item.id, revision: item.title.slice(0, 128), covers: ["criterion"], estimated_tokens: 7, estimated_tool_calls: 2 }] });
  const { steps, ...summary } = plan;
  const table = encodePmTableRows(steps.map((step) => ({ ...step })));
  const output = encodeNextEvidencePlan(plan);
  assert.equal(output, `${encodeToon({ ...summary, steps: table.rows, steps_encoding: table.encoding })}\n`);
  const decoded = decodeToon(output) as unknown as { steps: typeof table.rows; steps_encoding: typeof table.encoding };
  const { steps: _steps, steps_encoding: _encoding, ...rest } = decoded;
  assert.deepEqual({ ...rest, steps: decodePmTableRows({ rows: decoded.steps, encoding: decoded.steps_encoding }) }, plan);
  assert.equal(plan.cost, 41, "declared acquisition costs are not output estimates");
  assert.deepEqual(JSON.parse(encodeNextEvidencePlan(plan, "json")), plan);
});

test("SDK witness codec preserves exact citations and refuses byte overflow indivisibly", async (t) => {
  const { item } = await fixture(t);
  const base = { kind: "state" as const, subject: "service", field: "status", scope: "now", citation: { item: item.id, field: "/metadata/status" } };
  const report = checkContextWitnesses({ claims: [{ ...base, id: "a", value: '界😀 "one"' }, { ...base, id: "b", value: "other", supersedes: ["a"] }] });
  const output = encodeWitnessReport(report, "toon", 4000);
  assert.equal(output, `${encodeToon(report)}\n`);
  assert.deepEqual(decodeToon(output), report);
  const bytes = Buffer.byteLength(output);
  assert.equal(encodeWitnessReport(report, "toon", bytes), output);
  assert.throws(() => encodeWitnessReport(report, "toon", bytes - 1), /BUDGET_TOO_SMALL/);
  assert.deepEqual(JSON.parse(encodeWitnessReport(report, "json")), report);
});

test("SDK freshness codec keeps byte-sized prefix omissions and source completeness", async (t) => {
  const { client, item, read } = await fixture(t);
  const packet = { sections: Array.from({ length: 32 }, (_, index) => ({ id: `section-${index}`, content: "漢字😀", sources: [{ kind: "item" as const, id: item.id, fields: ["title"] }], depends_on: [] })) };
  const manifest = await recordFreshness(packet, read);
  await update(item.id, { title: "changed", author: "fixture" }, client);
  const report = await resumeFreshness(packet, manifest, read);
  assert.equal(encodeFreshness(report, "toon", 10000), `${encodeToon(report)}\n`);
  for (const format of ["json", "toon"] as const) {
    for (const budget of [1000, 1500, 2000]) {
      const output = encodeFreshness(report, format, budget);
      const decoded = (format === "json" ? JSON.parse(output) : decodeToon(output)) as FreshnessResult;
      assert.ok(Buffer.byteLength(output) <= budget);
      assert.equal(decoded.omitted_sections + decoded.invalidated.length, 32);
      assert.equal(decoded.checked_sources, 1);
      assert.equal(decoded.reusable, false);
      assert.equal(decoded.remedy, report.remedy);
      assert.deepEqual(decoded.invalidated, report.invalidated.slice(0, decoded.invalidated.length));
    }
  }
});

test("SDK evidence codec preserves whole criteria, source counts and byte ceilings", async (t) => {
  const { item, read } = await fixture(t);
  const input = { criteria: Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, text: '漢字😀 "\\', evidence: [{ item: item.id, field: "body" }] })) };
  for (const format of ["json", "toon"] as const) {
    const pack = await packCriterionEvidence(input, read, { format, byteBudget: 3000 });
    const output = encodeEvidencePack(pack, format);
    assert.equal(output, `${format === "json" ? JSON.stringify(pack) : encodeToon(pack)}\n`);
    assert.deepEqual(format === "json" ? JSON.parse(output) : decodeToon(output), pack);
    assert.ok(Buffer.byteLength(output) <= pack.byte_upper_bound && pack.byte_upper_bound <= 3000);
    assert.equal(pack.source_fields_read, 1);
    assert.ok(pack.remedy.includes("byte budget"));
    for (const criterion of pack.criteria) assert.equal(criterion.packed, pack.evidence.filter((row) => row.criterion === criterion.id).length);
  }
});
