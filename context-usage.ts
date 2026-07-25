/**
 * @module context-usage
 *
 * Reports on pm's own context-usage ledger: which items `pm context` and
 * `pm next` served, and which of those the agent subsequently touched.
 *
 * pm 2026.7.25 maintains an append-only ledger at
 * `<pm_root>/runtime/context-usage.jsonl`, writing a `serve` row whenever
 * `pm context` / `pm next` rank candidates and a `touch` row whenever a command
 * mutates an item. The CLI folds that ledger into the `usage_affinity` signal of
 * its built-in relevance model, but nothing surfaces the ledger itself — an
 * agent cannot ask "what was I shown, and did I actually use it?".
 *
 * This module answers exactly that, and deliberately stops there. It derives
 * only facts the ledger states directly — serve counts, touch counts, and
 * serve-then-touch conversion — and does **not** compute a competing affinity
 * score. pm owns the decay model; a second implementation of it here could
 * silently disagree with the ranking it purports to explain.
 *
 * Two failure modes fall out of the conversion analysis and are the practical
 * payload of the report:
 *
 * - **waste** — items pm served that were never touched afterwards. Every one
 *   is context an agent paid tokens for and did not use.
 * - **misses** — items an agent touched that pm never served. Every one is work
 *   the ranking failed to surface.
 *
 * The whole surface is read-only. The ledger is pm's file, with pm's schema and
 * pm's pruning; writing to it from here would corrupt the very signal being
 * reported on. {@link ContextUsageEvent} is imported as a type so the parser is
 * checked against the SDK's real contract while adding no runtime dependency —
 * installed extensions cannot resolve `@unbrained/pm-cli` at runtime
 * (upstream pm-cli#717).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextRelevanceSurface, ContextUsageEvent, ContextUsageServingRow } from "@unbrained/pm-cli/sdk";

/** Ledger location relative to the tracker root, owned and pruned by pm itself. */
export const LEDGER_RELATIVE_PATH = join("runtime", "context-usage.jsonl");

/**
 * Serving surfaces recognized by the parser.
 *
 * Typed against the SDK union so it cannot drift into an invalid value. A row
 * naming a surface pm adds later decodes as malformed, which the report states
 * explicitly — preferable to admitting it and skewing conversion silently.
 */
const SERVE_SURFACES: readonly ContextRelevanceSurface[] = ["context", "next"];

/**
 * Whether a timestamp is in canonical `Date.prototype.toISOString` form.
 *
 * Every window filter, report bound, "latest" wins, and conversion check in this
 * module compares `at` values as strings. That is only sound for a fixed-width
 * representation: `"2026-07-01T00:00:00.500Z"` sorts *before*
 * `"2026-07-01T00:00:00Z"` lexically, because `.` precedes `Z`, even though it
 * is the later instant. Requiring the canonical form — which is what pm writes —
 * makes string order equal chronological order, so any other spelling is
 * reported as malformed instead of silently skewing the metrics.
 */
function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

/** Default number of per-item rows rendered before the report truncates. */
export const DEFAULT_REPORT_LIMIT = 20;

/** Per-item rollup of every retained ledger row referencing one item. */
export interface ContextUsageItemReport {
  /** Item identifier as recorded by the ledger. */
  id: string;
  /**
   * Serve rows that actually put this item in the pack (`included: true`).
   *
   * Only these count as "shown", so only these can be wasted. An item pm ranked
   * but cut from the pack was never in front of the agent.
   */
  serves: number;
  /**
   * Serve rows that ranked this item at all, whether or not it made the pack.
   *
   * `ranked - serves` is the number of times the item lost to the token budget,
   * which is the signal for tuning that budget rather than the ranking.
   */
  ranked: number;
  /** Serve rows for this item followed by a same-author touch. */
  conversions: number;
  /** Total touch rows for this item, whether or not a serve preceded them. */
  touches: number;
  /** Best (lowest) rank the item was ever served at, or null when never served. */
  best_rank: number | null;
  /** Timestamp of the most recent serve, or null when never served. */
  last_served_at: string | null;
  /** Timestamp of the most recent touch, or null when never touched. */
  last_touched_at: string | null;
  /** Distinct touch intents observed, sorted, e.g. `["close", "create"]`. */
  intents: string[];
}

