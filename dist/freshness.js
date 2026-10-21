/** Portable assumption validation; manifests contain digests, never source snapshots. */
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { PmCliError, readSettings, locateItem, readLocatedItem, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
/** Hard ceilings for untrusted packet inputs and agent-sized resume output. */
export const FRESHNESS_LIMITS = { input_bytes: 262144, sections: 256, sources: 1024, evidence_bytes: 8388608 };
/** Expected refusals never include underlying paths, source values or exception messages. */
export class FreshnessError extends PmCliError {
    /** Concrete recovery action safe to expose in a public receipt. */
    remedy;
    constructor(code, remedy) {
        super(`${code}: ${remedy}`, 2, { code, nextSteps: [remedy] });
        this.remedy = remedy;
    }
}
/** Canonicalize object keys recursively; array order remains semantically significant. */
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object")
        return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
        throw new FreshnessError("SOURCE_UNAVAILABLE", "Read a complete JSON-compatible source and record a new manifest.");
    return encoded;
}
/** Hash values independent of property insertion order and process locale. */
function digest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
/** Require plain JSON objects at untrusted protocol boundaries. */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Restrict public coordinates to bounded, printable identifiers. */
function identifier(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }
/** Evidence paths are portable relative coordinates, never URLs or parent traversal. */
function evidencePath(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512 && !isAbsolute(value) && !/[\\:\x00-\x1f\x7f]/.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
/** Reject unknown fields so producers cannot silently rely on unvalidated semantics. */
function keys(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
/** Validate every source coordinate before any adapter or filesystem access. */
function sourceValid(value) {
    if (!object(value))
        return false;
    if (value.kind === "evidence")
        return keys(value, ["kind", "path"]) && evidencePath(value.path);
    if (value.kind !== "item" && value.kind !== "settings")
        return false;
    if (!keys(value, ["kind", ...(value.kind === "item" ? ["id"] : []), "fields"]) || (value.kind === "item" && !identifier(value.id)))
        return false;
    return value.fields === undefined || (Array.isArray(value.fields) && value.fields.length > 0 && value.fields.length <= 64 && value.fields.every(identifier) && new Set(value.fields).size === value.fields.length);
}
/** Canonical source key includes the exact field projection; no delimiter ambiguity. */
function sourceKey(source) { return canonical(source); }
/** Reject oversized, cyclic, duplicate or disconnected declarations before reading sources. */
export function parseFreshnessPacket(value) {
    const fail = () => new FreshnessError("INVALID_PACKET", "Supply 1-256 uniquely named sections with content, sources and acyclic depends_on; use item/settings fields or relative evidence paths.");
    let size;
    try {
        size = Buffer.byteLength(JSON.stringify(value) ?? "");
    }
    catch {
        throw fail();
    }
    if (size > FRESHNESS_LIMITS.input_bytes || !object(value) || !keys(value, ["sections"]) || !Array.isArray(value.sections) || value.sections.length === 0 || value.sections.length > FRESHNESS_LIMITS.sections)
        throw fail();
    const sections = value.sections;
    const ids = new Set();
    for (const section of sections) {
        if (!object(section) || !keys(section, ["id", "content", "sources", "depends_on"]) || !identifier(section.id) || ids.has(section.id) || typeof section.content !== "string" || !Array.isArray(section.sources) || !section.sources.every(sourceValid) || !Array.isArray(section.depends_on) || !section.depends_on.every(identifier) || new Set(section.depends_on).size !== section.depends_on.length || section.sources.length + section.depends_on.length === 0)
            throw fail();
        ids.add(section.id);
    }
    const packet = value;
    const done = new Set();
    const visiting = new Set();
    /** A depth-first check bounds dependency traversal by the declared section ceiling. */
    function visit(id) {
        if (done.has(id))
            return;
        if (visiting.has(id) || !ids.has(id))
            throw fail();
        visiting.add(id);
        for (const dep of packet.sections.find((section) => section.id === id).depends_on)
            visit(dep);
        visiting.delete(id);
        done.add(id);
    }
    for (const id of ids)
        visit(id);
    if (uniqueSources(packet).length > FRESHNESS_LIMITS.sources)
        throw fail();
    return packet;
}
/** Share identical source reads between sections without introducing persistent caches. */
function uniqueSources(packet) { return [...new Map(packet.sections.flatMap((section) => section.sources).map((source) => [sourceKey(source), source])).values()]; }
/** Capture digests at packet production time; a partial baseline is never accepted. */
export async function recordFreshness(packet, read) {
    parseFreshnessPacket(packet);
    const sources = [];
    for (const source of uniqueSources(packet)) {
        try {
            sources.push({ source, digest: digest(await read(source)) });
        }
        catch {
            throw new FreshnessError("SOURCE_UNAVAILABLE", "Restore source access and regenerate the packet and manifest together; no reusable baseline was recorded.");
        }
    }
    return { protocol: "pm-context-freshness/v1", packet_digest: digest(packet), sources };
}
/** Validate both manifest shape and complete correspondence with the supplied packet. */
function manifestFor(value, packet) {
    const fail = () => new FreshnessError("INVALID_MANIFEST", "Use the original packet with its complete manifest, or regenerate both; a manifest is an integrity receipt, not an authentication signature.");
    if (!object(value) || !keys(value, ["protocol", "packet_digest", "sources"]) || value.protocol !== "pm-context-freshness/v1" || value.packet_digest !== digest(packet) || !Array.isArray(value.sources) || value.sources.length > FRESHNESS_LIMITS.sources)
        throw fail();
    const expected = uniqueSources(packet).map(sourceKey).sort();
    const actual = [];
    for (const entry of value.sources) {
        if (!object(entry) || !keys(entry, ["source", "digest"]) || !sourceValid(entry.source) || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest))
            throw fail();
        actual.push(sourceKey(entry.source));
    }
    if (JSON.stringify(expected) !== JSON.stringify(actual.sort()))
        throw fail();
    return value;
}
/** Validate only declared assumptions; missing reads fail closed and propagate like changes. */
export async function resumeFreshness(packet, manifest, read) {
    parseFreshnessPacket(packet);
    const baseline = manifestFor(manifest, packet);
    const changed = new Map();
    let unavailable = 0;
    for (const entry of baseline.sources) {
        const key = sourceKey(entry.source);
        try {
            if (digest(await read(entry.source)) !== entry.digest)
                changed.set(key, `changed:${key}`);
        }
        catch {
            unavailable++;
            changed.set(key, `unavailable:${key}`);
        }
    }
    const causes = new Map();
    /** Memoize transitive causes once so shared and diamond dependencies stay deterministic. */
    function reasons(id) {
        const existing = causes.get(id);
        if (existing)
            return existing;
        const section = packet.sections.find((section) => section.id === id);
        const result = new Set(section.sources.map((source) => changed.get(sourceKey(source))).filter((cause) => cause !== undefined));
        for (const dep of section.depends_on)
            for (const cause of reasons(dep))
                result.add(cause);
        causes.set(id, result);
        return result;
    }
    const invalidated = packet.sections.map((section) => ({ section: section.id, causes: [...reasons(section.id)].sort() })).filter((row) => row.causes.length > 0);
    return {
        protocol: "pm-context-freshness/v1", packet_digest: baseline.packet_digest,
        code: unavailable > 0 ? "SOURCE_UNAVAILABLE" : invalidated.length > 0 ? "STALE" : "FRESH",
        reusable: invalidated.length === 0, checked_sources: baseline.sources.length,
        unchanged_sections: packet.sections.length - invalidated.length, invalidated_sections: invalidated.length,
        unavailable_sources: unavailable, invalidated, omitted_sections: 0,
        remedy: unavailable > 0 ? "Restore missing/unreadable sources, regenerate invalidated sections and record a new manifest. Do not reuse the packet." : invalidated.length > 0 ? "Regenerate invalidated sections and record a new manifest; retain unchanged sections." : "Reuse this packet for the declared sources at this read boundary; revalidate after later changes.",
    };
}
/** Bound a complete JSON or compact TOON response; omission never implies safe reuse. */
export function encodeFreshness(result, format, budget) {
    if (!Number.isSafeInteger(budget) || budget < 512)
        throw new FreshnessError("INVALID_ARGUMENT", "Use an integer --byte-budget of at least 512 and --format json or toon.");
    const value = structuredClone(result);
    /** TOON's quoted scalars permit lossless identifiers and Unicode without bespoke escaping. */
    function encode() {
        if (format === "json")
            return `${JSON.stringify(value)}\n`;
        // A small schema-specific TOON projection; nested protocol data remains proper TOON lists.
        const { invalidated, ...summary } = value;
        const lines = Object.entries(summary).map(([key, field]) => `${key}: ${JSON.stringify(field)}`);
        lines.push(`invalidated[${invalidated.length}]:`);
        for (const row of invalidated) {
            lines.push(`  - section: ${JSON.stringify(row.section)}`);
            lines.push(`    causes[${row.causes.length}]: ${row.causes.map((cause) => JSON.stringify(cause)).join(",")}`);
        }
        return `${lines.join("\n")}\n`;
    }
    // Manifests are always JSON artifacts: object-valued source declarations have no compact TOON projection.
    if (!("invalidated" in value) && format === "toon")
        throw new FreshnessError("INVALID_ARGUMENT", "Record manifests with --format json; resume supports both json and toon.");
    let output = encode();
    while (Buffer.byteLength(output) > budget && "invalidated" in value && value.invalidated.length > 0) {
        value.invalidated.pop();
        value.omitted_sections++;
        output = encode();
    }
    if (Buffer.byteLength(output) > budget || ("invalidated" in value && value.invalidated_sections > 0 && value.invalidated.length === 0))
        throw new FreshnessError("BUDGET_TOO_SMALL", "Increase --byte-budget to fit the complete manifest or at least one invalidated section; no state was changed.");
    return output;
}
/** Read finite regular files only; reject links, devices, permissions and concurrent edits. */
export function readFreshnessFile(path, limit = FRESHNESS_LIMITS.input_bytes) {
    try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const before = fstatSync(fd, { bigint: true });
            if (!before.isFile() || before.size > BigInt(limit) || (before.mode & 292n) === 0n)
                throw new Error();
            const bytes = Buffer.alloc(Number(before.size) + 1);
            let length = 0;
            for (;;) {
                const count = readSync(fd, bytes, length, bytes.length - length, null);
                if (count === 0)
                    break;
                length += count;
                if (length === bytes.length)
                    throw new Error();
            }
            const after = fstatSync(fd, { bigint: true });
            if (length !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
                throw new Error();
            return bytes.subarray(0, length);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        throw new FreshnessError("INPUT_UNAVAILABLE", "Use a stable, readable regular file within the input size limit.");
    }
}
/** Decode a bounded input without exposing parser excerpts or local paths. */
export function readFreshnessJson(path) {
    const bytes = readFreshnessFile(path);
    try {
        if (!isUtf8(bytes))
            throw new Error();
        return JSON.parse(bytes.toString("utf8"));
    }
    catch {
        throw new FreshnessError("INPUT_UNAVAILABLE", "Supply a valid UTF-8 JSON packet or manifest file.");
    }
}
/** Stateless authoritative SDK reads; reusing an adapter never reuses an earlier source value. */
export function createFreshnessReader(pmRoot, evidenceRoot) {
    return async (source) => {
        if (!sourceValid(source))
            throw new FreshnessError("INVALID_ARGUMENT", "Use a valid item/settings projection or relative evidence path.");
        if (source.kind === "evidence") {
            const root = realpathSync(evidenceRoot);
            const path = resolve(root, source.path);
            const parent = relative(root, realpathSync(dirname(path)));
            if (parent === ".." || parent.startsWith(`..${sep}`) || isAbsolute(parent))
                throw new Error("Outside evidence root");
            return readFreshnessFile(path, FRESHNESS_LIMITS.evidence_bytes).toString("base64");
        }
        let value;
        if (source.kind === "item") {
            readFreshnessFile(resolve(pmRoot, "settings.json"));
            const settings = await readSettings(pmRoot);
            const located = await locateItem(pmRoot, source.id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
            if (!located)
                throw new Error("Missing source");
            const bytes = readFreshnessFile(located.itemPath);
            const warnings = [];
            const { raw, document } = await readLocatedItem(located, { schema: settings.schema, warnings });
            if (raw !== bytes.toString("utf8") || warnings.length > 0)
                throw new Error("Unstable or incomplete source");
            value = { ...document.metadata, body: document.body };
        }
        else {
            // readSettings supplies defaults for missing files; absence cannot certify reuse.
            readFreshnessFile(resolve(pmRoot, "settings.json"));
            value = await readSettings(pmRoot);
        }
        if (!source.fields)
            return value;
        return Object.fromEntries(source.fields.map((field) => [field, Object.hasOwn(value, field) ? { present: true, value: value[field] } : { present: false }]));
    };
}
//# sourceMappingURL=freshness.js.map