/** Stateless acquisition planning over explicit missing evidence and declared read costs. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { encodePmTableRows } from "@unbrained/pm-cli/sdk";
import { PmCliError } from "@unbrained/pm-cli/sdk";
import { readFreshnessJson } from "./freshness.ts";

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
export class NextEvidenceError extends PmCliError {
  /** Stable error category, independent of input paths or source contents. */
  declare readonly code: "INVALID_PACKET" | "INPUT_UNAVAILABLE" | "INVALID_ARGUMENT" | "STALE_PLAN" | "INVALID_PLAN";
  /** Corrective action that leaves tracker and source data untouched. */
  readonly remedy: string;
  constructor(code: NextEvidenceError["code"], remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] });
    this.remedy = remedy;
  }
}
/** Accept plain records, excluding arrays and null. */
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Reject unknown qualifiers rather than silently dropping a producer's constraints. */
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
/** Public identifiers cannot be paths, commands or ambiguous whitespace aliases. */
function id(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }
/** Revision labels remain exact, including meaningful whitespace. */
function revision(value: unknown): value is string { return typeof value === "string" && value.length <= 256 && value.trim().length > 0; }
/** Bound cost arithmetic below Number's safe-integer ceiling. */
function integer(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum; }
/** Bound array traversal before allocation and reject holes, including inherited elements. */
function denseArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
  return true;
}
/** Strict parsing bounds exact optimization to 12 criteria and 64 reads, with no truncation. */
export function parseNextEvidencePacket(value: unknown): NextEvidencePacket {
  const fail = () => new NextEvidenceError("INVALID_PACKET", "Supply contract_revision, 0-12 unique missing IDs, 0-64 unique reads {id,source,revision,covers,estimated_tokens,estimated_tool_calls}, and tool_call_tokens (1-1000000). Arrays must be dense. Costs are integers: tokens 0-1000000, calls 0-1000, at least one positive. Covers must reference missing IDs; remove unknown qualifiers. Split larger contracts explicitly.");
  // Validate shape before serializing: JSON.stringify traverses even enormous sparse
  // arrays and invokes caller toJSON hooks. The bounded primitive fields below
  // produce a canonical packet smaller than the file reader's 262144-byte ceiling.
  if (!object(value) || !keys(value, ["contract_revision", "missing", "reads", "tool_call_tokens"]) || !revision(value.contract_revision) || !integer(value.tool_call_tokens, 1, 1000000) || !denseArray(value.missing, 12) || value.missing.some((entry) => !id(entry)) || new Set(value.missing).size !== value.missing.length || !denseArray(value.reads, 64)) throw fail();
  const missing = value.missing;
  const seen = new Set<string>(); const sources = new Map<string, string>();
  for (const row of value.reads) {
    if (!object(row) || !keys(row, ["id", "source", "revision", "covers", "estimated_tokens", "estimated_tool_calls"]) || !id(row.id) || seen.has(row.id) || !id(row.source) || !revision(row.revision) || !denseArray(row.covers, 12) || row.covers.some((entry) => !missing.includes(entry)) || new Set(row.covers).size !== row.covers.length || !integer(row.estimated_tokens, 0, 1000000) || !integer(row.estimated_tool_calls, 0, 1000) || row.estimated_tokens + row.estimated_tool_calls === 0) throw fail();
    if (sources.has(row.source) && sources.get(row.source) !== row.revision) throw fail();
    seen.add(row.id); sources.set(row.source, row.revision);
  }
  const packet = value as unknown as NextEvidencePacket;
  return { contract_revision: packet.contract_revision, missing: [...packet.missing].sort(), tool_call_tokens: packet.tool_call_tokens, reads: packet.reads.map((row) => ({ id: row.id, source: row.source, revision: row.revision, covers: [...row.covers].sort(), estimated_tokens: row.estimated_tokens + 0, estimated_tool_calls: row.estimated_tool_calls + 0 })).sort((a, b) => compare(a.id, b.id)) };
}
/** Use code-unit ordering, independent of locale. */
function compare(a: string, b: string): number { return Number(a > b) - Number(a < b); }
/** Reuse the package's bounded stable-file reader, preserving typed path-free refusals. */
export function readNextEvidenceJson(path: string): unknown {
  try { return readFreshnessJson(path); } catch { throw new NextEvidenceError("INPUT_UNAVAILABLE", "Supply a stable readable regular UTF-8 JSON file no larger than 262144 bytes."); }
}
/** Reject unrepresentable estimates and canonicalize signed zero before exposing numbers. */
function outputInteger(value: number, minimum: number, maximum: number): number {
  if (!integer(value, minimum, maximum)) throw new NextEvidenceError("INVALID_PLAN", "Regenerate the plan with finite integer estimates in the documented ranges.");
  return value + 0;
}
/** Apply numeric protocol bounds to every SDK and transport plan output without mutating it. */
function normalizePlanNumbers(plan: NextEvidencePlan): NextEvidencePlan {
  return {
    ...plan,
    reads_executed: outputInteger(plan.reads_executed, 0, 0) as 0,
    steps: plan.steps.map((step) => ({ ...step,
      estimated_tokens: outputInteger(step.estimated_tokens, 0, 1000000),
      estimated_tool_calls: outputInteger(step.estimated_tool_calls, 0, 1000),
      cost: outputInteger(step.cost, 1, 1001000000),
    })),
    estimated_tokens: outputInteger(plan.estimated_tokens, 0, 64000000),
    estimated_tool_calls: outputInteger(plan.estimated_tool_calls, 0, 64000),
    cost: outputInteger(plan.cost, 0, 64064000000),
    tool_call_tokens: outputInteger(plan.tool_call_tokens, 1, 1000000),
  };
}
/** Compute the exact minimum-cost cover, then rank its reads by newly added coverage per cost. */
export function planNextEvidence(input: unknown): NextEvidencePlan {
  const packet = parseNextEvidencePacket(input);
  const cost = (row: EvidenceRead) => row.estimated_tokens + packet.tool_call_tokens * row.estimated_tool_calls;
  const masks = packet.reads.map((row) => row.covers.reduce((mask, criterion) => mask | (1 << packet.missing.indexOf(criterion)), 0));
  const target = masks.reduce((mask, next) => mask | next, 0);
  const states = new Map<number, { cost: number; reads: number[] }>([[0, { cost: 0, reads: [] }]]);
  for (let index = 0; index < packet.reads.length; index++) {
    for (const [mask, state] of [...states]) {
      const next = mask | masks[index]!;
      if (next === mask) continue;
      const candidate = { cost: state.cost + cost(packet.reads[index]!), reads: [...state.reads, index] };
      const previous = states.get(next);
      // Ascending catalog order and first winner provide deterministic ties.
      if (!previous || candidate.cost < previous.cost) states.set(next, candidate);
    }
  }
  const selected = states.get(target)!;
  const remaining = selected.reads.map((index) => packet.reads[index]!);
  const covered = new Set<string>(); const steps: NextEvidenceStep[] = [];
  while (remaining.length) {
    remaining.sort((a, b) => b.covers.filter((entry) => !covered.has(entry)).length * cost(a) - a.covers.filter((entry) => !covered.has(entry)).length * cost(b) || compare(a.id, b.id));
    const row = remaining.shift()!; const adds = row.covers.filter((entry) => !covered.has(entry));
    adds.forEach((entry) => covered.add(entry));
    steps.push({ read: row.id, source: row.source, revision: row.revision, adds, estimated_tokens: row.estimated_tokens, estimated_tool_calls: row.estimated_tool_calls, cost: cost(row) });
  }
  const uncovered = packet.missing.filter((entry) => !covered.has(entry));
  return normalizePlanNumbers({
    protocol: "pm-context-next-evidence/v1", contract: createHash("sha256").update(JSON.stringify(packet)).digest("hex"),
    basis: "caller-declared-coverage;not-observed-evidence", optimality: "exact-minimum-cost-cover-of-coverable-criteria", ranking: "marginal-criteria-per-token-equivalent;read-id-ties", reads_executed: 0,
    missing: packet.missing, uncovered, steps, estimated_tokens: steps.reduce((sum, row) => sum + row.estimated_tokens, 0), estimated_tool_calls: steps.reduce((sum, row) => sum + row.estimated_tool_calls, 0), cost: selected.cost, tool_call_tokens: packet.tool_call_tokens,
    remedy: uncovered.length ? "Declare available reads for uncovered criteria, or retain these explicit gaps. Replan after any contract revision." : "Review the plan before separately acquiring evidence; revalidate against current caller-declared source revisions before use.",
  });
}
/** Verify both the current source contract and the complete persisted plan; never execute a read. */
export function validateNextEvidencePlan(plan: unknown, input: unknown): NextEvidencePlan {
  const current = planNextEvidence(input);
  if (!object(plan) || plan.protocol !== current.protocol || typeof plan.contract !== "string") throw new NextEvidenceError("INVALID_PLAN", "Supply an unmodified JSON plan produced by context-next-evidence.");
  if (plan.contract !== current.contract) throw new NextEvidenceError("STALE_PLAN", "Replan against the current criterion and source contracts, revisions, coverage and costs.");
  if (!isDeepStrictEqual(plan, current)) throw new NextEvidenceError("INVALID_PLAN", "Regenerate the plan; its steps, costs or coverage were modified.");
  return current;
}
/** Encode compact JSON or lossless TOON tables without source content or executable read instructions. */
export function encodeNextEvidencePlan(plan: NextEvidencePlan, format: "json" | "toon" = "toon"): string {
  plan = normalizePlanNumbers(plan);
  if (format === "json") return `${JSON.stringify(plan)}\n`;
  if (format !== "toon") throw new NextEvidenceError("INVALID_ARGUMENT", "Use --format json or toon.");
  const { steps, ...summary } = plan;
  const table = encodePmTableRows(steps.map((step) => ({ ...step })));
  const fields = ["read", "source", "revision", "adds", "estimated_tokens", "estimated_tool_calls", "cost"] as const;
  return `${Object.entries(summary).map(([key, value]) => Array.isArray(value) ? `${key}[${value.length}]: ${value.map((entry) => JSON.stringify(entry)).join(",")}` : `${key}: ${JSON.stringify(value)}`).join("\n")}\nsteps[${steps.length}]{${fields.join(",")}}:\n${table.rows.map((step) => `  ${fields.map((field) => JSON.stringify(step[field])).join(",")}\n`).join("")}steps_encoding:\n  json_columns[${table.encoding.json_columns.length}]: ${table.encoding.json_columns.map((field) => JSON.stringify(field)).join(",")}\n  absent[0]:\n`;
}
