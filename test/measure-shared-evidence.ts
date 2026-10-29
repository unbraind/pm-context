/** Measure only a committed public tracker export; never change its source bytes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreshnessReader, createSharedEvidenceReader, encodeSharedEvidence, packCriterionEvidence, encodeEvidencePack, packSharedEvidence } from "../index.ts";
import { readFileFocusItems } from "../file-focus.ts";
import { assertSharedReferenceClosure } from "./shared-reference-closure.ts";

/** Traverse only the supplied copy, rejecting links before permission changes. */
function paths(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = join(prefix, name); const stat = lstatSync(join(root, path));
    assert.ok(!stat.isSymbolicLink());
    return stat.isDirectory() ? [path, ...paths(root, path)] : [path];
  });
}
/** Include every tracker byte and coordinate in the read-only evidence. */
function fingerprint(root: string, files: string[]): string {
  const hash = createHash("sha256"); for (const file of files) hash.update(file).update(readFileSync(join(root, file)));
  return hash.digest("hex");
}

const source = process.argv[2]; assert.ok(source, "Supply a committed public tracker export");
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const scratch = mkdtempSync(join(tmpdir(), "shared-public-")); const root = join(scratch, "public-copy");
let entries: string[] = [];
try {
  cpSync(source, root, { recursive: true }); assert.equal(existsSync(join(root, ".git")), false);
  entries = paths(root); const files = entries.filter((path) => lstatSync(join(root, path)).isFile());
  for (const path of files) chmodSync(join(root, path), 0o444);
  for (const path of entries.slice().reverse().filter((path) => lstatSync(join(root, path)).isDirectory())) chmodSync(join(root, path), 0o555);
  chmodSync(root, 0o555); const before = fingerprint(root, files);
  const pmRoot = join(root, ".agents", "pm"); const items = await readFileFocusItems(pmRoot);
  const candidates = items.filter((item) => typeof item.description === "string" && item.description.length > 500 && item.description.length < 8000).sort((a, b) => b.description!.length - a.description!.length);
  assert.ok(candidates.length > 0);
  const criteria = Array.from({ length: 20 }, (_, i) => ({ id: `AC${i}`, text: `Retain the declared source for obligation ${i}`, evidence: [{ item: candidates[0]!.id, field: "description" }] }));
  const results = [];
  for (const format of ["json", "toon"] as const) {
    const read = createSharedEvidenceReader(pmRoot);
    const full = await packSharedEvidence({ criteria, byte_budget: 262144, format, representation: "expanded" }, read);
    const factored = await packSharedEvidence({ criteria, byte_budget: 262144, format }, read);
    assertSharedReferenceClosure(full); assertSharedReferenceClosure(factored);
    const legacy = await packCriterionEvidence({ criteria }, createFreshnessReader(pmRoot, root), { byteBudget: 262144, format });
    assert.deepEqual(factored.criteria, full.criteria); assert.deepEqual(factored.criteria, legacy.criteria);
    assert.equal(factored.bindings.length, 20); assert.equal(factored.fragments.length, 1);
    const constrained = await packSharedEvidence({ criteria, byte_budget: factored.byte_upper_bound, format, representation: "expanded" }, read);
    assertSharedReferenceClosure(constrained);
    const expandedBytes = Buffer.byteLength(encodeSharedEvidence(full, format)); const factoredBytes = Buffer.byteLength(encodeSharedEvidence(factored, format));
    results.push({ format, criteria: criteria.length, bindings: factored.bindings.length, fragments: factored.fragments.length, expanded_bytes: expandedBytes, factored_bytes: factoredBytes, saved_bytes: expandedBytes - factoredBytes, legacy_v1_bytes: Buffer.byteLength(encodeEvidencePack(legacy, format)), expanded_linked_at_factored_budget: constrained.criteria.filter((row) => row.state === "linked").length });
  }
  assert.equal(fingerprint(root, files), before); assert.deepEqual(paths(root), entries);
  process.stdout.write(`${JSON.stringify({ public_items: items.length, selected_item: candidates[0]!.id, source_bytes: Buffer.byteLength(candidates[0]!.description!), tracker_unchanged: true, results }, null, 2)}\n`);
} finally {
  if (existsSync(root)) {
    chmodSync(root, 0o755);
    for (const path of entries.filter((path) => lstatSync(join(root, path)).isDirectory())) chmodSync(join(root, path), 0o755);
  }
  rmSync(scratch, { recursive: true, force: true });
}
