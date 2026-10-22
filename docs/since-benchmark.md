# Public tracker resume measurement

Measured on 2026-10-21 with core CLI **2026.10.21**, package-pinned SDK
**2026.10.15**, and the committed public `unbraind/pm-cli` tracker at
`8ce50f94e5dcbeec5b5874dbf990c73a9e9d4b18`: **1,261 existing items**.
Only a Git archive extracted into a non-git scratch directory was modified.
The source checkout and its live tracker were read-only throughout.

Setup created and claimed one synthetic item, then established a checkpoint
before either measured session. Each session appended a short substantive
handoff comment to that item. The second session resumed the first cursor.
Neither route reread the full tracker into the agent context.

| Session | Core calls | Delta calls | Core output tokens | Delta output tokens | Core bytes | Delta bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First resume | 3 | 1 | 502 | 392 | 1,450 | 1,226 |
| Next resume | 3 | 1 | 546 | 392 | 1,599 | 1,228 |

Calls fall by **66.7%**; output tokens fall by **21.9%** and **28.2%**.
Tokens were counted from the complete actual stdout using `tiktoken==0.14.0`,
`o200k_base`, with special-token interpretation disabled. Each core response is
counted separately and the counts are summed. These are output tokens, excluding
prompts, tool-call framing, setup/checkpoint calls and oracle instrumentation.
Counts vary with generated IDs/timestamps and tokenizer. The runtime ceiling is
the stricter complete-response byte-token upper bound, independent of this
benchmark tokenizer. Both responses also fit a 4,000-byte ceiling, although this
measurement requested and verified a 12,000 ceiling. An earlier run used the
default ceiling because the handler missed the host's normalized option name;
these results replace it after the installed-CLI fix and an explicit runner
assertion for the requested ceiling.

The measured three-call route was:

```sh
pm activity --from "$from"
pm activity --from "$from" --raw
pm comments "$id"
```

The one-call route was:

```sh
pm context-pack since --cursor "$cursor" --token-budget 12000
```

**Completeness:** both sessions covered **1/1** matching immutable events,
with **0 missing events**, matching type/status/title metadata, the complete new substantive comment, the handoff
classification, the current own claim and **0 deferred rows**. An additional
unbounded raw JSON activity read served only as the oracle: each matching event's
item ID, operation, timestamp and author had to appear in the delta, and its new
comment had to appear in full. Type, status and title were checked against the
SDK-created item as well. The saved responses were also checked for the handoff
classification and own-claim reminder. Earlier-session comments that a plain comments
read repeats are intentionally outside the next delta. Full historical patch
payloads are not the completeness unit; the pack explicitly identifies changed
fields and provides a remedy for full patch reads.

The focused regression suite separately covers creation, close/reopen,
reprioritization, blockers and indirect unblocks, other-agent claims, release
messages, budget paging without lost rows, writes during paging, equal timestamps,
backdated appends, sparse legacy metadata, count/byte eviction, typed expiry, empty-refresh cursor advancement, competing
claim snapshots, and deletion without false reopen/unblock transitions.
Thus the public-copy token experiment is a two-session resumption sample, not a
claim that every event type or every tracker size has the same savings. An initial
experiment mistakenly included setup creation/claim events only in the delta;
that comparison was discarded and rerun with matching session boundaries.

Reproduce after building, using an installed current `pm` executable (or set
`PM_BENCHMARK_CLI` to an explicit executable):

```sh
npm ci
npm run build
node test/measure-since.ts "$PUBLIC_CHECKOUT" 8ce50f94e5dcbeec5b5874dbf990c73a9e9d4b18
uv run --with tiktoken==0.14.0 python - <<'PY'
from pathlib import Path
import tiktoken
enc = tiktoken.get_encoding('o200k_base')
for session in (1, 2):
    directory = Path('coverage/since-benchmark') / f'session-{session}'
    core = sum(len(enc.encode((directory / f'core-{i}.txt').read_text(), disallowed_special=())) for i in (1, 2, 3))
    delta = len(enc.encode((directory / 'delta.json').read_text(), disallowed_special=()))
    print(session, core, delta)
PY
```

The runner archives only committed tracker content, installs the local built
extension into the copy, verifies completeness, retains measured stdout under
ignored `coverage/since-benchmark`, and removes its scratch tracker. It does not
publish tracker contents. The checked-in runner produced these results and printed the CLI version; its
scratch tracker was removed after measurement.
