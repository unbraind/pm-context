/** Read-only consistency checks over producer-declared, co-current packet claims. */
import { PmCliError } from "@unbrained/pm-cli/sdk";
/** A citation into the producer's recorded item, using a JSON Pointer field coordinate. */
export interface ClaimCitation {
    item: string;
    field: string;
}
/** One assertion that holds now within an exact subject, field and scope. */
export interface ContextClaim {
    id: string;
    kind: "state" | "policy";
    subject: string;
    field: string;
    scope: string;
    /** State is single-valued; policy values are exclusively required or forbidden. */
    value: string;
    citation: ClaimCitation;
    /** Explicit replacement declarations; referenced claims must be in this packet. */
    supersedes?: string[];
}
/** Selected assertions only; free text and model proposals are deliberately outside this protocol. */
export interface WitnessPacket {
    claims: ContextClaim[];
}
/** The violated deterministic rule and its complete, smallest cited assertion set. */
export interface ContextWitness {
    rule: "CONFLICTING_STATE" | "SUPERSEDED_CLAIM" | "EXCLUSIVE_POLICY";
    claims: ContextClaim[];
}
/** Absence of a witness describes declared rules only, never semantic consistency. */
export interface WitnessReport {
    protocol: "pm-context-witness/v1";
    code: "CONTRADICTION" | "NO_DECLARED_CONFLICT";
    checked_claims: number;
    conflicting_pairs: number;
    basis: "declared-co-current-claims";
    witness: ContextWitness | null;
    remedy: string;
}
/** Stable refusal codes and recovery guidance shared by SDK and CLI. */
export declare class WitnessError extends PmCliError {
    /** Machine-readable failure category without input contents or private paths. */
    readonly code: "INVALID_PACKET" | "INVALID_ARGUMENT" | "INPUT_UNAVAILABLE" | "BUDGET_TOO_SMALL";
    /** Action required before safely retrying the operation. */
    readonly remedy: string;
    constructor(code: WitnessError["code"], remedy: string);
}
/** Bound work and validate the complete schema before considering any conflict. */
export declare function parseWitnessPacket(value: unknown): WitnessPacket;
/** Reuse the existing bounded UTF-8 JSON reader and expose witness-specific refusals. */
export declare function readWitnessPacket(path: string): WitnessPacket;
/** Return the globally smallest witness; all supported rules require exactly two assertions. */
export declare function checkContextWitnesses(input: WitnessPacket): WitnessReport;
/** Emit lossless agent-sized output; refuse rather than truncate a cited witness. */
export declare function encodeWitnessReport(report: WitnessReport, format?: "json" | "toon", budget?: number): string;
//# sourceMappingURL=witnesses.d.ts.map