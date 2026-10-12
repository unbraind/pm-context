import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { commitImportedItem, createRelationshipKindRegistry, emptyImportedDocument, init, readSettings } from "@unbrained/pm-cli/sdk";
import type { ItemMetadata, RelationshipKindDefinition } from "@unbrained/pm-cli/sdk";
import { create } from "@unbrained/pm-cli/sdk/core";
import { buildContextPack, renderAgentHandoff, renderMarkdown } from "../index.ts";
import type { ContextPack, ContextPackDepInfo, PmItem } from "../index.ts";

/** Package root used to install the committed distribution into a disposable tracker. */
const packageRoot = resolve(import.meta.dirname, "..");

/** Extension definitions exercise both declared precedence directions and the SDK default. */
const customKinds = ([
  { kind: "custom_waits", aliases: ["custom_wait_alias"], ordering: true, precedence: "target_before_source" },
  { kind: "custom_gates", ordering: true, precedence: "source_before_target" },
  { kind: "custom_default", ordering: true },
  { kind: "custom_evidence", ordering: false },
] satisfies Array<Pick<RelationshipKindDefinition, "kind" | "aliases" | "ordering" | "precedence">>)
  .map<RelationshipKindDefinition>((definition) => ({
  direction: "directed", hierarchy: false, outgoing: "many", incoming: "many",
  lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false,
  ...definition,
}));

/** Expected direct dependency summaries for one edge from a to b. */
function expectedDeps(direction: "direct" | "inverse" | "none", prefix = ""): ContextPackDepInfo[] {
  if (direction === "none") return [];
  return direction === "direct"
    ? [{ itemId: `${prefix}a`, dependsOn: [`${prefix}b`], dependedBy: [] }, { itemId: `${prefix}b`, dependsOn: [], dependedBy: [`${prefix}a`] }]
    : [{ itemId: `${prefix}a`, dependsOn: [], dependedBy: [`${prefix}b`] }, { itemId: `${prefix}b`, dependsOn: [`${prefix}a`], dependedBy: [] }];
}

/** Single-edge cases include compatibility aliases and kinds with no registered ordering semantics. */
const cases = [
  { kind: "related", direction: "none" },
  { kind: "implements", direction: "none" },
  { kind: "blocked_by", direction: "direct" },
  { kind: "blocks", direction: "inverse" },
  { kind: "depends_on", direction: "direct" },
  { kind: "parent", direction: "none" },
  { kind: "recurs_from", direction: "none" },
  { kind: "unknown_kind", direction: "none" },
] as const;

for (const { kind, direction } of cases) {
  test(`public builder preserves ${kind} context and projects only its ordering semantics`, () => {
    const items: PmItem[] = [
      { id: "a", title: "Focus", type: "Task", status: "open", dependencies: [{ id: "b", kind }] },
      { id: "b", title: "Context", type: "Task", status: "open" },
    ];
    const before = JSON.stringify(items);
    const pack = buildContextPack(items, { ids: ["a"], includeDeps: true });
    assert.deepEqual(pack.deps, expectedDeps(direction));
    assert.deepEqual(pack.relationships, [{ from: "a", to: "b", kind }]);
    assert.deepEqual(pack.neighbors.map((item) => item.id), ["b"]);
    assert.equal(JSON.stringify(items), before);
    for (const output of [renderMarkdown(pack), renderAgentHandoff(pack)]) {
      if (direction === "none") assert.doesNotMatch(output, /depends_on \[b\]/);
      else if (direction === "inverse") assert.match(output, /a: depends_on \[\] \| depended_by \[b\]/);
      else assert.match(output, /a: depends_on \[b\] \| depended_by \[\]/);
    }
  });
}

test("public builder respects custom semantics, aliases, and unknown-kind context", () => {
  const registry = createRelationshipKindRegistry();
  for (const definition of customKinds) registry.register(definition);
  for (const [kind, direction] of [
    ["custom_waits", "direct"], ["custom_wait_alias", "direct"],
    ["custom_gates", "inverse"], ["custom_default", "inverse"],
    ["custom_evidence", "none"], ["unregistered_custom", "none"],
  ] as const) {
    const pack = buildContextPack([
      { id: "a", dependencies: [{ id: "b", kind }] }, { id: "b" },
    ], { ids: ["a"], includeDeps: true, relationshipRegistry: registry });
    assert.deepEqual(pack.deps, expectedDeps(direction), kind);
    assert.deepEqual(pack.relationships, [{ from: "a", to: "b", kind }]);
    assert.equal(pack.neighbors[0]?.id, "b");
  }
});

