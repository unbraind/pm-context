import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8")) as {
  jobs: { release: { steps: { name: string; run?: string; env?: Record<string, string> }[] } };
};
const steps = workflow.jobs.release.steps;

/** Exercise the real decision block with an immutable empty prepared commit and newer source work. */
function selectAfterEmpty(notes: string, recovery = ""): { output: Record<string, string>; log: string } {
  const root = mkdtempSync(join(tmpdir(), "context-empty-prepared-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("remote", "add", "origin", root);
    for (const version of ["2026.10.31", "2026.11.1"]) {
      for (const file of ["package.json", "manifest.json", "package-lock.json"]) writeFileSync(join(root, file), JSON.stringify({ version }));
      writeFileSync(join(root, "CHANGELOG.md"), notes);
      git("add", "package.json", "manifest.json", "package-lock.json", "CHANGELOG.md");
      git("commit", "-qm", `Release pm-context v${version}`);
      if (version === "2026.10.31") git("tag", "v2026.10.31");
    }
    writeFileSync(join(root, "source.txt"), "Later delivered change");
    git("add", "source.txt");
    git("commit", "-qm", "Deliver new work");
    const script = steps.find(step => step.name === "Decide release")?.run;
    assert.ok(script);
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", script], { cwd: root, encoding: "utf8", env: {
      ...process.env, GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary"),
      RELEASE_TIMEZONE: "Europe/Vienna", RECOVERY_NOTES_SHA: recovery,
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("tag", "--list"), "v2026.10.31\n", "selection must never create, delete or retag a release");
    return { output: Object.fromEntries(readFileSync(join(root, "output"), "utf8").trim().split("\n").map(line => line.split("="))), log: result.stdout };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("an empty untagged preparation does not block the current daily release", () => {
  for (const notes of ["# Changelog\n\n## 2026.10.31 - 2026-10-31\nOld change\n", "## 2026.11.1 - 2026-11-01\n\nNo changes.\n", "## 2026.11.1 - 2026-11-01\n\n### Fixed\n"]) {
    const { output, log } = selectAfterEmpty(notes);
    assert.equal(output.should_release, "true");
    assert.equal(output.resume, "false");
    assert.notEqual(output.npm_version, "2026.11.1");
    assert.match(log, /Abandoning untagged prepared release v2026.11.1.*no usable same-version/);
  }
});

test("explicit recovery and valid prepared notes retain immutable resume selection", () => {
  for (const [notes, recovery] of [["# Changelog\nOld notes\n", "a".repeat(40)], ["## 2026.11.1 - 2026-11-01\n\n- Delivered change\n", ""]]) {
    const { output } = selectAfterEmpty(notes, recovery);
    assert.equal(output.resume, "true");
    assert.equal(output.npm_version, "2026.11.1");
  }
  assert.equal(steps.find(step => step.name === "Decide release")?.env?.RECOVERY_NOTES_SHA, "${{ inputs.recovery_notes_sha }}");
});

test("generation rejects an older section, placeholder and heading-only notes before preparing metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "context-exact-notes-"));
  try {
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(root, "node_modules/.bin/pm-changelog"), '#!/bin/sh\ncase " $* " in *" --stdout "*) cat fixture.md ;; esac\n', { mode: 0o755 });
    const script = steps.find(step => step.name === "Generate changelog and release notes")?.run;
    assert.ok(script);
    for (const [notes, success] of [
      ["## 2026.10.31 - 2026-10-31\nOld change\n", false],
      ["## 2026.11.1 - 2026-11-01\nNo changes.\n", false],
      ["## 2026.11.1 - 2026-11-01\n### Fixed\n", false],
      ["## 2026.11.1 - 2026-11-01\n- Delivered fix\n", true],
    ] as const) {
      writeFileSync(join(root, "fixture.md"), notes);
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, RELEASE_TAG: "v2026.11.01", NPM_VERSION: "2026.11.1" } });
      assert.equal(result.status === 0, success, result.stderr);
      if (success) assert.equal(readFileSync(join(root, "RELEASE_NOTES.md"), "utf8"), notes);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restoration refuses same-version placeholders and headings without content", () => {
  const root = mkdtempSync(join(tmpdir(), "context-empty-restore-"));
  try {
    const script = steps.find(step => step.name === "Restore prepared release notes")?.run;
    assert.ok(script);
    for (const content of ["No changes.\n", "### Fixed\n"]) {
      writeFileSync(join(root, "CHANGELOG.md"), `## 2026.11.1 - 2026-11-01\n${content}\n## 2026.10.31 - 2026-10-31\nOld fix\n`);
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, NPM_VERSION: "2026.11.1", RECOVERY_NOTES_SHA: "" } });
      assert.equal(result.status, 1);
      assert.equal(readFileSync(join(root, "RELEASE_NOTES.md"), "utf8"), "");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
