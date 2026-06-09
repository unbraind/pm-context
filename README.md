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
```

The command is read-only. It shells out to the active `pm` binary for
workspace data, so generated packs reflect the installed CLI and package
runtime rather than a stale parser.

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

## Command

`pm context-pack`

Options:

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
  default and produces byte-identical packs to prior versions. Neighbors discovered
  at deeper hops are still classified as neighbors (never focus), de-duplicated, and a
  focus item is never listed as its own neighbor.

## Philosophy

Project management is context management. `pm-context` makes that concrete by
turning pm's source-of-truth items into portable context that can be reviewed,
sent to another agent, or attached to a pull request.
