/**
 * Process-level tests for the coverage-gate script.
 *
 * The gate is a standalone Node script that reads `package.json#coverageGate`,
 * walks sources, runs the test command with V8 coverage, parses the lcov report,
 * and exits non-zero on a miss. These tests drive it as a real child process
 * over purpose-built temporary fixture projects — a tiny `package.json` + a
 * source file + a test file — and assert on its exit code and stderr/stdout
 * text. They are self-contained and free of anything specific to any one
 * package, so the same file can be dropped into any fleet package that uses the
 * gate.
 *
 * The gate resolves its repository root from `import.meta.dirname` (not from
 * `cwd`), so each fixture receives a copy of the script under its own
 * `scripts/` directory. This exercises the real code unchanged — the script
 * reads the fixture's `package.json`, walks the fixture's sources, and runs the
 * fixture's tests.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/** Absolute path to the coverage-gate script under test. */
const GATE_SOURCE = resolve(import.meta.dirname, "..", "scripts", "coverage-gate.ts");
/** Absolute path to the real package root, so fixtures can reuse its node_modules. */
const REAL_ROOT = resolve(import.meta.dirname, "..");

/**
 * Build a minimal fixture project in a temporary directory.
 *
 * Creates a `package.json` with the supplied `coverageGate` block, copies the
 * gate script into `scripts/`, and writes whatever source and test files are
 * passed. The directory is the fixture's repository root — the gate resolves
 * its config relative to `package.json` there.
 *
 * @param config - The `coverageGate` block to embed in `package.json`.
 * @param files - Map of repo-relative path to file content to write.
 * @param options - When `linkNodeModules` is set, symlink the real package's
 *   `node_modules` into the fixture so `npx tsc` (used by `ignore` verification)
 *   resolves without a network fetch.
 * @returns Absolute path to the fixture root.
 */
