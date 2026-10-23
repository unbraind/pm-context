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
import extension, { buildContextPack, buildAgentHandoff, createSdkPacker, type ContextPack } from "../index.ts";
import { FileFocusError, isTrackerPath, normalizeFocusPath, resolveFileFocus, readFileFocusItems } from "../file-focus.ts";

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
async function fixture(t: TestContext, trackerPath = ".agents/pm", rootSuffix = "") {
  const parent = mkdtempSync(join(tmpdir(), "file-focus-"));
  let root = join(parent, "project");
  mkdirSync(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  mkdirSync(join(root, "src"));
  for (const path of ["src/one.ts", "src/two.ts", "old.ts"]) writeFileSync(join(root, path), "initial\n");
  writeFileSync(join(root, ".gitignore"), ".agents/\nignored.txt\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Base");
  git(root, "switch", "-c", "feature");
  const initialized = await init("focus", { defaults: true, author: "integration-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, trackerPath) });
  let pmRoot = initialized.path;
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
  // Initialize through the real SDK before renaming: its Git setup also trims roots.
  if (rootSuffix) {
    renameSync(root, `${root}${rootSuffix}`);
    root += rootSuffix;
    pmRoot = join(root, trackerPath);
    client.cwd = root;
    client.pmRoot = pmRoot;
  }
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-pack", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, PM_PATH: pmRoot, PM_SOURCE_WORKSPACE_ROOT: root, PM_SOURCE_PM_PATH: pmRoot, PM_AUTHOR: "integration-test" },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  return { root, pmRoot, client, one: one.item.id, two: two.item.id, run };
}

test("trailing-whitespace roots preserve exact helper paths across same-repository renames", async (t) => {
  for (const suffix of [" ", "\t", "\n"]) {
    const f = await fixture(t, ".agents/pm", suffix);
    writeFileSync(join(f.root, "src/one.ts"), "changed\n");
    const focus = resolveFileFocus({ changed: "main" }, [], f.root, f.pmRoot)!;
    assert.equal(focus.root, f.root);
    assert.deepEqual(focus.files, ["src/one.ts"]);
    const head = git(f.root, "rev-parse", "HEAD");
    const renamed = `${f.root}ordinary`;
    renameSync(f.root, renamed);
    assert.equal(git(renamed, "rev-parse", "HEAD"), head);
    const control = resolveFileFocus({ changed: "main" }, [], renamed, join(renamed, ".agents/pm"))!;
    assert.deepEqual(control.files, focus.files);
    assert.equal(control.root, renamed);
  }
});

test("trailing-whitespace roots work through the installed CLI with changed and explicit files", async (t) => {
  const f = await fixture(t, ".agents/pm", " ");
  writeFileSync(join(f.root, "src/one.ts"), "changed\n");
  assert.ok((JSON.parse(f.run("--format", "json")) as ContextPack).items.length > 0);
  const before = snapshot(f.pmRoot);
  for (const selector of [["--changed", "main"], ["--files", "src/one.ts"]]) {
    const pack = JSON.parse(f.run(...selector, "--format", "json")) as ContextPack;
    assert.deepEqual(pack.items.map((item) => item.id), [f.one]);
    assert.deepEqual(pack.items[0]!.matched_files, ["src/one.ts"]);
  }
  assert.deepEqual(snapshot(f.pmRoot), before);
});

test("equal-cost capped packing preserves highest overlap despite opposite corpus ranks", () => {
  const best = { id: "focus-best-000", title: "X".repeat(100), type: "Task", status: "open", priority: 4, files: ["src"] };
  const next = Array.from({ length: 8 }, (_, index) => ({
    ...best, id: `focus-next-00${index}`, priority: 0, files: ["src/a.ts"],
  }));
  const corpusOrder = [...next, best];
  const pack = buildContextPack([best, ...next], {
    fileFocus: { root: "/repo", files: ["src/a.ts", "src/b.ts"], refresh: "" },
    neighborhood: false, maxItems: 1, packer: createSdkPacker(corpusOrder, corpusOrder),
  });
  assert.deepEqual(pack.items.map((item) => item.id), [best.id]);
});

test("equal-cost capped packing resolves overlap ties by lifecycle, priority, then id", () => {
  for (const [bestStatus, bestPriority, nextStatus, nextPriority] of [
    ["in_progress", 4, "open", 0], ["open", 0, "open", 4], ["open", 2, "open", 2],
  ] as const) {
    const best = { id: "focus-best-000", title: "X".repeat(100), type: "Task", status: bestStatus, priority: bestPriority, files: ["src"] };
    const next = Array.from({ length: 8 }, (_, index) => ({
      ...best, id: `focus-next-00${index}`, status: nextStatus, priority: nextPriority,
    })).reverse();
    const corpusOrder = [...next, best];
    const pack = buildContextPack(corpusOrder, {
      fileFocus: { root: "/repo", files: ["src/a.ts"], refresh: "" },
      neighborhood: false, maxItems: 1, packer: createSdkPacker(corpusOrder, corpusOrder),
    });
    assert.deepEqual(pack.items.map((item) => item.id), [best.id]);
  }
});

test("capped tracker-only packs work without git and file focus reports its requirement", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "context-no-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = await init("focus", { defaults: true, author: "integration-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const item = await create({ id: "one", title: "Portable work", author: "integration-test" }, { cwd: root, pmRoot: initialized.path });
  const installed = join(initialized.path, "extensions", "pm-context");
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const emptyPath = join(root, "empty-bin");
  mkdirSync(emptyPath);
  const run = (...args: string[]) => spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-pack", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, PM_PATH: initialized.path, PM_SOURCE_WORKSPACE_ROOT: root, PM_SOURCE_PM_PATH: initialized.path, PATH: emptyPath, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  const packed = run("--max-items", "1", "--format", "json");
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  assert.deepEqual((JSON.parse(packed.stdout) as ContextPack).items.map((entry) => entry.id), [item.item.id]);
  const changed = run("--changed", "main");
  assert.equal(changed.status, 2);
  assert.match(changed.stdout + changed.stderr, /File focus requires a Git working repository/);
});

test("equal-cost capped packing keeps highest overlap through installed CLI and explain", async (t) => {
  const f = await fixture(t);
  const best = await create({ id: "best-000", title: "X".repeat(100), status: "open", priority: 4, file: ["path=src"], author: "integration-test" }, f.client);
  for (let index = 0; index < 8; index += 1) {
    await create({ id: `next-00${index}`, title: "X".repeat(100), status: "open", priority: 0, file: ["path=src/a.ts"], author: "integration-test" }, f.client);
  }
  const args = ["--files", "src/a.ts", "--files", "src/b.ts", "--without-neighborhood", "--format", "json"];
  const uncapped = JSON.parse(f.run(...args)) as ContextPack;
  assert.equal(uncapped.items[0]!.id, best.item.id);
  assert.equal(uncapped.items.length, 9);
  for (const control of [["--id", best.item.id], ["--limit", "1"]]) {
    assert.deepEqual((JSON.parse(f.run(...args, "--max-items", "1", ...control)) as ContextPack).items.map((item) => item.id), [best.item.id]);
  }
  const pack = JSON.parse(f.run(...args, "--max-items", "1")) as ContextPack;
  assert.deepEqual(pack.items.map((item) => item.id), [best.item.id]);
  assert.deepEqual(pack.items[0]!.matched_files, ["src/a.ts", "src/b.ts"]);
  const explained = JSON.parse(f.run(...args, "--max-items", "1", "--explain")) as { entries: { id: string; matched_files: string[] }[] };
  assert.deepEqual(explained.entries.map((entry) => entry.id), [best.item.id]);
  assert.deepEqual(explained.entries[0]!.matched_files, pack.items[0]!.matched_files);
});

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
  assert.deepEqual(resolveFileFocus({ changed: true }, [], f.root, f.pmRoot)!.files, []);
  writeFileSync(join(f.root, "src/one.ts"), "edit\n");
  git(f.root, "add", "src/one.ts");
  git(f.root, "commit", "-m", "Feature");
  git(f.root, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  git(f.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.deepEqual(resolveFileFocus({ changed: true }, [], join(f.root, "src"), f.pmRoot)!.files, []);
  const refresh = f.run("--changed", "--format", "agent");
  assert.match(refresh, /--changed 'origin\/trunk'/);
  assert.doesNotMatch(refresh, /refs\/remotes/);
  assert.deepEqual(resolveFileFocus({ changed: "main" }, [], f.root, f.pmRoot)!.files, ["src/one.ts"]);
});

test("Git routing environment cannot redirect discovery or index reads", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "src/one.ts"), "edit\n");
  const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = join(f.root, "missing");
    assert.deepEqual(resolveFileFocus({ changed: true }, [], f.root, f.pmRoot)!.files, ["src/one.ts"]);
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
    assert.throws(() => resolveFileFocus(options, [...args], cwd, f.pmRoot), (error: unknown) => error instanceof FileFocusError && error.exitCode === 2 && error.code === code);
  }
  const failure = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-pack", "--changed", "missing-branch"], { cwd: f.root, encoding: "utf8", env: { ...process.env, PM_PATH: f.pmRoot, PM_SOURCE_WORKSPACE_ROOT: f.root, PM_SOURCE_PM_PATH: f.pmRoot } });
  assert.equal(failure.status, 2, failure.stdout + failure.stderr);
  assert.match(failure.stdout + failure.stderr, /known-base/);
  writeFileSync(join(f.root, ".git/index"), "corrupt");
  assert.throws(() => resolveFileFocus({ changed: true }, [], f.root, f.pmRoot), (error: unknown) => error instanceof FileFocusError && error.code === "GIT_FAILED");
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
  assert.equal(resolveFileFocus({ changed: false }, [], f.root, f.pmRoot), undefined);
  assert.ok(resolveFileFocus({ files: ["it's.ts"] }, [], f.root, f.pmRoot)!.refresh.includes("'\\''"));
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
  await assert.rejects(readFileFocusItems(f.pmRoot), (error: unknown) => {
    assert.ok(error instanceof FileFocusError);
    assert.equal(error.code, "TRACKER_READ_FAILED");
    assert.match(error.message, /Duplicate item identity: focus-one/);
    assert.ok(error.message.includes(`${f.one}.toon`) || error.message.includes(`${f.one}.md`));
    assert.ok(error.cause instanceof Error);
    return true;
  });
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
  assert.deepEqual(resolveFileFocus({ changed: true }, [], f.root, f.pmRoot)!.files, ["src/one.ts", "src/two.ts"]);
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


