import assert from "node:assert/strict";
import test from "node:test";
import extension, {
  buildSuggestedAgentCommand,
  buildAgentHandoff,
  buildContextPack,
  extractRelationships,
  MAX_NEIGHBORHOOD_DEPTH,
  resolveSelectionOptions,
  renderAgentHandoff,
  renderMarkdown,
  sortContextItems,
} from "../dist/index.js";

const items = [
  {
    id: "pm-1",
    title: "Build context dashboard",
    type: "Feature",
    status: "in_progress",
    priority: 1,
    tags: ["context", "web"],
    body: "A body that should only appear when requested.",
    updated_at: "2026-06-06T09:00:00Z",
    dependencies: [{ id: "pm-2", kind: "blocked_by" }],
    docs: [{ path: "docs/context.md" }],
  },
  {
    id: "pm-2",
    title: "Normalize source data",
    type: "Task",
    status: "open",
    priority: 0,
    tags: ["data"],
    updated_at: "2026-06-06T10:00:00Z",
  },
  {
    id: "pm-3",
    title: "Already shipped",
    type: "Task",
    status: "closed",
    priority: 0,
    tags: ["context"],
    files: ["src/context.ts"],
  },
];

test("extension has required shape", () => {
  assert.equal(extension.name, "pm-context");
  assert.equal(typeof extension.activate, "function");
});

test("activate registers context-pack command", () => {
  const commands: Array<Record<string, unknown>> = [];
  extension.activate({ registerCommand(command: Record<string, unknown>) { commands.push(command); } });
  assert.deepEqual(commands.map((command) => command.name), ["context-pack", "context-handoff"]);
});

test("activate exposes selector aliases for both commands", () => {
  const commands: Array<Record<string, unknown>> = [];
  extension.activate({ registerCommand(command: Record<string, unknown>) { commands.push(command); } });
  const byName = new Map(commands.map((command) => [command.name, command]));
  const packFlags = ((byName.get("context-pack") as { flags: Array<{ long: string }> } | undefined)?.flags ?? [])
    .map((flag) => flag.long);
  const handoffFlags = ((byName.get("context-handoff") as { flags: Array<{ long: string }> } | undefined)?.flags ?? [])
    .map((flag) => flag.long);
  for (const requiredFlag of ["--id", "--ids", "--status", "--state", "--type", "--kind"]) {
    assert.equal(packFlags.includes(requiredFlag), true, `context-pack missing ${requiredFlag}`);
    assert.equal(handoffFlags.includes(requiredFlag), true, `context-handoff missing ${requiredFlag}`);
  }
});

test("resolveSelectionOptions defaults handoff selection to in_progress", () => {
  assert.deepEqual(
    resolveSelectionOptions({}, { fallbackStatus: "in_progress" }),
    { ids: [], status: "in_progress", type: undefined, tag: undefined, inferredStatus: true },
  );
});

test("resolveSelectionOptions preserves explicit selectors without fallback", () => {
  assert.deepEqual(
    resolveSelectionOptions({ id: ["pm-1"], status: "blocked", tag: "release" }, { fallbackStatus: "in_progress" }),
    { ids: ["pm-1"], status: "blocked", type: undefined, tag: "release", inferredStatus: false },
  );
});

test("resolveSelectionOptions accepts selector aliases and deduplicates ids", () => {
  assert.deepEqual(
    resolveSelectionOptions({ ids: "pm-1, pm-2,pm-1", state: "blocked", kind: "Feature" }),
    { ids: ["pm-1", "pm-2"], status: "blocked", type: "Feature", tag: undefined, inferredStatus: false },
  );
});

test("buildSuggestedAgentCommand keeps context-pack refresh concise but reproducible", () => {
  const command = buildSuggestedAgentCommand({
    commandName: "context-pack",
    selection: { ids: ["pm-1", "pm-2"], status: undefined, type: undefined, tag: undefined, inferredStatus: false },
    limit: 40,
    defaultLimit: 25,
    recentLimit: 8,
    defaultRecentLimit: 5,
    includeClosed: true,
    neighborhood: false,
    neighborhoodDepth: 0,
    includeFormatFlag: true,
  });
  assert.equal(command, "pm context-pack --ids pm-1,pm-2 --format agent --limit 40 --recent 8 --include-closed --without-neighborhood");
});

test("buildSuggestedAgentCommand keeps single-id refresh commands unchanged", () => {
  const command = buildSuggestedAgentCommand({
    commandName: "context-pack",
    selection: { ids: ["pm-1"], status: undefined, type: undefined, tag: undefined, inferredStatus: false },
    limit: 25,
    defaultLimit: 25,
    recentLimit: 5,
    defaultRecentLimit: 5,
    includeClosed: false,
    neighborhood: true,
    neighborhoodDepth: 1,
    includeFormatFlag: true,
  });
  assert.equal(command, "pm context-pack --id pm-1 --format agent");
});

