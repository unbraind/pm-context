import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { SharedEvidenceReader } from "./shared-evidence.ts";
/** Exact JSON values; numbers are finite and bounded, with no coercion or rounding. */
export type AnswerValue = string | number | boolean | null;
/** A finite domain supplied by the task owner, not inferred from source prose. */
export interface AnswerVariable {
    id: string;
    values: AnswerValue[];
}
/** Only eq and neq are evaluated; other named operations make the result unknown. */
export interface AnswerPredicate {
    variable: string;
    op: string;
    value: AnswerValue;
}
/** Ordered first-match rule; all predicates in when must hold. Empty when always matches. */
export interface AnswerRule {
    when: AnswerPredicate[];
    answer: string;
}
/** The caller asserts that this field can affect the answer only through these variables. */
export interface AnswerFragment {
    id: string;
    item: string;
    field: string;
    variables: string[];
}
/** One strict declaration schema for SDK, CLI, saved packets and verification. */
export interface AnswerReductionRequest {
    contract_revision: string;
    variables: AnswerVariable[];
    rules: AnswerRule[];
    fallback: string;
    fragments: AnswerFragment[];
}
/** Matching cofactor digests certify equal answer vectors for each domain branch. */
export interface AnswerIrrelevanceProof {
    variable: string;
    contexts: number;
    branches: {
        value: AnswerValue;
        answers_sha256: string;
    }[];
}
/** Each field is independently revision-bound; missing sources remain explicit unknowns. */
export interface ReducedAnswerFragment {
    id: string;
    revision: string | null;
    state: "retained" | "omitted" | "unavailable";
    proof_variables: string[];
    value_json: string | null;
}
/** Self-contained finite routing table plus checkable declaration and omission certificates. */
export interface AnswerReduction {
    protocol: "pm-context-answer-reduction/v1";
    basis: "declared-domains-and-fragment-dependencies;not-inferred-semantics";
    contract: AnswerReductionRequest;
    representation: "full" | "reduced";
    state: "proved" | "unknown";
    combinations: number;
    relevant_variables: string[];
    routing: {
        inputs: AnswerValue[];
        answer: string;
    }[];
    proofs: AnswerIrrelevanceProof[];
    fragments: ReducedAnswerFragment[];
    remedy: string;
}
/** Host-compatible refusals never expose source contents or private input paths. */
export declare class AnswerReductionError extends PmCliError {
    /** Machine-readable categories survive both SDK and CLI error boundaries. */
    readonly code: "INVALID_REQUEST" | "INVALID_ARGUMENT" | "INPUT_UNAVAILABLE" | "INVALID_OUTPUT" | "STALE_PACKET";
    /** Corrective action available alongside the host next_steps field. */
    readonly remedy: string;
    constructor(code: AnswerReductionError["code"], remedy: string);
}
/** Validate once before reads; preserve declared order because it defines first-match semantics. */
export declare function parseAnswerReductionRequest(value: unknown): AnswerReductionRequest;
/** Read bounded stable UTF-8 JSON with the package's existing file-reader contract. */
export declare function readAnswerReductionJson(path: string): unknown;
/** Verify shape and certificates using the producer, including every emitted numeric domain. */
export declare function parseAnswerReduction(value: unknown): AnswerReduction;
/** Read every declared field through the caller's authoritative adapter; failures stay local. */
export declare function reduceAnswerContext(input: AnswerReductionRequest, read: SharedEvidenceReader, representation?: AnswerReduction["representation"]): Promise<AnswerReduction>;
/** Compact, lossless transports share the same producer-derived validator. */
export declare function encodeAnswerReduction(packet: AnswerReduction, format: "json" | "toon"): string;
/** Recompute all proofs and reread current revisions; replay cannot bless a stale packet. */
export declare function validateAnswerReduction(saved: unknown, input: AnswerReductionRequest, read: SharedEvidenceReader): Promise<AnswerReduction>;
//# sourceMappingURL=answer-reduction.d.ts.map