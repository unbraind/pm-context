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

### Max items

`--max-items <n>` caps the total number of items (focus + neighbors) in the
pack. Focus items take priority; neighbors are trimmed to fit the remaining
budget.

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
- `--compress` minimize output tokens (compact JSON, no blank lines)
- `--include-deps` include per-item dependency info in the context pack
- `--max-items <n>` maximum total items (focus + neighbors) in the pack
- `--section <section>` include only specific sections (repeatable):
  `summary`, `focus`, `neighborhood`, `neighbors`, `links`, `deps`,
  `blockers`, `next-actions` (alias: `actions`), `recent` (alias: `activity`),
  `refresh`

## Philosophy

Project management is context management. `pm-context` makes that concrete by
turning pm's source-of-truth items into portable context that can be reviewed,
sent to another agent, or attached to a pull request.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script
(guarded — it runs `pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so production / `--omit=dev` installs are not broken). To (re)run manually: `npm run merge:install`. After merging a branch that
touched `.agents/pm/`, run `pm history-repair --all` to reconcile history verification.
