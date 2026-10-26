import type { SuggestedCommand } from "./suggested-command.ts";
import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { PmItem } from "./index.ts";
/** Runtime snapshots are disposable, bounded, and never stored in item history. */
export declare const SINCE_RETENTION: {
    readonly count: 200;
    readonly bytes: 4194304;
    readonly directory: "runtime/context-since";
};
/** Explicit recovery contracts for expired history, bad input, and impossible budgets. */
export declare class SinceError extends PmCliError {
    /** Machine-readable failure category. */
    readonly code: string;
    /** Action that restores a usable starting point. */
    remedy: string;
    /** Host usage-error status, also understood by direct SDK callers. */
    readonly exitCode: 2;
    constructor(code: string, remedy: string, retryArgv?: string[]);
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
/** Exact JSON response; the bound includes the cursor and omission receipt. */
export interface SincePack {
    protocol: "pm-context-since/v1";
    cursor: string;
    served_at: string;
    restart_from: string;
    changes: DeltaRow[];
    omission_receipt: {
        invalid_timestamp_rows: number;
        invalid_timestamp_examples: Array<{
            id: string;
            ordinal: number;
            ts: string;
        }>;
        expired_streams: string[];
        deferred_rows: number;
        deferred_own_claims: number;
        excerpt_omitted_chars: number;
        remedy: string;
        /** Executable alternatives for complete comments/history. */
        commands: SuggestedCommand[];
    };
    budget: {
        ceiling: number;
        token_upper_bound: number;
        unit: "utf8-bytes";
    };
}
/** Invocation parameters deliberately exclude Git and mutable wall-clock defaults. */
export interface SinceOptions {
    cursor?: string;
    from?: string;
    author: string;
    tokenBudget: number;
}
/** Atomically publish a shared inventory and bounded checkpoints using the SDK writer lock. */
export declare function saveCheckpoint(directory: string, state: Checkpoint): Promise<{
    cursor: string;
    served_at: string;
}>;
/** Serialize with a conservative byte-token upper bound, including its own digits. */
export declare function encodeSincePack(pack: SincePack): string;
/** Select a prefix in linear serialization work, including exact counter and byte-count digits. */
export declare function packSinceRows(pack: SincePack, rows: DeltaRow[]): number;
/**
 * Serve one deterministic ranked page. Pending pages freeze their source window;
 * writes arriving while they drain are collected after the last pending page.
 * Byte-level budgeting upper-bounds byte-fallback tokenizer costs without an
 * unpinned model tokenizer dependency. Nothing is silently consumed on overflow.
 */
export declare function buildSincePack(pmRoot: string, items: PmItem[], terminal: Set<string>, options: SinceOptions): Promise<SincePack>;
//# sourceMappingURL=since.d.ts.map