# Public tracker freshness validation

Source: the public `unbraind/pm-context` tracker and README at
`42de04b` on `feat/since-delta-pack` (PR #164). The experiment exported only
tracked text files into a plain scratch directory; no Git metadata, hosted
tracker, credentials or private workspace data was used.

Command: `node test/measure-freshness.ts "$FRESHNESS_PUBLIC_INPUT"`, with
`FRESHNESS_PUBLIC_INPUT` pointing to that export, an empty executable PATH and
Git discovery bounded above the scratch directory. The script uses the real
SDK to prepare disposable changed/deleted variants, then makes all source
files read-only before recording and validation. The unavailable variant also
removes read permissions from its evidence file. No validator operation writes
source files, history or usage ledgers; an exact tree fingerprint, including
file names and bytes, is unchanged after every scenario.

Measured on a CPU-saturated shared host; times are observations, not performance
thresholds or capacity claims. There were **82 real items, 85 sections and 84
unique sources**. The complete manifest occupied **10791 JSON bytes** and took
**821.89 ms** to record.

| Scenario | Verdict | Unchanged sections | Invalidated sections | Unavailable sources | JSON bytes | TOON bytes | Resume ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Unchanged | FRESH | 85 | 0 | 0 | 394 | 381 | 1424.83 |
| One item, settings and evidence changed | STALE | 81 | 4 | 0 | 770 | 778 | 2076.98 |
| Deleted prerequisite and unreadable evidence | SOURCE_UNAVAILABLE | 82 | 3 | 2 | 718 | 721 | 733.70 |

The fourth invalidation in the changed scenario is the dependent plan section.
The unchanged and refused scenarios also inspect every declared source. Every
resume response fits the 4000-byte ceiling without omitted rows. Unit tests
separately exercise smaller budgets, explicit omission receipts, transitive
and diamond dependencies, selected-field reuse, stable digests, malformed
inputs and concurrent source changes. The installed CLI regression runs with
no Git executable and confirms the unavailable verdict exits 2.
