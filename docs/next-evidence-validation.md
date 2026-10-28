# Next-evidence validation

Public source: `unbraind/pm-context` main commit
`0a8e1db` (2026.10.28).

`test/validate-next-evidence-data.ts` runs against a disposable public tracker
snapshot in a plain directory outside Git. It uses SDK `listAllComplete` and
`certifyCompleteListResult` to orient, then freezes source files and fingerprints
the entire tracker before and after planning. Only the benchmark producer reads
source fields to declare costs; the planner receives no source reader.

Reproduce by exporting the public commit's `.agents/pm` tree into a scratch
non-git directory, then run:

```sh
node test/validate-next-evidence-data.ts <public-tracker-snapshot>
```

The snapshot contains **97 items**, with **36** having both explicit acceptance
criteria and linked tests. The benchmark producer selects six of those items and
declares seven missing criteria: six linked-test reads plus one deliberately
unavailable independent-review criterion. These are benchmark declarations, not
an assertion that the public items' original acceptance criteria were unmet.

Three overlapping available reads cover groups of four, four and six items.
Estimates use the UTF-8 bytes of serialized SDK item IDs and linked-test fields
divided by four and rounded up, plus a declared 40-token tool-call overhead.
This is a cost estimate, not measured inference usage or a model tokenizer.

| Measurement | Result |
| --- | ---: |
| Catalog reads / selected reads | 3 / 1 |
| Declared missing / covered / uncovered | 7 / 6 / 1 |
| Selected read estimated tokens | 523 |
| Selected read estimated tool calls | 1 |
| Selected combined cost | 563 |
| Alternative two-read combined cost | 915 |
| Compact JSON bytes, including newline | 869 |
| TOON bytes, including newline | 912 |
| Reads executed by planner | 0 |

The unavailable criterion is retained explicitly. Reversed input order produces
the same plan. Saved JSON revalidates; revised source contracts refuse with
`STALE_PLAN`. The tracker fingerprint is unchanged.

`test/next-evidence.test.ts` adds 500 seeded random operation sequences (seed
`0x2a105eed`), each with four operations: original declaration, revision change,
older-input replay and reordered input. Each operation round-trips JSON with
whitespace/CRLF variants and round-trips every plan through JSON and SDK-decoded
TOON, compares optimizer cost and uncovered criteria with an
independent exhaustive-subset model, and reads all authoritative native fields
and relationships back through the SDK-backed freshness reader against an
SDK-derived state model. There is no handwritten item normalization and no new
native-item import/export/sync path or replay/idempotency store.

A peer-interleaving regression injects SDK updates at all five planning workflow
boundaries on one non-git tracker. Earlier revision changes refuse at validation;
a later peer success is preserved. A foreign record remains byte-identical.
There is no shared mutable plan state or package-owned claim/lease/checkpoint/
outbox/budget/promotion transition. Installed CLI tests remove Git from PATH and
set the Git discovery ceiling, and fingerprint all tracker files before/after.

Behavioral revert proof, with rebuilds before each run:

- Replacing only exact cover selection in `planNextEvidence` with marginal-ratio
  greedy selection makes `node --test --test-name-pattern="exact cover beats"
  test/next-evidence.test.ts` fail: it selects `ab,bc` costing 60 instead of `all`
  costing 55.
- Bypassing only the contract mismatch refusal in `validateNextEvidencePlan`
  makes `node --test --test-name-pattern="saved JSON plans"
  test/next-evidence.test.ts` fail on the missing stale-plan exception.

Both behaviors were restored and rebuilt before verification. Full npm/Bun
release evidence is supplied by CI, at the repository's unchanged thresholds.

The refreshed overlap check found the feature already delivered by PR 176 and
the numeric round-trip repair by PR 183. This change preserves that v1 planner
and fixes its remaining sparse-array boundary defect. Core SDK
`packContextCandidates` selects projections of existing ranked candidates under
a budget; it does not solve the caller-declared missing-criterion acquisition
cover. SDK complete-list certification and TOON table codecs remain reused.
No new tracker mutation, status interpretation, execution, import/export/sync,
journal or shared mutable state is introduced.

The additional boundary corpus tests holes and inherited elements in every
array, maximum-length sparse arrays, serialization hooks, 500 seeded invalid
mutations (seed `0x48cd1028`), maximally escaped bounded packets, and a synthetic
fixture produced by the released implementation at the source commit above.
Source and compiled SDK producers preserve JSON/TOON round trips; invalid input
fails with a typed remedy before optimization. Numeric outputs continue to use
the existing finite safe-integer gate, with exact integer cross-products for
coverage/cost ranking. Native state is read back through the SDK in the existing
500-sequence model and peer-interleaving tests.

The boundary behavioral revert replaces only `parseNextEvidencePacket` with its
main implementation in a disposable package copy, rebuilding before each run.
`node --test --test-concurrency=2 --test-name-pattern="dense packet schema"
test/next-evidence.test.ts` fails with a missing refusal (1 failed), then passes
after restoring the fixed parser and rebuilding (1 passed). The package worktree
is never mutated by this proof.

The command guard regression uses a real plain tracker and source/compiled
command harnesses. Supplied empty or non-string check/format flags must refuse
before a deliberately absent packet can be opened; omitted and valid options
still work. Reverting only the command handler to the preceding implementation
in a disposable copy, rebuilding, then running
`node --test --test-concurrency=2 --test-name-pattern="supplied unusable"
test/next-evidence.test.ts` fails (1 failed); restoring and rebuilding passes
(1 passed).

`test/validate-next-evidence-installations.ts` accepts a captured npm tarball and
checks host versions, JSON, saved-plan revalidation, SDK-decoded TOON and
unusable-check refusal through npm global,
Bun global, npx, bunx, npm project-local and Bun project-local hosts. Global
directories are isolated, the host version is the repository pin, npm lifecycle
scripts are disabled (including cached launches), explicit Bun installs disable
scripts, and inherited credential variables are excluded. It verifies the same
artifact SHA-256 after each launcher and removes
only its own scratch directories. Run it separately from unit tests because it
performs public registry installs:

```sh
node test/validate-next-evidence-installations.ts <captured-package.tgz>
```

Measured result: **6/6 launchers**, **36/36 assertions**, using host
`2026.10.25` and one unchanged archive containing **49 entries**, **133017 packed
bytes** and **577676 unpacked bytes**. Artifact SHA-256:
`d07a1702317758f0b4530af62f5ad6615cb18ac8ca8cf360c3a8e19e02bfd54a`.
The archive is a local validation artifact and is not committed or published.

The final complete focused linked run passed **13/13 tests**, zero failures or
skips, with **100% lines, branches and functions** for `next-evidence.ts`.
