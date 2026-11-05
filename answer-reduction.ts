/** Exhaustive answer-preserving reduction over an explicitly declared finite task. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { encode } from "@toon-format/toon";
import { PmCliError } from "@unbrained/pm-cli/sdk";
import { isUtf8 } from "node:buffer";
import { readFreshnessFile } from "./freshness.ts";
import type { SharedEvidenceReader } from "./shared-evidence.ts";

/** Saved JSON and newly produced packets share the same UTF-8 byte ceiling. */
const MAX_PACKET_BYTES = 33554432;

/** Exact JSON values; numbers are finite and bounded, with no coercion or rounding. */
export type AnswerValue = string | number | boolean | null;
/** A finite domain supplied by the task owner, not inferred from source prose. */
export interface AnswerVariable { id: string; values: AnswerValue[] }
/** Only eq and neq are evaluated; other named operations make the result unknown. */
export interface AnswerPredicate { variable: string; op: string; value: AnswerValue }
/** Ordered first-match rule; all predicates in when must hold. Empty when always matches. */
export interface AnswerRule { when: AnswerPredicate[]; answer: string }
/** The caller asserts that this field can affect the answer only through these variables. */
export interface AnswerFragment { id: string; item: string; field: string; variables: string[] }
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
  branches: { value: AnswerValue; answers_sha256: string }[];
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
  routing: { inputs: AnswerValue[]; answer: string }[];
  proofs: AnswerIrrelevanceProof[];
  fragments: ReducedAnswerFragment[];
  remedy: string;
}
/** Host-compatible refusals never expose source contents or private input paths. */
export class AnswerReductionError extends PmCliError {
  /** Machine-readable categories survive both SDK and CLI error boundaries. */
  declare readonly code: "INVALID_REQUEST" | "INVALID_ARGUMENT" | "INPUT_UNAVAILABLE" | "INVALID_OUTPUT" | "STALE_PACKET";
  /** Corrective action available alongside the host next_steps field. */
  readonly remedy: string;
  constructor(code: AnswerReductionError["code"], remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] }); this.remedy = remedy;
  }
}
/** Reject exotic objects, hidden keys and accessor/serialization hooks at the boundary. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}
/** Strict keys also reject nonenumerable additions and getters before reading them. */
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && allowed.includes(key) && "value" in descriptor && descriptor.enumerable;
  });
}
/** Dense, bounded arrays have only their own indexed data properties and length. */
function dense(value: unknown, maximum: number): value is unknown[] {
  return !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, i)).every((entry) => entry !== undefined && "value" in entry && entry.enumerable);
}
/** Coordinates are opaque identifiers; prototype-like names are safe Map keys. */
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
/** Text preserves whitespace exactly; only empty/blank declarations are refused. */
function label(value: unknown): value is string { return typeof value === "string" && value.length <= 256 && value.trim().length > 0; }
/** Scalar domains avoid arithmetic and preserve distinctions between strings and numbers. */
function scalar(value: unknown): value is AnswerValue { return value === null || typeof value === "boolean" || (typeof value === "string" && value.length <= 256) || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12); }
/** Bound arbitrary SDK JSON before serialization, including aggregate string bytes. */
function json(value: unknown, budget: { nodes: number; chars: number }, depth = 0, sdk = false): boolean {
  if (--budget.nodes < 0 || depth > 24) return false;
  if (typeof value === "string") { budget.chars -= value.length; return budget.chars >= 0; }
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (dense(value, 100000)) return value.every((entry) => json(entry, budget, depth + 1, sdk));
  return record(value) && keys(value, Object.keys(value)) && Object.entries(value).every(([key, entry]) => json(key, budget, depth + 1, sdk) && ((sdk && entry === undefined) || json(entry, budget, depth + 1, sdk)));
}
/** Validate once before reads; preserve declared order because it defines first-match semantics. */
export function parseAnswerReductionRequest(value: unknown): AnswerReductionRequest {
  const fail = () => new AnswerReductionError("INVALID_REQUEST", "Supply contract_revision, 0-8 unique variables {id,values:1-8 unique JSON scalars}, 0-64 ordered rules {when:[{variable,op,value}],answer}, fallback and 0-64 fragments {id,item,field,variables}. Use dense arrays, at most 4096 combinations and 262144 UTF-8 bytes, finite numbers within +/-1e12, text up to 256 characters, no unknown keys. Predicates must name declared variables; eq/neq values must belong to their domain.");
  if (!record(value) || !keys(value, ["contract_revision", "variables", "rules", "fallback", "fragments"]) || !label(value.contract_revision) || !label(value.fallback) || !dense(value.variables, 8) || !dense(value.rules, 64) || !dense(value.fragments, 64)) throw fail();
  const domains = new Map<string, unknown[]>(); let combinations = 1;
  for (const row of value.variables) {
    if (!record(row) || !keys(row, ["id", "values"]) || !id(row.id) || domains.has(row.id) || !dense(row.values, 8) || row.values.length === 0 || !row.values.every(scalar) || new Set(row.values).size !== row.values.length) throw fail();
    domains.set(row.id, row.values); combinations *= row.values.length;
  }
  if (combinations > 4096) throw fail();
  for (const rule of value.rules) {
    if (!record(rule) || !keys(rule, ["when", "answer"]) || !label(rule.answer) || !dense(rule.when, 8)) throw fail();
    for (const predicate of rule.when) {
      if (!record(predicate) || !keys(predicate, ["variable", "op", "value"]) || !id(predicate.variable) || !domains.has(predicate.variable) || !id(predicate.op) || !scalar(predicate.value) || (["eq", "neq"].includes(predicate.op) && !domains.get(predicate.variable)!.includes(predicate.value))) throw fail();
    }
  }
  const fragments = new Set<string>();
  for (const row of value.fragments) {
    if (!record(row) || !keys(row, ["id", "item", "field", "variables"]) || !id(row.id) || fragments.has(row.id) || !id(row.item) || !id(row.field) || !dense(row.variables, 8) || !row.variables.every((entry) => typeof entry === "string" && domains.has(entry)) || new Set(row.variables).size !== row.variables.length) throw fail();
    fragments.add(row.id);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw fail();
  return JSON.parse(JSON.stringify(value)) as AnswerReductionRequest;
}
/** Read bounded stable UTF-8 JSON with the package's existing file-reader contract. */
export function readAnswerReductionJson(path: string): unknown {
  try {
    const bytes = readFreshnessFile(path, MAX_PACKET_BYTES);
    if (!isUtf8(bytes)) throw new Error();
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch { throw new AnswerReductionError("INPUT_UNAVAILABLE", "Supply stable readable UTF-8 JSON: declarations are limited to 262144 bytes, saved output to 33554432 bytes."); }
}
/** Enumerate the full Cartesian product in declared variable/value order. */
function inputs(variables: AnswerVariable[]): AnswerValue[][] {
  return variables.reduce<AnswerValue[][]>((rows, variable) => rows.flatMap((row) => variable.values.map((value) => [...row, value])), [[]]);
}
/** Hash exact ordered answer vectors; equality decisions themselves never depend on hashes. */
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Exhaustively compare cofactors while fixing every other variable, including interactions. */
function analyze(contract: AnswerReductionRequest) {
  const combinations = inputs(contract.variables);
  const known = contract.rules.every((rule) => rule.when.every((predicate) => predicate.op === "eq" || predicate.op === "neq"));
  const proofs: AnswerIrrelevanceProof[] = [];
  const indices = new Map(contract.variables.map((variable, i) => [variable.id, i]));
  const answers = known ? combinations.map((row) => contract.rules.find((rule) => rule.when.every((predicate) => predicate.op === "eq" ? row[indices.get(predicate.variable)!] === predicate.value : row[indices.get(predicate.variable)!] !== predicate.value))?.answer ?? contract.fallback) : [];
  if (known) for (const [index, variable] of contract.variables.entries()) {
    const vectors = variable.values.map((value) => answers.filter((_, i) => combinations[i]![index] === value));
    if (vectors.every((vector) => isDeepStrictEqual(vector, vectors[0]))) proofs.push({ variable: variable.id, contexts: vectors[0]!.length, branches: variable.values.map((value, i) => ({ value, answers_sha256: hash(vectors[i]) })) });
  }
  const irrelevant = new Set(proofs.map((proof) => proof.variable));
  const relevant = contract.variables.filter((variable) => !irrelevant.has(variable.id)).map((variable) => variable.id);
  const routing = new Map<string, { inputs: AnswerValue[]; answer: string }>();
  if (known) combinations.forEach((row, i) => {
    const projected = row.filter((_, index) => !irrelevant.has(contract.variables[index]!.id));
    routing.set(JSON.stringify(projected), { inputs: projected, answer: answers[i]! });
  });
  return { known, combinations: combinations.length, relevant, routing: [...routing.values()], proofs, irrelevant };
}
/** One projection path produces packets and validates their certificates and omission decisions. */
function project(contract: AnswerReductionRequest, sources: { revision: string | null; value_json: string | null }[], representation: AnswerReduction["representation"]): AnswerReduction {
  const analysis = analyze(contract);
  const fragments = contract.fragments.map((fragment, i): ReducedAnswerFragment => {
    const source = sources[i]!;
    const omitted = source.revision !== null && analysis.known && representation === "reduced" && fragment.variables.every((id) => analysis.irrelevant.has(id));
    return { id: fragment.id, revision: source.revision, state: source.revision === null ? "unavailable" : omitted ? "omitted" : "retained", proof_variables: omitted ? fragment.variables : [], value_json: omitted ? null : source.value_json };
  });
  const known = analysis.known && fragments.every((fragment) => fragment.state !== "unavailable");
  return { protocol: "pm-context-answer-reduction/v1", basis: "declared-domains-and-fragment-dependencies;not-inferred-semantics", contract, representation, state: known ? "proved" : "unknown", combinations: analysis.combinations, relevant_variables: analysis.relevant, routing: analysis.routing, proofs: analysis.proofs, fragments, remedy: known ? "Proof applies only to declared domains and fragment dependencies. Revalidate after source or contract changes." : "Keep unknown evidence. Restore unavailable fields or replace unsupported predicates with an explicit finite eq/neq table, then regenerate." };
}
/** Verify shape and certificates using the producer, including every emitted numeric domain. */
export function parseAnswerReduction(value: unknown): AnswerReduction {
  const fail = () => new AnswerReductionError("INVALID_OUTPUT", "Regenerate using reduceAnswerContext; retain the complete contract, routing, branch proofs and revision-bound fragments. Use full or reduced representation and finite bounded JSON.");
  if (!json(value, { nodes: 100000, chars: 8388608 }) || !record(value) || !keys(value, ["protocol", "basis", "contract", "representation", "state", "combinations", "relevant_variables", "routing", "proofs", "fragments", "remedy"]) || (value.representation !== "full" && value.representation !== "reduced")) throw fail();
  let contract: AnswerReductionRequest;
  try { contract = parseAnswerReductionRequest(value.contract); } catch { throw fail(); }
  if (!dense(value.fragments, 64) || value.fragments.length !== contract.fragments.length) throw fail();
  const sources = value.fragments.map((row) => {
    if (!record(row) || !keys(row, ["id", "revision", "state", "proof_variables", "value_json"]) || !(row.revision === null || (typeof row.revision === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(row.revision)))) throw fail();
    if (row.revision === null || row.state === "omitted") { if (row.value_json !== null) throw fail(); }
    else {
      if (typeof row.value_json !== "string") throw fail();
      try { if (!json(JSON.parse(row.value_json), { nodes: 100000, chars: 8388608 })) throw fail(); } catch { throw fail(); }
    }
    return { revision: row.revision as string | null, value_json: row.value_json as string | null };
  });
  const expected = project(contract, sources, value.representation as AnswerReduction["representation"]);
  if (!isDeepStrictEqual(value, expected)) throw fail();
  return expected;
}
/** Read every declared field through the caller's authoritative adapter; failures stay local. */
export async function reduceAnswerContext(input: AnswerReductionRequest, read: SharedEvidenceReader, representation: AnswerReduction["representation"] = "reduced"): Promise<AnswerReduction> {
  const contract = parseAnswerReductionRequest(input);
  if (representation !== "full" && representation !== "reduced") throw new AnswerReductionError("INVALID_ARGUMENT", "Use full or reduced representation.");
  const sources = []; const budget = { nodes: 100000, chars: 4000000 };
  // Reserve the packet's fixed strings, including the longer unavailable remedy.
  // Accepted sources add their revision, serialized value and possible proof ids.
  const packetBudget = { nodes: 100000, chars: 8388608 };
  const baseline = project(contract, contract.fragments.map(() => ({ revision: null, value_json: null })), representation);
  if (!json(baseline, packetBudget)) throw new AnswerReductionError("INVALID_REQUEST", "Reduce domain widths, answer lengths or combinations so routing and proofs fit the 8388608 packet string/key character budget before reading evidence.");
  let bytesRemaining = MAX_PACKET_BYTES - Buffer.byteLength(JSON.stringify(baseline)) - 1;
  if (bytesRemaining < 0) throw new AnswerReductionError("INVALID_REQUEST", "Reduce escaped domain widths, answer lengths or combinations so routing and proofs fit the 33554432 UTF-8 JSON byte budget before reading evidence.");
  for (const fragment of contract.fragments) {
    try {
      const source = await read({ item: fragment.item, field: fragment.field });
      const remaining = { ...budget };
      if (!record(source) || !keys(source, ["revision", "value"]) || typeof source.revision !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(source.revision) || !json(source.value, remaining, 0, true)) throw new Error();
      const value_json = JSON.stringify(source.value);
      const chars = value_json.length + source.revision.length + fragment.variables.reduce((sum, variable) => sum + variable.length, 0);
      if (chars > packetBudget.chars) throw new Error();
      const bytes = Buffer.byteLength(JSON.stringify({ revision: source.revision, value_json, proof_variables: fragment.variables }));
      if (bytes > bytesRemaining) throw new Error();
      bytesRemaining -= bytes;
      packetBudget.chars -= chars;
      Object.assign(budget, remaining);
      sources.push({ revision: source.revision, value_json });
    } catch { sources.push({ revision: null, value_json: null }); }
  }
  return parseAnswerReduction(project(contract, sources, representation));
}
/** Compact, lossless transports share the same producer-derived validator. */
export function encodeAnswerReduction(packet: AnswerReduction, format: "json" | "toon"): string {
  if (format !== "json" && format !== "toon") throw new AnswerReductionError("INVALID_ARGUMENT", "Use --format json or toon.");
  const checked = parseAnswerReduction(packet);
  return `${format === "json" ? JSON.stringify(checked) : encode(checked)}\n`;
}
/** Recompute all proofs and reread current revisions; replay cannot bless a stale packet. */
export async function validateAnswerReduction(saved: unknown, input: AnswerReductionRequest, read: SharedEvidenceReader): Promise<AnswerReduction> {
  const packet = parseAnswerReduction(saved);
  const current = await reduceAnswerContext(input, read, packet.representation);
  if (!isDeepStrictEqual(packet, current)) throw new AnswerReductionError("STALE_PACKET", "Regenerate against current SDK revisions and the current decision contract; saved content alone is not a revision key.");
  return current;
}
