/** Verified, budgeted net changes for one item since a recorded claim. */
import { isDeepStrictEqual } from "node:util";
import { createOutputOmissionReceipt, encodeToon, estimatePmOutputTokens, fitOutputEnvelope, getHistoryPath, locateItem, PmCliError, readHistoryEntries, readLocatedItem, readSettingsWithMetadata, replayHistoryToTarget, resolveContextIntentContract, resolveItemTypeRegistry, verifyHistoryEntries, } from "@unbrained/pm-cli/sdk";
import { buildSuggestedCommand } from "./suggested-command.js";
/** Package intent for resuming an item with a previous claim in its retained history. */
export const CLAIM_RESUME_INTENT = {
    command: "context-resume",
    intent: "resume",
    description: "Read current item state and net field changes since the selected author's recorded claim.",
    included_field_groups: ["item", "claim", "head", "changes"],
    token_budget: 1600,
    source: "package",
};
const auditFields = new Set(["author", "claim_principal", "created_at", "id", "pm_format_version", "updated_at"]);
const resumeOrder = [
    "status", "assignee", "blocked_by", "blocked_reason", "dependencies", "title", "priority",
    "acceptance_criteria", "comments", "notes", "learnings", "description", "body",
    "files", "docs", "tests", "test_runs",
];
/** Construct a bounded user-facing recovery error without echoing source paths or payloads. */
function refusal(code, message, remedy) {
    return new PmCliError(message, 2, { code, nextSteps: [remedy] });
}
/** Read the live item and its append-only stream through the SDK's read-only primitives. */
async function readClaimSource(pmRoot, id) {
    try {
        const { settings, warnings } = await readSettingsWithMetadata(pmRoot);
        const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
        if (!located || warnings.length)
            throw new Error("Item source unavailable");
        const itemWarnings = [];
        const [{ document }, history] = await Promise.all([
            readLocatedItem(located, { schema: settings.schema, warnings: itemWarnings }),
            readHistoryEntries(getHistoryPath(pmRoot, located.id), located.id),
        ]);
        if (itemWarnings.length)
            throw new Error("Item source incomplete");
        return { document, history };
    }
    catch {
        throw refusal("RESUME_SOURCE_UNAVAILABLE", "Could not read the item and its history.", "Check the item id and tracker settings, then inspect pm history <id> --verify.");
    }
}
/** Derive one lossless field operation, reusing array prefixes only when they match exactly. */
function fieldChange(field, before, after) {
    if (!Object.hasOwn(after, field))
        return { field, op: "remove" };
    const previous = before[field];
    const value = after[field];
    if (Array.isArray(previous) && Array.isArray(value) && value.length > previous.length
        && previous.every((entry, index) => isDeepStrictEqual(entry, value[index]))) {
        return { field, op: "append", from_length: previous.length, entries: value.slice(previous.length) };
    }
    return { field, op: "set", value };
}
/** Build a read-only claim-bound brief and fit whole field changes under its transport budget. */
export async function buildClaimResume(request, pmRoot) {
    const { id, author, intent = "resume", tokenBudget, format = "toon" } = request;
    if (typeof intent !== "string")
        throw refusal("INVALID_RESUME_REQUEST", "Supply a named resume intent.", "See pm context-resume --help.");
    const projection = resolveContextIntentContract("context-resume", intent, [CLAIM_RESUME_INTENT]);
    const budget = tokenBudget ?? projection.token_budget;
    if (typeof id !== "string" || !id.trim() || typeof author !== "string" || !author.trim()
        || !Number.isSafeInteger(budget) || budget < 128 || budget > 65536 || (format !== "json" && format !== "toon")) {
        throw refusal("INVALID_RESUME_REQUEST", "Supply an item id, a claim author, and an optional integer token budget from 128 to 65536.", "See pm context-resume --help.");
    }
    const { document, history } = await readClaimSource(pmRoot, id);
    let claimIndex = history.length - 1;
    for (; claimIndex >= 0; claimIndex--) {
        const entry = history[claimIndex];
        if (entry.op === "claim" && entry.author === author)
            break;
    }
    if (claimIndex < 0) {
        throw refusal("RESUME_CLAIM_UNAVAILABLE", "No retained claim matches the selected author on this item.", "Check the author with pm history <id> --compact, or inspect current context with pm get <id> --for inspect.");
    }
    const itemId = document.metadata.id;
    const claimEntry = history[claimIndex];
    const headEntry = history.at(-1);
    const claimVersion = claimIndex + 1;
    const headVersion = history.length;
    const unverified = () => refusal("RESUME_HISTORY_UNVERIFIED", "Could not verify both endpoints for the selected claim.", "Retry if the item just changed. Inspect pm history <id> --verify before relying on a delta.");
    if (!verifyHistoryEntries(history, document).ok)
        throw unverified();
    const baseline = replayHistoryToTarget(history, claimIndex);
    if (baseline.metadata.id !== itemId)
        throw unverified();
    const before = { ...baseline.metadata, body: baseline.body };
    const after = { ...document.metadata, body: document.body };
    const changedFields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
        .filter((field) => Object.hasOwn(before, field) !== Object.hasOwn(after, field)
        || !isDeepStrictEqual(before[field], after[field]));
    const omittedAuditFields = changedFields.filter((field) => auditFields.has(field));
    const workFields = changedFields.filter((field) => !auditFields.has(field));
    const fields = [...resumeOrder.filter((field) => workFields.includes(field)), ...workFields.filter((field) => !resumeOrder.includes(field))];
    const changes = fields.map((field) => fieldChange(field, before, after));
    const { title, status, priority, assignee } = document.metadata;
    const [restoreClaim, restoreHead] = [claimVersion, headVersion].map((version) => buildSuggestedCommand([
        "pm", "get", itemId, "--at", String(version), "--full", "--output-budget", "unbounded", "--json",
    ]));
    try {
        const fitted = fitOutputEnvelope(changes, {
            tokenBudget: budget,
            estimateTokens: (text) => estimatePmOutputTokens(Buffer.byteLength(text)),
            policy: "skip",
            buildEnvelope(rows, fit) {
                const included = new Set(fit.included_indices);
                const deferred = fields.filter((_field, index) => !included.has(index));
                const groups = [];
                if (omittedAuditFields.length)
                    groups.push({ name: "audit_fields", restore_with: restoreHead.command });
                if (deferred.length)
                    groups.push({ name: "deferred_fields", restore_with: restoreHead.command });
                return {
                    version: 1,
                    intent: CLAIM_RESUME_INTENT.intent,
                    item: { id: itemId, title, status, priority, assignee: assignee ?? null },
                    claim: { version: claimVersion, at: claimEntry.ts, item_hash: claimEntry.after_hash, author },
                    head: { version: headVersion, at: headEntry.ts, item_hash: headEntry.after_hash },
                    changes: rows,
                    omission_receipt: {
                        ...createOutputOmissionReceipt(groups),
                        audit_fields: omittedAuditFields,
                        deferred_fields: deferred,
                        ...(groups.length ? { restore_argv: { claim: restoreClaim.argv, head: restoreHead.argv } } : {}),
                    },
                };
            },
            renderers: {
                [format]: (packet) => format === "json" ? `${JSON.stringify(packet)}\n` : `${encodeToon(packet)}\n`,
            },
        });
        return { packet: fitted.envelope, text: fitted.renderings[0].text };
    }
    catch {
        throw refusal("RESUME_BUDGET_REFUSED", "Could not render the verified resume brief and its receipt within the requested budget.", "Increase --token-budget or use pm get <id> --for inspect and pm history <id> --verify.");
    }
}
//# sourceMappingURL=claim-resume.js.map