import { buildRestoreCommand, buildSuggestedCommand } from "./suggested-command.ts";
import type { SuggestedCommand, SuggestedRestore } from "./suggested-command.ts";
/** Mandatory field contracts over cache-free SDK reads and caller-carried SDK sessions. */
import { createHash } from "node:crypto";
import { encode } from "@toon-format/toon";
import {
  PmCliError, applyReadOutputSessionReferences, attachReadOutputSessionReceipt,
  composeContextIntentContracts, createOutputOmissionReceipt, parseReadOutputSession,
  resolveContextIntentContract, resolveRuntimeFieldRegistry,
} from "@unbrained/pm-cli/sdk";
import type { OutputOmissionReceipt, PmSettings, PmReadOutputSessionReceipt, PmReadOutputSessionReference, PmReadOutputSessionState } from "@unbrained/pm-cli/sdk";
import { listGetProjectionFields, listListProjectionFields } from "@unbrained/pm-cli/sdk/query";
import { createFreshnessReader, readFreshnessJson } from "./freshness.ts";

/** Phase selection describes a projection, never authority or a lifecycle transition. */
export const TASK_PHASES = ["investigation", "implementation", "review", "handoff"] as const;
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
export class PhaseContextError extends PmCliError {
  /** Stable machine-readable reason for refusing the entire packet. */
  declare readonly code: "INVALID_REQUEST" | "INPUT_UNAVAILABLE" | "SOURCE_UNAVAILABLE" | "MISSING_FIELD" | "BUDGET_TOO_SMALL" | "INVALID_OUTPUT";
  /** Concrete retry action, also exposed through the host's next_steps. */
  readonly remedy: string;
  constructor(code: PhaseContextError["code"], remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] });
    this.remedy = remedy;
  }
}
/** A field is restorable only when the host declares a compatible selector. */
export type PhaseFieldRestoration = (SuggestedRestore & { restore_unavailable?: never }) | {
  restore_unavailable: { code: "UNSUPPORTED_FIELD_PROJECTION"; reason: string };
  restore_with?: never;
  restore_argv?: never;
};
/** Coordinates survive SDK reference suppression so every mandatory value remains resolvable. */
export type PhaseFieldBinding = PhaseFieldRestoration & {
  item: string;
  field: string;
  fact: string;
  mandatory: boolean;
}
/** Exact authoritative SDK field value; JSON strings preserve nested native collections. */
export interface PhaseFieldFact { id: string; value_json: string }
/** Field-by-field difference between two contracts from the same request. */
export interface PhaseFieldChange { field: string; change: "added" | "removed" | "retained"; reason: string }
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
  omission_receipt: Omit<OutputOmissionReceipt, "omitted_field_groups"> & { omitted_field_groups: Array<{ name: string } & PhaseFieldRestoration> };
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

