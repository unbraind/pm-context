# SDK adoption audit, 2026-10-25

Tracked by [pm-context-sdk-adoption-1025](https://github.com/unbraind/pm-context/blob/main/.agents/pm/tasks/pm-context-sdk-adoption-1025.toon),
related to the earlier [SDK adoption](https://github.com/unbraind/pm-context/blob/main/.agents/pm/features/pm-context-lk82.toon).
The dependency remains pinned to `@unbrained/pm-cli@2026.10.23`.

| Audit finding | Decision | Evidence |
| --- | --- | --- |
| `file-focus.ts:137-161`: folder enumeration, decoding and identity checks | Retained pending a cache-free complete-list API. `listAllComplete({includeBody:true})` plus `certifyCompleteListResult` writes metadata caches. The existing file-focus contract forbids those writes. | `test/sdk-adoption.test.ts` compares both real read paths on one fresh non-Git tracker. The current reader leaves runtime absent; the SDK creates metadata caches. Existing file-focus tests also cover custom extension folders, corrupt documents, duplicate identities and unchanged tracker bytes. |
| `since.ts:128-133`: history directory enumeration | Replaced stream discovery with `listMutationEvents` and its bounded page cursor. Removed the local history-directory enumeration. | Existing delta tests cover more than 1,000 streams, equal timestamps, backdated appends, compaction, prefix rewrites/removal and execution without Git. Differential results below compare event keys and cursor fingerprints too. |

The missing SDK capability is an explicit **cache-free/read-only complete-list
policy**, available through `PmCompleteListOptions` or `PmClientOptions`, which
preserves active type registrations and duplicate-identity refusal. The current
public options expose no such policy. The owner/orchestrator files this upstream;
this change does not alter the dependency pin or write upstream repositories.

`--since` retains its `runActivity` history-policy preflight and
`readHistoryEntries` physical-prefix reads. SDK event pages discover the streams;
raw history entries preserve the existing content hashes, original timestamp
spellings, per-stream ordinals and backdated completeness checks. Event entries
alone normalize timestamps and cannot prove physical append-only prefixes.
Subscriptions are unnecessary for a finite request; bounded pages provide the
SDK catch-up path without waiting for future writes. Item and history source
files remain unchanged. The SDK may create its disposable event index in runtime,
alongside the package's existing disposable cursor state.

## Intentional stricter SDK behavior

SDK event admission refuses malformed or sub-millisecond history timestamps with
`history_timestamp_invalid`, before publishing a context cursor. Previously,
malformed timestamps were disclosed and omitted, while valid sub-millisecond
spellings could be replayed. Restore or repair the source history using the
host's documented recovery workflow before retrying. No history is rewritten by
this package. Existing whitespace-spelling diagnostics remain supported because
the SDK accepts trimmed timestamps while physical-prefix reads retain raw text.

## Differential proof

Build the baseline from `origin/main` commit `9068fb1` and the candidate using the
same installed dependency graph. Export only committed tracker files from public
fleet repositories; do not use working tracker data or runtime caches. Then run:

```sh
node test/sdk-adoption-differential.ts "$BASELINE_DIST" dist "$PUBLIC_CONTEXT_TRACKER" "$PUBLIC_CSV_TRACKER"
```

The runner creates independent copies outside Git, protects item/history/settings
files against writes, removes Git from the subprocess PATH, and hashes source
bytes before and after. Disposable runtime and locks remain writable. It compares
full file-focus item reads, context packs, agent handoffs, SDK explanations,
initial deltas and resumed deltas. A fixed pack clock removes recency variance;
only delta `served_at` wall-clock fields are excluded. Cursors, keys, budgets,
omission receipts and all other output fields must match exactly.

| Public snapshot | Items | Initial delta rows | Comparisons | Source bytes |
| --- | ---: | ---: | ---: | --- |
| `unbraind/pm-context@9068fb1` | 92 | 1,044 | 6/6 identical | Unchanged |
| `unbraind/pm-csv@c7cb72b8e377743b7d6ae8787bf73c989c559754` | 126 | 1,000 | 6/6 identical | Unchanged |

The stricter malformed/sub-millisecond case is exercised separately by
`test/sdk-adoption.test.ts`, rather than modifying these public snapshots.

## Revert proof

Revert only `readStreams` to `9068fb1`, leaving the new tests intact:

```sh
node --test --test-name-pattern='SDK event admission' test/sdk-adoption.test.ts
```

Result: **1 failed**, `Missing expected rejection`. Restore SDK stream discovery:
both adoption tests pass (**2/2**). The existing delta suites pass **26/26**.
The blocked file-focus replacement has no revert proof; its capability test
demonstrates the missing side-effect policy directly against the real SDK.
