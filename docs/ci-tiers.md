# Fleet CI v2

Required checks remain exactly `test (22)` and `test (26)`. Both run on
`ubuntu-latest` for pull requests and manual dispatch, cancel superseded PR
runs, and have a 25-minute timeout (expected quick execution: 6–10 minutes).
CodeQL is not a required check. No additional platform jobs existed.

| Check / contract | Code PR Node 22 | Code PR Node 26 | Tracker/docs-only PR (both) | Deep Node 22 and 26 |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers | yes | yes | yes | yes |
| Strict pm health / required merge drivers | — | yes | yes | yes |
| Changelog consistency | — | yes | yes | yes |
| Build and complete test suite | quick | quick via coverage | — | full npm + Bun |
| Committed dist matches fresh build, including untracked output | — | yes | — | yes |
| Typecheck and docstring gate | — | npm gate | — | npm + Bun gates |
| Coverage with unchanged native and c8 thresholds/source scope | — | quick npm gate | — | full npm + Bun gates |
| Release workflow contract | — | yes + npm gate | — | yes + npm + Bun gates |
| Production audit / package dry-run | — | npm gate | — | standalone + npm + Bun gates |
| Publish attestation and changelog date verification | — | npm gate | — | standalone + npm + Bun gates |
| Bun package graph installation | — | smoke | — | yes |
| bunx TypeScript smoke | — | yes | — | — (additional PR smoke) |
| CodeQL | separate workflow on matching paths | separate workflow on matching paths | path-filtered | separate main scan / weekly scan |

There is no standalone lint script; typecheck and docstring checks are the existing
static gates. All old CI checks remain in at least one tier. Repeated standalone
checks inside the old deep matrix are retained; PR Node 26 runs the npm release
gate once, and Node 22 runs `npm test` without coverage, changelog or packing.

The docs/tracker path runs only dependency installation, strict health and
changelog verification. Change detection compares PR base/head with NUL delimiters
and disables rename folding, so moving code into docs retains its source deletion.
Executable `.mjs`, `.cjs`, `.js` and `.ts` tracker files select the code path.
Manual dispatch always selects code validation. CodeQL ignores tracker data,
Markdown, docs and `package-lock.json` on PR/main events; its weekly Monday
03:03 UTC scan still analyzes the complete source, including tracker helpers.

Deep checks are named `deep (22)` and `deep (26)`, never required PR contexts.
They run on pushes to main, daily at 02:41 UTC (release: 03:23 UTC), or dispatch.
Each executes both original npm and Bun full release gates at `PM_TEST_DEPTH=full`
and `PM_TEST_TIME_SCALE=3`, with a 120-minute timeout and cancellation per ref.
The controller-owned `PM_LOCAL_DEEP` variable routes jobs to `[self-hosted, pm-local]`
unless set to `off`, which selects `ubuntu-latest`. Local runners reuse persistent
npm cache and preinstalled Bun; hosted runners use setup-node caching and setup-bun.
Every deep job logs its Bun version. No release or issue-sync workflows changed.

`test/support/depth.ts` uses the pilot's deterministic one-tenth prefix with a
minimum of 25 cases, capped by the original count. All ten 500-case loops run 50
cases in quick mode. Unset, `full` and unrecognized values retain the original
count. Seed generation, per-case assertions and boundary-size fixtures stay intact.
Native coverage still requires 100% lines, branches and functions; c8 keeps 100%
statements/lines/functions and 99.9% branches. Quick depth does not relax either gate.

The release gate has no packed acceptance script. Separate manual fixture scripts
exercise npm local/global installs, Bun global installation, npx and bunx execution;
they do not prove those install paths during a normal gate. The PR therefore runs
`bun install --no-save` and `bunx --no-install tsc --noEmit` explicitly. The normal
phase-restoration test retains its packed Node/Bun/CLI execution scenarios at both
depths, using a copied dependency graph rather than independent package installs.

The since-packing regression now checks at most two whole-pack serializations for
125, 250 and 500 rows, plus exact byte accounting, instead of requiring completion
within one second. Elapsed time remains diagnostic. Product lock-contention and pointer-validation deadlines,
and subprocess watchdogs in the touched suites, scale by `PM_TEST_TIME_SCALE`
(default 1; deep 3). Invalid or nonpositive factors fail explicitly. This guards the algorithmic
contract independently of machine load.

## Baseline and validation

The owner measured 39,929 fleet runner-minutes in 24 hours, including 1,576 for this
package, and roughly 28 minutes of queueing behind 20 hosted slots. Latest successful
main CI was run `43629665845`: queue-inclusive run duration 56m02s; Node 22 job
execution 15m51s, Node 26 8m05s (two full gates each). Its slowest seeded tests were
answer reduction (113.59s), shared evidence (111.74s), task phase (80.55s) and phase
restoration (73.63s); repeated gate runs produced similar results.

For the local-runner pilot, `gh run view 43623071562 --log-failed` returned no text.
The individual Node 22 job log and both job summaries show the npm release gate
passed and changelog verification failed with an out-of-date generated changelog.
No wall-clock test failure appears in that run. The existing release-changelog
item `pm-context-3zzd` owns that defect; release workflows and verifier scripts
remain outside this change. Quick/full timing and CI receipts are recorded in the
package task and PR; full depth is not run on the overloaded development host.

Local quick validation passed on Node 26: 75/75 touched tests in 4m05.829s;
5/5 helper and receipt-lock checks at time scale 3 in 7.349s; one
`PM_TEST_DEPTH=quick npm run coverage` in 8m11.159s, 489/489 tests with zero
failures, cancellations or skips. Native coverage reached 100% in all three
reported dimensions; c8 reached 100% statements/lines/functions/branches
(6,161 lines/statements, 269 functions, 2,956 branches). Thresholds and source
scope are unchanged; no late-seed-only branch regressions were needed.
Typecheck, test compilation, docstring lint, strict YAML parsing, changelog,
strict tracker health, release workflow verification, and bunx TypeScript
smoke passed. Fresh builds leave committed dist unchanged.

The baseline hosted Node 22 npm/Bun full gate steps took 7m46s/7m36s.
Local quick and hosted full timings differ in hardware and command scope;
they are not a controlled speedup comparison. PR job created-to-completed
latency remains unavailable while the required jobs are queued; consult the
PR/task for current run links. Full depth remains pending post-merge deep CI.
