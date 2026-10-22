/** Resumable delta serving; SDK history remains the only durable event authority. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PmCliError, applyHistoryPatch, readHistoryEntries, resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk";
import { runActivity } from "@unbrained/pm-cli/sdk/query";
/** Runtime snapshots are disposable, bounded, and never stored in item history. */
export const SINCE_RETENTION = { count: 200, bytes: 4_194_304, directory: "runtime/context-since" };
/** Explicit recovery contracts for expired history, bad input, and impossible budgets. */
export class SinceError extends PmCliError {
    /** Action that restores a usable starting point. */
    remedy;
    constructor(code, remedy) {
        super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] });
        this.remedy = remedy;
    }
}
/** Parse explicit-zone ISO timestamps without normalizing invalid calendar dates. */
function parseFromTimestamp(value) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if (!match)
        return NaN;
    // setUTCFullYear preserves years 0000–0099, unlike Date.UTC's 1900 offset.
    const monthEnd = new Date(0);
    monthEnd.setUTCFullYear(Number(match[1]), Number(match[2]), 0);
    if (Number(match[3]) > monthEnd.getUTCDate())
        return NaN;
    return Date.parse(value);
}
/** Hash JSON content rather than timestamps, so equal-time and late events survive. */
function digest(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Keep object traversal typed when histories contain arbitrary custom metadata. */
function record(value) {
    return value !== null && typeof value === "object" ? value : {};
}
/** Extract bounded prose while disclosing every character removed from excerpts. */
function excerpt(value, max) {
    const points = [...value];
    return { text: points.slice(0, max).join(""), omitted: Math.max(0, points.length - max) };
}
/** Use code-unit ordering, independent of process locale. */
function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/** Apply SDK history policy/read hooks, then retain physical stream order for equal/backdated timestamps. */
async function readStreams(pmRoot) {
    const streams = [];
    await runActivity({ raw: true, compact: true, limit: "1" }, { path: pmRoot });
    for (const file of readdirSync(join(pmRoot, "history")).filter((name) => name.endsWith(".jsonl")).sort()) {
        const id = file.slice(0, -6);
        const entries = await readHistoryEntries(join(pmRoot, "history", file), id);
        streams.push(entries.map((entry, ordinal) => ({ ...entry, id, ordinal, key: digest([id, ordinal, entry]) })));
    }
    return streams;
}
/** Merge indexed frontiers without sorting or moving the remaining stream entries. */
function mergeEvents(streams) {
    const indices = streams.map(() => 0);
    const events = [];
    for (;;) {
        let next;
        let selected = -1;
        for (const [index, stream] of streams.entries()) {
            const candidate = stream[indices[index]];
            if (candidate && (!next || (compare(candidate.ts, next.ts) || compare(candidate.id, next.id)) < 0)) {
                next = candidate;
                selected = index;
            }
        }
        if (!next)
            return events;
        events.push(next);
        indices[selected]++;
    }
}
/** Hash physical event order, including ordinals, to reject prefix rewrites. */
function fingerprint(streams) {
    return streams.filter((stream) => stream.length > 0).map((stream) => ({
        id: stream[0].id, count: stream.length, hash: digest(stream.map((event) => event.key)),
    }));
}
/** Check retained prefixes without merging; later ordinals remain eligible even if backdated. */
function validatePrefixes(streams, previous) {
    const current = new Map(streams.filter((stream) => stream.length > 0).map((stream) => [stream[0].id, stream]));
    for (const prefix of previous) {
        const stream = current.get(prefix.id);
        if (!stream || stream.length < prefix.count || digest(stream.slice(0, prefix.count).map((event) => event.key)) !== prefix.hash) {
            throw new SinceError("HISTORY_EXPIRED", "Retained history changed or was pruned. Reorient with pm context --for handoff, then restart with --from <ISO timestamp>.");
        }
    }
}
/** Derive active blockers from tracker-owned statuses and explicit blocking edges. */
function blockers(documents, terminal, registry) {
    const result = new Map();
    for (const [id, item] of documents) {
        if (terminal.has(String(item.status)))
            continue;
        const legacy = item.blocked_by;
        const legacyActive = typeof legacy === "string" && legacy.trim() && !terminal.has(String(documents.get(legacy.trim())?.status));
        if (item.status === "blocked" || item.blocked_reason || legacyActive)
            result.set(`${id}:status`, id);
        const deps = Array.isArray(item.dependencies) ? item.dependencies : [];
        for (const value of deps) {
            const dep = record(value);
            const target = String(dep.id);
            const definition = registry.resolve(dep.kind);
            if (definition?.ordering) {
                const [waiting, prerequisite] = definition.precedence === "target_before_source" ? [id, target] : [target, id];
                if (!terminal.has(String(documents.get(prerequisite)?.status)) && !terminal.has(String(documents.get(waiting)?.status)))
                    result.set(`${waiting}:${prerequisite}`, waiting);
            }
        }
    }
    return result;
}
/** New comment/note prose only; metadata-wide replacements do not repeat older text. */
function addedProse(before, after) {
    const text = [];
    for (const field of ["comments", "notes", "learnings"]) {
        const remaining = new Map();
        for (const value of Array.isArray(before[field]) ? before[field] : []) {
            const key = JSON.stringify(value);
            remaining.set(key, (remaining.get(key) ?? 0) + 1);
        }
        for (const value of Array.isArray(after[field]) ? after[field] : []) {
            const key = JSON.stringify(value);
            const count = remaining.get(key) ?? 0;
            if (count > 0) {
                remaining.set(key, count - 1);
                continue;
            }
            const prose = record(value).text;
            if (typeof prose === "string")
                text.push(prose);
        }
    }
    return text;
}
/**
 * Replay with the SDK patcher to distinguish actual transitions and indirect
 * unblocks, then retain an event row even for edits outside the named categories.
 */
function classify(events, selected, terminal, items) {
    const streamed = new Set(events.map((event) => event.id));
    const documents = new Map(items.filter((item) => !streamed.has(item.id)).map((item) => [item.id, { ...item }]));
    const bodies = new Map();
    const rows = [];
    const registry = resolveWorkspaceRelationshipKindRegistry();
    let blocked = blockers(documents, terminal, registry);
    for (const event of events) {
        const before = documents.get(event.id) ?? {};
        const document = applyHistoryPatch({ metadata: before, body: bodies.get(event.id) ?? "" }, event.patch, event.ordinal + 1, event.op);
        const after = document.metadata;
        documents.set(event.id, after);
        bodies.set(event.id, document.body);
        // Ancestor replacements can change every graph field, including imported baselines.
        const touchesGraph = event.op === "create" || event.op === "delete"
            || event.patch.some((patch) => /^(?:|\/metadata(?:\/(?:status|dependencies|blocked_by|blocked_reason)(?:\/.*)?)?)$/.test(patch.path));
        const nextBlocked = touchesGraph ? blockers(documents, terminal, registry) : blocked;
        if (selected.has(event.key)) {
            const kinds = [];
            if (event.op === "create")
                kinds.push("created");
            if (terminal.has(String(after.status)) && !terminal.has(String(before.status)))
                kinds.push("closed");
            if (terminal.has(String(before.status)) && typeof after.status === "string" && !terminal.has(after.status))
                kinds.push("reopened");
            if (event.op !== "create" && after.priority !== undefined && before.priority !== after.priority)
                kinds.push("reprioritized");
            const prose = addedProse(before, after);
            if (prose.length)
                kinds.push("comment");
            if (event.op === "release")
                kinds.push("release", "handoff");
            if (event.op === "claim")
                kinds.push("claim");
            const text = [...prose, event.message ?? ""].filter(Boolean).join("\n");
            if (/handoff|hand.over|release/i.test(text))
                kinds.push("handoff");
            const clipped = excerpt(text, 384);
            const title = excerpt(String(after.title ?? before.title ?? event.id), 128);
            const row = {
                key: event.key, id: event.id, op: event.op, ts: event.ts, author: event.author,
                kinds: [...new Set(kinds)], title: title.text, type: String(after.type ?? before.type ?? "unknown"), status: String(after.status ?? before.status ?? "unknown"), priority: Number(after.priority ?? 4),
                fields: [...new Set(event.patch.map((patch) => patch.path))], text: clipped.text,
                excerpt_omitted_chars: clipped.omitted + title.omitted,
            };
            // Include scalar transitions as prose; full patches remain available in history.
            const transitions = ["status", "priority", "assignee", "blocked_reason", "blocked_by", "release"].filter((field) => before[field] !== after[field]);
            if (transitions.length) {
                const values = excerpt(transitions.map((field) => `${field}: ${String(before[field])} -> ${String(after[field])}`).join("; "), 256);
                row.text = [row.text, values.text].filter(Boolean).join("\n");
                row.excerpt_omitted_chars += values.omitted;
            }
            for (const [key, id] of nextBlocked) {
                if (!blocked.has(key)) {
                    const title = excerpt(String(documents.get(id)?.title ?? id), 128);
                    rows.push({ ...row, key: `${row.key}:blocked:${key}`, id, op: "blocked", kinds: ["blocked"], title: title.text, type: String(documents.get(id)?.type ?? "unknown"), status: String(documents.get(id)?.status ?? "unknown"), text: key, priority: Number(documents.get(id)?.priority ?? 4), excerpt_omitted_chars: title.omitted });
                }
            }
            const unblocked = new Set();
            const waitingNow = new Set(nextBlocked.values());
            for (const [key, id] of blocked) {
                if (nextBlocked.has(key) || unblocked.has(id) || waitingNow.has(id))
                    continue;
                const status = documents.get(id)?.status;
                if (typeof status !== "string" || terminal.has(status))
                    continue;
                unblocked.add(id);
                const title = excerpt(String(documents.get(id)?.title ?? id), 128);
                const removed = excerpt([...blocked].filter(([edge, waiting]) => waiting === id && !nextBlocked.has(edge)).map(([edge]) => edge).join(", "), 384);
                rows.push({ ...row, key: `${row.key}:unblocked:${id}`, id, op: "unblocked", kinds: ["unblocked"], title: title.text, type: String(documents.get(id)?.type ?? "unknown"), status, text: removed.text, priority: Number(documents.get(id)?.priority ?? 4), excerpt_omitted_chars: title.omitted + removed.omitted });
            }
            rows.push(row);
        }
        blocked = nextBlocked;
    }
    const waitingAtEnd = new Set(blocked.values());
    for (const row of rows) {
        if (row.kinds[0] === "blocked")
            row.superseded = !blocked.has(row.text);
        if (row.kinds[0] === "unblocked") {
            const status = documents.get(row.id)?.status;
            row.superseded = waitingAtEnd.has(row.id) || typeof status !== "string" || terminal.has(status);
        }
    }
    return { rows, snapshots: [...documents].map(([id, metadata]) => ({ ...metadata, id })), blockers: blocked };
}
/** Prioritize blockers, own work, handoffs and newly actionable work, then priority. */
function rank(row) {
    if (row.superseded)
        return 11;
    if (row.blocked)
        return 0;
    for (const [index, kind] of ["blocked", "own_claim", "handoff", "unblocked", "claim", "reopened", "reprioritized", "created", "comment", "closed"].entries()) {
        if (row.kinds.includes(kind))
            return index;
    }
    return 10;
}
/** Decode only content-addressed state from this tracker; never follow cursor paths. */
function readCheckpoint(directory, token, author) {
    if (!/^s1_[a-f0-9]{64}$/.test(token))
        throw new SinceError("INVALID_CURSOR", "Use the opaque cursor returned by context-pack since.");
    let raw;
    try {
        raw = readFileSync(join(directory, `${token}.json`), "utf8");
    }
    catch {
        throw new SinceError("CURSOR_EXPIRED", "Reorient with pm context --for handoff, then restart using --from <ISO timestamp>; retained cursor state is unavailable.");
    }
    let state;
    try {
        state = JSON.parse(raw);
    }
    catch {
        throw new SinceError("INVALID_CURSOR", "Restart with --from <ISO timestamp>; cursor state is damaged.");
    }
    if (`s1_${digest(state)}` !== token)
        throw new SinceError("INVALID_CURSOR", "Restart with --from <ISO timestamp>; cursor state is damaged.");
    if (!Array.isArray(state.streams))
        throw new SinceError("CURSOR_EXPIRED", "Restart with --from <ISO timestamp>; this cursor uses an obsolete checkpoint format.");
    if (state.author !== author)
        throw new SinceError("CURSOR_AUTHOR_MISMATCH", "Resume with the original --author or start a new --from session.");
    return state;
}
/** Atomically publish content-addressed state and evict oldest snapshots within fixed limits. */
function saveCheckpoint(directory, state) {
    const raw = JSON.stringify(state);
    if (Buffer.byteLength(raw) > SINCE_RETENTION.bytes)
        throw new SinceError("CURSOR_CAPACITY", "Restart with a later --from timestamp to reduce pending rows; if the stream inventory alone exceeds capacity, use a smaller tracker. Checkpoint exceeds the runtime retention capacity.");
    const token = `s1_${digest(state)}`;
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `${token}.${randomUUID()}.tmp`);
    writeFileSync(temporary, raw, { mode: 0o600 });
    renameSync(temporary, join(directory, `${token}.json`));
    const files = readdirSync(directory).filter((file) => /^s1_[a-f0-9]{64}\.json$/.test(file)).flatMap((file) => {
        const stats = statSync(join(directory, file), { throwIfNoEntry: false });
        return stats ? [{ file, size: stats.size, mtimeMs: stats.mtimeMs }] : [];
    })
        .sort((a, b) => a.mtimeMs - b.mtimeMs || compare(a.file, b.file));
    let bytes = files.reduce((sum, file) => sum + file.size, 0);
    let count = files.length;
    for (const file of files) {
        if (count <= SINCE_RETENTION.count && bytes <= SINCE_RETENTION.bytes)
            break;
        if (file.file === `${token}.json`)
            continue;
        rmSync(join(directory, file.file), { force: true });
        bytes -= file.size;
        count--;
    }
    return token;
}
/** Serialize with a conservative byte-token upper bound, including its own digits. */
export function encodeSincePack(pack) {
    let output = `${JSON.stringify(pack)}\n`;
    while (pack.budget.token_upper_bound !== Buffer.byteLength(output)) {
        pack.budget.token_upper_bound = Buffer.byteLength(output);
        output = `${JSON.stringify(pack)}\n`;
    }
    return output;
}
/**
 * Serve one deterministic ranked page. Pending pages freeze their source window;
 * writes arriving while they drain are collected after the last pending page.
 * Byte-level budgeting upper-bounds byte-fallback tokenizer costs without an
 * unpinned model tokenizer dependency. Nothing is silently consumed on overflow.
 */
