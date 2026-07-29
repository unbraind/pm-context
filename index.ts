import type { ExtensionModule } from "@unbrained/pm-cli/sdk/authoring";
import { writeFileSync } from "node:fs";
import type {
  CommandHandlerContext,
  ExtensionApi,
  ItemMetadata,
  RuntimeStatusRegistry,
} from "@unbrained/pm-cli/sdk";
import { readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { list as pmList } from "@unbrained/pm-cli/sdk/core";
import type { ListResult, ListResultItem } from "@unbrained/pm-cli/sdk/query";
import {
  buildItemContextRelevanceCandidates,
  defaultScoreContextCandidates,
  packContextCandidates,
  recordContextUsageServing,
} from "@unbrained/pm-cli/sdk/query";
import type {
  ContextPackingCandidate,
  ContextProjectionCosts,
  ContextRelevanceReport,
  ContextUsageServingRow,
} from "@unbrained/pm-cli/sdk/query";
import { DEFAULT_REPORT_LIMIT, renderUsageReport, reportContextUsage, resolveSince } from "./context-usage.ts";
import { readContextUsageAffinity } from "@unbrained/pm-cli/sdk/query";

/**
 * Runtime stand-in for the SDK's `defineExtension`.
 *
 * `defineExtension` is a documented zero-cost identity function. This package
 * now resolves `@unbrained/pm-cli` at runtime (it is a peer dependency the pm
 * host provides) for the `sdk/core` and `sdk/query` engines, but the authoring
 * helper itself has no runtime behavior, so a local identity shim avoids a
 * needless value import while still contract-checking the module against
 * {@link ExtensionModule}.
 */

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
  /** Null (not absent) when the SDK reports an explicitly unset parent. */
  parent?: string | null;
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

export const MARKDOWN_SECTIONS = ["summary", "focus", "neighborhood", "neighbors", "links", "deps"] as const;
export const AGENT_SECTIONS = ["focus", "blockers", "next-actions", "actions", "nextactions", "recent", "activity", "links", "deps", "refresh"] as const;

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
  includeDeps?: boolean;
  maxItems?: number;
  /**
   * Override the focus-item ranking. Defaults to {@link sortContextItems} (the
   * deterministic priority-then-recency order used by the pure assembly path).
   * The command path supplies the SDK relevance ranker built from
   * {@link defaultScoreContextCandidates} so real packs honor pm's weighted
   * context-relevance model instead of the hand-rolled sort.
   */
  ranker?: (items: PmItem[]) => PmItem[];
  /**
   * Override the total-item budgeting applied when `maxItems` is set. Defaults
   * to the count-based trim (focus first, neighbors trimmed to fit). The
   * command path supplies a {@link packContextCandidates}-backed packer so a
   * token budget selects items with pm's projection-degradation packer rather
   * than a hard count slice.
   */
  packer?: (focus: PmItem[], neighbors: PmItem[], maxItems: number) => { focus: PmItem[]; neighbors: PmItem[] };
}

export interface ContextPackDepInfo {
  itemId: string;
  dependsOn: string[];
  dependedBy: string[];
}

export interface RenderOptions {
  sections?: string[];
  compress?: boolean;
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
    includeDeps: boolean;
    maxItems?: number;
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
  deps?: ContextPackDepInfo[];
}

export interface AgentHandoff {
  generatedAt: string;
  counts: {
    focus: number;
    neighbors: number;
    blockers: number;
    links: number;
    recent: number;
    deps: number;
  };
  focus: Array<{ id: string; title: string; status: string; type: string; priority?: number; deadline?: string }>;
  blockers: Array<{ itemId: string; blockedBy: string; kind: string; title?: string; status?: string }>;
  nextActions: Array<{ id: string; title: string; reason: string }>;
  recent: Array<{ id: string; title: string; status: string; updatedAt?: string }>;
  links: Array<{ itemId: string; kind: "doc" | "file"; value: string }>;
  deps?: ContextPackDepInfo[];
  suggestedCommand: string;
}

export interface SelectionOptions {
  ids: string[];
  status?: string;
  type?: string;
  tag?: string;
  inferredStatus: boolean;
}

interface RenderedCommandResult {
  pmContextRendered: true;
  output: string;
}

function renderedCommandResult(output: string): RenderedCommandResult {
  return { pmContextRendered: true, output: output.endsWith("\n") ? output : `${output}\n` };
}

