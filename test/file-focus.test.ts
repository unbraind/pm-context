import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { init, readLocatedItem, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import { create } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildContextPack, buildAgentHandoff, type ContextPack } from "../index.ts";
import { FileFocusError, normalizeFocusPath, resolveFileFocus, readFileFocusItems } from "../file-focus.ts";

const packageRoot = resolve(import.meta.dirname, "..");

/** Run real Git with explicit fixture identity and no inherited routing. */
function git(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Snapshot every tracker byte, including runtime state, to detect read-side writes. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) for (const [path, bytes] of Object.entries(snapshot(join(root, entry.name)))) result[`${entry.name}/${path}`] = bytes;
    else result[entry.name] = createHash("sha256").update(readFileSync(join(root, entry.name))).digest("hex");
  }
  return result;
}

/** Real repository, tracker and installed distribution for parser-to-renderer acceptance. */
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "file-focus-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  mkdirSync(join(root, "src"));
  for (const path of ["src/one.ts", "src/two.ts", "old.ts"]) writeFileSync(join(root, path), "initial\n");
  writeFileSync(join(root, ".gitignore"), ".agents/\nignored.txt\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Base");
  git(root, "switch", "-c", "feature");
  const initialized = await init("focus", { defaults: true, author: "integration-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents", "pm") });
  git(root, "add", ".gitattributes", ".gitignore");
  git(root, "commit", "--amend", "--no-edit");
  git(root, "branch", "-f", "main", "HEAD");
  const client = { cwd: root, pmRoot: initialized.path };
  const one = await create({ id: "one", title: "First file", status: "in_progress", file: ["path=src/one.ts"], author: "integration-test" }, client);
  const two = await create({ id: "two", title: "Second file", status: "open", file: ["path=src/two.ts"], author: "integration-test" }, client);
  const installed = join(initialized.path, "extensions", "pm-context");
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-pack", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, PM_PATH: initialized.path, PM_SOURCE_WORKSPACE_ROOT: root, PM_SOURCE_PM_PATH: initialized.path, PM_AUTHOR: "integration-test" },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  return { root, pmRoot: initialized.path, client, one: one.item.id, two: two.item.id, run };
}

test("changed uses committed branch edits, index, worktree and untracked paths without writing the tracker", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "src/one.ts"), "branch edit\n");
  git(f.root, "add", "src/one.ts");
  git(f.root, "commit", "-m", "Branch edit");
  writeFileSync(join(f.root, "src/two.ts"), "staged\n");
  git(f.root, "add", "src/two.ts");
  writeFileSync(join(f.root, "src/two.ts"), "unstaged\n");
  writeFileSync(join(f.root, "unlinked.ts"), "new\n");
  writeFileSync(join(f.root, "ignored.txt"), "ignored\n");
  const before = snapshot(f.pmRoot);
  const pack = JSON.parse(f.run("--changed", "--format", "json")) as ContextPack;
  assert.deepEqual(pack.items.map((item) => item.id), [f.one, f.two]);
  assert.deepEqual(pack.items.map((item) => item.matched_files), [["src/one.ts"], ["src/two.ts"]]);
  assert.deepEqual(pack.unlinked_changed_files, ["unlinked.ts"]);
  assert.equal("context_receipt" in pack, false);
  for (const format of ["markdown", "agent", "compact"]) {
    for (const explain of [false, true]) {
      const output = f.run("--changed", "main", "--format", format, ...(explain ? ["--explain"] : []));
      assert.match(output, /matched_files: src\/one.ts/);
      assert.match(output, /unlinked_changed_files:/);
      assert.match(output, /unlinked.ts/);
      assert.match(output, /pm files <id> --add/);
      if (format !== "markdown" && !explain) assert.match(output, /--changed 'main'/);
    }
  }
  const explained = JSON.parse(f.run("--changed", "main", "--format", "json", "--explain")) as { entries: { id: string; matched_files: string[] }[]; unlinked_changed_files: string[] };
  assert.deepEqual(explained.entries.map((entry) => entry.id), [f.one, f.two]);
  assert.deepEqual(explained.entries[0]!.matched_files, ["src/one.ts"]);
  assert.deepEqual(explained.unlinked_changed_files, ["unlinked.ts"]);
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("explicit repeated files preserve commas and spaces, combine with status and limit, and retain unlinked truth", async (t) => {
  const f = await fixture(t);
  const pack = JSON.parse(f.run("--files", "src/one.ts", "--files", "src\\two.ts", "--files", "comma, space.ts", "--status", "open", "--limit", "1", "--format", "json")) as ContextPack;
  assert.deepEqual(pack.items.map((item) => item.id), [f.two]);
  assert.deepEqual(pack.unlinked_changed_files, ["comma, space.ts"]);
  const output = join(f.root, "pack.json");
  f.run("--files", "src/one.ts", "--format", "json", "--output", output);
  assert.deepEqual((JSON.parse(readFileSync(output, "utf8")) as ContextPack).items.map((item) => item.id), [f.one]);
  const refresh = f.run("--files", "src/one.ts", "--format", "agent");
  const filteredRefresh = f.run("--files", "src/one.ts", "--id", f.one, "--status", "in_progress", "--type", "Task", "--tag", "example", "--format", "agent");
  assert.match(filteredRefresh, /--status in_progress --type Task --tag example/);
  const idRefresh = f.run("--files", "src/one.ts", "--id", f.one, "--format", "agent");
  assert.match(idRefresh, /--id focus-one/);
  assert.match(refresh, /--files 'src\/one.ts'/);
});

