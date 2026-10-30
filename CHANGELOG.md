# Changelog

## Unreleased

### Fixed

- Restore generated notes for the prepared 2026.10.29 release ([pm-context-release-notes-1029](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-release-notes-1029.toon))
- Resume must consume a verified same-version changelog recovery ([pm-context-resume-recovery-sha](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-resume-recovery-sha.toon))

## 2026.10.29 - 2026-10-29

### Added

- Factor shared criterion evidence into one revision-bound fragment ([pm-context-shared-fragment-evidence](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-shared-fragment-evidence.toon))

### Fixed

- Reject sparse evidence acquisition contracts before planning ([pm-context-acquisition-boundary](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-acquisition-boundary.toon))

## 2026.10.28 - 2026-10-28

### Added

- Keep mandatory task-phase context fields and explain phase switches ([pm-context-task-phase-contracts](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-task-phase-contracts.toon))

### Other

- Point the npm homepage at the package catalog and link the author ([pm-context-78wz](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-78wz.toon))
- Stop Hound from linting generated dist/ output ([pm-context-hound-generated-dist](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-hound-generated-dist.toon))

## 2026.10.26 - 2026-10-26

### Added

- Plan the cheapest next reads for missing criterion evidence ([pm-context-next-evidence](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-next-evidence.toon))

### Fixed

- Saved acquisition plans retain numeric estimates through JSON round trips ([pm-context-json-estimates](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-json-estimates.toon))

### Other

- Use SDK reads for file focus and resumable deltas ([pm-context-sdk-adoption-1025](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-sdk-adoption-1025.toon))

## 2026.10.25 - 2026-10-25

### Added

- Pack criterion evidence with exact budget coverage receipts ([pm-context-coverage-pack](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-coverage-pack.toon))
- Return smallest cited witnesses for contradictory context claims ([pm-context-kzoe](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-kzoe.toon))
- Resumable since delta packs with substantive messages and claims ([pm-context-8bbh](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-8bbh.toon))
- Validate only context assumptions invalidated on resume ([pm-context-vusp](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-vusp.toon))

### Fixed

- Preserve highest-overlap focus during capped packing ([pm-context-gb70](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-gb70.toon))
- Preserve repository roots ending in whitespace for file focus ([pm-context-gyq1](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-gyq1.toon))

### Other

- Certify complete context corpora and recover abandoned receipt locks ([pm-context-pbcw](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-pbcw.toon))
- Correct tracker reconciliation review evidence for PR 163 ([pm-context-r163](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-r163.toon))

## 2026.10.23 - 2026-10-23

### Added

- Focus context packs on changed and explicit files ([pm-context-ax7z](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-ax7z.toon))

### Changed

- Enable the gated GitHub issue sync ([pm-context-53bz](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-53bz.toon))
- Adopt pm-github 2026.10.16: default-branch-safe gated sync and daily gated closeout PRs ([pm-context-05ub](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-05ub.toon))

### Fixed

- A release that merges but fails to publish is abandoned by the next day's run ([pm-context-7yrb](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-7yrb.toon))
- Harden the release merge wait against mergeStateStatus deadlock ([pm-context-jjbl](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-jjbl.toon))
- The changelog gate stamps an untagged version with the current date, so its verdict flips every midnight with no commit ([pm-context-a9iw](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-a9iw.toon))
- The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green ([pm-context-594y](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-594y.toon))
- A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last ([pm-context-p965](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-p965.toon))

### Other

- Enable GitHub CodeQL code scanning ([pm-context-f4tl](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-f4tl.toon))
- Certify pm-context on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates ([pm-context-ht20](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-ht20.toon))

## 2026.10.21 - 2026-10-21

### Closed

- Closed: Daily Release workflow is failing ([pm-context-github-356cb2a080ed-81](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-github-356cb2a080ed-81.toon))

## 2026.10.14 - 2026-10-14

### Fixed

- Dependency projection relabels non-ordering relationships as depends_on and reverses blocks ([pm-context-github-356cb2a080ed-136](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-github-356cb2a080ed-136.toon))

## 2026.10.12 - 2026-10-12

### Added

- pm context-usage: report which served context an agent actually used ([pm-context-ci6v](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-ci6v.toon))

## 2026.10.5 - 2026-10-05

### Other

- Auto-merge green Dependabot updates and group the pm toolchain into one daily PR ([pm-context-h34i](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-h34i.toon))

## 2026.9.26 - 2026-09-26

### Other

- Certify pm CLI 2026.9.23 and adopt the guarded pm-ops merge-driver launcher ([pm-context-h04z](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-h04z.toon))

## 2026.9.22 - 2026-09-22