function renderCommandResult(context: { result?: unknown } | null | undefined): string | null {
  const result = context?.result as Partial<RenderedCommandResult> | null | undefined;
  return result?.pmContextRendered === true && typeof result.output === "string" ? result.output : null;
}

export interface SuggestedAgentCommandInput {
  commandName: "context-pack" | "context-handoff";
  selection: SelectionOptions;
  limit: number;
  defaultLimit: number;
  recentLimit: number;
  defaultRecentLimit: number;
  includeClosed: boolean;
  neighborhood: boolean;
  neighborhoodDepth: number;
  includeFormatFlag?: boolean;
  compress?: boolean;
  includeDeps?: boolean;
  maxItems?: number;
  sections?: string[];
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

export function validateSections(format: "markdown" | "agent" | "json", values: string[]): string[] {
  const sections = Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)));
  if (sections.length === 0) return sections;
  if (format === "json") {
    throw new CommandError("--section is only supported with markdown, agent, or compact output", EXIT_CODE.USAGE);
  }
  const allowed = new Set<string>(format === "markdown" ? MARKDOWN_SECTIONS : AGENT_SECTIONS);
  const unsupported = sections.filter((section) => !allowed.has(section));
  if (unsupported.length > 0) {
    throw new CommandError(
      `--section ${unsupported.map((section) => `'${section}'`).join(", ")} is not available in ${format} output; valid sections: ${[...allowed].join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return sections;
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function resolveSelectionOptions(
  options: Record<string, unknown>,
  defaults: { fallbackStatus?: string } = {},
): SelectionOptions {
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

function idSelectorArgs(ids: string[]): string[] {
  const normalizedIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (normalizedIds.length === 0) return [];
  if (normalizedIds.length === 1) return ["--id", shellQuote(normalizedIds[0])];
  return ["--ids", shellQuote(normalizedIds.join(","))];
}

export function buildSuggestedAgentCommand(input: SuggestedAgentCommandInput): string {
  const args: string[] = ["pm", input.commandName];
  if (input.selection.ids.length > 0) {
    args.push(...idSelectorArgs(input.selection.ids));
  } else {
    if (input.selection.status) args.push("--status", shellQuote(input.selection.status));
    if (input.selection.type) args.push("--type", shellQuote(input.selection.type));
    if (input.selection.tag) args.push("--tag", shellQuote(input.selection.tag));
  }
  if (input.includeFormatFlag) args.push("--format", "agent");
  if (input.limit !== input.defaultLimit) args.push("--limit", String(input.limit));
  if (input.recentLimit !== input.defaultRecentLimit) args.push("--recent", String(input.recentLimit));
  if (input.includeClosed) args.push("--include-closed");
  if (input.includeDeps) args.push("--include-deps");
  if (input.compress) args.push("--compress");
  if (typeof input.maxItems === "number" && input.maxItems > 0) args.push("--max-items", String(input.maxItems));
  if (input.sections && input.sections.length > 0) {
    for (const section of input.sections) args.push("--section", shellQuote(section));
  }
  if (!input.neighborhood) {
    args.push("--without-neighborhood");
  } else if (input.neighborhoodDepth !== 1) {
    args.push("--neighborhood-depth", String(input.neighborhoodDepth));
  }
  return args.join(" ");
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
  const ranker = options.ranker ?? sortContextItems;
  const limited = ranker(selected).slice(0, options.limit ?? 25);
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
  const neighborDepths = new Map<string, number>();
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
      neighborDepths.set(id, hop + 1);
    }
    frontier = next;
  }
  for (const id of selectedIds) neighborIds.delete(id);
  let neighbors = sortContextItems([...neighborIds].map((id) => byId.get(id)).filter((item): item is PmItem => Boolean(item)))
    .sort((a, b) => (neighborDepths.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (neighborDepths.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  // --max-items caps the total item count (focus + neighbors). The default
  // packer gives focus items priority and trims neighbors to fit the remaining
  // budget; the command path supplies a `packContextCandidates`-backed packer
  // that selects under a token budget with projection degradation instead.
  let focusItems = limited;
  if (typeof options.maxItems === "number" && options.maxItems > 0) {
    if (options.packer) {
      const packed = options.packer(focusItems, neighbors, options.maxItems);
      focusItems = packed.focus;
      neighbors = packed.neighbors;
    } else if (focusItems.length >= options.maxItems) {
      focusItems = focusItems.slice(0, options.maxItems);
      neighbors = [];
    } else {
      neighbors = neighbors.slice(0, options.maxItems - focusItems.length);
    }
  }
  const focusIdsFinal = new Set(focusItems.map((item) => item.id));
  const packItems = focusItems.map((item) => options.includeBody ? item : { ...item, body: undefined, description: undefined });
  const packNeighbors = neighbors.map((item) => options.includeBody ? item : { ...item, body: undefined, description: undefined });
  const selectedAndNeighbors = [...packItems, ...packNeighbors];
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const item of packItems) {
    byStatus[itemStatus(item)] = (byStatus[itemStatus(item)] ?? 0) + 1;
    byType[itemType(item)] = (byType[itemType(item)] ?? 0) + 1;
  }
  // --include-deps adds per-item dependency info (depends-on and depended-by)
  // for every visible item in the pack.
  let deps: ContextPackDepInfo[] | undefined;
  if (options.includeDeps) {
    const visibleIds = [...packItems, ...packNeighbors].map((item) => item.id);
    const dependsOn = new Map<string, Set<string>>();
    const dependedBy = new Map<string, Set<string>>();
    for (const rel of allRelationships) {
      const outgoing = dependsOn.get(rel.from) ?? new Set<string>();
      outgoing.add(rel.to);
      dependsOn.set(rel.from, outgoing);
      const incoming = dependedBy.get(rel.to) ?? new Set<string>();
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

export function renderMarkdown(pack: ContextPack, options: RenderOptions = {}): string {
  const sectionFilter = options.sections?.map((s) => s.toLowerCase());
  const compress = options.compress === true;
  const include = (name: string) => !sectionFilter || sectionFilter.includes(name);

  const lines: string[] = [
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
    } else {
      for (const rel of pack.relationships) lines.push(`- ${rel.from} --${rel.kind}--> ${rel.to}`);
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
    } else {
      for (const link of pack.links) lines.push(`- ${link.itemId} ${link.kind}: ${link.value}`);
    }
  }

  if (include("deps") && pack.deps) {
    lines.push("", "## Dependencies", "");
    if (pack.deps.length === 0) {
      lines.push("_No dependency relationships found._");
    } else {
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

function titleFor(items: PmItem[], id: string): string | undefined {
  return items.find((item) => item.id === id)?.title;
}

function statusFor(items: PmItem[], id: string): string | undefined {
  return items.find((item) => item.id === id)?.status;
}

function updatedTimestamp(item: PmItem): number {
  const raw = normalizeText(item.updated_at) || normalizeText(item.created_at);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildAgentHandoff(
  pack: ContextPack,
  options: { recentLimit?: number; suggestedCommand?: string } = {},
): AgentHandoff {
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

export function renderAgentHandoff(
  pack: ContextPack,
  options: { recentLimit?: number; suggestedCommand?: string; sections?: string[]; compress?: boolean } = {},
): string {
  const handoff = buildAgentHandoff(pack, options);
  const sectionFilter = options.sections?.map((s) => s.toLowerCase());
  const compress = options.compress === true;
  const include = (name: string, aliases: string[] = []) => !sectionFilter || sectionFilter.includes(name) || aliases.some((a) => sectionFilter!.includes(a));

  const lines: string[] = [
    "# pm agent handoff",
    "",
    `Generated: ${handoff.generatedAt}`,
    `Focus: ${handoff.counts.focus} | Neighbors: ${handoff.counts.neighbors} | Blockers: ${handoff.counts.blockers} | Links: ${handoff.counts.links} | Recent: ${handoff.counts.recent}${handoff.counts.deps > 0 ? ` | Deps: ${handoff.counts.deps}` : ""}`,
  ];

  if (include("focus")) {
    lines.push("", "## Focus", "");
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
  }

  if (include("blockers")) {
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
  }

  if (include("next-actions", ["actions", "nextactions"])) {
    lines.push("", "## Next Actions", "");
    if (handoff.nextActions.length === 0) {
      lines.push("_No open focus items._");
    } else {
      for (const action of handoff.nextActions) {
        lines.push(`- ${action.id}: ${markdownEscape(action.title)} - ${action.reason}`);
      }
    }
  }

  if (include("recent", ["activity"])) {
    lines.push("", "## Recent Activity", "");
    if (handoff.recent.length === 0) {
      lines.push("_No recent open activity._");
    } else {
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
    } else {
      for (const link of handoff.links) {
        lines.push(`- ${link.itemId} ${link.kind}: ${link.value}`);
      }
    }
  }

  if (include("deps") && handoff.deps) {
    lines.push("", "## Dependencies", "");
    if (handoff.deps.length === 0) {
      lines.push("_No dependency relationships found._");
    } else {
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

/**
 * Read every pm item (full metadata + body) in-process through the SDK.
 *
 * Replaces the previous `spawnSync("pm", ["list-all", "--json", "--include-body"])`
 * shell-out with the typed {@link list} action from `@unbrained/pm-cli/sdk/core`.
 * `list-all` is the SDK alias for `list` with `excludeTerminal: false`; passing
 * `full: true` + `includeBody: true` reproduces the full-metadata-with-body
 * projection the shell-out parsed, including the CLI's default truncation
 * semantics, so the downstream pack shape remains compatible.
 */
export async function readPmItems(pmRoot: string): Promise<PmItem[]> {
  let result: ListResult;
  try {
    result = await pmList(
      { full: true, includeBody: true, excludeTerminal: false },
      { pmRoot },
    );
  } catch (err) {
    throw new CommandError(`Could not read pm items via SDK list: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result.items.filter(
    (item): item is ListResultItem & { id: string } => typeof item.id === "string",
  );
}

/** Per-item token estimate for one character of text (rough 4 chars/token). */
const TOKENS_PER_CHAR = 0.25;
/** Default token budget allocated per `--max-items` slot when token-budgeted packing runs. */
const TOKENS_PER_ITEM_SLOT = 220;

/**
 * Coerce a {@link PmItem} into the {@link ItemMetadata} shape the SDK relevance
 * engine requires, filling any absent required scalar with a neutral default.
 * Items returned by {@link readPmItems} already carry every required field, so
 * this is idempotent for real packs; it only papers over the optional fields of
 * the loose `PmItem` projection so hand-built test fixtures still rank.
 */
function toItemMetadata(item: PmItem, now: string): ItemMetadata {
  const priority = typeof item.priority === "number" && item.priority >= 0 && item.priority <= 4 ? item.priority : 3;
  // `readPmItems` returns the SDK list engine's full projection, which already
  // satisfies `ItemMetadata`; it flows through the loose `PmItem` interface only
  // so `buildContextPack` can keep accepting hand-built fixtures. This cast
  // restores the precise SDK type for the relevance engine — the required
  // scalars are filled above, and the optional collection fields (dependencies,
  // docs, files, blocked_by) come straight from the real item. PmItem types
  // those as `unknown` (wider than ItemMetadata), so the assertion bridges that
  // widening rather than hiding a real mismatch.
  return {
    ...item,
    id: item.id,
    title: typeof item.title === "string" ? item.title : "",
    description: typeof item.description === "string" ? item.description : "",
    type: typeof item.type === "string" ? item.type : "Task",
    status: typeof item.status === "string" ? item.status : "unknown",
    priority: priority as 0 | 1 | 2 | 3 | 4,
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag)) : [],
    created_at: normalizeText(item.created_at) || normalizeText(item.updated_at) || now,
    updated_at: normalizeText(item.updated_at) || normalizeText(item.created_at) || now,
  } as ItemMetadata;
}

