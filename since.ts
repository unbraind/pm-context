import { buildSuggestedCommand } from "./suggested-command.ts";
import type { SuggestedCommand } from "./suggested-command.ts";
/** Resumable delta serving; SDK history remains the only durable event authority. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { PmCliError, acquireLock, applyHistoryPatch, listMutationEvents, readHistoryEntries, resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk";
import type { RelationshipKindRegistry } from "@unbrained/pm-cli/sdk";
import { runActivity } from "@unbrained/pm-cli/sdk/query";
import type { ActivityEntry } from "@unbrained/pm-cli/sdk/query";
import type { PmItem } from "./index.ts";

/** Runtime snapshots are disposable, bounded, and never stored in item history. */
export const SINCE_RETENTION = { count: 200, bytes: 4_194_304, directory: "runtime/context-since" } as const;
/** Explicit recovery contracts for expired history, bad input, and impossible budgets. */
export class SinceError extends PmCliError {
  /** Machine-readable failure category. */
  declare readonly code: string;
  /** Action that restores a usable starting point. */
  remedy: string;
  /** Host usage-error status, also understood by direct SDK callers. */
  declare readonly exitCode: 2;
  constructor(code: string, remedy: string, retryArgv?: string[]) {
    const retry = retryArgv === undefined ? undefined : buildSuggestedCommand(retryArgv);
    super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy], ...(retry ? { recovery: { suggested_retry: retry.command, suggested_retry_args: retry.argv } } : {}) });
    this.remedy = remedy;
  }
}
/** One immutable event or one current own-claim reminder, ranked as a whole. */
export interface DeltaRow {
  key: string;
  id: string;
  op: string;
  ts: string;
  author: string;
  kinds: string[];
  title: string;
  type: string;
  status: string;
  priority: number;
  fields: string[];
  text: string;
  excerpt_omitted_chars: number;
  /** A later graph transition reversed this historical blocker/unblock fact. */
  superseded?: boolean;
  /** Current own-claim snapshot is blocked, rather than a newly added blocker event. */
  blocked?: boolean;
}
/** One ordered prefix digest per stream keeps cursor size independent of event count. */
export interface StreamFingerprint {
  id: string;
  count: number;
  hash: string;
}
/** Frozen continuation state; prefix hashes detect pruning and backdated appends. */
export interface Checkpoint {
  version?: 2;
  served_at?: string;
  restart_from?: string;
  receipt?: Pick<SincePack["omission_receipt"], "invalid_timestamp_rows" | "invalid_timestamp_examples" | "expired_streams">;
  generation: number;
  author: string;
  streams: StreamFingerprint[];
  pending: DeltaRow[];
}
/** History rows retain physical per-stream order, including equal timestamps. */
interface Event extends ActivityEntry {
  id: string;
  ordinal: number;
  key: string;
  /** Parsed once; invalid rows never depend on the host timezone. */
  time: number;
}
/** Exact JSON response; the bound includes the cursor and omission receipt. */
export interface SincePack {
  protocol: "pm-context-since/v1";
  cursor: string;
  served_at: string;
  restart_from: string;
  changes: DeltaRow[];
  omission_receipt: {
    invalid_timestamp_rows: number;
    invalid_timestamp_examples: Array<{ id: string; ordinal: number; ts: string }>;
    expired_streams: string[];
    deferred_rows: number;
    deferred_own_claims: number;
    excerpt_omitted_chars: number;
    remedy: string;
    /** Executable alternatives for complete comments/history. */
    commands: SuggestedCommand[];
  };
  budget: { ceiling: number; token_upper_bound: number; unit: "utf8-bytes" };
}
/** Invocation parameters deliberately exclude Git and mutable wall-clock defaults. */
export interface SinceOptions {
  cursor?: string;
  from?: string;
  author: string;
  tokenBudget: number;
}
/** Parse explicit-zone ISO timestamps without normalizing invalid calendar dates. */
function parseFromTimestamp(value: string): number {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return NaN;
  // setUTCFullYear preserves years 0000–0099, unlike Date.UTC's 1900 offset.
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(Number(match[1]), Number(match[2]), 0);
  if (Number(match[3]) > monthEnd.getUTCDate()) return NaN;
  return Date.parse(value);
}
/** Hash JSON content rather than timestamps, so equal-time and late events survive. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Keep object traversal typed when histories contain arbitrary custom metadata. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
/** Extract bounded prose while disclosing every character removed from excerpts. */
function excerpt(value: string, max: number): { text: string; omitted: number } {
  const points = [...value];
  return { text: points.slice(0, max).join(""), omitted: Math.max(0, points.length - max) };
}
/** Use code-unit ordering, independent of process locale. */
function compare(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}
/**
 * Discover streams through SDK event pages, then retain their physical entries.
 * Raw SDK history reads preserve prefix fingerprints and timestamp spellings;
 * indexed event entries normalize timestamps and cannot replace that proof.
 */