function fixtureProject(
  config: Record<string, unknown>,
  files: Record<string, string>,
  options: { linkNodeModules?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", type: "module", coverageGate: config }, null, 2)}\n`,
    "utf8",
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(GATE_SOURCE, join(root, "scripts", "coverage-gate.ts"));
  if (options.linkNodeModules) {
    symlinkSync(join(REAL_ROOT, "node_modules"), join(root, "node_modules"));
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
  return root;
}

/**
 * Run the gate script as a child process in the fixture root and return the
 * combined result.
 *
 * Strips Node's test-runner context env vars (`NODE_TEST_CONTEXT`,
 * `NODE_TEST_WORKER_ID`) so the gate's inner `node --test` child process does
 * not detect a recursive test run and skip the test files. The real package's
 * `node_modules/.bin` is prepended to `PATH` so that `npx tsc --showConfig`
 * (used only when `ignore` entries are present) can resolve the TypeScript
 * compiler without a network fetch.
 *
 * @param cwd - Fixture root to run the gate in.
 * @returns The spawn result with exit status and captured output.
 */
function runGate(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  env.PATH = `${join(REAL_ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}`;
  env.TZ = "UTC";
  const result = spawnSync(process.execPath, ["scripts/coverage-gate.ts"], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A one-line TS source that is fully covered by the companion test. */
const COVERED_SOURCE = "export function add(a: number, b: number): number { return a + b; }\n";
/** A test that exercises the source above. */
const COVERED_TEST =
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
  "import { add } from '../src.ts';\n" +
  "test('add', () => { assert.equal(add(1, 2), 3); });\n";
/** A source with a dead branch the test never takes. */
const UNCOVERED_SOURCE =
  "export function classify(n: number): string {\n" +
  "  if (n > 0) return 'positive';\n" +
  "  return 'zero';\n" +
  "}\n";
/** A test that only covers the positive branch. */
const PARTIAL_TEST =
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
  "import { classify } from '../src.ts';\n" +
  "test('positive', () => { assert.equal(classify(1), 'positive'); });\n";

/** Minimal tsconfig for fixtures that need `tsc --showConfig` to resolve. */
const TSCONFIG = JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "." } }, null, 2);

test("coverage-gate passes a fully covered fixture at 100/100/100", () => {
  const root = fixtureProject(
    { sources: ["."], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    { "src.ts": COVERED_SOURCE, "test/example.test.ts": COVERED_TEST },
  );
  try {
    const result = runGate(root);
    assert.equal(result.status, 0, `gate should pass:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /source file\(s\) reported, thresholds met/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate exits non-zero on a threshold miss", () => {
  const root = fixtureProject(
    { sources: ["."], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    { "src.ts": UNCOVERED_SOURCE, "test/example.test.ts": PARTIAL_TEST },
  );
  try {
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail on a threshold miss");
    assert.notEqual(result.status, null, "gate should exit with a non-null status");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate rejects a sources entry that does not exist", () => {
  const root = fixtureProject(
    { sources: ["missing-dir"], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    { "src.ts": COVERED_SOURCE, "test/example.test.ts": COVERED_TEST },
  );
  try {
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail when a sources entry is absent");
    assert.match(result.stderr, /missing-dir.*does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate rejects a sources entry that is a .d.ts file", () => {
  const root = fixtureProject(
    { sources: ["types.d.ts"], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    { "types.d.ts": "export interface Foo { bar: string; }\n", "test/example.test.ts": "import test from 'node:test';\ntest('noop', () => {});\n" },
  );
  try {
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail when a sources entry is a .d.ts file");
    assert.match(result.stderr, /types\.d\.ts.*not a TypeScript source file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate rejects a sources entry that is a non-TypeScript file", () => {
  const root = fixtureProject(
    { sources: ["readme.md"], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    { "readme.md": "# hello\n", "test/example.test.ts": "import test from 'node:test';\ntest('noop', () => {});\n" },
  );
  try {
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail when a sources entry is a non-TS file");
    assert.match(result.stderr, /readme\.md.*not a TypeScript source file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate rejects an ignore entry that is not under sources", () => {
  const root = fixtureProject(
    { sources: ["src.ts"], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 }, ignore: ["orphan.ts"] },
    { "src.ts": COVERED_SOURCE, "test/example.test.ts": COVERED_TEST, "tsconfig.json": TSCONFIG },
    { linkNodeModules: true },
  );
  try {
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail when an ignore entry is not under sources");
    assert.match(result.stderr, /orphan\.ts.*not under.*sources/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate rejects an empty source walk", () => {
  const root = fixtureProject(
    { sources: ["."], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    { "test/example.test.ts": "import test from 'node:test';\ntest('noop', () => {});\n" },
  );
  try {
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail when no sources are found");
    assert.match(result.stderr, /source walk found no files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate rejects a source file never loaded during the run", () => {
  const root = fixtureProject(
    { sources: ["."], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    { "src.ts": COVERED_SOURCE, "untested.ts": "export function unused(): number { return 42; }\n", "test/example.test.ts": COVERED_TEST },
  );
  try {
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail when a source file is never loaded");
    assert.match(result.stderr, /untested\.ts/);
    assert.match(result.stderr, /never loaded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate rejects an ignore entry that emits runtime code", () => {
  const root = fixtureProject(
    { sources: ["."], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 }, ignore: ["runtime-ignored.ts"] },
    { "src.ts": COVERED_SOURCE, "runtime-ignored.ts": "export function runtimeFn(): number { return 42; }\n", "test/example.test.ts": COVERED_TEST, "tsconfig.json": TSCONFIG },
    { linkNodeModules: true },
  );
  try {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "runtime-ignored.js"), "export function runtimeFn() { return 42; }\n", "utf8");
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail when an ignored file emits runtime code");
    assert.match(result.stderr, /runtime-ignored\.ts.*emits runtime code/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate accepts an ignore entry that is genuinely type-only", () => {
  const root = fixtureProject(
    { sources: ["."], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 }, ignore: ["types-only.ts"] },
    { "src.ts": COVERED_SOURCE, "types-only.ts": "/** Type-only module. */\nexport interface Foo { bar: string; }\n", "test/example.test.ts": COVERED_TEST, "tsconfig.json": TSCONFIG },
    { linkNodeModules: true },
  );
  try {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "types-only.js"), "export {};\n", "utf8");
    const result = runGate(root);
    assert.equal(result.status, 0, `gate should pass with a type-only ignore:\n${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate fails when package.json has no coverageGate block", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-gate-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(GATE_SOURCE, join(root, "scripts", "coverage-gate.ts"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }, null, 2), "utf8");
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail without a coverageGate block");
    assert.match(result.stderr, /no.*coverageGate.*block/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage-gate rejects an ignore entry with no compiled output", () => {
  const root = fixtureProject(
    { sources: ["."], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 }, ignore: ["unbuilt.ts"] },
    { "src.ts": COVERED_SOURCE, "unbuilt.ts": "/** Type-only. */\nexport interface Bar { x: number; }\n", "test/example.test.ts": COVERED_TEST, "tsconfig.json": TSCONFIG },
    { linkNodeModules: true },
  );
  try {
    const result = runGate(root);
    assert.notEqual(result.status, 0, "gate should fail when ignored file has no compiled output");
    assert.match(result.stderr, /cannot verify.*unbuilt\.ts.*type-only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});