/** Rank options forwarded to the SDK relevance engine. */
export interface SdkRankOptions {
  /** Workspace lifecycle registry, including custom in-progress aliases. */
  statusRegistry: RuntimeStatusRegistry;
  /** Stable clock used for deadline/recency pressure. */
  now: string;
  /** Optional caller identity used for assignment affinity. */
  author?: string;
  /** Optional decayed served-then-used affinity by item id. */
  usageAffinity?: Readonly<Record<string, number>>;
}

/**
 * Rank items with pm's deterministic weighted relevance model.
 *
 * Wraps {@link buildItemContextRelevanceCandidates} +
 * {@link defaultScoreContextCandidates} so the command path uses the same
 * relevance signals (`priority_pressure`, `recency`, `claim_focus`, …) as
 * `pm context` / `pm next` instead of the hand-rolled priority-then-recency
 * sort. Returns the items in ranked order and exposes the full report via
 * {@link scoreContextItems} for `--explain`.
 */
export function rankContextItems(items: readonly PmItem[], options: SdkRankOptions): PmItem[] {
  const report = scoreContextItems(items, options);
  const byId = new Map<string, PmItem>(items.map((item) => [item.id, item]));
  return report.ranked
    .map((ranked) => byId.get(ranked.id))
    .filter((item): item is PmItem => Boolean(item));
}

