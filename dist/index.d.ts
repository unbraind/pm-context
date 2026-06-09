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
}
export interface AgentHandoff {
    generatedAt: string;
    counts: {
        focus: number;
        neighbors: number;
        blockers: number;
        links: number;
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
    links: Array<{
        itemId: string;
        kind: "doc" | "file";
        value: string;
    }>;
    suggestedCommand: string;
}
export declare function sortContextItems(items: PmItem[]): PmItem[];
export declare function extractRelationships(item: PmItem): Array<{
    from: string;
    to: string;
    kind: string;
}>;
export declare function buildContextPack(allItems: PmItem[], options?: ContextPackOptions): ContextPack;
export declare function renderMarkdown(pack: ContextPack): string;
export declare function buildAgentHandoff(pack: ContextPack): AgentHandoff;
export declare function renderAgentHandoff(pack: ContextPack): string;
export declare function readPmItems(pmRoot: string): PmItem[];
declare const _default: {
    name: string;
    version: string;
    description: string;
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map