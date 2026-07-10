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
    parent?: string;
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
export declare function readPmItems(pmRoot: string): PmItem[];
declare const _default: {
    name: string;
    version: string;
    description: string;
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map