# Context usage acceptance evidence

Owner item: [pm-context-ci6v](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-ci6v.toon).

## Scenario and baseline

Initialize a disposable tracker with the real SDK, create two focus items, and
serve a focus-only markdown bundle from the built package in session-a. Cite
one returned fact id against its receipt. Expect two served facts, one used
fact, precision 0.5, and a positive unused-token estimate. Serving the same
facts in session-b must retain their stable ids but have a distinct receipt
and zero used facts. Serving/reporting must leave item/history files unchanged.

Before implementation the built package selected both items, but exposed no
receipt, fact ids, or bundle/session metrics. The baseline was recorded in the
owner item's comments before source changes.

## Protocol and storage

The implementation measures the rendered bundle, then adds content-addressed
fact/section identifiers and a receipt. The command records explicit citations,
item-mutation proxies and file-edit proxies against that receipt. Duplicate
submissions merge evidence without increasing the used-fact count. Unknown
ids and session mismatches reject the entire submission. Session/item rollups
retain the served denominator and unused estimated token cost.

The package owns atomic snapshots under `runtime/context-receipts/`, separate
from the SDK's ledger: at most 200 receipts, each at most 256 KiB. Rotation
protects the receipt returned by the serving call and removes the least recently
written siblings, retaining at most 199 beside the current receipt. This holds
even when the siblings have future modification times. Failed output-file writes roll
back the receipt. Corrupt and oversized snapshots are counted and skipped.
No receipt state enters tracked item/history files. The README defines the v1
agent protocol, estimation model, retention window and evidence limitations.

## Tests and behavioral revert proof

`test/context-receipts.test.ts` uses real initialized trackers, real SDK create,
files and update actions, and the SDK's governed extension host harness. The
acceptance scenario imports `dist/index.js`, so it exercises the built artifact.
Additional tests exercise both serving commands, all evidence categories,
section exclusion, stable ids, file normalization, output files, read-only
explain, environment identity/session defaults, atomic rejection, idempotency,
rotation, corrupted snapshots, and filtered/limited aggregate denominators.
No SDK mock is used. Fixture initialization supplies both `cwd` and `pmRoot`,
so the schema tracker environment supplied by linked-test runs cannot redirect
the disposable tracker. Both linked commands pass through
`pm test pm-context-ci6v --run --progress`; this tracker's result tracking is
disabled, so the item comments record their successful results.

Key command:

```bash
npm run build
node --test --test-name-pattern='built package acceptance' test/context-receipts.test.ts
```

Two independent behavioral reversions left tests and module exports intact:

| Reverted behavior | Executed assertion failure |
| --- | --- |
| `measureContextOutput` restored raw output and original host serving only | `served text must expose a receipt` |
| `recordReceiptUsage` disabled evidence persistence | `used_facts`: actual 0, expected 1 |

Each reversion was built before running the identical test. Both runs loaded
and executed the acceptance scenario; neither failure was an import/type/load
failure. Restoring both functions made the identical built-package test pass.

Validation commands:

```bash
node --test test/context-receipts.test.ts
npm run release:check
bun run release:check
npm run changelog:full
```

The release checks retain the repository's exact thresholds: 100% lines,
branches and functions across every configured executable source; no threshold,
source list or exemption changed. Node's native gate does not independently
report or enforce statement coverage.

Historical validation on SDK 2026.10.4: both release commands passed with 295 tests and 100% lines/branches/functions
across six configured sources. The nine dedicated receipt tests passed. Fresh
npm and Bun consumers installed the packed tarball and pinned host, activated
the extension with the real CLI, and exercised serving, citation and reporting.
Node and native Bun both returned two served facts, one used fact, precision
0.5, positive unused-token cost, and a JSON handoff receipt.

## Main merge and SDK 2026.10.10 renewal

PR 131 started at `aaa5743` and merged main `49f1594` normally. Only the generated
`dist/index.js.map` conflicted; `npm run build` regenerated it from the merged
TypeScript. Receipt source and the real future-mtime regression were preserved.
Package, manifest and runtime versions remain the main release `2026.10.10`.
Development dependencies are exact SDK `2026.10.10`, pm-ops `2026.10.6` and
pm-changelog `2026.10.5`. The independent peer and manifest floors remain
`>=2026.8.15` and `2026.8.15` respectively.

