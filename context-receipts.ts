/**
 * Receipt protocol for the final output of pm-context's serving commands.
 * The package owns only runtime/context-receipts, never the SDK usage ledger.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, posix } from "node:path";

/** Physical retention ceilings: at most 200 receipts of 256 KiB each. */
export const RECEIPT_LIMITS = { count: 200, bytes: 262_144 } as const;
/** Isolated, ignored tracker runtime directory used by this protocol. */
export const RECEIPTS_RELATIVE_PATH = join("runtime", "context-receipts");
/** Explicit evidence categories; a touch or edit is a usage proxy, not a citation. */
export type UsageSignal = "citation" | "touch" | "edit";
/** One content-addressed unit that was present in the rendered bundle. */
export interface ContextFact {
  id: string;
  section_id: string;
  item_ids: string[];
  files: string[];
  estimated_tokens: number;
}
/** Stable section identifier and its rendered name. */
export interface ContextSection {
  id: string;
  name: string;
}
/** Public receipt returned alongside the context; no context text is persisted. */
export interface ContextReceipt {
  protocol: "pm-context-usage/v1";
  receipt_id: string;
  session: string;
  author: string;
  served_at: string;
  command: string;
  sections: ContextSection[];
  facts: ContextFact[];
  protocol_tokens: number;
}
/** Stored evidence is idempotent per fact and signal within one receipt. */
interface StoredReceipt extends ContextReceipt {
  used: Record<string, UsageSignal[]>;
}
/** Item/file associations from the selected pack, intersected with rendered text. */
export interface ReceiptAssociations {
  item_ids: string[];
  files: Array<{ itemId: string; value: string }>;
}
/** Serving identity; an omitted session defaults to this bundle's receipt id. */
export interface ReceiptIdentity {
  session?: string;
  author: string;
  command: string;
}
/** Usage evidence submitted by an agent or its post-mutation/edit hook. */
export interface ReceiptUsage {
  receipt_id: string;
  session?: string;
  citations: string[];
  touched_items: string[];
  edited_files: string[];
}
/** Precision-style metrics over retained receipt/fact impressions. */
export interface ReceiptMetrics {
  served_facts: number;
  used_facts: number;
  cited_facts: number;
  touch_facts: number;
  edit_facts: number;
  precision: number | null;
  estimated_served_tokens: number;
  unused_context_tokens: number;
  protocol_tokens: number;
}
/** Filtered runtime report; limits affect detail rows, never the aggregate. */
export interface ReceiptReport {
  protocol: "pm-context-usage/v1";
  retained_receipts: number;
  malformed_receipts: number;
  totals: ReceiptMetrics;
  sessions: Array<ReceiptMetrics & { session: string }>;
  items: Array<ReceiptMetrics & { id: string }>;
  receipts: Array<ReceiptMetrics & { receipt_id: string; session: string; unused_fact_ids: string[] }>;
}
/** Narrow receipt reports by session, author, time, or one receipt identifier. */
export interface ReceiptReportOptions {
  session?: string;
  author?: string;
  since?: string;
  receipt_id?: string;
  limit: number;
}

/** Normalize only repository-relative file evidence, rejecting URLs and traversal. */
export function normalizeReceiptFile(value: string): string {
  const portable = value.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  if (!portable || isAbsolute(portable) || /^[a-z][a-z\d+.-]*:/i.test(portable) || normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    throw new Error("File evidence must name a repository-relative file");
  }
  return normalized;
}

/**
 * Build facts from exactly the rendered content, annotate text or attach a JSON
 * manifest, and persist its receipt. Fact hashes exclude clocks and receipt ids.
 * Write failures propagate so callers disclose that measurement is unavailable.
 */
