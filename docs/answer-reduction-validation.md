# Answer reduction validation

Public tracker source: `unbraind/pm-context` main commit
`363e8bc5092faa9c48909ac3e2ebe8ce93c0f556` (package 2026.11.1,
pinned host SDK 2026.11.4).

The measurement script copies a committed public tracker export into a non-git
scratch directory, rejects symlinks, makes every copied file read-only, and uses
SDK-certified complete listing through `readFileFocusItems`. The source tracker
is never modified. The entire copy is fingerprinted before and after reduction.

```sh
node test/measure-answer-reduction.ts <public-tracker-export>
```

Of **102 public items**, the benchmark selects four distinct existing descriptions
(`pm-context-m6cr`, `pm-context-s8q4`, `pm-context-a9iw`, `pm-context-cilu`), totaling
**5,071 UTF-8 bytes**, plus the first item's title. It declares the two-variable
routing task in `test/answer-reduction-fixture.ts`: urgency changes the route;
background detail does not. These are explicit benchmark task declarations, not
claims that the original items are irrelevant to their own work. No source text
is repeated or padded. Four descriptions are omitted, and all four input
combinations retain their answers; both representations are checked independently
(eight answer comparisons). The two background branches carry cofactor proofs.

| Transport | Full bytes | Reduced bytes | Saved bytes | Reduction |
| --- | ---: | ---: | ---: | ---: |
| JSON | 7,600 | 2,526 | 5,074 | 66.7632% |
| TOON | 7,625 | 2,547 | 5,078 | 66.5967% |

Measurements include the complete contract, source revisions, routing table,
branch certificates, omission rows, remedies and trailing newline. Acceptance
uses exact integer `2 * reduced_bytes <= full_bytes`; percentages are display
only. Saved output revalidates against the same native revisions, and the file
list and tracker fingerprint remain identical. A single short description does
not achieve 50% because fixed proof overhead dominates; this is not a universal
compression guarantee.

## Regression and state evidence

`test/answer-reduction.test.ts` covers source and compiled SDKs, exact eq/neq and
first-match semantics, interacting inputs, constant and empty-variable tasks,
unsupported predicates, limits including 4,096 combinations, sparse/exotic
inputs, finite output checks, per-field failures, malformed certificates,
revision ABA replay, CLI guards and JSON/TOON agreement. The installed CLI runs
with a PATH containing no Git and a Git discovery ceiling. Both tracker source
and foreign records remain unchanged. The documented JSON example equals the
same tested routing fixture.

`test/answer-reduction-model.test.ts` seeds 500 random operation sequences with
`0x5a11c026`. It updates a real native Issue under random ambient focus, varies
custom status names using the SDK registry roles, parent/dependency relationships,
all native populated fields, whitespace/CRLF and older input declarations. The
reference model is read back through SDK `get`; native field inventory comes from
the SDK document reader, excluding absent optional properties via JSON transport.
No local status/field normalization is used. Each sequence exercises fresh and
older requests in full/reduced form, validates both encodings, revalidates saved
packets against current SDK revisions and checks unchanged tracker bytes before
SDK read-back. There is no new native import, sync, mutation or journal path.
Before randomized status transitions, a baseline packet round-trips all **52
populated native fields**; later absent terminal-result fields follow SDK state.
The passing run completed **4,000 JSON/TOON round trips** and **8,000 independent
routing answer checks**. The linked focused run passed **15/15 tests**, with zero
skips, cancellations or failures; the command-registration check passed 1/1.

A separate real-tracker interleaving regression injects a competing SDK update at
every one of the native reader's four item/history observation boundaries. Mixed
reads become explicit unknowns. A write after the final observation preserves the
observed revision receipt; subsequent validation detects it as stale. The peer's
successful state and a foreign file are preserved. No package-owned leases,
checkpoints, outboxes, budgets or promotions exist on this read-only path.

