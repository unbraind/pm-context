# Criterion evidence packing

`pm context-evidence` packs a producer's explicit acceptance criteria against
tracker field bindings. The SDK supplies authoritative reads and deterministic
candidate packing. This is criterion-level coverage, alongside context-pack's
neighborhoods, file focus and compression; it does not register a search provider.
Core context intents continue to own field projections. pm-review continues to
own reviewer attention and judgments.

Create `criteria.json` (replace the sample item with an existing tracker item):

```json
{
  "criteria": [
    { "id": "AC1", "text": "The implementation has linked tests", "evidence": [
      { "item": "sample-task", "field": "tests" }
    ] },
    { "id": "AC2", "text": "The interface is documented", "evidence": [
      { "item": "sample-task", "field": "docs" },
      { "item": "sample-task", "field": "description" }
    ] },
    { "id": "AC3", "text": "Independent acceptance review", "evidence": [] }
  ]
}
```

```sh
pm context-evidence --packet criteria.json --byte-budget 4000
pm context-evidence --packet criteria.json --byte-budget 2000 --format json
```

Every criterion remains in `criteria`, including its exact ID, text, required
binding count and packed count. `linked` means all declared bindings were packed;
`budget_omitted` means the whole criterion's evidence group was omitted; `unlinked`
means the producer declared no evidence. All bindings are required, with no
partial group or excerpt. A field binding is a top-level item field (or `body`),
not a JSON Pointer, local file path, URL fetch, or inferred match. Empty field
values remain exact recorded values and do not establish substantive acceptance.

The packer orders declarations by criterion ID using code-unit ordering, then
uses the core SDK's value-per-byte selection with equal scores and criterion rank
as the tie breaker. Smaller complete groups can fit before larger groups. It does
not claim an optimal set-cover solution, a monotonic selection across budgets,
or semantic sufficiency. Shared source bindings are read once per invocation;
shared evidence is repeated for each included criterion and charged each time.

`evidence` rows retain `criterion`, `item`, `field` and `value_json`. Parse
`value_json` to recover the exact JSON-compatible source value. This string
representation makes arbitrary nested fields lossless in both compact JSON and
TOON tables. Bindings cite the tracker field itself; linked files and URLs are
not opened, tests are not executed, and results are not judged or refreshed.

`source_fields_read` discloses all distinct fields read for sizing, including
those later omitted. `content_reviewed` is always false. Omitted evidence was
read for sizing only, never reviewed by this command. Only explicitly bound
fields enter the candidate set; there is no implied inspection of other tracker
items, fields, artifacts, or search results. Values reflect individual stable
source reads, not an atomic snapshot across the tracker.

The byte ceiling includes every citation, value, criterion, receipt, JSON/TOON
syntax byte, UTF-8 character and final newline. `byte_upper_bound` conservatively
includes its own decimal digits. It is a byte ceiling, not a tokenizer estimate.
Changing format changes costs, so pack and encode with the same format. The SDK
may leave a few bytes unused to reserve table headers and receipt count digits.

```ts
import {
  createFreshnessReader, packCriterionEvidence, encodeEvidencePack,
  readEvidencePacket, EvidencePackingError,
} from 'pm-context';

try {
  const packet = readEvidencePacket('criteria.json');
  const read = createFreshnessReader('.agents/pm', '.');
  const pack = await packCriterionEvidence(packet, read, {
    byteBudget: 4000, format: 'toon',
  });
  process.stdout.write(encodeEvidencePack(pack, 'toon'));
} catch (error) {
  if (error instanceof EvidencePackingError) {
    console.error(error.code, error.remedy);
  } else throw error;
}
```

For another backend, supply a `FreshnessReader`: an item-field projection returns
`{ [field]: { present: true, value: <JSON-compatible source value> } }` or
`{ [field]: { present: false } }`. Reject unavailable or incomplete reads. This
adapter keeps storage and access policy with the caller; it does not fetch hosted
data or invent missing evidence.

Refusals use `PmCliError`, exit 2, a typed `code`, `remedy`, and host `next_steps`:

| Code | Remedy |
| --- | --- |
| `INVALID_PACKET` | Supply 1–128 unique explicit criteria, at most 512 bindings, and supported fields only. |
| `INPUT_UNAVAILABLE` | Supply a stable regular readable UTF-8 JSON file of at most 262144 bytes. |
| `INVALID_ARGUMENT` | Use JSON/TOON and an integer byte budget from 512 to 262144. |
| `SOURCE_UNAVAILABLE` | Restore the named item/field or narrow bindings to at most 8388608 source bytes. No partial coverage result is issued. |
| `BUDGET_TOO_SMALL` | Increase the budget until all criterion identities and the complete receipt fit. |

The command is read-only and works in a plain tracker without Git or a Git
executable. No tracker data, settings, usage receipts, claims or history are
written. Packet input follows the same stable-file safeguards as context freshness.
