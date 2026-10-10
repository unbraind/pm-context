/** Exercise the existing parsed-workflow verifier on real, disposable workflow files. */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const packageRoot = process.cwd();
const verifier = join(packageRoot, ".agents", "pm", "verify-release-yaml.mjs");
const releaseSource = readFileSync(join(packageRoot, ".github", "workflows", "release.yml"), "utf8");
const ciSource = readFileSync(join(packageRoot, ".github", "workflows", "ci.yml"), "utf8");

/** Run the actual verifier after writing fixture workflows and the actual alert helper bytes. */
function verify(release: string, ci: string, markerPresent = true): SpawnSyncReturns<string> {
  const root = mkdtempSync(join(tmpdir(), "release-workflow-verifier-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, ".github", "workflows", "release.yml"), release);
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), ci);
    if (markerPresent) {
      copyFileSync(join(packageRoot, "scripts", "alert-on-release-failure.sh"), join(root, "scripts", "alert-on-release-failure.sh"));
    } else {
      writeFileSync(join(root, "scripts", "alert-on-release-failure.sh"), "#!/bin/sh\nexit 0\n");
    }
    return spawnSync(process.execPath, [verifier], { cwd: root, encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("actual parsed verifier accepts scalar and array dependencies while validating real checked-in workflows", () => {
  for (const release of [releaseSource, releaseSource.replace("    needs: release\n", "    needs: [release]\n")]) {
    const result = verify(release, ciSource);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release.yml alert job verified/);
  }
});

test("actual parsed verifier refuses drift in alert dependencies, permissions, checkout, execution, marker and CI linkage", () => {
  const cases: Array<{ name: string; release: string; ci: string; marker: boolean; error: RegExp }> = [
    { name: "dependencies", release: releaseSource.replace("    needs: release\n", "    needs: unknown\n"), ci: ciSource, marker: true, error: /unknown/ },
    { name: "permissions", release: releaseSource.replace("      issues: write\n", "      issues: read\n"), ci: ciSource, marker: true, error: /issues/ },
    { name: "checkout", release: releaseSource.replace("          persist-credentials: false\n", "          persist-credentials: true\n"), ci: ciSource, marker: true, error: /without persisted credentials/ },
    { name: "execution", release: releaseSource.replace("run: bash scripts/alert-on-release-failure.sh", "run: echo skipped"), ci: ciSource, marker: true, error: /execute the tracked alert script/ },
    { name: "marker", release: releaseSource, ci: ciSource, marker: false, error: /dedup marker/ },
    { name: "ci", release: releaseSource, ci: ciSource.replaceAll("run: npm run verify:release-workflow", "run: echo skipped"), marker: true, error: /CI must execute/ },
    { name: "invalid YAML", release: "jobs: [\n", ci: ciSource, marker: true, error: /YAMLParseError/ },
  ];
  for (const fixture of cases) {
    const result = verify(fixture.release, fixture.ci, fixture.marker);
    assert.notEqual(result.status, 0, fixture.name);
    assert.match(result.stderr, fixture.error, fixture.name);
    assert.doesNotMatch(result.stdout, /verified/, fixture.name);
  }
});
