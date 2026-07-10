import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const defineExtension = ((extension) => extension);
export const EXIT_CODE = {
    GENERIC_FAILURE: 1,
    USAGE: 2,
};
export class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
export const MAX_NEIGHBORHOOD_DEPTH = 5;
export const MARKDOWN_SECTIONS = ["summary", "focus", "neighborhood", "neighbors", "links", "deps"];
export const AGENT_SECTIONS = ["focus", "blockers", "next-actions", "actions", "nextactions", "recent", "activity", "links", "deps", "refresh"];
function asArray(value) {
    if (Array.isArray(value))
        return value.flatMap(asArray);
    if (typeof value !== "string")
        return [];
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function boolOption(options, ...keys) {
    return keys.some((key) => {
        const value = options[key];
        return value === true || value === "true" || value === "1";
    });
}
function stringOption(options, ...keys) {
    for (const key of keys) {
        const value = options[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
function intOption(options, key, fallback) {
    const raw = options[key];
    if (raw === undefined || raw === null || raw === "")
        return fallback;
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        throw new CommandError(`--${key} must be a positive integer`, EXIT_CODE.USAGE);
    }
    return parsed;
}
export function validateSections(format, values) {
    const sections = Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)));
    if (sections.length === 0)
        return sections;
    if (format === "json") {
        throw new CommandError("--section is only supported with markdown, agent, or compact output", EXIT_CODE.USAGE);
    }
    const allowed = new Set(format === "markdown" ? MARKDOWN_SECTIONS : AGENT_SECTIONS);
    const unsupported = sections.filter((section) => !allowed.has(section));
    if (unsupported.length > 0) {
        throw new CommandError(`--section ${unsupported.map((section) => `'${section}'`).join(", ")} is not available in ${format} output; valid sections: ${[...allowed].join(", ")}`, EXIT_CODE.USAGE);
    }
    return sections;
}
function intOptionMin0(options, keys, fallback) {
    for (const key of keys) {
        const raw = options[key];
        if (raw === undefined || raw === null || raw === "")
            continue;
        const parsed = Number.parseInt(String(raw), 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            throw new CommandError(`--${keys[0]} must be a non-negative integer`, EXIT_CODE.USAGE);
        }
        return parsed;
    }
    return fallback;
}
function shellQuote(value) {
    if (/^[A-Za-z0-9._/:=,-]+$/.test(value))
        return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
}
export function resolveSelectionOptions(options, defaults = {}) {
    const ids = Array.from(new Set([...asArray(options.id), ...asArray(options.ids)]));
    const status = stringOption(options, "status", "state");
    const type = stringOption(options, "type", "kind");
    const tag = stringOption(options, "tag");
    const hasExplicitSelector = ids.length > 0 || Boolean(status) || Boolean(type) || Boolean(tag);
    if (hasExplicitSelector || !defaults.fallbackStatus) {
        return { ids, status, type, tag, inferredStatus: false };
    }
    return { ids, status: defaults.fallbackStatus, type, tag, inferredStatus: true };
}
function idSelectorArgs(ids) {
    const normalizedIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (normalizedIds.length === 0)
        return [];
    if (normalizedIds.length === 1)
        return ["--id", shellQuote(normalizedIds[0])];
    return ["--ids", shellQuote(normalizedIds.join(","))];
}
export function buildSuggestedAgentCommand(input) {
    const args = ["pm", input.commandName];
    if (input.selection.ids.length > 0) {
        args.push(...idSelectorArgs(input.selection.ids));
    }
    else {
        if (input.selection.status)
            args.push("--status", shellQuote(input.selection.status));
        if (input.selection.type)
            args.push("--type", shellQuote(input.selection.type));
        if (input.selection.tag)
            args.push("--tag", shellQuote(input.selection.tag));
    }
    if (input.includeFormatFlag)
        args.push("--format", "agent");
    if (input.limit !== input.defaultLimit)
        args.push("--limit", String(input.limit));
    if (input.recentLimit !== input.defaultRecentLimit)
        args.push("--recent", String(input.recentLimit));
    if (input.includeClosed)
        args.push("--include-closed");
    if (input.includeDeps)
        args.push("--include-deps");
    if (input.compress)
        args.push("--compress");
    if (typeof input.maxItems === "number" && input.maxItems > 0)
        args.push("--max-items", String(input.maxItems));
    if (input.sections && input.sections.length > 0) {
        for (const section of input.sections)
            args.push("--section", shellQuote(section));
    }
    if (!input.neighborhood) {
        args.push("--without-neighborhood");
    }
    else if (input.neighborhoodDepth !== 1) {
        args.push("--neighborhood-depth", String(input.neighborhoodDepth));
    }
    return args.join(" ");
}
function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeTags(value) {
    return asArray(value).map((tag) => tag.toLowerCase());
}
function itemStatus(item) {
    return normalizeText(item.status) || "unknown";
}
function itemType(item) {
    return normalizeText(item.type) || "Item";
}
function isClosedStatus(status) {
    const normalized = status.toLowerCase();
    return normalized === "closed" || normalized === "done" || normalized === "canceled" || normalized === "cancelled";
}
function itemUpdatedAt(item) {
    return normalizeText(item.updated_at) || normalizeText(item.created_at);
}
export function sortContextItems(items) {
    return [...items].sort((a, b) => {
        const priorityA = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
        const priorityB = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
        if (priorityA !== priorityB)
            return priorityA - priorityB;
        return itemUpdatedAt(b).localeCompare(itemUpdatedAt(a)) || a.id.localeCompare(b.id);
    });
}
function parseRelationshipValue(value, fallbackKind) {
    if (!value)
        return [];
    if (typeof value === "string") {
        return asArray(value).map((to) => ({ to, kind: fallbackKind }));
    }
    if (Array.isArray(value)) {
        return value.flatMap((entry) => parseRelationshipValue(entry, fallbackKind));
    }
    if (typeof value === "object") {
        const record = value;
        const to = normalizeText(record.id) || normalizeText(record.to) || normalizeText(record.target) ||
            normalizeText(record.target_id) || normalizeText(record.item) || normalizeText(record.item_id);
        if (!to)
            return [];
        const kind = normalizeText(record.kind) || normalizeText(record.type) || fallbackKind;
        return [{ to, kind }];
    }
    return [];
}
export function extractRelationships(item) {
    const rels = [
        ...parseRelationshipValue(item.deps, "depends_on"),
        ...parseRelationshipValue(item.dependencies, "depends_on"),
        ...parseRelationshipValue(item.blocked_by, "blocked_by"),
        ...parseRelationshipValue(item.blockedBy, "blocked_by"),
    ];
    const seen = new Set();
    return rels
        .filter((rel) => rel.to && rel.to !== item.id)
        .map((rel) => ({ from: item.id, to: rel.to, kind: rel.kind }))
        .filter((rel) => {
        const key = `${rel.from}\0${rel.kind}\0${rel.to}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function extractLinkValues(value) {
    if (!value)
        return [];
    if (typeof value === "string")
        return asArray(value);
    if (Array.isArray(value))
        return value.flatMap(extractLinkValues);
    if (typeof value === "object") {
        const record = value;
        return [
            normalizeText(record.path),
            normalizeText(record.url),
            normalizeText(record.href),
            normalizeText(record.file),
            normalizeText(record.doc),
            normalizeText(record.value),
        ].filter(Boolean);
    }
    return [];
}
function buildLinks(items) {
    const links = [];
    for (const item of items) {
        for (const value of extractLinkValues(item.docs))
            links.push({ itemId: item.id, kind: "doc", value });
        for (const value of extractLinkValues(item.files))
            links.push({ itemId: item.id, kind: "file", value });
    }
    return links;
}
function matchesFilters(item, options) {
    if (!options.includeClosed && isClosedStatus(itemStatus(item)))
        return false;
    if (options.status && itemStatus(item).toLowerCase() !== options.status.toLowerCase())
        return false;
    if (options.type && itemType(item).toLowerCase() !== options.type.toLowerCase())
        return false;
    if (options.tag && !normalizeTags(item.tags).includes(options.tag.toLowerCase()))
        return false;
    return true;
}
export function buildContextPack(allItems, options = {}) {
    const ids = Array.from(new Set((options.ids ?? []).map((id) => id.trim()).filter(Boolean)));
    const byId = new Map(allItems.map((item) => [item.id, item]));
    const allRelationships = allItems.flatMap(extractRelationships);
    const selected = ids.length > 0
        ? ids.map((id) => byId.get(id)).filter((item) => Boolean(item))
        : allItems.filter((item) => matchesFilters(item, options));
    const limited = sortContextItems(selected).slice(0, options.limit ?? 25);
    const selectedIds = new Set(limited.map((item) => item.id));
    // Resolve the neighborhood depth. --without-neighborhood (neighborhood === false)
    // forces depth 0. Otherwise default to 1 hop, capped at MAX_NEIGHBORHOOD_DEPTH.
    let depth = options.neighborhoodDepth ?? 1;
    if (options.neighborhood === false)
        depth = 0;
    if (depth < 0)
        depth = 0;
    if (depth > MAX_NEIGHBORHOOD_DEPTH)
        depth = MAX_NEIGHBORHOOD_DEPTH;
    // BFS over the (bidirectional) dependency relationship graph starting from the
    // focus items. Each hop expands the frontier by one degree of separation. The
    // visited set is seeded with focus ids so a focus item is never a neighbor.
    const neighborIds = new Set();
    const neighborDepths = new Map();
    const visited = new Set(selectedIds);
    let frontier = new Set(selectedIds);
    for (let hop = 0; hop < depth && frontier.size > 0; hop += 1) {
        const next = new Set();
        for (const rel of allRelationships) {
            if (frontier.has(rel.from) && !visited.has(rel.to))
                next.add(rel.to);
            if (frontier.has(rel.to) && !visited.has(rel.from))
                next.add(rel.from);
        }
        for (const id of next) {
            visited.add(id);
            neighborIds.add(id);
            neighborDepths.set(id, hop + 1);
        }
        frontier = next;
    }
    for (const id of selectedIds)
        neighborIds.delete(id);
    let neighbors = sortContextItems([...neighborIds].map((id) => byId.get(id)).filter((item) => Boolean(item)))
        .sort((a, b) => (neighborDepths.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (neighborDepths.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    // --max-items caps the total item count (focus + neighbors). Focus items take
    // priority; neighbors are trimmed to fit the remaining budget. If focus
    // alone exceeds the cap, focus is also trimmed.
    let focusItems = limited;
    if (typeof options.maxItems === "number" && options.maxItems > 0) {
        if (focusItems.length >= options.maxItems) {
            focusItems = focusItems.slice(0, options.maxItems);
            neighbors = [];
        }
        else {
            neighbors = neighbors.slice(0, options.maxItems - focusItems.length);
        }
    }
    const focusIdsFinal = new Set(focusItems.map((item) => item.id));
    const packItems = focusItems.map((item) => options.includeBody ? item : { ...item, body: undefined, description: undefined });
    const packNeighbors = neighbors.map((item) => options.includeBody ? item : { ...item, body: undefined, description: undefined });
    const selectedAndNeighbors = [...packItems, ...packNeighbors];
    const byStatus = {};
    const byType = {};
    for (const item of packItems) {
        byStatus[itemStatus(item)] = (byStatus[itemStatus(item)] ?? 0) + 1;
        byType[itemType(item)] = (byType[itemType(item)] ?? 0) + 1;
    }
    // --include-deps adds per-item dependency info (depends-on and depended-by)
    // for every visible item in the pack.
    let deps;
    if (options.includeDeps) {
        const visibleIds = [...packItems, ...packNeighbors].map((item) => item.id);
        const dependsOn = new Map();
        const dependedBy = new Map();
        for (const rel of allRelationships) {
            const outgoing = dependsOn.get(rel.from) ?? new Set();
            outgoing.add(rel.to);
            dependsOn.set(rel.from, outgoing);
            const incoming = dependedBy.get(rel.to) ?? new Set();
            incoming.add(rel.from);
            dependedBy.set(rel.to, incoming);
        }
        deps = visibleIds
            .map((itemId) => ({
            itemId,
            dependsOn: [...(dependsOn.get(itemId) ?? [])],
            dependedBy: [...(dependedBy.get(itemId) ?? [])],
        }))
            .filter((dep) => dep.dependsOn.length > 0 || dep.dependedBy.length > 0);
    }
    return {
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        filters: {
            ids,
            status: options.status,
            type: options.type,
            tag: options.tag,
            includeClosed: options.includeClosed === true,
            neighborhood: depth > 0,
            includeDeps: options.includeDeps === true,
            maxItems: options.maxItems,
        },
        summary: {
            totalItems: allItems.length,
            selectedItems: packItems.length,
            neighborItems: packNeighbors.length,
            byStatus,
            byType,
        },
        items: packItems,
        neighbors: packNeighbors,
        links: buildLinks(selectedAndNeighbors),
        relationships: allRelationships.filter((rel) => focusIdsFinal.has(rel.from) || focusIdsFinal.has(rel.to)),
        deps,
    };
}
function markdownEscape(value) {
    return String(value ?? "").replace(/\r?\n/g, " ").trim();
}
function renderItemList(items, includeBody) {
    if (items.length === 0)
        return ["_None._"];
    const lines = [];
    for (const item of items) {
        const meta = [
            itemType(item),
            itemStatus(item),
            typeof item.priority === "number" ? `p${item.priority}` : "",
            item.assignee ? `@${item.assignee}` : "",
            item.deadline ? `due ${item.deadline}` : "",
        ].filter(Boolean).join(" | ");
        lines.push(`- **${item.id}** ${markdownEscape(item.title || "(untitled)")} (${meta})`);
        const tags = normalizeTags(item.tags);
        if (tags.length > 0)
            lines.push(`  - tags: ${tags.join(", ")}`);
        if (includeBody) {
            const body = normalizeText(item.body) || normalizeText(item.description);
            if (body)
                lines.push(`  - context: ${markdownEscape(body).slice(0, 700)}`);
        }
    }
    return lines;
}
export function renderMarkdown(pack, options = {}) {
    const sectionFilter = options.sections?.map((s) => s.toLowerCase());
    const compress = options.compress === true;
    const include = (name) => !sectionFilter || sectionFilter.includes(name);
    const lines = [
        "# pm context pack",
        "",
        `Generated: ${pack.generatedAt}`,
    ];
    if (include("summary")) {
        lines.push("", "## Summary", "");
        lines.push(`- Total workspace items: ${pack.summary.totalItems}`);
        lines.push(`- Focus items: ${pack.summary.selectedItems}`);
        lines.push(`- Neighbor items: ${pack.summary.neighborItems}`);
        lines.push(`- Statuses: ${Object.entries(pack.summary.byStatus).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
        lines.push(`- Types: ${Object.entries(pack.summary.byType).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
    }
    if (include("focus")) {
        lines.push("", "## Focus Items", "");
        lines.push(...renderItemList(pack.items, pack.items.some((item) => Boolean(item.body || item.description))));
    }
    if (include("neighborhood")) {
        lines.push("", "## Dependency Neighborhood", "");
        if (pack.relationships.length === 0) {
            lines.push("_No dependency relationships in focus._");
        }
        else {
            for (const rel of pack.relationships)
                lines.push(`- ${rel.from} --${rel.kind}--> ${rel.to}`);
        }
    }
    if (include("neighbors")) {
        lines.push("", "## Neighbor Items", "");
        lines.push(...renderItemList(pack.neighbors, false));
    }
    if (include("links")) {
        lines.push("", "## Linked Context", "");
        if (pack.links.length === 0) {
            lines.push("_No docs or files linked in selected context._");
        }
        else {
            for (const link of pack.links)
                lines.push(`- ${link.itemId} ${link.kind}: ${link.value}`);
        }
    }
    if (include("deps") && pack.deps) {
        lines.push("", "## Dependencies", "");
        if (pack.deps.length === 0) {
            lines.push("_No dependency relationships found._");
        }
        else {
            for (const dep of pack.deps) {
                lines.push(`- ${dep.itemId}: depends_on [${dep.dependsOn.join(", ")}] | depended_by [${dep.dependedBy.join(", ")}]`);
            }
        }
    }
    lines.push("");
    let output = `${lines.join("\n")}\n`;
    if (compress) {
        output = `${output.split("\n").filter((line) => line.trim() !== "").join("\n")}\n`;
    }
    return output;
}
function titleFor(items, id) {
    return items.find((item) => item.id === id)?.title;
}
function statusFor(items, id) {
    return items.find((item) => item.id === id)?.status;
}
function updatedTimestamp(item) {
    const raw = normalizeText(item.updated_at) || normalizeText(item.created_at);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}
export function buildAgentHandoff(pack, options = {}) {
    const allVisible = [...pack.items, ...pack.neighbors];
    const focusIds = new Set(pack.items.map((item) => item.id));
    const blockers = pack.relationships
        .filter((rel) => focusIds.has(rel.from) && (rel.kind === "blocked_by" || rel.kind === "depends_on"))
        .map((rel) => ({
        itemId: rel.from,
        blockedBy: rel.to,
        kind: rel.kind,
        title: titleFor(allVisible, rel.to),
        status: statusFor(allVisible, rel.to),
    }));
    const blockedFocusIds = new Set(blockers.map((blocker) => blocker.itemId));
    const nextActions = pack.items
        .filter((item) => !isClosedStatus(itemStatus(item)))
        .slice(0, 8)
        .map((item) => ({
        id: item.id,
        title: normalizeText(item.title) || "(untitled)",
        reason: blockedFocusIds.has(item.id)
            ? "resolve blocker first"
            : typeof item.priority === "number"
                ? `priority ${item.priority}`
                : "selected focus item",
    }));
    const ids = pack.items.map((item) => item.id).join(",");
    const suggestedCommand = normalizeText(options.suggestedCommand) || (ids
        ? `pm context-pack --id ${ids} --format agent`
        : "pm context-pack --status in_progress --format agent");
    const recentLimit = options.recentLimit ?? 5;
    const recent = [...allVisible]
        .filter((item) => !isClosedStatus(itemStatus(item)))
        .sort((a, b) => updatedTimestamp(b) - updatedTimestamp(a) || a.id.localeCompare(b.id))
        .slice(0, recentLimit)
        .map((item) => ({
        id: item.id,
        title: normalizeText(item.title) || "(untitled)",
        status: itemStatus(item),
        updatedAt: normalizeText(item.updated_at) || normalizeText(item.created_at) || undefined,
    }));
    return {
        generatedAt: pack.generatedAt,
        counts: {
            focus: pack.summary.selectedItems,
            neighbors: pack.summary.neighborItems,
            blockers: blockers.length,
            links: pack.links.length,
            recent: recent.length,
            deps: pack.deps?.length ?? 0,
        },
        focus: pack.items.map((item) => ({
            id: item.id,
            title: normalizeText(item.title) || "(untitled)",
            status: itemStatus(item),
            type: itemType(item),
            priority: typeof item.priority === "number" ? item.priority : undefined,
            deadline: normalizeText(item.deadline) || undefined,
        })),
        blockers,
        nextActions,
        recent,
        links: pack.links.slice(0, 12),
        deps: pack.deps,
        suggestedCommand,
    };
}
export function renderAgentHandoff(pack, options = {}) {
    const handoff = buildAgentHandoff(pack, options);
    const sectionFilter = options.sections?.map((s) => s.toLowerCase());
    const compress = options.compress === true;
    const include = (name, aliases = []) => !sectionFilter || sectionFilter.includes(name) || aliases.some((a) => sectionFilter.includes(a));
    const lines = [
        "# pm agent handoff",
        "",
        `Generated: ${handoff.generatedAt}`,
        `Focus: ${handoff.counts.focus} | Neighbors: ${handoff.counts.neighbors} | Blockers: ${handoff.counts.blockers} | Links: ${handoff.counts.links} | Recent: ${handoff.counts.recent}${handoff.counts.deps > 0 ? ` | Deps: ${handoff.counts.deps}` : ""}`,
    ];
    if (include("focus")) {
        lines.push("", "## Focus", "");
        if (handoff.focus.length === 0) {
            lines.push("_No focus items._");
        }
        else {
            for (const item of handoff.focus) {
                const meta = [
                    item.type,
                    item.status,
                    item.priority === undefined ? "" : `p${item.priority}`,
                    item.deadline ? `due ${item.deadline}` : "",
                ].filter(Boolean).join(" | ");
                lines.push(`- ${item.id}: ${markdownEscape(item.title)} (${meta})`);
            }
        }
    }
    if (include("blockers")) {
        lines.push("", "## Blockers", "");
        if (handoff.blockers.length === 0) {
            lines.push("_No visible blockers._");
        }
        else {
            for (const blocker of handoff.blockers) {
                const label = blocker.title ? `${blocker.blockedBy} ${markdownEscape(blocker.title)}` : blocker.blockedBy;
                const status = blocker.status ? ` (${blocker.status})` : "";
                lines.push(`- ${blocker.itemId} ${blocker.kind} ${label}${status}`);
            }
        }
    }
    if (include("next-actions", ["actions", "nextactions"])) {
        lines.push("", "## Next Actions", "");
        if (handoff.nextActions.length === 0) {
            lines.push("_No open focus items._");
        }
        else {
            for (const action of handoff.nextActions) {
                lines.push(`- ${action.id}: ${markdownEscape(action.title)} - ${action.reason}`);
            }
        }
    }
    if (include("recent", ["activity"])) {
        lines.push("", "## Recent Activity", "");
        if (handoff.recent.length === 0) {
            lines.push("_No recent open activity._");
        }
        else {
            for (const item of handoff.recent) {
                const updated = item.updatedAt ? ` - updated ${item.updatedAt}` : "";
                lines.push(`- ${item.id}: ${markdownEscape(item.title)} (${item.status})${updated}`);
            }
        }
    }
    if (include("links")) {
        lines.push("", "## Linked Context", "");
        if (handoff.links.length === 0) {
            lines.push("_No linked files or docs._");
        }
        else {
            for (const link of handoff.links) {
                lines.push(`- ${link.itemId} ${link.kind}: ${link.value}`);
            }
        }
    }
    if (include("deps") && handoff.deps) {
        lines.push("", "## Dependencies", "");
        if (handoff.deps.length === 0) {
            lines.push("_No dependency relationships found._");
        }
        else {
            for (const dep of handoff.deps) {
                lines.push(`- ${dep.itemId}: depends_on [${dep.dependsOn.join(", ")}] | depended_by [${dep.dependedBy.join(", ")}]`);
            }
        }
    }
    if (include("refresh")) {
        lines.push("", "## Refresh", "", `\`${handoff.suggestedCommand}\``, "");
    }
    let output = `${lines.join("\n")}\n`;
    if (compress) {
        output = `${output.split("\n").filter((line) => line.trim() !== "").join("\n")}\n`;
    }
    return output;
}
export function readPmItems(pmRoot) {
    const result = spawnSync("pm", ["--path", pmRoot, "list-all", "--json", "--include-body"], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new CommandError(result.stderr.trim() || "`pm list-all --json --include-body` failed");
    }
    try {
        const parsed = JSON.parse(result.stdout);
        const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
        return items.filter((item) => Boolean(item) && typeof item === "object" && typeof item.id === "string");
    }
    catch (err) {
        throw new CommandError(`Could not parse pm item JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function setupCommands(api) {
    const contextPackDefaultLimit = 25;
    const contextHandoffDefaultLimit = 12;
    const defaultRecentLimit = 5;
    api.registerCommand({
        name: "context-pack",
        description: "Generate a durable pm context pack for handoffs and reviews.",
        intent: "turn selected pm work into portable context",
        examples: [
            "pm context-pack --id pm-1234 --include-body --output context.md",
            "pm context-pack --id pm-1234 --format agent",
            "pm context-pack --ids pm-1234,pm-5678 --state blocked --format compact",
            "pm context-pack --id pm-1234 --format compact --recent 8",
            "pm context-pack --status in_progress --tag release --format json",
            "pm context-pack --id pm-1234 --compress --format json",
            "pm context-pack --id pm-1234 --format agent --include-deps --section focus --section blockers",
            "pm context-pack --id pm-1234 --max-items 10",
        ],
        flags: [
            { long: "--id", value_name: "id", description: "Focus item id (repeatable or comma-separated)", type: "string" },
            { long: "--ids", value_name: "ids", description: "Comma-separated focus ids (alias for repeated --id)", type: "string" },
            { long: "--status", value_name: "status", description: "Filter focus items by status", type: "string" },
            { long: "--state", value_name: "status", description: "Alias for --status", type: "string" },
            { long: "--type", value_name: "type", description: "Filter focus items by type", type: "string" },
            { long: "--kind", value_name: "type", description: "Alias for --type", type: "string" },
            { long: "--tag", value_name: "tag", description: "Filter focus items by tag", type: "string" },
            { long: "--limit", value_name: "n", description: "Maximum focus item count (default: 25)", type: "string" },
            { long: "--format", value_name: "format", description: "Output format: markdown, json, agent, or compact", type: "string" },
            { long: "--recent", value_name: "n", description: "Recent activity items in agent/compact output (default: 5)", type: "string" },
            { long: "--output", value_name: "file", description: "Write context pack to a file", type: "string" },
            { long: "--include-body", description: "Include body/description text", type: "boolean" },
            { long: "--include-closed", description: "Include closed/canceled items in filtered packs", type: "boolean" },
            { long: "--without-neighborhood", description: "Omit dependency/dependent neighbors", type: "boolean" },
            { long: "--neighborhood-depth", value_name: "n", description: `Transitive neighbor hops via dependency graph (0-${MAX_NEIGHBORHOOD_DEPTH}, default: 1; 0 = none)`, type: "string" },
            { long: "--compress", description: "Minimize output tokens (compact JSON, no blank lines)", type: "boolean" },
            { long: "--include-deps", description: "Include per-item dependency info in the context pack", type: "boolean" },
            { long: "--max-items", value_name: "n", description: "Maximum total items (focus + neighbors) in the pack", type: "string" },
            { long: "--section", value_name: "section", description: "Include sections (repeatable). Markdown: summary, focus, neighborhood, neighbors, links, deps. Agent/compact: focus, blockers, next-actions, recent, links, deps, refresh", type: "string" },
        ],
        async run(ctx) {
            const options = ctx.options;
            const requestedFormat = (stringOption(options, "format") ?? "markdown").toLowerCase();
            const format = requestedFormat === "compact" ? "agent" : requestedFormat;
            if (format !== "markdown" && format !== "json" && format !== "agent") {
                throw new CommandError("--format must be markdown, json, agent, or compact", EXIT_CODE.USAGE);
            }
            const selection = resolveSelectionOptions(options);
            const limit = intOption(options, "limit", contextPackDefaultLimit);
            const includeBody = boolOption(options, "include-body", "includeBody");
            const includeClosed = boolOption(options, "include-closed", "includeClosed");
            const neighborhood = !boolOption(options, "without-neighborhood", "withoutNeighborhood");
            const neighborhoodDepth = intOptionMin0(options, ["neighborhood-depth", "neighborhoodDepth"], 1);
            const recentLimit = intOptionMin0(options, ["recent", "recentLimit", "recent-limit"], defaultRecentLimit);
            const compress = boolOption(options, "compress");
            const includeDeps = boolOption(options, "include-deps", "includeDeps");
            const maxItems = intOptionMin0(options, ["max-items", "maxItems"], 0) || undefined;
            const sections = validateSections(format, [...asArray(options.section), ...asArray(options.sections)]);
            const pack = buildContextPack(readPmItems(ctx.pm_root), {
                ids: selection.ids,
                status: selection.status,
                type: selection.type,
                tag: selection.tag,
                limit,
                includeBody,
                includeClosed,
                neighborhood,
                neighborhoodDepth,
                includeDeps,
                maxItems,
            });
            const suggestedCommand = buildSuggestedAgentCommand({
                commandName: "context-pack",
                selection,
                limit,
                defaultLimit: contextPackDefaultLimit,
                recentLimit,
                defaultRecentLimit,
                includeClosed,
                neighborhood,
                neighborhoodDepth,
                includeFormatFlag: true,
                compress,
                includeDeps,
                maxItems,
                sections: sections.length > 0 ? sections : undefined,
            });
            const renderOpts = { recentLimit, suggestedCommand, compress, sections: sections.length > 0 ? sections : undefined };
            const output = format === "json"
                ? `${JSON.stringify(pack, null, compress ? 0 : 2)}\n`
                : format === "agent"
                    ? renderAgentHandoff(pack, renderOpts)
                    : renderMarkdown(pack, renderOpts);
            const outputPath = stringOption(options, "output");
            if (outputPath) {
                writeFileSync(outputPath, output, "utf-8");
                console.error(`context pack written to ${outputPath}`);
            }
            else {
                console.error(output.trimEnd());
            }
            const reportedFormat = requestedFormat === "compact" ? "compact" : format;
            return format === "json" ? pack : { ok: true, format: reportedFormat, selected: pack.summary.selectedItems, neighbors: pack.summary.neighborItems };
        },
    });
    api.registerCommand({
        name: "context-handoff",
        description: "Generate an agent-ready handoff with concise defaults.",
        intent: "produce compact, actionable handoff context for another agent",
        examples: [
            "pm context-handoff --id pm-1234",
            "pm context-handoff --ids pm-1234,pm-5678 --state blocked",
            "pm context-handoff --status blocked --recent 8",
            "pm context-handoff --tag release --without-neighborhood",
            "pm context-handoff --id pm-1234 --format json",
            "pm context-handoff --id pm-1234 --compress --include-deps",
        ],
        flags: [
            { long: "--id", value_name: "id", description: "Focus item id (repeatable or comma-separated)", type: "string" },
            { long: "--ids", value_name: "ids", description: "Comma-separated focus ids (alias for repeated --id)", type: "string" },
            { long: "--status", value_name: "status", description: "Filter focus items by status", type: "string" },
            { long: "--state", value_name: "status", description: "Alias for --status", type: "string" },
            { long: "--type", value_name: "type", description: "Filter focus items by type", type: "string" },
            { long: "--kind", value_name: "type", description: "Alias for --type", type: "string" },
            { long: "--tag", value_name: "tag", description: "Filter focus items by tag", type: "string" },
            { long: "--limit", value_name: "n", description: `Maximum focus item count (default: ${contextHandoffDefaultLimit})`, type: "string" },
            { long: "--format", value_name: "format", description: "Output format: agent, json, or compact (default: agent)", type: "string" },
            { long: "--recent", value_name: "n", description: `Recent activity items (default: ${defaultRecentLimit})`, type: "string" },
            { long: "--output", value_name: "file", description: "Write handoff output to a file", type: "string" },
            { long: "--include-closed", description: "Include closed/canceled items in filtered packs", type: "boolean" },
            { long: "--without-neighborhood", description: "Omit dependency/dependent neighbors", type: "boolean" },
            { long: "--neighborhood-depth", value_name: "n", description: `Transitive neighbor hops via dependency graph (0-${MAX_NEIGHBORHOOD_DEPTH}, default: 1; 0 = none)`, type: "string" },
            { long: "--compress", description: "Minimize output tokens (compact JSON, no blank lines)", type: "boolean" },
            { long: "--include-deps", description: "Include per-item dependency info in the handoff", type: "boolean" },
            { long: "--max-items", value_name: "n", description: "Maximum total items (focus + neighbors) in the handoff", type: "string" },
            { long: "--section", value_name: "section", description: "Include only specific sections (repeatable): focus, blockers, next-actions, recent, links, deps, refresh", type: "string" },
        ],
        async run(ctx) {
            const options = ctx.options;
            const requestedFormat = (stringOption(options, "format") ?? "agent").toLowerCase();
            const format = requestedFormat === "compact" ? "agent" : requestedFormat;
            if (format !== "agent" && format !== "json") {
                throw new CommandError("--format must be agent, json, or compact", EXIT_CODE.USAGE);
            }
            const selection = resolveSelectionOptions(options, { fallbackStatus: "in_progress" });
            const limit = intOption(options, "limit", contextHandoffDefaultLimit);
            const includeClosed = boolOption(options, "include-closed", "includeClosed");
            const neighborhood = !boolOption(options, "without-neighborhood", "withoutNeighborhood");
            const neighborhoodDepth = intOptionMin0(options, ["neighborhood-depth", "neighborhoodDepth"], 1);
            const recentLimit = intOptionMin0(options, ["recent", "recentLimit", "recent-limit"], defaultRecentLimit);
            const compress = boolOption(options, "compress");
            const includeDeps = boolOption(options, "include-deps", "includeDeps");
            const maxItems = intOptionMin0(options, ["max-items", "maxItems"], 0) || undefined;
            const sections = validateSections(format, [...asArray(options.section), ...asArray(options.sections)]);
            const pack = buildContextPack(readPmItems(ctx.pm_root), {
                ids: selection.ids,
                status: selection.status,
                type: selection.type,
                tag: selection.tag,
                limit,
                includeClosed,
                neighborhood,
                neighborhoodDepth,
                includeDeps,
                maxItems,
            });
            const suggestedCommand = buildSuggestedAgentCommand({
                commandName: "context-handoff",
                selection,
                limit,
                defaultLimit: contextHandoffDefaultLimit,
                recentLimit,
                defaultRecentLimit,
                includeClosed,
                neighborhood,
                neighborhoodDepth,
                compress,
                includeDeps,
                maxItems,
                sections: sections.length > 0 ? sections : undefined,
            });
            const renderOpts = { recentLimit, suggestedCommand, compress, sections: sections.length > 0 ? sections : undefined };
            const handoff = buildAgentHandoff(pack, { recentLimit, suggestedCommand });
            const output = format === "json"
                ? `${JSON.stringify(handoff, null, compress ? 0 : 2)}\n`
                : renderAgentHandoff(pack, renderOpts);
            const outputPath = stringOption(options, "output");
            if (outputPath) {
                writeFileSync(outputPath, output, "utf-8");
                console.error(`context pack written to ${outputPath}`);
            }
            else {
                console.error(output.trimEnd());
            }
            return {
                ok: true,
                format: format === "json" ? "json" : "agent",
                selected: pack.summary.selectedItems,
                neighbors: pack.summary.neighborItems,
                defaultedStatus: selection.inferredStatus ? selection.status : undefined,
            };
        },
    });
}
export default defineExtension({
    name: "pm-context",
    version: "2026.7.10",
    description: "Generate deterministic pm context packs for agent handoffs, reviews, and status briefs",
    activate(api) {
        setupCommands(api);
    },
});
//# sourceMappingURL=index.js.map