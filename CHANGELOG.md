# Changelog

## Unreleased

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-context-4apx](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-4apx.toon))

## 2026.7.14 - 2026-07-14

### Fixed

- context-pack and context-handoff write rendered output to stderr instead of stdout ([pm-context-ubca](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-ubca.toon))

## 2026.7.10-1 - 2026-07-10

### Added

- Full pm ecosystem production pass for pm-context ([pm-context-mssk](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-mssk.toon))

### Changed

- Refactor section validation, dedup deps, and refresh toolchain ([pm-context-m0ib](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-m0ib.toon))

### Fixed

- Adversarial review pass 2026-07-10 ([pm-context-i9z0](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-i9z0.toon))

### Other

- Full-cycle hardening wave: pm-context ([pm-context-eie5](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-eie5.toon))
- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-context-p5bz](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-p5bz.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-context-pwa5](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-pwa5.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-context-o7on](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-o7on.toon))
- Align pm-context changelog check with full changelog output ([pm-context-9or3](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-9or3.toon))
- Refresh pm-context to latest pm CLI and changelog toolchain ([pm-context-o5k1](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-o5k1.toon))

## 2026.6.14 - 2026-06-14

### Other

- Regenerate CHANGELOG to drop the duplicate Unreleased section from pm-changelog issue 47 ([pm-context-fgmg](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-fgmg.toon))

## 2026.6.13 - 2026-06-13

### Other

- Daily Release publish step runs prepublishOnly post-tag: align npm publish with --ignore-scripts ([pm-context-wvup](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-wvup.toon))

## 2026.6.9 - 2026-06-09

### Added

- Add compact format alias and recent activity section ([pm-context-8vgi](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-8vgi.toon))
- Add --neighborhood-depth for transitive context neighbors ([pm-context-qbmf](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-qbmf.toon))

## 2026.6.7 - 2026-06-06

### Added

- Build initial context pack command ([pm-context-0gyf](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-0gyf.toon))
- Add agent handoff digest mode to context packs ([pm-context-opzn](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-opzn.toon))

### Other

- Run tests during release readiness ([pm-context-cqmc](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-cqmc.toon))
