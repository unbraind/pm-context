# SDK codecs and UTF-8 receipt accounting

This implements the remaining G5 adoption from the 2026-11-06 audit, tracked by
[pm-context-sdk-codecs-utf8](https://github.com/unbraind/pm-context/blob/main/.agents/pm/chores/pm-context-sdk-codecs-utf8.toon).
The companion specification is `pm-cli-website-nzm7`; the companion tracker is
read only. The existing development SDK pin remains 2026.11.4. The declared 2026.10.23
peer floor also exports the host codecs; the published declarations were checked.

`estimatePmOutputTokens(Buffer.byteLength(text, "utf8"))` replaces character
counts in item projection costs, served facts and protocol overhead. JSON fact
values are serialized first, so escaping is included. Repeated facts retain
per-occurrence estimates. Receipt overhead measures the difference between the
complete emitted output and input bytes, including the final newline; JSON
re-serialization stabilizes the receipt's own counter digits before persistence.
Whitespace removed by serialization cannot produce negative protocol costs.
Fact IDs, citation associations, receipt retention and native locking are
unchanged. Facts and protocol overhead remain separate measures rather than a
claim that their independently rounded estimates sum to an exact tokenizer cost.

The host's public `encodeToon` export from `sdk/testing` replaces handwritten
TOON containers in freshness, witnesses, next-evidence and criterion evidence.
That entry point is the installed host's supported generic codec export; no
private host modules are imported. Existing answer reduction, task-phase and
shared-evidence serializers also use that host codec. JSON remains native
`JSON.stringify`. TOON whitespace, quoting and tabular choices follow the host
codec; the decoded domain shapes remain unchanged. Next-evidence additionally
retains the SDK's `encodePmTableRows` wire schema and all its encoding metadata,
restored with `decodePmTableRows` after TOON decoding.

## Domain rules retained

- Context selection already uses `packContextCandidates`; only its projection
  cost estimator changes. The 220-token per-slot allocation is a ranking input,
  while `max-items` remains a count limit. This is not whole-output fitting.
- Next-evidence acquisition costs are producer-declared tokens plus weighted
  tool calls. They are not estimates of the plan's serialized output.
- Witness budgets remain UTF-8 bytes and refuse an entire oversized witness;
  citations and supersession references are never split.
- Freshness keeps a linear prefix selection, source counts, omitted-section
  counts, recovery guidance and the requirement that a stale packet contain at
  least one invalidated section. Single-row SDK render deltas provide sizing
  without local container grammar or repeatedly encoding the whole packet.
- Criterion evidence still uses the SDK packer over byte-cost candidates and
  admits complete criterion groups. Standalone SDK row encodings conservatively
  reserve transport overhead; the complete serialized output remains below its
  reported byte ceiling. Source completeness and coverage receipts remain.
- `context-pack since` explicitly declares `budget.unit = "utf8-bytes"`, even
  though its historical option is named `--token-budget`. Its byte-fallback
  upper bound and cursor/omission protocol remain unchanged.

There is no package-owned whole-envelope estimated-token fitting loop to replace
with `fitOutputEnvelope`. The SDK fitter exists in the installed public API;
introducing its token units or an extra `output_fit` wire receipt into these
existing byte protocols would change their contract. The package retains only
the domain byte admission described above.

## Regression and behavioral revert evidence

`node --test --test-concurrency=2 test/sdk-codecs-utf8.test.ts` exercises real
non-Git temporary trackers created, mutated and read through the installed SDK;
there are no SDK mocks. It covers Unicode and JSON escaping, repeated facts,
self-inclusive protocol overhead, UTF-8 projection selection, canonical host
codec round trips, exact witness byte boundaries, freshness omissions and
complete evidence groups. Existing CLI and compiled-package suites exercise the
same transports and preserve restoration instructions.

For each proof, copy the candidate sources and tests to a disposable directory,
restore only the named function from `origin/main` (`87b6e4f`), and run the
matching test-name pattern against `test/sdk-codecs-utf8.test.ts`:

| Reverted function | Test-name pattern | Expected failure count |
| --- | --- | ---: |
| `serveContextReceipt` | `SDK UTF-8 fact\|SDK receipt overhead` | 2 |
| `estimateTokens` | `SDK projection costs` | 1 |
| `encodeNextEvidencePlan` | `SDK next-evidence codec` | 1 |
| `encodeWitnessReport` | `SDK witness codec` | 1 |
| `encodeFreshness` | `SDK freshness codec` | 1 |
| `encodeEvidencePack` | `SDK evidence codec` | 1 |

The old estimator's removed constant is inlined as `0.25` in its disposable
function revert. Every revert must exit 1 through behavioral assertions, never
an import/build failure. Restore the candidate functions in `finally`, then run
all seven regression tests again. The reviewed worktree is never mutated by
these proofs. Concurrency tests are not required for this codec/accounting
change: the native lease mechanism is unchanged and retains its existing
cross-process tests.
