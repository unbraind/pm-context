# pm-context

`pm-context` generates deterministic context packs from a pm workspace so
handoffs, reviews, and agent sessions start from the same project state.

It complements the core `pm context` command by writing durable markdown or JSON
packs for selected items and their dependency neighborhood.

## Install

```bash
pm install github.com/unbraind/pm-context --project
```

## Usage

```bash
pm context-pack --id pm-1234 --include-body --output context.md
pm context-pack --id pm-1234 --format agent
pm context-pack --id pm-1234 --format compact --recent 8
pm context-pack --ids pm-1234,pm-5678 --state blocked --format compact
pm context-pack --status in_progress --tag release --format json
pm context-pack --type Feature --include-closed --limit 20
pm context-pack --id pm-1234 --neighborhood-depth 2
pm context-pack --id pm-1234 --compress --format json
pm context-pack --id pm-1234 --include-deps --section focus --section blockers
pm context-pack --id pm-1234 --max-items 10
pm context-pack --changed --format agent
pm context-pack --changed origin/main --format json
pm context-pack --files src/parser.ts --files test/parser.test.ts
```

The command reads workspace data in-process through the typed pm SDK, so packs
use the installed CLI's canonical query and relevance engines rather than a
second parser. Normal pack and handoff runs attach a runtime receipt for their rendered facts
and record a best-effort SDK serving event for visible items when an author is
available. `--explain` stays observational and creates neither receipt nor event.

## Output

Markdown packs include:

- a summary with selected item counts by status and type
- focus items sorted by priority and update time
- dependency and dependent context for selected items
- linked docs and files when item metadata exposes them
- optional item bodies

JSON packs expose the same data in a stable shape for automation.

Agent handoff packs (`--format agent` or `--format compact`) are intentionally
compact. They focus on the current work, visible blockers, next actions, recent
activity, linked files/docs, and the exact refresh command another agent should
run before continuing.

### Focus on the files being changed

`pm context-pack --changed [<base>]` focuses on items linked to the branch and
working set: the diff from `merge-base(base, HEAD)`, staged and unstaged changes,
and untracked files that Git does not ignore. The base defaults to the local
`origin/HEAD` symbolic ref, falling back to `main`; fetch the default branch or
pass a known base if it cannot be resolved. Renames consider both old and new
paths so existing links still provide context. Changes inside the resolved pm
tracker root (including custom roots) are excluded from `--changed`.

Use repeated `--files <path>` for an explicit working set, including paths that
do not exist yet. Paths are relative to the repository root (native absolute
paths inside that root are also accepted), and backslashes are normalized.
`--files` and `--changed` combine their unique paths. Linked directories match
contained files with path boundaries, so `src` matches `src/parser.ts` but
`sr` does not. File selection intersects any id/status/type/tag filters.

Focus items rank by the number of unique matching paths, then status
(`in_progress`, `open`, `blocked`, `closed` with `--include-closed`), then
ascending priority and id. Existing neighborhood depth, focus limit, max-items
and token packing apply afterward. Under `--max-items` token pressure, equal-cost
focus candidates retain that order: greatest overlap first, then lifecycle
status, ascending priority, and ascending id as the final deterministic tie-break.
An empty working set selects no focus items.

Repository roots retain meaningful trailing whitespace. With older hosts that
trim the repository context, file focus recovers the exact root from the current
working repository when it matches that context.

Every focus item exposes `matched_files`. `unlinked_changed_files` lists working
set paths with no linked item anywhere in the tracker, independently of filters
and packing; link them with `pm files <id> --add path=<path>`. These diagnostics
appear in JSON, markdown, agent/compact and `--explain`; text diagnostics follow
the `focus` section when using `--section`. Explain ranks follow the emitted
file-focused pack. File-focused requests are observational: they create no
tracker receipts or serving events, including when an author is set.
`--output` writes only the requested output file. A non-Git directory, invalid
base or path outside the repository produces an actionable usage error.

### Compress mode

`--compress` minimizes output tokens for token-sensitive agent contexts:

- JSON output is minified (no indentation)
- Markdown and agent output have all blank lines removed

### Section filtering

`--section <section>` selects only specific sections of the rendered output.
Repeat the flag for multiple sections. Available sections:

- Markdown: `summary`, `focus`, `neighborhood`, `neighbors`, `links`, `deps`
- Agent: `focus`, `blockers`, `next-actions` (alias: `actions`), `recent`
  (alias: `activity`), `links`, `deps`, `refresh`

### Dependency info

`--include-deps` adds per-item dependency information (`dependsOn` and
`dependedBy` arrays) to the context pack and handoff output. A `## Dependencies`
section is rendered in markdown/agent output when present.

