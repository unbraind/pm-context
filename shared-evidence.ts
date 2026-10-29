/** Revision-bound within-packet factoring over authoritative SDK field reads. */
import { createHash } from "node:crypto";
import { encode } from "@toon-format/toon";
import { getHistoryPath, PmCliError, readHistorySnapshot } from "@unbrained/pm-cli/sdk";
import { packContextCandidates } from "@unbrained/pm-cli/sdk/query";
import { createFreshnessReader } from "./freshness.ts";
import { parseEvidencePacket } from "./evidence-packing.ts";
import type { CriterionCoverage, EvidenceBinding, EvidencePacket } from "./evidence-packing.ts";

/** One closed request schema shared by both representations and the CLI. */
export interface SharedEvidenceRequest extends EvidencePacket {
  byte_budget?: number;
  format?: "json" | "toon";
  representation?: "factored" | "expanded";
}
/** Adapters supply an authoritative revision, never a content-only retry key. */
export interface RevisionedEvidence { revision: string; value: unknown }
/** Resolve one field at one stable revision, or reject unavailable/incomplete data. */
export type SharedEvidenceReader = (binding: EvidenceBinding) => Promise<RevisionedEvidence>;
/** A fragment identity binds its revision and exact JSON value, including whitespace. */
export interface SharedEvidenceFragment { id: string; revision: string; value_json: string }
/** Host-style id/context_ref references retain every criterion and source coordinate. */
export interface SharedEvidenceBinding extends EvidenceBinding { criterion: string; id: string; context_ref: string }
/** Expanded rows use the same fragment identities and coverage as factored rows. */
export interface ExpandedSharedEvidence extends SharedEvidenceBinding { revision: string; value_json: string }
/** Both representations share a single producer and whole-criterion budget selection. */
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
export class SharedEvidenceError extends PmCliError {
  /** Stable category independent of backend paths and source contents. */
  declare readonly code: "INVALID_REQUEST" | "SOURCE_UNAVAILABLE" | "BUDGET_TOO_SMALL" | "INVALID_OUTPUT";
  /** Recovery action also exposed as host next_steps. */
  readonly remedy: string;
  constructor(code: SharedEvidenceError["code"], remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] }); this.remedy = remedy;
  }
}
/** Reject exotic records; Map is used for all caller-controlled lookup identities. */
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype; }
/** Dense arrays have exactly the indexed keys that JSON will transport. */
function dense(value: unknown): value is unknown[] { return Array.isArray(value) && Object.keys(value).length === value.length && Object.keys(value).every((key, i) => key === String(i)); }
/** Bound recursion and nodes before serialization; SDK optional object fields may be absent. */
function json(value: unknown, remaining: { nodes: number }, depth = 0, sdk = false): boolean {
  if (--remaining.nodes < 0 || depth > 24) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (dense(value)) return value.every((entry) => json(entry, remaining, depth + 1, sdk));
  return record(value) && Object.values(value).every((entry) => (sdk && entry === undefined) || json(entry, remaining, depth + 1, sdk));
}
/** Validate untrusted controls and declarations once before any source read. */
export function parseSharedEvidenceRequest(value: unknown): Required<SharedEvidenceRequest> {
  const fail = () => new SharedEvidenceError("INVALID_REQUEST", "Supply criteria as for context-evidence; optional byte_budget (integer 512-262144), format (json|toon) and representation (factored|expanded). Use dense arrays and remove unknown keys.");
  if (!record(value) || !Object.keys(value).every((key) => ["criteria", "byte_budget", "format", "representation"].includes(key))) throw fail();
  if ((Object.hasOwn(value, "byte_budget") && (!Number.isSafeInteger(value.byte_budget) || Number(value.byte_budget) < 512 || Number(value.byte_budget) > 262144)) || (Object.hasOwn(value, "format") && value.format !== "json" && value.format !== "toon") || (Object.hasOwn(value, "representation") && value.representation !== "expanded" && value.representation !== "factored")) throw fail();
  let packet: EvidencePacket;
  try { packet = parseEvidencePacket({ criteria: value.criteria }); } catch { throw fail(); }
  if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw fail();
  const input = value as unknown as SharedEvidenceRequest;
  return { ...packet, byte_budget: input.byte_budget ?? 4000, format: input.format ?? "toon", representation: input.representation ?? "factored" };
}
/** SHA-256 names exact revision/value pairs without storing an external cache. */
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Read SDK item state and history twice; interleaving refuses instead of mixing revisions. */
export function createSharedEvidenceReader(pmRoot: string): SharedEvidenceReader {
  const read = createFreshnessReader(pmRoot, ".");
  return async (binding) => {
    const first = await read({ kind: "item", id: binding.item });
    if (!record(first) || typeof first.id !== "string" || !json(first, { nodes: 100000 }, 0, true)) throw new Error("Incomplete SDK source");
    const historyPath = getHistoryPath(pmRoot, first.id);
    const before = await readHistorySnapshot(historyPath, first.id);
    const second = await read({ kind: "item", id: first.id });
    const after = await readHistorySnapshot(historyPath, first.id);
    if (Buffer.byteLength(before.raw ?? "") > 8388608 || before.raw !== after.raw || JSON.stringify(first) !== JSON.stringify(second) || !Object.hasOwn(first, binding.field)) throw new Error("Changed or missing SDK source");
    return { revision: hash([first.id, before.raw, first]), value: first[binding.field] };
  };
}
/** Validate all emitted counters and JSON numbers before encoding either transport. */
export function encodeSharedEvidence(pack: SharedEvidencePack, format: "json" | "toon"): string {
  const counts = [pack.source_fields_read, pack.byte_budget, pack.byte_upper_bound, ...pack.criteria.flatMap((row) => [row.required, row.packed])];
  if (!json(pack, { nodes: 100000 }) || !counts.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 262144) || pack.byte_budget < 512 || pack.byte_upper_bound > pack.byte_budget || pack.source_fields_read > 512 || pack.criteria.some((row) => row.required > 512 || row.packed > row.required) || !["json", "toon"].includes(format)) throw new SharedEvidenceError("INVALID_OUTPUT", "Regenerate a finite bounded packet using packSharedEvidence and encode it in the same json|toon format.");
  return `${format === "json" ? JSON.stringify(pack) : encode(pack)}\n`;
}
/** Project selected groups through the same path for sizing and final output. */
function project(pack: SharedEvidencePack, selected: ReadonlySet<string>, rows: ExpandedSharedEvidence[]): SharedEvidencePack {
  const included = rows.filter((row) => selected.has(row.criterion));
  const fragments = new Map(included.map(({ id, revision, value_json }) => [id, { id, revision, value_json }]));
  return {
    ...pack,
    criteria: pack.criteria.map((row) => selected.has(row.id) ? { ...row, state: "linked", packed: row.required } : row),
    bindings: pack.representation === "factored" ? included.map(({ criterion, item, field, id, context_ref }) => ({ criterion, item, field, id, context_ref })) : [],
    fragments: pack.representation === "factored" ? [...fragments.values()].sort((a, b) => a.id < b.id ? -1 : 1) : [],
    evidence: pack.representation === "expanded" ? included : [],
  };
}
/** Factor exact revision/value pairs; preserve whole criterion groups under the byte ceiling. */
export async function packSharedEvidence(input: SharedEvidenceRequest, read: SharedEvidenceReader): Promise<SharedEvidencePack> {
  const request = parseSharedEvidenceRequest(input);
  const values = new Map<string, SharedEvidenceFragment>();
  const rows: ExpandedSharedEvidence[] = [];
  let sourceBytes = 0;
  for (const criterion of request.criteria) for (const binding of criterion.evidence) {
    const key = JSON.stringify(binding);
    if (!values.has(key)) {
      try {
        const source = await read(binding);
        if (!record(source) || Object.keys(source).some((key) => !["revision", "value"].includes(key)) || typeof source.revision !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(source.revision) || !json(source.value, { nodes: 100000 }, 0, true)) throw new Error();
        const value_json = JSON.stringify(source.value);
        sourceBytes += Buffer.byteLength(value_json);
        if (sourceBytes > 8388608) throw new Error();
        values.set(key, { id: `f-${hash([source.revision, value_json])}`, revision: source.revision, value_json });
      } catch { throw new SharedEvidenceError("SOURCE_UNAVAILABLE", "Restore stable SDK fields and authoritative revisions with finite JSON values; narrow bindings to at most 8388608 source bytes. Retry the read; no tracker state was changed."); }
    }
    const fragment = values.get(key)!;
    rows.push({ criterion: criterion.id, ...binding, ...fragment, context_ref: `packet:fragments:${fragment.id}` });
  }
  let pack: SharedEvidencePack = {
    protocol: "pm-context-shared-evidence/v1", representation: request.representation, basis: "all-declared-bindings;not-semantic-acceptance", reference_scope: "packet:fragments:<id>", ranking: "sdk-whole-criteria;recompute-shared-cost", source_fields_read: values.size, content_reviewed: false,
    criteria: request.criteria.map((row) => ({ id: row.id, text: row.text, state: row.evidence.length ? "budget_omitted" : "unlinked", required: row.evidence.length, packed: 0 })),
    bindings: [], fragments: [], evidence: [], byte_budget: request.byte_budget, byte_upper_bound: request.byte_budget,
  };
  const size = (value: SharedEvidencePack) => Buffer.byteLength(encodeSharedEvidence(value, request.format));
  if (size(pack) > pack.byte_budget) throw new SharedEvidenceError("BUDGET_TOO_SMALL", "Increase byte_budget to retain every criterion identity and the complete coverage receipt.");
  const selected = new Set<string>();
  for (;;) {
    const bytes = size(pack);
    const candidates = pack.criteria.filter((row) => row.required > 0 && !selected.has(row.id)).map((row, rank) => {
      const item = project(pack, new Set([...selected, row.id]), rows);
      const cost = Math.max(1, size(item) - bytes);
      return { id: row.id, item, rank: rank + 1, score: 1, token_costs: { identity: cost, summary: cost, full: cost } };
    });
    // Costs are exact UTF-8 bytes (integer units), not rounded token estimates.
    // Conservatively charging each candidate separately can only overcount shared
    // fragments. Recompute after each admission to reclaim that sharing.
    const next = packContextCandidates(candidates, { tokenBudget: pack.byte_budget - bytes, profile: "context" }).included[0];
    if (!next) break;
    selected.add(next.id); pack = next.item;
  }
  pack.byte_upper_bound = size(pack);
  return pack;
}