Behavioral reverts run only in disposable copies, rebuilding `dist` before the
regression. Disabling the omission condition in `project` fails the exhaustive
routing test. Bypassing the current-revision comparison in
`validateAnswerReduction` fails the same test's ABA replay assertion. The working
implementation is rerun after these mutations; the delivery worktree is never
mutated for the revert proof.

Focused commands:

```sh
npm run typecheck
npm run build:test
npm run docstring
node --test --test-concurrency=2 test/answer-reduction.test.ts test/answer-reduction-model.test.ts test/renderer-ownership.test.ts
pm test pm-context-ubo1 --run --progress --timeout 900
npm run changelog:check
npm run audit:prod
```

The repository has no separate lint script; its docstring gate and TypeScript
checks are run unchanged. Targeted c8 measurement covers `answer-reduction.ts`
with **100% statements, branches, functions and lines**. This is feature-scope
coverage; the full unchanged npm and Bun release gates run in CI.

## Packed acquisition

`test/validate-answer-installations.ts` installs one captured npm artifact into
isolated npm/Bun project-local installs, npm/Bun global prefixes, and npx/bunx
launchers. Every mode installs the extension through the native package command
and exercises full/reduced JSON, TOON, saved revision checks, typed refusals and
artifact digest stability against host 2026.11.4. Credentials are excluded from
child environments. No actual global installation is changed.

```sh
node test/validate-answer-installations.ts <captured-package.tgz>
```

The PR carries the artifact digest, launcher counts and exact-head CI run URLs.
No package is published by this validation.

Captured artifact SHA-256:
`e0a519d38f618d72777186671f975321f93e749cbbd68eb906fb23564ae12564`.
The artifact contains 57 files (655,809 unpacked bytes); its digest remained
unchanged across **6 launcher modes / 42 assertions**. Binary tarballs remain
untracked. The build used for the tests is the committed generated output.

## PR 213 review regressions

`test/answer-reduction-review.test.ts` walks every nested container in request,
source and saved-packet fixtures. It rejects custom/null prototypes, subclass
arrays, transparent/revoked/trapping proxies, accessors, hidden properties,
symbol additions and sparse arrays. Rejections do not invoke validation hooks.
Ordinary JSON, frozen declarations and SDK objects with optional undefined
fields remain supported. A malformed representation object receives
`INVALID_OUTPUT` without string coercion.

Escaped-string tests cover a single oversized serialized value, cumulative
serialized overflow, and later healthy fields that must retain the unconsumed
raw-source budget. Both full and reduced representations are checked through
source and rebuilt SDK exports. Packet overhead is reserved before source
acceptance. The measurement regression uses only disposable data and verifies
original file/directory modes after refusing a linked export root.

Behavioral mutations are built and run in disposable copies. Removing each of
object enumerability, array prototype, object proxy, array proxy or array-element
enumerability guards fails its shape matrix. Restoring the original source
acceptance function fails the escaped-size test. Restoring output representation
coercion fails the saved-packet matrix. Removing the export-root guard fails the
permission regression. Replacing all-dependency omission with any-dependency
omission fails the mixed-dependency retention assertion. Fixed implementations
are rebuilt and rerun after these checks.

An additional routing-budget regression refuses an oversized 4,096-row packet
before source reads, while accepting the same table with narrower values.
Removing that early guard also fails its behavioral mutation check.
Escaped routing values can exceed the existing saved-file byte ceiling while
fitting the character limit. A separate regression checks refusal before reads,
per-source byte overflow without consuming peer budget, and a large accepted
packet read back through the real saved-file reader. The producer reserves the
JSON newline and shares its byte ceiling with that reader.

The packed-installation acceptance also requires a proved packet, the exact
retained routing title, and an omitted background fragment: **10 assertions per
launcher / 60 total**, in addition to preserving the captured artifact digest.
The artifact digest and counts above describe the earlier feature baseline;
review-round artifact and release-gate receipts are recorded on the PR and its
pm item.
