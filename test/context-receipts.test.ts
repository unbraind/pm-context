import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { init } from "@unbrained/pm-cli/sdk";
import { create, files, update } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import builtExtension from "../dist/index.js";
import { normalizeReceiptFile, serveContextReceipt, recordReceiptUsage, reportContextReceipts, renderReceiptReport,
  RECEIPT_LIMITS, RECEIPTS_RELATIVE_PATH, type ContextReceipt, type ReceiptReport } from "../context-receipts.ts";

/** Create a real initialized tracker, two SDK items, and a governed extension harness. */
async function fixture(t: TestContext, built = false) {
  const root = mkdtempSync(join(tmpdir(), "context-receipts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = await init("usage", { defaults: true, author: "agent-a", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents", "pm") });
  const client = { cwd: root, pmRoot: initialized.path };
  const first = await create({ title: "Used fact", body: "Helpful body", author: "agent-a" }, client);
  const second = await create({ title: "Unused fact", author: "agent-a" }, client);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "used.ts"), 'export const state = "before";\n');
  await files(first.item.id, { add: ["src/used.ts"], author: "agent-a" }, client);
  const harness = await createExtensionTestHarness(built ? builtExtension : extension, {
    name: "pm-context", capabilities: ["commands", "renderers", "schema"],
  });
  t.after(() => harness.deactivate());
  assert.deepEqual(harness.activation.failed, []);
  /** Run a serving/report command with real tracker storage and explicit session identity. */
  const run = async (command: string, options: Record<string, unknown>, global: Record<string, unknown> = { author: "agent-a" }) => {
    const result = await harness.runCommand({ command, pmRoot: initialized.path, options, global });
    return (result as { result: { output: string } }).result.output;
  };
  return { root, pmRoot: initialized.path, first: first.item.id, second: second.item.id, client, run };
}

/** Extract a JSON command's receipt or the markdown footer identifier and runtime snapshot. */
function receiptFrom(output: string, pmRoot: string): ContextReceipt {
  if (output.startsWith("{")) return (JSON.parse(output) as { context_receipt: ContextReceipt }).context_receipt;
  const match = /Context receipt: ([\da-f-]{36})/.exec(output);
  assert.ok(match, "served text must expose a receipt");
  return JSON.parse(readFileSync(join(pmRoot, RECEIPTS_RELATIVE_PATH, `${match[1]}.json`), "utf8")) as ContextReceipt;
}

/** Read JSON receipt metrics from the command while leaving legacy metrics intact. */
function bundlesFrom(output: string): ReceiptReport {
  return (JSON.parse(output) as { bundles: ReceiptReport }).bundles;
}

test("built package acceptance: two served focus facts, one citation, isolated sessions, no tracked writes", async (t) => {
  const f = await fixture(t, true);
  const before = readFileSync(join(f.pmRoot, "history", `${f.first}.jsonl`), "utf8");
  const output = await f.run("context-pack", { ids: `${f.first},${f.second}`, section: "focus", session: "session-a" });
  const receipt = receiptFrom(output, f.pmRoot);
  assert.equal(receipt.facts.length, 2);
  const firstFact = receipt.facts.find((fact) => fact.item_ids.includes(f.first));
  assert.ok(firstFact);
  assert.ok(output.includes(`[${firstFact.id}]`));
  const independent = receiptFrom(await f.run("context-pack", { ids: `${f.first},${f.second}`, section: "focus", session: "session-b" }), f.pmRoot);
  assert.deepEqual(independent.facts.map((fact) => fact.id), receipt.facts.map((fact) => fact.id));
  assert.notEqual(independent.receipt_id, receipt.receipt_id);
  const reported = bundlesFrom(await f.run("context-usage", { receipt: receipt.receipt_id, session: "session-a", cite: firstFact.id, format: "json" }));
  assert.equal(reported.totals.served_facts, 2);
  assert.equal(reported.totals.used_facts, 1);
  assert.equal(reported.totals.precision, 0.5);
  assert.equal(reported.totals.cited_facts, 1);
  assert.ok(reported.totals.unused_context_tokens > 0);
  assert.equal(bundlesFrom(await f.run("context-usage", { session: "session-b", format: "json" })).totals.used_facts, 0);
  assert.equal(readFileSync(join(f.pmRoot, "history", `${f.first}.jsonl`), "utf8"), before);
  assert.ok(!readFileSync(join(f.pmRoot, "tasks", `${f.first}.toon`), "utf8").includes("pm-context-usage/v1"));
});

