# Answer-sensitive context reduction

`pm context-reduce` removes source fields that cannot change the answer of an
explicit finite routing task. It evaluates every declared input combination;
there is no sampling, inference, text interpretation or tracker mutation.

Start with [the routing example](examples/answer-reduction.json), replacing
`routing-task` with a real item ID:

```sh
pm context-reduce --packet routing.json --format toon
pm context-reduce --packet routing.json --format json > reduced.json
pm context-reduce --packet routing.json --representation full --json > full.json
pm context-reduce --packet routing.json --check reduced.json --json
```

The table declares `urgent` and `background`. Both background branches route
urgent tasks to `priority`; other tasks route to `normal`. Thus the description
can be omitted under the caller's declaration that it influences the task only
through `background`. The title remains because it depends on `urgent`.

## Contract and limits

Each request has exactly `contract_revision`, `variables`, `rules`, `fallback`
and `fragments`. Variables have unique IDs and nonempty, unique scalar domains.
Rules are evaluated in order: the first rule whose `when` predicates all hold
supplies `answer`; otherwise `fallback` supplies it. Empty `when` matches always.
`eq` and `neq` compare exact values without coercion, trimming or arithmetic.
Unknown operation names are accepted but **the entire predicate analysis becomes
unknown**: all available fragments remain, routing and proofs are empty, and the
remedy asks for a supported explicit table. Even an unreachable unsupported rule
is treated conservatively.

Each fragment binds an SDK-native top-level `{item,field}` and declares its full
set of influencing `variables`. An empty set explicitly declares independence
from every input. Values can be text, links, relationships or other native JSON
fields. The package never assigns meaning to status names; declare domain values
using your application's SDK status-registry roles if the task depends on them.

| Bound | Maximum / domain |
| --- | --- |
| Variables / values per variable | 8 / 8 |
| Cartesian input combinations | 4,096 |
| Rules / predicates per rule | 64 / 8 |
| Fragments / dependency variables per fragment | 64 / 8 |
| Identifier | 1–128 ASCII letters, digits, `_`, `.`, `:`, `-`; starts alphanumeric |
| Revision, answer, string scalar | 256 characters; revision and answers nonblank |
| Number scalar | finite, between −10¹² and 10¹² inclusive |
| Declaration | 262,144 UTF-8 bytes |
| Source JSON traversal | 100,000 nodes, 4,000,000 string/key characters total; depth 24 |
| Saved JSON file | 33,554,432 bytes |

Arrays must be dense. Unknown keys, getters, serialization hooks and duplicate
IDs/domain values are refused before source reads. No declaration is truncated.
SDK optional object fields use normal JSON serialization; their absent values
are not replaced with invented defaults. Scalar whitespace and CRLF are exact.

## What the proof establishes

For each variable, fix every other input and collect the answer vector for each
value in that variable's domain. The variable is irrelevant only when all those
vectors are exactly equal. The receipt carries every branch value, its SHA-256
answer-vector digest, and the number of fixed contexts compared. Equality is
decided on the vectors themselves, not on digests. The packet includes the entire
decision contract, so a verifier can reproduce the proof without omitted text.
Interactions such as XOR remain relevant even when marginal answer counts match.

A fragment is omitted only if all its declared variables are irrelevant. Every
omitted fragment retains its ID, native coordinate in `contract.fragments`,
authoritative source revision, and `proof_variables` references. Empty dependency
sets have an empty proof list, expressing the caller's unconditional declaration.
`routing` maps the ordered `relevant_variables` values to answers. Full and reduced
representations share that routing and the same certificates; full additionally
retains every available source value for direct byte comparisons.

This proves the declared finite task only. It does not prove that a caller's
domains are exhaustive in the real world or that their fragment dependencies are
correct. An omitted document could matter to a different question. The output's
`basis` makes that boundary explicit. Small inputs may grow because proof overhead
is included; there is no universal compression promise.

Missing, changing, malformed or oversized sources produce an `unavailable` row,
`state: unknown` and a remedy. Healthy fields are preserved or independently
proved irrelevant. Failed reads never consume the remaining source budget.
No omitted fragment is claimed readable when its source was unavailable.

## SDK and validation

```ts
import {
  createSharedEvidenceReader, parseAnswerReductionRequest,
  reduceAnswerContext, encodeAnswerReduction, validateAnswerReduction,
} from "pm-context";

const request = parseAnswerReductionRequest(untrustedJson);
const read = createSharedEvidenceReader(pmRoot);
const reduced = await reduceAnswerContext(request, read);
const text = encodeAnswerReduction(reduced, "toon");
await validateAnswerReduction(savedJson, request, read);
```

The CLI supplies its host tracker root. The SDK accepts the existing authoritative
`SharedEvidenceReader` adapter; the native adapter uses the supported pm SDK
item/history APIs. No executable path or global-symlink discovery is involved.
Alternative backends must supply authoritative revision tokens that change with
native history, including an A→B→A change. Content-only hashes are insufficient.

`parseAnswerReduction` verifies the serialized schema, routing, cofactor
certificates and omission decisions through the same projection used by the
producer. It does not authenticate supplied source revisions. To trust a saved
packet against a tracker, use `validateAnswerReduction` or `--check`: these reread
every source and recompute the packet, including the contract revision. Stale
inputs refuse rather than replaying an earlier decision. Native reads are
optimistic observations, not locks: a writer can commit immediately after the
last read. Packets carry revisions, not a future freshness guarantee.

`AnswerReductionError` exposes `code`, `remedy`, exit code 2, and host `next_steps`:
`INVALID_REQUEST` asks for a bounded declaration; `INVALID_ARGUMENT` corrects CLI
guards; `INPUT_UNAVAILABLE` requests a stable JSON file; `INVALID_OUTPUT` requests
regeneration; `STALE_PACKET` requests current source/contract revisions. No private
paths or source snippets appear in these errors. Source-level unavailability is
reported per fragment rather than throwing away the packet.

Both transports encode the same typed packet. JSON is compact; TOON uses native
tables where possible and stores source values as lossless `value_json` strings.
Validate imported JSON/decoded TOON with the exported parser. Nothing imports,
syncs or mutates tracker items, and no journals, caches or idempotency stores are
created. All commands work without Git, including `--check`.

See [measured validation](answer-reduction-validation.md) for public data,
model-based replay, packed installation and behavioral revert evidence.