test("linked directories rank by unique overlap before status and priority and preserve neighborhoods and budgets", async (t) => {
  const f = await fixture(t);
  const directory = await create({ id: "directory", title: "Directory", status: "blocked", priority: 4, file: ["path=./src/", "path=src/one.ts"], dep: [`id=${f.one},kind=blocked_by`], author: "integration-test" }, f.client);
  const args = ["--files", "src/one.ts", "--files", "src/two.ts", "--format", "json"];
  const pack = JSON.parse(f.run(...args, "--limit", "1")) as ContextPack;
  assert.deepEqual(pack.items.map((item) => item.id), [directory.item.id]);
  assert.deepEqual(pack.items[0]!.matched_files, ["src/one.ts", "src/two.ts"]);
  assert.deepEqual(pack.neighbors.map((item) => item.id), [f.one]);
  assert.deepEqual((JSON.parse(f.run(...args, "--max-items", "1")) as ContextPack).items.map((item) => item.id), [directory.item.id]);
  assert.deepEqual((JSON.parse(f.run(...args, "--limit", "1", "--neighborhood-depth", "0")) as ContextPack).neighbors, []);
  const explained = JSON.parse(f.run(...args, "--max-items", "1", "--explain")) as { entries: { id: string }[] };
  assert.deepEqual(explained.entries.map((entry) => entry.id), [directory.item.id]);
});

test("renames match both old and new linked paths and avoid directory-prefix false positives", async (t) => {
  const f = await fixture(t);
  const old = await create({ id: "old", title: "Old path", file: ["path=old.ts"], author: "integration-test" }, f.client);
  const moved = await create({ id: "moved", title: "New path", file: ["path=moved.ts"], author: "integration-test" }, f.client);
  await create({ id: "prefix", title: "Wrong prefix", file: ["path=sr"], author: "integration-test" }, f.client);
  renameSync(join(f.root, "old.ts"), join(f.root, "moved.ts"));
  git(f.root, "add", "old.ts", "moved.ts");
  const pack = JSON.parse(f.run("--changed", "main", "--files", "src/one.ts", "--format", "json")) as ContextPack;
  assert.deepEqual(new Set(pack.items.map((item) => item.id)), new Set([f.one, old.item.id, moved.item.id]));
  assert.deepEqual(pack.unlinked_changed_files, []);
});

test("default base honors origin/HEAD, falls back to main and finds changes from a subdirectory", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(resolveFileFocus({ changed: true }, [], f.root)!.files, []);
  writeFileSync(join(f.root, "src/one.ts"), "edit\n");
  git(f.root, "add", "src/one.ts");
  git(f.root, "commit", "-m", "Feature");
  git(f.root, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  git(f.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.deepEqual(resolveFileFocus({ changed: true }, [], join(f.root, "src"))!.files, []);
  assert.deepEqual(resolveFileFocus({ changed: "main" }, [], f.root)!.files, ["src/one.ts"]);
});

test("Git routing environment cannot redirect discovery or index reads", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "src/one.ts"), "edit\n");
  const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = join(f.root, "missing");
    assert.deepEqual(resolveFileFocus({ changed: true }, [], f.root)!.files, ["src/one.ts"]);
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});

