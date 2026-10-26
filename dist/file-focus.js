import { buildSuggestedCommand } from "./suggested-command.js";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, posix, relative, win32 } from "node:path";
import { readdir } from "node:fs/promises";
import { PmCliError, getActiveExtensionRegistrations, readLocatedItem, readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
/** Actionable usage failure from Git discovery or path validation. */
export class FileFocusError extends PmCliError {
    exitCode = 2;
    constructor(code, message, options, retryArgv) {
        const retry = retryArgv === undefined ? undefined : buildSuggestedCommand(retryArgv);
        super(message, 2, { code, ...(retry ? { nextSteps: ["Use the structured retry after repairing the unreadable documents."], recovery: { suggested_retry: retry.command, suggested_retry_args: retry.argv } } : {}) });
        this.cause = options?.cause;
        this.code = code;
    }
}
/** Run read-only Git with inherited repository routing and index variables removed. */
function git(cwd, args) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
}
/** Convert native or slash-separated links to safe paths relative to the repository root. */
export function normalizeFocusPath(value, root) {
    value = value.replace(/\r?\n$/, "");
    if (!value || /^[a-z][a-z\d+.-]*:\/\//i.test(value))
        return undefined;
    let path = value.replace(/\\/g, "/");
    const normalizedRoot = root.replace(/\\/g, "/");
    if (win32.isAbsolute(path) && (/^[A-Za-z]:/.test(path) || path.startsWith("//"))) {
        path = win32.relative(normalizedRoot, path).replace(/\\/g, "/");
        if (win32.isAbsolute(path))
            return undefined;
    }
    else if (isAbsolute(path)) {
        path = relative(root, path).replace(/\\/g, "/");
    }
    path = posix.normalize(path).replace(/\/$/, "");
    if (path === ".." || path.startsWith("../"))
        return undefined;
    return path;
}
/** Check tracker containment using repository-relative paths on native and Windows roots. */
export function isTrackerPath(path, pmRoot, repoRoot) {
    const tracker = normalizeFocusPath(pmRoot, repoRoot);
    const normalized = normalizeFocusPath(path, repoRoot);
    if (tracker === undefined || normalized === undefined)
        return false;
    const [directory, file] = /^[A-Za-z]:/.test(repoRoot) || repoRoot.replace(/\\/g, "/").startsWith("//")
        ? [tracker.toLowerCase(), normalized.toLowerCase()] : [tracker, normalized];
    return directory === "." || file === directory || file.startsWith(`${directory}/`);
}
/** Resolve --changed and repeated --files using real Git; an empty working set remains an active filter. */
export function resolveFileFocus(options, args, cwd, pmRoot, sourceCwd = cwd) {
    const changed = options.changed !== undefined && options.changed !== false;
    const explicit = options.files === undefined ? [] : Array.isArray(options.files) ? options.files.map(String) : [String(options.files)];
    if (!changed && explicit.length === 0) {
        if (args.length)
            throw new FileFocusError("INVALID_FILE_FOCUS", "A base argument requires --changed. Use --changed <base> or --files <path>.");
        return undefined;
    }
    if (args.length > 1 || (!changed && args.length > 0))
        throw new FileFocusError("INVALID_FILE_FOCUS", "Pass one base with --changed, or repeat --files <path>.");
    // Older hosts trim their root context. Recover it only when the actual working
    // repository matches that context, preserving portable roots for other repos.
    const sourceRoot = git(sourceCwd, ["rev-parse", "--show-toplevel"])?.replace(/\n$/, "");
    const root = sourceRoot?.trimEnd() === cwd ? sourceRoot
        : git(cwd, ["rev-parse", "--show-toplevel"])?.replace(/\n$/, "");
    if (!root)
        throw new FileFocusError("NOT_GIT_REPOSITORY", "File focus requires a Git working repository. Run from the repository containing the changed files.");
    const files = new Set();
    const refresh_argv = [];
    if (changed) {
        const base = typeof options.changed === "string" ? options.changed : args[0] ?? git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.trim() ?? "main";
        const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])?.trim();
        const mergeBase = commit && git(root, ["merge-base", commit, "HEAD"])?.trim();
        if (!mergeBase)
            throw new FileFocusError("UNKNOWN_BASE", "Cannot resolve the Git base or a common ancestor with HEAD. Fetch the base branch, then use --changed <known-base>.");
        for (const command of [
            ["diff", "--name-only", "-z", "--no-renames", mergeBase, "--"],
            ["diff", "--name-only", "-z", "--no-renames", "--cached", "--"],
            ["diff", "--name-only", "-z", "--no-renames", "--"],
            ["ls-files", "--others", "--exclude-standard", "-z"],
        ]) {
            const output = git(root, command);
            if (output === undefined)
                throw new FileFocusError("GIT_FAILED", "Cannot read the Git working set. Check repository access and retry --changed.");
            for (const path of output.split("\0").filter(Boolean)) {
                if (!isTrackerPath(path, pmRoot, root))
                    files.add(path);
            }
        }
        refresh_argv.push("--changed", base);
    }
    for (const path of explicit) {
        const normalized = normalizeFocusPath(path, root);
        if (normalized === undefined)
            throw new FileFocusError("INVALID_FILE_FOCUS", "Each --files path must be inside the Git repository. Use repository-relative paths.");
        files.add(normalized);
        refresh_argv.push("--files", normalized);
    }
    const refresh = ` ${buildSuggestedCommand(refresh_argv).command}`;
    return { root, files: [...files].sort(), refresh, refresh_argv };
}
/** Match exact files and linked directory ancestors, retaining unique changed paths per item. */
export function matchFileFocus(items, focus, links) {
    const matches = new Map();
    for (const item of items) {
        const paths = links(item.files).map((path) => normalizeFocusPath(path, focus.root)).filter((path) => path !== undefined);
        const matched = focus.files.filter((file) => paths.some((path) => path === "." || file === path || file.startsWith(`${path}/`)));
        if (matched.length)
            matches.set(item.id, matched);
    }
    return matches;
}
/** Rank focus by unique overlap, lifecycle status, priority, then deterministic id. */
export function rankFileFocus(items, matches) {
    const status = { in_progress: 0, open: 1, blocked: 2, closed: 3 };
    return [...items].sort((a, b) => matches.get(b.id).length - matches.get(a.id).length
        || (status[String(a.status)] ?? 4) - (status[String(b.status)] ?? 4)
        || (a.priority ?? 2) - (b.priority ?? 2) || a.id.localeCompare(b.id));
}
/** Portable template used by both structured packets and the rendered linking hint. */
export function fileLinkCommand() { return buildSuggestedCommand(["pm", "files", "<id>", "--add", "path=<path>"]); }
/** Render the unlinked working set with a concrete tracker-linking hint. */
export function renderFileFocus(value) {
    if (!value.unlinked_changed_files)
        return [];
    return ["", "unlinked_changed_files:", ...value.unlinked_changed_files.map((path) => `- ${JSON.stringify(path)}`),
        `Link relevant paths with: ${fileLinkCommand().command}`,
        `argv: ${JSON.stringify(fileLinkCommand().argv)}`];
}
/** Enumerate all registered item folders through the canonical SDK parser without creating metadata caches. */
export async function readFileFocusItems(pmRoot) {
    let itemPath = pmRoot;
    try {
        const settings = await readSettings(pmRoot);
        const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
        const items = new Map();
        for (const folder of registry.folders) {
            const type = registry.types.find((name) => registry.type_to_folder[name] === folder);
            itemPath = join(pmRoot, folder);
            const entries = await readdir(itemPath, { withFileTypes: true }).catch((error) => {
                if (error.code === "ENOENT")
                    return [];
                throw error;
            });
            for (const entry of entries) {
                if (!entry.isFile() || !/\.(toon|md)$/.test(entry.name))
                    continue;
                const format = entry.name.endsWith(".toon") ? "toon" : "json_markdown";
                const id = entry.name.replace(/\.(toon|md)$/, "");
                itemPath = join(pmRoot, folder, entry.name);
                const { document } = await readLocatedItem({ id, type, itemPath, item_format: format }, { schema: settings.schema });
                if (items.has(document.metadata.id))
                    throw new Error(`Duplicate item identity: ${document.metadata.id}`);
                items.set(document.metadata.id, { ...document.metadata, body: document.body });
            }
        }
        return [...items.values()];
    }
    catch (error) {
        const detail = String(error);
        throw new FileFocusError("TRACKER_READ_FAILED", `Cannot completely read tracker items at ${itemPath}: ${detail}. Resolve unreadable or duplicate documents before retrying file focus.`, { cause: error }, ["pm", "validate"]);
    }
}
//# sourceMappingURL=file-focus.js.map