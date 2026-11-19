import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createHistoryEntry, decodeToon, emptyImportedDocument, estimatePmOutputTokens,
  getItemAt, historyCompact, init, readAuthorEnvironment, replayHistoryToTarget, schemaAddField, verifyHistoryEntries, writeAuthorEnvironment,
} from "@unbrained/pm-cli/sdk";
import type { HistoryEntry } from "@unbrained/pm-cli/sdk";
import { claim, comments, create, release, update } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildClaimResume } from "../index.ts";
import type { ClaimResumePacket, ClaimResumeRequest } from "../index.ts";

const author = "resume-agent";
const other = "other-agent";

/** Set up real SDK storage with an item whose stable inputs predate all claims. */
async function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "claim-resume-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = join(cwd, ".agents", "pm");
  const client = { cwd, pmRoot };
  await init("resume", { defaults: true, author, agentGuidance: "skip" }, client);
  const { item: { id } } = await create({
    title: "Resume this task", author, description: "Stable background", body: "Original body",
    tags: "old-tag", reviewer: "review-agent", comment: ["text=The known prefix"],
  }, client);
  const history = join(pmRoot, "history", `${id}.jsonl`);
  const itemPath = join(pmRoot, "tasks", `${id}.toon`);
  const build = (options: Partial<ClaimResumeRequest> = {}) => buildClaimResume({ id, author, ...options }, pmRoot);
  return { id, client, history, itemPath, build };
}

/** Match stable error codes without tying assertions to SDK class bundling. */
function code(expected: string) {
  return (value: unknown) => (value as { code?: string }).code === expected;
}

test("selects the latest claim by exact author and returns only net field changes", async (t) => {
  const f = await fixture(t);
  await claim(f.id, { author, start: true }, f.client);
  await comments(f.id, { add: "After first claim", author }, f.client);
  await release(f.id, { author }, f.client);
  await claim(f.id, { author }, f.client);
  const anchor = (await f.build({ format: "json" })).packet;
  assert.equal(anchor.claim.version, anchor.head.version);
  assert.deepEqual(anchor.changes, []);
  assert.equal(anchor.omission_receipt.has_omissions, false);

  await update(f.id, { body: "Temporary rewrite", author }, f.client);
  await update(f.id, { body: "Original body", unset: ["reviewer"], tags: "new-tag", author }, f.client);
  await comments(f.id, { add: "Work completed since the last claim 🧪", author }, f.client);
  await release(f.id, { author }, f.client);
  const released = (await f.build()).packet;
  assert.equal(released.item.assignee, null);
  assert.deepEqual(released.changes[0], { field: "assignee", op: "remove" });
  await claim(f.id, { author: other }, f.client);
  const { packet, text } = await f.build({ format: "json" });
  assert.deepEqual(packet.claim, anchor.claim);
  assert.equal(packet.item.status, "in_progress");
  assert.equal(packet.item.assignee, other);
  assert.ok(packet.head.version > packet.claim.version);
  assert.notEqual(packet.head.item_hash, packet.claim.item_hash);
  assert.deepEqual(packet.changes.map((change) => [change.field, change.op]), [
    ["assignee", "set"], ["comments", "append"], ["reviewer", "remove"], ["tags", "set"],
  ]);
  const appended = packet.changes.find((change) => change.op === "append")!;
  assert.equal(appended.from_length, 2);
  assert.equal(appended.entries.length, 1);
  assert.match(JSON.stringify(appended.entries), /Work completed since the last claim 🧪/);
  assert.ok(!text.includes("Stable background"));
  assert.ok(!text.includes("Temporary rewrite"));
  assert.ok(!text.includes("After first claim"));
  assert.deepEqual(packet.omission_receipt.audit_fields, ["claim_principal", "updated_at"]);
  assert.deepEqual(JSON.parse(text), packet);
  assert.deepEqual((await f.build({ author: other })).packet.changes, []);
});

test("budgets the complete encoding, skipping a large field without hiding smaller changes", async (t) => {
  const f = await fixture(t);
  await claim(f.id, { author }, f.client);
  await update(f.id, { status: "in_progress", body: "🧪 é\n".repeat(1200), author }, f.client);
  await comments(f.id, { add: "Small new note", author }, f.client);
  for (const format of ["json", "toon"] as const) {
    const { packet, text } = await f.build({ format, tokenBudget: 600 });
    assert.deepEqual(packet.changes.map((change) => change.field), ["status", "comments"]);
    assert.deepEqual(packet.omission_receipt.deferred_fields, ["body"]);
    assert.equal(packet.output_fit.omitted_count, 1);
    assert.equal(packet.output_fit.output_bytes, Buffer.byteLength(text));
    assert.equal(packet.output_fit.estimated_tokens, estimatePmOutputTokens(Buffer.byteLength(text)));
    assert.ok(packet.output_fit.estimated_tokens <= 600);
    const exact = await f.build({ format, tokenBudget: packet.output_fit.estimated_tokens });
    assert.deepEqual(exact.packet.changes, packet.changes);
    assert.ok(exact.packet.output_fit.estimated_tokens <= exact.packet.output_fit.token_budget);
    const full = await f.build({ format, tokenBudget: 16000 });
    assert.equal(full.packet.output_fit.omitted_count, 0);
    assert.match(full.text, /🧪/);
  }
  await assert.rejects(f.build({ tokenBudget: 128 }), code("RESUME_BUDGET_REFUSED"));
});

