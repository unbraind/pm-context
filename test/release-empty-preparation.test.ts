import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8")) as {
  jobs: { release: { env: Record<string, string>; steps: { name: string; run?: string; env?: Record<string, string> }[] } };
};
const steps = workflow.jobs.release.steps;
const releaseEnvironment = workflow.jobs.release.env;

/** Empty formatting and placeholders must refuse; visible change text must remain publishable. */
const listContentCases: readonly (readonly [string, boolean])[] = [
  ["", false],
  ["### Fixed", false],
  ["- ", false],
  ["* ", false],
  ["+ ", false],
  ["1. ", false],
  ["- No changes.", false],
  ["* No changes.", false],
  ["+ No changes.", false],
  ["1) No changes.", false],
  ["- - No changes.", false],
  ["- <!-- hidden change -->", false],
  ["- --", false],
  ["- Delivered a real fix", true],
  ["* Delivered a real fix", true],
  ["Delivered a real fix in a non-list paragraph.", true],
  ["1.2 remains supported.", true],
];

/** Use a fixed canonical section for the shared policy and each real workflow consumer. */
function releaseSection(content: string): string { return `## 2026.11.1 - 2026-11-01\n${content}\n\n`; }

test("shared notes policy requires real text after Markdown list markers", () => {
  for (const [content, usable] of listContentCases) {
    const section = releaseSection(content);
    const result = spawnSync("awk", ["-v", "version=2026.11.1", releaseEnvironment.RELEASE_NOTES_AWK], { encoding: "utf8", input: section, shell: false });
    assert.equal(result.status === 0, usable, JSON.stringify(content));
    assert.equal(result.stdout, usable ? section : "", JSON.stringify(content));
  }
});

/** Execute unmodified workflow source from a script file; paths and values remain separate arguments. */
function runWorkflowStep(root: string, name: string, variables: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  const script = steps.find(step => step.name === name)?.run;
  assert.ok(script);
  const file = join(root, "workflow-step.sh");
  writeFileSync(file, script);
  return spawnSync("bash", ["-e", file], { cwd: root, encoding: "utf8", shell: false,
    env: { ...process.env, ...releaseEnvironment, ...variables } });
}

