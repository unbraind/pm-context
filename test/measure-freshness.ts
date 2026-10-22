/** Reproducible public-tracker experiment; mutations are confined to disposable variants. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { update, deleteItem } from "@unbrained/pm-cli/sdk/core";
import { readPmItems, createFreshnessReader, recordFreshness, resumeFreshness, encodeFreshness } from "../index.ts";
import type { FreshnessPacket } from "../index.ts";

/** Enumerate only the explicitly supplied scratch tree, refusing symlinks. */
function files(root: string, prefix: string = ""): string[] {
  return readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = join(prefix, name);
    const stat = lstatSync(join(root, path));
    assert.ok(!stat.isSymbolicLink());
    return stat.isDirectory() ? files(root, path) : [path];
  });
}
/** Verify all source bytes, not merely the item selected for mutation. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const path of files(root)) hash.update(path).update(readFileSync(join(root, path)));
  return hash.digest("hex");
}
/** Freeze inputs before invoking validation; restore write mode only for owned cleanup. */
function freeze(root: string): void { for (const path of files(root)) chmodSync(join(root, path), 0o444); }

const input = process.argv[2];
if (!input) throw new Error("Supply an exported public tracker tree; no git commands run in this experiment.");
const scratch = mkdtempSync(join(tmpdir(), "freshness-measure-"));
try {
  const roots = ["baseline", "changed", "unavailable"].map((name) => join(scratch, name));
  for (const root of roots) cpSync(input, root, { recursive: true });
  const base = roots[0]!;
  const pmRoot = join(base, ".agents", "pm");
  const items = (await readPmItems(pmRoot)).sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(items.length > 10 && items.length < 250);
  const target = items[0]!.id;
  const packet: FreshnessPacket = { sections: [
    ...items.map((item, index) => ({ id: `item-${index}`, content: `Assumptions from public item ${index}`, sources: [{ kind: "item" as const, id: item.id }], depends_on: [] })),
    { id: "settings", content: "Effective workspace schema", sources: [{ kind: "settings", fields: ["schema", "author_default"] }], depends_on: [] },
    { id: "evidence", content: "Published package documentation", sources: [{ kind: "evidence", path: "README.md" }], depends_on: [] },
    { id: "dependent-plan", content: "Plan based on the first prerequisite", sources: [], depends_on: ["item-0"] },
  ] };
  const changed = roots[1]!;
  await update(target, { title: "Synthetic changed prerequisite", author: "validation-agent", force: true }, { cwd: changed, pmRoot: join(changed, ".agents", "pm") });
  const settingsPath = join(changed, ".agents", "pm", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  writeFileSync(settingsPath, JSON.stringify({ ...settings, author_default: "validation-agent" }));
  writeFileSync(join(changed, "README.md"), "Synthetic changed evidence\n");
  const unavailable = roots[2]!;
  await deleteItem(target, { author: "validation-agent", force: true }, { cwd: unavailable, pmRoot: join(unavailable, ".agents", "pm") });
  for (const root of roots) freeze(root);
  const before = roots.map(fingerprint);
  chmodSync(join(unavailable, "README.md"), 0);
  const started = performance.now();
  const manifest = await recordFreshness(packet, createFreshnessReader(pmRoot, base));
  const recordMs = performance.now() - started;
  const scenarios = [];
  for (const [index, root] of roots.entries()) {
    const start = performance.now();
    const result = await resumeFreshness(packet, manifest, createFreshnessReader(join(root, ".agents", "pm"), root));
    const milliseconds = performance.now() - start;
    const encoded = encodeFreshness(result, "json", 4000);
    const toon = encodeFreshness(result, "toon", 4000);
    assert.equal(result.omitted_sections, 0);
    assert.equal(result.invalidated_sections, [0, 4, 3][index]);
    assert.equal(result.code, ["FRESH", "STALE", "SOURCE_UNAVAILABLE"][index]);
    scenarios.push({ scenario: ["unchanged", "item-settings-evidence-change", "deleted-item-unreadable-evidence"][index], code: result.code, checked_sources: result.checked_sources, unchanged_sections: result.unchanged_sections, invalidated_sections: result.invalidated_sections, unavailable_sources: result.unavailable_sources, json_bytes: Buffer.byteLength(encoded), toon_bytes: Buffer.byteLength(toon), milliseconds: Number(milliseconds.toFixed(2)) });
  }
  chmodSync(join(unavailable, "README.md"), 0o444);
  assert.deepEqual(roots.map(fingerprint), before, "validation changed source bytes");
  console.log(JSON.stringify({ items: items.length, sections: packet.sections.length, sources: manifest.sources.length, manifest_bytes: Buffer.byteLength(encodeFreshness(manifest, "json", 262144)), record_ms: Number(recordMs.toFixed(2)), source_bytes_unchanged: true, scenarios }, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