test("source serving paths expose rendered subset, links and idempotent citation/touch/edit metrics", async (t) => {
  const f = await fixture(t);
  for (const command of ["context-pack", "context-handoff"]) {
    const rendered = await f.run(command, { ids: `${f.first},${f.second}`, format: "json", session: command });
    const receipt = receiptFrom(rendered, f.pmRoot);
    assert.equal(receipt.session, command);
    const fact = receipt.facts.find((entry) => entry.item_ids.includes(f.first) && !entry.item_ids.includes(f.second));
    assert.ok(fact);
    await update(f.first, { title: "Changed after serving", author: "agent-a" }, f.client);
    writeFileSync(join(f.root, "src", "used.ts"), 'export const state = "after";\n');
    const args = { receipt: receipt.receipt_id, session: command, cite: fact.id, touch: f.first, "edited-file": "./src/used.ts", format: "json" };
    const first = bundlesFrom(await f.run("context-usage", args));
    const repeated = bundlesFrom(await f.run("context-usage", args));
    assert.deepEqual(repeated, first);
    assert.ok(first.totals.touch_facts > 0);
    assert.ok(first.totals.edit_facts > 0);
    assert.equal(first.totals.cited_facts, 1);
    assert.equal(first.items.find((item) => item.id === f.first)?.precision, 1);
    assert.ok((first.items.find((item) => item.id === f.second)?.precision ?? 1) < 1, "the second item still has unused independent facts");
  }
  const focusOnly = receiptFrom(await f.run("context-pack", { id: f.first, section: "summary", session: "summary" }), f.pmRoot);
  assert.ok(focusOnly.facts.every((fact) => fact.item_ids.length === 0 && fact.files.length === 0));
  await assert.rejects(f.run("context-usage", { receipt: focusOnly.receipt_id, touch: f.first }), /not served/);
  const handed = await f.run("context-handoff", { id: f.first, format: "compact", section: "focus" });
  assert.ok(handed.includes("[f-"));
  assert.ok(!handed.includes("src/used.ts"));
  assert.ok(!receiptFrom(handed, f.pmRoot).facts.some((fact) => fact.files.length > 0));
  const brief = await f.run("context-usage", {}, { author: "agent-a", json: false });
  assert.match(brief, /Bundle receipts/);
  assert.match(brief, /item-touch proxies/);
});

test("usage command rejects missing receipt, foreign ids, session mismatch and invalid paths atomically", async (t) => {
  const f = await fixture(t);
  const receipt = receiptFrom(await f.run("context-pack", { id: f.first, format: "json", session: "one" }), f.pmRoot);
  const fact = receipt.facts[0];
  for (const options of [
    { cite: fact.id }, { receipt: "../../outside", cite: fact.id },
    { receipt: "11111111-1111-1111-1111-111111111111", cite: fact.id },
    { receipt: receipt.receipt_id, session: "other", cite: fact.id },
    { receipt: receipt.receipt_id, cite: `${fact.id},f-unknown` },
    { receipt: receipt.receipt_id, touch: "missing" },
    { receipt: receipt.receipt_id, "edited-file": "src/other.ts" },
    { receipt: receipt.receipt_id, "edited-file": "../outside" },
  ]) await assert.rejects(f.run("context-usage", options));
  assert.equal(bundlesFrom(await f.run("context-usage", { receipt: receipt.receipt_id, format: "json" })).totals.used_facts, 0);
  // A section citation uses every fact in that section, including repeat flags.
  const report = bundlesFrom(await f.run("context-usage", { receipt: receipt.receipt_id, cite: [receipt.sections[0].id, fact.id], format: "json" }));
  assert.ok(report.totals.used_facts > 0);
});