async function readStreams(pmRoot: string): Promise<Event[][]> {
  const streams: Event[][] = [];
  await runActivity({ raw: true, compact: true, limit: "1" }, { path: pmRoot });
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listMutationEvents({ pmRoot, since: cursor, limit: 1000 });
    for (const event of page.events) ids.add(event.item_id);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  for (const id of [...ids].sort()) {
    const entries = await readHistoryEntries(join(pmRoot, "history", `${id}.jsonl`), id);
    streams.push(entries.map((entry, ordinal) => ({ ...entry, id, ordinal, key: digest([id, ordinal, entry]), time: parseFromTimestamp(entry.ts) })));
  }
  return streams;
}
/** Merge indexed frontiers without sorting or moving the remaining stream entries. */
function mergeEvents(streams: Event[][]): Event[] {
  const indices = streams.map(() => 0);
  const events: Event[] = [];
  for (;;) {
    let next: Event | undefined;
    let selected = -1;
    for (const [index, stream] of streams.entries()) {
      const candidate = stream[indices[index]!];
      if (candidate && (!next || ((Number.isNaN(candidate.time) ? -Infinity : candidate.time) - (Number.isNaN(next.time) ? -Infinity : next.time) || compare(candidate.id, next.id)) < 0)) {
        next = candidate;
        selected = index;
      }
    }
    if (!next) return events;
    events.push(next);
    indices[selected]!++;
  }
}
/** Hash physical event order, including ordinals, to reject prefix rewrites. */
function fingerprint(streams: Event[][]): StreamFingerprint[] {
  return streams.filter((stream) => stream.length > 0).map((stream) => ({
    id: stream[0]!.id, count: stream.length, hash: digest(stream.map((event) => event.key)),
  }));
}
/** Check retained prefixes without merging; later ordinals remain eligible even if backdated. */
function validatePrefixes(streams: Event[][], previous: StreamFingerprint[]): string[] {
  const compacted: string[] = [];
  const current = new Map(streams.filter((stream) => stream.length > 0).map((stream) => [stream[0]!.id, stream]));
  for (const prefix of previous) {
    const stream = current.get(prefix.id);
    if (!stream || stream.length < prefix.count || digest(stream.slice(0, prefix.count).map((event) => event.key)) !== prefix.hash) {
      if (stream?.[0]?.op === "history_compact_baseline") { compacted.push(prefix.id); continue; }
      throw new SinceError("HISTORY_EXPIRED", "Retained history changed or was pruned. Reorient using the structured retry, then restart with an explicit ISO timestamp.", ["pm", "context", "--for", "handoff"]);
    }
  }
  return compacted;
}
/** Derive only one document's blocking contributions using current endpoint states. */
function blockerEdges(id: string, item: Record<string, unknown>, documents: Map<string, Record<string, unknown>>, terminal: Set<string>, registry: RelationshipKindRegistry): Map<string, string> {
  const result = new Map<string, string>();
  if (terminal.has(String(item.status))) return result;
  const legacy = item.blocked_by;
  const legacyActive = typeof legacy === "string" && legacy.trim() && !terminal.has(String(documents.get(legacy.trim())?.status));
  if (item.status === "blocked" || item.blocked_reason || legacyActive) result.set(`${id}:status`, id);
  for (const value of Array.isArray(item.dependencies) ? item.dependencies : []) {
    const dep = record(value);
    const target = String(dep.id);
    const definition = registry.resolve(dep.kind);
    if (definition?.ordering) {
      const [waiting, prerequisite] = definition.precedence === "target_before_source" ? [id, target] : [target, id];
      if (!terminal.has(String(documents.get(prerequisite)?.status)) && !terminal.has(String(documents.get(waiting)?.status))) result.set(`${waiting}:${prerequisite}`, waiting);
    }
  }
  return result;
}
/** Reverse adjacency bounds graph updates to changed documents and their referrers. */
class BlockerGraph {
  readonly active = new Map<string, string>();
  readonly waiting = new Map<string, Set<string>>();
  readonly reverse = new Map<string, Set<string>>();
  readonly owners = new Map<string, Set<string>>();
  readonly contributions = new Map<string, Map<string, string>>();
  readonly references = new Map<string, Set<string>>();
  readonly documents: Map<string, Record<string, unknown>>;
  readonly terminal: Set<string>;
  readonly registry: RelationshipKindRegistry;
  /** Index initial metadata once; streamed documents are populated by causal replay. */
  constructor(documents: Map<string, Record<string, unknown>>, terminal: Set<string>, registry: RelationshipKindRegistry) {
    this.documents = documents; this.terminal = terminal; this.registry = registry;
    for (const id of documents.keys()) this.update(id, true);
  }
  /** Refresh affected owners and return net changes, deduplicating shared edges. */
  update(id: string, initial = false): { added: Map<string, string>; removed: Map<string, string> } {
    const affected = new Set(initial ? [id] : [id, ...(this.reverse.get(id) ?? [])]);
    const before = new Map<string, string | undefined>();
    for (const owner of affected) {
      const item = this.documents.get(owner)!;
      const old = this.contributions.get(owner) ?? new Map<string, string>();
      const next = blockerEdges(owner, item, this.documents, this.terminal, this.registry);
      for (const key of new Set([...old.keys(), ...next.keys()])) if (!before.has(key)) before.set(key, this.active.get(key));
      for (const ref of this.references.get(owner) ?? []) this.reverse.get(ref)!.delete(owner);
      const refs = new Set((Array.isArray(item.dependencies) ? item.dependencies : []).map((value) => String(record(value).id)));
      if (typeof item.blocked_by === "string" && item.blocked_by.trim()) refs.add(item.blocked_by.trim());
      this.references.set(owner, refs);
      for (const ref of refs) {
        if (!this.reverse.has(ref)) this.reverse.set(ref, new Set());
        this.reverse.get(ref)!.add(owner);
      }
      for (const [key, waiting] of old) {
        const owners = this.owners.get(key)!;
        owners.delete(owner);
        if (!owners.size) {
          this.owners.delete(key); this.active.delete(key);
          this.waiting.get(waiting)!.delete(key);
          if (!this.waiting.get(waiting)!.size) this.waiting.delete(waiting);
        }
      }
      for (const [key, waiting] of next) {
        if (!this.owners.has(key)) this.owners.set(key, new Set());
        this.owners.get(key)!.add(owner); this.active.set(key, waiting);
        if (!this.waiting.has(waiting)) this.waiting.set(waiting, new Set());
        this.waiting.get(waiting)!.add(key);
      }
      this.contributions.set(owner, next);
    }
    const added = new Map<string, string>(); const removed = new Map<string, string>();
    for (const [key, waiting] of before) {
      if (waiting === undefined) added.set(key, this.active.get(key)!);
      if (waiting !== undefined && !this.active.has(key)) removed.set(key, waiting);
    }
    return { added, removed };
  }
}
/** New comment/note prose only; metadata-wide replacements do not repeat older text. */
function addedProse(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const text: string[] = [];
  for (const field of ["comments", "notes", "learnings"]) {
    const remaining = new Map<string | undefined, number>();
    for (const value of Array.isArray(before[field]) ? before[field] : []) {
      const key = JSON.stringify(value);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const value of Array.isArray(after[field]) ? after[field] : []) {
      const key = JSON.stringify(value);
      const count = remaining.get(key) ?? 0;
      if (count > 0) { remaining.set(key, count - 1); continue; }
      const prose = record(value).text;
      if (typeof prose === "string") text.push(prose);
    }
  }
  return text;
}
/**
 * Replay with the SDK patcher to distinguish actual transitions and indirect
 * unblocks, then retain an event row even for edits outside the named categories.
 */