/**
 * Score items with the SDK relevance model and return the full report.
 *
 * The report's `ranked[].contributions` map each item's score back to the
 * individual signals that produced it — the data behind `pm context-pack
 * --explain`.
 */
export function scoreContextItems(items: readonly PmItem[], options: SdkRankOptions): ContextRelevanceReport<PmItem> {
  const now = options.now;
  const byId = new Map(items.map((item) => [item.id, item]));
  const candidates = buildItemContextRelevanceCandidates(
    items.map((item) => toItemMetadata(item, now)),
    {
      statusRegistry: options.statusRegistry,
      now,
      author: options.author,
      usageAffinity: options.usageAffinity,
    },
  );
  // `defaultScoreContextCandidates` is the deterministic, extension-free core of
  // `scoreContextCandidates`. The command path runs in-process and does not need
  // the governed `context_relevance` service override, so the synchronous default
  // keeps pack generation deterministic and side-effect free.
  return defaultScoreContextCandidates<PmItem>(
    candidates.map((candidate) => ({ id: candidate.id, item: byIdOrFail(byId, candidate.id), signals: candidate.signals })),
  );
}

/** Look up an item by id or throw a descriptive error (keeps callers honest). */
function byIdOrFail(byId: ReadonlyMap<string, PmItem>, id: string): PmItem {
  const item = byId.get(id);
  if (!item) throw new CommandError(`relevance candidate ${id} not found among items`);
  return item;
}

