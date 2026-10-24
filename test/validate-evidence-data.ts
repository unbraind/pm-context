/** Reproducible read-only measurements against a public tracker copy outside Git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk/core";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/query";
import { createFreshnessReader, encodeEvidencePack, packCriterionEvidence } from "../index.ts";
import type { EvidencePacket } from "../index.ts";

/** Fingerprint every copied file to prove that packing performed no tracker writes. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}
const source = process.argv[2];
assert.ok(source, "Pass a read-only public tracker snapshot as the first argument");
const root = mkdtempSync(join(tmpdir(), "evidence-public-"));
try {
  const pmRoot = join(root, "tracker");
  cpSync(resolve(source), pmRoot, { recursive: true, filter: (path) => !["runtime", "locks", "transactions", "search", "extensions"].includes(path.split(/[\\/]/).at(-1)!) });
  const result = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot, cwd: root, noExtensions: true }));
  const ids = result.items.map((item) => item.id).sort();
  const qualified = result.items.filter((item) => typeof item.acceptance_criteria === "string" && item.acceptance_criteria.trim() && Array.isArray(item.tests) && item.tests.length > 0).sort((a, b) => a.id < b.id ? -1 : 1);
  assert.ok(qualified.length >= 8, "Eight items with actual acceptance criteria and linked tests are required");
  assert.ok(ids.length >= 8, "A nontrivial public tracker is required");
  // Complete-list orientation may initialize disposable SDK indexes. Freeze
  // the resulting copy before the operation whose read-only behavior is measured.
  function freeze(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) freeze(path); else chmodSync(path, 0o444);
    }
  }
  freeze(pmRoot);
  const initial = fingerprint(pmRoot);
  const read = createFreshnessReader(pmRoot, root);
  const packet: EvidencePacket = { criteria: qualified.slice(0, 8).map((item, index) => ({
    id: `AC${index + 1}`, text: String(item.acceptance_criteria).split(";")[0]!.trim(), evidence: [{ item: item.id, field: "title" }, { item: item.id, field: "tests" }],
  })) };
  packet.criteria.push({ id: "AC9", text: "Undeclared independent evidence", evidence: [] });
  const measurements = [];
  for (const format of ["json", "toon"] as const) {
    const full = await packCriterionEvidence(packet, read, { format, byteBudget: 20000 });
    assert.equal(full.criteria.filter((row) => row.state === "linked").length, 8);
    const lowerBudget = Math.floor(full.byte_upper_bound * 0.7);
    for (const budget of [20000, lowerBudget]) {
      const pack = await packCriterionEvidence(packet, read, { format, byteBudget: budget });
      const bytes = Buffer.byteLength(encodeEvidencePack(pack, format));
      assert.ok(bytes <= pack.byte_upper_bound && pack.byte_upper_bound <= budget);
      assert.deepEqual(await packCriterionEvidence({ criteria: packet.criteria.slice().reverse().map((row) => ({ ...row, evidence: row.evidence.slice().reverse() })) }, read, { format, byteBudget: budget }), pack);
      measurements.push({ format, budget, bytes, upper_bound: pack.byte_upper_bound, linked: pack.criteria.filter((row) => row.state === "linked").map((row) => row.id), budget_omitted: pack.criteria.filter((row) => row.state === "budget_omitted").map((row) => row.id), unlinked: pack.criteria.filter((row) => row.state === "unlinked").map((row) => row.id), evidence_rows: pack.evidence.length, source_fields_read: pack.source_fields_read });
    }
  }
  assert.equal(fingerprint(pmRoot), initial);
  assert.ok(measurements.filter((row) => row.budget < 20000).every((row) => row.budget_omitted.length > 0));
  console.log(JSON.stringify({ tracker_items: ids.length, items_with_criteria_and_tests: qualified.length, selected_items: 8, criteria: 9, source_fields: 16, tracker_unchanged: true, deterministic: true, measurements }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
