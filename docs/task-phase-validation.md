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
| JSON | 329 | 1,801,950 | 3,305 | 10,741 |
| TOON | 329 | 1,772,334 | 3,214 | 10,651 |

Sizes include explanations, bindings, facts, omission receipts, command argv and final newline. These figures were rerun after adding safe command suggestions; the earlier product-head CI receipt below predates that additive wire-format change.
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

The CLI also preserves raw overrides for the same strict schema. Replacing only
that adapter's raw phase/format read with the older trim-and-ignore helper makes
the installed/host regression fail **1/1**, with `Missing expected rejection`
for a blank phase. The source is restored exactly afterward. Blank phase,
previous-phase, field, budget and format flags refuse through the installed
parser; source and compiled host cases cover wrong types and malformed roots too.

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

## Full CI receipt

[Run 40262690108](https://github.com/unbraind/pm-context/actions/runs/40262690108)
validates product head `3508a58851cba2709055a1d169f4fbeaac26f715`.
Both `npm run release:check` and `bun run release:check` pass on Node 22 and 26:
**419/419 tests per gate, no failures or skips** (1,676 aggregate passes).
Native coverage covers 15 sources at 100% lines, branches and functions. c8
reports 100% statements/functions/lines and 99.95% branches at the unchanged
99.9% branch threshold; `task-phase.ts` measures 100% in all four dimensions.
Fresh tracker health, committed-output verification, dependency audit, package
dry run, changelog and publication-attestation checks pass. CodeQL also passes.
The final pull request reports the subsequent evidence-only head's CI run too.

## Command suggestion review correction

Blocking review of PR 181 found unquoted omitted metadata keys in shell restore
commands. `buildSuggestedCommand` now validates/copies argv before rendering;
`quotePosixArgument` is the only POSIX display quoting function. It leaves plain
safe tokens readable, quotes all other arguments with single quotes, escapes
embedded apostrophes and refuses NUL bytes. Phase bindings/omissions, handoff
refreshes, file-focus flags/link guides, delta recovery and registered examples
all use this path. JSON/TOON outputs retain executable arrays. `commandExamples`
returns fresh structured host examples. Legacy shell-string overrides refuse.

The core SDK supplies a legacy placeholder display without argv. The package
omits that field and supplies `session_restore` with quoted display and argv;
SDK charging conservatively includes its internal legacy template. Concrete
field facts always restore through the binding's `restore_argv`.

`test/suggested-command.test.ts` checks 500 seeded random key/value commands,
including spaces, quotes, operators, substitutions, backticks, control characters,
leading hyphens, Unicode and empty values. A real POSIX shell splits each display
and NUL-frames the resulting argv; exact equality and absence of a marker file
prove transport fidelity. Real non-Git SDK metadata includes the fixed
`a;printf X` review key. Both JSON and TOON outputs, handoff selectors, linking
examples and typed recovery commands undergo the same shell check.

Behavioral revert: restore only interpolation of the omitted key in
`buildPhaseContext`, preserving the structured argv and every test. Run:

```sh
node --test --test-name-pattern='fixed review key' test/suggested-command.test.ts
```

Result: **1/1 failed**. The shell returned field `a` instead of `a;printf X` and
lost the trailing output-budget arguments. Exact source bytes were restored;
all three command tests pass with the builder. Targeted renderer coverage is
100% statements/branches/functions/lines. The PR records the correction's final
npm and Bun CI run separately from the earlier product-head receipt above.
