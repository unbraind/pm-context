import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8")) as {
  jobs: { release: { env: Record<string, string>; steps: { name: string; run?: string; env?: Record<string, string> }[] } };
};
const steps = workflow.jobs.release.steps;
const releaseEnvironment = workflow.jobs.release.env;

/** Exercise the real decision block with an immutable empty prepared commit and newer source work. */
function selectAfterEmpty(notes: string, recovery = "", published: boolean | "unknown" = false, preparedVersions = ["2026.11.1"]): { output: Record<string, string>; log: string } {
  const root = mkdtempSync(join(tmpdir(), "context-empty-prepared-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("remote", "add", "origin", root);
    for (const version of ["2026.10.31", ...preparedVersions]) {
      for (const file of ["package.json", "manifest.json", "package-lock.json"]) writeFileSync(join(root, file), JSON.stringify({ version }));
      writeFileSync(join(root, "CHANGELOG.md"), notes);
      git("add", "package.json", "manifest.json", "package-lock.json", "CHANGELOG.md");
      git("commit", "-qm", `Release pm-context v${version}`);
      if (version === "2026.10.31") git("tag", "v2026.10.31");
    }
    writeFileSync(join(root, "source.txt"), "Later delivered change");
    git("add", "source.txt");
    git("commit", "-qm", "Deliver new work");
    if (recovery) {
      writeFileSync(join(root, "CHANGELOG.md"), `## ${preparedVersions.at(-1)} - 2026-11-02\n- Recovered actual change\n`);
      git("add", "CHANGELOG.md"); git("commit", "-qm", "Repair notes");
      recovery = git("rev-parse", "HEAD").trim();
    }
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/npm"), published === "unknown" ? "#!/bin/sh\necho '{\"error\":{\"code\":\"E503\"}}'\nexit 1\n" : published ? "#!/bin/sh\necho '\"2026.11.1\"'\n" : "#!/bin/sh\necho '{\"error\":{\"code\":\"E404\"}}'\nexit 1\n", { mode: 0o755 });
    const script = steps.find(step => step.name === "Decide release")?.run;
    assert.ok(script);
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", script], { cwd: root, encoding: "utf8", env: {
      ...process.env, ...releaseEnvironment, PATH: join(root, "bin") + ":" + process.env.PATH, GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary"),
      RELEASE_TIMEZONE: "Europe/Vienna", RECOVERY_NOTES_SHA: recovery,
    } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
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
      ["## 2026.11.1 - 2026-11-01\r\nNo changes.\r\n", false],
      ["## 2026.11.1 - 2026-11-01\n### Fixed\n", false],
      ["## 2026.11.1 - 2026-11-01\n<!-- hidden\ncomment -->\n---\n", false],
      ["## 2026.11.1 - 2026-11-01\n- One fix\n## 2026.11.1 - 2026-11-01\n- Duplicate\n", false],
      ["## 2026.11.1 - 2026-11-01\n- Delivered fix\n", true],
    ] as const) {
      writeFileSync(join(root, "fixture.md"), notes);
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, ...releaseEnvironment, RELEASE_TAG: "v2026.11.01", NPM_VERSION: "2026.11.1" } });
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
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, ...releaseEnvironment, NPM_VERSION: "2026.11.1", RECOVERY_NOTES_SHA: "" } });
      assert.equal(result.status, 1);
      assert.equal(readFileSync(join(root, "RELEASE_NOTES.md"), "utf8"), "");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("published preparations remain resumable and recovery can select a later empty preparation", () => {
  const published = selectAfterEmpty("# Changelog\nOld notes\n", "", true);
  assert.equal(published.output.resume, "true");
  assert.match(published.log, /already published; retaining its immutable reconciliation/);
  assert.throws(() => selectAfterEmpty("# Changelog\nOld notes\n", "", "unknown"), /Cannot establish whether prepared/);
  const later = selectAfterEmpty("# Changelog\nOld notes\n", "recover", false, ["2026.11.1", "2026.11.2"]);
  assert.equal(later.output.npm_version, "2026.11.2");
  assert.equal(later.output.resume, "true");
});

test("the locked generator emits the exact unpadded section for a padded pending tag", () => {
  const root = mkdtempSync(join(tmpdir(), "context-real-generation-"));
  const repository = process.cwd();
  const run = (bin: string, args: string[]): string => execFileSync(bin, args, { cwd: root, encoding: "utf8", stdio: "pipe", env: { ...process.env, PM_PATH: join(root, ".agents/pm"), GITHUB_STEP_SUMMARY: join(root, "summary"), ...releaseEnvironment, RELEASE_TAG: "v2026.11.01", NPM_VERSION: "2026.11.1" } });
  try {
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    run("git", ["init", "-q", "-b", "main"]);
    run("git", ["config", "user.name", "Fixture"]); run("git", ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "package.json"), '{"version":"2026.10.31"}');
    run("git", ["add", "package.json"]); run("git", ["commit", "-qm", "Old release"]); run("git", ["tag", "v2026.10.31"]);
    run(process.execPath, [join(repository, "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "synthetic", "--defaults", "--agent-guidance", "skip"]);
    run(process.execPath, [join(repository, "node_modules/@unbrained/pm-cli/dist/cli.js"), "create", "issue", "Delivered exact section", "--status", "closed", "--close-reason", "Delivered", "--release", "2026.11.1"]);
    writeFileSync(join(root, "package.json"), '{"version":"2026.11.1"}');
    const script = steps.find(step => step.name === "Generate changelog and release notes")?.run;
    assert.ok(script); run("bash", ["-e", "-c", script]);
    const notes = readFileSync(join(root, "RELEASE_NOTES.md"), "utf8");
    assert.match(notes, /^## 2026\.11\.1 - 2026-11-01/m);
    assert.match(notes, /Delivered exact section/);
    assert.doesNotMatch(notes, /## 2026\.10\.31/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