/** Exercise the real decision block with an immutable empty prepared commit and newer source work. */
function selectAfterEmpty(notes: string, recovery = "", published: boolean | "unknown" = false, preparedVersions = ["2026.11.1"]): { output: Record<string, string>; log: string } {
  const root = mkdtempSync(join(tmpdir(), "context-empty-prepared-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", shell: false });
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
    const result = runWorkflowStep(root, "Decide release", {
      PATH: join(root, "bin") + ":" + process.env.PATH, GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary"),
      RELEASE_TIMEZONE: "Europe/Vienna", RECOVERY_NOTES_SHA: recovery,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(git("tag", "--list"), "v2026.10.31\n", "selection must never create, delete or retag a release");
    return { output: Object.fromEntries(readFileSync(join(root, "output"), "utf8").trim().split("\n").map(line => line.split("="))), log: result.stdout };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("an empty untagged preparation does not block the current daily release", () => {
  for (const notes of ["# Changelog\n\n## 2026.10.31 - 2026-10-31\nOld change\n", "## 2026.11.1 - 2026-11-01\n\nNo changes.\n", ...listContentCases.filter(([, usable]) => !usable).map(([content]) => releaseSection(content))]) {
    const { output, log } = selectAfterEmpty(notes);
    assert.equal(output.should_release, "true");
    assert.equal(output.resume, "false");
    assert.notEqual(output.npm_version, "2026.11.1");
    assert.match(log, /Abandoning untagged prepared release v2026.11.1.*no usable same-version/);
  }
});

test("explicit recovery and valid prepared notes retain immutable resume selection", () => {
  for (const [notes, recovery] of [["# Changelog\nOld notes\n", "a".repeat(40)], ...listContentCases.filter(([, usable]) => usable).map(([content]) => [releaseSection(content), ""])]) {
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
    for (const [notes, success] of [
      ["## 2026.10.31 - 2026-10-31\nOld change\n", false],
      ["## 2026.11.1 - 2026-11-01\r\nNo changes.\r\n", false],
      ["## 2026.11.1 - 2026-11-01\n### Fixed\n", false],
      ["## 2026.11.1 - 2026-11-01\n<!-- hidden\ncomment -->\n---\n", false],
      ["## 2026.11.1 - 2026-11-01\n- One fix\n## 2026.11.1 - 2026-11-01\n- Duplicate\n", false],
      ...listContentCases.map(([content, usable]) => [releaseSection(content), usable] as const),
    ] as const) {
      writeFileSync(join(root, "fixture.md"), notes);
      const result = runWorkflowStep(root, "Generate changelog and release notes", { RELEASE_TAG: "v2026.11.01", NPM_VERSION: "2026.11.1" });
      assert.equal(result.status === 0, success, result.stderr);
      if (success) assert.equal(readFileSync(join(root, "RELEASE_NOTES.md"), "utf8"), notes);
      else assert.match(result.stdout, /::error::No usable release notes for v2026\.11\.01:.*section is missing, duplicated, or has no visible changes/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restoration refuses empty list content and retains real bullets and paragraphs", () => {
  const root = mkdtempSync(join(tmpdir(), "context-empty-restore-"));
  try {
    for (const [content, usable] of [["No changes.", false], ...listContentCases] as const) {
      const section = releaseSection(content);
      writeFileSync(join(root, "CHANGELOG.md"), `${section}## 2026.10.31 - 2026-10-31\nOld fix\n`);
      const result = runWorkflowStep(root, "Restore prepared release notes", { NPM_VERSION: "2026.11.1", RECOVERY_NOTES_SHA: "" });
      assert.equal(result.status === 0, usable, JSON.stringify(content));
      assert.equal(readFileSync(join(root, "RELEASE_NOTES.md"), "utf8"), usable ? section : "", JSON.stringify(content));
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
  const root = mkdtempSync(join(tmpdir(), "context real generation ' $(no-command) -"));
  const repository = process.cwd();
  const run = (bin: string, args: string[]): string => execFileSync(bin, args, { cwd: root, encoding: "utf8", stdio: "pipe", shell: false, env: { ...process.env, PM_PATH: join(root, ".agents/pm"), GITHUB_STEP_SUMMARY: join(root, "summary"), ...releaseEnvironment, RELEASE_TAG: "v2026.11.01", NPM_VERSION: "2026.11.1" } });
  try {
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    run("git", ["init", "-q", "-b", "main"]);
    run("git", ["config", "user.name", "Fixture"]); run("git", ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "package.json"), '{"version":"2026.10.31"}');
    run("git", ["add", "package.json"]); run("git", ["commit", "-qm", "Old release"]); run("git", ["tag", "v2026.10.31"]);
    run(process.execPath, [join(repository, "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "synthetic", "--defaults", "--agent-guidance", "skip"]);
    run(process.execPath, [join(repository, "node_modules/@unbrained/pm-cli/dist/cli.js"), "create", "issue", "Delivered exact section", "--status", "closed", "--close-reason", "Delivered", "--release", "2026.11.1"]);
    writeFileSync(join(root, "package.json"), '{"version":"2026.11.1"}');
    const result = runWorkflowStep(root, "Generate changelog and release notes", { PM_PATH: join(root, ".agents/pm"), GITHUB_STEP_SUMMARY: join(root, "summary"), RELEASE_TAG: "v2026.11.01", NPM_VERSION: "2026.11.1" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const notes = readFileSync(join(root, "RELEASE_NOTES.md"), "utf8");
    assert.match(notes, /^## 2026\.11\.1 - 2026-11-01/m);
    assert.match(notes, /Delivered exact section/);
    assert.doesNotMatch(notes, /## 2026\.10\.31/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Build a real release history and deterministic registry/clock commands without shell interpolation. */
function releaseHistory(t: Pick<TestContext, 'after'>) {
  const root = mkdtempSync(join(tmpdir(), "context-release-coordinates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", shell: false }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("remote", "add", "origin", root);
  /** Append exactly the immutable metadata and notes that selection will inspect. */
  const prepare = (tag: string, usable = false): string => {
    const version = tag.slice(1).split("-")[0].split(".").map(part => String(Number(part))).join(".") + (tag.includes("-") ? tag.slice(tag.indexOf("-")) : "");
    for (const file of ["package.json", "manifest.json", "package-lock.json"]) writeFileSync(join(root, file), JSON.stringify({ version }));
    writeFileSync(join(root, "CHANGELOG.md"), usable ? `## ${version} - 2026-11-11\n- Delivered fixture fix\n` : "# Changelog\nOld notes\n");
    git("add", "package.json", "manifest.json", "package-lock.json", "CHANGELOG.md");
    git("commit", "--allow-empty", "-qm", `Release pm-context ${tag}`);
    return git("rev-parse", "HEAD");
  };
  prepare("v2026.10.31", true); git("tag", "v2026.10.31");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/date"), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_RELEASE_DATE"\n', { mode: 0o755 });
  writeFileSync(join(root, "bin/npm"), '#!/bin/sh\nif [ "$2" = "pm-context@$FIXTURE_PUBLISHED_VERSION" ]; then printf \'"%s"\\n\' "$FIXTURE_PUBLISHED_VERSION"; else echo \'{"error":{"code":"E404"}}\'; exit 1; fi\n', { mode: 0o755 });
  /** Run selection against unchanged metadata, with all fixture values confined to environment entries. */
  const select = (published = "", date = "2026.11.11", recovery = ""): Record<string, string> => {
    writeFileSync(join(root, "output"), "");
    const result = runWorkflowStep(root, "Decide release", { PATH: join(root, "bin") + ":" + process.env.PATH,
      GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary"), RECOVERY_NOTES_SHA: recovery,
      FIXTURE_RELEASE_DATE: date, FIXTURE_PUBLISHED_VERSION: published });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return Object.fromEntries(readFileSync(join(root, "output"), "utf8").trim().split("\n").map(line => line.split("=")));
  };
  /** Commit an immutable full changelog repair, including any newer sections already present. */
  const repair = (versions: readonly string[]): string => {
    writeFileSync(join(root, "CHANGELOG.md"), versions.map(version => `## ${version} - 2026-11-11\n- Recovered fixture change\n`).join("\n"));
    git("add", "CHANGELOG.md"); git("commit", "-qm", "Repair prepared notes");
    return git("rev-parse", "HEAD");
  };
  return { git, prepare, select, repair };
}

test("publish-before-tag retry burns the abandoned coordinate and resumes the new preparation", t => {
  const history = releaseHistory(t);
  const abandoned = history.prepare("v2026.11.11");
  const allocation = history.select();
  assert.equal(allocation.resume, "false");
  assert.equal(allocation.npm_version, "2026.11.11-1");
  const current = history.prepare(allocation.tag, true);
  const retried = history.select(allocation.npm_version);
  assert.equal(retried.resume, "true");
  assert.equal(retried.release_sha, current);
  assert.notEqual(retried.release_sha, abandoned);
  assert.equal(history.git("tag", "--list"), "v2026.10.31");
});

test("a single empty unpublished preparation is abandoned and today proceeds with a fresh suffix", t => {
  const history = releaseHistory(t);
  history.prepare("v2026.11.11");
  const allocation = history.select();
  assert.equal(allocation.should_release, "true");
  assert.equal(allocation.resume, "false");
  assert.equal(allocation.tag, "v2026.11.11-1");
});

test("newest usable or published preparation wins over an older abandoned duplicate", t => {
  const history = releaseHistory(t);
  const abandoned = history.prepare("v2026.11.11");
  const usable = history.prepare("v2026.11.11", true);
  assert.equal(history.select("2026.11.11").release_sha, usable);
  assert.notEqual(history.select("2026.11.11").release_sha, abandoned);
  const published = history.prepare("v2026.11.11-1");
  assert.equal(history.select("2026.11.11-1").release_sha, published);
});

test("allocation reserves every preparation suffix and existing tag using normalized dates", t => {
  const history = releaseHistory(t);
  history.git("tag", "v2026.11.01-2");
  history.prepare("v2026.11.1");
  history.prepare("v2026.11.1-4");
  const allocation = history.select("", "2026.11.01");
  assert.equal(allocation.resume, "false");
  assert.equal(allocation.tag, "v2026.11.01-5");
});

test("explicit older recovery takes precedence over newer preparations", t => {
  for (const newerHasNotes of [false, true]) {
    const history = releaseHistory(t);
    const older = history.prepare("v2026.11.11");
    history.prepare("v2026.11.11-1", newerHasNotes);
    const recovery = history.repair(["2026.11.11-1", "2026.11.11"]);
    const selected = history.select("", "2026.11.11", recovery);
    assert.equal(selected.release_sha, older);
    assert.equal(selected.npm_version, "2026.11.11");
  }
});

test("explicit recovery still chooses a newer usable duplicate of its target coordinate", t => {
  const history = releaseHistory(t);
  history.prepare("v2026.11.11");
  const newer = history.prepare("v2026.11.11", true);
  const recovery = history.repair(["2026.11.11"]);
  assert.equal(history.select("", "2026.11.11", recovery).release_sha, newer);
});