test("serving writes measured output files, leaves explain observational, discloses runtime failure", async (t) => {
  const f = await fixture(t);
  for (const command of ["context-pack", "context-handoff"]) {
    const destination = join(f.root, `${command}.json`);
    await f.run(command, { id: f.first, format: "json", output: destination });
    assert.ok(receiptFrom(readFileSync(destination, "utf8"), f.pmRoot).receipt_id);
  }
  const retained = readdirSync(join(f.pmRoot, RECEIPTS_RELATIVE_PATH)).length;
  const explanation = await f.run("context-pack", { id: f.first, format: "json", explain: true });
  assert.ok(!explanation.includes("context_receipt"));
  assert.equal(readdirSync(join(f.pmRoot, RECEIPTS_RELATIVE_PATH)).length, retained);
  await assert.rejects(f.run("context-pack", { id: f.first, output: join(f.root, "absent", "pack.md") }));
  assert.equal(readdirSync(join(f.pmRoot, RECEIPTS_RELATIVE_PATH)).length, retained);
  mkdirSync(join(f.pmRoot, RECEIPTS_RELATIVE_PATH, ".lock"));
  assert.match(await f.run("context-pack", { id: f.first }), /receipt unavailable/);
  assert.match(await f.run("context-handoff", { id: f.first, format: "json" }), /context_receipt_error/);
  const unavailableOutput = join(f.root, "unavailable.json");
  await f.run("context-pack", { id: f.first, format: "json", output: unavailableOutput });
  assert.match(readFileSync(unavailableOutput, "utf8"), /context_receipt_error/);
});

test("session environment is honored; no identity yields an isolated receipt session", async (t) => {
  const f = await fixture(t);
  const priorSession = process.env.PM_CONTEXT_SESSION;
  const priorAuthor = process.env.PM_AUTHOR;
  try {
    process.env.PM_CONTEXT_SESSION = "environment-session";
    process.env.PM_AUTHOR = "environment-author";
    const receipt = receiptFrom(await f.run("context-pack", { id: f.first, format: "json" }, {}), f.pmRoot);
    assert.equal(receipt.session, "environment-session");
    assert.equal(receipt.author, "environment-author");
    assert.equal(bundlesFrom(await f.run("context-usage", { format: "json" })).sessions[0].session, "environment-session");
    delete process.env.PM_CONTEXT_SESSION;
    delete process.env.PM_AUTHOR;
    const anonymous = receiptFrom(await f.run("context-handoff", { id: f.first, format: "json" }, {}), f.pmRoot);
    assert.equal(anonymous.session, anonymous.receipt_id);
    assert.equal(anonymous.author, "anonymous");
  } finally {
    if (priorSession === undefined) delete process.env.PM_CONTEXT_SESSION; else process.env.PM_CONTEXT_SESSION = priorSession;
    if (priorAuthor === undefined) delete process.env.PM_AUTHOR; else process.env.PM_AUTHOR = priorAuthor;
  }
});

test("receipt storage rotates at the hard count bound and rejects oversized snapshots", async (t) => {
  const f = await fixture(t);
  const base = serveContextReceipt(f.pmRoot, "# Pack\n\n## Focus\n- first\n## Focus\n- first\n", "text", { item_ids: [], files: [] }, { author: "a", command: "context-pack" });
  assert.equal(base.receipt.facts.length, 1, "duplicate content is one fact with summed token cost");
  assert.equal(base.receipt.facts[0].estimated_tokens, 4);
  const directory = join(f.pmRoot, RECEIPTS_RELATIVE_PATH);
  const stored = JSON.parse(readFileSync(join(directory, `${base.receipt.receipt_id}.json`), "utf8")) as Record<string, unknown>;
  for (let index = 0; index < RECEIPT_LIMITS.count; index++) {
    const id = `00000000-0000-0000-0000-${index.toString().padStart(12, "0")}`;
    const path = join(directory, `${id}.json`);
    writeFileSync(path, JSON.stringify({ ...stored, receipt_id: id }));
    utimesSync(path, Math.floor(index / 2), Math.floor(index / 2));
  }
  serveContextReceipt(f.pmRoot, "# Empty\n", "text", { item_ids: [], files: [] }, { author: "a", command: "context-pack" });
  assert.equal(readdirSync(directory).filter((name) => name.endsWith(".json")).length, RECEIPT_LIMITS.count);
  assert.ok(!readdirSync(directory).includes("00000000-0000-0000-0000-000000000000.json"));
  // A clock moving backwards or coarse timestamps must not evict the receipt
  // this serving call promises the agent can cite immediately afterwards.
  for (const name of readdirSync(directory)) {
    const future = new Date("2100-01-01T00:00:00.000Z");
    utimesSync(join(directory, name), future, future);
  }
  const current = serveContextReceipt(f.pmRoot, "# Current\n", "text", { item_ids: [], files: [] }, { author: "a", command: "context-pack" });
  assert.equal(reportContextReceipts(f.pmRoot, { receipt_id: current.receipt.receipt_id, limit: 20 }).retained_receipts, 1);
  assert.equal(readdirSync(directory).filter((name) => name.endsWith(".json")).length, RECEIPT_LIMITS.count);
  assert.throws(() => serveContextReceipt(f.pmRoot, "# Pack\n- x\n", "text", { item_ids: [], files: [] }, {
    author: "a".repeat(RECEIPT_LIMITS.bytes), command: "context-pack",
  }), /byte limit/);
  assert.ok(!readdirSync(directory).includes(".lock"));
  assert.ok(!readdirSync(directory).some((name) => name.endsWith(".tmp")));
});