test("refuses invalid requests, absent claims, and an item whose history disagrees with disk", async (t) => {
  const f = await fixture(t);
  for (const options of [
    { id: "" }, { id: null as never }, { author: " " }, { author: true as never },
    { intent: null as never }, { tokenBudget: 127 }, { tokenBudget: 70000 },
    { tokenBudget: 800.25 }, { format: "yaml" as never },
  ]) {
    await assert.rejects(f.build(options), code("INVALID_RESUME_REQUEST"));
  }
  await assert.rejects(f.build({ intent: "inspect" }), code("unknown_context_intent"));
  await assert.rejects(f.build({ id: "resume-missing" }), code("RESUME_SOURCE_UNAVAILABLE"));
  await assert.rejects(f.build(), code("RESUME_CLAIM_UNAVAILABLE"));
  await claim(f.id, { author: other }, f.client);
  await assert.rejects(f.build({ author: other.toUpperCase() }), code("RESUME_CLAIM_UNAVAILABLE"));
  const item = readFileSync(f.itemPath, "utf8");
  writeFileSync(f.itemPath, item.replace("Resume this task", "Edited outside history"));
  await assert.rejects(f.build({ author: other }), code("RESUME_HISTORY_UNVERIFIED"));
  const settingsPath = join(f.client.pmRoot, "settings.json");
  const settingsText = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(settingsText);
  writeFileSync(settingsPath, JSON.stringify({ ...settings, schema: { ...settings.schema, unknown_field_policy: "warn" } }));
  writeFileSync(f.itemPath, item.replace(/(title: [^\n]+\n)/u, "$1unknown_resume_metadata: extra\n"));
  await assert.rejects(f.build({ author: other }), code("RESUME_SOURCE_UNAVAILABLE"));
  writeFileSync(settingsPath, settingsText);
  writeFileSync(f.itemPath, item);
  await historyCompact(f.id, { author: other }, f.client);
  await assert.rejects(f.build({ author: other }), code("RESUME_CLAIM_UNAVAILABLE"));
});

