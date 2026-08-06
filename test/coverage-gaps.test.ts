/**
 * Additional coverage tests for index.ts — targeting branches and functions
 * not exercised by the main context-pack and context-usage test files.
 *
 * These tests cover: pure-function edge cases (empty states, missing fields,
 * error paths), the context-handoff command run through the harness, the
 * context-usage command with an author and affinity, and defensive catch
 * blocks triggered by corrupted ledger data.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension, {
  buildAgentHandoff,
  buildContextExplain,
  buildContextPack,
  buildSuggestedAgentCommand,
  createSdkPacker,
  createSdkRanker,
  extractRelationships,
  rankContextItems,
  readPmItems,
  renderAgentHandoff,
  renderContextExplain,
  renderMarkdown,
  scoreContextItems,
  sortContextItems,
  byIdOrFail,
  markdownEscape,
  renderedCommandResult,
  CommandError,
  type ContextPack,
  type PmItem,
  type SdkRankOptions,
} from "../index.ts";

import { init } from "@unbrained/pm-cli/sdk";
import { create } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";

type ExtensionHarness = Awaited<ReturnType<typeof createExtensionTestHarness>>;

const activeHarnesses = new Set<ExtensionHarness>();

test.afterEach(async () => {
  for (const runner of activeHarnesses) await runner.deactivate();
  activeHarnesses.clear();
});

/** Manifest capabilities the harness must grant for registration to be permitted. */
const CAPABILITIES = ["commands", "renderers", "schema"] as const;

/** Build SdkRankOptions from a real tracker root, used for direct ranking tests. */
async function rankOptionsFrom(root: string, author?: string): Promise<SdkRankOptions> {
  const settings = await readSettings(root);
  return {
    statusRegistry: resolveRuntimeStatusRegistry(settings.schema),
    now: "2026-07-01T00:00:00.000Z",
    author,
  };
}

// ---------------------------------------------------------------------------
// Pure-function edge cases
// ---------------------------------------------------------------------------

test("buildSuggestedAgentCommand shellQuotes status values with spaces", () => {
  const command = buildSuggestedAgentCommand({
    commandName: "context-pack",
    selection: { ids: [], status: "in progress", type: undefined, tag: undefined, inferredStatus: false },
    limit: 25,
    defaultLimit: 25,
    recentLimit: 5,
    defaultRecentLimit: 5,
    includeClosed: false,
    neighborhood: true,
    neighborhoodDepth: 1,
    includeFormatFlag: true,
  });
  assert.match(command, /--status 'in progress'/);
});

test("extractRelationships handles non-string, non-array, non-object relationship values", () => {
  const item: PmItem = { id: "pm-1", deps: 42, blocked_by: true };
  const rels = extractRelationships(item);
  assert.deepEqual(rels, []);
});

test("buildContextPack with non-string, non-array, non-object docs values produces no links", () => {
  const item: PmItem = { id: "pm-1", title: "T", status: "open", docs: 42, files: true };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  assert.deepEqual(pack.links, []);
});

test("renderMarkdown shows no-relationships message when neighborhood is included but empty", () => {
  const item: PmItem = { id: "pm-1", title: "Solo", type: "Task", status: "open", priority: 1 };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderMarkdown(pack, { sections: ["neighborhood"] });
  assert.match(md, /_No dependency relationships in focus\._/);
});

test("buildAgentHandoff uses 'selected focus item' reason when priority is absent", () => {
  const item: PmItem = { id: "pm-1", title: "No priority", type: "Task", status: "in_progress" };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const handoff = buildAgentHandoff(pack);
  assert.deepEqual(handoff.nextActions, [{ id: "pm-1", title: "No priority", reason: "selected focus item" }]);
});

test("renderAgentHandoff renders all empty-state placeholders", () => {
  const emptyPack: ContextPack = {
    generatedAt: "now",
    filters: { ids: [], includeClosed: false, neighborhood: false, includeDeps: false },
    summary: { totalItems: 0, selectedItems: 0, neighborItems: 0, byStatus: {}, byType: {} },
    items: [],
    neighbors: [],
    links: [],
    relationships: [],
  };
  const md = renderAgentHandoff(emptyPack);
  assert.match(md, /_No focus items\._/);
  assert.match(md, /_No visible blockers\._/);
  assert.match(md, /_No open focus items\._/);
  assert.match(md, /_No recent open activity\._/);
  assert.match(md, /_No linked files or docs\._/);
});

test("renderAgentHandoff renders empty deps placeholder when includeDeps is set but no deps exist", () => {
  const item: PmItem = { id: "pm-1", title: "Solo", type: "Task", status: "in_progress", priority: 1 };
  const pack = buildContextPack([item], { ids: ["pm-1"], includeDeps: true, generatedAt: "now" });
  const md = renderAgentHandoff(pack, { sections: ["deps"] });
  assert.match(md, /_No dependency relationships found\._/);
});

