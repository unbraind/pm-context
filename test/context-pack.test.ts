import assert from "node:assert/strict";
import test from "node:test";
import extension, { buildContextPack, extractRelationships, renderMarkdown, sortContextItems } from "../dist/index.js";

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
  assert.equal(commands[0]?.name, "context-pack");
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
