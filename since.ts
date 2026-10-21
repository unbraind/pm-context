/** Resumable delta serving; SDK history remains the only durable event authority. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PmCliError, applyHistoryPatch, readHistoryEntries, resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk";
import type { RelationshipKindRegistry } from "@unbrained/pm-cli/sdk";
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
  constructor(code: string, remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] });
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
  priority: number;
  fields: string[];
  text: string;
  excerpt_omitted_chars: number;
  /** A later graph transition reversed this historical blocker/unblock fact. */
  superseded?: boolean;
}
/** Frozen continuation state; seen hashes detect pruning and backdated appends. */
interface Checkpoint {
  author: string;
  seen: string[];
  pending: DeltaRow[];
}
/** History rows retain physical per-stream order, including equal timestamps. */
interface Event extends ActivityEntry {
  id: string;
  ordinal: number;
  key: string;
}
/** Exact JSON response; the bound includes the cursor and omission receipt. */
export interface SincePack {
  protocol: "pm-context-since/v1";
  cursor: string;
  changes: DeltaRow[];
  omission_receipt: {
    deferred_rows: number;
    deferred_own_claims: number;
    excerpt_omitted_chars: number;
    remedy: string;
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
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Read all validated SDK streams, with no activity default limit or Git dependency. */
async function readEvents(pmRoot: string): Promise<Event[]> {
  const streams: Event[][] = [];
  for (const file of readdirSync(join(pmRoot, "history")).filter((name) => name.endsWith(".jsonl")).sort()) {
    const id = file.slice(0, -6);
    const entries = await readHistoryEntries(join(pmRoot, "history", file), id);
    streams.push(entries.map((entry, ordinal) => ({ ...entry, id, ordinal, key: digest([id, ordinal, entry]) })));
  }
  // Merge stream frontiers, preserving causality even when a writer's clock regresses.
  const events: Event[] = [];
  for (;;) {
    const stream = streams.filter((entries) => entries.length).sort((a, b) => compare(a[0]!.ts, b[0]!.ts) || compare(a[0]!.id, b[0]!.id))[0];
    if (!stream) return events;
    events.push(stream.shift()!);
  }
}
/** Derive active blockers from tracker-owned statuses and explicit blocking edges. */
function blockers(documents: Map<string, Record<string, unknown>>, terminal: Set<string>, registry: RelationshipKindRegistry): Map<string, string> {
  const result = new Map<string, string>();
  for (const [id, item] of documents) {
    if (terminal.has(String(item.status))) continue;
    if (item.status === "blocked" || item.blocked_reason) result.set(`${id}:status`, id);
    const deps = Array.isArray(item.dependencies) ? item.dependencies : [];
    for (const value of deps) {
      const dep = record(value);
      const target = String(dep.id);
      const definition = registry.resolve(dep.kind);
      if (definition?.ordering) {
        const [waiting, prerequisite] = definition.precedence === "target_before_source" ? [id, target] : [target, id];
        if (!terminal.has(String(documents.get(prerequisite)?.status)) && !terminal.has(String(documents.get(waiting)?.status))) result.set(`${waiting}:${prerequisite}`, waiting);
      }
    }
  }
  return result;
}
/** New comment/note prose only; metadata-wide replacements do not repeat older text. */
function addedProse(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const text: string[] = [];
  for (const field of ["comments", "notes", "learnings"]) {
    const old = new Set((Array.isArray(before[field]) ? before[field] : []).map((value) => JSON.stringify(value)));
    for (const value of Array.isArray(after[field]) ? after[field] : []) {
      if (!old.has(JSON.stringify(value))) {
        const prose = record(value).text;
        if (typeof prose === "string") text.push(prose);
      }
    }
  }
  return text;
}
/**
 * Replay with the SDK patcher to distinguish actual transitions and indirect
 * unblocks, then retain an event row even for edits outside the named categories.
 */
function classify(events: Event[], selected: Set<string>, terminal: Set<string>): DeltaRow[] {
  const documents = new Map<string, Record<string, unknown>>();
  const bodies = new Map<string, string>();
  const rows: DeltaRow[] = [];
  let blocked = new Map<string, string>();
  const registry = resolveWorkspaceRelationshipKindRegistry();
  for (const event of events) {
    const before = documents.get(event.id) ?? {};
    const document = applyHistoryPatch({ metadata: before, body: bodies.get(event.id) ?? "" }, event.patch, event.ordinal + 1, event.op);
    const after = document.metadata;
    documents.set(event.id, after);
    bodies.set(event.id, document.body);
    const nextBlocked = blockers(documents, terminal, registry);
    if (selected.has(event.key)) {
      const kinds: string[] = [];
      if (event.op === "create") kinds.push("created");
      if (terminal.has(String(after.status)) && !terminal.has(String(before.status))) kinds.push("closed");
      if (terminal.has(String(before.status)) && !terminal.has(String(after.status))) kinds.push("reopened");
      if (event.op !== "create" && before.priority !== after.priority) kinds.push("reprioritized");
      const prose = addedProse(before, after);
      if (prose.length) kinds.push("comment");
      if (event.op === "release") kinds.push("release", "handoff");
      if (event.op === "claim") kinds.push("claim");
      const text = [...prose, event.message ?? ""].filter(Boolean).join("\n");
      if (/handoff|hand.over|release/i.test(text)) kinds.push("handoff");
      const clipped = excerpt(text, 384);
      const title = excerpt(String(after.title ?? before.title ?? event.id), 128);
      const row: DeltaRow = {
        key: event.key, id: event.id, op: event.op, ts: event.ts, author: event.author,
        kinds: [...new Set(kinds)], title: title.text, priority: Number(after.priority ?? 4),
        fields: [...new Set(event.patch.map((patch) => patch.path))], text: clipped.text,
        excerpt_omitted_chars: clipped.omitted + title.omitted,
      };
      // Include scalar transitions as prose; full patches remain available in history.
      const transitions = ["status", "priority", "assignee", "blocked_reason", "release"].filter((field) => before[field] !== after[field]);
      if (transitions.length) {
        const values = excerpt(transitions.map((field) => `${field}: ${String(before[field])} -> ${String(after[field])}`).join("; "), 256);
        row.text = [row.text, values.text].filter(Boolean).join("\n");
        row.excerpt_omitted_chars += values.omitted;
      }
      for (const [key, id] of nextBlocked) {
        if (!blocked.has(key)) {
          const title = excerpt(String(documents.get(id)?.title ?? id), 128);
          rows.push({ ...row, key: `${row.key}:blocked:${key}`, id, kinds: ["blocked"], title: title.text, text: key, priority: Number(documents.get(id)?.priority ?? 4), excerpt_omitted_chars: title.omitted });
        }
      }
      for (const [key, id] of blocked) {
        if (!nextBlocked.has(key)) {
          const title = excerpt(String(documents.get(id)?.title ?? id), 128);
          rows.push({ ...row, key: `${row.key}:unblocked:${key}`, id, kinds: ["unblocked"], title: title.text, text: key, priority: Number(documents.get(id)?.priority ?? 4), excerpt_omitted_chars: title.omitted });
        }
      }
      rows.push(row);
    }
    blocked = nextBlocked;
  }
  for (const row of rows) {
    if (row.kinds[0] === "blocked") row.superseded = !blocked.has(row.text);
    if (row.kinds[0] === "unblocked") row.superseded = blocked.has(row.text);
  }
  return rows;
}
/** Prioritize blockers, own work, handoffs and newly actionable work, then priority. */
function rank(row: DeltaRow): number {
  if (row.superseded) return 11;
  for (const [index, kind] of ["blocked", "own_claim", "handoff", "unblocked", "claim", "reopened", "reprioritized", "created", "comment", "closed"].entries()) {
    if (row.kinds.includes(kind)) return index;
  }
  return 10;
}
/** Decode only content-addressed state from this tracker; never follow cursor paths. */
function readCheckpoint(directory: string, token: string, author: string): Checkpoint {
  if (!/^s1_[a-f0-9]{64}$/.test(token)) throw new SinceError("INVALID_CURSOR", "Use the opaque cursor returned by context-pack since.");
  let raw: string;
  try { raw = readFileSync(join(directory, `${token}.json`), "utf8"); }
  catch { throw new SinceError("CURSOR_EXPIRED", "Reorient with pm context --for handoff, then restart using --from <ISO timestamp>; retained cursor state is unavailable."); }
  let state: Checkpoint;
  try { state = JSON.parse(raw) as Checkpoint; }
  catch { throw new SinceError("INVALID_CURSOR", "Restart with --from <ISO timestamp>; cursor state is damaged."); }
  if (`s1_${digest(state)}` !== token) throw new SinceError("INVALID_CURSOR", "Restart with --from <ISO timestamp>; cursor state is damaged.");
  if (state.author !== author) throw new SinceError("CURSOR_AUTHOR_MISMATCH", "Resume with the original --author or start a new --from session.");
  return state;
}
/** Atomically publish content-addressed state and evict oldest snapshots within fixed limits. */
function saveCheckpoint(directory: string, state: Checkpoint): string {
  const raw = JSON.stringify(state);
  if (Buffer.byteLength(raw) > SINCE_RETENTION.bytes) throw new SinceError("CURSOR_CAPACITY", "Use a smaller --from window or compact history after reorienting; checkpoint exceeds the runtime retention capacity.");
  const token = `s1_${digest(state)}`;
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `${token}.${randomUUID()}.tmp`);
  writeFileSync(temporary, raw, { mode: 0o600 });
  renameSync(temporary, join(directory, `${token}.json`));
  const files = readdirSync(directory).filter((file) => /^s1_[a-f0-9]{64}\.json$/.test(file)).map((file) => ({ file, ...statSync(join(directory, file)) }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || compare(a.file, b.file));
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  let count = files.length;
  for (const file of files) {
    if (count <= SINCE_RETENTION.count && bytes <= SINCE_RETENTION.bytes) break;
    if (file.file === `${token}.json`) continue;
    rmSync(join(directory, file.file), { force: true });
    bytes -= file.size;
    count--;
  }
  return token;
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
  const previous = options.cursor ? readCheckpoint(directory, options.cursor, options.author) : undefined;
  const events = await readEvents(pmRoot);
  const seen = events.map((event) => event.key).sort();
  const current = new Set(seen);
  if (previous?.seen.some((key) => !current.has(key))) throw new SinceError("HISTORY_EXPIRED", "Retained history changed or was pruned. Reorient with pm context --for handoff, then restart with --from <ISO timestamp>.");
  let rows: DeltaRow[];
  let snapshot: string[];
  if (previous && previous.pending.length) {
    rows = previous.pending;
    snapshot = previous.seen;
  } else {
    const from = options.from === undefined ? undefined : Date.parse(options.from);
    if (from !== undefined && !Number.isFinite(from)) throw new SinceError("INVALID_FROM", "--from must be an ISO timestamp.");
    if (from !== undefined && events.some((event) => event.op === "history_compact_baseline" && Date.parse(event.ts) >= from)) throw new SinceError("HISTORY_EXPIRED", "Requested time predates retained history. Reorient with pm context --for handoff and restart after the compacted baseline.");
    const prior = new Set(previous?.seen);
    const selected = new Set(events.filter((event) => from === undefined ? !prior.has(event.key) : Date.parse(event.ts) >= from).map((event) => event.key));
    rows = selected.size ? classify(events, selected, terminal) : [];
    for (const item of items) {
      if (item.assignee === options.author && !terminal.has(String(item.status))) {
        const title = excerpt(String(item.title ?? item.id), 128);
        rows.push({
          key: `own:${item.id}`, id: item.id, op: "own_claim", ts: String(item.updated_at), author: options.author,
          kinds: ["own_claim"], title: title.text, priority: Number(item.priority ?? 4), fields: [], text: String(item.status), excerpt_omitted_chars: title.omitted,
        });
      }
    }
    rows.sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || compare(b.ts, a.ts) || compare(a.key, b.key));
    snapshot = seen;
  }
  const pack: SincePack = {
    protocol: "pm-context-since/v1", cursor: `s1_${"0".repeat(64)}`, changes: [],
    omission_receipt: { deferred_rows: rows.length, deferred_own_claims: rows.filter((row) => row.op === "own_claim").length, excerpt_omitted_chars: 0, remedy: "Resume --cursor for deferred rows; pm comments <id> or pm history <id> --full for complete excerpts and patches." },
    budget: { ceiling: options.tokenBudget, token_upper_bound: 0, unit: "utf8-bytes" },
  };
  let included = 0;
  for (const row of rows) {
    pack.changes.push(row);
    if (Buffer.byteLength(encodeSincePack(pack)) > options.tokenBudget) { pack.changes.pop(); break; }
    included++;
  }
  pack.omission_receipt.deferred_rows = rows.length - included;
  pack.omission_receipt.deferred_own_claims = rows.slice(included).filter((row) => row.op === "own_claim").length;
  pack.omission_receipt.excerpt_omitted_chars = pack.changes.reduce((sum, row) => sum + row.excerpt_omitted_chars, 0);
  if ((rows.length > 0 && included === 0) || Buffer.byteLength(encodeSincePack(pack)) > options.tokenBudget) throw new SinceError("BUDGET_TOO_SMALL", "Increase --token-budget to fit the receipt and at least one complete delta row; no cursor advanced.");
  pack.cursor = saveCheckpoint(directory, { author: options.author, seen: snapshot, pending: rows.slice(included) });
  encodeSincePack(pack);
  return pack;
}