export function serveContextReceipt(
  pmRoot: string,
  output: string,
  format: "json" | "text",
  associations: ReceiptAssociations,
  identity: ReceiptIdentity,
  outputPath?: string,
): { output: string; receipt: ContextReceipt } {
  const receipt: StoredReceipt = {
    protocol: "pm-context-usage/v1", receipt_id: randomUUID(), session: "", author: identity.author,
    served_at: new Date().toISOString(), command: identity.command, sections: [], facts: [], protocol_tokens: 0, used: {},
  };
  receipt.session = identity.session ?? receipt.receipt_id;
  const knownFiles: Array<{ itemId: string; value: string; normalized: string }> = [];
  for (const file of associations.files) {
    try { knownFiles.push({ ...file, normalized: normalizeReceiptFile(file.value) }); } catch { /* External links are not editable files. */ }
  }
  /** Intern a stable section name for both JSON and text projections. */
  const sectionFor = (name: string): ContextSection => {
    const existing = receipt.sections.find((section) => section.name === name);
    if (existing) return existing;
    const section = { id: `s-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`, name };
    receipt.sections.push(section);
    return section;
  };
  /** Associate one visible fragment with content ids, items and editable files. */
  const factFor = (section: ContextSection, text: string, inheritedItems: string[] = []): ContextFact => {
    const itemIds = associations.item_ids.filter((id) => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
    });
    const item_ids = [...new Set([...inheritedItems, ...itemIds])].sort();
    const files = [...new Set(knownFiles.filter((file) => item_ids.includes(file.itemId) && (format === "json" ? text.includes(JSON.stringify(file.value)) : text === `- ${file.itemId} file: ${file.value}`)).map((file) => file.normalized))].sort();
    const id = `f-${createHash("sha256").update(JSON.stringify([section.id, item_ids, text])).digest("hex").slice(0, 24)}`;
    const existing = receipt.facts.find((fact) => fact.id === id);
    if (existing) { existing.estimated_tokens += Math.ceil(text.length / 4); return existing; }
    const fact = { id, section_id: section.id, item_ids, files, estimated_tokens: Math.ceil(text.length / 4) };
    receipt.facts.push(fact);
    return fact;
  };
  let rendered: string;
  if (format === "json") {
    const payload = JSON.parse(output) as Record<string, unknown>;
    for (const [name, value] of Object.entries(payload)) {
      if (name === "generatedAt") continue;
      const section = sectionFor(name);
      for (const fragment of Array.isArray(value) ? value : [value]) factFor(section, JSON.stringify(fragment));
    }
    const { used: _used, ...publicReceipt } = receipt;
    payload.context_receipt = publicReceipt;
    // Preserve compact JSON when the original output was minified.
    rendered = `${JSON.stringify(payload, null, output.trim().includes("\n") ? 2 : 0)}\n`;
    receipt.protocol_tokens = Math.ceil((rendered.length - output.length) / 4);
    publicReceipt.protocol_tokens = receipt.protocol_tokens;
    rendered = `${JSON.stringify(payload, null, output.trim().includes("\n") ? 2 : 0)}\n`;
  } else {
    let section = sectionFor("preamble");
    let inheritedItems: string[] = [];
    const lines = output.trimEnd().split("\n").map((line) => {
      if (/^#+ /.test(line)) {
        section = sectionFor(line.replace(/^#+ /, "")); inheritedItems = [];
        return `${line} [${section.id}]`;
      }
      if (!line.trim() || line.startsWith("Generated:")) return line;
      const fact = factFor(section, line, /^\s/.test(line) ? inheritedItems : []);
      inheritedItems = fact.item_ids;
      return `${line} [${fact.id}]`;
    });
    rendered = `${lines.join("\n")}\n\nContext receipt: ${receipt.receipt_id}; session: ${receipt.session}; protocol: ${receipt.protocol}\n`;
    receipt.protocol_tokens = Math.ceil((rendered.length - output.length) / 4);
  }
  withReceiptStore(pmRoot, (directory) => {
    const path = join(directory, `${receipt.receipt_id}.json`);
    try {
      persistReceipt(path, receipt);
      if (outputPath) writeFileSync(outputPath, rendered, "utf8");
      const entries = readdirSync(directory).filter((entry) => /^[\da-f-]{36}\.json$/.test(entry))
        .map((entry) => ({ entry, modified: statSync(join(directory, entry)).mtimeMs }))
        .sort((a, b) => b.modified - a.modified || b.entry.localeCompare(a.entry));
      for (const entry of entries.slice(RECEIPT_LIMITS.count)) rmSync(join(directory, entry.entry));
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  });
  const { used: _used, ...publicReceipt } = receipt;
  return { output: rendered, receipt: publicReceipt };
}

/** Serialize an atomic bounded snapshot; readers never observe a partial write. */
function persistReceipt(path: string, receipt: StoredReceipt): void {
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized) > RECEIPT_LIMITS.bytes) throw new Error("Context receipt exceeds the runtime byte limit");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, serialized, { mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

/** Cooperating writers serialize rotation and evidence updates; contention asks for retry. */
function withReceiptStore<T>(pmRoot: string, operation: (directory: string) => T): T {
  const directory = join(pmRoot, RECEIPTS_RELATIVE_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, ".lock");
  mkdirSync(lock);
  try { return operation(directory); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Validate every field consumed by reports, skipping oversized or corrupt snapshots. */
function readReceipt(path: string): StoredReceipt | null {
  try {
    if (statSync(path).size > RECEIPT_LIMITS.bytes) return null;
    const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof decoded !== "object" || decoded === null) return null;
    const row = decoded as Record<string, unknown>;
    if (row.protocol !== "pm-context-usage/v1" || typeof row.receipt_id !== "string" || !/^[\da-f-]{36}$/.test(row.receipt_id) || basename(path) !== `${row.receipt_id}.json`) return null;
    for (const key of ["session", "author", "served_at", "command"]) if (typeof row[key] !== "string") return null;
    const at = row.served_at as string;
    if (Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) return null;
    if (!Number.isSafeInteger(row.protocol_tokens) || (row.protocol_tokens as number) < 0 || !Array.isArray(row.sections) || !Array.isArray(row.facts)) return null;
    const sectionIds = new Set<string>();
    for (const section of row.sections) {
      if (typeof section !== "object" || section === null || typeof section.id !== "string" || typeof section.name !== "string") return null;
      sectionIds.add(section.id);
    }
    const factIds = new Set<string>();
    for (const entry of row.facts) {
      if (typeof entry !== "object" || entry === null) return null;
      const fact = entry as Record<string, unknown>;
      if (typeof fact.id !== "string" || factIds.has(fact.id) || typeof fact.section_id !== "string" || !sectionIds.has(fact.section_id)) return null;
      if (!Array.isArray(fact.item_ids) || !fact.item_ids.every((id: unknown) => typeof id === "string")) return null;
      if (!Array.isArray(fact.files) || !fact.files.every((file: unknown) => typeof file === "string" && normalizeReceiptFile(file) === file)) return null;
      if (!Number.isSafeInteger(fact.estimated_tokens) || (fact.estimated_tokens as number) < 0) return null;
      factIds.add(fact.id);
    }
    if (typeof row.used !== "object" || row.used === null || Array.isArray(row.used)) return null;
    for (const [id, signals] of Object.entries(row.used)) {
      if (!factIds.has(id) || !Array.isArray(signals) || !signals.every((signal: unknown) => signal === "citation" || signal === "touch" || signal === "edit")) return null;
    }
    return row as unknown as StoredReceipt;
  } catch { return null; }
}

/**
 * Record explicit, receipt-scoped usage. Unknown ids reject the entire update;
 * repeat reports are idempotent. Item/file proxies match only facts in this receipt.
 */
export function recordReceiptUsage(pmRoot: string, usage: ReceiptUsage): void {
  if (!/^[\da-f-]{36}$/.test(usage.receipt_id)) throw new Error("Invalid context receipt id");
  withReceiptStore(pmRoot, (directory) => {
    const path = join(directory, `${usage.receipt_id}.json`);
    const receipt = readReceipt(path);
    if (!receipt) throw new Error("Context receipt is missing, expired or malformed");
    if (usage.session !== undefined && usage.session !== receipt.session) throw new Error("Session does not match the context receipt");
    const editedFiles = usage.edited_files.map(normalizeReceiptFile);
    const citations = new Set(usage.citations);
    for (const id of citations) {
      if (!receipt.facts.some((fact) => fact.id === id) && !receipt.sections.some((section) => section.id === id)) throw new Error("Citation was not served in this receipt");
    }
    for (const id of usage.touched_items) if (!receipt.facts.some((fact) => fact.item_ids.includes(id))) throw new Error("Touched item was not served in this receipt");
    for (const file of editedFiles) if (!receipt.facts.some((fact) => fact.files.includes(file))) throw new Error("Edited file was not served in this receipt");
    for (const fact of receipt.facts) {
      const signals = new Set(receipt.used[fact.id]);
      if (citations.has(fact.id) || citations.has(fact.section_id)) signals.add("citation");
      if (usage.touched_items.some((id) => fact.item_ids.includes(id))) signals.add("touch");
      if (editedFiles.some((file) => fact.files.includes(file))) signals.add("edit");
      if (signals.size > 0) receipt.used[fact.id] = [...signals].sort();
    }
    persistReceipt(path, receipt);
  });
}

/** Count fact impressions and estimated unused cost without claiming cognitive use. */
function receiptMetrics(receipts: readonly StoredReceipt[], itemId?: string): ReceiptMetrics {
  const metrics: ReceiptMetrics = { served_facts: 0, used_facts: 0, cited_facts: 0, touch_facts: 0, edit_facts: 0,
    precision: null, estimated_served_tokens: 0, unused_context_tokens: 0, protocol_tokens: 0 };
  for (const receipt of receipts) {
    if (itemId === undefined) metrics.protocol_tokens += receipt.protocol_tokens;
    for (const fact of receipt.facts) {
      if (itemId !== undefined && !fact.item_ids.includes(itemId)) continue;
      const signals = receipt.used[fact.id] ?? [];
      metrics.served_facts += 1;
      metrics.estimated_served_tokens += fact.estimated_tokens;
      if (signals.length > 0) metrics.used_facts += 1;
      else metrics.unused_context_tokens += fact.estimated_tokens;
      if (signals.includes("citation")) metrics.cited_facts += 1;
      if (signals.includes("touch")) metrics.touch_facts += 1;
      if (signals.includes("edit")) metrics.edit_facts += 1;
    }
  }
  if (metrics.served_facts > 0) metrics.precision = metrics.used_facts / metrics.served_facts;
  return metrics;
}

/** Read retained receipts, report skipped corruption, and aggregate before limiting detail. */
export function reportContextReceipts(pmRoot: string, options: ReceiptReportOptions): ReceiptReport {
  const directory = join(pmRoot, RECEIPTS_RELATIVE_PATH);
  const selected: StoredReceipt[] = [];
  let malformed = 0;
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory).filter((name) => /^[\da-f-]{36}\.json$/.test(name))) {
      const receipt = readReceipt(join(directory, entry));
      if (!receipt) { malformed += 1; continue; }
      if (options.session !== undefined && receipt.session !== options.session) continue;
      if (options.author !== undefined && receipt.author !== options.author) continue;
      if (options.since !== undefined && receipt.served_at <= options.since) continue;
      if (options.receipt_id !== undefined && receipt.receipt_id !== options.receipt_id) continue;
      selected.push(receipt);
    }
  }
  selected.sort((a, b) => a.served_at.localeCompare(b.served_at) || a.receipt_id.localeCompare(b.receipt_id));
  const sessions = [...new Set(selected.map((receipt) => receipt.session))].sort();
  const itemIds = [...new Set(selected.flatMap((receipt) => receipt.facts.flatMap((fact) => fact.item_ids)))].sort();
  return {
    protocol: "pm-context-usage/v1", retained_receipts: selected.length, malformed_receipts: malformed,
    totals: receiptMetrics(selected),
    sessions: sessions.slice(0, options.limit).map((session) => ({ session, ...receiptMetrics(selected.filter((receipt) => receipt.session === session)) })),
    items: itemIds.slice(0, options.limit).map((id) => ({ id, ...receiptMetrics(selected, id) })),
    receipts: selected.slice(0, options.limit).map((receipt) => ({ receipt_id: receipt.receipt_id, session: receipt.session,
      ...receiptMetrics([receipt]), unused_fact_ids: receipt.facts.filter((fact) => !receipt.used[fact.id]?.length).map((fact) => fact.id) })),
  };
}

/** Render the receipt denominator, usage proxies and unused estimated cost as a brief. */
export function renderReceiptReport(report: ReceiptReport): string {
  const metrics = report.totals;
  const precision = metrics.precision === null ? "n/a" : `${(100 * metrics.precision).toFixed(1)}%`;
  return ["## Bundle receipts (reported usage)", "", `- receipts: ${report.retained_receipts}; malformed skipped: ${report.malformed_receipts}`,
    `- used / served facts: ${metrics.used_facts} / ${metrics.served_facts}; precision: ${precision}`,
    `- citations: ${metrics.cited_facts}; item-touch proxies: ${metrics.touch_facts}; file-edit proxies: ${metrics.edit_facts}`,
    `- unused context: ~${metrics.unused_context_tokens} tokens; protocol overhead: ~${metrics.protocol_tokens} tokens`, "",
    "| session | used / served | unused tokens (estimated) |", "| --- | ---: | ---: |",
    ...report.sessions.map((session) => `| ${session.session.replaceAll("|", "\\|").replaceAll("\n", " ")} | ${session.used_facts} / ${session.served_facts} | ${session.unused_context_tokens} |`), ""].join("\n");
}
