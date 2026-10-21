# Validate assumptions when resuming

`context-pack since` delivers events. Freshness checks whether a particular
packet's declared assumptions still hold. It stores no snapshots, history,
usage events or mutable cursor state: the producer keeps its packet and the
returned digest manifest together.

Build the packet while reading authoritative sources, then immediately record
and validate it before first use. `content` is the original assumption text;
this validator checks its declared dependencies, not the truth of its prose.
A field projection must include every field that the assumption relies on.
Omit `fields` to observe the complete item or effective settings. Top-level
field presence is significant; property order is not, while array order is.
Item digests cover metadata and body, including revision fields when present.
Evidence digests cover exact bytes, including binary files.

For example, create `packet.json` (replace the illustrative item ID):

```json
{
  "sections": [
    {
      "id": "api-contract",
      "content": "The prerequisite API is ready and its contract is unchanged.",
      "sources": [
        {"kind": "item", "id": "demo-api", "fields": ["status", "dependencies"]},
        {"kind": "evidence", "path": "docs/api.md"}
      ],
      "depends_on": []
    },
    {
      "id": "implementation-plan",
      "content": "Implement the client against that contract.",
      "sources": [{"kind": "settings", "fields": ["schema"]}],
      "depends_on": ["api-contract"]
    }
  ]
}
```

```sh
pm context-freshness record --packet packet.json > manifest.json
pm context-freshness resume --packet packet.json --manifest manifest.json
pm context-freshness resume --packet packet.json --manifest manifest.json \
  --format json --byte-budget 4000
```

`record` emits a complete compact JSON artifact (default ceiling: 262144 bytes).
`resume` defaults to compact TOON; `--json` or `--format json` selects compact
JSON. Its default ceiling is 4000 UTF-8 bytes, including the final newline.
`--byte-budget` is an integer of at least 512. This is an exact byte bound,
not a tokenizer-dependent estimate. A manifest that cannot fit refuses; resume
may drop whole invalidation rows and reports `omitted_sections`. Increase the
budget and retry with the same inputs to see every invalidated section.
Omitted rows never change `reusable`, totals or the verdict.

An evidence path is relative to the source workspace. Use `--evidence-root`
when packet production and resumption run from different directories. Absolute
paths, traversal, URLs, final symlinks, escaping ancestor symlinks, nonregular
files, unreadable files and oversized files cannot certify reuse. Evidence is
limited to 8 MiB per file; packet, manifest, settings and item files to 256 KiB.
Remote URLs are not fetched; provide a pinned local artifact or a backend
adapter. Source contents and underlying exception messages never enter receipts.

The response lists only invalidated section IDs, each with a deduplicated set
of changed/unavailable source coordinates. Causes propagate transitively
through `depends_on`, including shared dependencies; unrelated sections appear
only in `unchanged_sections`. A section must have a source or depend on another
section. Duplicate IDs, unknown dependencies and cycles refuse before reads.
The packet digest binds content and declarations to the manifest; this is
integrity checking, not an authentication signature. Keep both artifacts with
the actual context packet and trust the producer that declares dependencies.

| Code | Exit | Remedy |
| --- | ---: | --- |
| `FRESH` | 0 | Reuse declared assumptions; validate again after later changes |
| `STALE` | 0 | Regenerate the listed sections and record a new manifest |
| `SOURCE_UNAVAILABLE` | 2 | Restore deleted, corrupt or unreadable sources; do not reuse the packet |
| `INVALID_PACKET` / `INVALID_MANIFEST` | 2 | Supply the original valid pair, or regenerate them together |
| `INPUT_UNAVAILABLE` | 2 | Supply readable, stable, bounded JSON artifacts |
| `INVALID_ARGUMENT` / `BUDGET_TOO_SMALL` | 2 | Correct the flags or increase the byte ceiling |

Missing sources during recording refuse the entire baseline. During resume,
all declared sources are checked and the bounded receipt retains the full
unavailable count. The CLI emits that receipt to stdout with exit 2. Other
refusals use the host's standard error channel and typed recovery guidance.
The SDK returns `SOURCE_UNAVAILABLE` as a `FreshnessResult`; malformed input
and recording failures throw `FreshnessError` with `code`, `exitCode`, `remedy`.

## Typed SDK

```ts
import {
  createFreshnessReader, recordFreshness, resumeFreshness, encodeFreshness,
  parseFreshnessPacket,
} from "pm-context";
import type { FreshnessPacket } from "pm-context";

const packet: FreshnessPacket = parseFreshnessPacket(parsedPacketJson);
const read = createFreshnessReader(pmRoot, evidenceRoot);
const manifest = await recordFreshness(packet, read);
// Later; the same adapter performs new authoritative reads on every call.
const result = await resumeFreshness(packet, manifest, read);
const output = encodeFreshness(result, "json", 4000);
if (result.code === "SOURCE_UNAVAILABLE") throw new Error(result.remedy);
```

`FreshnessReader` accepts one `FreshnessSource` and returns a JSON-compatible
value or rejects if that source cannot be read. A hosted backend can supply
this adapter without filesystem or Git access. The supplied filesystem adapter
uses public SDK item/settings readers, including custom type folders, and never
writes a tracker or a usage ledger. Source reads are individually checked;
there is no cross-backend transaction or protection against a writer changing
sources after validation. Revalidate at the next use boundary.

Dependencies must be declared explicitly. Include each prerequisite item as a
source in its assumption section and connect dependent sections with
`depends_on`. A new unrelated item does not invalidate a fixed-item assumption.
Workspace-wide selection, filesystem globs, remote freshness and time-dependent
claims require a producer-owned authoritative digest source; they are not
inferred from item history or silently treated as verified.
