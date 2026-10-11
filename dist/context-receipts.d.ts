/** Physical retention ceilings: at most 200 receipts of 256 KiB each. */
export declare const RECEIPT_LIMITS: {
    readonly count: 200;
    readonly bytes: 262144;
};
/** Isolated, ignored tracker runtime directory used by this protocol. */
export declare const RECEIPTS_RELATIVE_PATH: string;
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
/** Item/file associations from the selected pack, intersected with rendered text. */
export interface ReceiptAssociations {
    item_ids: string[];
    files: Array<{
        itemId: string;
        value: string;
    }>;
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
    sessions: Array<ReceiptMetrics & {
        session: string;
    }>;
    items: Array<ReceiptMetrics & {
        id: string;
    }>;
    receipts: Array<ReceiptMetrics & {
        receipt_id: string;
        session: string;
        unused_fact_ids: string[];
    }>;
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
export declare function normalizeReceiptFile(value: string): string;
/**
 * Build facts from exactly the rendered content, annotate text or attach a JSON
 * manifest, and persist its receipt. Fact hashes exclude clocks and receipt ids.
 * Write failures propagate so callers disclose that measurement is unavailable.
 */
export declare function serveContextReceipt(pmRoot: string, output: string, format: "json" | "text", associations: ReceiptAssociations, identity: ReceiptIdentity, outputPath?: string): {
    output: string;
    receipt: ContextReceipt;
};
/**
 * Record explicit, receipt-scoped usage. Unknown ids reject the entire update;
 * repeat reports are idempotent. Item/file proxies match only facts in this receipt.
 */
export declare function recordReceiptUsage(pmRoot: string, usage: ReceiptUsage): void;
/** Read retained receipts, report skipped corruption, and aggregate before limiting detail. */
export declare function reportContextReceipts(pmRoot: string, options: ReceiptReportOptions): ReceiptReport;
/** Render the receipt denominator, usage proxies and unused estimated cost as a brief. */
export declare function renderReceiptReport(report: ReceiptReport): string;
//# sourceMappingURL=context-receipts.d.ts.map