test("buildSuggestedAgentCommand includes inferred in_progress for context-handoff", () => {
  const command = buildSuggestedAgentCommand({
    commandName: "context-handoff",
    selection: { ids: [], status: "in_progress", type: undefined, tag: undefined, inferredStatus: true },
    limit: 12,
    defaultLimit: 12,
    recentLimit: 5,
    defaultRecentLimit: 5,
    includeClosed: false,
    neighborhood: true,
    neighborhoodDepth: 2,
  });
  assert.equal(command, "pm context-handoff --status in_progress --neighborhood-depth 2");
});

test("extractRelationships normalizes supported dependency shapes", () => {
  assert.deepEqual(extractRelationships({
    id: "a",
    deps: ["b"],
    blocked_by: "c,d",
    dependencies: [{ target_id: "e", type: "relates_to" }],
  }), [
    { from: "a", to: "b", kind: "depends_on" },
    { from: "a", to: "e", kind: "relates_to" },
    { from: "a", to: "c", kind: "blocked_by" },
    { from: "a", to: "d", kind: "blocked_by" },
  ]);
});

test("buildContextPack filters selected items and adds dependency neighbors", () => {
  const pack = buildContextPack(items, { ids: ["pm-1"], includeBody: true, generatedAt: "now" });
  assert.equal(pack.summary.selectedItems, 1);
  assert.equal(pack.summary.neighborItems, 1);
  assert.equal(pack.items[0]?.id, "pm-1");
  assert.equal(pack.neighbors[0]?.id, "pm-2");
  assert.equal(pack.relationships[0]?.to, "pm-2");
  assert.deepEqual(pack.links, [{ itemId: "pm-1", kind: "doc", value: "docs/context.md" }]);
});

const chainItems = [
  {
    id: "pm-1",
    title: "Focus",
    type: "Feature",
    status: "in_progress",
    priority: 1,
    updated_at: "2026-06-06T09:00:00Z",
    dependencies: [{ id: "pm-2", kind: "depends_on" }],
  },
  {
    id: "pm-2",
    title: "Direct neighbor",
    type: "Task",
    status: "open",
    priority: 0,
    updated_at: "2026-06-06T10:00:00Z",
    dependencies: [{ id: "pm-4", kind: "depends_on" }],
  },
  {
    id: "pm-4",
    title: "Neighbor of a neighbor",
    type: "Task",
    status: "open",
    priority: 0,
    updated_at: "2026-06-06T11:00:00Z",
  },
  {
    id: "pm-5",
    title: "Unrelated",
    type: "Task",
    status: "open",
    priority: 0,
    updated_at: "2026-06-06T12:00:00Z",
  },
];

test("buildContextPack depth 1 (explicit) is byte-identical to the legacy default", () => {
  const legacy = JSON.stringify(buildContextPack(chainItems, { ids: ["pm-1"], includeBody: true, generatedAt: "now" }));
  const depth1 = JSON.stringify(buildContextPack(chainItems, { ids: ["pm-1"], includeBody: true, generatedAt: "now", neighborhoodDepth: 1 }));
  assert.equal(depth1, legacy);
});

test("buildContextPack renderMarkdown is byte-identical at depth 1 vs default", () => {
  const legacy = renderMarkdown(buildContextPack(chainItems, { ids: ["pm-1"], includeBody: true, generatedAt: "now" }));
  const depth1 = renderMarkdown(buildContextPack(chainItems, { ids: ["pm-1"], includeBody: true, generatedAt: "now", neighborhoodDepth: 1 }));
  assert.equal(depth1, legacy);
});

test("buildContextPack depth 1 includes only direct neighbors", () => {
  const pack = buildContextPack(chainItems, { ids: ["pm-1"], neighborhoodDepth: 1, generatedAt: "now" });
  assert.deepEqual(pack.neighbors.map((item) => item.id), ["pm-2"]);
  assert.equal(pack.summary.neighborItems, 1);
});

test("buildContextPack depth 2 pulls a neighbor-of-a-neighbor that depth 1 omits", () => {
  const depth1 = buildContextPack(chainItems, { ids: ["pm-1"], neighborhoodDepth: 1, generatedAt: "now" });
  assert.equal(depth1.neighbors.some((item) => item.id === "pm-4"), false);
  const depth2 = buildContextPack(chainItems, { ids: ["pm-1"], neighborhoodDepth: 2, generatedAt: "now" });
  assert.deepEqual(depth2.neighbors.map((item) => item.id).sort(), ["pm-2", "pm-4"]);
  assert.equal(depth2.summary.neighborItems, 2);
});

test("buildContextPack depth 0 omits all neighbors like --without-neighborhood", () => {
  const depthZero = buildContextPack(chainItems, { ids: ["pm-1"], neighborhoodDepth: 0, generatedAt: "now" });
  const without = buildContextPack(chainItems, { ids: ["pm-1"], neighborhood: false, generatedAt: "now" });
  assert.equal(depthZero.neighbors.length, 0);
  assert.equal(depthZero.filters.neighborhood, false);
  assert.equal(JSON.stringify(depthZero), JSON.stringify(without));
});