These arrays summarize execution ordering according to the relationship kind
registry: `blocked_by` (including `depends_on`) lists prerequisites, while
`blocks` lists dependents. `related`, `implements`, hierarchy, and other
non-ordering edges remain in typed relationships and neighborhood context but
do not create prerequisites. Commands honor active extension kind definitions;
`buildContextPack`, `buildAgentHandoff`, and `renderAgentHandoff` accept an optional
`relationshipRegistry` for custom kinds. Commands supply the active workspace registry.
Handoff blockers follow the same ordering and precedence semantics even without
`--include-deps`, and retain each raw relationship kind.

### Max items

`--max-items <n>` caps the total number of items (focus + neighbors) in the
pack. The SDK packer first selects candidates under a token budget with
projection degradation, preserving required focus items and relevance-ranked
neighbors; `--max-items` is then enforced as an additional hard item-count
ceiling.

## Command

`pm context-pack`

Options:

- `--session <id>` usage session (also available on `context-handoff`); defaults to
  `PM_CONTEXT_SESSION`, then a fresh receipt id for each bundle
- `--changed [<base>]` focus linked files from a Git base plus the working set
- `--files <path>` explicit repository-relative working set (repeatable)
- `--id <id>` repeatable item ids to focus
- `--ids <id,id>` comma-separated focus item ids (alias for repeated `--id`)
- `--status <status>` filter by status
- `--state <status>` alias for `--status`
- `--type <type>` filter by type
- `--kind <type>` alias for `--type`
- `--tag <tag>` filter by tag
- `--limit <n>` maximum focus item count
- `--format <markdown|json|agent|compact>` output format (`compact` aliases `agent`)
- `--recent <n>` recent activity lines for agent/compact output (default `5`)
- `--output <file>` write the pack to a file
- `--include-body` include item bodies
- `--include-closed` include closed/canceled items in filtered packs
- `--without-neighborhood` omit dependency/dependent neighbors
- `--neighborhood-depth <n>` include transitive neighbors up to `n` hops (default `1`).
  A breadth-first walk over the dependency relationship graph in both directions
  (`depends_on`/`blocked_by` edges and their reverse). `0` is equivalent to
  `--without-neighborhood`; the value is capped at `5`. Depth `1` is the historical
  default and preserves the prior item selection. Neighbors discovered
  at deeper hops are still classified as neighbors (never focus), de-duplicated, and a
  focus item is never listed as its own neighbor.
- `--compress` minimize output tokens (compact JSON, no blank lines)
- `--include-deps` include per-item dependency info in the context pack
- `--max-items <n>` maximum total items (focus + neighbors) in the pack
- `--explain` explain the exact focus and neighborhood items that the normal
  selection and packing path would emit, without recording a serving event;
  reported ranks and scores are relative to that emitted pack, not the workspace
- `--section <section>` include only specific sections (repeatable):
  `summary`, `focus`, `neighborhood`, `neighbors`, `links`, `deps`,
  `blockers`, `next-actions` (alias: `actions`), `recent` (alias: `activity`),
  `refresh`

`pm context-usage`

Measures the context bundles generated by `context-pack` and `context-handoff`,
with separate compatibility metrics from the host's `context`/`next` ledger.
It reports facts served versus facts reported used per session and item, so
agents can reduce unused context in their next request.

### Agent usage protocol (v1)

1. Choose a session id and set `PM_CONTEXT_SESSION`, or pass `--session` on each
   serving and reporting command. Refreshing context creates a new receipt;
   reusing a session aggregates those bundle impressions. Without a session,
   each bundle's receipt id becomes its isolated session id.
2. Read a pack or handoff. JSON adds `context_receipt` with `protocol`,
   `receipt_id`, `session`, `author`, `served_at`, stable `sections` and `facts`.
   Text annotates headings with `[s-…]` and content lines with `[f-…]`, and ends
   with a receipt/session footer. Preserve those ids in the agent's context.
3. Report facts that informed your work, using ids from that receipt. A section
   citation reports all facts in that section. A post-mutation or file-edit hook
   may instead submit touched item ids or edited repository-relative paths.
   Invoke the hook **after successful work**, against the receipt used for it.
4. Inspect the session report, then request fewer sections or items when the
   retained evidence repeatedly shows unused context.

```bash
export PM_CONTEXT_SESSION=review-42
# Start a branch task with its actual working set:
pm context-pack --changed --format agent
# For receipt-based usage measurement, request a regular item pack:
pm context-pack --ids pm-1234,pm-5678 --section focus
# Copy the actual receipt/fact identifiers from the returned bundle:
pm context-usage --receipt RECEIPT_ID --cite FACT_ID --json
pm context-usage --receipt RECEIPT_ID --cite SECTION_ID --json
# A hook can report later successful mutations or edits:
pm context-usage --receipt RECEIPT_ID --touch pm-1234 --edited-file src/example.ts
pm context-usage --session review-42 --json
pm context-usage --by agent-a --limit 50
```

