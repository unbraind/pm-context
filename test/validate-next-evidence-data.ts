/** Reproducible planning measurements on a read-only public tracker copy outside Git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk/core";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/query";
import { encodeNextEvidencePlan, planNextEvidence, validateNextEvidencePlan } from "../index.ts";
import type { NextEvidencePacket } from "../index.ts";

/** Detect every file change after the copy is frozen. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    hash.update(entry.name); hash.update(entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}
/** Freeze source files after the SDK's initial complete-list orientation. */
function freeze(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) freeze(path); else chmodSync(path, 0o444);
  }
}
const source = process.argv[2]; assert.ok(source, "Supply a public tracker snapshot");
const root = mkdtempSync(join(tmpdir(), "next-evidence-public-"));
try {
  const pmRoot = join(root, "tracker");
  cpSync(resolve(source), pmRoot, { recursive: true, filter: (path) => !["runtime", "locks", "transactions", "search", "extensions"].includes(path.split(/[\\/]/).at(-1)!) });
  const result = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot, cwd: root, noExtensions: true }));
  const qualified = result.items.filter((item) => typeof item.acceptance_criteria === "string" && item.acceptance_criteria.trim() && Array.isArray(item.tests) && item.tests.length).sort((a, b) => a.id < b.id ? -1 : 1);
  assert.ok(qualified.length >= 6);
  const selected = qualified.slice(0, 6);
  const revision = fingerprint(pmRoot); freeze(pmRoot); const before = fingerprint(pmRoot);
  const ids = selected.map((_, index) => `AC${index + 1}`);
  // Only the benchmark producer reads source fields to declare cost estimates.
  // The planner receives metadata values and has no reader or SDK client.
  const groups = [[0, 1, 2, 3], [2, 3, 4, 5], [0, 1, 2, 3, 4, 5]];
  const input: NextEvidencePacket = {
    contract_revision: "public-validation-v1", missing: [...ids, "independent-review"], tool_call_tokens: 40,
    reads: groups.map((indices, index) => ({ id: `read${index + 1}`, source: "public-tracker", revision, covers: indices.map((i) => ids[i]!), estimated_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(indices.map((i) => ({ id: selected[i]!.id, tests: selected[i]!.tests })))) / 4), estimated_tool_calls: 1 })),
  };
  const plan = planNextEvidence(input); assert.deepEqual(plan.uncovered, ["independent-review"]);
  assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0]!.read, "read3");
  assert.deepEqual(validateNextEvidencePlan(JSON.parse(encodeNextEvidencePlan(plan, "json")), input), plan);
  assert.deepEqual(planNextEvidence({ ...input, reads: [...input.reads].reverse(), missing: [...input.missing].reverse() }), plan);
  assert.throws(() => validateNextEvidencePlan(plan, { ...input, reads: input.reads.map((row) => ({ ...row, revision: "new-revision" })) }), { code: "STALE_PLAN" });
  assert.equal(fingerprint(pmRoot), before);
  console.log(JSON.stringify({ tracker_items: result.items.length, items_with_criteria_and_tests: qualified.length, selected_items: 6, missing_criteria: 7, catalog_reads: 3, selected_reads: plan.steps.length, covered: plan.missing.length - plan.uncovered.length, uncovered: plan.uncovered.length, estimated_tokens: plan.estimated_tokens, estimated_tool_calls: plan.estimated_tool_calls, tool_call_tokens: input.tool_call_tokens, cost: plan.cost, alternative_pair_cost: input.reads.slice(0, 2).reduce((sum, row) => sum + row.estimated_tokens + input.tool_call_tokens * row.estimated_tool_calls, 0), output_bytes: { json: Buffer.byteLength(encodeNextEvidencePlan(plan, "json")), toon: Buffer.byteLength(encodeNextEvidencePlan(plan, "toon")) }, reads_executed: plan.reads_executed, tracker_unchanged: true, deterministic: true, stale_contract_refused: true }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
