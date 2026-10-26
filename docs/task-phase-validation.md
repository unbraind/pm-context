# Task-phase context validation

Tracked by [pm-context-task-phase-contracts](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-task-phase-contracts.toon).

## Scope and overlap

Core SDK intents own projection declarations and resolution. Core output sessions
own reference syntax and budget accounting. Existing `context-evidence` ranks
criterion groups, `context-freshness` detects source changes and `context-handoff`
summarizes handoffs. Sibling pm-brief summarizes context, pm-review evaluates
review evidence, pm-memory stores memories and pm-rlm coordinates inference.
The added contract requires caller-selected fields for an explicit task phase,
with all-or-refuse retention and an explained requirement diff. It grants no
agent authority and performs no lifecycle transition.

SDK reuse: `composeContextIntentContracts`, `resolveContextIntentContract`,
`createOutputOmissionReceipt`, `parseReadOutputSession`,
`applyReadOutputSessionReferences`, `attachReadOutputSessionReceipt`, plus the
existing cache-free `createFreshnessReader` built on SDK settings, item location
and document parsing. TOON uses the same codec as the host, declared as a direct
production dependency. The pinned pm SDK remains 2026.10.23; the current CLI
registry version was checked as 2026.10.25.

## Reproduce

```sh
npm run build
npm run build:test
node --test test/task-phase.test.ts test/renderer-ownership.test.ts
npm run typecheck
npm run docstring
node test/task-phase-public.ts "$PUBLIC_TRACKER_SNAPSHOT"
```

Only export committed `.agents/pm` files from the public repository. The public
runner creates its own non-Git copy, makes every source file and directory read
only, removes Git from PATH, and checks complete before/after hashes. It opens no
linked artifacts and executes no linked tests. No hosted data is used.

## Public tracker measurements

Snapshot: `unbraind/pm-context@41fa36e1eae25b7ce692de6b9d198c0b05730acd`.
The corpus contains **93 items and 1,794 source fields**. All 744 phase/format
requests use the default 16,000-byte transport ceiling.

| Phase | Successful packets | Typed refusals |
| --- | ---: | ---: |
| Investigation | 186 | 0 |
| Implementation | 184 | 2 |
| Review | 102 | 84 |
| Handoff | 186 | 0 |

The 84 review refusals report missing acceptance-criteria fields; the two
implementation refusals report an insufficient budget for the mandatory body.
These counts include both encodings. Every success retains both mandatory
values: **1,316 exact value comparisons** and **11,518 omitted field selectors**.
There are **92 successful investigation-to-implementation switches**, each
reusing one unchanged SDK title reference and serving the newly required body.
The remaining switch refuses its body budget. Every source byte remains unchanged.

| Encoding | Successful packets | Total UTF-8 bytes | Min | Max |
| --- | ---: | ---: | ---: | ---: |
| JSON | 329 | 1,168,385 | 2,245 | 7,687 |
| TOON | 329 | 983,116 | 1,885 | 6,929 |

Sizes include explanations, bindings, facts, omission receipts and final newline.
They are transport measurements rather than tokenizer measurements.

## Behavioral guarantees

The seeded model test runs 500 operation sequences with five packet operations
per sequence. Each sequence changes native fields and a relationship through the
SDK, then checks a current request, phase switch, older request replay, optional
field restoration and older session replay. It compares every delivered/reused
value with current state read through SDK `get`, then reads state back after
every operation. Standard JSON transport handles SDK optional object properties;
there are no handwritten normalization rules. Native strings, whitespace/CRLF,
numbers, booleans, relationships, hierarchy and all seeded linked collections
participate. Packet operations preserve complete tracker hashes.

The feature has no tracker import/export/sync writer, journaled mutation plan,
outbox or shared mutable checkpoint. Requests import declarations, not item
state; JSON/TOON exports are read-only. Mutation idempotency keys and plan
recovery are therefore inapplicable. Field fact ids include target coordinates
and current values; replay always rereads the target. Caller-carried sessions
must be sequenced by the caller rather than concurrently merged.

Statuses pass through unchanged and no role-based selection occurs. Randomly
named registered active statuses remain visible. Concurrent fixtures also cover
custom active, blocked, terminal-done and terminal-canceled registry roles with
eight independent readers per role on one non-Git tracker. A foreign runtime
record and every source byte remain unchanged. No package path acquires leases,
changes budgets on disk, deletes foreign records or persists state.

## Revert proof

Temporarily change only `buildPhaseContext` to retain the first mandatory field:

```sh
node --test --test-name-pattern='four real SDK phase fixtures' test/task-phase.test.ts
```

Result: **1/1 failed** because the packet retained one binding instead of two.
Restore that selection, then bypass only SDK reference suppression:

```sh
node --test --test-name-pattern='phase switches reuse unchanged' test/task-phase.test.ts
```

Result: **1/1 failed** because the unchanged title was delivered in full instead
of retaining its SDK reference. Exact source bytes were restored after each
probe. The complete tests run with both behaviors restored.

## Local targeted gates

`test/task-phase.test.ts`: **8/8 passed**, including the 500-sequence model.
`test/renderer-ownership.test.ts`: **7/7 passed**. There are no skipped tests.
Targeted c8 measurement of `task-phase.ts`: **100% statements, branches,
functions and lines**. Typecheck, test typecheck, build, docstring and changelog
checks pass. The package defines no separate lint script. The linked four-phase
test also passes through `pm test --run --progress` (**1/1**); result tracking is
disabled, so its receipt is retained in the pm item comment.

The full unchanged-threshold npm and Bun release gates run in CI, rather than
on the saturated shared host. Their exact-head results and run URL are reported
in the pull request. Local strict health sees an existing host-global pm-github
extension/version mismatch; the fresh CI checkout determines release-gate health.
