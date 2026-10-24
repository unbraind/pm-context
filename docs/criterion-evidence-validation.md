# Public tracker validation

Source: the public pm-context tracker at main commit
`c484938837a10e2b0963300d604c748e5c22f5f9` (89 items).
A certified complete SDK census found 29 items with both actual acceptance
criteria and linked tests. The first eight by ID supplied their first declared
criterion plus bindings to their recorded title and linked-test fields. A ninth
criterion deliberately had no producer-declared evidence.

`node test/validate-evidence-data.ts public-tracker-copy` reproduces the
measurement from an exported tracker snapshot. The script copies only tracker
data into a fresh non-Git temporary directory. Census initialization precedes
freezing all copied files read-only; packing then leaves the entire copy's
recursive SHA-256 fingerprint unchanged. No public source tracker is written.
The validation ran with Git discovery bounded at the temporary directory's parent.
The installed-command regression separately removes Git from PATH.

| Format | Byte ceiling | Actual bytes | Self-inclusive upper bound | Linked criteria | Budget omissions | Unlinked | Evidence rows |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| JSON | 20000 | 6485 | 6486 | 8 | none | AC9 | 16 |
| JSON | 4540 | 4341 | 4341 | 6 | AC4, AC7 | AC9 | 12 |
| TOON | 20000 | 5539 | 5540 | 8 | none | AC9 | 16 |
| TOON | 3877 | 3555 | 3555 | 6 | AC4, AC7 | AC9 | 12 |

All four packs retained all nine criterion rows and disclosed all 16 distinct
source-field sizing reads. Reversing both criterion order and binding order
produced identical results in all four cases. The smaller ceilings are 70% of
the corresponding full output upper bounds. AC4 and AC7 lose their whole evidence
groups; AC9 remains separately unlinked. Citations and receipts are included in
the measurements. Recorded test commands were copied as evidence, not executed;
this measurement does not claim those original acceptance criteria passed.

The focused regression command is:

```sh
node --test test/evidence-packing.test.ts test/renderer-ownership.test.ts
```

It passed 10/10 tests through the pinned pm test runner. The command-registration
regression passed 1/1 separately. Native and c8 focused measurements of the new
packing module both measured 100% lines, branches and functions; c8 additionally
measured 100% statements. TypeScript source/test checks, the repository's
docstring gate and `git diff --check` passed. There is no separate lint script.

Behavioral revert proof: changing only `packCriterionEvidence` to pass an
unbounded selection allowance to the SDK, keeping all other code unchanged,
caused the real-tracker regression to fail: AC2 became `linked` instead of
`budget_omitted`. Restoring the budget calculation restored the passing test.

Full-package release evidence comes from the PR's npm and Bun CI release gates
on Node 22 and 26, at unchanged thresholds. Local full gates were deferred because
of host CPU saturation. A clean-home strict tracker health check passed. The
normal local home exposed an unrelated installed-extension host version skew;
no dependency pin, global extension or history record was changed to hide it.

Code head `808301d` passed [CI run 40072556257](https://github.com/unbraind/pm-context/actions/runs/40072556257):
`npm run release:check` and `bun run release:check` each passed 403/403 tests on
Node 22 and 26 (four successful full gates, 1612 main-suite test executions).
Package native coverage measured 100% lines/branches/functions. Package c8
coverage measured 100% statements/lines/functions and 99.95% branches, exceeding
the unchanged 99.9% c8 branch threshold. The new evidence module measured 100%
on all four c8 dimensions. The CI also passed strict tracker health, committed
build reproducibility, changelog validation, production audit and package checks.
The documentation/PM receipt commit is verified separately on its final PR head.