export async function buildSincePack(pmRoot, items, terminal, options) {
    if ((!options.cursor === !options.from) || !options.author.trim())
        throw new SinceError("INVALID_ARGUMENT", "Supply exactly one of --cursor or --from and a nonempty --author.");
    if (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget < 512)
        throw new SinceError("INVALID_BUDGET", "--token-budget must be an integer of at least 512.");
    const directory = join(pmRoot, SINCE_RETENTION.directory);
    const previous = options.cursor ? readCheckpoint(directory, options.cursor, options.author) : undefined;
    const streams = await readStreams(pmRoot);
    if (previous)
        validatePrefixes(streams, previous.streams);
    let rows;
    let snapshot;
    if (previous && previous.pending.length) {
        rows = previous.pending;
        snapshot = previous.streams;
    }
    else {
        const events = mergeEvents(streams);
        const from = options.from === undefined ? undefined : parseFromTimestamp(options.from);
        if (from !== undefined && !Number.isFinite(from))
            throw new SinceError("INVALID_FROM", "--from must be a valid ISO timestamp with seconds and an explicit Z or ±HH:MM offset.");
        if (from !== undefined && events.some((event) => event.op === "history_compact_baseline" && Date.parse(event.ts) >= from))
            throw new SinceError("HISTORY_EXPIRED", "Requested time predates retained history. Reorient with pm context --for handoff and restart after the compacted baseline.");
        const prior = new Map(previous?.streams.map((stream) => [stream.id, stream.count]));
        const selected = new Set(events.filter((event) => from === undefined ? event.ordinal >= (prior.get(event.id) ?? 0) : Date.parse(event.ts) >= from).map((event) => event.key));
        const classified = classify(events, selected, terminal, items);
        rows = classified.rows;
        const snapshots = new Map(items.map((item) => [item.id, item]));
        for (const item of classified.snapshots)
            snapshots.set(item.id, item);
        for (const item of snapshots.values()) {
            if (item.assignee === options.author && !terminal.has(String(item.status))) {
                const title = excerpt(String(item.title ?? item.id), 128);
                const refs = [...classified.blockers].filter(([, waiting]) => waiting === item.id).map(([edge]) => edge);
                const detail = refs.length ? excerpt([String(item.blocked_reason ?? item.blocked_by ?? ""), ...refs].filter(Boolean).join("; "), 384) : excerpt("", 384);
                rows.push({
                    key: `own:${item.id}`, id: item.id, op: "own_claim", ts: String(item.updated_at), author: options.author,
                    kinds: ["own_claim"], title: title.text, type: String(item.type ?? "unknown"), status: String(item.status ?? "unknown"), priority: Number(item.priority ?? 4), fields: [], text: detail.text, excerpt_omitted_chars: title.omitted + detail.omitted, ...(refs.length ? { blocked: true } : {}),
                });
            }
        }
        rows.sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || compare(b.ts, a.ts) || compare(a.key, b.key));
        snapshot = fingerprint(streams);
    }
    const pack = {
        protocol: "pm-context-since/v1", cursor: `s1_${"0".repeat(64)}`, changes: [],
        omission_receipt: { deferred_rows: rows.length, deferred_own_claims: rows.filter((row) => row.op === "own_claim").length, excerpt_omitted_chars: 0, remedy: "Resume --cursor for deferred rows; pm comments <id> or pm history <id> --full for complete excerpts and patches." },
        budget: { ceiling: options.tokenBudget, token_upper_bound: 0, unit: "utf8-bytes" },
    };
    let included = 0;
    for (const row of rows) {
        pack.changes.push(row);
        pack.omission_receipt.deferred_rows--;
        if (row.op === "own_claim")
            pack.omission_receipt.deferred_own_claims--;
        pack.omission_receipt.excerpt_omitted_chars += row.excerpt_omitted_chars;
        if (Buffer.byteLength(encodeSincePack(pack)) > options.tokenBudget) {
            pack.changes.pop();
            break;
        }
        included++;
    }
    pack.omission_receipt.deferred_rows = rows.length - included;
    pack.omission_receipt.deferred_own_claims = rows.slice(included).filter((row) => row.op === "own_claim").length;
    pack.omission_receipt.excerpt_omitted_chars = pack.changes.reduce((sum, row) => sum + row.excerpt_omitted_chars, 0);
    if ((rows.length > 0 && included === 0) || Buffer.byteLength(encodeSincePack(pack)) > options.tokenBudget)
        throw new SinceError("BUDGET_TOO_SMALL", "Increase --token-budget to fit the receipt and at least one complete delta row; no cursor advanced.");
    pack.cursor = saveCheckpoint(directory, { generation: (previous?.generation ?? -1) + 1, author: options.author, streams: snapshot, pending: rows.slice(included) });
    encodeSincePack(pack);
    return pack;
}
//# sourceMappingURL=since.js.map