/** Complete read-only view of the ledger for one filter selection. */
export interface ContextUsageReport {
  /** Whether the ledger file exists; false means pm has not served or mutated yet. */
  ledger_present: boolean;
  /** Rows that parsed into a recognized event, after filtering. */
  event_count: number;
  /** Rows that could not be parsed; pm truncates on prune, so a tail row can be partial. */
  malformed_line_count: number;
  /** Serve events retained after filtering. */
  serve_event_count: number;
  /** Touch events retained after filtering. */
  touch_event_count: number;
  /** Distinct authors present, sorted. */
  authors: string[];
  /** Distinct surfaces present, sorted; `context` and/or `next`. */
  surfaces: string[];
  /** Earliest retained event timestamp, or null when no events matched. */
  from: string | null;
  /** Latest retained event timestamp, or null when no events matched. */
  to: string | null;
  /** Per-item rollups, ordered by serves desc, then conversions desc, then id. */
  items: ContextUsageItemReport[];
  /** Items served but never touched afterwards — context paid for and unused. */
  waste: string[];
  /** Items touched but never served — work the ranking failed to surface. */
  misses: string[];
  /**
   * Fraction of included serve judgments followed by a same-author touch, or
   * null when no judgments exist. This is serve-then-touch conversion, not pm's
   * `usage_affinity`, which additionally applies recency decay.
   */
  conversion_rate: number | null;
}

/** Filters narrowing which ledger rows a report is derived from. */
export interface ContextUsageReportOptions {
  /** Restrict to one recording author. */
  author?: string;
  /** Restrict to one serving surface; touch rows carry no surface and are kept. */
  surface?: string;
  /** Drop events at or before this ISO timestamp. */
  since?: string;
  /** Maximum per-item rows retained in {@link ContextUsageReport.items}. */
  limit?: number;
}

/** One serve judgment: an included item at a rank, recorded at a timestamp by an author. */
interface ServeJudgment {
  id: string;
  rank: number;
  at: string;
  author: string;
}

/**
 * Resolve a `--since` value into an ISO timestamp.
 *
 * Accepts a full ISO timestamp, or a relative day offset written as `7d`,
 * `-7d`, or `7`. pm's own `--from` silently yields an empty window for an
 * unsigned offset (upstream pm-cli#651); both signs are accepted here because
 * "7 days ago" and "-7 days" are the same request from an agent.
 *
 * @param value - Raw flag text.
 * @param now - Clock used to resolve relative offsets, for deterministic tests.
 * @returns The resolved ISO timestamp, or null when the value is unparseable.
 */
export function resolveSince(value: string, now: Date = new Date()): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const relative = /^-?(\d+(?:\.\d+)?)d?$/i.exec(trimmed);
  if (relative) return new Date(now.getTime() - Number(relative[1]) * 86_400_000).toISOString();
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Decode one ledger line into a recognized event.
 *
 * Validates the discriminant and every field the report reads, so a row written
 * by a future pm version — or a partial tail row left by a prune — is reported
 * as malformed rather than silently contributing zeroes to the metrics.
 *
 * @param line - Raw JSONL line, assumed already trimmed of surrounding space.
 * @returns The decoded event, or null when the line is absent or malformed.
 */
export function parseLedgerLine(line: string): ContextUsageEvent | null {
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.at !== "string" || !isCanonicalTimestamp(row.at) || typeof row.author !== "string") return null;
  if (row.kind === "touch") {
    if (typeof row.item_id !== "string" || typeof row.intent !== "string") return null;
    return { kind: "touch", at: row.at, author: row.author, item_id: row.item_id, intent: row.intent };
  }
  if (row.kind !== "serve") return null;
  if (typeof row.profile !== "string" || !Array.isArray(row.rows)) return null;
  const surface = SERVE_SURFACES.find((candidate) => candidate === row.surface);
  if (!surface) return null;
  const rows: ContextUsageServingRow[] = [];
  for (const candidate of row.rows) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.rank !== "number" || typeof entry.included !== "boolean") return null;
    rows.push({ id: entry.id, rank: entry.rank, included: entry.included });
  }
  return { kind: "serve", at: row.at, author: row.author, surface, profile: row.profile, rows };
}