test("token accounting, JSON minification, text inheritance, stable ids and normalized paths", async (t) => {
  const f = await fixture(t);
  const association = { item_ids: ["item-1", "item-10"], files: [{ itemId: "item-1", value: "./src/used.ts" }, { itemId: "item-1", value: "https://example.invalid" }] };
  const output = 'preamble\n# Pack\nGenerated: now\n\n## Focus\n- item-1\n  - body: extra\n## Links\n- item-1 file: ./src/used.ts\n- item-10\n';
  const receipt = serveContextReceipt(f.pmRoot, output, "text", association, { author: "a", command: "context-pack" }).receipt;
  assert.deepEqual(receipt.facts[1].item_ids, ["item-1"]);
  assert.deepEqual(receipt.facts[2].item_ids, ["item-1"]);
  assert.deepEqual(receipt.facts.at(-1)?.item_ids, ["item-10"]);
  recordReceiptUsage(f.pmRoot, { receipt_id: receipt.receipt_id, citations: [], touched_items: [], edited_files: ["src\\used.ts"] });
  const report = reportContextReceipts(f.pmRoot, { receipt_id: receipt.receipt_id, limit: 20 });
  const used = receipt.facts.find((fact) => fact.files.length > 0);
  assert.ok(used);
  assert.equal(report.totals.unused_context_tokens, receipt.facts.reduce((sum, fact) => sum + fact.estimated_tokens, 0) - used.estimated_tokens);
  assert.equal(report.totals.precision, 1 / receipt.facts.length);
  const pretty = serveContextReceipt(f.pmRoot, '{\n "generatedAt": "now",\n "items": [{"id":"item-1"}]\n}\n', "json", association, { session: "json", author: "a", command: "context-pack" });
  const compact = serveContextReceipt(f.pmRoot, '{"generatedAt":"later","items":[{"id":"item-1"}]}\n', "json", association, { author: "a", command: "context-pack" });
  assert.deepEqual(compact.receipt.facts, pretty.receipt.facts);
  assert.equal(compact.output.trim().split("\n").length, 1);
  for (const invalid of ["", "/absolute", "../escape", "a/../../escape", ".", "C:\\escape", "https://example.invalid/file"]) assert.throws(() => normalizeReceiptFile(invalid));
  assert.equal(normalizeReceiptFile("./src/../src/used.ts"), "src/used.ts");
  const quotedFile = 'src/quoted"file.ts';
  const quotedAssociation = { item_ids: ["item-1"], files: [{ itemId: "item-1", value: quotedFile }] };
  const quoted = serveContextReceipt(f.pmRoot, JSON.stringify({ links: [{ itemId: "item-1", kind: "file", value: quotedFile }] }), "json", quotedAssociation, { author: "a", command: "context-pack" });
  assert.deepEqual(quoted.receipt.facts[0].files, [quotedFile], "JSON escaping must preserve editable-file associations");
  const hiddenLink = serveContextReceipt(f.pmRoot, '# Pack\n- item-1: src/used.tsx\n', "text", { item_ids: ["item-1"], files: [{ itemId: "item-1", value: "src/used.ts" }] }, { author: "a", command: "context-pack" });
  assert.deepEqual(hiddenLink.receipt.facts[0].files, [], "partial filename text cannot credit an excluded link");
});

