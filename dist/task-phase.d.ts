import type { SuggestedCommand, SuggestedRestore } from "./suggested-command.ts";
import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { OutputOmissionReceipt, PmReadOutputSessionReceipt, PmReadOutputSessionReference, PmReadOutputSessionState } from "@unbrained/pm-cli/sdk";
/** Phase selection describes a projection, never authority or a lifecycle transition. */
export declare const TASK_PHASES: readonly ["investigation", "implementation", "review", "handoff"];
/** The four independently declared context requirements. */
export type TaskPhase = typeof TASK_PHASES[number];
/** One strict request schema shared by the SDK and CLI, including transport controls. */
export interface PhaseContextRequest {
    phase: TaskPhase;
    contracts: Record<TaskPhase, string[]>;
    items: string[];
    previous_phase?: TaskPhase;
    include_fields?: string[];
    byte_budget?: number;
    format?: "json" | "toon";
    session?: PmReadOutputSessionState;
}
/** Safe refusals never include backend paths, exception messages or source values. */
export declare class PhaseContextError extends PmCliError {
    /** Stable machine-readable reason for refusing the entire packet. */
    readonly code: "INVALID_REQUEST" | "INPUT_UNAVAILABLE" | "SOURCE_UNAVAILABLE" | "MISSING_FIELD" | "BUDGET_TOO_SMALL" | "INVALID_OUTPUT";
    /** Concrete retry action, also exposed through the host's next_steps. */
    readonly remedy: string;
    constructor(code: PhaseContextError["code"], remedy: string);
}
/** A field is restorable only when the host declares a compatible selector. */
export type PhaseFieldRestoration = (SuggestedRestore & {
    restore_unavailable?: never;
}) | {
    restore_unavailable: {
        code: "UNSUPPORTED_FIELD_PROJECTION";
        reason: string;
    };
    restore_with?: never;
    restore_argv?: never;
};
/** Coordinates survive SDK reference suppression so every mandatory value remains resolvable. */
export type PhaseFieldBinding = PhaseFieldRestoration & {
    item: string;
    field: string;
    fact: string;
    mandatory: boolean;
};
/** Exact authoritative SDK field value; JSON strings preserve nested native collections. */
export interface PhaseFieldFact {
    id: string;
    value_json: string;
}
/** Field-by-field difference between two contracts from the same request. */
export interface PhaseFieldChange {
    field: string;
    change: "added" | "removed" | "retained";
    reason: string;
}
/** Complete bounded packet; refusal is the only degradation when mandatory facts cannot fit. */
export interface PhaseContextPacket {
    ok: true;
    protocol: "pm-context-phase/v1";
    phase: TaskPhase;
    previous_phase: TaskPhase | null;
    mandatory_fields: string[];
    changes: PhaseFieldChange[];
    bindings: PhaseFieldBinding[];
    facts: Array<PhaseFieldFact | PmReadOutputSessionReference>;
    omission_receipt: Omit<OutputOmissionReceipt, "omitted_field_groups"> & {
        omitted_field_groups: Array<{
            name: string;
        } & PhaseFieldRestoration>;
    };
    /** Exact complete encoded size including the trailing newline and this counter. */
    bytes: number;
    byte_budget: number;
    format: "json" | "toon";
    /** SDK session ids name field facts; bindings carry their native item restore commands. */
    session_fact_scope: "item-field-value;restore-with-bindings";
    /** SDK-owned charging conservatively includes its removed legacy restore template. */
    read_session?: Omit<PmReadOutputSessionReceipt, "restore_reference_with">;
    /** Concrete item refresh; field restorations are carried by bindings. */
    session_restore?: SuggestedCommand;
}
/** Validate untrusted input once before reading sources; never normalize tracker content. */
export declare function parsePhaseContextRequest(value: unknown): PhaseContextRequest;
/** Read bounded regular UTF-8 JSON; the shared builder owns schema validation. */
export declare function readPhaseContextJson(path: string): unknown;
/** Serialize only valid finite JSON data, preserving exact source strings and arrays. */
export declare function encodePhaseContext(packet: PhaseContextPacket): string;
/** Build mandatory projections using SDK intent resolution, omission receipts and session reuse. */
export declare function buildPhaseContext(input: PhaseContextRequest, pmRoot: string): Promise<PhaseContextPacket>;
//# sourceMappingURL=task-phase.d.ts.map