/**
 * Read and decode every retained ledger row for a tracker.
 *
 * @param pmRoot - Tracker root containing the `runtime` directory.
 * @returns Decoded events in file order plus the count of unparseable lines,
 *   and `present: false` when pm has not written a ledger yet.
 */
export function readLedger(pmRoot: string): { present: boolean; events: ContextUsageEvent[]; malformed: number } {
  const path = join(pmRoot, LEDGER_RELATIVE_PATH);
  if (!existsSync(path)) return { present: false, events: [], malformed: 0 };
  const events: ContextUsageEvent[] = [];
  let malformed = 0;
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const event = parseLedgerLine(line);
    if (event) events.push(event);
    else malformed += 1;
  }
  return { present: true, events, malformed };
}

/**
 * Roll decoded ledger events up into a usage report.
 *
 * A serve judgment converts when the same author touches the served item at a
 * later timestamp. Only rows pm marked `included` are judged: a candidate that
 * was ranked but cut from the pack was never shown, so failing to touch it is
 * not waste. Touch matching uses each item's latest touch per author, which is
 * sufficient because conversion asks only whether *any* later touch exists.
 *
 * @param events - Decoded events, in any order; ordering is derived internally.
 * @param options - Author, surface, since, and limit filters.
 * @returns The rolled-up report over the filtered event set.
 */
export function buildUsageReport(
  events: readonly ContextUsageEvent[],
  options: ContextUsageReportOptions = {},
): Omit<ContextUsageReport, "ledger_present" | "malformed_line_count"> {
  const { author, surface, since } = options;
  const limit = options.limit ?? DEFAULT_REPORT_LIMIT;
  const selected = events.filter((event) => {
    if (author && event.author !== author) return false;
    if (since && event.at <= since) return false;
    if (surface && event.kind === "serve" && event.surface !== surface) return false;
    return true;
  });

  const items = new Map<string, ContextUsageItemReport>();
  const touchTimesByAuthor = new Map<string, string[]>();
  const judgments: ServeJudgment[] = [];
  const authors = new Set<string>();
  const surfaces = new Set<string>();
  let serveEvents = 0;
  let touchEvents = 0;
  let from: string | null = null;
  let to: string | null = null;

  const entryFor = (id: string): ContextUsageItemReport => {
    const existing = items.get(id);
    if (existing) return existing;
    const created: ContextUsageItemReport = {
      id,
      serves: 0,
      conversions: 0,
      ranked: 0,
      touches: 0,
      best_rank: null,
      last_served_at: null,
      last_touched_at: null,
      intents: [],
    };
    items.set(id, created);
    return created;
  };

  for (const event of selected) {
    authors.add(event.author);
    if (from === null || event.at < from) from = event.at;
    if (to === null || event.at > to) to = event.at;
    if (event.kind === "touch") {
      touchEvents += 1;
      const entry = entryFor(event.item_id);
      entry.touches += 1;
      if (entry.last_touched_at === null || event.at > entry.last_touched_at) entry.last_touched_at = event.at;
      if (!entry.intents.includes(event.intent)) entry.intents.push(event.intent);
      const key = `${event.author} ${event.item_id}`;
      const times = touchTimesByAuthor.get(key);
      if (times) times.push(event.at);
      else touchTimesByAuthor.set(key, [event.at]);
      continue;
    }
    serveEvents += 1;
    surfaces.add(event.surface);
    for (const row of event.rows) {
      const entry = entryFor(row.id);
      entry.ranked += 1;
      if (entry.best_rank === null || row.rank < entry.best_rank) entry.best_rank = row.rank;
      // Only an included row was actually shown, so only it can be served, wasted, or converted.
      if (!row.included) continue;
      entry.serves += 1;
      if (entry.last_served_at === null || event.at > entry.last_served_at) entry.last_served_at = event.at;
      judgments.push({ id: row.id, rank: row.rank, at: event.at, author: event.author });
    }
  }

  let converted = 0;
  for (const judgment of judgments) {
    const times = touchTimesByAuthor.get(`${judgment.author} ${judgment.id}`);
    if (!times?.some((at) => at > judgment.at)) continue;
    converted += 1;
    entryFor(judgment.id).conversions += 1;
  }

  const ranked = [...items.values()].sort((a, b) =>
    b.serves - a.serves || b.conversions - a.conversions || a.id.localeCompare(b.id));
  for (const entry of ranked) entry.intents.sort();

  return {
    event_count: selected.length,
    serve_event_count: serveEvents,
    touch_event_count: touchEvents,
    authors: [...authors].sort(),
    surfaces: [...surfaces].sort(),
    from,
    to,
    items: ranked.slice(0, Math.max(0, limit)),
    waste: ranked.filter((entry) => entry.serves > 0 && entry.conversions === 0).map((entry) => entry.id),
    misses: ranked.filter((entry) => entry.serves === 0 && entry.touches > 0).map((entry) => entry.id),
    conversion_rate: judgments.length === 0 ? null : converted / judgments.length,
  };
}

