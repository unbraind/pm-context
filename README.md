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
pm context-pack --status in_progress --tag release --format json
pm context-pack --type Feature --include-closed --limit 20
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

Agent handoff packs (`--format agent`) are intentionally compact. They focus on
the current work, visible blockers, next actions, linked files/docs, and the
exact refresh command another agent should run before continuing.

## Command

`pm context-pack`

Options:

- `--id <id>` repeatable item ids to focus
- `--status <status>` filter by status
- `--type <type>` filter by type
- `--tag <tag>` filter by tag
- `--limit <n>` maximum focus item count
- `--format <markdown|json|agent>` output format
- `--output <file>` write the pack to a file
- `--include-body` include item bodies
- `--include-closed` include closed/canceled items in filtered packs
- `--without-neighborhood` omit dependency/dependent neighbors

## Philosophy

Project management is context management. `pm-context` makes that concrete by
turning pm's source-of-truth items into portable context that can be reviewed,
sent to another agent, or attached to a pull request.