/** Reject exotic objects before reading untrusted keys or serializing values. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
/** Require dense, ordinary arrays without additional keys. */
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
/** Bounded JSON domain shared by requests and emitted data, including nested native values. */
function jsonValue(value: unknown, remaining: { nodes: number }, depth = 0, counters = false, sdk = false): boolean {
  if (--remaining.nodes < 0 || depth > 20) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value) && (!counters || (Number.isSafeInteger(value) && value >= 0));
  if (dense(value)) return value.every((entry) => jsonValue(entry, remaining, depth + 1, counters, sdk));
  // SDK optional object properties may be undefined; ordinary JSON transport
  // omits those keys. Array holes/undefined elements remain invalid everywhere.
  return record(value) && Object.values(value).every((entry) => (sdk && entry === undefined) || jsonValue(entry, remaining, depth + 1, counters, sdk));
}
/** All request objects have closed key sets to prevent ignored misspellings. */
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
/** Portable identifiers are also safe selectors without shell interpolation. */
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
/** Metadata selectors are top-level field names, never paths or facet expressions. */
function field(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value); }
/** Require bounded unique lists and reject sparse entries before iteration. */
function list(value: unknown, min: number, max: number, valid: (entry: unknown) => boolean): value is string[] {
  return dense(value) && value.length >= min && value.length <= max && value.every(valid) && new Set(value).size === value.length;
}
/** Narrow an explicit phase, with no inferred task status semantics. */
function phase(value: unknown): value is TaskPhase { return TASK_PHASES.includes(value as TaskPhase); }
/** Validate untrusted input once before reading sources; never normalize tracker content. */
export function parsePhaseContextRequest(value: unknown): PhaseContextRequest {
  const fail = () => new PhaseContextError("INVALID_REQUEST", "Supply phase, 1-32 unique item ids and contracts for investigation/implementation/review/handoff (1-32 unique top-level fields each). Optional: previous_phase, include_fields (0-32), byte_budget (integer 512-262144), format (json|toon), SDK session (at most 10000 seen ids). Remove unknown keys; use dense arrays and finite numbers.");
  if (!jsonValue(value, { nodes: 20000 }) || Buffer.byteLength(JSON.stringify(value)) > 262144 || !record(value) || !keys(value, ["phase", "contracts", "items", "previous_phase", "include_fields", "byte_budget", "format", "session"]) || !phase(value.phase) || !list(value.items, 1, 32, identifier) || !record(value.contracts) || !keys(value.contracts, TASK_PHASES) || !TASK_PHASES.every((name) => list((value.contracts as Record<string, unknown>)[name], 1, 32, field))) throw fail();
  if ((Object.hasOwn(value, "previous_phase") && !phase(value.previous_phase)) || (Object.hasOwn(value, "include_fields") && !list(value.include_fields, 0, 32, field)) || (Object.hasOwn(value, "format") && value.format !== "json" && value.format !== "toon") || (Object.hasOwn(value, "byte_budget") && (!Number.isSafeInteger(value.byte_budget) || Number(value.byte_budget) < 512 || Number(value.byte_budget) > 262144))) throw fail();
  let session: PmReadOutputSessionState | undefined;
  if (Object.hasOwn(value, "session")) {
    try {
      if (!record(value.session) || !list(value.session.seen_item_ids, 0, 10000, identifier)) throw fail();
      session = parseReadOutputSession(value.session);
    } catch { throw fail(); }
  }
  const input = value as unknown as PhaseContextRequest;
  return {
    phase: input.phase, contracts: Object.fromEntries(TASK_PHASES.map((name) => [name, [...input.contracts[name]].sort()])) as Record<TaskPhase, string[]>,
    items: [...input.items].sort(),
    ...(input.previous_phase === undefined ? {} : { previous_phase: input.previous_phase }),
    include_fields: [...(input.include_fields ?? [])].sort(), byte_budget: input.byte_budget ?? 16000, format: input.format ?? "toon",
    ...(session === undefined ? {} : { session }),
  };
}
/** Read bounded regular UTF-8 JSON; the shared builder owns schema validation. */
export function readPhaseContextJson(path: string): unknown {
  try { return readFreshnessJson(path); }
  catch { throw new PhaseContextError("INPUT_UNAVAILABLE", "Supply a stable readable regular UTF-8 JSON request no larger than 262144 bytes."); }
}
/** Serialize only valid finite JSON data, preserving exact source strings and arrays. */
export function encodePhaseContext(packet: PhaseContextPacket): string {
  if (!jsonValue(packet, { nodes: 100000 }, 0, true) || !["json", "toon"].includes(packet.format) || packet.byte_budget < 512 || packet.byte_budget > 262144 || packet.bytes > 262144) throw new PhaseContextError("INVALID_OUTPUT", "Regenerate the packet from current SDK reads; output must use json|toon, nonnegative safe counters and byte_budget 512-262144.");
  return `${packet.format === "json" ? JSON.stringify(packet) : encode(packet)}\n`;
}
/** Never advertise an executable selector that the host cannot parse as one field. */
function restoreField(item: string, name: string, supported: ReadonlySet<string>): PhaseFieldRestoration {
  return supported.has(name)
    ? buildRestoreCommand(["pm", "get", item, "--fields", name, "--output-budget", "unbounded", "--json"])
    : { restore_unavailable: { code: "UNSUPPORTED_FIELD_PROJECTION", reason: "The pinned CLI has no supported single-field projection for this source key. Read it through the SDK or include it in a phase packet when the request schema accepts the key." } };
}
/** Build mandatory projections using SDK intent resolution, omission receipts and session reuse. */
export async function buildPhaseContext(input: PhaseContextRequest, pmRoot: string): Promise<PhaseContextPacket> {
  const request = parsePhaseContextRequest(input);
  const contracts = composeContextIntentContracts([], TASK_PHASES.map((name) => ({ command: "context-phase", intent: name, description: `Mandatory ${name} fields`, included_field_groups: request.contracts[name], token_budget: 65536 })));
  const mandatory = resolveContextIntentContract("context-phase", request.phase, contracts)!.included_field_groups;
  const included = new Set([...mandatory, ...request.include_fields!]);
  const previous = request.previous_phase === undefined ? [] : request.contracts[request.previous_phase];
  const packet: PhaseContextPacket = {
    ok: true, protocol: "pm-context-phase/v1", phase: request.phase, previous_phase: request.previous_phase ?? null,
    mandatory_fields: mandatory,
    changes: [...new Set([...previous, ...mandatory])].sort().map((name) => ({ field: name, change: !previous.includes(name) ? "added" : !mandatory.includes(name) ? "removed" : "retained", reason: !previous.includes(name) ? `Required by ${request.phase}` : !mandatory.includes(name) ? `Required by ${request.previous_phase}; optional in ${request.phase}` : `Required by both ${request.previous_phase} and ${request.phase}` })),
    bindings: [], facts: [], omission_receipt: { ...createOutputOmissionReceipt([]), omitted_field_groups: [] }, bytes: 0, byte_budget: request.byte_budget!, format: request.format!, session_fact_scope: "item-field-value;restore-with-bindings",
  };
  const read = createFreshnessReader(pmRoot, ".");
  let supported: Set<string>;
  try {
    const settings = await read({ kind: "settings" }) as PmSettings;
    const runtimeKeys = resolveRuntimeFieldRegistry(settings.schema).definitions.map((definition) => definition.metadata_key);
    // Row metadata selectors exclude get-only derived facets. Item aliases name
    // canonical fields, never literal raw metadata keys containing a dot.
    const metadata = new Set(listListProjectionFields(runtimeKeys));
    supported = new Set(listGetProjectionFields(runtimeKeys).filter((name) => field(name) && metadata.has(name)));
  } catch { throw new PhaseContextError("SOURCE_UNAVAILABLE", "Restore readable SDK settings before deriving executable field projections."); }
  const omitted: Array<{ name: string } & PhaseFieldRestoration> = [];
  let sourceBytes = 0;
  for (const item of request.items) {
    let source: Record<string, unknown>;
    try {
      const value = await read({ kind: "item", id: item });
      if (!record(value) || !jsonValue(value, { nodes: 100000 }, 0, false, true)) throw new Error();
      const serialized = JSON.stringify(value);
      sourceBytes += Buffer.byteLength(serialized);
      if (sourceBytes > 8388608) throw new Error();
      source = JSON.parse(serialized) as Record<string, unknown>;
    } catch { throw new PhaseContextError("SOURCE_UNAVAILABLE", `Restore readable SDK source ${item}, with finite JSON fields; narrow selection to at most 8388608 source bytes. No packet was issued.`); }
    for (const name of Object.keys(source).sort()) if (!included.has(name)) omitted.push({ name: `${item}.${name}`, ...restoreField(item, name, supported) });
    for (const name of [...included].sort()) {
      if (!Object.hasOwn(source, name)) throw new PhaseContextError("MISSING_FIELD", `Restore field ${name} on item ${item}, or revise the declared contract/include_fields. No mandatory field was dropped.`);
      const value_json = JSON.stringify(source[name]);
      // This is a read fact identity, not a mutation idempotency key. Include the
      // target coordinate so equal text on different items/fields never aliases.
      const id = `f-${createHash("sha256").update(JSON.stringify([item, name, value_json])).digest("hex")}`;
      packet.bindings.push({ item, field: name, fact: id, mandatory: mandatory.includes(name), ...restoreField(item, name, supported) });
      packet.facts.push({ id, value_json });
    }
  }
  packet.omission_receipt = { ...createOutputOmissionReceipt(omitted.map((group) => ({ name: group.name, restore_with: group.restore_with ?? "" }))), omitted_field_groups: omitted };
  let result = packet;
  if (request.session) {
    result.session_restore = buildSuggestedCommand(["pm", "get", request.items[0]!, "--depth", "brief", "--json"]);
    // The SDK owns reference construction and receipt accounting. Only facts are
    // rows: bindings and explanations must remain present even when facts reuse.
    const projected = applyReadOutputSessionReferences({ ...packet, row_contract: { command: "context-phase", row_kind: "collection", row_keys: ["facts"], fields: "unsupported" } }, request.session);
    result = { ...packet, facts: projected.facts as PhaseContextPacket["facts"] };
  }
  // Coupled fixed point: exact transport bytes include their own digits and the
  // SDK receipt; SDK accounting intentionally measures the compact JSON object.
  for (;;) {
    if (request.session) {
      const accounted = attachReadOutputSessionReceipt({ ...result }, request.session) as unknown as PhaseContextPacket & { read_session: PmReadOutputSessionReceipt };
      // The SDK's legacy display template is not executable POSIX text. Account
      // it conservatively, but emit only our structured, quoted replacement.
      const read_session = Object.fromEntries(Object.entries(accounted.read_session).filter(([key]) => key !== "restore_reference_with")) as unknown as NonNullable<PhaseContextPacket["read_session"]>;
      result = { ...accounted, read_session };
    }
    const bytes = Buffer.byteLength(encodePhaseContext(result));
    if (bytes > result.byte_budget || (result.read_session && result.read_session.spent_this_call_tokens > request.session!.token_budget - request.session!.spent_tokens)) throw new PhaseContextError("BUDGET_TOO_SMALL", "Increase byte_budget or the SDK session token budget, narrow items, or start a fresh session. Mandatory facts and complete receipts must all fit; no session state was advanced.");
    if (bytes === result.bytes) return result;
    result.bytes = bytes;
  }
}
