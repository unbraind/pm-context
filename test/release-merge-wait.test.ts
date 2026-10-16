/** Execute the checked-in merge loop with a local GitHub transport fixture. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

/** Run the actual workflow loop without contacting GitHub or changing Git refs. */
function runMergeWait(state: string, options: { readFailure?: boolean; refused?: boolean; timeout?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-merge-fixture-"));
  try {
    const document = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as {
      jobs: { release: { steps: Array<{ name: string; run?: string }> } };
    };
    const run = document.jobs.release.steps.find((step) => step.name === "Merge release metadata through protected PR")?.run;
    assert.ok(run);
    const start = run.indexOf('owner="');
    const end = run.indexOf('rm -f "$merge_err" "$pr_view_err"', start);
    assert.ok(start >= 0 && end > start, "locate the complete checked-in merge wait");
    const result = spawnSync("bash", ["-e", "-u", "-o", "pipefail", "-c", `
      pr_number=7
      release_commit=fixture-head
      gh() {
        if [[ "$1 $2" == "pr view" ]]; then
          if [[ "$READ_FAILURE" == 1 ]]; then echo 'temporary read failure' >&2; return 1; fi
          printf '{"merge_state":"%s","unsettled":[],"failing":[]}\\n' "$MERGE_STATE"
        elif [[ "$1 $2" == "api graphql" ]]; then
          return 0
        elif [[ "$1 $2 $3 $4" == "api --method PUT repos/example/package/pulls/7/merge" ]]; then
          [[ "$*" == *'merge_method=rebase'* && "$*" == *'sha=fixture-head'* ]] || return 2
          echo attempt >> attempts
          if [[ "$TIMEOUT" == 1 || ( "$REFUSED" == 1 && ! -f refused ) ]]; then
            touch refused
            echo 'checks not ready' >&2
            return 1
          fi
          echo '{"sha":"fixture-merged"}'
        elif [[ "$1 $2" == "api repos/example/package/actions/runs?head_sha=fixture-head&per_page=100" ]]; then
          return 0
        else
          echo "$*" >> unexpected
          echo "Unexpected GitHub request: $*" >&2
          return 2
        fi
      }
      sleep() { if [[ "$TIMEOUT" == 1 ]]; then SECONDS=2000; fi; }
      ${run.slice(start, end)}
      printf 'result=%s\\n' "$merged_sha"
    `], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "example/package",
        MERGE_STATE: state,
        READ_FAILURE: options.readFailure ? "1" : "0",
        REFUSED: options.refused || options.timeout ? "1" : "0",
        TIMEOUT: options.timeout ? "1" : "0",
      },
    });
    assert.equal(existsSync(join(root, "unexpected")), false, "the workflow made an unsupported transport request");
    return {
      ...result,
      attempts: existsSync(join(root, "attempts")) ? readFileSync(join(root, "attempts"), "utf8").trim().split("\n").length : 0,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const state of ["BLOCKED", "UNKNOWN", "CLEAN"]) {
  test(`release merge attempts the SHA-guarded API while state is ${state}`, () => {
    const result = runMergeWait(state, { refused: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Merge attempt refused/);
    assert.match(result.stdout, /result=fixture-merged/);
    assert.equal(result.attempts, 2);
  });
}

test("a transient PR read failure still attempts the merge", () => {
  const result = runMergeWait("BLOCKED", { readFailure: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Could not read PR/);
  assert.match(result.stdout, /result=fixture-merged/);
  assert.equal(result.attempts, 1);
});

for (const state of ["DIRTY", "BEHIND"]) {
  test(`release merge fails closed for ${state}`, () => {
    const result = runMergeWait(state);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /conflicts with main or its base moved/);
    assert.doesNotMatch(result.stdout, /result=fixture-merged/);
    assert.equal(result.attempts, 0);
  });
}

test("release merge stops at its deadline when the API keeps refusing", () => {
  // The local transport keeps refusing; advancing the shell clock on sleep
  // exercises the real deadline without waiting thirty minutes.
  const result = runMergeWait("BLOCKED", { timeout: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /did not merge within 30 minutes/);
});