test("changed excludes tracked items and history under default and custom pm roots", async (t) => {
  for (const trackerPath of [".agents/pm", "project/tracker"]) {
    const f = await fixture(t, trackerPath);
    writeFileSync(join(f.root, "src/one.ts"), "branch edit\n");
    git(f.root, "add", "src/one.ts");
    git(f.root, "add", "-f", `${trackerPath}/tasks`, `${trackerPath}/history`);
    git(f.root, "commit", "-m", "Code and tracker changes");
    writeFileSync(join(f.root, `${trackerPath}-notes.ts`), "outside tracker\n");
    git(f.root, "add", "-f", `${trackerPath}-notes.ts`);
    const before = snapshot(f.pmRoot);
    const pack = JSON.parse(f.run("--changed", "main", "--format", "json")) as ContextPack;
    assert.deepEqual(pack.items.map((item) => item.id), [f.one]);
    assert.deepEqual(pack.unlinked_changed_files, [`${trackerPath}-notes.ts`]);
    for (const pmRoot of [f.pmRoot, trackerPath, trackerPath.replaceAll("/", "\\")]) {
      assert.deepEqual(resolveFileFocus({ changed: "main" }, [], join(f.root, "src"), pmRoot)!.files,
        [`${trackerPath}-notes.ts`, "src/one.ts"].sort());
    }
    assert.deepEqual(snapshot(f.pmRoot), before);
  }
});