test("buildContextPack caps neighborhood depth at MAX_NEIGHBORHOOD_DEPTH", () => {
  const capped = buildContextPack(chainItems, { ids: ["pm-1"], neighborhoodDepth: 999, generatedAt: "now" });
  // With a 2-hop chain, both transitive neighbors are reached; cap just bounds traversal.
  assert.deepEqual(capped.neighbors.map((item) => item.id).sort(), ["pm-2", "pm-4"]);
  assert.equal(MAX_NEIGHBORHOOD_DEPTH, 5);
});

test("buildContextPack never includes a focus item as its own neighbor", () => {
  // pm-1 and pm-2 are both focus; the pm-1<->pm-2 edge must not make either a neighbor.
  const pack = buildContextPack(chainItems, { ids: ["pm-1", "pm-2"], neighborhoodDepth: 3, generatedAt: "now" });
  const focusIds = new Set(pack.items.map((item) => item.id));
  for (const neighbor of pack.neighbors) {
    assert.equal(focusIds.has(neighbor.id), false, `${neighbor.id} should not be both focus and neighbor`);
  }
  assert.deepEqual(pack.neighbors.map((item) => item.id), ["pm-4"]);
});

test("buildContextPack excludes closed items by default but can include them", () => {
  assert.deepEqual(buildContextPack(items, { tag: "context", generatedAt: "now" }).items.map((item) => item.id), ["pm-1"]);
  assert.deepEqual(buildContextPack(items, { tag: "context", includeClosed: true, generatedAt: "now" }).items.map((item) => item.id), ["pm-3", "pm-1"]);
});

test("buildContextPack strips body unless includeBody is true", () => {
  assert.equal(buildContextPack(items, { ids: ["pm-1"], generatedAt: "now" }).items[0]?.body, undefined);
  assert.equal(buildContextPack(items, { ids: ["pm-1"], includeBody: true, generatedAt: "now" }).items[0]?.body, items[0].body);
});

test("sortContextItems orders by priority then updated time", () => {
  assert.deepEqual(sortContextItems(items).map((item) => item.id), ["pm-2", "pm-3", "pm-1"]);
});

test("renderMarkdown includes summary, relationships and optional bodies", () => {
  const markdown = renderMarkdown(buildContextPack(items, { ids: ["pm-1"], includeBody: true, generatedAt: "now" }));
  assert.match(markdown, /^# pm context pack/);
  assert.match(markdown, /Focus items: 1/);
  assert.match(markdown, /pm-1 --blocked_by--> pm-2/);
  assert.match(markdown, /A body that should only appear/);
});

test("buildAgentHandoff extracts compact focus, blockers, next actions and refresh command", () => {
  const handoff = buildAgentHandoff(buildContextPack(items, { ids: ["pm-1"], generatedAt: "now" }), { recentLimit: 1 });
  assert.equal(handoff.counts.focus, 1);
  assert.equal(handoff.counts.blockers, 1);
  assert.equal(handoff.counts.recent, 1);
  assert.deepEqual(handoff.focus.map((item) => item.id), ["pm-1"]);
  assert.deepEqual(handoff.blockers, [{
    itemId: "pm-1",
    blockedBy: "pm-2",
    kind: "blocked_by",
    title: "Normalize source data",
    status: "open",
  }]);
  assert.deepEqual(handoff.nextActions, [{
    id: "pm-1",
    title: "Build context dashboard",
    reason: "resolve blocker first",
  }]);
  assert.deepEqual(handoff.recent, [{
    id: "pm-2",
    title: "Normalize source data",
    status: "open",
    updatedAt: "2026-06-06T10:00:00Z",
  }]);
  assert.equal(handoff.suggestedCommand, "pm context-pack --id pm-1 --format agent");
});

test("buildAgentHandoff honors explicit suggested refresh command", () => {
  const handoff = buildAgentHandoff(
    buildContextPack(items, { ids: ["pm-1"], generatedAt: "now" }),
    { suggestedCommand: "pm context-handoff --id pm-1" },
  );
  assert.equal(handoff.suggestedCommand, "pm context-handoff --id pm-1");
});

test("renderAgentHandoff emits token-compact agent sections", () => {
  const markdown = renderAgentHandoff(buildContextPack(items, { ids: ["pm-1"], generatedAt: "now" }));
  assert.match(markdown, /^# pm agent handoff/);
  assert.match(markdown, /Focus: 1 \| Neighbors: 1 \| Blockers: 1 \| Links: 1 \| Recent: 2/);
  assert.match(markdown, /pm-1 blocked_by pm-2 Normalize source data \(open\)/);
  assert.match(markdown, /pm-1: Build context dashboard - resolve blocker first/);
  assert.match(markdown, /## Recent Activity/);
  assert.match(markdown, /pm-2: Normalize source data \(open\) - updated 2026-06-06T10:00:00Z/);
  assert.match(markdown, /`pm context-pack --id pm-1 --format agent`/);
});
