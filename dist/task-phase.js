import { buildRestoreCommand, buildSuggestedCommand } from "./suggested-command.js";
/** Mandatory field contracts over cache-free SDK reads and caller-carried SDK sessions. */
import { createHash } from "node:crypto";
import { encode } from "@toon-format/toon";
import { PmCliError, applyReadOutputSessionReferences, attachReadOutputSessionReceipt, composeContextIntentContracts, createOutputOmissionReceipt, parseReadOutputSession, resolveContextIntentContract, } from "@unbrained/pm-cli/sdk";
import { createFreshnessReader, readFreshnessJson } from "./freshness.js";
/** Phase selection describes a projection, never authority or a lifecycle transition. */
export const TASK_PHASES = ["investigation", "implementation", "review", "handoff"];
/** Safe refusals never include backend paths, exception messages or source values. */
export class PhaseContextError extends PmCliError {
    /** Concrete retry action, also exposed through the host's next_steps. */
    remedy;
    constructor(code, remedy) {
        super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] });
        this.remedy = remedy;
    }
}
/** Reject exotic objects before reading untrusted keys or serializing values. */
function record(value) {
    return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
/** Require dense, ordinary arrays without additional keys. */
function dense(value) {
    return Array.isArray(value) && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
/** Bounded JSON domain shared by requests and emitted data, including nested native values. */
function jsonValue(value, remaining, depth = 0, counters = false, sdk = false) {
    if (--remaining.nodes < 0 || depth > 20)
        return false;
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value) && (!counters || (Number.isSafeInteger(value) && value >= 0));
    if (dense(value))
        return value.every((entry) => jsonValue(entry, remaining, depth + 1, counters, sdk));
    // SDK optional object properties may be undefined; ordinary JSON transport
    // omits those keys. Array holes/undefined elements remain invalid everywhere.
    return record(value) && Object.values(value).every((entry) => (sdk && entry === undefined) || jsonValue(entry, remaining, depth + 1, counters, sdk));
}
/** All request objects have closed key sets to prevent ignored misspellings. */
function keys(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
/** Portable identifiers are also safe selectors without shell interpolation. */
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
/** Metadata selectors are top-level field names, never paths or facet expressions. */
function field(value) { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value); }
/** Require bounded unique lists and reject sparse entries before iteration. */
function list(value, min, max, valid) {
    return dense(value) && value.length >= min && value.length <= max && value.every(valid) && new Set(value).size === value.length;
}
/** Narrow an explicit phase, with no inferred task status semantics. */
function phase(value) { return TASK_PHASES.includes(value); }
/** Validate untrusted input once before reading sources; never normalize tracker content. */
export function parsePhaseContextRequest(value) {
    const fail = () => new PhaseContextError("INVALID_REQUEST", "Supply phase, 1-32 unique item ids and contracts for investigation/implementation/review/handoff (1-32 unique top-level fields each). Optional: previous_phase, include_fields (0-32), byte_budget (integer 512-262144), format (json|toon), SDK session (at most 10000 seen ids). Remove unknown keys; use dense arrays and finite numbers.");
    if (!jsonValue(value, { nodes: 20000 }) || Buffer.byteLength(JSON.stringify(value)) > 262144 || !record(value) || !keys(value, ["phase", "contracts", "items", "previous_phase", "include_fields", "byte_budget", "format", "session"]) || !phase(value.phase) || !list(value.items, 1, 32, identifier) || !record(value.contracts) || !keys(value.contracts, TASK_PHASES) || !TASK_PHASES.every((name) => list(value.contracts[name], 1, 32, field)))
        throw fail();
    if ((Object.hasOwn(value, "previous_phase") && !phase(value.previous_phase)) || (Object.hasOwn(value, "include_fields") && !list(value.include_fields, 0, 32, field)) || (Object.hasOwn(value, "format") && value.format !== "json" && value.format !== "toon") || (Object.hasOwn(value, "byte_budget") && (!Number.isSafeInteger(value.byte_budget) || Number(value.byte_budget) < 512 || Number(value.byte_budget) > 262144)))
        throw fail();
    let session;
    if (Object.hasOwn(value, "session")) {
        try {
            if (!record(value.session) || !list(value.session.seen_item_ids, 0, 10000, identifier))
                throw fail();
            session = parseReadOutputSession(value.session);
        }
        catch {
            throw fail();
        }
    }
    const input = value;
    return {
        phase: input.phase, contracts: Object.fromEntries(TASK_PHASES.map((name) => [name, [...input.contracts[name]].sort()])),
        items: [...input.items].sort(),
        ...(input.previous_phase === undefined ? {} : { previous_phase: input.previous_phase }),
        include_fields: [...(input.include_fields ?? [])].sort(), byte_budget: input.byte_budget ?? 16000, format: input.format ?? "toon",
        ...(session === undefined ? {} : { session }),
    };
}
/** Read bounded regular UTF-8 JSON; the shared builder owns schema validation. */
export function readPhaseContextJson(path) {
    try {
        return readFreshnessJson(path);
    }
    catch {
        throw new PhaseContextError("INPUT_UNAVAILABLE", "Supply a stable readable regular UTF-8 JSON request no larger than 262144 bytes.");
    }
}
/** Serialize only valid finite JSON data, preserving exact source strings and arrays. */
export function encodePhaseContext(packet) {
    if (!jsonValue(packet, { nodes: 100000 }, 0, true) || !["json", "toon"].includes(packet.format) || packet.byte_budget < 512 || packet.byte_budget > 262144 || packet.bytes > 262144)
        throw new PhaseContextError("INVALID_OUTPUT", "Regenerate the packet from current SDK reads; output must use json|toon, nonnegative safe counters and byte_budget 512-262144.");
    return `${packet.format === "json" ? JSON.stringify(packet) : encode(packet)}\n`;
}
/** Build mandatory projections using SDK intent resolution, omission receipts and session reuse. */
export async function buildPhaseContext(input, pmRoot) {
    const request = parsePhaseContextRequest(input);
    const contracts = composeContextIntentContracts([], TASK_PHASES.map((name) => ({ command: "context-phase", intent: name, description: `Mandatory ${name} fields`, included_field_groups: request.contracts[name], token_budget: 65536 })));
    const mandatory = resolveContextIntentContract("context-phase", request.phase, contracts).included_field_groups;
    const included = new Set([...mandatory, ...request.include_fields]);
    const previous = request.previous_phase === undefined ? [] : request.contracts[request.previous_phase];
    const packet = {
        ok: true, protocol: "pm-context-phase/v1", phase: request.phase, previous_phase: request.previous_phase ?? null,
        mandatory_fields: mandatory,
        changes: [...new Set([...previous, ...mandatory])].sort().map((name) => ({ field: name, change: !previous.includes(name) ? "added" : !mandatory.includes(name) ? "removed" : "retained", reason: !previous.includes(name) ? `Required by ${request.phase}` : !mandatory.includes(name) ? `Required by ${request.previous_phase}; optional in ${request.phase}` : `Required by both ${request.previous_phase} and ${request.phase}` })),
        bindings: [], facts: [], omission_receipt: { ...createOutputOmissionReceipt([]), omitted_field_groups: [] }, bytes: 0, byte_budget: request.byte_budget, format: request.format, session_fact_scope: "item-field-value;restore-with-bindings",
    };
    const read = createFreshnessReader(pmRoot, ".");
    const omitted = [];
    let sourceBytes = 0;
    for (const item of request.items) {
        let source;
        try {
            const value = await read({ kind: "item", id: item });
            if (!record(value) || !jsonValue(value, { nodes: 100000 }, 0, false, true))
                throw new Error();
            const serialized = JSON.stringify(value);
            sourceBytes += Buffer.byteLength(serialized);
            if (sourceBytes > 8388608)
                throw new Error();
            source = JSON.parse(serialized);
        }
        catch {
            throw new PhaseContextError("SOURCE_UNAVAILABLE", `Restore readable SDK source ${item}, with finite JSON fields; narrow selection to at most 8388608 source bytes. No packet was issued.`);
        }
        for (const name of Object.keys(source).sort())
            if (!included.has(name))
                omitted.push({ name: `${item}.${name}`, ...buildRestoreCommand(["pm", "get", item, "--fields", name, "--output-budget", "unbounded"]) });
        for (const name of [...included].sort()) {
            if (!Object.hasOwn(source, name))
                throw new PhaseContextError("MISSING_FIELD", `Restore field ${name} on item ${item}, or revise the declared contract/include_fields. No mandatory field was dropped.`);
            const value_json = JSON.stringify(source[name]);
            // This is a read fact identity, not a mutation idempotency key. Include the
            // target coordinate so equal text on different items/fields never aliases.
            const id = `f-${createHash("sha256").update(JSON.stringify([item, name, value_json])).digest("hex")}`;
            packet.bindings.push({ item, field: name, fact: id, mandatory: mandatory.includes(name), ...buildRestoreCommand(["pm", "get", item, "--fields", name, "--output-budget", "unbounded"]) });
            packet.facts.push({ id, value_json });
        }
    }
    packet.omission_receipt = { ...createOutputOmissionReceipt(omitted), omitted_field_groups: omitted };
    let result = packet;
    if (request.session) {
        result.session_restore = buildSuggestedCommand(["pm", "get", "<item-id>", "--brief"]);
        // The SDK owns reference construction and receipt accounting. Only facts are
        // rows: bindings and explanations must remain present even when facts reuse.
        const projected = applyReadOutputSessionReferences({ ...packet, row_contract: { command: "context-phase", row_kind: "collection", row_keys: ["facts"], fields: "unsupported" } }, request.session);
        result = { ...packet, facts: projected.facts };
    }
    // Coupled fixed point: exact transport bytes include their own digits and the
    // SDK receipt; SDK accounting intentionally measures the compact JSON object.
    for (;;) {
        if (request.session) {
            const accounted = attachReadOutputSessionReceipt({ ...result }, request.session);
            // The SDK's legacy display template is not executable POSIX text. Account
            // it conservatively, but emit only our structured, quoted replacement.
            const read_session = Object.fromEntries(Object.entries(accounted.read_session).filter(([key]) => key !== "restore_reference_with"));
            result = { ...accounted, read_session };
        }
        const bytes = Buffer.byteLength(encodePhaseContext(result));
        if (bytes > result.byte_budget || (result.read_session && result.read_session.spent_this_call_tokens > request.session.token_budget - request.session.spent_tokens))
            throw new PhaseContextError("BUDGET_TOO_SMALL", "Increase byte_budget or the SDK session token budget, narrow items, or start a fresh session. Mandatory facts and complete receipts must all fit; no session state was advanced.");
        if (bytes === result.bytes)
            return result;
        result.bytes = bytes;
    }
}
//# sourceMappingURL=task-phase.js.map