# Changelog

## 2026.8.9 - 2026-08-09

### Fixed

- Release workflow publishes npm before advancing protected main (GH006 desync) ([pm-context-b7ub](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-b7ub.toon))
- Release changelog generate and check derived the section name from two different sources ([pm-context-cilu](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-cilu.toon))

### Other

- Restore the 2026.8.9 release on main to match npm ([pm-context-1fqt](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-1fqt.toon))
- Adopt pm CLI 2026.8.7 and protect extension assets during multi-agent merges ([pm-context-5njx](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-5njx.toon))

## 2026.8.7 - 2026-08-07

### Fixed

- Gate durable PM project health in CI on pm CLI 2026.8.6 ([pm-context-k6aa](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-k6aa.toon))

### Removed

- Remove unused SDK query import flagged by DeepScan ([pm-context-dmsf](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-dmsf.toon))

### Other

- Harden exact coverage gate and assertions from exact-head review ([pm-context-6ywm](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-6ywm.toon))
- Raise the coverage gate to a measured 100/100/100 and bring scripts/coverage-gate.ts under it ([pm-context-5925](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-5925.toon))

## 2026.8.5 - 2026-08-05

### Other

- Declare renderer ownership so the host enforces scoping the package only applied at runtime ([pm-context-lhse](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-lhse.toon))

## 2026.8.4 - 2026-08-04

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([pm-context-6rua](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-6rua.toon))

## 2026.7.31 - 2026-07-31

### Fixed

- Release commits discard the rebuilt dist, so the git-install path serves the previous version ([pm-context-bbsp](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-bbsp.toon))

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([pm-context-wd30](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-wd30.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-context-docu](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-docu.toon))

## 2026.7.28 - 2026-07-28

### Other

- Adopt pm-cli 2026.7.28 ([pm-context-o43q](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-o43q.toon))

## 2026.7.27 - 2026-07-27

### Added

- Adopt sdk/query context engine and drop spawnSync shell-outs ([pm-context-lk82](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-lk82.toon))

### Fixed

- context-usage redeclared host-owned --author global, failing registration on pm-cli 2026.7.27 ([pm-context-s8q4](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-s8q4.toon))

### Removed

- Adopt pm-cli 2026.7.26 typed authoring contracts and remove the any-cast defineExtension shim ([pm-context-q67i](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-q67i.toon))

### Other

- Exclude generated dist output from DeepScan static analysis ([pm-context-01lr](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-01lr.toon))

## 2026.7.26 - 2026-07-26

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([pm-context-x5qt](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-x5qt.toon))

## 2026.7.25 - 2026-07-25

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([pm-context-pf4e](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-pf4e.toon))

## 2026.7.23 - 2026-07-23

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-context-164t](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-164t.toon))

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

## 2026.7.10 - 2026-07-10

### Other

- Ecosystem release readiness pass 2026-07-06 ([pm-context-m959](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-m959.toon))

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