/**
 * Build a {@link ContextPackOptions.ranker} closure backed by the SDK relevance
 * model. The closure ranks whatever focus subset {@link buildContextPack} hands
 * it after id/status/type/tag filtering, preserving the SDK's weighted order.
 */
export function createSdkRanker(allItems: readonly PmItem[], options: SdkRankOptions): (items: PmItem[]) => PmItem[] {
  return (items: PmItem[]): PmItem[] => {
    if (items.length <= 1) return items;
    return rankContextItems(items, options);
  };
}

/** Rough token estimate for one projection level of a context candidate. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length * TOKENS_PER_CHAR));
}

/**
 * Estimate the identity / summary / full token costs for one item, matching the
 * monotone projection ladder {@link packContextCandidates} upgrades through.
 */
function estimateProjectionCosts(item: PmItem): ContextProjectionCosts {
  const identity = estimateTokens(`${item.id} ${normalizeText(item.title)}`);
  const meta = `${itemType(item)} ${itemStatus(item)} ${typeof item.priority === "number" ? item.priority : ""} ${(normalizeTags(item.tags)).join(" ")}`;
  const summary = identity + estimateTokens(meta);
  const body = normalizeText(item.body) || normalizeText(item.description);
  const full = summary + (body ? estimateTokens(body) : 0);
  return { identity, summary, full };
}

/**
 * Build a {@link ContextPackOptions.packer} closure backed by
 * {@link packContextCandidates}. Each `--max-items` slot maps to a token budget;
 * focus items are required anchors, neighbors compete by relevance rank for the
 * remaining budget. The packer first selects under that token budget with pm's
 * projection-degradation optimizer, then enforces the command's explicit item
 * ceiling while preserving the SDK-selected focus-first order.
 */
export function createSdkPacker(
  rankedFocus: readonly PmItem[],
  rankedNeighbors: readonly PmItem[],
): (focus: PmItem[], neighbors: PmItem[], maxItems: number) => { focus: PmItem[]; neighbors: PmItem[] } {
  const focusRank = new Map<string, number>(rankedFocus.map((item, index) => [item.id, index + 1]));
  const neighborRank = new Map<string, number>(rankedNeighbors.map((item, index) => [item.id, rankedFocus.length + index + 1]));
  return (focus: PmItem[], neighbors: PmItem[], maxItems: number): { focus: PmItem[]; neighbors: PmItem[] } => {
    if (!(maxItems > 0)) return { focus, neighbors };
    const tokenBudget = maxItems * TOKENS_PER_ITEM_SLOT;
    const candidates: ContextPackingCandidate<PmItem>[] = [
      ...focus.map((item) => ({
        id: item.id,
        item,
        rank: focusRank.get(item.id) ?? 1,
        score: 1 / (focusRank.get(item.id) ?? 1),
        token_costs: estimateProjectionCosts(item),
        required: true,
      })),
      ...neighbors.map((item) => ({
        id: item.id,
        item,
        rank: neighborRank.get(item.id) ?? focus.length + 1,
        score: 1 / (neighborRank.get(item.id) ?? focus.length + 1),
        token_costs: estimateProjectionCosts(item),
      })),
    ];
    const packed = packContextCandidates(candidates, { tokenBudget, profile: "context" });
    const included = new Set(packed.included.map((candidate) => candidate.id));
    const packedFocus = focus.filter((item) => included.has(item.id)).slice(0, maxItems);
    const remainingSlots = Math.max(0, maxItems - packedFocus.length);
    return {
      focus: packedFocus,
      neighbors: neighbors.filter((item) => included.has(item.id)).slice(0, remainingSlots),
    };
  };
}