test("tracker containment handles Windows casing, separators, external roots and path boundaries", () => {
  for (const [path, pmRoot, root, expected] of [
    [".agents/pm/history/item.jsonl", ".agents/pm", "/repo", true],
    [".agents/pm", "/repo/.agents/pm", "/repo", true],
    [".agents/pm-notes.ts", ".agents/pm", "/repo", false],
    ["src/one.ts", "/outside/tracker", "/repo", false],
    ["../outside", ".agents/pm", "/repo", false],
    ["src/one.ts", "/repo", "/repo", true],
    [".agents/PM/history/item.jsonl", "C:\\Repo\\.agents\\pm", "C:\\Repo", true],
    ["project\\tracker\\tasks\\item.toon", "project\\tracker", "C:\\Repo", true],
    ["src/one.ts", "D:\\tracker", "C:\\Repo", false],
    ["project/tracker/tasks/item.toon", "\\\\server\\repo\\project\\tracker", "\\\\server\\repo", true],
    ["PROJECT/tracker/tasks/item.toon", "//server/repo/project/tracker", "//server/repo", true],
  ] as const) assert.equal(isTrackerPath(path, pmRoot, root), expected);
});

test("malformed item errors retain the failing item path and original parser cause", async (t) => {
  const f = await fixture(t);
  const itemPath = join(f.pmRoot, "tasks", `${f.one}.toon`);
  writeFileSync(itemPath, "not a valid item document");
  let original: unknown;
  try { await readLocatedItem({ id: f.one, type: "Task", itemPath, item_format: "toon" }); }
  catch (error) { original = error; }
  assert.ok(original instanceof Error);
  await assert.rejects(readFileFocusItems(f.pmRoot), (error: unknown) => {
    assert.ok(error instanceof FileFocusError);
    assert.equal(error.code, "TRACKER_READ_FAILED");
    assert.ok(error.message.includes(itemPath));
    assert.ok(error.message.includes(original.message));
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, original.message);
    return true;
  });
});