function classify(events: Event[], selected: Set<string>, terminal: Set<string>, items: PmItem[]): { rows: DeltaRow[]; snapshots: PmItem[]; blockers: Map<string, string> } {
  const streamed = new Set(events.map((event) => event.id));
  const documents = new Map<string, Record<string, unknown>>(items.filter((item) => !streamed.has(item.id)).map((item) => [item.id, { ...item }]));
  const bodies = new Map<string, string>();
  const rows: DeltaRow[] = [];
  const registry = resolveWorkspaceRelationshipKindRegistry();
  const graph = new BlockerGraph(documents, terminal, registry);
  for (const event of events) {
    const before = documents.get(event.id) ?? {};
    const document = applyHistoryPatch({ metadata: before, body: bodies.get(event.id) ?? "" }, event.patch, event.ordinal + 1, event.op);
    const after = document.metadata;
    documents.set(event.id, after);
    bodies.set(event.id, document.body);
    // Ancestor replacements can change every graph field, including imported baselines.
    const touchesGraph = event.op === "create" || event.op === "delete"
      || event.patch.some((patch) => /^(?:|\/metadata(?:\/(?:status|dependencies|blocked_by|blocked_reason)(?:\/.*)?)?)$/.test(patch.path));
    const delta = touchesGraph ? graph.update(event.id) : { added: new Map<string, string>(), removed: new Map<string, string>() };
    if (selected.has(event.key)) {
      const kinds: string[] = [];
      if (event.op === "create") kinds.push("created");
      if (terminal.has(String(after.status)) && !terminal.has(String(before.status))) kinds.push("closed");
      if (terminal.has(String(before.status)) && typeof after.status === "string" && !terminal.has(after.status)) kinds.push("reopened");
      if (event.op !== "create" && after.priority !== undefined && before.priority !== after.priority) kinds.push("reprioritized");
      const prose = addedProse(before, after);
      if (prose.length) kinds.push("comment");
      if (event.op === "release") kinds.push("release", "handoff");
      if (event.op === "claim") kinds.push("claim");
      const text = [...prose, event.message ?? ""].filter(Boolean).join("\n");
      if (/(?:^|\n)\s*(?:handoff|hand[ -]over)\s*:/i.test(text)) kinds.push("handoff");
      const clipped = excerpt(text, 384);
      const title = excerpt(String(after.title ?? before.title ?? event.id), 128);
      const row: DeltaRow = {
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
      for (const [key, id] of delta.added) {
        {
          const title = excerpt(String(documents.get(id)?.title ?? id), 128);
          rows.push({ ...row, key: `${row.key}:blocked:${key}`, id, op: "blocked", kinds: ["blocked"], title: title.text, type: String(documents.get(id)?.type ?? "unknown"), status: String(documents.get(id)?.status ?? "unknown"), text: key, priority: Number(documents.get(id)?.priority ?? 4), excerpt_omitted_chars: title.omitted });
        }
      }
      const unblocked = new Set<string>();
      for (const [, id] of delta.removed) {
        if (unblocked.has(id) || graph.waiting.has(id)) continue;
        const status = documents.get(id)?.status;
        if (typeof status !== "string" || terminal.has(status)) continue;
        unblocked.add(id);
        const title = excerpt(String(documents.get(id)?.title ?? id), 128);
        const removed = excerpt([...delta.removed].filter(([, waiting]) => waiting === id).map(([edge]) => edge).join(", "), 384);
        rows.push({ ...row, key: `${row.key}:unblocked:${id}`, id, op: "unblocked", kinds: ["unblocked"], title: title.text, type: String(documents.get(id)?.type ?? "unknown"), status, text: removed.text, priority: Number(documents.get(id)?.priority ?? 4), excerpt_omitted_chars: title.omitted + removed.omitted });
      }
      rows.push(row);
    }
  }
  const blocked = graph.active;
  const waitingAtEnd = new Set(graph.waiting.keys());
  for (const row of rows) {
    if (row.kinds[0] === "blocked") row.superseded = !blocked.has(row.text);
    if (row.kinds[0] === "unblocked") {
      const status = documents.get(row.id)?.status;
      row.superseded = waitingAtEnd.has(row.id) || typeof status !== "string" || terminal.has(status);
    }
  }
  return { rows, snapshots: [...documents].map(([id, metadata]) => ({ ...metadata, id })), blockers: blocked };
}
/** Prioritize blockers, own work, handoffs and newly actionable work, then priority. */
function rank(row: DeltaRow): number {
  if (row.superseded) return 11;
  if (row.blocked) return 0;
  for (const [index, kind] of ["blocked", "own_claim", "handoff", "unblocked", "claim", "reopened", "reprioritized", "created", "comment", "closed"].entries()) {
    if (row.kinds.includes(kind)) return index;
  }
  return 10;
}
/** Stored checkpoints share one compressed immutable stream inventory per corpus. */
type DiskCheckpoint = Omit<Checkpoint, "streams"> & { streams: StreamFingerprint[] | string };
/** Delivery time is advisory; replay identity seals the restart boundary and history inventory. */
function checkpointDigest(state: DiskCheckpoint): string {
  const { served_at: _servedAt, ...identity } = state;
  return digest(state.version === 2 ? identity : state);
}
/** Read under the same SDK lock as publication so inventory collection cannot race a reader. */
async function readCheckpoint(directory: string, token: string, author: string): Promise<Checkpoint> {
  if (!/^s1_[a-f0-9]{64}$/.test(token)) throw new SinceError("INVALID_CURSOR", "Use the opaque cursor returned by context-pack since.");
  const unlock = await acquireLock(directory, "context-since", 30, author, false, false, 10000);
  try {
    let raw: string;
    try { raw = readFileSync(join(directory, `${token}.json`), "utf8"); }
    catch { throw new SinceError("CURSOR_EXPIRED", "Restart using the previous response's inclusive --from restart_from value; retained cursor state is unavailable."); }
    let state: DiskCheckpoint;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") throw new Error("Invalid checkpoint object");
      state = parsed as DiskCheckpoint;
    }
    catch { throw new SinceError("INVALID_CURSOR", "Restart with --from <ISO timestamp>; cursor state is damaged."); }
    if (`s1_${checkpointDigest(state)}` !== token) throw new SinceError("INVALID_CURSOR", "Restart with --from <ISO timestamp>; cursor state is damaged.");
    if (state.author !== author) throw new SinceError("CURSOR_AUTHOR_MISMATCH", "Resume with the original --author or start a new --from session.");
    if (typeof state.streams === "string") {
      const ref = state.streams;
      try {
        if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error("Invalid inventory reference");
        const inventory = gunzipSync(readFileSync(join(directory, `i1_${ref}.gz`)), { maxOutputLength: 67_108_864 }).toString("utf8");
        if (createHash("sha256").update(inventory).digest("hex") !== ref) throw new Error("Inventory digest mismatch");
        state.streams = JSON.parse(inventory) as StreamFingerprint[];
      } catch { throw new SinceError("CURSOR_EXPIRED", "Restart using --from restart_from from the previous response; the shared history inventory is unavailable or damaged."); }
    }
    if (!Array.isArray(state.streams)) throw new SinceError("CURSOR_EXPIRED", "Restart with --from <ISO timestamp>; this cursor uses an obsolete checkpoint format.");
    return { ...state, streams: state.streams };
  } finally { await unlock(); }
}
/** Publish runtime bytes by rename while the SDK cursor lock protects readers and collectors. */
function publishRuntimeFile(directory: string, file: string, bytes: string | Uint8Array): void {
  const temporary = join(directory, `${file}.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, join(directory, file));
}
/** Atomically publish a shared inventory and bounded checkpoints using the SDK writer lock. */
export async function saveCheckpoint(directory: string, state: Checkpoint): Promise<{ cursor: string; served_at: string }> {
  const unlock = await acquireLock(directory, "context-since", 30, state.author, false, false, 10000);
  try {
    const servedTime = state.served_at === undefined ? Date.now() : parseFromTimestamp(state.served_at);
    if (!Number.isFinite(servedTime)) throw new SinceError("INVALID_CURSOR", "Checkpoint serving time must be an explicit-zone ISO timestamp.");
    const inventory = JSON.stringify(state.streams);
    const ref = createHash("sha256").update(inventory).digest("hex");
    const compressed = gzipSync(inventory);
    const stored: DiskCheckpoint = { ...state, version: 2, served_at: new Date(servedTime).toISOString(), streams: ref };
    const raw = JSON.stringify(stored);
    if (Buffer.byteLength(raw) + compressed.length > SINCE_RETENTION.bytes) throw new SinceError("CURSOR_CAPACITY", "Restart with a later --from timestamp to reduce pending rows; the compressed stream inventory plus pending rows exceeds runtime retention capacity.");
    const token = `s1_${checkpointDigest(stored)}`;
    const target = join(directory, `${token}.json`);
    const inventoryPath = join(directory, `i1_${ref}.gz`);
    let retained: Buffer | undefined;
    try { retained = readFileSync(inventoryPath); } catch { /* Missing disposable inventory is republished. */ }
    if (!retained?.equals(compressed)) publishRuntimeFile(directory, `i1_${ref}.gz`, compressed);
    if (statSync(target, { throwIfNoEntry: false })) {
      try {
        const existing = JSON.parse(readFileSync(target, "utf8")) as DiskCheckpoint;
        if (checkpointDigest(existing) === token.slice(3) && typeof existing.served_at === "string" && existing.served_at.length === 24 && Number.isFinite(parseFromTimestamp(existing.served_at))) return { cursor: token, served_at: existing.served_at };
      } catch { /* A fresh from-window can replace damaged disposable metadata. */ }
    }
    publishRuntimeFile(directory, `${token}.json`, raw);
    const refs = new Map<string, number>();
    const files = readdirSync(directory).filter((file) => /^s1_[a-f0-9]{64}\.json$/.test(file)).flatMap((file) => {
      const stats = statSync(join(directory, file), { throwIfNoEntry: false });
      if (!stats) return [];
      let reference: string | undefined;
      try { const checkpoint = JSON.parse(readFileSync(join(directory, file), "utf8")) as DiskCheckpoint; if (typeof checkpoint.streams === "string" && /^[a-f0-9]{64}$/.test(checkpoint.streams)) reference = checkpoint.streams; } catch { /* Collect malformed disposable snapshots normally. */ }
      if (reference) refs.set(reference, (refs.get(reference) ?? 0) + 1);
      return [{ file, size: stats.size, mtimeMs: stats.mtimeMs, reference }];
    }).sort((a, b) => a.mtimeMs - b.mtimeMs || compare(a.file, b.file));
    const inventories = new Map<string, number>();
    for (const file of readdirSync(directory).filter((file) => /^i1_[a-f0-9]{64}\.gz$/.test(file))) {
      const reference = file.slice(3, -3);
      if (!refs.has(reference)) rmSync(join(directory, file), { force: true });
      else inventories.set(reference, statSync(join(directory, file)).size);
    }
    let bytes = files.reduce((sum, file) => sum + file.size, 0) + [...inventories.values()].reduce((sum, size) => sum + size, 0);
    let count = files.length;
    for (const file of files) {
      if (count <= SINCE_RETENTION.count && bytes <= SINCE_RETENTION.bytes) break;
      if (file.file === `${token}.json`) continue;
      rmSync(join(directory, file.file), { force: true }); bytes -= file.size; count--;
      if (file.reference) {
        const remaining = refs.get(file.reference)! - 1; refs.set(file.reference, remaining);
        if (!remaining) { rmSync(join(directory, `i1_${file.reference}.gz`), { force: true }); bytes -= inventories.get(file.reference) ?? 0; }
      }
    }
    return { cursor: token, served_at: stored.served_at! };
  } finally { await unlock(); }
}
/** Serialize with a conservative byte-token upper bound, including its own digits. */
export function encodeSincePack(pack: SincePack): string {
  let output = `${JSON.stringify(pack)}\n`;
  while (pack.budget.token_upper_bound !== Buffer.byteLength(output)) {
    pack.budget.token_upper_bound = Buffer.byteLength(output);
    output = `${JSON.stringify(pack)}\n`;
  }
  return output;
}
/** Select a prefix in linear serialization work, including exact counter and byte-count digits. */
export function packSinceRows(pack: SincePack, rows: DeltaRow[]): number {
  pack.changes = [];
  const receipt = pack.omission_receipt;
  receipt.deferred_rows = rows.length;
  receipt.deferred_own_claims = rows.filter((row) => row.op === "own_claim").length;
  receipt.excerpt_omitted_chars = 0;
  /** Count the JSON digits affected by each candidate without serializing the pack. */
  const digits = (value: number) => String(value).length;
  const fixed = Buffer.byteLength(JSON.stringify(pack)) + 1 - digits(receipt.deferred_rows) - digits(receipt.deferred_own_claims) - digits(receipt.excerpt_omitted_chars) - digits(pack.budget.token_upper_bound);
  let rowBytes = 0;
  for (const row of rows) {
    const candidate = rowBytes + Buffer.byteLength(JSON.stringify(row)) + (pack.changes.length ? 1 : 0);
    const deferred = receipt.deferred_rows - 1;
    const own = receipt.deferred_own_claims - Number(row.op === "own_claim");
    const omitted = receipt.excerpt_omitted_chars + row.excerpt_omitted_chars;
    const size = fixed + candidate + digits(deferred) + digits(own) + digits(omitted);
    let total = size + 1;
    while (total !== size + digits(total)) total = size + digits(total);
    if (total > pack.budget.ceiling) break;
    rowBytes = candidate; pack.changes.push(row);
    receipt.deferred_rows = deferred; receipt.deferred_own_claims = own; receipt.excerpt_omitted_chars = omitted;
  }
  const size = fixed + rowBytes + digits(receipt.deferred_rows) + digits(receipt.deferred_own_claims) + digits(receipt.excerpt_omitted_chars);
  let total = size + 1;
  while (total !== size + digits(total)) total = size + digits(total);
  pack.budget.token_upper_bound = total;
  encodeSincePack(pack);
  return pack.changes.length;
}
/**
 * Serve one deterministic ranked page. Pending pages freeze their source window;
 * writes arriving while they drain are collected after the last pending page.
 * Byte-level budgeting upper-bounds byte-fallback tokenizer costs without an
 * unpinned model tokenizer dependency. Nothing is silently consumed on overflow.
 */
export async function buildSincePack(pmRoot: string, items: PmItem[], terminal: Set<string>, options: SinceOptions): Promise<SincePack> {
  if ((!options.cursor === !options.from) || !options.author.trim()) throw new SinceError("INVALID_ARGUMENT", "Supply exactly one of --cursor or --from and a nonempty --author.");
  if (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget < 512) throw new SinceError("INVALID_BUDGET", "--token-budget must be an integer of at least 512.");
  const directory = join(pmRoot, SINCE_RETENTION.directory);
  const previous = options.cursor ? await readCheckpoint(directory, options.cursor, options.author) : undefined;
  const servedAt = new Date().toISOString();
  const streams = await readStreams(pmRoot);
  const expired = previous ? validatePrefixes(streams, previous.streams) : [];
  const invalid = streams.flat().filter((event) => !Number.isFinite(event.time));
  let receipt = { invalid_timestamp_rows: invalid.length, invalid_timestamp_examples: invalid.slice(0, 8).map(({ id, ordinal, ts }) => ({ id, ordinal, ts: excerpt(ts, 128).text })), expired_streams: expired };
  let restartFrom = previous?.restart_from ?? options.from ?? "0000-01-01T00:00:00Z";
  const restartTime = parseFromTimestamp(restartFrom);
  let earliest = restartTime;
  for (const event of streams.flat()) if (event.time < earliest) { earliest = event.time; restartFrom = event.ts; }
  let rows: DeltaRow[];
  let snapshot: StreamFingerprint[];
  if (previous && previous.pending.length) {
    rows = previous.pending;
    snapshot = previous.streams;
    receipt = previous.receipt ?? receipt;
  } else {
    const events = mergeEvents(streams);
    const from = options.from === undefined ? undefined : parseFromTimestamp(options.from);
    if (from !== undefined && !Number.isFinite(from)) throw new SinceError("INVALID_FROM", "--from must be a valid ISO timestamp with seconds and an explicit Z or ±HH:MM offset.");
    for (const event of events) if (event.op === "history_compact_baseline" && (Number.isNaN(event.time) || (from !== undefined && event.time >= from)) && !receipt.expired_streams.includes(event.id)) receipt.expired_streams.push(event.id);
    const prior = new Map(previous?.streams.map((stream) => [stream.id, stream.count]));
    const selected = new Set(events.filter((event) => Number.isFinite(event.time) && event.op !== "history_compact_baseline" && (from === undefined ? event.ordinal >= (expired.includes(event.id) ? 1 : prior.get(event.id) ?? 0) : event.time >= from)).map((event) => event.key));
    const classified = classify(events, selected, terminal, items);
    rows = classified.rows;
    const refsByWaiting = new Map<string, string[]>();
    for (const [edge, waiting] of classified.blockers) {
      const refs = refsByWaiting.get(waiting) ?? []; refs.push(edge); refsByWaiting.set(waiting, refs);
    }
    const snapshots = new Map(items.map((item) => [item.id, item]));
    for (const item of classified.snapshots) snapshots.set(item.id, item);
    for (const item of snapshots.values()) {
      if (item.assignee === options.author && !terminal.has(String(item.status))) {
        const title = excerpt(String(item.title ?? item.id), 128);
        const refs = refsByWaiting.get(item.id) ?? [];
        const detail = refs.length ? excerpt([String(item.blocked_reason ?? item.blocked_by ?? ""), ...refs].filter(Boolean).join("; "), 384) : excerpt("", 384);
        rows.push({
          key: `own:${item.id}`, id: item.id, op: "own_claim", ts: String(item.updated_at), author: options.author,
          kinds: ["own_claim"], title: title.text, type: String(item.type ?? "unknown"), status: String(item.status ?? "unknown"), priority: Number(item.priority ?? 4), fields: [], text: detail.text, excerpt_omitted_chars: title.omitted + detail.omitted, ...(refs.length ? { blocked: true } : {}),
        });
      }
    }
    const times = new Map(events.map((event) => [event.ts, event.time]));
    for (const row of rows) if (!times.has(row.ts)) times.set(row.ts, parseFromTimestamp(row.ts));
    rows.sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || (times.get(b.ts)! - times.get(a.ts)! || 0) || compare(a.key, b.key));
    snapshot = fingerprint(streams);
  }
  const pack: SincePack = {
    protocol: "pm-context-since/v1", cursor: `s1_${"0".repeat(64)}`, served_at: servedAt, restart_from: restartFrom, changes: [],
    omission_receipt: { ...receipt, deferred_rows: rows.length, deferred_own_claims: rows.filter((row) => row.op === "own_claim").length, excerpt_omitted_chars: 0, remedy: "Resume with the cursor for deferred rows; use the structured commands for complete excerpts and patches.", commands: [buildSuggestedCommand(["pm", "comments", "--help"]), buildSuggestedCommand(["pm", "history", "--help"])] },
    budget: { ceiling: options.tokenBudget, token_upper_bound: 0, unit: "utf8-bytes" },
  };
  const included = packSinceRows(pack, rows);
  if ((rows.length > 0 && included === 0) || pack.budget.token_upper_bound > options.tokenBudget) throw new SinceError("BUDGET_TOO_SMALL", "Increase --token-budget to fit the receipt and at least one complete delta row; no cursor advanced.");
  const publication = await saveCheckpoint(directory, { generation: (previous?.generation ?? -1) + 1, author: options.author, streams: snapshot, pending: rows.slice(included), served_at: servedAt, restart_from: restartFrom, receipt });
  pack.cursor = publication.cursor; pack.served_at = publication.served_at;
  encodeSincePack(pack);
  return pack;
}
