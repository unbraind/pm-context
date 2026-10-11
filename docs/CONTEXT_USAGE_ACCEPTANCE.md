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
Native Bun used explicit `--bun`. The package's production and development npm
audits reported zero vulnerabilities. The minimum SDK consumer separately
reported four high-severity findings in the old host dependency graph
(`@unbrained/pm-cli`, `braces`, `fast-glob`, `micromatch`); its compatibility
result is not a clean audit. The independent compatibility floor was preserved.
These bounded synthetic consumers do not
establish production readiness, deployment, scale or final host delivery.

## Receipt rendering and matcher review renewal

The earlier SDK renewal counts above describe the historical candidate. The
reviewed candidate preserves the SDK default-module constraint using the actual
`ExtensionModule` authoring type intersected with the package's required
`name`, `version` and `description` fields. `satisfies` erases at runtime;
the obsolete one-use identity wrapper is removed. Preliminary module-only and
manifest-only constraints failed typechecking and are excluded from passing
evidence because those SDK interfaces do not declare all package metadata.

When receipt persistence fails, both `context-pack` and `context-handoff`
explicitly carry the caller's compression choice into fallback JSON rendering.
The regression blocks the real receipt directory with a regular file, checks
the exact pretty and compact bytes returned and written, and asserts that
output-file failures reach the SDK host's documented failure result. Successful
output writes remain possible while usage measurement is disclosed as unavailable.
The original fallback fails the requested-spacing assertion with the same test;
restoring byte-identical source passes. An earlier test incorrectly expected the
host harness to throw ordinary filesystem errors; its documented failure result
is asserted directly in the final test.

Item patterns are compiled once per receipt, retaining literal escaping and
word/hyphen boundaries. A bounded delegating constructor observer uses the
original `RegExp` implementation and real filesystem receipt persistence.
Metacharacter ids, exact and nearby ids, multiple text and JSON fragments,
inherited items, file associations, stable fact hashes, ordering and deduplication
are checked against explicit expected facts. Original source compiles 21
patterns instead of three for the text receipt and fails the constructor-count
assertion. Restoring exact source passes. This ordinary optimization provides no
security, resource-capacity or production-scale evidence.

Both unchanged release launchers pass 296 tests, with zero failures,
cancellations, skips or todos. The ten receipt tests pass. The six configured
native Node sources measure 3258/3258 lines, 1041/1041 branches and 220/220
functions; all counters are positive. The gate does not independently measure
statements. The full authored inventory remains eleven executable files.
All ten JavaScript/TypeScript files are included in the separate c8 observation:
statements and lines 3789/3837 (98.74%), branches 1158/1164 (99.48%), and
functions 102/103 (99.02%). Shell coverage remains unmeasured. Docstrings
pass for nine TypeScript files and 31 rule-selected declarations. These figures
do not claim whole-source four-metric coverage or documentation certification;
the existing coverage owner `pm-context-3s5f` retains that gap.

Fresh consumers install the same 17-file npm archive directly under current
SDK `2026.10.10` and minimum `2026.8.15`, using npm/Node and Bun/native Bun.
All four pass the governed built harness, actual CLI, session/citation/proxy
checks and the three existing retention rounds. The actual installed CLI also
passes both commands' pretty/compact fallback bytes and output-write failures;
direct packed receipt calls retain literal and inherited item associations.
Both `npx --no-install pm` and `bunx --bun --no-install pm` pass receipt/citation
checks in each consumer, with separate disposable trackers and the installed
SDK version checked. All four consumers typecheck the default export against
their actual SDK authoring `ExtensionModule` and required package metadata.
Every archive file matches its built source bytes. Current production and
development audits report zero findings; the minimum host graph separately
retains four high findings. Compatibility therefore remains a separate claim
from dependency audit cleanliness, whole privacy/quality and final review.

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