test("refuses verified legacy streams whose selected claim belongs to an earlier identity", async (t) => {
  const f = await fixture(t);
  await claim(f.id, { author }, f.client);
  const unclaimed = (await getItemAt(f.id, "1", f.client)).document;
  const current = (await getItemAt(f.id, "2", f.client)).document;
  const empty = emptyImportedDocument();
  const priorIdentity = { ...current, metadata: { ...current.metadata, id: "resume-earlier-identity" } };
  const nowIso = "2026-01-01T00:00:00Z";
  const event = (op: string, before: typeof current, after: typeof current) =>
    createHistoryEntry({ op, before, after, nowIso, author });
  const streams = [
    [event("create", empty, unclaimed), event("claim", unclaimed, current), event("delete", current, empty), event("create", empty, current)],
    [event("create", empty, unclaimed), event("claim", unclaimed, priorIdentity), event("update", priorIdentity, current)],
  ];
  assert.match(verifyHistoryEntries(streams[0]!, current).errors.join(", "), /duplicate_create/u);
  const changedId = verifyHistoryEntries(streams[1]!, current);
  assert.equal(changedId.ok, true, changedId.errors.join(", "));
  for (const entries of streams) {
    writeFileSync(f.history, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await assert.rejects(f.build(), code("RESUME_HISTORY_UNVERIFIED"));
  }
});

test("real SDK command dispatch honors explicit, global and environment claim authors", async (t) => {
  const f = await fixture(t);
  await claim(f.id, { author }, f.client);
  const runner = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
  t.after(() => runner.deactivate());
  const previousAuthor = readAuthorEnvironment();
  t.after(() => writeAuthorEnvironment(previousAuthor));
  const command = { command: "context-resume", pmRoot: f.client.pmRoot, args: [f.id] };

  writeAuthorEnvironment(other);
  for (const invocation of [
    { options: { claimAuthor: author, for: "resume", tokenBudget: 600 }, global: { author: other, json: true } },
    { options: {}, global: { author, json: false } },
  ]) {
    const result = await runner.runCommand({ ...command, ...invocation });
    assert.equal(result.handled, true);
    const { output } = result.result as { output: string };
    const packet = (invocation.global.json ? JSON.parse(output) : decodeToon(output)) as ClaimResumePacket;
    assert.equal(packet.claim.author, author);
    assert.equal(packet.output_fit.token_budget, invocation.options.tokenBudget ?? 1600);
  }
  writeAuthorEnvironment(author);
  const implicit = await runner.runCommand({ ...command, global: { json: true } });
  assert.equal(implicit.handled, true);
  assert.equal(JSON.parse((implicit.result as { output: string }).output).claim.author, author);
  writeAuthorEnvironment(undefined);
  await assert.rejects(runner.runCommand(command), code("INVALID_RESUME_REQUEST"));
});

test("installed CLI uses real tracker history and restores deferred data by version without Git", async (t) => {
  const f = await fixture(t);
  await schemaAddField("custom_signal", { type: "string", cliFlag: "custom-signal", commands: ["update"], author }, f.client);
  await schemaAddField("notes_count", { type: "string", cliFlag: "stored-notes-count", commands: ["update"], author }, f.client);
  const initial = { customSignal: "Initial signal", storedNotesCount: "Initial stored field", author };
  await update(f.id, initial, f.client);
  await claim(f.id, { author }, f.client);
  const updated = {
    body: "🧪 changed body ".repeat(600), customSignal: "Current signal ".repeat(200),
    storedNotesCount: "Current stored field ".repeat(200), author,
  };
  await update(f.id, updated, f.client);
  await comments(f.id, { add: "Large deferred collection entry ".repeat(300), author }, f.client);
  const packageRoot = resolve(import.meta.dirname, "..");
  const installed = join(f.client.pmRoot, "extensions", "pm-context");
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const noGit = join(f.client.cwd, "no-git");
  mkdirSync(noGit);
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM_"))),
    PM_PATH: f.client.pmRoot, PM_AUTHOR: author, PATH: noGit, GIT_CEILING_DIRECTORIES: tmpdir(),
  };
  /** Execute the installed command or its returned recovery argv through the real host CLI. */
  const run = (args: string[], invocationAuthor = author) => spawnSync(process.execPath, [cli, ...args], {
    cwd: f.client.cwd, env: { ...env, PM_AUTHOR: invocationAuthor }, encoding: "utf8", timeout: 30000,
  });
  const before = [f.itemPath, f.history].map((path) => readFileSync(path, "utf8"));
  const toon = run(["context-resume", f.id, "--claim-author", author, "--for", "resume", "--token-budget", "600"]);
  assert.equal(toon.status, 0, toon.stderr);
  assert.deepEqual(decodeToon(toon.stdout), (await f.build({ tokenBudget: 600 })).packet);
  const json = run(["context-resume", f.id, "--token-budget", "600", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const packet = JSON.parse(json.stdout) as ClaimResumePacket;
  assert.deepEqual(packet, (await f.build({ tokenBudget: 600, format: "json" })).packet);
  assert.deepEqual(packet.omission_receipt.deferred_fields, ["comments", "body", "custom_signal", "notes_count"]);
  assert.deepEqual(packet.omission_receipt.raw_restore_fields, ["notes_count"]);
  const recovery = packet.omission_receipt.restore_argv!;
  const history = run(recovery.history!.slice(1));
  assert.equal(history.status, 0, history.stderr);
  const entries = (JSON.parse(history.stdout) as { history: HistoryEntry[] }).history;
  for (const side of ["claim", "head"] as const) {
    const revision = packet[side];
    const result = run(recovery[side].slice(1));
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout).item;
    const { document } = await getItemAt(f.id, String(revision.version), f.client);
    assert.equal(actual.body, document.body);
    assert.deepEqual(actual.comments, document.metadata.comments);
    const metadata = document.metadata as unknown as Record<string, unknown>;
    assert.equal(actual.custom_signal, metadata.custom_signal);
    assert.equal(entries[revision.version - 1]!.after_hash, revision.item_hash);
    const replay = replayHistoryToTarget(entries, revision.version - 1);
    assert.equal(replay.metadata.notes_count, metadata.notes_count);
  }

  const explicit = run(["context-resume", f.id, "--author", author, "--json"], other);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).claim.author, author);
  const noAuthor = run(["context-resume", f.id, "--json"], "");
  assert.equal(noAuthor.status, 2, noAuthor.stderr);
  assert.equal(JSON.parse(noAuthor.stderr).code, "INVALID_RESUME_REQUEST");

  const noMatch = run(["context-resume", f.id, "--claim-author", other, "--json"]);
  assert.equal(noMatch.status, 2, noMatch.stderr);
  assert.equal(JSON.parse(noMatch.stderr).code, "RESUME_CLAIM_UNAVAILABLE");
  const small = run(["context-resume", f.id, "--token-budget", "128", "--json"]);
  assert.equal(small.status, 2, small.stderr);
  assert.equal(JSON.parse(small.stderr).code, "RESUME_BUDGET_REFUSED");
  assert.deepEqual([f.itemPath, f.history].map((path) => readFileSync(path, "utf8")), before);
});