`--cite`, `--touch`, and `--edited-file` accept repeated flags or comma-separated
values and require `--receipt`. An unknown citation, unserved item/file, invalid
path, expired receipt, or mismatched session rejects the entire submission.
Repeated submissions are idempotent. Reports for the same fact can retain all
three evidence categories without counting the fact as used more than once.
When a session is supplied explicitly or through the environment it must match
the selected receipt. Different receipts never inherit one another's evidence,
even if their fact ids are identical. `--by` filters the recording author;
the host-owned global `--author` sets invocation identity, not the report filter.

A fact is one nonblank rendered text content line (including placeholders), or
one top-level JSON field value/array entry. Generated timestamps and headings
are framing. Facts are content-addressed by section, associated item ids, and
rendered content; unchanged content in the same format keeps its id across
refreshes. Changed content gets a new id. Repeated identical fragments in one
section share an id with summed token cost. Section ids hash the rendered name.
Markdown section filters, body truncation, handoff link limits and packing are
applied **before** facts are identified. JSON reports all fields in the JSON
bundle, as with the existing JSON serving format.

Only visible item identifiers and visible linked file paths are associated with
facts; excluded bodies, items and sections cannot receive usage credit. File
paths are normalized to repository-relative POSIX paths. URLs and absolute or
traversing paths cannot be reported as edited files. A fact spanning several
items belongs to each item's rollup, so item totals can overlap; session and
bundle totals count that fact once.

The JSON report adds `bundles`, with `totals`, `sessions`, `items`, and `receipts`:

- `precision = used_facts / served_facts` (`null` for no served facts).
- `cited_facts`, `touch_facts`, and `edit_facts` separate explicit citations from
  mutation/edit proxies. An uncited read can be reported explicitly by fact id.
- `estimated_served_tokens` sums fact cost, estimated as `ceil(characters / 4)`
  per rendered fragment. `unused_context_tokens` sums only unused facts.
  These are estimates, not tokenizer measurements, billing, or cognitive-use proof.
- `protocol_tokens` separately estimates receipt/annotation overhead; headings,
  generated clocks and other framing are outside the fact-cost denominator.
- `unused_fact_ids` identifies unused facts in each detailed receipt. Aggregate
  metrics are computed before `--limit` truncates the detail arrays.

Metrics describe the complete bundle handed to the command host or written to
`--output`. The SDK does not expose a fact-level post-egress callback, so later
host truncation, omitted responses, or an agent failing to read a saved file
cannot be inferred. For complete delivery use `--output` and read the resulting
file, or the host's unbounded output controls. Agents must submit evidence;
silence means **unreported usage**, not proven irrelevance. Host ledger touches
carry no session or fact ids and are never automatically credited to a receipt.

### Runtime storage and failure handling

Receipts live exclusively in the tracker's ignored
`runtime/context-receipts/` directory. Each atomic JSON snapshot stores ids,
associations, token estimates and deduplicated evidence, **no context text**.
Rotation keeps the current receipt and the most recently written siblings, at
most 200 snapshots of 256 KiB each (50 MiB maximum retained receipt data).
Older receipts are deleted; their
metrics leave the retained-window report. Successful evidence writes refresh a
receipt's retention position. There is no tracked receipt file or schema change,
and the host-owned `runtime/context-usage.jsonl` remains under SDK ownership.
The receipt returned by the current serving call is protected during rotation,
including when older snapshots have future modification times. The remaining
199 slots retain the most recently written siblings.

A directory lock serializes cooperating writers; contention fails a usage
submission and can be retried. A process crash can leave `.lock`; an operator
may remove that abandoned lock after ensuring no writer is running. Corrupt,
oversized or partial snapshots are skipped and counted as `malformed_receipts`.
Serving failures disclose `context_receipt_error` in JSON or a receipt-unavailable
message in text and still return context. They do not claim measured usage.
`--explain` creates no receipt. Failed output-file writes roll back their receipt.

### Host ledger compatibility report

The existing report still reads pm's bounded `runtime/context-usage.jsonl` and
surfaces **conversion** (same-author serve followed by a touch), **waste**
(served without a later touch), and **misses** (touched without a serve).
It uses serve rows' `included` flags; `ranked - serves` identifies budget losses.
Recognized delivery rows do not change that legacy denominator. This historical
conversion is separate from the receipt/session metrics and cannot establish
fact usage or final delivery. When `--by` is supplied, SDK-decayed affinity is
shown when available; the package does not implement a competing relevance model.

