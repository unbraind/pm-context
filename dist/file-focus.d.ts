import type { PmItem } from "./index.ts";
/** A repository-normalized working set and reproducible refresh arguments. */
export interface FileFocus {
    root: string;
    files: string[];
    refresh: string;
}
/** Actionable usage failure from Git discovery or path validation. */
export declare class FileFocusError extends Error {
    readonly exitCode = 2;
    readonly code: "NOT_GIT_REPOSITORY" | "UNKNOWN_BASE" | "GIT_FAILED" | "INVALID_FILE_FOCUS" | "TRACKER_READ_FAILED";
    constructor(code: FileFocusError["code"], message: string, options?: ErrorOptions);
}
/** Convert native or slash-separated links to safe paths relative to the repository root. */
export declare function normalizeFocusPath(value: string, root: string): string | undefined;
/** Check tracker containment using repository-relative paths on native and Windows roots. */
export declare function isTrackerPath(path: string, pmRoot: string, repoRoot: string): boolean;
/** Resolve --changed and repeated --files using real Git; an empty working set remains an active filter. */
export declare function resolveFileFocus(options: Record<string, unknown>, args: string[], cwd: string, pmRoot: string): FileFocus | undefined;
/** Match exact files and linked directory ancestors, retaining unique changed paths per item. */
export declare function matchFileFocus(items: PmItem[], focus: FileFocus, links: (value: unknown) => string[]): Map<string, string[]>;
/** Rank focus by unique overlap, lifecycle status, priority, then deterministic id. */
export declare function rankFileFocus(items: PmItem[], matches: Map<string, string[]>): PmItem[];
/** Render the unlinked working set with a concrete tracker-linking hint. */
export declare function renderFileFocus(value: {
    unlinked_changed_files?: string[];
}): string[];
/** Enumerate all registered item folders through the canonical SDK parser without creating metadata caches. */
export declare function readFileFocusItems(pmRoot: string): Promise<PmItem[]>;
//# sourceMappingURL=file-focus.d.ts.map