### Fixed

- A publish that npm accepts late is reported as failed and the GitHub Release is skipped on bun mirror lag ([pm-context-ims7](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-ims7.toon))

### Other

- Certify pm CLI 2026.9.21 and install merge drivers through the canonical pm-ops launcher ([pm-context-2axh](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-2axh.toon))

## 2026.9.18 - 2026-09-18

### Other

- Certify pm CLI 2026.9.17 ([pm-context-ptx2](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-ptx2.toon))

## 2026.9.13 - 2026-09-13

### Other

- Certify pm CLI 2026.9.12 and the pm-ops 2026.9.11 auditor ([pm-context-0ruy](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-0ruy.toon))

## 2026.9.11 - 2026-09-11

### Other

- Certify pm CLI 2026.9.10 and pick up the canonical auditor fixes the lockfile was holding back ([pm-context-syd5](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-syd5.toon))

## 2026.9.8 - 2026-09-08

### Security

- Consume the canonical attestation gate instead of carrying a copy of it ([pm-context-m6cr](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-m6cr.toon))

## 2026.9.6 - 2026-09-06

### Other

- Recognize context-usage delivery events on pm-cli 2026.9.5 ([pm-context-d77x](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-d77x.toon))

## 2026.8.31 - 2026-08-31

### Fixed

- Remove the unused changelog verifier test import ([pm-context-91b3](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-91b3.toon))
- Keep CodeQL actions versioned and updated as one unit ([pm-context-zwf1](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-zwf1.toon))
- Rebase the changelog date verifier onto the current release workflow ([pm-context-o76d](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-o76d.toon))

### Closed

- Closed: Pin pm-changelog 2026.8.30 before the next release ([pm-context-4w80](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-4w80.toon))

## 2026.8.29 - 2026-08-29

### Fixed

- Refuse the unattested publish fallback after provenance failure ([pm-context-fuhi](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-fuhi.toon))
- Preserve append-only provenance history during review repair ([pm-context-9xfx](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-9xfx.toon))
- Make the affinity tiebreak test use one shared instant ([pm-context-hxj5](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-hxj5.toon))

## 2026.8.28 - 2026-08-28

### Fixed

- changelog scripts read the pm workspace with default budgets instead of canonical complete reads ([pm-context-8th2](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-8th2.toon))

### Other

- Alert on daily release failure and require merge drivers in CI ([pm-context-qu0a](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-qu0a.toon))

### Closed

- Closed: The identity gate deadlocks the one remediation its own failure message prescribes ([pm-context-nfxp](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-nfxp.toon))

## 2026.8.16 - 2026-08-16

### Fixed

- A truncated list-all answer is consumed as if it were complete ([pm-context-kfdx](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-kfdx.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- Duplicate changelog verification steps ran the same replace-mode check twice in CI ([pm-context-btl1](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-btl1.toon))
- The release merge-wait read branch protection which the workflow token can never read ([pm-context-vu89](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-vu89.toon))

### Other

- Adopt the canonical docstring gate so the documented surface cannot regress silently ([pm-context-ylx4](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-ylx4.toon))

## 2026.8.9 - 2026-08-09

### Fixed

- Release workflow publishes npm before advancing protected main (GH006 desync) ([pm-context-b7ub](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-b7ub.toon))

### Other

- Restore the 2026.8.9 release on main to match npm ([pm-context-1fqt](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-1fqt.toon))
- Adopt pm CLI 2026.8.7 and protect extension assets during multi-agent merges ([pm-context-5njx](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-5njx.toon))

### Closed

- Closed: Release changelog generate and check derived the section name from two different sources ([pm-context-cilu](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-cilu.toon))

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

## 2026.8.1 - 2026-08-01

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

### Removed

- Adopt pm-cli 2026.7.26 typed authoring contracts and remove the any-cast defineExtension shim ([pm-context-q67i](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-q67i.toon))

### Other

- Exclude generated dist output from DeepScan static analysis ([pm-context-01lr](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-01lr.toon))

### Closed

- Closed: context-usage redeclared host-owned --author global, failing registration on pm-cli 2026.7.27 ([pm-context-s8q4](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-s8q4.toon))

## 2026.7.26 - 2026-07-26

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([pm-context-x5qt](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-x5qt.toon))

## 2026.7.25 - 2026-07-25

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([pm-context-pf4e](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-pf4e.toon))

## 2026.7.23 - 2026-07-23

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-context-4apx](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-4apx.toon))

### Closed

- Closed: Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-context-164t](https://github.com/unbraind/pm-context/blob/main/.agents/pm/issues/pm-context-164t.toon))

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