```bash
pm context-usage
pm context-usage --surface next --since 7d --json
```

Report options:

- `--session <id>` filter bundle receipts (also reads `PM_CONTEXT_SESSION`)
- `--receipt <id>` filter or submit evidence to one bundle receipt
- `--cite <ids>`, `--touch <ids>`, `--edited-file <paths>` submit usage evidence
- `--by <author>` filter both reports by recording author
- `--surface <context|next>` filter only legacy host serve events
- `--since <when>` drop serves at or before an ISO timestamp or day offset
  (`7d`, `-7d`, `7`); bundle evidence is attributed to the receipt's serve time
- `--limit <n>` maximum detail rows (default `20`)
- `--format <markdown|json>`; the global `--json` also selects JSON


## Philosophy

Project management is context management. `pm-context` makes that concrete by
turning pm's source-of-truth items into portable context that can be reviewed,
sent to another agent, or attached to a pull request — and, with
`pm context-usage`, by measuring whether that context was worth sending.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

The existing quality owner, `pm-context-3s5f`, remains open. The native coverage
gate enforces 100% lines, branches and functions for nine configured files; it
does not expose an independent statement counter. The same test run is wrapped
by c8, which independently enforces 100% statements, lines and functions and
99.9% branches across all eleven authored TypeScript/JavaScript executables. The
remaining c8 branch converts a non-Error exception from receipt usage into a
command error. Neither measurement covers the shell alert helper, so passing
the release command does not establish whole-source 100/100/100/100.

| Authored executable | Native gate | c8 release gate |
| --- | --- | --- |
| `index.ts` | Included | Included |
| `file-focus.ts` | Included | Included |
| `context-receipts.ts` | Included | Included |
| `context-usage.ts` | Included | Included |
| `scripts/coverage-gate.ts` | Included | Included |
| `scripts/docstring-gate.ts` | Included | Included |
| `scripts/verify-release-publish-attestation.ts` | Included | Included |
| `scripts/main-invocation.ts` | Included | Included |
| `scripts/prepare-merge-driver.ts` | Outside configured scope | Included |
| `scripts/verify-release-changelog-date.ts` | Included | Included |
| `.agents/pm/verify-release-yaml.mjs` | Outside configured scope | Included |
| `scripts/alert-on-release-failure.sh` | Unmeasured | Unmeasured |

Coverage reports are removed before configuration validation and on runner or
inventory failures, preventing an earlier report from surviving a failed gate.
The c8 gate uses `all: true` to count unexecuted files in its configured scope;
its subprocess collection includes the managed prepare launcher and the parsed
workflow verifier. c8 currently reports zero function counters for those two
scripts, so their reported function percentage does not certify their callbacks.
Artifact preparation tests execute the unchanged managed launcher in disposable
Git checkouts and prove `pack` and `publish` preserve local merge configuration.
The parsed-workflow verifier has disposable real-file acceptance and rejection
fixtures in `test/release-workflow-verifier.test.ts`; those tests never contact
GitHub or mutate release controls.

The documentation launcher checks the pm-ops analyzer's selected declaration
policy. It excludes anonymous callbacks and several internal declaration forms,
so its passing count does not certify documentation of every authored declaration.
The managed merge-driver launcher must remain byte-identical to the pinned
pm-ops template; its internal callback is part of the outstanding documentation
scope. The alert and workflow-verifier migration also requires coordinating the
existing `pm-context-qu0a` ownership before migrating its linked paths. No helper
has been marked removed while that dependency remains unresolved.

## Resume since your last session

```sh
pm context-pack since --from 2026-10-20T18:00:00Z --token-budget 4000
pm context-pack since --cursor "$cursor" --token-budget 4000
```

Returns ranked changes, bounded substantive comments and handoff messages, claims,
a new opaque cursor and an omission receipt. The whole JSON response fits the
conservative UTF-8 byte-token ceiling; budget-deferred rows remain resumable.
See [cursor semantics and recovery](docs/since.md).

## Resume only invalidated assumptions

Record a digest manifest for a packet whose sections declare item, settings and
local evidence dependencies. On resume, receive only invalidated sections;
changes propagate through dependent sections while unchanged assumptions reuse
safely. Deleted or unreadable sources refuse reuse with a bounded receipt.

```sh
pm context-freshness record --packet packet.json > manifest.json
pm context-freshness resume --packet packet.json --manifest manifest.json --json
```

No new snapshot store or event delta stream is created. See the
[packet example, typed SDK and refusal contracts](docs/freshness.md).

## Without git

Item-selected packs, handoffs, usage reports, `context-pack since` and freshness record/resume work in a
plain initialized tracker without invoking Git. Changed-file focus (`--changed`)
requires a Git working repository and explains that requirement when unavailable.
