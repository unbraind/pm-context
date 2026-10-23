# Check recorded packet assertions

Select a packet first using the existing context SDK/CLI. Its producer then
declares precisely which claims hold together. This separate input protocol is
`WitnessPacket`, not the raw `context-pack` JSON shape. It accepts assertions
from memory/decision producers without inferring facts from their prose.

Save this as `claims.json`:

```json
{
  "claims": [
    {
      "id": "recorded-open", "kind": "state", "subject": "task-123",
      "field": "status", "scope": "current", "value": "open",
      "citation": { "item": "task-123", "field": "/metadata/status" }
    },
    {
      "id": "handoff-closed", "kind": "state", "subject": "task-123",
      "field": "status", "scope": "current", "value": "closed",
      "citation": { "item": "handoff-456", "field": "/metadata/notes/0/text" }
    }
  ]
}
```

```sh
pm context-witnesses --packet claims.json
pm context-witnesses --packet claims.json --json --byte-budget 4000
```

The result has `code: CONTRADICTION`, `conflicting_pairs: 1`, and a witness with
rule `CONFLICTING_STATE` containing both cited declarations in claim-ID order.
Removing either assertion removes that conflict. Success, including a found
contradiction, exits 0; callers decide their own acceptance policy from `code`.
Invalid input and insufficient output budgets exit 2 with a remedy.

All assertions mean **currently applicable in this exact scope**. Different
environments, historical times, multi-valued fields and conditional policies
must be represented in distinct scopes or left outside this protocol. State
values are exact nonempty strings; no synonyms, case folding or natural-language
negation is applied. Policy claims use `kind: policy` and only `required` or
`forbidden`, meaning the same action is respectively mandatory or prohibited.
`supersedes: ["older-claim-id"]` on a replacement asserts that the referenced
claim is no longer applicable. Including both as current yields
`SUPERSEDED_CLAIM`, even when the values agree. Targets must exist in the same
packet and match kind, subject, field and scope. Self/unknown/cross-scope targets
refuse. Supersession is explicit; timestamps never imply it.

Each supported rule has a two-assertion witness. The checker counts every
conflicting unordered pair and returns one globally smallest set (cardinality
two). Ties use ascending code-unit claim IDs, independently of input order or
locale. If a pair violates multiple rules, explicit supersession takes
precedence. It does not enumerate every minimum set or solve arbitrary logic.

`citation.item` is a recorded item identity; `citation.field` is a JSON Pointer
into that producer's item document. Citations are retained exactly and **not
dereferenced or independently verified**. Use a freshness check when source
currency matters. `NO_DECLARED_CONFLICT` is scoped to the supplied declarations;
it does not certify prose, missing claims, source truth or model output. Model
proposals should stay separate until a producer explicitly records and scopes
them. Checking never writes a tracker, receipt or settings file.

The TypeScript surface is exported from `pm-context`:

```ts
import { checkContextWitnesses, encodeWitnessReport } from "pm-context";
import type { ContextPack, WitnessPacket } from "pm-context";

// pack is an already selected ContextPack assembled by the existing SDK path.
// Only populate this slot when status is present; do not invent absent facts.
export function checkSelectedStatus(pack: ContextPack): string {
  const packet: WitnessPacket = {
    claims: [...pack.items, ...pack.neighbors].filter(item => item.status !== undefined)
      .map((item, index) => ({
        id: `status-${index}`, kind: "state", subject: item.id,
        field: "status", scope: "current", value: item.status!,
        citation: { item: item.id, field: "/metadata/status" },
      })),
  };
  // Add other explicitly recorded co-current assertions to packet.claims here.
  return encodeWitnessReport(checkContextWitnesses(packet), "toon", 4000);
}
```

`parseWitnessPacket(unknown)` validates and copies a packet;
`readWitnessPacket(file)` reuses the package's bounded regular-file UTF-8 JSON
reader; `checkContextWitnesses(packet)` validates SDK inputs too. Unknown
qualifiers refuse so a producer cannot silently depend on ignored semantics.
Limits: 262144 input bytes, 512 claims, unique printable ASCII coordinate IDs of
1–128 characters, state values of 1–256 characters, JSON Pointer coordinates up
to 256 characters. Empty packets return an explicit zero checked-claims count.
Output defaults to 4000 UTF-8 bytes; accepted budgets are integers 512–262144.
JSON and TOON decode to the same report; the complete witness is never truncated.

`WitnessError` extends the SDK `PmCliError` and exposes `code`, `remedy`,
`exitCode: 2` and host `nextSteps`. Codes are `INVALID_PACKET` (correct the schema
or scope declarations), `INPUT_UNAVAILABLE` (supply a readable bounded JSON
file), `INVALID_ARGUMENT` (correct format/budget/arguments), and
`BUDGET_TOO_SMALL` (increase budget or shorten coordinates). Refusals omit
source values and private file locations in package-owned messages and remedies.
The host CLI may attach invocation arguments (including input paths) to its
recovery/refusal envelope; redact that host metadata before publishing diagnostics.

The check runs in initialized trackers without Git, including when no Git
executable is on PATH. It does not consolidate pm-memory knowledge or duplicate
pm-jev inference; existing core selection, ranking and relationship governance
remain responsible for their own contracts.
