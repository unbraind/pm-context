import type { OutputEnvelopeFitReceipt, OutputOmissionReceipt } from "@unbrained/pm-cli/sdk";
/** Package intent for resuming an item with a previous claim in its retained history. */
export declare const CLAIM_RESUME_INTENT: {
    command: "context-resume";
    intent: "resume";
    description: string;
    included_field_groups: string[];
    token_budget: number;
    source: "package";
};
/** Request shared by the SDK entry point and the installed extension command. */
export interface ClaimResumeRequest {
    id: string;
    author: string;
    intent?: string;
    tokenBudget?: number;
    format?: "toon" | "json";
}
/** Field changes are atomic. An append reuses the prefix at the claim endpoint. */
export type ClaimResumeChange = {
    field: string;
    op: "set";
    value: unknown;
} | {
    field: string;
    op: "append";
    from_length: number;
    entries: unknown[];
} | {
    field: string;
    op: "remove";
};
/** A recovery coordinate in the verified history stream read for this brief. */
export interface ClaimResumeRevision {
    version: number;
    at: string;
    item_hash: string;
}
/** Versioned brief and the SDK's complete-envelope budget accounting. */
export interface ClaimResumePacket {
    version: 1;
    intent: "resume";
    item: {
        id: string;
        title: string;
        status: string;
        priority: number;
        assignee: string | null;
    };
    claim: ClaimResumeRevision & {
        author: string;
    };
    head: ClaimResumeRevision;
    changes: readonly ClaimResumeChange[];
    omission_receipt: OutputOmissionReceipt & {
        audit_fields: string[];
        deferred_fields: string[];
        restore_argv?: {
            claim: string[];
            head: string[];
        };
    };
    output_fit: Readonly<OutputEnvelopeFitReceipt>;
}
/** Typed packet and its exact UTF-8 rendering, including the final newline. */
export interface ClaimResumeResult {
    packet: ClaimResumePacket;
    text: string;
}
/** Build a read-only claim-bound brief and fit whole field changes under its transport budget. */
export declare function buildClaimResume(request: ClaimResumeRequest, pmRoot: string): Promise<ClaimResumeResult>;
//# sourceMappingURL=claim-resume.d.ts.map