The unchanged `npm run release:check` passed 295 tests, with zero failures,
cancellations, skips or todos. Both existing owner-linked receipt commands
passed within their unchanged 240-second deadlines. The original source-only
retention control from `1268aa5` was repeated with the regression unchanged:
the returned receipt was absent (actual 0, expected 1). Restoring the original
source bytes passed the identical focused test. The earlier two behavioral
revert records above remain historical evidence.

Linking the full release command exposed an older fixture isolation defect:
the schema tracker environment took precedence over SDK initialization calls
that supplied only `cwd`. That linked run executed 295 tests: 256 passed and
39 failed, with zero skips. Pinning initialization alone left 22 failures
because item creation still selected the injected schema tracker. The 39
initialization and 24 item-creation calls in
`test/context-pack.test.ts` and `test/coverage-gaps.test.ts` now supply both
`cwd` and `pmRoot`, preserving real disposable trackers under linked execution.
No assertion, test count, coverage threshold or deadline was changed. The two
original receipt commands, full release command and changelog check remain
owner-linked with 240-second deadlines.
Repeating all four linked commands passed after both boundaries were pinned;
the full release run again passed all 295 tests with zero failures or skips.

The authored executable inventory is eleven files: three runtime TypeScript
modules, six TypeScript scripts, one JavaScript verifier and one shell script.
The configured six-file native Node gate measured 3278/3278 lines,
1038/1038 branches and 219/219 functions. Its scope excludes
`scripts/main-invocation.ts`, `scripts/prepare-merge-driver.ts`,
`scripts/verify-release-changelog-date.ts`, `.agents/pm/verify-release-yaml.mjs`
and `scripts/alert-on-release-failure.sh`; these existing exclusions were not
changed. Docstrings passed for nine TypeScript files and 31 declarations
selected by the analyzer's rules; JavaScript and shell documentation are outside
that denominator.

An additional c8 observation included all ten authored JavaScript/TypeScript
files: statements and lines 3809/3857 (98.75%), branches 1154/1160 (99.48%),
functions 103/104 (99.03%). The verifier was unexercised by that test-only run;
the normal release gate executes it separately. Shell coverage was not measured.
This observation is separate from the unchanged mandatory native Node gate and
does not establish whole-source four-metric certification.

Fresh npm/Node and Bun/native Bun consumers installed the npm-packed built
artifact under SDK `2026.10.10` and minimum `2026.8.15`. Each exercised the real
governed host harness and installed CLI: two served focus facts, one cited fact,
precision 0.5, positive unused-token cost, isolated sessions, idempotent
citations, actual SDK mutation and file edit proxies, and JSON handoff output.
Each also repeated three real filesystem retention rounds with 200 future-mtime
siblings, checking both the hard 200-receipt bound and immediate citation of
the returned receipt. No item/history bytes changed during serving/reporting.
Native Bun used explicit `--bun`. Both production and development npm audits
reported zero vulnerabilities. These bounded synthetic consumers do not
establish production readiness, deployment, scale or final host delivery.

## SDK boundaries and open risks

The SDK's host touch ledger exposes item/author/time evidence without receipt,
fact or session identifiers. Successful SDK mutations alone cannot be safely
assigned to one of several agent sessions. Agents or post-mutation hooks must
submit receipt-scoped evidence. The SDK also has no generic fact-level
post-egress callback for extension output, so host truncation, suppressed
responses and whether an agent read a saved file are not inferred. The legacy
host-ledger report remains separate and uses its existing inclusion semantics.

Token counts approximate four characters per token, with annotation/receipt
cost reported separately. Silence is unreported usage, not proven irrelevance.
Facts shared by several items contribute to each item rollup but only once to
bundle/session totals. Runtime rotation bounds the observation window; a crashed
writer can leave a directory lock requiring operator recovery.
