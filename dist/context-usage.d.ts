import type { ContextUsageEvent } from "@unbrained/pm-cli/sdk";
/** Ledger location relative to the tracker root, owned and pruned by pm itself. */
export declare const LEDGER_RELATIVE_PATH: string;
/** Default number of per-item rows rendered before the report truncates. */
export declare const DEFAULT_REPORT_LIMIT = 20;
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
export declare function resolveSince(value: string, now?: Date): string | null;
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
export declare function parseLedgerLine(line: string): ContextUsageEvent | null;
/**
 * Read and decode every retained ledger row for a tracker.
 *
 * @param pmRoot - Tracker root containing the `runtime` directory.
 * @returns Decoded events in file order plus the count of unparseable lines,
 *   and `present: false` when pm has not written a ledger yet.
 */
export declare function readLedger(pmRoot: string): {
    present: boolean;
    events: ContextUsageEvent[];
    malformed: number;
};
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
export declare function buildUsageReport(events: readonly ContextUsageEvent[], options?: ContextUsageReportOptions): Omit<ContextUsageReport, "ledger_present" | "malformed_line_count">;
/**
 * Read a tracker's ledger and roll it up in one call.
 *
 * @param pmRoot - Tracker root containing the `runtime` directory.
 * @param options - Author, surface, since, and limit filters.
 * @returns The complete report, with `ledger_present: false` and zeroed
 *   counters when pm has not written a ledger yet.
 */
export declare function reportContextUsage(pmRoot: string, options?: ContextUsageReportOptions): ContextUsageReport;
/**
 * Render a report as an agent-readable Markdown brief.
 *
 * Leads with conversion rate and the two failure lists, because those are the
 * only parts an agent acts on; the per-item table is supporting detail.
 *
 * @param report - Report produced by {@link reportContextUsage}.
 * @returns Markdown text ending in a newline.
 */
export declare function renderUsageReport(report: ContextUsageReport): string;
//# sourceMappingURL=context-usage.d.ts.map