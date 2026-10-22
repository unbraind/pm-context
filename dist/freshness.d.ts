import { PmCliError } from "@unbrained/pm-cli/sdk";
/** Hard ceilings for untrusted packet inputs and agent-sized resume output. */
export declare const FRESHNESS_LIMITS: {
    readonly input_bytes: 262144;
    readonly sections: 256;
    readonly sources: 1024;
    readonly evidence_bytes: 8388608;
};
/** A source projection; omitted fields mean the complete authoritative item/settings. */
export type FreshnessSource = {
    kind: "item";
    id: string;
    fields?: string[];
} | {
    kind: "settings";
    fields?: string[];
} | {
    kind: "evidence";
    path: string;
};
/** One assumption unit, with explicit source and transitive section dependencies. */
export interface FreshnessSection {
    id: string;
    content: string;
    sources: FreshnessSource[];
    depends_on: string[];
}
/** Producer-owned packet; content and dependency declarations are bound together. */
export interface FreshnessPacket {
    sections: FreshnessSection[];
}
/** Backend adapter: return authoritative JSON-compatible values or reject unavailable reads. */
export type FreshnessReader = (source: FreshnessSource) => Promise<unknown>;
/** Source coordinates and canonical SHA-256 digests, with no item/evidence contents. */
export interface FreshnessManifest {
    protocol: "pm-context-freshness/v1";
    packet_digest: string;
    sources: Array<{
        source: FreshnessSource;
        digest: string;
    }>;
}
/** Invalidated assumptions only; unchanged sections are represented by their count. */
export interface FreshnessResult {
    protocol: "pm-context-freshness/v1";
    packet_digest: string;
    code: "FRESH" | "STALE" | "SOURCE_UNAVAILABLE";
    reusable: boolean;
    checked_sources: number;
    unchanged_sections: number;
    invalidated_sections: number;
    unavailable_sources: number;
    invalidated: Array<{
        section: string;
        causes: string[];
    }>;
    omitted_sections: number;
    remedy: string;
}
/** Expected refusals never include underlying paths, source values or exception messages. */
export declare class FreshnessError extends PmCliError {
    /** Stable SDK and CLI refusal category. */
    readonly code: "INVALID_PACKET" | "INVALID_MANIFEST" | "INVALID_ARGUMENT" | "INPUT_UNAVAILABLE" | "SOURCE_UNAVAILABLE" | "BUDGET_TOO_SMALL";
    /** Concrete recovery action safe to expose in a public receipt. */
    readonly remedy: string;
    constructor(code: FreshnessError["code"], remedy: string);
}
/** Reject oversized, cyclic, duplicate or disconnected declarations before reading sources. */
export declare function parseFreshnessPacket(value: unknown): FreshnessPacket;
/** Capture digests at packet production time; a partial baseline is never accepted. */
export declare function recordFreshness(packet: FreshnessPacket, read: FreshnessReader): Promise<FreshnessManifest>;
/** Validate only declared assumptions; missing reads fail closed and propagate like changes. */
export declare function resumeFreshness(packet: FreshnessPacket, manifest: FreshnessManifest, read: FreshnessReader): Promise<FreshnessResult>;
/** Bound a complete JSON or compact TOON response; omission never implies safe reuse. */
export declare function encodeFreshness(result: FreshnessResult | FreshnessManifest, format: "json" | "toon", budget: number): string;
/** Read finite regular files only; reject links, devices, permissions and concurrent edits. */
export declare function readFreshnessFile(path: string, limit?: number): Buffer;
/** Decode a bounded input without exposing parser excerpts or local paths. */
export declare function readFreshnessJson(path: string): unknown;
/** Stateless authoritative SDK reads; reusing an adapter never reuses an earlier source value. */
export declare function createFreshnessReader(pmRoot: string, evidenceRoot: string): FreshnessReader;
//# sourceMappingURL=freshness.d.ts.map