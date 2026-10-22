# Resume with a delta pack

`pm context-pack since --from 2026-10-20T18:00:00Z --token-budget 4000`
returns ranked JSON changes, substantive comment/note excerpts, handoff and release
messages, other agents' claim events, and your own nonterminal claims. Use your
normal global `--author` or `PM_AUTHOR` identity. Save the returned opaque `cursor`:

```sh
pm context-pack since --cursor "$cursor" --token-budget 4000
```

The starting timestamp is inclusive and must use
`YYYY-MM-DDTHH:mm:ss[.fraction]Z` or an explicit `±HH:MM` offset in place of `Z`.
Calendar dates must exist, hours run from 00 to 23, and minutes and seconds from
00 to 59. Loose dates, missing timezones and normalized rollovers are rejected
with `INVALID_FROM`. Years below 0100 retain their actual year.
Subsequent calls identify immutable history
entries rather than comparing timestamps, so equal timestamps and backdated
appends do not disappear. Every event gets an operation, author, timestamp,
changed-field inventory, type, status and stable key. Derived graph transitions
use `blocked`/`unblocked` operations; closing or deleting the waiting item does
not manufacture newly actionable work. Lifecycle, priority and assignee
transitions are stated explicitly. Blocking edges follow the SDK relationship
registry; closing a prerequisite also identifies affected dependents.

History timestamps also require valid explicit-zone timestamps. Each is parsed
once; cross-stream replay and ranked time ordering compare instants, so different
offset spellings do not change causal order. Physical append order within each
stream still wins for backdated entries. Invalid timestamps cannot be assigned
to a time window: the omission receipt reports `invalid_timestamp_rows` and up
to eight `invalid_timestamp_examples` (item, zero-based ordinal and at most 128
timestamp characters). Their patches still contribute to current-state replay,
but those event rows are omitted. A positive count prevents a completeness claim;
inspect the referenced histories before relying on time-window transitions.

Blockers rank first, followed by your claims, handoffs, unblocked work, other
claims, reopened/reprioritized/new items, comments and closures. Priority, event
time and key break ties deterministically. Reversed blocker/unblock rows carry `superseded: true` and rank last. A claim
event may also have been released later in the same window; read its transitions
and timestamps together. Own claims come from the same SDK history replay as the delta, so a competing
claim between metadata and history reads cannot remain listed as your own.
Claims describe the serving snapshot, including
open and in-progress statuses and excluding the workspace's terminal statuses.
Handoffs are explicit release operations or prose lines starting with `handoff:`,
`hand over:` or `hand-over:`. Ordinary comments and closure messages about release
notes retain their normal rank.

Each response includes an omission receipt. Rows that do not fit remain in the
cursor and are returned by the next call. Pages drain a frozen snapshot before
collecting writes that arrived during paging; keep resuming until
`deferred_rows` is zero, then refresh that cursor for later changes. The receipt
also counts deferred own claims. Comment/message prose is limited to 384 Unicode
code points per event, titles to 128 and transition prose to 256; each visible row
reports omitted excerpt characters. Read `pm comments <id>` and
`pm history <id> --full` when complete prose or JSON patches are needed. Changed
fields outside the named transition categories are identified, without including
their complete values. This is a decision delta, not an export of history patches.

The budget covers the complete serialized JSON response, newline, receipt and
cursor. Its unit is **UTF-8 bytes**, a conservative token upper bound for
byte-fallback tokenizers; it is deliberately stricter than a characters/4
estimate. `budget.token_upper_bound` equals the final byte count. Minimum accepted
input is 512; a ceiling that cannot fit the envelope and one full row fails with
`BUDGET_TOO_SMALL` without advancing a cursor. Increase the ceiling and retry.
No random usage-receipt footer is appended to this deterministic surface.

