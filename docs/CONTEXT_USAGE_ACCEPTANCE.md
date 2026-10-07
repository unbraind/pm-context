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
removes the least recently written snapshots. Failed output-file writes roll
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
source list or exemption changed. The source gate reports statement coverage
through Node's native line/branch/function counters rather than a separate
statement threshold.

Both release commands passed with 295 tests and 100% lines/branches/functions
across six configured sources. The nine dedicated receipt tests passed. Fresh
npm and Bun consumers installed the packed tarball and pinned host, activated
the extension with the real CLI, and exercised serving, citation and reporting.
Node and native Bun both returned two served facts, one used fact, precision
0.5, positive unused-token cost, and a JSON handoff receipt.

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
