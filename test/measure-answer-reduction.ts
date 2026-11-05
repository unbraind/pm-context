/** Measure a committed public tracker copy without writing or normalizing its contents. */
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileFocusItems } from "../file-focus.ts";
import { createSharedEvidenceReader, encodeAnswerReduction, reduceAnswerContext, validateAnswerReduction } from "../index.ts";
import { assertAnswers, fingerprint, routingRequest } from "./answer-reduction-fixture.ts";

/** Traverse only the explicit snapshot, refusing links before changing permissions. */
function paths(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = join(prefix, name); const stat = lstatSync(join(root, path)); assert.ok(!stat.isSymbolicLink());
    return stat.isDirectory() ? [path, ...paths(root, path)] : [path];
  });
}
const source = process.argv[2]; assert.ok(source, "Supply a public committed tracker export");
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const scratch = mkdtempSync(join(tmpdir(), "answer-public-")); const root = join(scratch, "copy");
let entries: string[] = [];
try {
  cpSync(source, root, { recursive: true }); assert.equal(existsSync(join(root, ".git")), false);
  entries = paths(root);
  for (const path of entries.filter((path) => lstatSync(join(root, path)).isFile())) chmodSync(join(root, path), 0o444);
  for (const path of entries.slice().reverse().filter((path) => lstatSync(join(root, path)).isDirectory())) chmodSync(join(root, path), 0o555);
  chmodSync(root, 0o555); const before = fingerprint(root);
  const pmRoot = join(root, ".agents/pm"); const items = await readFileFocusItems(pmRoot);
  const candidates = items.filter((item) => typeof item.description === "string" && item.description.length > 500 && item.description.length < 8000).sort((a, b) => b.description!.length - a.description!.length || a.id.localeCompare(b.id));
  assert.ok(candidates.length >= 4);
  const selected = candidates.slice(0, 4); const request = routingRequest(selected[0]!.id); const read = createSharedEvidenceReader(pmRoot);
  request.fragments = [request.fragments[0]!, ...selected.map((item, i) => ({ id: `background-${i}`, item: item.id, field: "description", variables: ["background"] }))];
  const full = await reduceAnswerContext(request, read, "full"); const reduced = await reduceAnswerContext(request, read);
  assert.equal(full.state, "proved"); assert.equal(reduced.state, "proved");
  const checked = assertAnswers(full) + assertAnswers(reduced);
  await validateAnswerReduction(reduced, request, read);
  const results = ["json", "toon"].map((format) => {
    const fullBytes = Buffer.byteLength(encodeAnswerReduction(full, format as "json" | "toon"));
    const reducedBytes = Buffer.byteLength(encodeAnswerReduction(reduced, format as "json" | "toon"));
    assert.ok(reducedBytes * 2 <= fullBytes, "inclusive exact 50 percent acceptance");
    return { format, full_bytes: fullBytes, reduced_bytes: reducedBytes, saved_bytes: fullBytes - reducedBytes, saved_percent: (fullBytes - reducedBytes) * 100 / fullBytes };
  });
  assert.equal(fingerprint(root), before); assert.deepEqual(paths(root), entries);
  console.log(JSON.stringify({ public_items: items.length, selected_items: selected.map((item) => item.id), source_description_bytes: selected.reduce((sum, item) => sum + Buffer.byteLength(item.description!), 0), combinations: full.combinations, independently_checked_answers: checked, omitted_fragments: reduced.fragments.filter((row) => row.state === "omitted").length, proved_branches: reduced.proofs.flatMap((proof) => proof.branches).length, tracker_unchanged: true, results }, null, 2));
} finally {
  if (existsSync(root)) { chmodSync(root, 0o755); for (const path of entries.filter((path) => lstatSync(join(root, path)).isDirectory())) chmodSync(join(root, path), 0o755); }
  rmSync(scratch, { recursive: true, force: true });
}
