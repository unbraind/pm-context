# Next-evidence validation

Public source: `unbraind/pm-context` main commit
`ff1b9e90fd0043f6aa778cea4f03598e453b2610`.

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

The snapshot contains **91 items**, with **31** having both explicit acceptance
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
