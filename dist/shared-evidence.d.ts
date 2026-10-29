import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { CriterionCoverage, EvidenceBinding, EvidencePacket } from "./evidence-packing.ts";
/** One closed request schema shared by both representations and the CLI. */
export interface SharedEvidenceRequest extends EvidencePacket {
    byte_budget?: number;
    format?: "json" | "toon";
    representation?: "factored" | "expanded";
}
/** Adapters supply an authoritative revision, never a content-only retry key. */
export interface RevisionedEvidence {
    revision: string;
    value: unknown;
}
/** Resolve one field at one stable revision, or reject unavailable/incomplete data. */
export type SharedEvidenceReader = (binding: EvidenceBinding) => Promise<RevisionedEvidence>;
/** A fragment identity binds its revision and exact JSON value, including whitespace. */
export interface SharedEvidenceFragment {
    id: string;
    revision: string;
    value_json: string;
}
/** Host-style id/context_ref references retain every criterion and source coordinate. */
export interface SharedEvidenceBinding extends EvidenceBinding {
    criterion: string;
    id: string;
    context_ref: string;
}
/** Expanded rows use the same fragment identities and coverage as factored rows. */
export interface ExpandedSharedEvidence extends SharedEvidenceBinding {
    revision: string;
    value_json: string;
}
/** Both representations retain the referenced registry and share whole-criterion selection. */
export interface SharedEvidencePack {
    protocol: "pm-context-shared-evidence/v1";
    representation: "factored" | "expanded";
    basis: "all-declared-bindings;not-semantic-acceptance";
    reference_scope: "packet:fragments:<id>";
    ranking: "sdk-whole-criteria;recompute-shared-cost";
    source_fields_read: number;
    content_reviewed: false;
    criteria: CriterionCoverage[];
    bindings: SharedEvidenceBinding[];
    fragments: SharedEvidenceFragment[];
    evidence: ExpandedSharedEvidence[];
    byte_budget: number;
    byte_upper_bound: number;
}
/** Safe typed refusals carry concrete remedies through the host's error contract. */
export declare class SharedEvidenceError extends PmCliError {
    /** Stable category independent of backend paths and source contents. */
    readonly code: "INVALID_REQUEST" | "SOURCE_UNAVAILABLE" | "BUDGET_TOO_SMALL" | "INVALID_OUTPUT";
    /** Recovery action also exposed as host next_steps. */
    readonly remedy: string;
    constructor(code: SharedEvidenceError["code"], remedy: string);
}
/** Validate untrusted controls and declarations once before any source read. */
export declare function parseSharedEvidenceRequest(value: unknown): Required<SharedEvidenceRequest>;
/** Read SDK item state and history twice; interleaving refuses instead of mixing revisions. */
export declare function createSharedEvidenceReader(pmRoot: string): SharedEvidenceReader;
/** Validate reference closure, emitted counters and JSON numbers before either transport. */
export declare function encodeSharedEvidence(pack: SharedEvidencePack, format: "json" | "toon"): string;
/** Factor exact revision/value pairs; preserve whole criterion groups under the byte ceiling. */
export declare function packSharedEvidence(input: SharedEvidenceRequest, read: SharedEvidenceReader): Promise<SharedEvidencePack>;
//# sourceMappingURL=shared-evidence.d.ts.map