test("receipt aggregates honor filters and row limits without changing denominators", async (t) => {
  const f = await fixture(t);
  const empty = reportContextReceipts(f.pmRoot, { limit: 20 });
  assert.equal(empty.totals.precision, null);
  assert.match(renderReceiptReport(empty), /n\/a/);
  const association = { item_ids: ["item-1"], files: [] };
  const first = serveContextReceipt(f.pmRoot, "## Focus\n- item-1\n", "text", association, { author: "a", command: "context-pack", session: "a|b\nc" }).receipt;
  const second = serveContextReceipt(f.pmRoot, "## Focus\n- item-1\n", "text", association, { author: "b", command: "context-handoff", session: "second" }).receipt;
  const secondPath = join(f.pmRoot, RECEIPTS_RELATIVE_PATH, `${second.receipt_id}.json`);
  const secondSnapshot = JSON.parse(readFileSync(secondPath, "utf8")) as Record<string, unknown>;
  writeFileSync(secondPath, JSON.stringify({ ...secondSnapshot, served_at: first.served_at }));
  const all = reportContextReceipts(f.pmRoot, { limit: 1 });
  assert.equal(all.retained_receipts, 2);
  assert.equal(all.totals.served_facts, 2);
  assert.equal(all.sessions.length, 1);
  assert.equal(all.receipts.length, 1);
  assert.equal(reportContextReceipts(f.pmRoot, { author: "a", limit: 20 }).retained_receipts, 1);
  assert.equal(reportContextReceipts(f.pmRoot, { session: "second", limit: 20 }).retained_receipts, 1);
  assert.equal(reportContextReceipts(f.pmRoot, { receipt_id: first.receipt_id, limit: 20 }).retained_receipts, 1);
  assert.equal(reportContextReceipts(f.pmRoot, { since: "9999-01-01T00:00:00.000Z", limit: 20 }).retained_receipts, 0);
  assert.match(renderReceiptReport(all), /a\\\|b c/);
});

test("corrupt receipt snapshots are counted, excluded and cannot accept usage", async (t) => {
  const f = await fixture(t);
  const receipt = receiptFrom(await f.run("context-pack", { id: f.first, format: "json" }), f.pmRoot);
  const path = join(f.pmRoot, RECEIPTS_RELATIVE_PATH, `${receipt.receipt_id}.json`);
  const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const fact = receipt.facts[0];
  const invalids: unknown[] = [
    null, 1, {}, { ...original, protocol: "future" }, { ...original, receipt_id: 42 }, { ...original, receipt_id: "invalid" }, { ...original, receipt_id: "11111111-1111-1111-1111-111111111111" },
    ...["session", "author", "served_at", "command"].map((key) => ({ ...original, [key]: null })),
    { ...original, served_at: "not-a-date" }, { ...original, served_at: "2026-01-01" },
    { ...original, protocol_tokens: 0.5 }, { ...original, protocol_tokens: -1 },
    { ...original, sections: null }, { ...original, facts: null },
    ...[null, 1, { id: 1, name: "Focus" }, { id: "section", name: null }].map((section) => ({ ...original, sections: [section] })),
    ...[null, 1, { ...fact, id: 1 }, { ...fact, section_id: 1 }, { ...fact, section_id: "unknown" },
      { ...fact, item_ids: null }, { ...fact, item_ids: [1] }, { ...fact, files: null }, { ...fact, files: [1] },
      { ...fact, files: ["./un-normalized.ts"] }, { ...fact, files: ["../outside"] },
      { ...fact, estimated_tokens: 0.5 }, { ...fact, estimated_tokens: -1 }].map((entry) => ({ ...original, facts: [entry] })),
    { ...original, facts: [fact, fact] },
    ...[null, 1, [], { unknown: ["citation"] }, { [fact.id]: "citation" }, { [fact.id]: ["future"] }].map((used) => ({ ...original, used })),
  ];
  for (const invalid of invalids) {
    writeFileSync(path, JSON.stringify(invalid));
    const report = reportContextReceipts(f.pmRoot, { limit: 20 });
    assert.equal(report.malformed_receipts, 1, `reject ${JSON.stringify(invalid)}`);
    assert.equal(report.totals.served_facts, 0);
  }
  writeFileSync(path, "{partial");
  assert.equal(reportContextReceipts(f.pmRoot, { limit: 20 }).malformed_receipts, 1);
  writeFileSync(path, " ".repeat(RECEIPT_LIMITS.bytes + 1));
  assert.equal(reportContextReceipts(f.pmRoot, { limit: 20 }).malformed_receipts, 1);
  assert.throws(() => recordReceiptUsage(f.pmRoot, { receipt_id: receipt.receipt_id, citations: [fact.id], touched_items: [], edited_files: [] }), /malformed/);
  rmSync(path);
  mkdirSync(path);
  assert.equal(reportContextReceipts(f.pmRoot, { limit: 20 }).malformed_receipts, 1);
});
