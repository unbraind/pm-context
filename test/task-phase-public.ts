/** Reproducible read-only validation of committed public tracker snapshots outside Git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { buildPhaseContext, createFreshnessReader, encodePhaseContext, PhaseContextError, TASK_PHASES } from "../dist/index.js";
import type { PhaseContextRequest } from "../dist/index.js";
import { readFileFocusItems } from "../dist/file-focus.js";

/** Hash every source and runtime byte so accidental writes cannot hide in excluded folders. */
function snapshot(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink(), "public source must contain ordinary files");
    hash.update(entry.name).update(entry.isDirectory() ? snapshot(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}
/** Protect the owned scratch copy, then restore directory permissions only for cleanup. */
function permissions(root: string, readonly: boolean): void {
  chmodSync(root, readonly ? 0o555 : 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) permissions(path, readonly);
    else chmodSync(path, readonly ? 0o444 : 0o644);
  }
}

const input = process.argv[2];
assert.ok(input, "usage: node test/task-phase-public.ts COMMITTED_PUBLIC_TRACKER");
const root = mkdtempSync(join(tmpdir(), "phase-public-"));
const tracker = join(root, "tracker");
const original = snapshot(resolve(input));
try {
  cpSync(resolve(input), tracker, { recursive: true }); permissions(tracker, true);
  assert.equal(existsSync(join(root, ".git")), false);
  process.env.GIT_CEILING_DIRECTORIES = root;
  process.env.PATH = join(root, "no-executables");
  const items = await readFileFocusItems(tracker);
  const phaseCounts = Object.fromEntries(TASK_PHASES.map((phase) => [phase, { ok: 0, refused: 0 }])) as Record<string, { ok: number; refused: number }>;
  const refusals: Record<string, number> = {};
  const formats = { json: { packets: 0, bytes: 0, min: 262144, max: 0 }, toon: { packets: 0, bytes: 0, min: 262144, max: 0 } };
  let mandatory = 0; let omissions = 0; let switches = 0; let reused = 0; let sourceFields = 0;
  const read = createFreshnessReader(tracker, root);
  for (const item of items) {
    const source = JSON.parse(JSON.stringify(await read({ kind: "item", id: item.id }))) as Record<string, unknown>;
    sourceFields += Object.keys(source).length;
    const request: PhaseContextRequest = { items: [item.id], phase: "investigation", contracts: {
      investigation: ["title", "description"], implementation: ["title", "body"], review: ["title", "acceptance_criteria"], handoff: ["title", "status"],
    } };
    for (const phase of TASK_PHASES) for (const format of ["json", "toon"] as const) {
      try {
        const packet = await buildPhaseContext({ ...request, phase, format }, tracker);
        const encoded = encodePhaseContext(packet);
        assert.equal(Buffer.byteLength(encoded), packet.bytes); assert.ok(packet.bytes <= 16000);
        assert.deepEqual(format === "json" ? JSON.parse(encoded) : decodeToon(encoded), packet);
        for (const binding of packet.bindings) {
          const fact = packet.facts.find((row) => row.id === binding.fact)!; assert.ok("value_json" in fact);
          assert.deepEqual(JSON.parse(fact.value_json), source[binding.field]); mandatory++;
        }
        assert.equal(packet.bindings.length, request.contracts[phase].length);
        omissions += packet.omission_receipt.omitted_field_group_count;
        phaseCounts[phase]!.ok++;
        const stats = formats[format]; stats.packets++; stats.bytes += packet.bytes; stats.min = Math.min(stats.min, packet.bytes); stats.max = Math.max(stats.max, packet.bytes);
      } catch (error) {
        assert.ok(error instanceof PhaseContextError);
        assert.ok(["MISSING_FIELD", "BUDGET_TOO_SMALL"].includes(error.code), error.message);
        phaseCounts[phase]!.refused++; refusals[error.code] = (refusals[error.code] ?? 0) + 1;
      }
    }
    try {
      const first = await buildPhaseContext({ ...request, session: { version: 1, id: "public", token_budget: 50000, spent_tokens: 0, seen_item_ids: [] } }, tracker);
      const next = await buildPhaseContext({ ...request, phase: "implementation", previous_phase: "investigation", session: first.read_session!.next_state }, tracker);
      assert.equal(next.read_session!.suppressed_repeat_count, 1); switches++; reused += next.read_session!.suppressed_repeat_count;
    } catch (error) { assert.ok(error instanceof PhaseContextError && error.code === "BUDGET_TOO_SMALL"); }
  }
  assert.equal(snapshot(tracker), original); assert.equal(snapshot(resolve(input)), original);
  console.log(JSON.stringify({ items: items.length, source_fields: sourceFields, attempts: items.length * 8, phaseCounts, refusals, formats,
    mandatory_values_verified: mandatory, omitted_fields_with_selectors: omissions, phase_switches: switches, unchanged_sdk_references: reused,
    source_bytes_unchanged: true, git_available: false, readonly_copy: true }));
} finally { permissions(root, false); rmSync(root, { recursive: true, force: true }); }
