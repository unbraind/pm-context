import type { ExtensionApi, RuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import type { ContextRelevanceReport } from "@unbrained/pm-cli/sdk/query";
/**
 * Runtime stand-in for the SDK's `defineExtension`.
 *
 * `defineExtension` is a documented zero-cost identity function. This package
 * now resolves `@unbrained/pm-cli` at runtime (it is a peer dependency the pm
 * host provides) for the `sdk/core` and `sdk/query` engines, but the authoring
 * helper itself has no runtime behavior, so a local identity shim avoids a
 * needless value import while still contract-checking the module against
 * {@link ExtensionModule}.
 */
export declare const EXIT_CODE: {
    readonly GENERIC_FAILURE: 1;
    readonly USAGE: 2;
};
export declare class CommandError extends Error {
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
export interface PmItem {
    id: string;
    title?: string;
    type?: string;
    status?: string;
    priority?: number;
    tags?: string[];
    body?: string;
    description?: string;
    /** Null (not absent) when the SDK reports an explicitly unset parent. */
    parent?: string | null;
    assignee?: string;
    sprint?: string;
    release?: string;
    deadline?: string;
    created_at?: string;
    updated_at?: string;
    docs?: unknown;
    files?: unknown;
    deps?: unknown;
    dependencies?: unknown;
    blocked_by?: unknown;
    blockedBy?: unknown;
    [key: string]: unknown;
}
export declare const MAX_NEIGHBORHOOD_DEPTH = 5;
export declare const MARKDOWN_SECTIONS: readonly ["summary", "focus", "neighborhood", "neighbors", "links", "deps"];
export declare const AGENT_SECTIONS: readonly ["focus", "blockers", "next-actions", "actions", "nextactions", "recent", "activity", "links", "deps", "refresh"];
export interface ContextPackOptions {
    ids?: string[];
    status?: string;
    type?: string;
    tag?: string;
    limit?: number;
    includeBody?: boolean;
    includeClosed?: boolean;
    neighborhood?: boolean;
    neighborhoodDepth?: number;
    generatedAt?: string;
    includeDeps?: boolean;
    maxItems?: number;
    /**
     * Override the focus-item ranking. Defaults to {@link sortContextItems} (the
     * deterministic priority-then-recency order used by the pure assembly path).
     * The command path supplies the SDK relevance ranker built from
     * {@link defaultScoreContextCandidates} so real packs honor pm's weighted
     * context-relevance model instead of the hand-rolled sort.
     */
    ranker?: (items: PmItem[]) => PmItem[];
    /**
     * Override the total-item budgeting applied when `maxItems` is set. Defaults
     * to the count-based trim (focus first, neighbors trimmed to fit). The
     * command path supplies a {@link packContextCandidates}-backed packer so a
     * token budget selects items with pm's projection-degradation packer rather
     * than a hard count slice.
     */
    packer?: (focus: PmItem[], neighbors: PmItem[], maxItems: number) => {
        focus: PmItem[];
        neighbors: PmItem[];
    };
}
export interface ContextPackDepInfo {
    itemId: string;
    dependsOn: string[];
    dependedBy: string[];
}
export interface RenderOptions {
    sections?: string[];
    compress?: boolean;
}
export interface ContextPack {
    generatedAt: string;
    filters: {
        ids: string[];
        status?: string;
        type?: string;
        tag?: string;
        includeClosed: boolean;
        neighborhood: boolean;
        includeDeps: boolean;
        maxItems?: number;
    };
    summary: {
        totalItems: number;
        selectedItems: number;
        neighborItems: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
    };
    items: PmItem[];
    neighbors: PmItem[];
    links: Array<{
        itemId: string;
        kind: "doc" | "file";
        value: string;
    }>;
    relationships: Array<{
        from: string;
        to: string;
        kind: string;
    }>;
    deps?: ContextPackDepInfo[];
}
export interface AgentHandoff {
    generatedAt: string;
    counts: {
        focus: number;
        neighbors: number;
        blockers: number;
        links: number;
        recent: number;
        deps: number;
    };
    focus: Array<{
        id: string;
        title: string;
        status: string;
        type: string;
        priority?: number;
        deadline?: string;
    }>;
    blockers: Array<{
        itemId: string;
        blockedBy: string;
        kind: string;
        title?: string;
        status?: string;
    }>;
    nextActions: Array<{
        id: string;
        title: string;
        reason: string;
    }>;
    recent: Array<{
        id: string;
        title: string;
        status: string;
        updatedAt?: string;
    }>;
    links: Array<{
        itemId: string;
        kind: "doc" | "file";
        value: string;
    }>;
    deps?: ContextPackDepInfo[];
    suggestedCommand: string;
}
export interface SelectionOptions {
    ids: string[];
    status?: string;
    type?: string;
    tag?: string;
    inferredStatus: boolean;
}
export interface SuggestedAgentCommandInput {
    commandName: "context-pack" | "context-handoff";
    selection: SelectionOptions;
    limit: number;
    defaultLimit: number;
    recentLimit: number;
    defaultRecentLimit: number;
    includeClosed: boolean;
    neighborhood: boolean;
    neighborhoodDepth: number;
    includeFormatFlag?: boolean;
    compress?: boolean;
    includeDeps?: boolean;
    maxItems?: number;
    sections?: string[];
}
export declare function validateSections(format: "markdown" | "agent" | "json", values: string[]): string[];
export declare function resolveSelectionOptions(options: Record<string, unknown>, defaults?: {
    fallbackStatus?: string;
}): SelectionOptions;
export declare function buildSuggestedAgentCommand(input: SuggestedAgentCommandInput): string;
export declare function sortContextItems(items: PmItem[]): PmItem[];
export declare function extractRelationships(item: PmItem): Array<{
    from: string;
    to: string;
    kind: string;
}>;
export declare function buildContextPack(allItems: PmItem[], options?: ContextPackOptions): ContextPack;
export declare function renderMarkdown(pack: ContextPack, options?: RenderOptions): string;
export declare function buildAgentHandoff(pack: ContextPack, options?: {
    recentLimit?: number;
    suggestedCommand?: string;
}): AgentHandoff;
export declare function renderAgentHandoff(pack: ContextPack, options?: {
    recentLimit?: number;
    suggestedCommand?: string;
    sections?: string[];
    compress?: boolean;
}): string;
/**
 * Read every pm item (full metadata + body) in-process through the SDK.
 *
 * Replaces the previous `spawnSync("pm", ["list-all", "--json", "--include-body"])`
 * shell-out with the typed {@link list} action from `@unbrained/pm-cli/sdk/core`.
 * `list-all` is the SDK alias for `list` with `excludeTerminal: false`; passing
 * `full: true` + `includeBody: true` + `noTruncate: true` reproduces the exact
 * full-metadata-with-body projection the shell-out parsed, so the downstream
 * pack shape is byte-identical (verified against real workspaces).
 */
export declare function readPmItems(pmRoot: string): Promise<PmItem[]>;
/** Rank options forwarded to the SDK relevance engine. */
export interface SdkRankOptions {
    /** Workspace lifecycle registry, including custom in-progress aliases. */
    statusRegistry: RuntimeStatusRegistry;
    /** Stable clock used for deadline/recency pressure. */
    now: string;
    /** Optional caller identity used for assignment affinity. */
    author?: string;
    /** Optional decayed served-then-used affinity by item id. */
    usageAffinity?: Readonly<Record<string, number>>;
}
/**
 * Rank items with pm's deterministic weighted relevance model.
 *
 * Wraps {@link buildItemContextRelevanceCandidates} +
 * {@link defaultScoreContextCandidates} so the command path uses the same
 * relevance signals (`priority_pressure`, `recency`, `claim_focus`, …) as
 * `pm context` / `pm next` instead of the hand-rolled priority-then-recency
 * sort. Returns the items in ranked order and exposes the full report via
 * {@link scoreContextItems} for `--explain`.
 */
export declare function rankContextItems(items: readonly PmItem[], options: SdkRankOptions): PmItem[];
/**
 * Score items with the SDK relevance model and return the full report.
 *
 * The report's `ranked[].contributions` map each item's score back to the
 * individual signals that produced it — the data behind `pm context-pack
 * --explain`.
 */
export declare function scoreContextItems(items: readonly PmItem[], options: SdkRankOptions): ContextRelevanceReport<PmItem>;
/**
 * Build a {@link ContextPackOptions.ranker} closure backed by the SDK relevance
 * model. The closure ranks whatever focus subset {@link buildContextPack} hands
 * it after id/status/type/tag filtering, preserving the SDK's weighted order.
 */
export declare function createSdkRanker(allItems: readonly PmItem[], options: SdkRankOptions): (items: PmItem[]) => PmItem[];
/**
 * Build a {@link ContextPackOptions.packer} closure backed by
 * {@link packContextCandidates}. Each `--max-items` slot maps to a token budget;
 * focus items are required anchors, neighbors compete by relevance rank for the
 * remaining budget. The packer selects under that token budget with pm's
 * projection-degradation optimizer instead of a hard count slice.
 */
export declare function createSdkPacker(rankedFocus: readonly PmItem[], rankedNeighbors: readonly PmItem[]): (focus: PmItem[], neighbors: PmItem[], maxItems: number) => {
    focus: PmItem[];
    neighbors: PmItem[];
};
/** One ranked focus item with its per-signal relevance contributions. */
export interface ContextExplainEntry {
    id: string;
    rank: number;
    score: number;
    contributions: Record<string, number>;
}
/** Relevance explanation report surfaced by `pm context-pack --explain`. */
export interface ContextExplainReport {
    generatedAt: string;
    model: string;
    available_signals: readonly string[];
    entries: ContextExplainEntry[];
}
/**
 * Build the `--explain` report from the SDK relevance model for a set of items.
 */
export declare function buildContextExplain(items: readonly PmItem[], options: SdkRankOptions): ContextExplainReport;
/**
 * Render a {@link ContextExplainReport} as an agent-readable Markdown brief.
 *
 * Each focus item is listed with its relevance rank, normalized score, and the
 * per-signal contributions that produced it (sorted most-contributing first), so
 * an agent can judge whether the pack is trustworthy before acting on it.
 */
export declare function renderContextExplain(report: ContextExplainReport, options?: {
    compress?: boolean;
}): string;
declare const _default: {
    name: string;
    version: string;
    description: string;
    activate(api: ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map