test("file focus returns actionable typed errors for non-Git, unknown bases, invalid paths and unreadable index", async (t) => {
  const f = await fixture(t);
  const outside = mkdtempSync(join(tmpdir(), "non-git-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const [options, args, cwd, code] of [
    [{ changed: true }, [], outside, "NOT_GIT_REPOSITORY"],
    [{ files: "src/one.ts" }, [], outside, "NOT_GIT_REPOSITORY"],
    [{ changed: "missing-branch" }, [], f.root, "UNKNOWN_BASE"],
    [{ changed: "--help" }, [], f.root, "UNKNOWN_BASE"],
    [{ files: "../escape" }, [], f.root, "INVALID_FILE_FOCUS"],
    [{}, ["main"], f.root, "INVALID_FILE_FOCUS"],
    [{ files: "src/one.ts" }, ["main"], f.root, "INVALID_FILE_FOCUS"],
    [{ changed: true }, ["main", "extra"], f.root, "INVALID_FILE_FOCUS"],
  ] as const) {
    assert.throws(() => resolveFileFocus(options, [...args], cwd), (error: unknown) => error instanceof FileFocusError && error.exitCode === 2 && error.code === code);
  }
  const failure = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-pack", "--changed", "missing-branch"], { cwd: f.root, encoding: "utf8", env: { ...process.env, PM_PATH: f.pmRoot, PM_SOURCE_WORKSPACE_ROOT: f.root, PM_SOURCE_PM_PATH: f.pmRoot } });
  assert.equal(failure.status, 2, failure.stdout + failure.stderr);
  assert.match(failure.stdout + failure.stderr, /known-base/);
  writeFileSync(join(f.root, ".git/index"), "corrupt");
  assert.throws(() => resolveFileFocus({ changed: true }, [], f.root), (error: unknown) => error instanceof FileFocusError && error.code === "GIT_FAILED");
});

test("path normalization supports native absolute paths, Windows roots, containment and invalid links", () => {
  for (const [path, root, expected] of [
    ["./src/../src/one.ts", "/repo", "src/one.ts"], ["/repo/src/one.ts", "/repo", "src/one.ts"],
    ["C:\\repo\\src\\one.ts", "C:\\repo", "src/one.ts"], ["D:\\elsewhere\\one.ts", "C:\\repo", undefined],
    ["../outside", "/repo", undefined], ["..", "/repo", undefined], ["https://example.invalid/file", "/repo", undefined],
    ["", "/repo", undefined], ["src\\one.ts", "/repo", "src/one.ts"], [".", "/repo", "."],
  ]) assert.equal(normalizeFocusPath(path!, root!), expected);
});

test("empty focus stays empty and ranking uses status, priority and deterministic ties", () => {
  const items = [
    { id: "z", status: "closed", priority: 0 }, { id: "b", status: "open", priority: 2 },
    { id: "a", status: "open", priority: 2 }, { id: "high", status: "open", priority: 0 },
    { id: "active", status: "in_progress", priority: 4 }, { id: "blocked", status: "blocked" },
    { id: "unknown", status: "custom" }, { id: "unknown2" },
  ].map((item) => ({ ...item, files: ["."] }));
  const fileFocus = { root: "/repo", files: ["src/a.ts"], refresh: "" };
  assert.deepEqual(buildContextPack(items, { fileFocus, includeClosed: true }).items.map((item) => item.id), ["active", "high", "a", "b", "blocked", "z", "unknown", "unknown2"]);
  assert.equal(buildContextPack(items, { fileFocus: { ...fileFocus, files: [] } }).items.length, 0);
  assert.equal(buildContextPack(items, { ids: ["a", "blocked"], status: "open", fileFocus }).items.length, 1);
  assert.deepEqual(buildAgentHandoff(buildContextPack(items, { fileFocus })).focus[0]!.matched_files, ["src/a.ts"]);
});

test("command uses source workspace and cwd fallbacks with file selectors", async (t) => {
  const f = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
  assert.equal(resolveFileFocus({ changed: false }, [], f.root), undefined);
  assert.ok(resolveFileFocus({ files: ["it's.ts"] }, [], f.root)!.refresh.includes("'\\''"));
  const previous = process.cwd();
  try {
    process.chdir(f.root);
    const output = await harness.runCommand({ command: "context-pack", pmRoot: f.pmRoot, options: { files: ["src/one.ts"], format: "json" }, global: { json: false } });
    assert.ok(output);
  } finally { process.chdir(previous); }
});


test("read-only SDK enumeration supports markdown, skips non-items and fails closed on corrupt or duplicate items", async (t) => {
  const f = await fixture(t);
  const itemPath = join(f.pmRoot, "tasks", `${f.one}.toon`);
  const { document } = await readLocatedItem({ id: f.one, type: "Task", itemPath, item_format: "toon" });
  const markdownPath = join(f.pmRoot, "tasks", `${f.one}.md`);
  writeFileSync(markdownPath, serializeItemDocument(document, { format: "json_markdown" }));
  await assert.rejects(readFileFocusItems(f.pmRoot), (error: unknown) => error instanceof FileFocusError && error.code === "TRACKER_READ_FAILED");
  rmSync(itemPath);
  mkdirSync(join(f.pmRoot, "tasks", "nested"));
  writeFileSync(join(f.pmRoot, "tasks", "ignored.txt"), "not an item");
  assert.deepEqual(new Set((await readFileFocusItems(f.pmRoot)).map((item) => item.id)), new Set([f.one, f.two]));
  writeFileSync(markdownPath, "not a valid item document");
  await assert.rejects(readFileFocusItems(f.pmRoot), FileFocusError);
  rmSync(join(f.pmRoot, "tasks"), { recursive: true });
  writeFileSync(join(f.pmRoot, "tasks"), "not a directory");
  await assert.rejects(readFileFocusItems(f.pmRoot), FileFocusError);
  rmSync(join(f.pmRoot, "tasks"));
  assert.deepEqual(await readFileFocusItems(f.pmRoot), []);
});