/**
 * Read a tracker's ledger and roll it up in one call.
 *
 * @param pmRoot - Tracker root containing the `runtime` directory.
 * @param options - Author, surface, since, and limit filters.
 * @returns The complete report, with `ledger_present: false` and zeroed
 *   counters when pm has not written a ledger yet.
 */
export function reportContextUsage(pmRoot: string, options: ContextUsageReportOptions = {}): ContextUsageReport {
  const { present, events, malformed } = readLedger(pmRoot);
  return { ledger_present: present, malformed_line_count: malformed, ...buildUsageReport(events, options) };
}

/**
 * Render a report as an agent-readable Markdown brief.
 *
 * Leads with conversion rate and the two failure lists, because those are the
 * only parts an agent acts on; the per-item table is supporting detail.
 *
 * @param report - Report produced by {@link reportContextUsage}.
 * @returns Markdown text ending in a newline.
 */
export function renderUsageReport(report: ContextUsageReport): string {
  const lines: string[] = ["# Context usage", ""];
  if (!report.ledger_present) {
    lines.push(
      "No ledger at `runtime/context-usage.jsonl`.",
      "",
      "pm writes it on the first `pm context`, `pm next`, or item mutation.",
      "",
    );
    return lines.join("\n");
  }
  const rate = report.conversion_rate === null ? "n/a" : `${(report.conversion_rate * 100).toFixed(1)}%`;
  lines.push(
    `- serve-then-touch conversion: **${rate}**`,
    `- events: ${report.event_count} (${report.serve_event_count} serve, ${report.touch_event_count} touch)`,
    `- window: ${report.from ?? "n/a"} .. ${report.to ?? "n/a"}`,
    `- authors: ${report.authors.length > 0 ? report.authors.join(", ") : "n/a"}`,
    `- surfaces: ${report.surfaces.length > 0 ? report.surfaces.join(", ") : "n/a"}`,
  );
  if (report.malformed_line_count > 0) lines.push(`- malformed lines skipped: ${report.malformed_line_count}`);
  lines.push("");
  lines.push(
    "## Waste (served, never touched)",
    "",
    report.waste.length > 0 ? report.waste.map((id) => `- ${id}`).join("\n") : "_none_",
    "",
    "## Misses (touched, never served)",
    "",
    report.misses.length > 0 ? report.misses.map((id) => `- ${id}`).join("\n") : "_none_",
    "",
  );
  if (report.items.length > 0) {
    lines.push(
      "## Items",
      "",
      "| id | serves | ranked | conversions | touches | best rank | last served | last touched | intents |",
      "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    );
    for (const entry of report.items) {
      lines.push(
        `| ${entry.id} | ${entry.serves} | ${entry.ranked} | ${entry.conversions} | ${entry.touches} | ` +
        `${entry.best_rank ?? "-"} | ${entry.last_served_at ?? "-"} | ${entry.last_touched_at ?? "-"} | ` +
        `${entry.intents.join(", ") || "-"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