test("mixed edges deduplicate execution direction and retain dependencies outside the visible budget", () => {
  const items: PmItem[] = [
    { id: "a", dependencies: [
      { id: "b", kind: "blocked_by" }, { id: "b", kind: "related" },
      { id: "c", kind: "blocks" }, { id: "d", kind: "implements" },
      { id: "missing", kind: "blocked_by" },
    ] },
    { id: "b", dependencies: [{ id: "a", kind: "blocks" }] },
    { id: "c" }, { id: "d" },
  ];
  const before = JSON.stringify(items);
  const pack = buildContextPack(items, { ids: ["a"], includeDeps: true, maxItems: 1 });
  assert.deepEqual(pack.deps, [{ itemId: "a", dependsOn: ["b", "missing"], dependedBy: ["c"] }]);
  assert.equal(pack.relationships.length, 6);
  assert.deepEqual(pack.neighbors, []);
  assert.equal(JSON.stringify(items), before);
});

/** Capture stored item documents and complete history streams, excluding disposable runtime receipts. */
function storedBytes(pmRoot: string): Record<string, string> {
  const bytes: Record<string, string> = {};
  for (const folder of ["tasks", "history"]) {
    for (const name of readdirSync(join(pmRoot, folder))) {
      bytes[`${folder}/${name}`] = readFileSync(join(pmRoot, folder, name), "utf8");
    }
  }
  return bytes;
}