test("merge-base excludes base-only commits and retains staged reversions absent from the net diff", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "src/one.ts"), "branch edit\n");
  git(f.root, "add", "src/one.ts");
  git(f.root, "commit", "-m", "Feature");
  git(f.root, "switch", "main");
  writeFileSync(join(f.root, "base-only.ts"), "base only\n");
  git(f.root, "add", "base-only.ts");
  git(f.root, "commit", "-m", "Base moves independently");
  git(f.root, "switch", "feature");
  writeFileSync(join(f.root, "src/one.ts"), "initial\n");
  git(f.root, "add", "src/one.ts");
  writeFileSync(join(f.root, "src/two.ts"), "unstaged\n");
  assert.deepEqual(resolveFileFocus({ changed: true }, [], f.root)!.files, ["src/one.ts", "src/two.ts"]);
});

test("source command preserves file reasons, explanations, filters, refreshes and output writes across portable roots", async (t) => {
  const f = await fixture(t);
  await create({ id: "directory", title: "Directory", status: "blocked", file: ["path=src", "path=https://example.invalid/no", "path=../outside"], dep: [`id=${f.one},kind=blocked_by`, `id=${f.two},kind=blocked_by`], author: "integration-test" }, f.client);
  const harness = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
  const handler = harness.activation.commands.handlers.find((entry) => entry.command === "context-pack")!;
  const before = snapshot(f.pmRoot);
  for (const portable of [{ repo_root: f.root }, { source_workspace_root: f.root }]) {
    for (const format of ["json", "markdown", "agent", "compact"]) {
      for (const explain of [false, true]) {
        const result = await handler.run({ command: "context-pack", args: [], options: { files: ["src/one.ts", "missing.ts"], format, explain, compress: true }, pm_root: f.pmRoot, global: { json: false }, ...portable }) as { output: string };
        assert.match(result.output, /matched_files/);
        assert.match(result.output, /unlinked_changed_files/);
        assert.match(result.output, /missing.ts/);
      }
    }
  }
  for (const explain of [false, true]) {
    const output = join(f.root, `output-${explain}.json`);
    await handler.run({ command: "context-pack", args: [], options: { files: ["src/one.ts"], format: "json", explain, output, maxItems: "1" }, pm_root: f.pmRoot, repo_root: f.root, global: { json: false } });
    assert.match(readFileSync(output, "utf8"), /matched_files/);
  }
  for (const filters of [{}, { status: "in_progress", type: "Task", tag: "example" }]) {
    await handler.run({ command: "context-pack", args: [], options: { files: ["src/one.ts"], id: f.one, format: "agent", ...filters }, pm_root: f.pmRoot, repo_root: f.root, global: { json: false } });
  }
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("installed CLI includes type folders contributed by real extensions without tracker writes", async (t) => {
  const f = await fixture(t);
  const custom = join(f.pmRoot, "extensions", "focus-types");
  mkdirSync(custom);
  writeFileSync(join(custom, "manifest.json"), JSON.stringify({ name: "focus-types", version: "1.0.0", entry: "index.ts", capabilities: ["schema"] }));
  writeFileSync(join(custom, "index.ts"), `import type { ExtensionApi } from "@unbrained/pm-cli/sdk"; export default { name: "focus-types", activate(api: ExtensionApi) { api.registerItemTypes([{ name: "FocusCase", folder: "focus-cases" }]); } };`);
  const created = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "create", "FocusCase", "Custom linked item", "--create-mode", "progressive", "--file", "path=src/one.ts", "--json"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, PM_PATH: f.pmRoot, PM_SOURCE_WORKSPACE_ROOT: f.root, PM_SOURCE_PM_PATH: f.pmRoot, PM_AUTHOR: "integration-test" },
  });
  assert.equal(created.status, 0, created.stderr + created.stdout);
  const id = (JSON.parse(created.stdout) as { id: string }).id;
  const before = snapshot(f.pmRoot);
  const pack = JSON.parse(f.run("--files", "src/one.ts", "--format", "json")) as ContextPack;
  assert.ok(pack.items.some((item) => item.id === id && item.type === "FocusCase"));
  assert.deepEqual(snapshot(f.pmRoot), before);
});
