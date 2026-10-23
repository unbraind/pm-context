/** Read-only consistency checks over producer-declared, co-current packet claims. */
import { PmCliError } from "@unbrained/pm-cli/sdk";
import { readFreshnessJson } from "./freshness.js";
/** Stable refusal codes and recovery guidance shared by SDK and CLI. */
export class WitnessError extends PmCliError {
    /** Action required before safely retrying the operation. */
    remedy;
    constructor(code, remedy) {
        super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] });
        this.remedy = remedy;
    }
}
/** Accept JSON records without treating arrays or null as declarations. */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Keep public coordinates bounded and independent of filesystem layout. */
function identifier(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }
/** Exact allowed fields prevent producers relying on silently ignored qualifiers. */
function keys(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
/** Compare exact subjects and scopes; no case folding or lexical inference is permitted. */
function sameSlot(a, b) { return a.kind === b.kind && a.subject === b.subject && a.field === b.field && a.scope === b.scope; }
/** Bound work and validate the complete schema before considering any conflict. */
export function parseWitnessPacket(value) {
    const fail = () => new WitnessError("INVALID_PACKET", "Supply at most 512 unique cited claims with exact kind, subject, field, scope and value; policy values are required/forbidden. Supersedes must name other claims in the same slot. Remove unsupported qualifiers or encode separate scopes.");
    let size;
    try {
        size = Buffer.byteLength(JSON.stringify(value) ?? "");
    }
    catch {
        throw fail();
    }
    if (size > 262144 || !object(value) || !keys(value, ["claims"]) || !Array.isArray(value.claims) || value.claims.length > 512)
        throw fail();
    const ids = new Set();
    for (const claim of value.claims) {
        if (!object(claim) || !keys(claim, ["id", "kind", "subject", "field", "scope", "value", "citation", "supersedes"])
            || !identifier(claim.id) || ids.has(claim.id) || (claim.kind !== "state" && claim.kind !== "policy")
            || !identifier(claim.subject) || !identifier(claim.field) || !identifier(claim.scope)
            || typeof claim.value !== "string" || claim.value.length === 0 || claim.value.length > 256 || /[\x00-\x1f\x7f]/.test(claim.value)
            || (claim.kind === "policy" && !["required", "forbidden"].includes(claim.value))
            || !object(claim.citation) || !keys(claim.citation, ["item", "field"]) || !identifier(claim.citation.item)
            || typeof claim.citation.field !== "string" || !/^(?:\/(?:[^~\x00-\x1f\x7f]|~[01])*)+$/.test(claim.citation.field) || claim.citation.field.length > 256
            || (claim.supersedes !== undefined && (!Array.isArray(claim.supersedes) || claim.supersedes.length > 512 || !claim.supersedes.every(identifier) || new Set(claim.supersedes).size !== claim.supersedes.length)))
            throw fail();
        ids.add(claim.id);
    }
    const packet = value;
    const byId = new Map(packet.claims.map((claim) => [claim.id, claim]));
    for (const claim of packet.claims)
        for (const target of claim.supersedes ?? []) {
            const previous = byId.get(target);
            if (!previous || previous.id === claim.id || !sameSlot(previous, claim))
                throw fail();
        }
    return { claims: packet.claims.map((claim) => ({
            id: claim.id, kind: claim.kind, subject: claim.subject, field: claim.field, scope: claim.scope, value: claim.value,
            citation: { item: claim.citation.item, field: claim.citation.field },
            ...(claim.supersedes === undefined ? {} : { supersedes: [...claim.supersedes].sort() }),
        })) };
}
/** Reuse the existing bounded UTF-8 JSON reader and expose witness-specific refusals. */
export function readWitnessPacket(path) {
    let value;
    try {
        value = readFreshnessJson(path);
    }
    catch {
        throw new WitnessError("INPUT_UNAVAILABLE", "Provide a readable regular UTF-8 JSON packet no larger than 262144 bytes.");
    }
    return parseWitnessPacket(value);
}
/** Return the globally smallest witness; all supported rules require exactly two assertions. */
export function checkContextWitnesses(input) {
    const packet = parseWitnessPacket(input);
    // Code-unit ordering is stable across process locales. Every witness has two
    // claims, so the first conflicting sorted pair is also the global minimum.
    packet.claims.sort((a, b) => a.id < b.id ? -1 : 1);
    let witness = null;
    let pairs = 0;
    for (let i = 0; i < packet.claims.length; i++)
        for (let j = i + 1; j < packet.claims.length; j++) {
            const a = packet.claims[i];
            const b = packet.claims[j];
            if (!sameSlot(a, b))
                continue;
            const superseded = a.supersedes?.includes(b.id) || b.supersedes?.includes(a.id);
            if (!superseded && a.value === b.value)
                continue;
            pairs++;
            if (!witness)
                witness = { rule: superseded ? "SUPERSEDED_CLAIM" : a.kind === "state" ? "CONFLICTING_STATE" : "EXCLUSIVE_POLICY", claims: [a, b] };
        }
    return {
        protocol: "pm-context-witness/v1", code: witness ? "CONTRADICTION" : "NO_DECLARED_CONFLICT",
        checked_claims: packet.claims.length, conflicting_pairs: pairs, basis: "declared-co-current-claims", witness,
        remedy: witness ? "Review cited assertions and explicitly correct or reselect the packet; no source was changed." : "No conflict under declared rules. Free text, omitted claims and model proposals were not checked.",
    };
}
/** Emit lossless agent-sized output; refuse rather than truncate a cited witness. */
export function encodeWitnessReport(report, format = "toon", budget = 4000) {
    if (!["json", "toon"].includes(format) || !Number.isSafeInteger(budget) || budget < 512 || budget > 262144)
        throw new WitnessError("INVALID_ARGUMENT", "Use json or toon and an integer byte budget between 512 and 262144.");
    const { witness, ...summary } = report;
    const lines = Object.entries(summary).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
    if (witness) {
        lines.push("witness:", `  rule: ${JSON.stringify(witness.rule)}`, `  claims[${witness.claims.length}]:`);
        for (const claim of witness.claims) {
            const { citation, supersedes, ...fields } = claim;
            Object.entries(fields).forEach(([key, value], index) => lines.push(`    ${index === 0 ? "- " : "  "}${key}: ${JSON.stringify(value)}`));
            lines.push("      citation:", `        item: ${JSON.stringify(citation.item)}`, `        field: ${JSON.stringify(citation.field)}`);
            if (supersedes)
                lines.push(`      supersedes[${supersedes.length}]: ${supersedes.map((id) => JSON.stringify(id)).join(",")}`);
        }
    }
    else
        lines.push("witness: null");
    const output = format === "json" ? `${JSON.stringify(report)}\n` : `${lines.join("\n")}\n`;
    if (Buffer.byteLength(output) > budget)
        throw new WitnessError("BUDGET_TOO_SMALL", "Increase byte budget to retain the complete smallest witness, or select claims with shorter coordinates.");
    return output;
}
//# sourceMappingURL=witnesses.js.map