test("renderAgentHandoff renders the refresh section", () => {
  const item: PmItem = { id: "pm-1", title: "T", type: "Task", status: "in_progress", priority: 1 };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderAgentHandoff(pack, { sections: ["refresh"] });
  assert.match(md, /## Refresh/);
  assert.match(md, /`pm context-pack --id pm-1 --format agent`/);
});

// ---------------------------------------------------------------------------
// renderContextExplain — the markdown path is never hit by the explain test
// in context-pack.test.ts (it only uses --format json).
// ---------------------------------------------------------------------------

test("renderContextExplain renders entries with contributions sorted by impact", () => {
  const report = {
    generatedAt: "2026-07-01T00:00:00.000Z",
    model: "context-relevance-v1",
    ranking_scope: "emitted_pack" as const,
    available_signals: ["priority_pressure", "recency", "claim_focus"],
    entries: [
      { id: "pm-1", rank: 1, score: 0.95, contributions: { priority_pressure: 0.5, recency: 0.3, claim_focus: 0.15 } },
      { id: "pm-2", rank: 2, score: 0.4, contributions: { priority_pressure: 0.1, recency: 0.3, claim_focus: 0 } },
    ],
  };
  const md = renderContextExplain(report);
  assert.match(md, /^# pm context explain/);
  assert.match(md, /Model: context-relevance-v1/);
  assert.match(md, /Signals: priority_pressure, recency, claim_focus/);
  assert.match(md, /\*\*pm-1\*\* rank 1 score 0\.950/);
  // Contributions must be sorted most-contributing first.
  const pm1Line = md.split("\n").find((l) => l.includes("pm-1")) ?? "";
  const priorityIdx = pm1Line.indexOf("priority_pressure");
  const recencyIdx = pm1Line.indexOf("recency");
  assert.ok(priorityIdx < recencyIdx, "priority_pressure should appear before recency (sorted desc)");
});

test("renderContextExplain renders the empty-entries placeholder", () => {
  const report = {
    generatedAt: "2026-07-01T00:00:00.000Z",
    model: "context-relevance-v1",
    ranking_scope: "emitted_pack" as const,
    available_signals: ["priority_pressure"],
    entries: [],
  };
  const md = renderContextExplain(report);
  assert.match(md, /_No focus items to explain\._/);
});

test("renderContextExplain compress removes blank lines", () => {
  const report = {
    generatedAt: "2026-07-01T00:00:00.000Z",
    model: "context-relevance-v1",
    ranking_scope: "emitted_pack" as const,
    available_signals: ["priority_pressure"],
    entries: [{ id: "pm-1", rank: 1, score: 0.5, contributions: { priority_pressure: 0.5 } }],
  };
  const md = renderContextExplain(report, { compress: true });
  assert.equal(md.includes("\n\n"), false, "compressed output should have no blank lines");
});

// ---------------------------------------------------------------------------
// SDK ranker / packer / scorer edge cases
// ---------------------------------------------------------------------------

test("createSdkRanker returns items unchanged when length <= 1", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-rank-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const opts = await rankOptionsFrom(initialized.path);
    const ranker = createSdkRanker([], opts);
    assert.deepEqual(ranker([]), []);
    const one: PmItem[] = [{ id: "pm-1", title: "Solo", type: "Task", status: "in_progress", priority: 1 }];
    assert.deepEqual(ranker(one), one);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createSdkPacker returns focus and neighbors unchanged when maxItems is 0", () => {
  const focus: PmItem[] = [{ id: "pm-1", title: "F", type: "Task", status: "in_progress", priority: 1 }];
  const neighbors: PmItem[] = [{ id: "pm-2", title: "N", type: "Task", status: "open", priority: 0 }];
  const packer = createSdkPacker(focus, neighbors);
  const result = packer(focus, neighbors, 0);
  assert.deepEqual(result.focus, focus);
  assert.deepEqual(result.neighbors, neighbors);
});

test("createSdkPacker handles items without body in projection cost estimation", () => {
  const focus: PmItem[] = [{ id: "pm-1", title: "F", type: "Task", status: "in_progress" }];
  const neighbors: PmItem[] = [{ id: "pm-2", title: "N", type: "Task", status: "open" }];
  const packer = createSdkPacker(focus, neighbors);
  // maxItems = 2 should pack both items; the body-absent branch in
  // estimateProjectionCosts is exercised here.
  const result = packer(focus, neighbors, 2);
  assert.equal(result.focus.length, 1);
  assert.equal(result.neighbors.length, 1);
});

test("scoreContextItems fills missing optional fields via toItemMetadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-rank-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const opts = await rankOptionsFrom(initialized.path);
    // Items with no title, no description, no type, no status, no tags, no
    // timestamps, and an out-of-range priority — toItemMetadata must fill
    // defaults for all of these.
    const items: PmItem[] = [
      { id: "pm-1", priority: 99 } as PmItem,
      { id: "pm-2", priority: -1 } as PmItem,
    ];
    const report = scoreContextItems(items, opts);
    assert.equal(report.ranked.length, 2);
    // Every item should be ranked (no throw from missing fields).
    assert.deepEqual(new Set(report.ranked.map((r) => r.id)), new Set(["pm-1", "pm-2"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rankContextItems returns items in ranked order", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-rank-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const opts = await rankOptionsFrom(initialized.path);
    const items: PmItem[] = [
      { id: "pm-1", title: "A", type: "Task", status: "in_progress", priority: 1, updated_at: "2026-07-01T00:00:00Z" },
      { id: "pm-2", title: "B", type: "Task", status: "in_progress", priority: 0, updated_at: "2026-07-02T00:00:00Z" },
    ];
    const ranked = rankContextItems(items, opts);
    assert.equal(ranked.length, 2);
    // Higher priority (0) should rank first.
    assert.equal(ranked[0].id, "pm-2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildContextExplain produces a report from the SDK relevance model", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-rank-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const opts = await rankOptionsFrom(initialized.path);
    const items: PmItem[] = [
      { id: "pm-1", title: "A", type: "Task", status: "in_progress", priority: 1, updated_at: "2026-07-01T00:00:00Z" },
    ];
    const report = buildContextExplain(items, opts);
    assert.equal(report.ranking_scope, "emitted_pack");
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].id, "pm-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readPmItems error path
// ---------------------------------------------------------------------------

test("readPmItems throws CommandError when pmRoot is not a tracker", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-bad-"));
  try {
    await assert.rejects(() => readPmItems(root), /Could not read pm items via SDK list/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Command-path tests through the harness
// ---------------------------------------------------------------------------

/** Activate the extension through the SDK host harness. */
async function harness() {
  const created = await createExtensionTestHarness(extension, {
    name: "pm-context",
    capabilities: CAPABILITIES,
  });
  assert.deepEqual(created.activation.failed, [], "activation must not fail");
  activeHarnesses.add(created);
  return created;
}

/** Unwrap the `{ handled, result }` envelope the host returns from a command run. */
function commandResult<TResult>(result: unknown): TResult {
  return (result as { result: TResult }).result;
}

test("context-handoff renders agent handoff for a focus item", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const focus = await create(
      { title: "Handoff focus", id: "focus", status: "in_progress", author: "test" },
      { cwd: root },
    );
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: focus.item.id, format: "agent" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output, "expected rendered output");
    assert.match(output, /^# pm agent handoff/);
    assert.match(output, /Handoff focus/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-handoff returns json for --format json", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const focus = await create(
      { title: "Handoff focus", id: "focus", status: "in_progress", author: "test" },
      { cwd: root },
    );
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: focus.item.id, format: "json" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output, "expected json output");
    const handoff = JSON.parse(output) as { focus: Array<{ id: string }>; suggestedCommand: string };
    assert.equal(handoff.focus.length, 1);
    assert.equal(handoff.focus[0].id, focus.item.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-handoff rejects an invalid format", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const runner = await harness();
    await assert.rejects(
      () => runner.runCommand({ command: "context-handoff", pmRoot: initialized.path, options: { format: "markdown" } }),
      /--format must be agent, json, or compact/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-handoff writes output to --output file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const focus = await create(
      { title: "Handoff focus", id: "focus", status: "in_progress", author: "test" },
      { cwd: root },
    );
    const runner = await harness();
    const outputPath = join(root, "handoff.md");
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: focus.item.id, format: "agent", output: outputPath },
      global: { json: false },
    });
    const ret = commandResult<{ ok?: boolean; format?: string }>(result);
    assert.equal(ret.ok, true);
    assert.equal(ret.format, "agent");
    const written = readFileSync(outputPath, "utf-8");
    assert.match(written, /# pm agent handoff/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-handoff defaults status to in_progress when no selector is given", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const ip = await create({ title: "In progress", id: "ip", status: "in_progress", author: "test" }, { cwd: root });
    await create({ title: "Open", id: "open", status: "open", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { format: "json" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    const handoff = JSON.parse(output) as { focus: Array<{ id: string }> };
    assert.equal(handoff.focus.length, 1);
    assert.equal(handoff.focus[0].id, ip.item.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-handoff writes json output to --output file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const outputPath = join(root, "handoff.json");
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "json", output: outputPath },
      global: { json: false },
    });
    const ret = commandResult<{ ok?: boolean; format?: string }>(result);
    assert.equal(ret.ok, true);
    const written = JSON.parse(readFileSync(outputPath, "utf-8")) as { focus: Array<{ id: string }> };
    assert.equal(written.focus.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-handoff records a serving event when author is provided", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "agent", author: "test" },
      global: { json: false },
    });
    const ledgerPath = join(initialized.path, "runtime", "context-usage.jsonl");
    assert.ok(existsSync(ledgerPath), "serving event must be recorded");
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    const last = JSON.parse(lines.at(-1) ?? "{}") as { kind?: string; rows?: Array<{ id: string }> };
    assert.equal(last.kind, "serve");
    assert.deepEqual(last.rows?.map((r) => r.id), [f.item.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-handoff uses max-items to budget the pack", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "json", maxItems: "1" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output, "expected json output");
    const handoff = JSON.parse(output) as { counts: { focus: number; neighbors: number } };
    assert.equal(handoff.counts.focus, 1);
    assert.equal(handoff.counts.neighbors, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Generate ISO timestamps relative to now for ledger seeding.
 * The SDK's affinity reader enforces a 30-day retention window, so events
 * must be recent to be counted.
 */
function recentIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// context-usage with --by (author) and affinity
// ---------------------------------------------------------------------------

test("context-usage with --by returns affinity from the SDK store", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-usage-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    mkdirSync(join(initialized.path, "runtime"), { recursive: true });
    writeFileSync(
      join(initialized.path, "runtime", "context-usage.jsonl"),
      [
        JSON.stringify({ kind: "serve", at: recentIso(10), author: "a", surface: "context", profile: "context", rows: [{ id: "x-1", rank: 1, included: true }] }),
        JSON.stringify({ kind: "touch", at: recentIso(5), author: "a", item_id: "x-1", intent: "update" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-usage",
      pmRoot: initialized.path,
      options: { by: "a" },
      global: { json: true },
    });
    const report = commandResult<{ affinity?: { affinity: Record<string, number>; positive_judgments: number; serving_events: number } }>(result);
    assert.ok(report.affinity, "affinity must be present when --by is given");
    assert.equal(report.affinity!.positive_judgments, 1);
    assert.equal(report.affinity!.serving_events, 1);
    assert.ok(report.affinity!.affinity["x-1"] > 0, "x-1 should have positive affinity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-usage with --by renders affinity in markdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-usage-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    mkdirSync(join(initialized.path, "runtime"), { recursive: true });
    writeFileSync(
      join(initialized.path, "runtime", "context-usage.jsonl"),
      [
        JSON.stringify({ kind: "serve", at: recentIso(10), author: "a", surface: "context", profile: "context", rows: [{ id: "x-1", rank: 1, included: true }] }),
        JSON.stringify({ kind: "touch", at: recentIso(5), author: "a", item_id: "x-1", intent: "update" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-usage",
      pmRoot: initialized.path,
      options: { by: "a" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.match(output, /## Author affinity \(SDK decayed\)/);
    assert.match(output, /positive judgments: 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-usage with --by degrades gracefully when affinity read fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-usage-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    // Write a corrupted serve event with non-iterable rows so readContextUsageAffinity throws.
    mkdirSync(join(initialized.path, "runtime"), { recursive: true });
    writeFileSync(
      join(initialized.path, "runtime", "context-usage.jsonl"),
      JSON.stringify({ kind: "serve", at: recentIso(10), author: "a", surface: "context", profile: "context", rows: null }) + "\n",
      "utf-8",
    );
    const runner = await harness();
    // The command should not throw — it catches the affinity read error and returns the report without affinity.
    const result = await runner.runCommand({
      command: "context-usage",
      pmRoot: initialized.path,
      options: { by: "a" },
      global: { json: true },
    });
    const report = commandResult<{ ledger_present?: boolean; affinity?: unknown }>(result);
    assert.equal(report.ledger_present, true);
    assert.equal(report.affinity, undefined, "affinity must be absent when the read fails");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// context-pack error paths: invalid --limit, invalid --recent
// ---------------------------------------------------------------------------

test("context-pack rejects a non-positive --limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const runner = await harness();
    await assert.rejects(
      () => runner.runCommand({ command: "context-pack", pmRoot: initialized.path, options: { limit: "0" } }),
      /--limit must be a positive integer/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-pack rejects a negative --recent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const runner = await harness();
    await assert.rejects(
      () => runner.runCommand({ command: "context-pack", pmRoot: initialized.path, options: { recent: "-1" } }),
      /--recent must be a non-negative integer/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveSdkRankOptions: readContextUsageAffinity catch block
// ---------------------------------------------------------------------------

test("context-pack with author degrades when affinity read fails on corrupted ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    // Write a corrupted serve event so readContextUsageAffinity throws during rank option resolution.
    mkdirSync(join(initialized.path, "runtime"), { recursive: true });
    writeFileSync(
      join(initialized.path, "runtime", "context-usage.jsonl"),
      JSON.stringify({ kind: "serve", at: recentIso(10), author: "test", surface: "context", profile: "context", rows: null }) + "\n",
      "utf-8",
    );
    const runner = await harness();
    // The pack should still succeed — the catch block sets usageAffinity to undefined.
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "json", author: "test" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output, "pack should still render despite affinity read failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recordPackServing catch block: ledger path is a directory
// ---------------------------------------------------------------------------

test("context-pack with author does not fail when serving record throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    // Create a directory at the ledger path so appendFile fails with EISDIR.
    mkdirSync(join(initialized.path, "runtime"), { recursive: true });
    mkdirSync(join(initialized.path, "runtime", "context-usage.jsonl"), { recursive: true });
    const runner = await harness();
    // The pack should still succeed — recordPackServing catches the write error.
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "json", author: "test" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output, "pack should render despite serving record failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// context-pack --output writes to a file (markdown path)
// ---------------------------------------------------------------------------

test("context-pack writes markdown to --output file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const outputPath = join(root, "pack.md");
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "markdown", output: outputPath },
      global: { json: false },
    });
    const ret = commandResult<{ ok?: boolean; format?: string }>(result);
    assert.equal(ret.ok, true);
    assert.equal(ret.format, "markdown");
    const written = readFileSync(outputPath, "utf-8");
    assert.match(written, /^# pm context pack/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// context-pack --explain with markdown output (renders through renderContextExplain)
// ---------------------------------------------------------------------------

test("context-pack --explain renders markdown by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, explain: true },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.match(output, /^# pm context explain/);
    assert.match(output, /Ranking scope: emitted pack/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-pack --explain writes markdown to --output file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const outputPath = join(root, "explain.md");
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, explain: true, output: outputPath },
      global: { json: false },
    });
    const ret = commandResult<{ ok?: boolean; explained?: number }>(result);
    assert.equal(ret.ok, true);
    assert.equal(ret.explained, 1);
    const written = readFileSync(outputPath, "utf-8");
    assert.match(written, /# pm context explain/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// Branch-coverage tests: targeting specific uncovered branches identified by
// the V8 coverage report. Each test asserts an observable outcome, not just
// line execution.
// ===========================================================================

// --- sortContextItems: missing priority (L365/L366 false arms) -------------

test("sortContextItems treats missing priority as lowest urgency", () => {
  const withPriority: PmItem = { id: "a", title: "Has priority", type: "Task", status: "open", priority: 1, updated_at: "2026-01-01T00:00:00Z" };
  const noPriority: PmItem = { id: "b", title: "No priority", type: "Task", status: "open", updated_at: "2026-01-01T00:00:00Z" };
  const sorted = sortContextItems([noPriority, withPriority]);
  // The item with a numeric priority (1) should rank before the one without
  // (treated as Number.MAX_SAFE_INTEGER — lowest urgency).
  assert.equal(sorted[0].id, "a");
  assert.equal(sorted[1].id, "b");
});

// --- sortContextItems: equal priority + equal timestamps → id tiebreaker (L368) ---

test("sortContextItems breaks equal-priority equal-timestamp ties by id", () => {
  const items: PmItem[] = [
    { id: "pm-b", title: "B", type: "Task", status: "open", priority: 1, updated_at: "2026-01-01T00:00:00Z" },
    { id: "pm-a", title: "A", type: "Task", status: "open", priority: 1, updated_at: "2026-01-01T00:00:00Z" },
  ];
  const sorted = sortContextItems(items);
  // Equal priority and equal updated_at → tiebreaker is a.id.localeCompare(b.id)
  assert.equal(sorted[0].id, "pm-a");
  assert.equal(sorted[1].id, "pm-b");
});

// --- itemStatus fallback "unknown" (L347) -----------------------------------

test("buildContextPack itemStatus falls back to unknown when status is absent", () => {
  const item: PmItem = { id: "pm-1", title: "No status" };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  assert.equal(pack.summary.byStatus["unknown"], 1);
});

// --- parseRelationshipValue: item/item_id fallback (L383), empty to (L384), type fallback (L385) ---

test("extractRelationships uses item and item_id fallbacks for target id", () => {
  const item: PmItem = { id: "pm-1", dependencies: [{ item: "pm-2" }] };
  const rels = extractRelationships(item);
  assert.deepEqual(rels, [{ from: "pm-1", to: "pm-2", kind: "depends_on" }]);
});

test("extractRelationships uses item_id fallback for target id", () => {
  const item: PmItem = { id: "pm-1", dependencies: [{ item_id: "pm-3" }] };
  const rels = extractRelationships(item);
  assert.deepEqual(rels, [{ from: "pm-1", to: "pm-3", kind: "depends_on" }]);
});

test("extractRelationships skips objects with no resolvable target id", () => {
  const item: PmItem = { id: "pm-1", dependencies: [{ kind: "depends_on" }] };
  const rels = extractRelationships(item);
  assert.deepEqual(rels, []);
});

test("extractRelationships uses type fallback for kind when kind is absent", () => {
  const item: PmItem = { id: "pm-1", dependencies: [{ id: "pm-2", type: "relates_to" }] };
  const rels = extractRelationships(item);
  assert.deepEqual(rels, [{ from: "pm-1", to: "pm-2", kind: "relates_to" }]);
});

// --- extractRelationships: duplicate dedup (L404) --------------------------

test("extractRelationships deduplicates identical relationships", () => {
  const item: PmItem = { id: "pm-1", deps: ["pm-2", "pm-2"], dependencies: [{ id: "pm-2", kind: "depends_on" }] };
  const rels = extractRelationships(item);
  // All three entries resolve to the same {from: pm-1, to: pm-2, kind: depends_on}
  assert.deepEqual(rels, [{ from: "pm-1", to: "pm-2", kind: "depends_on" }]);
});

// --- matchesFilters: type mismatch (L440) -----------------------------------

test("buildContextPack type filter excludes non-matching items", () => {
  const items: PmItem[] = [
    { id: "pm-1", title: "Feature", type: "Feature", status: "open" },
    { id: "pm-2", title: "Bug", type: "Bug", status: "open" },
  ];
  const pack = buildContextPack(items, { type: "Feature", generatedAt: "now" });
  assert.deepEqual(pack.items.map((item) => item.id), ["pm-1"]);
});

// --- buildContextPack: negative neighborhoodDepth (L459) --------------------

test("buildContextPack clamps negative neighborhoodDepth to 0", () => {
  const items: PmItem[] = [
    { id: "pm-1", title: "Focus", type: "Task", status: "open", dependencies: [{ id: "pm-2", kind: "depends_on" }] },
    { id: "pm-2", title: "Neighbor", type: "Task", status: "open" },
  ];
  const pack = buildContextPack(items, { ids: ["pm-1"], neighborhoodDepth: -1, generatedAt: "now" });
  assert.equal(pack.neighbors.length, 0, "negative depth must produce no neighbors");
  assert.equal(pack.filters.neighborhood, false);
});

// --- renderItemList: item with assignee and deadline (L573/L574 true arms) ---

test("renderMarkdown shows assignee and deadline in item metadata", () => {
  const item: PmItem = { id: "pm-1", title: "With assignee", type: "Task", status: "in_progress", priority: 1, assignee: "alice", deadline: "2026-12-01" };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderMarkdown(pack);
  assert.match(md, /@alice/);
  assert.match(md, /due 2026-12-01/);
});

// --- renderItemList: item without priority (L572 false arm) -----------------

test("renderMarkdown omits priority from metadata when item has no priority", () => {
  const item: PmItem = { id: "pm-1", title: "No priority", type: "Task", status: "in_progress" };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderMarkdown(pack);
  // The meta section is `(type | status | p<n> | ...)`. When priority is absent,
  // there should be no `p`-prefixed priority segment — not even `pundefined`.
  const metaMatch = md.match(/\(([^)]*)\)/);
  assert.ok(metaMatch, "metadata section should be present");
  const meta = metaMatch[1];
  const segments = meta.split(" | ").map((s) => s.trim());
  assert.equal(segments.some((s) => s.startsWith("p")), false, "no segment should start with 'p' (priority prefix) when priority is absent");
});

// --- renderItemList: item without title → "(untitled)" fallback (L576) -----

test("renderMarkdown shows untitled for items with no title", () => {
  const item: PmItem = { id: "pm-1", type: "Task", status: "open" };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderMarkdown(pack);
  assert.match(md, /\*\*pm-1\*\* \(untitled\)/);
});

// --- renderMarkdown: empty pack → "none" for byStatus/byType (L603/L604) ----

test("renderMarkdown shows none for empty byStatus and byType", () => {
  const emptyPack: ContextPack = {
    generatedAt: "now",
    filters: { ids: [], includeClosed: false, neighborhood: false, includeDeps: false },
    summary: { totalItems: 0, selectedItems: 0, neighborItems: 0, byStatus: {}, byType: {} },
    items: [],
    neighbors: [],
    links: [],
    relationships: [],
  };
  const md = renderMarkdown(emptyPack);
  assert.match(md, /Statuses: none/);
  assert.match(md, /Types: none/);
});

// --- updatedTimestamp: no timestamps (L663/L665) ---------------------------

test("buildAgentHandoff handles items with no timestamps in recent sort", () => {
  const item: PmItem = { id: "pm-1", title: "No timestamps", type: "Task", status: "in_progress", priority: 1 };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const handoff = buildAgentHandoff(pack);
  // The item should still appear in recent, with updatedAt undefined
  assert.equal(handoff.recent.length, 1);
  assert.equal(handoff.recent[0].updatedAt, undefined);
});

// --- buildAgentHandoff: item without title → "(untitled)" (L689/L707/L723) ---

test("buildAgentHandoff uses untitled for focus items without a title", () => {
  const item: PmItem = { id: "pm-1", type: "Task", status: "in_progress", priority: 1 };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const handoff = buildAgentHandoff(pack);
  assert.equal(handoff.focus[0].title, "(untitled)");
  assert.equal(handoff.nextActions[0].title, "(untitled)");
  assert.equal(handoff.recent[0].title, "(untitled)");
});

// --- buildAgentHandoff: recent sort tiebreaker by id (L703) ----------------

test("buildAgentHandoff breaks recent sort ties by id", () => {
  const items: PmItem[] = [
    { id: "pm-b", title: "B", type: "Task", status: "open", updated_at: "2026-01-01T00:00:00Z" },
    { id: "pm-a", title: "A", type: "Task", status: "open", updated_at: "2026-01-01T00:00:00Z" },
  ];
  const pack = buildContextPack(items, { ids: ["pm-a", "pm-b"], generatedAt: "now" });
  const handoff = buildAgentHandoff(pack);
  // Equal timestamps → tiebreaker by id ascending
  assert.equal(handoff.recent[0].id, "pm-a");
  assert.equal(handoff.recent[1].id, "pm-b");
});

// --- renderAgentHandoff: focus with priority and deadline (L763/L764) --------

test("renderAgentHandoff shows priority and deadline in focus metadata", () => {
  const item: PmItem = { id: "pm-1", title: "T", type: "Task", status: "in_progress", priority: 2, deadline: "2026-12-01" };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderAgentHandoff(pack);
  assert.match(md, /p2/);
  assert.match(md, /due 2026-12-01/);
});

// --- renderAgentHandoff: blocker without title and status (L777/L778 false) --

test("renderAgentHandoff renders blocker without title or status", () => {
  const item: PmItem = { id: "pm-1", title: "Focus", type: "Task", status: "in_progress", priority: 1, dependencies: [{ id: "pm-2", kind: "blocked_by" }] };
  const neighbor: PmItem = { id: "pm-2" };
  const pack = buildContextPack([item, neighbor], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderAgentHandoff(pack);
  // Blocker should show just the id, no title or status
  assert.match(md, /pm-1 blocked_by pm-2$/m);
});

// --- renderAgentHandoff: recent item without updatedAt (L801 false arm) -----

test("renderAgentHandoff omits updated suffix for recent items without updatedAt", () => {
  const item: PmItem = { id: "pm-1", title: "T", type: "Task", status: "in_progress", priority: 1 };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderAgentHandoff(pack);
  const recentLine = md.split("\n").find((l) => l.includes("pm-1:")) ?? "";
  assert.equal(recentLine.includes("updated"), false, "should not show 'updated' when updatedAt is absent");
});

// --- buildSuggestedAgentCommand: no ids but type and tag (L317/L318) --------

test("buildSuggestedAgentCommand includes type and tag when no ids are given", () => {
  const command = buildSuggestedAgentCommand({
    commandName: "context-pack",
    selection: { ids: [], status: undefined, type: "Feature", tag: "release", inferredStatus: false },
    limit: 25,
    defaultLimit: 25,
    recentLimit: 5,
    defaultRecentLimit: 5,
    includeClosed: false,
    neighborhood: true,
    neighborhoodDepth: 1,
    includeFormatFlag: true,
  });
  assert.match(command, /--type Feature/);
  assert.match(command, /--tag release/);
});

// --- buildSuggestedAgentCommand: whitespace-only ids (L306) ----------------

test("buildSuggestedAgentCommand produces no id args when all ids are whitespace", () => {
  const command = buildSuggestedAgentCommand({
    commandName: "context-pack",
    selection: { ids: ["  ", ""], status: "in_progress", type: undefined, tag: undefined, inferredStatus: false },
    limit: 25,
    defaultLimit: 25,
    recentLimit: 5,
    defaultRecentLimit: 5,
    includeClosed: false,
    neighborhood: true,
    neighborhoodDepth: 1,
    includeFormatFlag: true,
  });
  // Whitespace-only ids normalize to empty inside idSelectorArgs, so no --id/--ids
  // args are emitted. The ids.length > 0 check passes (raw length is 2), so the
  // else branch (with status/type/tag selectors) is NOT entered.
  assert.equal(command.includes("--id"), false, "should not include --id when ids are empty after normalization");
  assert.equal(command.includes("--ids"), false, "should not include --ids when ids are empty after normalization");
  assert.equal(command, "pm context-pack --format agent");
});

// --- createSdkPacker: unmatched items trigger rank fallback (L1017-L1026) ---

test("createSdkPacker uses fallback ranks for items not in the ranked list", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const opts = await rankOptionsFrom(initialized.path);
    // Build the packer with empty rank maps so all lookups fall back
    const packer = createSdkPacker([], []);
    const focus: PmItem[] = [{ id: "pm-1", title: "F", type: "Task", status: "in_progress", priority: 1, body: "body text" }];
    const neighbors: PmItem[] = [{ id: "pm-2", title: "N", type: "Task", status: "open" }];
    const result = packer(focus, neighbors, 2);
    // Both items should be packed despite not being in the rank maps
    assert.ok(result.focus.length + result.neighbors.length <= 2);
    assert.ok(result.focus.length >= 1, "focus item should be included");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- createSdkPacker: items with body → estimateTokens for body (L992 true) ---

test("createSdkPacker accounts for body text in projection costs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const opts = await rankOptionsFrom(initialized.path);
    const focus: PmItem[] = [{ id: "pm-1", title: "F", type: "Task", status: "in_progress", priority: 1, body: "A substantial body of text that adds token cost." }];
    const neighbors: PmItem[] = [];
    const packer = createSdkPacker(focus, neighbors);
    const result = packer(focus, neighbors, 1);
    // The focus item has a body, so the full projection cost includes body tokens.
    // It should still be packed since it's required (focus).
    assert.equal(result.focus.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- createSdkRanker: >1 items → rankContextItems path (L973 false, L974) ----

test("createSdkRanker ranks multiple items through the SDK model", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-rank-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const opts = await rankOptionsFrom(initialized.path);
    const items: PmItem[] = [
      { id: "pm-1", title: "A", type: "Task", status: "in_progress", priority: 1, updated_at: "2026-07-01T00:00:00Z" },
      { id: "pm-2", title: "B", type: "Task", status: "in_progress", priority: 0, updated_at: "2026-07-02T00:00:00Z" },
    ];
    const ranker = createSdkRanker(items, opts);
    const ranked = ranker(items);
    // The ranker should produce a different order than input when the SDK model
    // ranks them differently (priority 0 before priority 1).
    assert.equal(ranked.length, 2);
    assert.notDeepEqual(ranked.map((item) => item.id), items.map((item) => item.id), "ranker should reorder items by SDK relevance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-pack: invalid format (L1228/L1229/L1230) -----------------------

test("context-pack rejects an invalid format", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const runner = await harness();
    await assert.rejects(
      () => runner.runCommand({ command: "context-pack", pmRoot: initialized.path, options: { format: "xml" } }),
      /--format must be markdown, json, agent, or compact/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-pack: compact format (L1227 true arm) --------------------------

test("context-pack treats compact format as agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "compact" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output, "compact format should produce output");
    assert.match(output, /^# pm agent handoff/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-pack: compress + json (L1271, L1299) --------------------------

test("context-pack produces compressed json output", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "json", compress: true },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    // Compressed JSON has no blank lines (indent=0)
    assert.equal(output.includes("\n\n"), false, "compressed json should have no blank lines");
    const parsed = JSON.parse(output) as { items: Array<{ id: string }> };
    assert.equal(parsed.items[0].id, f.item.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-pack: sections + json (L1295, L1297) --------------------------

test("context-pack passes sections through in json output", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "agent", section: "focus" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.match(output, /## Focus/);
    assert.equal(output.includes("## Recent Activity"), false, "non-selected sections should be omitted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-handoff: compact format (L1347/L1348 true arm) -----------------

test("context-handoff treats compact format as agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "compact" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.match(output, /^# pm agent handoff/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-handoff: compress + json (L1403) ------------------------------

test("context-handoff produces compressed json output", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "json", compress: true },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.equal(output.includes("\n\n"), false, "compressed json should have no blank lines");
    const parsed = JSON.parse(output) as { focus: Array<{ id: string }> };
    assert.equal(parsed.focus[0].id, f.item.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-handoff: sections + json (L1398, L1400) ----------------------

test("context-handoff passes sections through in agent output", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: f.item.id, format: "agent", section: "blockers" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.match(output, /## Blockers/);
    assert.equal(output.includes("## Focus"), false, "non-selected sections should be omitted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-handoff: --output with inferred status (L1413 true arm) --------

test("context-handoff --output reports defaultedStatus when status is inferred", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    await create({ title: "In progress", id: "ip", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const outputPath = join(root, "handoff.md");
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { format: "agent", output: outputPath },
      global: { json: false },
    });
    const ret = commandResult<{ ok?: boolean; defaultedStatus?: string }>(result);
    assert.equal(ret.ok, true);
    assert.equal(ret.defaultedStatus, "in_progress", "inferred status should be reported as defaultedStatus");
    const written = readFileSync(outputPath, "utf-8");
    assert.match(written, /# pm agent handoff/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- recordPackServing: empty pack (L1169 true arm) ------------------------

test("context-pack with no matching items does not fail on empty serving", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const runner = await harness();
    // Use a tag that matches no items → empty pack → recordPackServing returns early
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { tag: "nonexistent-tag", format: "json", author: "test" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output, "should produce output even with no matching items");
    const parsed = JSON.parse(output) as { items: unknown[]; summary: { selectedItems: number } };
    assert.equal(parsed.summary.selectedItems, 0);
    assert.deepEqual(parsed.items, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-usage.ts: affinity sort tiebreaker (L437) ----------------------

test("context-usage with --by sorts affinity entries with equal values by id", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-usage-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    mkdirSync(join(initialized.path, "runtime"), { recursive: true });
    // Seed two items with identical serve+touch patterns so they get equal affinity.
    // The sort tiebreaker (a[0].localeCompare(b[0])) should order them by id.
    writeFileSync(
      join(initialized.path, "runtime", "context-usage.jsonl"),
      [
        JSON.stringify({ kind: "serve", at: recentIso(10), author: "a", surface: "context", profile: "context", rows: [{ id: "x-2", rank: 1, included: true }, { id: "x-1", rank: 2, included: true }] }),
        JSON.stringify({ kind: "touch", at: recentIso(5), author: "a", item_id: "x-1", intent: "update" }),
        JSON.stringify({ kind: "touch", at: recentIso(5), author: "a", item_id: "x-2", intent: "update" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-usage",
      pmRoot: initialized.path,
      options: { by: "a" },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.match(output, /## Author affinity \(SDK decayed\)/);
    // Both items should appear in the affinity section
    assert.match(output, /x-1:/);
    assert.match(output, /x-2:/);
    // When affinity values are equal, entries should be sorted by id ascending.
    // Extract the affinity lines to verify ordering.
    const affinityLines = output.split("\n").filter((l) => l.match(/^- x-\d+:/));
    assert.ok(affinityLines.length >= 2, "should have at least two affinity entries");
    const firstId = affinityLines[0].match(/^- (x-\d+):/)?.[1];
    const secondId = affinityLines[1].match(/^- (x-\d+):/)?.[1];
    assert.ok(firstId && secondId);
    assert.ok(firstId < secondId, `tiebreaker should sort by id ascending: ${firstId} before ${secondId}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- renderCommandResult: null for non-marked result (L200 false arm) -------
// The renderer's resultDiscriminator normally filters non-marked results before
// the renderer function is called. But the renderer function itself must still
// handle a non-marked result gracefully (defensive). This test calls the
// renderer's run function directly to exercise that defensive path.

test("renderer run function returns null for a non-marked result", async () => {
  const ext = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: CAPABILITIES });
  try {
    for (const override of ext.activation.renderers.overrides) {
      assert.equal(typeof override.run, "function", "renderer override must have a run function");
      // Call the renderer directly with a non-marked result, bypassing the
      // discriminator. The function should return null, not throw.
      const result = override.run({
        format: override.format,
        command: "context-pack",
        result: { notMarked: true },
      });
      assert.equal(result, null, `${override.format} renderer should return null for a non-marked result`);
    }
  } finally {
    await ext.deactivate();
  }
});

// --- BFS reverse-edge: unvisited node pointing to a frontier node (L472) ----

test("buildContextPack discovers reverse dependencies via BFS back-edges", () => {
  // pm-1 depends on pm-2 (forward edge). pm-3 also depends on pm-2 (reverse
  // edge from pm-3's perspective). At hop 1, pm-2 is in the frontier and pm-3
  // is unvisited, so the BFS back-edge check adds pm-3 as a neighbor.
  const items: PmItem[] = [
    { id: "pm-1", title: "Focus", type: "Task", status: "in_progress", priority: 1, dependencies: [{ id: "pm-2", kind: "depends_on" }] },
    { id: "pm-2", title: "Shared dep", type: "Task", status: "open", priority: 0 },
    { id: "pm-3", title: "Reverse dep", type: "Task", status: "open", priority: 0, dependencies: [{ id: "pm-2", kind: "depends_on" }] },
  ];
  const pack = buildContextPack(items, { ids: ["pm-1"], neighborhoodDepth: 2, generatedAt: "now" });
  assert.ok(pack.neighbors.some((item) => item.id === "pm-3"), "pm-3 should be discovered as a reverse neighbor");
});

// --- renderAgentHandoff: focus item without priority (L763 true arm) --------

test("renderAgentHandoff omits priority from focus metadata when absent", () => {
  const item: PmItem = { id: "pm-1", title: "No priority", type: "Task", status: "in_progress" };
  const pack = buildContextPack([item], { ids: ["pm-1"], generatedAt: "now" });
  const md = renderAgentHandoff(pack);
  const focusLine = md.split("\n").find((l) => l.includes("pm-1:")) ?? "";
  // The meta section is `(type | status | ...)`. When priority is absent, there
  // should be no `p<number>` segment — check by looking for the pattern `| p`.
  assert.equal(focusLine.includes("| p"), false, "focus line should not include priority segment when priority is absent");
});

// --- context-pack --explain --format json --compress (L1271 true arm) -------

test("context-pack --explain produces compressed json", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-pack-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-pack",
      pmRoot: initialized.path,
      options: { id: f.item.id, explain: true, format: "json", compress: true },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.equal(output.includes("\n\n"), false, "compressed json explain should have no blank lines");
    const parsed = JSON.parse(output) as { entries: Array<{ id: string }> };
    assert.ok(parsed.entries.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- context-handoff: default format (no --format given) (L1347 true arm) ---

test("context-handoff defaults to agent format when no --format is given", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-handoff-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const f = await create({ title: "F", id: "f", status: "in_progress", author: "test" }, { cwd: root });
    const runner = await harness();
    const result = await runner.runCommand({
      command: "context-handoff",
      pmRoot: initialized.path,
      options: { id: f.item.id },
      global: { json: false },
    });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output);
    assert.match(output, /^# pm agent handoff/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- toItemMetadata: items with tags exercise the tag mapper (L895) ----------

test("rankContextItems processes items with tags through toItemMetadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-context-rank-"));
  try {
    const initialized = await init("ctx", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root });
    const opts = await rankOptionsFrom(initialized.path);
    const items: PmItem[] = [
      { id: "pm-1", title: "A", type: "Task", status: "in_progress", priority: 1, tags: ["web", "release"], updated_at: "2026-07-01T00:00:00Z" },
      { id: "pm-2", title: "B", type: "Task", status: "in_progress", priority: 0, tags: ["api"], updated_at: "2026-07-02T00:00:00Z" },
    ];
    const ranked = rankContextItems(items, opts);
    assert.equal(ranked.length, 2);
    // Both items should be ranked (the tag mapper should not throw)
    assert.deepEqual(new Set(ranked.map((r) => r.id)), new Set(["pm-1", "pm-2"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Restored defensive guards (PR #52 rework) -------------------------------
// Each guard below was deleted by a prior pass to fake 100% coverage and has
// been restored. These tests drive the defensive arms directly so the gate
// measures them rather than deleting them.

test("renderedCommandResult appends a trailing newline when the producer omits it", () => {
  // Defensive arm of the ternary: render producers always terminate with "\n",
  // so this arm is only reachable by calling the helper with unterminated text.
  const withoutNewline = renderedCommandResult("no trailing newline");
  assert.equal(withoutNewline.output, "no trailing newline\n");
  assert.equal(withoutNewline.pmContextRendered, true);
  // Hot-path arm: already-terminated output is returned unchanged.
  const withNewline = renderedCommandResult("already terminated\n");
  assert.equal(withNewline.output, "already terminated\n");
});

test("markdownEscape coerces a nullish value to the empty string before escaping", () => {
  // Defensive arm of `value ?? ""`: every render caller passes a string
  // (titles are coerced upstream), so a nullish value only reaches this guard
  // through a direct call. The observable outcome is an empty, trimmed string.
  assert.equal(markdownEscape(undefined), "");
  assert.equal(markdownEscape(null), "");
  // Non-nullish values still round-trip with newlines flattened to spaces.
  assert.equal(markdownEscape("line one\nline two"), "line one line two");
});

test("byIdOrFail throws a descriptive CommandError when the id is absent", () => {
  // Defensive arm: `scoreContextItems` builds candidates from the same items
  // that key `byId`, so a miss is unreachable through that path. The guard still
  // converts a future mismatch into a clear, attributable error.
  const byId = new Map<string, PmItem>([["pm-1", { id: "pm-1", title: "A" }]]);
  assert.deepEqual(byIdOrFail(byId, "pm-1"), { id: "pm-1", title: "A" });
  assert.throws(
    () => byIdOrFail(byId, "pm-missing"),
    (err: unknown) => err instanceof CommandError && /relevance candidate pm-missing not found/.test(err.message),
    "a missing candidate id must raise a CommandError naming the id",
  );
});
