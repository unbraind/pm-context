/** Measure real current and historical status assertions from an exported public tracker. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHistoryPath, readHistorySnapshot } from "@unbrained/pm-cli/sdk";
import { buildContextPack, checkContextWitnesses, encodeWitnessReport } from "../index.ts";
import { readFileFocusItems } from "../file-focus.ts";
import type { ContextClaim } from "../index.ts";

/** Enumerate only the supplied scratch copy and refuse links before reading or chmod. */
function paths(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = join(prefix, name);
    const stat = lstatSync(join(root, path));
    assert.ok(!stat.isSymbolicLink(), "Public export must contain regular files and directories only");
    return stat.isDirectory() ? [path, ...paths(root, path)] : [path];
  });
}
/** Include all source file bytes and coordinates in the immutable-read proof. */
function fingerprint(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const path of files) hash.update(path).update(readFileSync(join(root, path)));
  return hash.digest("hex");
}

process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const source = process.argv[2];
assert.ok(source, "Supply a committed public tracker export");
const scratch = mkdtempSync(join(tmpdir(), "witness-measure-"));
const root = join(scratch, "public-copy");
try {
  cpSync(source, root, { recursive: true });
  assert.equal(existsSync(join(root, ".git")), false, "Validation must run outside Git");
  const entries = paths(root);
  const files = entries.filter((path) => lstatSync(join(root, path)).isFile());
  const directories = entries.filter((path) => lstatSync(join(root, path)).isDirectory());
  for (const path of files) chmodSync(join(root, path), 0o444);
  for (const path of [...directories].reverse()) chmodSync(join(root, path), 0o555);
  chmodSync(root, 0o555);
  const before = fingerprint(root, files);
  const pmRoot = join(root, ".agents", "pm");
  const readStart = performance.now();
  const items = await readFileFocusItems(pmRoot);
  assert.ok(items.length > 10 && items.length <= 256);
  const pack = buildContextPack(items, { includeClosed: true, limit: 256, neighborhood: false, generatedAt: "2026-10-23T00:00:00.000Z" });
  assert.equal(pack.items.length, items.length);
  const claims: ContextClaim[] = pack.items.filter((item) => typeof item.status === "string").map((item, index) => ({
    id: `current-${index}`, kind: "state", subject: item.id, field: "status", scope: "assembled-current",
    value: item.status!, citation: { item: item.id, field: "/metadata/status" },
  }));
  const readMs = performance.now() - readStart;
  const historical: ContextClaim[] = [];
  let historyEntries = 0;
  for (const [index, current] of claims.entries()) {
    const history = await readHistorySnapshot(getHistoryPath(pmRoot, current.subject), current.subject);
    historyEntries += history.entries.length;
    outer: for (const [eventIndex, event] of history.entries.entries()) for (const [patchIndex, patch] of event.patch.entries()) {
      if ((patch.op === "add" || patch.op === "replace") && patch.path === "/metadata/status" && typeof patch.value === "string" && patch.value !== current.value) {
        // Deliberately present a real historical assertion as co-current: this
        // is a stale handoff assembly error, not a claim the source is corrupt.
        historical.push({ ...current, id: `historical-${index}`, value: patch.value, citation: { item: `history:${current.subject}`, field: `/entries/${eventIndex}/patch/${patchIndex}/value` } });
        break outer;
      }
    }
  }
  assert.ok(historical.length > 0, "Public tracker must have recorded status transitions");
  const scenarios = [];
  for (const [scenario, selected, expectedPairs] of [
    ["current-recorded-status", claims, 0],
    ["historical-status-presented-as-current", [...claims, ...historical], historical.length],
  ] as const) {
    const started = performance.now();
    const report = checkContextWitnesses({ claims: [...selected] });
    const milliseconds = performance.now() - started;
    assert.equal(report.conflicting_pairs, expectedPairs);
    assert.equal(report.witness?.claims.length ?? 0, expectedPairs ? 2 : 0);
    assert.deepEqual(checkContextWitnesses({ claims: [...selected].reverse() }), report);
    scenarios.push({ scenario, claims: selected.length, conflicting_pairs: report.conflicting_pairs, witness_size: report.witness?.claims.length ?? 0, json_bytes: Buffer.byteLength(encodeWitnessReport(report, "json")), toon_bytes: Buffer.byteLength(encodeWitnessReport(report)), milliseconds: Number(milliseconds.toFixed(2)) });
  }
  assert.deepEqual(paths(root), entries, "Validation created or removed files");
  assert.equal(fingerprint(root, files), before, "Validation changed tracker bytes");
  console.log(JSON.stringify({ items: items.length, selected_items: pack.items.length, history_entries: historyEntries, historical_statuses: historical.length, read_ms: Number(readMs.toFixed(2)), source_files: files.length, source_bytes_unchanged: true, git_required: false, scenarios }, null, 2));
} finally {
  // Only this script's owned copy is made writable again for cleanup.
  chmodSync(root, 0o755);
  for (const path of paths(root)) if (lstatSync(join(root, path)).isDirectory()) chmodSync(join(root, path), 0o755);
  rmSync(scratch, { recursive: true, force: true });
}