/** One ranked focus item with its per-signal relevance contributions. */
export interface ContextExplainEntry {
  id: string;
  rank: number;
  score: number;
  contributions: Record<string, number>;
}

/** Relevance explanation report surfaced by `pm context-pack --explain`. */
export interface ContextExplainReport {
  generatedAt: string;
  model: string;
  /** Population over which ranks and normalized scores were computed. */
  ranking_scope: "emitted_pack";
  available_signals: readonly string[];
  entries: ContextExplainEntry[];
}

/**
 * Build the `--explain` report from the SDK relevance model for the emitted
 * pack. Ranks and normalized scores are relative to this supplied population,
 * not the complete workspace corpus.
 */
export function buildContextExplain(items: readonly PmItem[], options: SdkRankOptions): ContextExplainReport {
  const report = scoreContextItems(items, options);
  return {
    generatedAt: options.now,
    model: report.model,
    ranking_scope: "emitted_pack",
    available_signals: report.available_signals,
    entries: report.ranked.map((ranked) => ({
      id: ranked.id,
      rank: ranked.rank,
      score: ranked.score,
      contributions: ranked.contributions,
    })),
  };
}

/**
 * Render a {@link ContextExplainReport} as an agent-readable Markdown brief.
 *
 * Each focus item is listed with its relevance rank, normalized score, and the
 * per-signal contributions that produced it (sorted most-contributing first), so
 * an agent can judge whether the pack is trustworthy before acting on it.
 */
export function renderContextExplain(report: ContextExplainReport, options: { compress?: boolean } = {}): string {
  const lines: string[] = [
    "# pm context explain",
    "",
    `Generated: ${report.generatedAt}`,
    `Model: ${report.model}`,
    "Ranking scope: emitted pack (not workspace-wide)",
    `Signals: ${report.available_signals.join(", ")}`,
    "",
    "## Relevance",
    "",
  ];
  if (report.entries.length === 0) {
    lines.push("_No focus items to explain._", "");
  } else {
    for (const entry of report.entries) {
      const contributions = Object.entries(entry.contributions)
        .sort((a, b) => b[1] - a[1])
        .map(([signal, value]) => `${signal}=${value.toFixed(3)}`)
        .join(", ");
      lines.push(`- **${entry.id}** rank ${entry.rank} score ${entry.score.toFixed(3)} — ${contributions}`);
    }
    lines.push("");
  }
  let output = `${lines.join("\n")}\n`;
  if (options.compress) {
    output = `${output.split("\n").filter((line) => line.trim() !== "").join("\n")}\n`;
  }
  return output;
}

/**
 * Resolve the SDK relevance rank options for one command invocation.
 *
 * Builds the workspace lifecycle status registry from pm settings (falling
 * back to the built-in registry when the tracker has no settings file), pins a
 * stable clock, and — when an author is resolvable — pulls decayed
 * served-then-used affinity from the SDK context-usage store so the relevance
 * model's `usage_affinity` signal reflects real agent feedback.
 */
async function resolveSdkRankOptions(ctx: CommandHandlerContext): Promise<SdkRankOptions> {
  const now = new Date().toISOString();
  let statusRegistry: RuntimeStatusRegistry;
  try {
    // readSettings returns built-in defaults even for an uninitialized tracker,
    // so this yields a valid registry for any real workspace root.
    const settings = await readSettings(ctx.pm_root);
    statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  } catch (err) {
    throw new CommandError(`Could not resolve workspace status registry for relevance ranking: ${err instanceof Error ? err.message : String(err)}`);
  }
  const author = stringOption(ctx.options ?? {}, "author") ?? ctx.global?.author;
  let usageAffinity: Readonly<Record<string, number>> | undefined;
  if (author) {
    try {
      const affinity = await readContextUsageAffinity({ pmRoot: ctx.pm_root, author });
      usageAffinity = affinity.affinity;
    } catch {
      // No ledger yet, or unreadable; ranking proceeds without usage affinity.
      usageAffinity = undefined;
    }
  }
  return { statusRegistry, now, author, usageAffinity };
}

