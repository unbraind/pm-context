# Next-evidence acquisition plans

Evidence packing chooses facts already present. Acquisition planning chooses
which missing facts to read next. The caller declares which criteria lack
sufficient evidence, which reads are available, their coverage, source revision
contracts and costs. The planner does not infer missing criteria, fetch sources,
inspect tracker data, invoke models, or execute diagnostics. `pm-ops` owns
approved operational execution; `pm-rlm` owns model-driven decomposition.

For example, save this as `acquisition.json`:

```json
{
  "contract_revision": "acceptance-v1",
  "missing": ["AC1", "AC2", "AC3"],
  "tool_call_tokens": 10,
  "reads": [
    {"id":"first","source":"tracker","revision":"r7","covers":["AC1","AC2"],"estimated_tokens":20,"estimated_tool_calls":1},
    {"id":"second","source":"tracker","revision":"r7","covers":["AC2","AC3"],"estimated_tokens":20,"estimated_tool_calls":1},
    {"id":"combined","source":"tracker","revision":"r7","covers":["AC1","AC2","AC3"],"estimated_tokens":45,"estimated_tool_calls":1}
  ]
}
```

```sh
pm context-next-evidence --packet acquisition.json
pm context-next-evidence --packet acquisition.json --format json > plan.json
pm context-next-evidence --packet acquisition.json --check plan.json --json
```

The combined read costs 55 token equivalents, compared with 60 for the two
smaller reads. Exact set-cover optimization chooses `combined` even though each
smaller read has a better standalone coverage/cost ratio. Among minimum-cost
covers, the first discovered cover in ascending read-ID order wins. Selected
reads are then ordered by newly added criteria per combined cost, with read-ID
ties. `adds` reports only criteria not covered by an earlier step. Every read
has positive combined cost, so optimal plans contain no redundant reads.

Cost is `estimated_tokens + tool_call_tokens * estimated_tool_calls`. The
positive tool overhead is caller policy, not a measured tokenizer or latency
estimate. There is no budget ceiling or approximate fallback. The result covers
all coverable criteria at minimum declared combined cost. `uncovered` discloses
criteria outside the catalog's union; an empty catalog returns every missing
criterion as uncovered. An empty missing set produces a zero-cost plan. Coverage
is a declaration, never proof of semantic sufficiency or completed acceptance.

```ts
import {
  readNextEvidenceJson, planNextEvidence,
  validateNextEvidencePlan, encodeNextEvidencePlan, NextEvidenceError,
} from 'pm-context';

try {
  const packet = readNextEvidenceJson('acquisition.json');
  const plan = planNextEvidence(packet);
  process.stdout.write(encodeNextEvidencePlan(plan, 'json'));
  validateNextEvidencePlan(plan, packet); // revalidate with CURRENT caller revisions
} catch (error) {
  if (error instanceof NextEvidenceError) console.error(error.code, error.remedy);
  else throw error;
}
```

The `contract` SHA-256 binds the canonical full packet, including **every** read
source and revision, criterion contract revision, missing ID, coverage declaration
and cost. Input ordering is immaterial. Revision strings remain exact, including
whitespace and CRLF. Reads of the same source must declare the same revision.
`--check` verifies both this digest and the entire deterministic saved plan;
modified steps, costs and omissions refuse. Saving/checking supports JSON only;
TOON is for compact agent display. In TOON, `adds` is a JSON-encoded cell; parse
that cell as JSON, or restore rows with the core SDK `decodePmTableRows`
and the emitted `steps_encoding` metadata. Encoding uses the corresponding SDK
`encodePmTableRows` helper. Top-level missing/uncovered arrays are native TOON arrays.

The caller must supply current revisions before use; validation does not discover
remote changes. Plans are observations of a declared immutable contract, not
execution authorization, locks, reservations or idempotency keys. No mutable
plan store, tracker import/export/sync path, claim, lease, checkpoint, outbox or
budget counter is introduced. Arbitrary foreign tracker records are never
opened or changed. Concurrent callers operate on independent value snapshots;
there is no shared write transition to lease or drain. A regression injects
a peer SDK update at all five snapshot/planning/serialization/validation/return
boundaries on one plain tracker, preserves peer success and foreign records,
and refuses revisions that changed before revalidation.

Input files are bounded to 262144 UTF-8 bytes, 12 unique missing IDs and 64 unique reads;
exact dynamic programming uses at most 4096 coverage states. Nothing is silently
truncated. `missing`, `reads` and every `covers` array must be dense, including
SDK inputs: holes and inherited array elements refuse with `INVALID_PACKET`.
Array bounds are checked before traversal, cloning or serialization, so even
maximum-length sparse arrays cannot trigger unbounded serialization work.
The canonical packet contains only bounded primitive fields and fits below the
file byte ceiling, including maximally escaped revisions. Caller `toJSON` hooks
are never invoked. Both `planNextEvidence(unknown)` and
`validateNextEvidencePlan(plan, unknown)` use the same strict packet parser;
the CLI passes raw JSON directly to that boundary. `parseNextEvidencePacket`
remains available when a caller needs a canonical packet separately. Released
v1 packet hashes and saved plans remain compatible.

Tokens are integers 0–1000000, calls 0–1000, and tool overhead
1–1000000; each read must have positive tokens or calls. All packet and plan
outputs use finite safe integers and canonical positive zero, including SDK
objects, JSON and TOON. Step cost is 1–1001000000. Plan totals are bounded by
the 64-read catalog: tokens 0–64000000, calls 0–64000 and cost
0–64064000000; `reads_executed` is always 0. Encoders reject numeric values
outside these ranges rather than emitting JSON null or silently truncating them.
Signed zero in input estimates is equivalent to zero and does not alter the
contract digest. JSON stringify/parse preserves every emitted number by
`Object.is`, so an unchanged saved plan passes `--check`. IDs use 1–128 ASCII
letters/digits/underscore/dot/colon/hyphen starting with a letter/digit. Revision
strings are 1–256 characters and nonblank. Unknown qualifiers and unknown or
duplicate criterion references refuse, including unsupported execution commands,
budgets and constraints. Larger tasks must be explicitly partitioned by callers;
optimality then applies within each partition, not across it.

Refusals use `PmCliError`, exit 2, a typed `code`, `remedy` and host `next_steps`:

| Code | Remedy |
| --- | --- |
| `INVALID_PACKET` | Correct bounded unique declarations, costs, revisions and known coverage IDs; remove unsupported qualifiers. |
| `INPUT_UNAVAILABLE` | Supply a stable readable regular UTF-8 JSON input no larger than 262144 bytes. |
| `INVALID_ARGUMENT` | Supply `--packet`, JSON/TOON format, and no positional arguments. |
| `STALE_PLAN` | Replan against current contracts, revisions, coverage and costs. |
| `INVALID_PLAN` | Supply an unmodified JSON plan generated from the current packet. |

Validation includes a seeded exhaustive-subset reference model over 500 random
operation sequences with replayed older inputs, CRLF and whitespace variants,
revision changes, reorderings and JSON/TOON round trips. The numeric property
suite also exercises 500 generated plans with signed zeros,
boundary estimates, empty catalogs and full catalogs through JSON/TOON and
source/built command `--check` handlers. Every operation reads native
state back through the SDK and compares it with its SDK-derived reference,
including relationships and all native fields. Planner calls never normalize,
import or write native items. Installed CLI checks run in a plain tracker with
Git absent from PATH and a Git discovery ceiling.
An additional 500 seeded boundary mutations cover sparse arrays and extreme
numbers through source and compiled SDK entry points. A fixture produced by
the released version preserves its original plan byte values and digest.
