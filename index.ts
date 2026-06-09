import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
} as const;

export class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

export interface PmItem {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  priority?: number;
  tags?: string[];
  body?: string;
  description?: string;
  parent?: string;
  assignee?: string;
  sprint?: string;
  release?: string;
  deadline?: string;
  created_at?: string;
  updated_at?: string;
  docs?: unknown;
  files?: unknown;
  deps?: unknown;
  dependencies?: unknown;
  blocked_by?: unknown;
  blockedBy?: unknown;
  [key: string]: unknown;
}

export const MAX_NEIGHBORHOOD_DEPTH = 5;

export interface ContextPackOptions {
  ids?: string[];
  status?: string;
  type?: string;
  tag?: string;
  limit?: number;
  includeBody?: boolean;
  includeClosed?: boolean;
  neighborhood?: boolean;
  neighborhoodDepth?: number;
  generatedAt?: string;
}

export interface ContextPack {
  generatedAt: string;
  filters: {
    ids: string[];
    status?: string;
    type?: string;
    tag?: string;
    includeClosed: boolean;
    neighborhood: boolean;
  };
  summary: {
    totalItems: number;
    selectedItems: number;
    neighborItems: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
  items: PmItem[];
  neighbors: PmItem[];
  links: Array<{ itemId: string; kind: "doc" | "file"; value: string }>;
  relationships: Array<{ from: string; to: string; kind: string }>;
}

export interface AgentHandoff {
  generatedAt: string;
  counts: {
    focus: number;
    neighbors: number;
    blockers: number;
    links: number;
  };
  focus: Array<{ id: string; title: string; status: string; type: string; priority?: number; deadline?: string }>;
  blockers: Array<{ itemId: string; blockedBy: string; kind: string; title?: string; status?: string }>;
  nextActions: Array<{ id: string; title: string; reason: string }>;
  links: Array<{ itemId: string; kind: "doc" | "file"; value: string }>;
  suggestedCommand: string;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(asArray);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function boolOption(options: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => {
    const value = options[key];
    return value === true || value === "true" || value === "1";
  });
}

function stringOption(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function intOption(options: Record<string, unknown>, key: string, fallback: number): number {
  const raw = options[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new CommandError(`--${key} must be a positive integer`, EXIT_CODE.USAGE);
  }
  return parsed;
}

function intOptionMin0(options: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const raw = options[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new CommandError(`--${keys[0]} must be a non-negative integer`, EXIT_CODE.USAGE);
    }
    return parsed;
  }
  return fallback;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTags(value: unknown): string[] {
  return asArray(value).map((tag) => tag.toLowerCase());
}

function itemStatus(item: PmItem): string {
  return normalizeText(item.status) || "unknown";
}

function itemType(item: PmItem): string {
  return normalizeText(item.type) || "Item";
}

function isClosedStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "closed" || normalized === "done" || normalized === "canceled" || normalized === "cancelled";
}

function itemUpdatedAt(item: PmItem): string {
  return normalizeText(item.updated_at) || normalizeText(item.created_at);
}

export function sortContextItems(items: PmItem[]): PmItem[] {
  return [...items].sort((a, b) => {
    const priorityA = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
    const priorityB = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return itemUpdatedAt(b).localeCompare(itemUpdatedAt(a)) || a.id.localeCompare(b.id);
  });
}

function parseRelationshipValue(value: unknown, fallbackKind: string): Array<{ to: string; kind: string }> {
  if (!value) return [];
  if (typeof value === "string") {
    return asArray(value).map((to) => ({ to, kind: fallbackKind }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseRelationshipValue(entry, fallbackKind));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const to = normalizeText(record.id) || normalizeText(record.to) || normalizeText(record.target) ||
      normalizeText(record.target_id) || normalizeText(record.item) || normalizeText(record.item_id);
    if (!to) return [];
    const kind = normalizeText(record.kind) || normalizeText(record.type) || fallbackKind;
    return [{ to, kind }];
  }
  return [];
}

export function extractRelationships(item: PmItem): Array<{ from: string; to: string; kind: string }> {
  const rels = [
    ...parseRelationshipValue(item.deps, "depends_on"),
    ...parseRelationshipValue(item.dependencies, "depends_on"),
    ...parseRelationshipValue(item.blocked_by, "blocked_by"),
    ...parseRelationshipValue(item.blockedBy, "blocked_by"),
  ];
  const seen = new Set<string>();
  return rels
    .filter((rel) => rel.to && rel.to !== item.id)
    .map((rel) => ({ from: item.id, to: rel.to, kind: rel.kind }))
    .filter((rel) => {
      const key = `${rel.from}\0${rel.kind}\0${rel.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function extractLinkValues(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return asArray(value);
  if (Array.isArray(value)) return value.flatMap(extractLinkValues);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
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

function buildLinks(items: PmItem[]): Array<{ itemId: string; kind: "doc" | "file"; value: string }> {
  const links: Array<{ itemId: string; kind: "doc" | "file"; value: string }> = [];
  for (const item of items) {
    for (const value of extractLinkValues(item.docs)) links.push({ itemId: item.id, kind: "doc", value });
    for (const value of extractLinkValues(item.files)) links.push({ itemId: item.id, kind: "file", value });
  }
  return links;
}

function matchesFilters(item: PmItem, options: ContextPackOptions): boolean {
  if (!options.includeClosed && isClosedStatus(itemStatus(item))) return false;
  if (options.status && itemStatus(item).toLowerCase() !== options.status.toLowerCase()) return false;
  if (options.type && itemType(item).toLowerCase() !== options.type.toLowerCase()) return false;
  if (options.tag && !normalizeTags(item.tags).includes(options.tag.toLowerCase())) return false;
  return true;
}

export function buildContextPack(allItems: PmItem[], options: ContextPackOptions = {}): ContextPack {
  const ids = Array.from(new Set((options.ids ?? []).map((id) => id.trim()).filter(Boolean)));
  const byId = new Map(allItems.map((item) => [item.id, item]));
  const allRelationships = allItems.flatMap(extractRelationships);
  const selected = ids.length > 0
    ? ids.map((id) => byId.get(id)).filter((item): item is PmItem => Boolean(item))
    : allItems.filter((item) => matchesFilters(item, options));
  const limited = sortContextItems(selected).slice(0, options.limit ?? 25);
  const selectedIds = new Set(limited.map((item) => item.id));
  // Resolve the neighborhood depth. --without-neighborhood (neighborhood === false)
  // forces depth 0. Otherwise default to 1 hop, capped at MAX_NEIGHBORHOOD_DEPTH.
  let depth = options.neighborhoodDepth ?? 1;
  if (options.neighborhood === false) depth = 0;
  if (depth < 0) depth = 0;
  if (depth > MAX_NEIGHBORHOOD_DEPTH) depth = MAX_NEIGHBORHOOD_DEPTH;
  // BFS over the (bidirectional) dependency relationship graph starting from the
  // focus items. Each hop expands the frontier by one degree of separation. The
  // visited set is seeded with focus ids so a focus item is never a neighbor.
  const neighborIds = new Set<string>();
  const visited = new Set<string>(selectedIds);
  let frontier = new Set<string>(selectedIds);
  for (let hop = 0; hop < depth && frontier.size > 0; hop += 1) {
    const next = new Set<string>();
    for (const rel of allRelationships) {
      if (frontier.has(rel.from) && !visited.has(rel.to)) next.add(rel.to);
      if (frontier.has(rel.to) && !visited.has(rel.from)) next.add(rel.from);
    }
    for (const id of next) {
      visited.add(id);
      neighborIds.add(id);
    }
    frontier = next;
  }
  for (const id of selectedIds) neighborIds.delete(id);
  const neighbors = sortContextItems([...neighborIds].map((id) => byId.get(id)).filter((item): item is PmItem => Boolean(item)));
  const packItems = limited.map((item) => options.includeBody ? item : { ...item, body: undefined, description: undefined });
  const packNeighbors = neighbors.map((item) => options.includeBody ? item : { ...item, body: undefined, description: undefined });
  const selectedAndNeighbors = [...packItems, ...packNeighbors];
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const item of packItems) {
    byStatus[itemStatus(item)] = (byStatus[itemStatus(item)] ?? 0) + 1;
    byType[itemType(item)] = (byType[itemType(item)] ?? 0) + 1;
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
    relationships: allRelationships.filter((rel) => selectedIds.has(rel.from) || selectedIds.has(rel.to)),
  };
}

function markdownEscape(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function renderItemList(items: PmItem[], includeBody: boolean): string[] {
  if (items.length === 0) return ["_None._"];
  const lines: string[] = [];
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
    if (tags.length > 0) lines.push(`  - tags: ${tags.join(", ")}`);
    if (includeBody) {
      const body = normalizeText(item.body) || normalizeText(item.description);
      if (body) lines.push(`  - context: ${markdownEscape(body).slice(0, 700)}`);
    }
  }
  return lines;
}

export function renderMarkdown(pack: ContextPack): string {
  const lines: string[] = [
    "# pm context pack",
    "",
    `Generated: ${pack.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Total workspace items: ${pack.summary.totalItems}`,
    `- Focus items: ${pack.summary.selectedItems}`,
    `- Neighbor items: ${pack.summary.neighborItems}`,
    `- Statuses: ${Object.entries(pack.summary.byStatus).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    `- Types: ${Object.entries(pack.summary.byType).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    "",
    "## Focus Items",
    "",
    ...renderItemList(pack.items, pack.items.some((item) => Boolean(item.body || item.description))),
    "",
    "## Dependency Neighborhood",
    "",
  ];
  if (pack.relationships.length === 0) {
    lines.push("_No dependency relationships in focus._");
  } else {
    for (const rel of pack.relationships) lines.push(`- ${rel.from} --${rel.kind}--> ${rel.to}`);
  }
  lines.push("", "## Neighbor Items", "", ...renderItemList(pack.neighbors, false), "", "## Linked Context", "");
  if (pack.links.length === 0) {
    lines.push("_No docs or files linked in selected context._");
  } else {
    for (const link of pack.links) lines.push(`- ${link.itemId} ${link.kind}: ${link.value}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function titleFor(items: PmItem[], id: string): string | undefined {
  return items.find((item) => item.id === id)?.title;
}

function statusFor(items: PmItem[], id: string): string | undefined {
  return items.find((item) => item.id === id)?.status;
}

export function buildAgentHandoff(pack: ContextPack): AgentHandoff {
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
  const suggestedCommand = ids
    ? `pm context-pack --id ${ids} --format agent`
    : "pm context-pack --status in_progress --format agent";
  return {
    generatedAt: pack.generatedAt,
    counts: {
      focus: pack.summary.selectedItems,
      neighbors: pack.summary.neighborItems,
      blockers: blockers.length,
      links: pack.links.length,
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
    links: pack.links.slice(0, 12),
    suggestedCommand,
  };
}

export function renderAgentHandoff(pack: ContextPack): string {
  const handoff = buildAgentHandoff(pack);
  const lines: string[] = [
    "# pm agent handoff",
    "",
    `Generated: ${handoff.generatedAt}`,
    `Focus: ${handoff.counts.focus} | Neighbors: ${handoff.counts.neighbors} | Blockers: ${handoff.counts.blockers} | Links: ${handoff.counts.links}`,
    "",
    "## Focus",
    "",
  ];
  if (handoff.focus.length === 0) {
    lines.push("_No focus items._");
  } else {
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
  lines.push("", "## Blockers", "");
  if (handoff.blockers.length === 0) {
    lines.push("_No visible blockers._");
  } else {
    for (const blocker of handoff.blockers) {
      const label = blocker.title ? `${blocker.blockedBy} ${markdownEscape(blocker.title)}` : blocker.blockedBy;
      const status = blocker.status ? ` (${blocker.status})` : "";
      lines.push(`- ${blocker.itemId} ${blocker.kind} ${label}${status}`);
    }
  }
  lines.push("", "## Next Actions", "");
  if (handoff.nextActions.length === 0) {
    lines.push("_No open focus items._");
  } else {
    for (const action of handoff.nextActions) {
      lines.push(`- ${action.id}: ${markdownEscape(action.title)} - ${action.reason}`);
    }
  }
  lines.push("", "## Linked Context", "");
  if (handoff.links.length === 0) {
    lines.push("_No linked files or docs._");
  } else {
    for (const link of handoff.links) {
      lines.push(`- ${link.itemId} ${link.kind}: ${link.value}`);
    }
  }
  lines.push("", "## Refresh", "", `\`${handoff.suggestedCommand}\``, "");
  return `${lines.join("\n")}\n`;
}

export function readPmItems(pmRoot: string): PmItem[] {
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
    return items.filter((item: unknown): item is PmItem => Boolean(item) && typeof item === "object" && typeof (item as PmItem).id === "string");
  } catch (err) {
    throw new CommandError(`Could not parse pm item JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function setupCommands(api: any): void {
  api.registerCommand({
    name: "context-pack",
    description: "Generate a durable pm context pack for handoffs and reviews.",
    intent: "turn selected pm work into portable context",
    examples: [
      "pm context-pack --id pm-1234 --include-body --output context.md",
      "pm context-pack --id pm-1234 --format agent",
      "pm context-pack --status in_progress --tag release --format json",
    ],
    flags: [
      { long: "--id", value_name: "id", description: "Focus item id (repeatable or comma-separated)", type: "string" },
      { long: "--status", value_name: "status", description: "Filter focus items by status", type: "string" },
      { long: "--type", value_name: "type", description: "Filter focus items by type", type: "string" },
      { long: "--tag", value_name: "tag", description: "Filter focus items by tag", type: "string" },
      { long: "--limit", value_name: "n", description: "Maximum focus item count (default: 25)", type: "string" },
      { long: "--format", value_name: "format", description: "Output format: markdown, json, or agent", type: "string" },
      { long: "--output", value_name: "file", description: "Write context pack to a file", type: "string" },
      { long: "--include-body", description: "Include body/description text", type: "boolean" },
      { long: "--include-closed", description: "Include closed/canceled items in filtered packs", type: "boolean" },
      { long: "--without-neighborhood", description: "Omit dependency/dependent neighbors", type: "boolean" },
      { long: "--neighborhood-depth", value_name: "n", description: `Transitive neighbor hops via dependency graph (0-${MAX_NEIGHBORHOOD_DEPTH}, default: 1; 0 = none)`, type: "string" },
    ],
    async run(ctx: any) {
      const options = ctx.options as Record<string, unknown>;
      const format = (stringOption(options, "format") ?? "markdown").toLowerCase();
      if (format !== "markdown" && format !== "json" && format !== "agent") {
        throw new CommandError("--format must be markdown, json, or agent", EXIT_CODE.USAGE);
      }
      const pack = buildContextPack(readPmItems(ctx.pm_root), {
        ids: asArray(options.id),
        status: stringOption(options, "status"),
        type: stringOption(options, "type"),
        tag: stringOption(options, "tag"),
        limit: intOption(options, "limit", 25),
        includeBody: boolOption(options, "include-body", "includeBody"),
        includeClosed: boolOption(options, "include-closed", "includeClosed"),
        neighborhood: !boolOption(options, "without-neighborhood", "withoutNeighborhood"),
        neighborhoodDepth: intOptionMin0(options, ["neighborhood-depth", "neighborhoodDepth"], 1),
      });
      const output = format === "json"
        ? `${JSON.stringify(pack, null, 2)}\n`
        : format === "agent"
          ? renderAgentHandoff(pack)
          : renderMarkdown(pack);
      const outputPath = stringOption(options, "output");
      if (outputPath) {
        writeFileSync(outputPath, output, "utf-8");
        console.error(`context pack written to ${outputPath}`);
      } else {
        console.error(output.trimEnd());
      }
      return format === "json" ? pack : { ok: true, format, selected: pack.summary.selectedItems, neighbors: pack.summary.neighborItems };
    },
  });
}

export default defineExtension({
  name: "pm-context",
  version: "2026.6.8",
  description: "Generate deterministic pm context packs for agent handoffs, reviews, and status briefs",
  activate(api: any) {
    setupCommands(api);
  },
});
