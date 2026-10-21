# Resume with a delta pack

`pm context-pack since --from 2026-10-20T18:00:00Z --token-budget 4000`
returns ranked JSON changes, substantive comment/note excerpts, handoff and release
messages, other agents' claim events, and your own nonterminal claims. Use your
normal global `--author` or `PM_AUTHOR` identity. Save the returned opaque `cursor`:

```sh
pm context-pack since --cursor "$cursor" --token-budget 4000
```

The starting timestamp is inclusive. Subsequent calls identify immutable history
entries rather than comparing timestamps, so equal timestamps and backdated
appends do not disappear. Every event gets an operation, author, timestamp,
changed-field inventory and stable key. Lifecycle, priority and assignee
transitions are stated explicitly. Blocking edges follow the SDK relationship
registry; closing a prerequisite also identifies affected dependents.

Blockers rank first, followed by your claims, handoffs, unblocked work, other
claims, reopened/reprioritized/new items, comments and closures. Priority, event
time and key break ties deterministically. Reversed blocker/unblock rows carry `superseded: true` and rank last. A claim
event may also have been released later in the same window; read its transitions
and timestamps together. Own claims describe the serving snapshot, including
open and in-progress statuses and excluding the workspace's terminal statuses.

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

Cursors are scoped to the tracker and author. Disposable, content-addressed
snapshots live under the ignored tracker `runtime/context-since` directory, with
at most 200 snapshots and 4 MiB total retained state. The cursor carries no file
path. Losing/evicting runtime state produces `CURSOR_EXPIRED`; pruning or changing
history covered by a cursor produces `HISTORY_EXPIRED`. Both refuse to invent a
complete delta and instruct callers to reorient with `pm context --for handoff`,
then restart with an appropriate `--from` timestamp. A timestamp predating a
compacted history baseline also refuses. `INVALID_CURSOR`,
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
