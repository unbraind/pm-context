/** Compare two built distributions against immutable public tracker snapshots outside Git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Hash source corpus bytes, excluding disposable SDK and package runtime state. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["runtime", "locks", "search"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(snapshot(path))) result[`${entry.name}/${name}`] = hash;
    } else {
      assert.ok(entry.isFile(), "public snapshot must contain only ordinary source files");
      result[entry.name] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return result;
}

/** Make settings, item documents and history immutable while leaving disposable runtime writable. */
function protect(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { protect(path); chmodSync(path, 0o555); }
    else chmodSync(path, 0o444);
  }
}

/** Restore scratch directory permissions solely so the test can remove its own copies. */
function unprotect(root: string): void {
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) unprotect(join(root, entry.name));
}

// Static imports are resolved relative to the selected built distribution.
const worker = `
import { readFileFocusItems } from './file-focus.js';
import { buildContextPack, buildAgentHandoff, buildContextExplain } from './index.js';
import { buildSincePack } from './since.js';
import { readSettings, resolveRuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
const pmRoot = process.env.DIFFERENTIAL_PM_ROOT;
const items = await readFileFocusItems(pmRoot);
const focus = { root: process.env.DIFFERENTIAL_PROJECT_ROOT, files: ['index.ts', 'since.ts', 'file-focus.ts', 'README.md'], refresh: '' };
const options = { fileFocus: focus, includeClosed: true, maxItems: 10, generatedAt: '2026-10-25T00:00:00.000Z' };
const pack = buildContextPack(items, options);
const handoff = buildAgentHandoff(pack);
const explain = buildContextExplain([...pack.items, ...pack.neighbors], { now: options.generatedAt, statusRegistry: resolveRuntimeStatusRegistry(await readSettings(pmRoot)) });
const terminal = new Set(['closed', 'canceled']);
const initial = await buildSincePack(pmRoot, items, terminal, { author: 'differential-fixture', from: '2000-01-01T00:00:00Z', tokenBudget: 100000000 });
const resumed = await buildSincePack(pmRoot, items, terminal, { author: 'differential-fixture', cursor: initial.cursor, tokenBudget: 100000000 });
const { served_at: initialTime, ...initialStable } = initial;
const { served_at: resumedTime, ...resumedStable } = resumed;
console.log(JSON.stringify({ items, pack, handoff, explain, initial: initialStable, resumed: resumedStable }));
`;

/** Run public functions with Git absent from PATH and source bytes protected. */
function run(dist: string, pmRoot: string, project: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: dist, input: worker, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, PATH: join(project, "no-executables"), GIT_CEILING_DIRECTORIES: project,
      DIFFERENTIAL_PM_ROOT: pmRoot, DIFFERENTIAL_PROJECT_ROOT: project },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const [beforeArg, afterArg, ...trackers] = process.argv.slice(2);
assert.ok(beforeArg && afterArg && trackers.length > 0, "usage: node test/sdk-adoption-differential.ts BEFORE_DIST AFTER_DIST TRACKER...");
const before = resolve(beforeArg);
const after = resolve(afterArg);
for (const tracker of trackers) {
  const scratch = mkdtempSync(join(tmpdir(), "context-sdk-differential-"));
  try {
    assert.equal(existsSync(join(scratch, ".git")), false);
    const original = snapshot(resolve(tracker));
    const roots = ["before", "after"].map((name) => {
      const root = join(scratch, name);
      cpSync(resolve(tracker), root, { recursive: true });
      protect(root);
      mkdirSync(join(root, "runtime"));
      mkdirSync(join(root, "locks"));
      return root;
    });
    // The project root is shared only as a path-normalization anchor; neither copy is a Git repository.
    const a = run(before, roots[0]!, scratch);
    const b = run(after, roots[1]!, scratch);
    assert.deepEqual(b, a, "every output field except serving wall-clock timestamps must match");
    for (const root of roots) assert.deepEqual(snapshot(root), original, "source corpus bytes changed");
    assert.deepEqual(snapshot(resolve(tracker)), original, "input snapshot changed");
    const initial = b.initial as { changes: unknown[] };
    console.log(JSON.stringify({ items: (b.items as unknown[]).length, delta_rows: initial.changes.length,
      comparisons: ["file-focus items", "context pack", "handoff", "explain", "since initial", "since resumed"],
      source_bytes_unchanged: true, git_available: false, differences: [] }));
  } finally { unprotect(scratch); rmSync(scratch, { recursive: true, force: true }); }
}
