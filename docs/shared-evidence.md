# Shared-fragment evidence

`pm context-evidence-shared --packet criteria.json` emits each identical,
revision-bound field fragment once within a criterion packet. Every use remains
a separate binding with `criterion`, `item`, `field`, `id` and `context_ref`.
Join `bindings[].id` to `fragments[].id`; `context_ref` is
`packet:fragments:<id>`. This follows the host's `id`/`context_ref` convention,
with packet scope rather than pretending to be a persistent output session.

```json
{
  "criteria": [
    { "id": "AC1", "text": "Implementation evidence", "evidence": [
      { "item": "sample-task", "field": "description" }
    ] },
    { "id": "AC2", "text": "Handoff evidence", "evidence": [
      { "item": "sample-task", "field": "description" }
    ] }
  ],
  "byte_budget": 16000,
  "format": "toon",
  "representation": "factored"
}
```

Replace `sample-task` with an existing native item. The two bindings reference
one fragment containing `revision` and lossless `value_json`. Parse `value_json`
as JSON to recover nested tests, documents, relationships or other native fields.
Only declared top-level fields are evidence; linked files and URLs are not
opened and tests are not executed. `linked` describes declared binding coverage,
never substantive acceptance or reviewer approval.

```sh
pm context-evidence-shared --packet criteria.json
pm context-evidence-shared --packet criteria.json --format json
```

Set `representation` to `expanded` to emit independent `evidence` rows with
the same coordinates, fragment identities, revisions and exact values. Both
modes retain the canonical `fragments` registry: every `context_ref`, including
those on expanded rows, resolves to exactly one target. Expanded values also
remain inline, so this compatibility mode repeats text in addition to its
registry copy. All registry bytes count toward the byte ceiling. At a
sufficient budget, either representation covers exactly the same criteria.
At the same smaller budget, factoring can admit more whole criteria. The
existing `context-evidence` v1 command and SDK output retain their format.

```ts
import {
  createSharedEvidenceReader, packSharedEvidence, encodeSharedEvidence,
  SharedEvidenceError,
} from 'pm-context';

try {
  const pack = await packSharedEvidence({
    criteria: [
      { id: 'AC1', text: 'Retain implementation evidence', evidence: [
        { item: 'sample-task', field: 'description' },
      ] },
    ],
    format: 'json', byte_budget: 16000,
  }, createSharedEvidenceReader('.agents/pm'));
  process.stdout.write(encodeSharedEvidence(pack, 'json'));
} catch (error) {
  if (error instanceof SharedEvidenceError) console.error(error.code, error.remedy);
  else throw error;
}
```

The request uses the existing criterion schema: 1–128 unique IDs, nonblank
texts of at most 1024 characters, at most 512 bindings, and at most 262144 input
bytes. Arrays must be dense; unknown keys and duplicate bindings within a
criterion refuse. Optional controls are `byte_budget` (safe integer 512–262144,
default 4000), `format` (`json|toon`, default TOON) and `representation`
(`factored|expanded`, default factored). CLI `--format` overrides the request;
host `--json` selects JSON when no explicit format flag is supplied.

Both representations use the same producer and sizing projection. The SDK
selects whole criterion groups using integer byte costs, with deterministic
criterion ranks; costs are recomputed after each admission to charge shared
fragments once. This is conservative greedy selection, without an optimality or
monotonic-selection guarantee. All criterion receipts remain present: `linked`,
`budget_omitted` or `unlinked`, with required/packed binding counts. No partial
criterion, dangling reference or unreferenced fragment is emitted. All source
reads, including evidence omitted after sizing, are counted by
`source_fields_read`; `content_reviewed` remains false.

The complete UTF-8 byte ceiling includes Unicode, quotes, all tables, coverage
receipts, the counter itself and the final newline. `byte_upper_bound` is a
conservative self-inclusive bound. Pack and encode with the same format. Small
fragments may cost more in factored form because citations and revision
identities still occupy bytes. Factoring is exact JSON serialization equality,
not whitespace normalization or semantic similarity.

The native adapter uses supported SDK item and history reads. A revision binds
the complete native item state and history bytes; a changed item, even one
whose text was later restored, receives a distinct revision. Unrelated edits
conservatively invalidate all fragments from that item. Missing legacy history
is supported with a state-bound revision. Both item and history are reread to
detect interleaving. There is no global snapshot, lock or transaction isolation;
a writer can still act after the last read, and different fields may reflect
different stable read boundaries. This command has no write, import, sync,
checkpoint or recovery path, and requires no journal or idempotency key.

For other backends, supply a `SharedEvidenceReader` returning
`{ revision, value }` for each `{ item, field }`. Revision strings are portable
1–256 character identifiers and must identify the authoritative source version,
including revision scope across items; a content hash alone cannot distinguish
an ABA edit. Equal revision/value pairs can share across items while every
citation remains in the bindings. Distinct revisions or values never collapse.
Readers must reject unavailable or incomplete data. Source values must be
finite JSON data (dense arrays, bounded depth/nodes); optional SDK object keys
with `undefined` use native JSON omission. Strings retain exact whitespace and
line endings. Aggregate serialized source values are limited to 8388608 bytes;
native history snapshots above that size refuse after SDK acquisition. The SDK
owns history-read allocation. Producer output counters are checked for finite
safe integers and documented ranges before returning. Encoding also rejects
missing or duplicate targets, unknown criterion references, mismatched expanded
values/revisions, and unreferenced fragments with typed `INVALID_OUTPUT`.

| Refusal | Remedy |
| --- | --- |
| `INVALID_REQUEST` | Correct the closed request schema and bounded transport controls. |
| `SOURCE_UNAVAILABLE` | Restore the named fields, finite values and authoritative revisions; retry after concurrent changes settle or narrow sources. No partial packet is issued. |
| `BUDGET_TOO_SMALL` | Increase the budget to retain every criterion identity and its coverage receipt. |
| `INVALID_OUTPUT` | Regenerate through the SDK producer and encode in the same JSON/TOON format. |
| `INPUT_UNAVAILABLE` | Supply a stable regular readable UTF-8 JSON file within the input ceiling. |

All refusals use the host `PmCliError` contract, exit 2 and concrete `next_steps`;
builder refusals also expose `remedy`. Existing released native fields remain
readable, including empty collections and arbitrary nested relationship data.

## Without git

The SDK and CLI work in a plain tracker with no Git executable. Packet reads
write no tracker data, settings, caches, usage receipts, claims or history.
Core output sessions continue to handle reuse across calls, pm-memory owns
durable knowledge, and pm-evidence owns citation resolution/freshness. This
feature only factors exact evidence inside one criterion packet.
