/** Criterion-level packing over explicit tracker bindings; no semantic search or review. */
import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { FreshnessReader } from "./freshness.ts";
/** A top-level authoritative tracker field, including linked tests, docs or files. */
export interface EvidenceBinding {
    item: string;
    field: string;
}
/** All declared bindings must fit before a criterion has linked evidence coverage. */
export interface EvidenceCriterion {
    id: string;
    text: string;
    evidence: EvidenceBinding[];
}
/** Explicit producer-owned acceptance criteria; empty bindings disclose missing evidence. */
export interface EvidencePacket {
    criteria: EvidenceCriterion[];
}
/** Stable refusal categories with host-compatible recovery instructions. */
export declare class EvidencePackingError extends PmCliError {
    /** Safe machine-readable failure category, independent of source contents. */
    readonly code: "INVALID_PACKET" | "INVALID_ARGUMENT" | "INPUT_UNAVAILABLE" | "SOURCE_UNAVAILABLE" | "BUDGET_TOO_SMALL";
    /** Concrete action that permits retrying without editing the source tracker. */
    readonly remedy: string;
    constructor(code: EvidencePackingError["code"], remedy: string);
}
/** Per-criterion omission receipt remains present even when no evidence fits. */
export interface CriterionCoverage {
    id: string;
    text: string;
    state: "linked" | "budget_omitted" | "unlinked";
    required: number;
    packed: number;
}
/** Lossless field value encoded as JSON text so TOON and JSON share one compact schema. */
export interface PackedEvidence extends EvidenceBinding {
    criterion: string;
    value_json: string;
}
/** Complete response, including the conservative self-inclusive byte measurement. */
export interface EvidencePack {
    protocol: "pm-context-evidence/v1";
    basis: "all-declared-bindings;not-semantic-acceptance";
    ranking: "sdk-value-per-byte;criterion-id-ties";
    source_fields_read: number;
    content_reviewed: false;
    omitted_evidence: "read-for-sizing-only;artifacts-not-opened;tests-not-run";
    criteria: CriterionCoverage[];
    evidence: PackedEvidence[];
    byte_budget: number;
    /** Upper bound includes the newline and this field's own decimal digits. */
    byte_upper_bound: number;
    remedy: string;
}
/** Bound both input work and output transport; the ceiling measures UTF-8 bytes, not tokens. */
export interface EvidencePackOptions {
    byteBudget?: number;
    format?: "json" | "toon";
}
/** Validate and normalize declarations before any source read or budget selection. */
export declare function parseEvidencePacket(value: unknown): EvidencePacket;
/** Reuse bounded stable JSON input handling without exposing paths in refusals. */
export declare function readEvidencePacket(path: string): EvidencePacket;
/** Render exact compact JSON or TOON tables; nested source values stay lossless JSON strings. */
export declare function encodeEvidencePack(pack: EvidencePack, format: "json" | "toon"): string;
/** Pack complete criterion groups using SDK selection and exact serialized transport costs. */
export declare function packCriterionEvidence(input: EvidencePacket, read: FreshnessReader, options?: EvidencePackOptions): Promise<EvidencePack>;
//# sourceMappingURL=evidence-packing.d.ts.map