/** Initialize real SDK storage and install the built package through the host's project discovery layout. */
async function cliFixture(t: TestContext, custom = false) {
  const root = mkdtempSync(join(tmpdir(), "dependency-projection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = await init("deps", { defaults: true, author: "integration-test", agentGuidance: "skip" }, {
    cwd: root, pmRoot: join(root, ".agents", "pm"),
  });
  const extensionRoot = join(initialized.path, "extensions");
  mkdirSync(extensionRoot, { recursive: true });
  const installedRoot = join(extensionRoot, "pm-context");
  mkdirSync(installedRoot);
  cpSync(join(packageRoot, "manifest.json"), join(installedRoot, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(installedRoot, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(installedRoot, "node_modules"), "dir");
  if (custom) {
    const customRoot = join(extensionRoot, "custom-kinds");
    mkdirSync(customRoot);
    symlinkSync(join(packageRoot, "node_modules"), join(customRoot, "node_modules"), "dir");
    writeFileSync(join(customRoot, "manifest.json"), JSON.stringify({
      name: "custom-kinds", version: "1.0.0", entry: "index.ts", capabilities: ["schema"],
    }));
    writeFileSync(join(customRoot, "index.ts"), `import type { ExtensionApi } from "@unbrained/pm-cli/sdk";
export default { name: "custom-kinds", activate(api: ExtensionApi) {
  api.registerRelationshipKinds(${JSON.stringify(customKinds)});
} };
`);
  }
  const client = { cwd: root, pmRoot: initialized.path };
  /** Execute the real host CLI against the installed distribution and the isolated tracker. */
  function run(command: string, format: string): string {
    const result = spawnSync(process.execPath, [
      join(packageRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js"),
      command, "--id", "deps-a", "--include-deps", "--format", format,
    ], { cwd: root, encoding: "utf8", env: { ...process.env, PM_PATH: initialized.path, PM_AUTHOR: "integration-test" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  return { client, pmRoot: initialized.path, run };
}

for (const { kind, direction } of cases.slice(0, 4)) {
  test(`installed CLI JSON, Markdown and agent retain ${kind} without inventing prerequisites`, async (t) => {
    const f = await cliFixture(t);
    await create({ id: "b", title: "Context", author: "integration-test" }, f.client);
    await create({ id: "a", title: "Focus", dep: [`id=b,kind=${kind}`], author: "integration-test" }, f.client);
    const before = storedBytes(f.pmRoot);
    const pack = JSON.parse(f.run("context-pack", "json")) as ContextPack;
    assert.deepEqual(pack.deps, expectedDeps(direction, "deps-"));
    assert.deepEqual(pack.relationships, [{ from: "deps-a", to: "deps-b", kind }]);
    assert.deepEqual(pack.neighbors.map((item) => item.id), ["deps-b"]);
    for (const [command, format] of [
      ["context-pack", "markdown"], ["context-pack", "agent"], ["context-handoff", "agent"],
    ]) {
      const output = f.run(command, format);
      assert.match(output, /Context/);
      if (direction === "none") assert.doesNotMatch(output, /depends_on \[deps-b\]/);
      else if (direction === "inverse") assert.match(output, /deps-a: depends_on \[\] \| depended_by \[deps-b\]/);
      else assert.match(output, /deps-a: depends_on \[deps-b\] \| depended_by \[\]/);
    }
    const handoff = JSON.parse(f.run("context-handoff", "json")) as { deps: ContextPackDepInfo[] };
    assert.deepEqual(handoff.deps, expectedDeps(direction, "deps-"));
    assert.deepEqual(storedBytes(f.pmRoot), before);
  });
}

test("installed CLI mixed edges preserve raw kinds and use active extension ordering semantics", async (t) => {
  const f = await cliFixture(t, true);
  for (const id of ["b", "c", "d", "e"]) await create({ id, title: `Context ${id}`, author: "integration-test" }, f.client);
  const focus = await create({ id: "a", title: "Focus", author: "integration-test" }, f.client);
  // Import extension-owned metadata through the real SDK writer, including its audit history.
  const document = emptyImportedDocument();
  // SDK metadata types still enumerate built-ins; extension-owned imports carry registered string kinds.
  document.metadata = { ...focus.item, dependencies: [
    { id: "deps-b", kind: "custom_waits" }, { id: "deps-c", kind: "custom_gates" },
    { id: "deps-d", kind: "custom_evidence" }, { id: "deps-e", kind: "related" },
  ].map((edge) => ({ ...edge, created_at: focus.item.created_at, author: "integration-test" })) } as unknown as ItemMetadata;
  const imported = await commitImportedItem({
    pmRoot: f.pmRoot, id: focus.item.id, itemPath: join(f.pmRoot, "tasks", `${focus.item.id}.toon`),
    document, author: "integration-test", message: "Import custom relationship fixture",
    settings: await readSettings(f.pmRoot), conflictWarningPrefix: "fixture_conflict",
  });
  assert.equal(imported.committed, true);
  const before = storedBytes(f.pmRoot);
  const pack = JSON.parse(f.run("context-pack", "json")) as ContextPack;
  assert.deepEqual(pack.deps?.slice().sort((a, b) => a.itemId.localeCompare(b.itemId)), [
    { itemId: "deps-a", dependsOn: ["deps-b"], dependedBy: ["deps-c"] },
    { itemId: "deps-b", dependsOn: [], dependedBy: ["deps-a"] },
    { itemId: "deps-c", dependsOn: ["deps-a"], dependedBy: [] },
  ]);
  assert.deepEqual(pack.relationships, [
    { from: "deps-a", to: "deps-b", kind: "custom_waits" }, { from: "deps-a", to: "deps-c", kind: "custom_gates" },
    { from: "deps-a", to: "deps-d", kind: "custom_evidence" }, { from: "deps-a", to: "deps-e", kind: "related" },
  ]);
  assert.deepEqual(pack.neighbors.map((item) => item.id).sort(), ["deps-b", "deps-c", "deps-d", "deps-e"]);
  for (const [command, format] of [["context-pack", "markdown"], ["context-pack", "agent"], ["context-handoff", "agent"]]) {
    assert.match(f.run(command, format), /deps-a: depends_on \[deps-b\] \| depended_by \[deps-c\]/);
  }
  const handoff = JSON.parse(f.run("context-handoff", "json")) as { deps: ContextPackDepInfo[] };
  assert.deepEqual(handoff.deps, pack.deps);
  assert.deepEqual(storedBytes(f.pmRoot), before);
});