Cursors are scoped to the tracker and author. A deterministic sequence number
ensures even an empty refresh returns a new token; retries of the same input
cursor and corpus return the same response. Disposable, content-addressed
snapshots live under the ignored tracker `runtime/context-since` directory, with
at most 200 snapshots and 4 MiB total retained state. Checkpoints reference shared,
compressed, content-addressed inventories containing one count and ordered prefix
hash per nonempty stream. Unchanged polls by different agents share that inventory
instead of copying it into every checkpoint. The count is an upper bound: distinct
inventories and pending rows also consume the byte allowance and can reduce the
number retained. Unreferenced inventories are collected with evicted checkpoints;
SDK locks serialize publication and protect inventory reads across processes.
A later `--from` reduces pending rows; exceptionally large compressed inventories
can still require a smaller tracker. Cursors from the older event-key checkpoint
format expire with an explicit restart remedy. The
cursor carries no file path. Losing/evicting runtime state produces `CURSOR_EXPIRED`; pruning or changing
history without a compaction baseline produces `HISTORY_EXPIRED`.

Every response provides `served_at`, the first publication time of that immutable
response, and `restart_from`, a conservative inclusive restart boundary covering
the requested start and the earliest valid retained timestamp. Persist both with
the cursor. On cursor loss, use `--from "$restart_from"`; replay can repeat events,
so deduplicate by event key. `served_at` is diagnostic clock metadata excluded
from replay identity; retries reuse its persisted first-publication value.
Do not restart at the later serving time when a page still has deferred rows.
Backdated writes earlier than the saved boundary require an earlier start.

Compaction of one stream reports its item ID in `expired_streams` while continuing
unaffected streams. Frozen pages remain deliverable even if their source was
compacted; the next refresh reports the affected stream and resumes after its
baseline. A `--from` start predating a baseline also reports that stream instead
of refusing the whole tracker. Missing pruned events cannot be reconstructed:
any expired stream or invalid timestamp requires history inspection or
`pm context --for handoff` before claiming a complete delta. `INVALID_CURSOR`,
`CURSOR_AUTHOR_MISMATCH`, `INVALID_ARGUMENT`, `INVALID_FROM`, `INVALID_BUDGET` and
`CURSOR_CAPACITY` provide specific remedies through the exported `SinceError`
contract (`code`, `remedy`, `exitCode=2`) and the CLI diagnostic.

The package uses the existing certified full-item SDK reader and validated SDK
history reader/patch replay. It never modifies items or append-only histories.
Readers consume the tracker view supplied by the host; this local runtime cursor
store does not claim a remote Postgres or MCP transport implementation.

# Existing overlap

Core `pm context --for handoff` serves current-state orientation, not an immutable
history continuation. Core `pm activity` supplies a digest or compact/raw event
stream; a separate comment read is needed for substantive prose. `pm-brief`'s
`pm brief since <checkpoint>` already summarizes lifecycle, priority, assignment
and dependency edits. This addition supplies the missing durable continuation,
substantive excerpts, claims and exact output ceiling, without changing the core
activity protocol or adding a second tracker.

# Without git

Delta packs, ordinary item-selected context packs, handoffs and usage reports work
in a plain initialized tracker. The since command invokes no Git executable.
File focus with `--changed` requires a Git working repository; explicit tracker
reads continue to work everywhere.

See [the public-copy measurement](since-benchmark.md) for calls, tokenizer counts,
completeness checks, reproducible commands and the limits of the experiment.

An internal SDK activity preflight applies core history policy and read hooks.
Physical stream reads then preserve append order for equal or backdated timestamps.
The call/token measurement concerns agent invocations and output, rather than
internal filesystem-read counts or latency.

Own-claim snapshots include `blocked: true` and bounded current blocker context,
including free-text `blocked_by` reasons, even on an empty refresh. Historical
replay uses certified current metadata only for items without retained streams.

Causal replay scans indexed stream frontiers in timestamp/item-ID order, retaining
physical order within each stream even for backdated writes. Pending pages only
validate stored stream prefixes; they skip causal merging and classification.
Blocker updates use reverse references and per-owner edge contributions, so graph
events refresh only the changed document and its referrers. Shared and inverse
edges retain all owners. Packing serializes each row once, adjusts byte counts
and receipt digits incrementally, then serializes the complete response once.