/**
 * Record a context-serving event to pm's own context-usage ledger.
 *
 * This closes the feedback loop: every emitted focus and neighborhood item
 * becomes an included `serve` row in the same `runtime/context-usage.jsonl`
 * pm's `usage_affinity` signal reads, so a later
 * `pm context-usage --author <agent>` can report whether the served context was
 * actually touched. Skipped silently when no author is resolvable, since the
 * ledger is per-author.
 */
async function recordPackServing(ctx: CommandHandlerContext, focus: readonly PmItem[], neighbors: readonly PmItem[]): Promise<void> {
  const author = stringOption(ctx.options ?? {}, "author") ?? ctx.global?.author;
  if (!author) return;
  const rows: ContextUsageServingRow[] = [
    ...focus.map((item, index) => ({ id: item.id, rank: index + 1, included: true })),
    ...neighbors.map((item, index) => ({ id: item.id, rank: focus.length + index + 1, included: true })),
  ];
  if (rows.length === 0) return;
  try {
    await recordContextUsageServing({
      pmRoot: ctx.pm_root,
      author,
      surface: "context",
      profile: "context",
      rows,
    });
  } catch {
    // Recording is best-effort: a ledger write failure must not break a pack.
  }
}

function setupCommands(api: ExtensionApi): void {
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
      "pm context-pack --status in_progress --explain",
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
      { long: "--explain", description: "Explain emitted items with ranks/scores relative to the packed subset instead of emitting a pack", type: "boolean" },
    ],
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
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
      const explain = boolOption(options, "explain");
      const sections = validateSections(format, [...asArray(options.section), ...asArray(options.sections)]);
      const items = await readPmItems(ctx.pm_root);
      const rankOptions = await resolveSdkRankOptions(ctx);
      const ranker = createSdkRanker(items, rankOptions);
      // Pre-rank the full corpus so the token-budgeted packer has relevance ranks
      // for both focus and neighbor candidates before buildContextPack trims.
      let packer: ContextPackOptions["packer"];
      if (maxItems) {
        const rankedAll = rankContextItems(items, rankOptions);
        packer = createSdkPacker(rankedAll, rankedAll);
      }
      const pack = buildContextPack(items, {
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
        ranker,
        packer,
      });
      if (explain) {
        const explainReport = buildContextExplain([...pack.items, ...pack.neighbors], rankOptions);
        const output = format === "json"
          ? `${JSON.stringify(explainReport, null, compress ? 0 : 2)}\n`
          : renderContextExplain(explainReport, { compress });
        const outputPath = stringOption(options, "output");
        if (outputPath) {
          writeFileSync(outputPath, output, "utf-8");
          return { ok: true, format: format === "json" ? "json" : "markdown", explained: explainReport.entries.length };
        }
        return renderedCommandResult(output);
      }
      await recordPackServing(ctx, pack.items, pack.neighbors);
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
        const reportedFormat = requestedFormat === "compact" ? "compact" : format;
        return format === "json" ? pack : { ok: true, format: reportedFormat, selected: pack.summary.selectedItems, neighbors: pack.summary.neighborItems };
      }
      return renderedCommandResult(output);
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
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
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
      const items = await readPmItems(ctx.pm_root);
      const rankOptions = await resolveSdkRankOptions(ctx);
      const ranker = createSdkRanker(items, rankOptions);
      let packer: ContextPackOptions["packer"];
      if (maxItems) {
        const rankedAll = rankContextItems(items, rankOptions);
        packer = createSdkPacker(rankedAll, rankedAll);
      }
      const pack = buildContextPack(items, {
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
        ranker,
        packer,
      });
      await recordPackServing(ctx, pack.items, pack.neighbors);
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
        return {
          ok: true,
          format: format === "json" ? "json" : "agent",
          selected: pack.summary.selectedItems,
          neighbors: pack.summary.neighborItems,
          defaultedStatus: selection.inferredStatus ? selection.status : undefined,
        };
      }
      return renderedCommandResult(output);
    },
  });

  api.registerCommand({
    name: "context-usage",
    description: "Report which items pm context/next served and which of those were actually touched.",
    intent: "measure whether served context is being used",
    examples: [
      "pm context-usage",
      "pm context-usage --format json",
      "pm context-usage --surface next --since 7d",
      "pm context-usage --by agent-a --limit 50",
    ],
    flags: [
      { long: "--by", value_name: "author", description: "Restrict to one recording author", type: "string" },
      { long: "--surface", value_name: "surface", description: "Restrict serve events to one surface: context or next", type: "string" },
      { long: "--since", value_name: "when", description: "Drop events at or before this point (ISO timestamp, or a day offset such as 7d)", type: "string" },
      { long: "--limit", value_name: "n", description: `Maximum per-item rows (default: ${DEFAULT_REPORT_LIMIT})`, type: "string" },
      { long: "--format", value_name: "format", description: "Output format: markdown or json (default: markdown)", type: "string" },
    ],
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options ?? {};
      const requestedFormat = stringOption(options, "format")?.toLowerCase();
      if (requestedFormat && requestedFormat !== "markdown" && requestedFormat !== "json") {
        throw new CommandError("--format must be markdown or json", EXIT_CODE.USAGE);
      }
      const surface = stringOption(options, "surface")?.toLowerCase();
      if (surface && surface !== "context" && surface !== "next") {
        throw new CommandError("--surface must be context or next", EXIT_CODE.USAGE);
      }
      const rawSince = stringOption(options, "since");
      const since = rawSince === undefined ? undefined : resolveSince(rawSince);
      if (rawSince !== undefined && since === null) {
        throw new CommandError(`--since '${rawSince}' is not an ISO timestamp or a day offset such as 7d`, EXIT_CODE.USAGE);
      }
      // This is a *filter* over recorded ledger events ("whose usage to report"),
      // which is a different concept from pm's host-owned global `--author`
      // ("override mutation author for this invocation"). Reusing the global
      // would silently narrow every report to the invoking agent, so this keeps
      // a distinct `--by`.
      const author = stringOption(options, "by");
      const report = reportContextUsage(ctx.pm_root, {
        author,
        surface,
        since: since ?? undefined,
        limit: intOption(options, "limit", DEFAULT_REPORT_LIMIT),
      });
      // When an author is selected, fold in pm's own decayed served-then-touched
      // affinity from the SDK context-usage store. This is the same `usage_affinity`
      // signal the relevance model consumes, surfaced directly so an agent can see
      // which items its prior touches reinforced — without this module re-implementing
      // pm's decay model. The event-based waste/misses/conversion report stays because
      // the SDK does not expose the raw ledger event stream (see SDK_PROBLEMS).
      let affinity: { affinity: Record<string, number>; positive_judgments: number; serving_events: number } | undefined;
      if (author) {
        try {
          affinity = await readContextUsageAffinity({ pmRoot: ctx.pm_root, author });
        } catch {
          affinity = undefined;
        }
      }
      const reportWithAffinity = affinity ? { ...report, affinity } : report;
      // pm's global --json owns that flag name, so a command-level alias would be
      // silently shadowed and never populate ctx.options. Read the global instead,
      // so `pm context-usage --json` returns the raw report as an agent expects.
      const wantsJson = requestedFormat === "json" || ctx.global?.json === true;
      return wantsJson ? reportWithAffinity : renderedCommandResult(renderUsageReport(reportWithAffinity));
    },
  });
}

/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * This package resolves `@unbrained/pm-cli` at runtime for the `sdk/core` and
 * `sdk/query` engines (it is a peer dependency the pm host provides), but
 * `defineExtension` itself is a pure identity with no runtime behavior, so a
 * local shim avoids a needless value import while still contract-checking the
 * extension object against {@link ExtensionModule} exactly as the imported
 * helper would.
 */
const defineExtension = <TModule extends ExtensionModule>(module: TModule): TModule => module;

export default defineExtension({
  name: "pm-context",
  version: "2026.7.29",
  description: "Generate deterministic pm context packs for agent handoffs, reviews, and status briefs",
  activate(api: ExtensionApi) {
    setupCommands(api);
    if (typeof api.registerRenderer === "function") {
      api.registerRenderer("toon", renderCommandResult);
      api.registerRenderer("json", renderCommandResult);
    }
  },
});
