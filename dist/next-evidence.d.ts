import { PmCliError } from "@unbrained/pm-cli/sdk";
/** Available read metadata only; there is deliberately no executable callback or command. */
export interface EvidenceRead {
    id: string;
    source: string;
    revision: string;
    covers: string[];
    estimated_tokens: number;
    estimated_tool_calls: number;
}
/** Caller-owned criterion contract and explicitly missing criterion identifiers. */
export interface NextEvidencePacket {
    contract_revision: string;
    missing: string[];
    reads: EvidenceRead[];
    /** Positive token-equivalent overhead for one tool invocation. */
    tool_call_tokens: number;
}
/** One selected read, ordered by marginal coverage per declared combined cost. */
export interface NextEvidenceStep {
    read: string;
    source: string;
    revision: string;
    adds: string[];
    estimated_tokens: number;
    estimated_tool_calls: number;
    cost: number;
}
/** Compact reusable plan; coverage is a caller declaration, never observed evidence. */
export interface NextEvidencePlan {
    protocol: "pm-context-next-evidence/v1";
    contract: string;
    basis: "caller-declared-coverage;not-observed-evidence";
    optimality: "exact-minimum-cost-cover-of-coverable-criteria";
    ranking: "marginal-criteria-per-token-equivalent;read-id-ties";
    reads_executed: 0;
    missing: string[];
    uncovered: string[];
    steps: NextEvidenceStep[];
    estimated_tokens: number;
    estimated_tool_calls: number;
    cost: number;
    tool_call_tokens: number;
    remedy: string;
}
/** Typed refusals are safe to render through the host CLI error boundary. */
export declare class NextEvidenceError extends PmCliError {
    /** Stable error category, independent of input paths or source contents. */
    readonly code: "INVALID_PACKET" | "INPUT_UNAVAILABLE" | "INVALID_ARGUMENT" | "STALE_PLAN" | "INVALID_PLAN";
    /** Corrective action that leaves tracker and source data untouched. */
    readonly remedy: string;
    constructor(code: NextEvidenceError["code"], remedy: string);
}
/** Strict parsing bounds exact optimization to 12 criteria and 64 reads, with no truncation. */
export declare function parseNextEvidencePacket(value: unknown): NextEvidencePacket;
/** Reuse the package's bounded stable-file reader, preserving typed path-free refusals. */
export declare function readNextEvidenceJson(path: string): unknown;
/** Compute the exact minimum-cost cover, then rank its reads by newly added coverage per cost. */
export declare function planNextEvidence(input: NextEvidencePacket): NextEvidencePlan;
/** Verify both the current source contract and the complete persisted plan; never execute a read. */
export declare function validateNextEvidencePlan(plan: unknown, input: NextEvidencePacket): NextEvidencePlan;
/** Encode compact JSON or lossless TOON tables without source content or executable read instructions. */
export declare function encodeNextEvidencePlan(plan: NextEvidencePlan, format?: "json" | "toon"): string;
//# sourceMappingURL=next-evidence.d.ts.map