# Shared evidence validation

Exact-fit budgets are successful terminal states: once the complete receipt
consumes the byte ceiling, no positive-capacity SDK selector is invoked.
`test/zero-budget.test.ts` generates 500 exact/adjacent boundary cases across
both representations, JSON/TOON and source/compiled SDKs, checks the legacy
producer and zero item slots, and executes the reported 512-byte case through
installed Node/Bun CLIs without Git. Removing only the exhaustion guard in a
disposable copy makes the property fail with the original SDK TypeError;
restoring it passes. Packed acceptance also exercises exact JSON/TOON receipts
through all five install modes and Node/Bun SDK consumers.

Public source: the 98-item pm-context tracker at
[`c9f2994caf0b682def7a7fe6cf67beabbc89c978`](https://github.com/unbraind/pm-context/tree/c9f2994caf0b682def7a7fe6cf67beabbc89c978/.agents/pm).
`test/measure-shared-evidence.ts` copied the committed export to a non-Git
scratch project, made files/directories read-only, and checked the complete
before/after file inventory and byte fingerprint. Both stayed identical.

The scenario declares twenty benchmark obligations citing the actual 1,448-byte
`description` on `pm-context-m6cr`. These are explicit test declarations, not a
claim that recorded prose satisfies twenty native acceptance criteria. No
public tracker data was changed or synthesized.

| Transport | Expanded bytes | Factored bytes | Saved bytes | Bindings | Text copies |
| --- | ---: | ---: | ---: | ---: | ---: |
| JSON | 38,523 | 8,995 | 29,528 | 20 | 1 |
| TOON | 36,072 | 7,036 | 29,036 | 20 | 1 |

All twenty criteria were linked in both full representations. At the factored
packet's byte budget, expanded output retained three linked criteria; the rest
had explicit budget omissions. The legacy v1 packet measured 33,601 JSON bytes
and 32,056 TOON bytes. All figures include the final newline and every receipt;
they are transport bytes, not tokenizer counts or model-performance claims.

Reproduce with a committed public export containing `.agents/pm`:

```sh
node test/measure-shared-evidence.ts public-export
```

`test/shared-evidence.test.ts` checks twenty independent bindings, cross-item
sharing through an authoritative adapter, revision separation, an ABA native
edit, deterministic permutations, byte boundaries, complete-group omissions,
finite JSON extremes and sparse arrays, legacy-compatible empty/nested values,
and installed CLI execution with no Git executable. A native extension injects
competing SDK writes at all four item/history observation boundaries; the test
asserts refusal on detected interleaving and preserves the final-read window
as a consistent earlier observation. Missing legacy history remains readable.

The seeded state model executes 500 operation sequences over all 52 seeded
native fields, relationships, random custom active statuses, random ambient
focus, whitespace/CRLF variants, current requests and old-request replay.
Factored/expanded JSON and TOON are joined and checked against authoritative SDK
read-back; fields that the SDK has unset cause matching typed refusals. No
handwritten normalizer is used. There is no feature import or sync operation.

Behavioral reversions run only in a disposable copy: removing deduplication
causes the twenty-binding test to fail; removing revision identity causes the
distinct-revision assertion to fail. Restoring the producer passes the same
test. The reviewed worktree is never mutated for these proofs.

`test/packed-shared-evidence.ts` consumes one captured npm artifact, checks its
SHA-256 before and after, and installs it with isolated credentials-free npm and
Bun hosts. It exercises real project-local, npm-global, Bun-global, npx and
bunx CLI entry points plus SDK consumption from the three installed packages.
The SDK is imported through its supported package exports; no argv, executable
symlink or installation-path discovery is used by the feature.

```sh
node test/packed-shared-evidence.ts captured-package.tgz 2026.10.28
```

The full npm/Bun release gates run in CI at the repository's unchanged coverage
thresholds. Local checks are targeted tests, type checks, the docstring gate and
whitespace validation. No separate lint script is configured by this package.
