/** Criterion-level packing over explicit tracker bindings; no semantic search or review. */
import { PmCliError } from "@unbrained/pm-cli/sdk";
import { packContextCandidates } from "@unbrained/pm-cli/sdk/query";
import { readFreshnessJson } from "./freshness.ts";
import type { FreshnessReader } from "./freshness.ts";

/** A top-level authoritative tracker field, including linked tests, docs or files. */
export interface EvidenceBinding { item: string; field: string }
/** All declared bindings must fit before a criterion has linked evidence coverage. */
export interface EvidenceCriterion { id: string; text: string; evidence: EvidenceBinding[] }
/** Explicit producer-owned acceptance criteria; empty bindings disclose missing evidence. */
export interface EvidencePacket { criteria: EvidenceCriterion[] }
/** Stable refusal categories with host-compatible recovery instructions. */
export class EvidencePackingError extends PmCliError {
  /** Safe machine-readable failure category, independent of source contents. */
  declare readonly code: "INVALID_PACKET" | "INVALID_ARGUMENT" | "INPUT_UNAVAILABLE" | "SOURCE_UNAVAILABLE" | "BUDGET_TOO_SMALL";
  /** Concrete action that permits retrying without editing the source tracker. */
  readonly remedy: string;
  constructor(code: EvidencePackingError["code"], remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] });
    this.remedy = remedy;
  }
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
export interface PackedEvidence extends EvidenceBinding { criterion: string; value_json: string }
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
export interface EvidencePackOptions { byteBudget?: number; format?: "json" | "toon" }
/** Treat records distinctly from arrays and null during untrusted JSON validation. */
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Coordinates are public identifiers rather than filesystem paths. */
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }
/** Refuse unknown qualifiers rather than silently changing the declared coverage contract. */
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
/** Validate and normalize declarations before any source read or budget selection. */
export function parseEvidencePacket(value: unknown): EvidencePacket {
  const fail = () => new EvidencePackingError("INVALID_PACKET", "Supply 1-128 unique criteria with id, text (1-1024 characters), and evidence bindings {item,field}; use at most 512 distinct bindings in total. Remove unknown qualifiers and duplicate bindings.");
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(value) ?? ""); } catch { throw fail(); }
  if (size > 262144 || !object(value) || !keys(value, ["criteria"]) || !Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 128) throw fail();
  const ids = new Set<string>(); let count = 0;
  for (const row of value.criteria) {
    if (!object(row) || !keys(row, ["id", "text", "evidence"]) || !identifier(row.id) || ids.has(row.id) || typeof row.text !== "string" || !row.text.trim() || row.text.length > 1024 || !Array.isArray(row.evidence)) throw fail();
    ids.add(row.id);
    const bindings = new Set<string>();
    for (const binding of row.evidence) {
      if (!object(binding) || !keys(binding, ["item", "field"]) || !identifier(binding.item) || !identifier(binding.field) || bindings.has(JSON.stringify([binding.item, binding.field]))) throw fail();
      bindings.add(JSON.stringify([binding.item, binding.field]));
      if (++count > 512) throw fail();
    }
  }
  const packet = value as unknown as EvidencePacket;
  return { criteria: packet.criteria.map((row) => ({ id: row.id, text: row.text, evidence: row.evidence.map((binding) => ({ item: binding.item, field: binding.field })).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))) })).sort((a, b) => compare(a.id, b.id)) };
}
/** Code-unit ordering avoids locale-dependent ordering of producer declarations. */
function compare(a: string, b: string): number { return Number(a > b) - Number(a < b); }
/** Reuse bounded stable JSON input handling without exposing paths in refusals. */
export function readEvidencePacket(path: string): EvidencePacket {
  let value: unknown;
  try { value = readFreshnessJson(path); } catch { throw new EvidencePackingError("INPUT_UNAVAILABLE", "Provide a stable readable regular UTF-8 JSON packet no larger than 262144 bytes."); }
  return parseEvidencePacket(value);
}
/** Render exact compact JSON or TOON tables; nested source values stay lossless JSON strings. */
export function encodeEvidencePack(pack: EvidencePack, format: "json" | "toon"): string {
  if (format === "json") return `${JSON.stringify(pack)}\n`;
  if (format !== "toon") throw new EvidencePackingError("INVALID_ARGUMENT", "Use --format json or toon.");
  const { criteria, evidence, ...summary } = pack;
  const lines = Object.entries(summary).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  for (const [name, rows, fields] of [["criteria", criteria, ["id", "text", "state", "required", "packed"]], ["evidence", evidence, ["criterion", "item", "field", "value_json"]]] as const) {
    lines.push(`${name}[${rows.length}]{${fields.join(",")}}:`);
    for (const row of rows) lines.push(`  ${fields.map((field) => JSON.stringify((row as unknown as Record<string, unknown>)[field])).join(",")}`);
  }
  return `${lines.join("\n")}\n`;
}
/** Pack complete criterion groups using SDK selection and exact serialized transport costs. */
export async function packCriterionEvidence(input: EvidencePacket, read: FreshnessReader, options: EvidencePackOptions = {}): Promise<EvidencePack> {
  const packet = parseEvidencePacket(input);
  const budget = options.byteBudget ?? 4000; const format = options.format ?? "toon";
  if (!Number.isSafeInteger(budget) || budget < 512 || budget > 262144 || !["json", "toon"].includes(format)) throw new EvidencePackingError("INVALID_ARGUMENT", "Use json or toon and an integer --byte-budget between 512 and 262144.");
  const values = new Map<string, string>();
  let sourceBytes = 0;
  const groups: Array<{ id: string; rows: PackedEvidence[] }> = [];
  for (const criterion of packet.criteria) {
    const rows: PackedEvidence[] = [];
    for (const binding of criterion.evidence) {
      const key = JSON.stringify(binding);
      if (!values.has(key)) {
        let encoded: string | undefined;
        try {
          const result = await read({ kind: "item", id: binding.item, fields: [binding.field] });
          const field = object(result) ? result[binding.field] : undefined;
          if (!object(field) || field.present !== true) throw new Error();
          encoded = JSON.stringify(field.value);
          if (encoded === undefined) throw new Error();
          sourceBytes += Buffer.byteLength(encoded);
          if (sourceBytes > 8388608) throw new Error();
        } catch { throw new EvidencePackingError("SOURCE_UNAVAILABLE", `Restore readable field ${binding.field} on item ${binding.item}, or narrow the explicit bindings to at most 8388608 source bytes. No coverage result was issued.`); }
        values.set(key, encoded);
      }
      rows.push({ criterion: criterion.id, ...binding, value_json: values.get(key)! });
    }
    if (rows.length) groups.push({ id: criterion.id, rows });
  }
  const pack: EvidencePack = {
    protocol: "pm-context-evidence/v1", basis: "all-declared-bindings;not-semantic-acceptance", ranking: "sdk-value-per-byte;criterion-id-ties",
    source_fields_read: values.size, content_reviewed: false, omitted_evidence: "read-for-sizing-only;artifacts-not-opened;tests-not-run",
    criteria: packet.criteria.map((row) => ({ id: row.id, text: row.text, state: row.evidence.length ? "budget_omitted" : "unlinked", required: row.evidence.length, packed: 0 })),
    evidence: [], byte_budget: budget, byte_upper_bound: budget,
    remedy: "Increase byte budget for budget_omitted criteria; declare evidence for unlinked criteria. Review packed evidence before judging acceptance.",
  };
  // The initial receipt uses the longest state and zero counts. Packed count
  // digits and both table-length headers are reserved separately per candidate.
  const overhead = Buffer.byteLength(encodeEvidencePack(pack, format));
  if (overhead > budget) throw new EvidencePackingError("BUDGET_TOO_SMALL", "Increase --byte-budget to retain every criterion and the complete coverage receipt.");
  const candidates = groups.map((group, index) => {
    const cost = group.rows.reduce((sum, row) => sum + Buffer.byteLength(format === "json" ? JSON.stringify(row) : `  ${[row.criterion, row.item, row.field, row.value_json].map((value) => JSON.stringify(value)).join(",")}\n`) + 1, 8);
    return { id: group.id, item: group.rows, rank: index + 1, score: 1, token_costs: { identity: cost, summary: cost, full: cost } };
  });
  if (budget > overhead) {
    const selected = packContextCandidates(candidates, { tokenBudget: budget - overhead, profile: "context" });
    const included = new Set(selected.included.map((row) => row.id));
    pack.evidence = selected.included.flatMap((row) => row.item);
    for (const criterion of pack.criteria) if (included.has(criterion.id)) { criterion.state = "linked"; criterion.packed = criterion.required; }
  }
  // Starting at the ceiling makes the self-inclusive digit count conservative.
  pack.byte_upper_bound = Buffer.byteLength(encodeEvidencePack(pack, format));
  return pack;
}
