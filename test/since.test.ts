import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { init, historyCompact, createHistoryEntry, appendHistoryEntry, emptyImportedDocument } from "@unbrained/pm-cli/sdk";
import { create, comments, claim, release, update, close, reopen, deleteItem } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { readPmItems } from "../index.ts";
import { buildSincePack, encodeSincePack, SinceError, SINCE_RETENTION } from "../since.ts";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import type { SinceOptions, SincePack } from "../since.ts";

const terminal = new Set(["closed", "canceled"]);
const epoch = "2000-01-01T00:00:00Z";

/** Use real SDK persistence outside any enclosing Git repository. */
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "since-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("delta", { defaults: true, author: "agent-a", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const client = { cwd: root, pmRoot };
  /** Read full, certified metadata through the same loader as the command. */
  const pack = async (options: Partial<SinceOptions> = {}) => buildSincePack(pmRoot, await readPmItems(pmRoot), terminal, {
    author: "agent-a", tokenBudget: 100_000, ...options,
  });
  return { root, pmRoot, client, pack };
}

/** Assert stable machine-readable remedies in addition to the host exit status. */
function errorCode(code: string) {
  return (error: unknown) => error instanceof SinceError && error.code === code && error.exitCode === 2 && !!error.remedy;
}

test("real tracker delta includes lifecycle, prose, handoffs, claims and indirect unblocks", async (t) => {
  const f = await fixture(t);
  const a = (await create({ title: "Own open work", author: "agent-a" }, f.client)).item.id;
  const b = (await create({ title: "Prerequisite", author: "agent-a" }, f.client)).item.id;
  const c = (await create({ title: "Dependent", author: "agent-a" }, f.client)).item.id;
  await claim(a, { author: "agent-a" }, f.client);
  const baseline = await f.pack({ from: epoch });
  await comments(a, { add: "The acceptance check found a substantive missing case.", author: "agent-a" }, f.client);
  await update(a, { blockedBy: "Waiting for review", author: "agent-a" }, f.client);
  const intermediate = await f.pack({ cursor: baseline.cursor });
  assert.ok(intermediate.changes.some((row) => row.op === "own_claim" && row.blocked && row.text.includes("Waiting for review")));
  await update(a, { blockedReason: "Waiting for CI", author: "agent-a" }, f.client);
  await update(b, { priority: "0", author: "agent-a" }, f.client);
  await update(c, { dep: [`id=${b},kind=blocked_by`], author: "agent-a" }, f.client);
  await close(b, "Prerequisite passed", { author: "agent-a" }, f.client);
  await reopen(b, "Regression remains", { author: "agent-a" }, f.client);
  await claim(c, { author: "agent-b" }, f.client);
  await release(c, { author: "agent-b", message: "handoff: resume after the fixture repair" }, f.client);
  const created = (await create({ title: "Newly ready", author: "agent-a" }, f.client)).item.id;
  await claim(c, { author: "agent-a" }, f.client);
  const pack = await f.pack({ cursor: baseline.cursor });
  const kinds = new Set(pack.changes.flatMap((row) => row.kinds));
  for (const kind of ["created", "closed", "reopened", "reprioritized", "blocked", "unblocked", "comment", "claim", "release", "handoff", "own_claim"]) assert.ok(kinds.has(kind), kind);
  assert.ok(pack.changes.some((row) => row.text.includes("substantive missing case")));
  assert.ok(pack.changes.some((row) => row.id === c && row.kinds.includes("unblocked")));
  assert.ok(pack.changes.some((row) => row.id === c && row.author === "agent-b" && row.op === "claim"));
  assert.ok(pack.changes.some((row) => row.id === created && row.kinds.includes("created")));
  assert.ok(pack.changes[0]!.kinds.includes("blocked") || pack.changes[0]!.blocked);
  assert.ok(pack.changes.filter((row) => row.kinds.includes("unblocked")).every((row) => row.superseded));
  assert.equal(pack.omission_receipt.deferred_rows, 0);
  assert.deepEqual(await f.pack({ cursor: baseline.cursor }), pack, "same cursor and corpus yield byte-identical output");
  const next = await f.pack({ cursor: pack.cursor });
  assert.deepEqual(next.changes.map((row) => row.op), ["own_claim", "own_claim"]);
  assert.ok(next.changes.every((row) => row.blocked));
  assert.ok(next.changes.some((row) => row.text.includes("Waiting for CI")));
  assert.equal(existsSync(join(f.root, ".git")), false);
});

test("budgeted pages omit explicitly, retain all event identities and collect writes after draining", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Pagination", author: "agent-a" }, f.client)).item.id;
  await claim(id, { author: "agent-a" }, f.client);
  const baseline = await f.pack({ from: epoch });
  for (let index = 0; index < 6; index++) await comments(id, { add: `Substantive session ${index}: ${"x".repeat(500)}`, author: "agent-a" }, f.client);
  const complete = await f.pack({ cursor: baseline.cursor });
  let page = await f.pack({ cursor: baseline.cursor, tokenBudget: 2400 });
  assert.ok(page.omission_receipt.deferred_rows > 0);
  assert.ok(page.omission_receipt.excerpt_omitted_chars >= 0);
  await comments(id, { add: "Arrived during paging", author: "agent-a" }, f.client);
  const collected = [];
  for (let count = 0; count < 20; count++) {
    const output = encodeSincePack(page);
    assert.equal(page.budget.token_upper_bound, Buffer.byteLength(output));
    assert.ok(page.budget.token_upper_bound <= 2400);
    collected.push(...page.changes);
    if (!page.omission_receipt.deferred_rows) break;
    page = await f.pack({ cursor: page.cursor, tokenBudget: 2400 });
  }
  assert.deepEqual(collected, complete.changes);
  assert.ok(collected.some((row) => row.excerpt_omitted_chars > 0));
  const fresh = await f.pack({ cursor: page.cursor });
  assert.ok(fresh.changes.some((row) => row.text.includes("Arrived during paging")));
  await assert.rejects(f.pack({ cursor: baseline.cursor, tokenBudget: 512 }), errorCode("BUDGET_TOO_SMALL"));
});

test("bad arguments, wrong author, corrupt or missing cursors fail with explicit remedies", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.pack(), errorCode("INVALID_ARGUMENT"));
  await assert.rejects(f.pack({ from: epoch, cursor: "bad" }), errorCode("INVALID_ARGUMENT"));
  await assert.rejects(f.pack({ from: epoch, author: " " }), errorCode("INVALID_ARGUMENT"));
  for (const tokenBudget of [NaN, 511, 2.5]) await assert.rejects(f.pack({ from: epoch, tokenBudget }), errorCode("INVALID_BUDGET"));
  await assert.rejects(f.pack({ from: "yesterdayish" }), errorCode("INVALID_FROM"));
  await assert.rejects(f.pack({ cursor: "../../outside" }), errorCode("INVALID_CURSOR"));
  await assert.rejects(f.pack({ cursor: `s1_${"0".repeat(64)}` }), errorCode("CURSOR_EXPIRED"));
  const pack = await f.pack({ from: epoch });
  const emptyRefresh = await f.pack({ cursor: pack.cursor });
  assert.notEqual(emptyRefresh.cursor, pack.cursor, "even an empty refresh returns a new cursor");
  assert.deepEqual(await f.pack({ cursor: pack.cursor }), emptyRefresh, "retrying a cursor stays deterministic");
  await assert.rejects(f.pack({ cursor: pack.cursor, author: "agent-b" }), errorCode("CURSOR_AUTHOR_MISMATCH"));
  writeFileSync(join(f.pmRoot, SINCE_RETENTION.directory, `${pack.cursor}.json`), "{}");
  await assert.rejects(f.pack({ cursor: pack.cursor }), errorCode("INVALID_CURSOR"));
});

test("since rejects loose timestamps and invalid calendar, clock and offset fields", async (t) => {
  const f = await fixture(t);
  for (const from of [
    "1", "2026-10-20", "2026-10-20T18:00:00", "2026-10-20T18:00:00z",
    "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z",
    "1900-02-29T00:00:00Z", "0099-02-29T00:00:00Z", "0100-02-29T00:00:00Z",
    "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z", "2026-01-32T00:00:00Z",
    "2026-10-20T24:00:00Z", "2026-10-20T18:60:00Z", "2026-10-20T18:00:60Z",
    "2026-10-20T18:00:00+24:00", "2026-10-20T18:00:00+00:60", " 2026-10-20T18:00:00Z",
  ]) await assert.rejects(f.pack({ from }), errorCode("INVALID_FROM"), from);
  assert.equal(existsSync(join(f.root, ".git")), false);
});

test("since preserves early years, leap days and inclusive explicit-offset boundaries", async (t) => {
  const f = await fixture(t);
  const empty = emptyImportedDocument();
  for (const [id, nowIso] of [
    ["delta-early", "0099-02-28T12:34:56.123Z"],
    ["delta-boundary", "2020-02-29T12:34:56.123Z"],
  ] as const) await appendHistoryEntry(join(f.pmRoot, "history", `${id}.jsonl`), createHistoryEntry({
    nowIso, author: "agent-a", op: "update", before: empty, after: empty,
  }));
  for (const from of [
    "0000-02-29T00:00:00Z", "0099-02-28T12:34:56.123Z", "0099-02-28T14:04:56.123+01:30",
  ]) assert.ok((await f.pack({ from })).changes.some((row) => row.id === "delta-early"), from);
  for (const from of [
    "0100-02-28T00:00:00Z", "0400-02-29T00:00:00Z", "2000-02-29T00:00:00Z",
    "2020-02-29T12:34:56.123Z", "2020-02-29T14:04:56.123+01:30",
    "2020-02-29T11:04:56.123-01:30", "2020-02-29T12:34:56.123000Z",
  ]) assert.deepEqual((await f.pack({ from })).changes.filter((row) => row.id.startsWith("delta-")).map((row) => row.id), ["delta-boundary"], from);
  assert.deepEqual((await f.pack({ from: "2020-02-29T12:34:56.124Z" })).changes.filter((row) => row.id.startsWith("delta-")), []);
});

test("history compaction reports the affected stream without expiring every cursor", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Retained history", author: "agent-a" }, f.client)).item.id;
  await comments(id, { add: "old session", author: "agent-a" }, f.client);
  await comments(id, { add: "another session", author: "agent-a" }, f.client);
  const old = await f.pack({ from: epoch });
  await historyCompact(id, { author: "agent-a" }, f.client);
  assert.deepEqual((await f.pack({ cursor: old.cursor })).omission_receipt.expired_streams, [id]);
  assert.deepEqual((await f.pack({ from: epoch })).omission_receipt.expired_streams, [id]);
  assert.equal((await f.pack({ from: "2099-01-01T00:00:00Z" })).changes.length, 0);
});

test("installed built command works with no Git executable and preserves source tracker bytes", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "No git delta", author: "agent-a" }, f.client)).item.id;
  await comments(id, { add: "handoff: use the exported parser", author: "agent-a" }, f.client);
  const packageRoot = resolve(import.meta.dirname, "..");
  const install = join(f.pmRoot, "extensions", "pm-context");
  mkdirSync(install, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(install, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(install, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(install, "node_modules"), "dir");
  const emptyPath = join(f.root, "no-executables");
  mkdirSync(emptyPath);
  const history = readFileSync(join(f.pmRoot, "history", `${id}.jsonl`), "utf8");
  const result = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"),
    "context-pack", "since", "--from", epoch, "--token-budget", "8000", "--json"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, PM_PATH: f.pmRoot, PM_AUTHOR: "agent-a", PATH: emptyPath, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(result.status, 0, result.stderr);
  const pack = JSON.parse(result.stdout) as SincePack;
  assert.ok(pack.changes.some((row) => row.text.includes("exported parser")));
  assert.ok(Buffer.byteLength(result.stdout) <= 8000);
  assert.equal(pack.budget.ceiling, 8000, "the installed CLI must honor the explicit flag");
  assert.equal(history, readFileSync(join(f.pmRoot, "history", `${id}.jsonl`), "utf8"));
  const invalid = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"),
    "context-pack", "since", "--cursor", "bad", "--json"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, PM_PATH: f.pmRoot, PM_AUTHOR: "agent-a", PATH: emptyPath, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(invalid.status, 2);
  const failure = JSON.parse(invalid.stderr) as { code: string; next_steps: string[] };
  assert.equal(failure.code, "INVALID_CURSOR");
  assert.ok(failure.next_steps.length > 0);
  const small = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"),
    "context-pack", "since", "--from", epoch, "--token-budget", "512", "--json"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, PM_PATH: f.pmRoot, PM_AUTHOR: "agent-a", PATH: emptyPath, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(small.status, 2);
  assert.equal((JSON.parse(small.stderr) as { code: string }).code, "BUDGET_TOO_SMALL");


});

test("registered handler uses the author and default budget from host context", async (t) => {
  const f = await fixture(t);
  await create({ title: "Host defaults", author: "agent-a" }, f.client);
  const harness = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
  t.after(() => harness.deactivate());
  const result = await harness.runCommand({ command: "context-pack since", pmRoot: f.pmRoot, options: { from: epoch }, global: { author: "agent-a" } });
  assert.equal(result.errorMessage, undefined);
  assert.equal((JSON.parse((result.result as { output: string }).output) as SincePack).budget.ceiling, 4000);
  const cursor = (JSON.parse((result.result as { output: string }).output) as SincePack).cursor;
  const savedAuthor = process.env.PM_AUTHOR;
  try {
    process.env.PM_AUTHOR = "agent-a";
    const resumed = await harness.runCommand({ command: "context-pack since", pmRoot: f.pmRoot, options: { cursor, "token-budget": "8000" }, global: {} });
    assert.equal((JSON.parse((resumed.result as { output: string }).output) as SincePack).budget.ceiling, 8000);
    delete process.env.PM_AUTHOR;
    const fallback = await harness.runCommand({ command: "context-pack since", pmRoot: f.pmRoot, options: { from: epoch }, global: {} });
    assert.equal(fallback.errorMessage, undefined);
  } finally {
    if (savedAuthor === undefined) delete process.env.PM_AUTHOR;
    else process.env.PM_AUTHOR = savedAuthor;
  }

});

/** Build adversarial runtime state while leaving SDK-owned item histories untouched. */
function checkpoint(pmRoot: string, pending: SincePack["changes"]) {
  const state = { generation: 0, author: "agent-a", streams: [], pending };
  const raw = JSON.stringify(state);
  const token = `s1_${createHash("sha256").update(raw).digest("hex")}`;
  const directory = join(pmRoot, SINCE_RETENTION.directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${token}.json`), raw);
  return token;
}

test("retention enforces count and byte capacity without evicting the returned snapshot", async (t) => {
  const f = await fixture(t);
  const pack = await f.pack({ from: epoch });
  const directory = join(f.pmRoot, SINCE_RETENTION.directory);
  for (let index = 0; index < 201; index++) {
    const path = join(directory, `s1_${index.toString(16).padStart(64, "0")}.json`);
    writeFileSync(path, " ".repeat(22000));
    utimesSync(path, new Date("2099-01-01"), new Date("2099-01-01"));
  }
  symlinkSync("evicted-snapshot", join(directory, `s1_${"f".repeat(64)}.json`));
  const refreshed = await f.pack({ cursor: pack.cursor });
  assert.ok(existsSync(join(directory, `${refreshed.cursor}.json`)));
  const files = readdirSync(directory).filter((file) => /^(?:s1_.*\.json|i1_.*\.gz)$/.test(file) && existsSync(join(directory, file)));
  assert.ok(files.filter((file) => file.startsWith("s1_")).length <= SINCE_RETENTION.count);
  assert.ok(files.reduce((sum, file) => sum + readFileSync(join(directory, file)).length, 0) <= SINCE_RETENTION.bytes);
  await create({ title: "Capacity row", author: "agent-a" }, f.client);
  const realRow = (await f.pack({ from: epoch })).changes[0]!;
  const huge = Array.from({ length: 240 }, (_, index) => ({ ...realRow, key: String(index), text: "x".repeat(20000) }));
  const token = checkpoint(f.pmRoot, huge);
  await assert.rejects(f.pack({ cursor: token, tokenBudget: 30000 }), errorCode("CURSOR_CAPACITY"));
  const broken = join(directory, `${refreshed.cursor}.json`);
  writeFileSync(broken, "{");
  await assert.rejects(f.pack({ cursor: refreshed.cursor }), errorCode("INVALID_CURSOR"));
});


test("equal-time, backdated, inverse-edge and sparse historical records retain causal transitions", async (t) => {
  const f = await fixture(t);
  const time = "2026-01-01T00:00:00.000Z";
  /** SDK-produced history can retain sparse legacy snapshots preceding a repair. */
  async function stream(id: string, snapshots: Record<string, unknown>[]) {
    let before = emptyImportedDocument();
    for (const [index, metadata] of snapshots.entries()) {
      const after = { metadata: metadata as unknown as ItemMetadata, body: "" };
      await appendHistoryEntry(join(f.pmRoot, "history", `${id}.jsonl`), createHistoryEntry({
        nowIso: index === 2 ? "2025-12-31T23:59:00.000Z" : time, author: "agent-a", op: "update", before, after,
      }));
      before = after;
    }
  }
  await stream("delta-a", [
    { id: "delta-a", status: "blocked", blocked_reason: "Waiting on access", comments: [], dependencies: [] },
    { id: "delta-a", status: "open", dependencies: [{ id: "delta-b", kind: "blocks" }] },
    {},
  ]);
  await stream("delta-b", [
    { id: "delta-b", status: "open", dependencies: [{ id: "missing", kind: "related" }] },
    { id: "delta-b", status: "closed" },
  ]);
  await stream("delta-wait", [
    { id: "delta-wait", status: "open", dependencies: [{ id: "missing", kind: "blocked_by" }] },
    { id: "delta-wait", status: "closed" },
  ]);
  await stream("delta-done", [
    { id: "delta-done", status: "blocked" },
    { id: "delta-done", status: "open" },
    { id: "delta-done", status: "closed" },
  ]);
  await stream("delta-ready", [
    { id: "delta-ready", status: "blocked" },
    { id: "delta-ready", status: "open" },
  ]);
  await stream("delta-partial", [
    { id: "delta-partial", status: "open", dependencies: [{ id: "missing-a", kind: "blocked_by", created_at: time, author: "agent-a" }, { id: "missing-b", kind: "blocked_by", created_at: time, author: "agent-a" }] },
    { id: "delta-partial", status: "open", dependencies: [{ id: "missing-b", kind: "blocked_by", created_at: time, author: "agent-a" }] },
  ]);
  await stream("delta-multi", [
    { id: "delta-multi", status: "open", dependencies: [{ id: "missing-a", kind: "blocked_by", created_at: time, author: "agent-a" }, { id: "missing-b", kind: "blocked_by", created_at: time, author: "agent-a" }] },
    { id: "delta-multi", status: "open" },
  ]);
  await stream("delta-00-terminal", [{ id: "delta-00-terminal", status: "closed" }]);
  await stream("delta-legacy-closed", [{ id: "delta-legacy-closed", status: "open", blocked_by: "delta-00-terminal" }]);
  const repeated = { created_at: time, author: "agent-a", text: "Same-time repeated comment" };
  await stream("delta-repeated", [
    { id: "delta-repeated", status: "open", comments: [repeated] },
    { id: "delta-repeated", status: "open", comments: [repeated, repeated] },
    { id: "delta-repeated", status: "closed", comments: [repeated, repeated] },
  ]);
  // Append a structurally valid legacy record with malformed optional collections.
  // Activity can surface it; the delta must safely omit non-prose collection values.
  const empty = emptyImportedDocument();
  await appendHistoryEntry(join(f.pmRoot, "history", "delta-legacy.jsonl"), {
    ...createHistoryEntry({ nowIso: time, author: "agent-a", op: "legacy", before: empty, after: empty }),
    patch: [{ op: "add", path: "/metadata/comments", value: [null] }, { op: "add", path: "/metadata/dependencies", value: [null] }],
  });
  writeFileSync(join(f.pmRoot, "history", ".keep"), "not a history stream");
  const pack = await buildSincePack(f.pmRoot, [{ id: "delta-own", assignee: "agent-a" }, { id: "delta-owned-blocked", assignee: "agent-a", status: "blocked" }], terminal, { author: "agent-a", from: epoch, tokenBudget: 100000 });
  assert.ok(pack.changes.some((row) => row.id === "delta-b" && row.kinds.includes("blocked")));
  assert.ok(!pack.changes.some((row) => row.id === "delta-wait" && row.kinds.includes("unblocked")), "closing blocked work does not create actionable work");
  assert.ok(pack.changes.some((row) => row.id === "delta-a" && row.kinds.includes("unblocked") && row.superseded));
  assert.ok(pack.changes.some((row) => row.id === "delta-done" && row.kinds.includes("unblocked") && row.superseded));
  assert.ok(pack.changes.some((row) => row.id === "delta-ready" && row.kinds.includes("unblocked") && row.superseded === false));
  assert.ok(pack.changes.some((row) => row.title === "delta-b"));
  assert.ok(!pack.changes.some((row) => row.id === "delta-partial" && row.kinds.includes("unblocked")), "remaining prerequisites keep an item blocked");
  const multi = pack.changes.filter((row) => row.id === "delta-multi" && row.kinds.includes("unblocked"));
  assert.equal(multi.length, 1, "clearing several blockers emits one newly actionable item");
  assert.ok(multi[0]!.text.includes("missing-a") && multi[0]!.text.includes("missing-b"));
  assert.ok(!pack.changes.some((row) => row.id === "delta-legacy-closed" && row.kinds.includes("blocked")), "closed legacy blocker references do not block work");
  assert.ok(pack.changes.some((row) => row.ts < time));
  assert.equal(pack.changes.filter((row) => row.id === "delta-repeated" && row.kinds.includes("comment")).length, 2, "identical same-time comments are counted as separate additions");
  const cursor = pack.cursor;
  const before = emptyImportedDocument();
  const after = { metadata: { id: "delta-c", title: "Late old-clock event", status: "open", priority: 4 } as unknown as ItemMetadata, body: "" };
  await appendHistoryEntry(join(f.pmRoot, "history", "delta-c.jsonl"), createHistoryEntry({ nowIso: "2020-01-01T00:00:00Z", author: "agent-a", op: "create", before, after }));
  const late = await buildSincePack(f.pmRoot, [], terminal, { author: "agent-a", cursor, tokenBudget: 100000 });
  assert.ok(late.changes.some((row) => row.id === "delta-c"));
});


test("claim ownership uses the same history snapshot when another agent claims between reads", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Concurrent claim snapshot", author: "agent-a" }, f.client)).item.id;
  await claim(id, { author: "agent-a" }, f.client);
  const baseline = await f.pack({ from: epoch });
  const staleMetadata = await readPmItems(f.pmRoot);
  await claim(id, { author: "agent-b", force: true }, f.client);
  const pack = await buildSincePack(f.pmRoot, staleMetadata, terminal, { author: "agent-a", cursor: baseline.cursor, tokenBudget: 10000 });
  assert.ok(pack.changes.some((row) => row.op === "claim" && row.author === "agent-b"));
  assert.ok(!pack.changes.some((row) => row.op === "own_claim" && row.id === id));
});


test("deleting terminal work does not invent a reopen or reprioritization", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Deleted terminal work", author: "agent-a" }, f.client)).item.id;
  await close(id, "Finished", { author: "agent-a" }, f.client);
  const baseline = await f.pack({ from: epoch });
  await comments(id, { add: "Retain this final handoff before cleanup", author: "agent-a" }, f.client);
  await deleteItem(id, { author: "agent-a" }, f.client);
  const pack = await f.pack({ cursor: baseline.cursor });
  assert.ok(pack.changes.some((row) => row.op === "delete"));
  assert.ok(pack.changes.some((row) => row.text.includes("final handoff")));
  assert.ok(!pack.changes.some((row) => row.kinds.includes("reopened") || row.kinds.includes("reprioritized")));
});


test("receipt budgeting drops the last row at an exact serialized boundary", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Receipt boundary", author: "agent-a" }, f.client)).item.id;
  const baseline = await f.pack({ from: epoch });
  for (let index = 0; index < 2; index++) await comments(id, { add: `${index}: ${"x".repeat(2400)}`, author: "agent-a" }, f.client);
  const complete = await f.pack({ cursor: baseline.cursor });
  assert.equal(complete.changes.length, 2);
  complete.budget.ceiling = 3000;
  let exact = Buffer.byteLength(encodeSincePack(complete));
  complete.budget.ceiling = exact;
  exact = Buffer.byteLength(encodeSincePack(complete));
  const page = await f.pack({ cursor: baseline.cursor, tokenBudget: exact - 1 });
  assert.equal(page.changes.length, 1, "an oversized last row must leave a usable page");
  assert.equal(page.omission_receipt.deferred_rows, 1);
  assert.equal(page.omission_receipt.excerpt_omitted_chars, page.changes[0]!.excerpt_omitted_chars);
  assert.ok(Buffer.byteLength(encodeSincePack(page)) <= exact - 1);
  assert.deepEqual((await f.pack({ cursor: page.cursor })).changes, complete.changes.slice(1));
  assert.equal((await f.pack({ cursor: baseline.cursor, tokenBudget: exact })).changes.length, 2, "a complete receipt fits at its exact byte ceiling");
});


test("checkpoint size stays compact beyond the old 4 MiB event-key limit", async (t) => {
  const f = await fixture(t);
  const empty = emptyImportedDocument();
  const entry = createHistoryEntry({ nowIso: epoch, author: "agent-a", op: "update", before: empty, after: empty });
  const count = 65000;
  writeFileSync(join(f.pmRoot, "history", "delta-large.jsonl"), `${JSON.stringify(entry)}\n`.repeat(count));
  const pack = await f.pack({ from: "2099-01-01T00:00:00Z" });
  const raw = readFileSync(join(f.pmRoot, SINCE_RETENTION.directory, `${pack.cursor}.json`), "utf8");
  const stored = JSON.parse(raw) as { streams: string };
  const state = { streams: JSON.parse(gunzipSync(readFileSync(join(f.pmRoot, SINCE_RETENTION.directory, `i1_${stored.streams}.gz`))).toString("utf8")) as Array<{ id: string; count: number; hash: string }> };
  const large = state.streams.find((stream) => stream.id === "delta-large")!;
  assert.equal(state.streams.length, 2, "one large item stream plus SDK workspace history");
  assert.equal(large.count, count);
  assert.match(large.hash, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(raw) < 512, "retained history fingerprints must scale with streams rather than events");
});


test("stream prefixes detect rewrite, truncation and removal while retaining late appends", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Prefix integrity", author: "agent-a" }, f.client)).item.id;
  await comments(id, { add: "Retained prefix", author: "agent-a" }, f.client);
  const baseline = await f.pack({ from: epoch });
  const path = join(f.pmRoot, "history", `${id}.jsonl`);
  const original = readFileSync(path, "utf8");
  const entries = original.trim().split("\n");
  const changed = JSON.parse(entries[0]!) as { author: string };
  changed.author = "agent-b";
  writeFileSync(path, [JSON.stringify(changed), ...entries.slice(1)].join("\n") + "\n");
  await assert.rejects(f.pack({ cursor: baseline.cursor }), errorCode("HISTORY_EXPIRED"));
  writeFileSync(path, entries.slice(0, -1).join("\n") + "\n");
  await assert.rejects(f.pack({ cursor: baseline.cursor }), errorCode("HISTORY_EXPIRED"));
  writeFileSync(path, "");
  await assert.rejects(f.pack({ cursor: baseline.cursor }), errorCode("HISTORY_EXPIRED"));
  rmSync(path);
  await assert.rejects(f.pack({ cursor: baseline.cursor }), errorCode("HISTORY_EXPIRED"));
  writeFileSync(path, original);
  const empty = emptyImportedDocument();
  await appendHistoryEntry(path, createHistoryEntry({ nowIso: "1999-01-01T00:00:00Z", author: "agent-a", op: "update", before: empty, after: empty, message: "Late physical append" }));
  const resumed = await f.pack({ cursor: baseline.cursor });
  assert.equal(resumed.changes.length, 1);
  assert.ok(resumed.changes[0]!.text.includes("Late physical append"));
});


test("indexed causal merging avoids per-event stream shifts and frontier sorting", async (t) => {
  const f = await fixture(t);
  const a = (await create({ title: "Merge A", author: "agent-a" }, f.client)).item.id;
  const b = (await create({ title: "Merge B", author: "agent-a" }, f.client)).item.id;
  await comments(a, { add: "Merge prose", author: "agent-a" }, f.client);
  const originalShift = Array.prototype.shift;
  const originalSort = Array.prototype.sort;
  let shifts = 0;
  let sorts = 0;
  let scans = 0;
  const originalEntries = Array.prototype.entries;
  /** Identify only delta-owned event arrays; SDK activity and unrelated arrays stay untouched. */
  function isEvent(value: unknown): boolean {
    return value !== null && typeof value === "object" && "ordinal" in value && "key" in value;
  }
  try {
    Array.prototype.entries = function <T>(this: T[]): ArrayIterator<[number, T]> {
      if (Array.isArray(this[0]) && isEvent(this[0][0])) scans++;
      return originalEntries.call(this) as ArrayIterator<[number, T]>;
    };
    Array.prototype.shift = function <T>(this: T[]): T | undefined {
      if (isEvent(this[0])) shifts++;
      return originalShift.call(this) as T | undefined;
    };
    Array.prototype.sort = function <T>(this: T[], compareFn?: (a: T, b: T) => number): T[] {
      if (Array.isArray(this[0]) && isEvent(this[0][0])) sorts++;
      return originalSort.call(this, compareFn) as T[];
    };
    const pack = await f.pack({ from: epoch });
    assert.ok(pack.changes.some((row) => row.id === a) && pack.changes.some((row) => row.id === b));
    assert.equal(shifts, 0, "delta event streams must not move remaining entries per event");
    assert.equal(sorts, 0, "delta stream frontiers must not be sorted per event");
    assert.ok(scans > 0, "new windows perform a causal frontier scan");
    scans = 0;
    const frozen = checkpoint(f.pmRoot, pack.changes);
    const resumed = await f.pack({ cursor: frozen, tokenBudget: 1300 });
    assert.ok(resumed.omission_receipt.deferred_rows > 0);
    assert.equal(shifts, 0, "pending pages must skip the event merge");
    assert.equal(sorts, 0);
    assert.equal(scans, 0, "pending pages only validate history prefixes");
  } finally {
    Array.prototype.shift = originalShift;
    Array.prototype.sort = originalSort;
    Array.prototype.entries = originalEntries;
  }
});


test("obsolete event-key cursors expire with an explicit restart remedy", async (t) => {
  const f = await fixture(t);
  const state = { generation: 0, author: "agent-a", seen: [], pending: [] };
  const raw = JSON.stringify(state);
  const cursor = `s1_${createHash("sha256").update(raw).digest("hex")}`;
  const directory = join(f.pmRoot, SINCE_RETENTION.directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${cursor}.json`), raw);
  await assert.rejects(f.pack({ cursor }), (error: unknown) => errorCode("CURSOR_EXPIRED")(error) && error instanceof SinceError && error.remedy.includes("--from"));
});


test("unrelated history does not rescan blocker documents, including empty windows", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Graph scan sentinel", author: "agent-a" }, f.client)).item.id;
  const waiting = (await create({ title: "Waiting sentinel", author: "agent-a" }, f.client)).item.id;
  await update(waiting, { dep: [`id=${id},kind=blocked_by`], author: "agent-a" }, f.client);
  const baseline = await f.pack({ from: epoch });
  const original = Map.prototype[Symbol.iterator];
  let scans = 0;
  /** Count document traversals only; leave SDK maps and their values intact. */
  Map.prototype[Symbol.iterator] = function <K, V>(this: Map<K, V>): MapIterator<[K, V]> {
    const value: unknown = this.get(id as K);
    if (value !== null && typeof value === "object" && "title" in value && value.title === "Graph scan sentinel") scans++;
    return original.call(this) as MapIterator<[K, V]>;
  };
  try {
    await f.pack({ cursor: baseline.cursor });
    const before = scans;
    for (let index = 0; index < 8; index++) {
      await comments(id, { add: `Graph-neutral comment ${index}`, author: "agent-a" }, f.client);
    }
    await update(id, { title: "Graph scan sentinel", priority: "1", author: "agent-a" }, f.client);
    scans = 0;
    const delta = await f.pack({ cursor: baseline.cursor });
    assert.equal(scans, before, "prose and priority changes must not add graph traversals");
    assert.equal(delta.changes.filter((row) => row.kinds.includes("comment")).length, 8);
    assert.ok(!delta.changes.some((row) => row.kinds.includes("unblocked")));
    scans = 0;
    await f.pack({ from: "2099-01-01T00:00:00Z" });
    assert.equal(scans, before, "empty selection must not rescan for unrelated history either");
  } finally {
    Map.prototype[Symbol.iterator] = original;
  }
});


test("metadata ancestor replacements still recompute indirect blockers", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Ancestor prerequisite", author: "agent-a" }, f.client)).item.id;
  const waiting = (await create({ title: "Ancestor dependent", author: "agent-a" }, f.client)).item.id;
  await update(waiting, { dep: [`id=${id},kind=blocked_by`], author: "agent-a" }, f.client);
  const baseline = await f.pack({ from: epoch });
  const empty = emptyImportedDocument();
  const entry = createHistoryEntry({ nowIso: "2090-01-01T00:00:00Z", author: "agent-a", op: "update", before: empty, after: empty });
  await appendHistoryEntry(join(f.pmRoot, "history", `${id}.jsonl`), {
    ...entry, patch: [{ op: "replace", path: "/metadata", value: { id, title: "Ancestor prerequisite", status: "closed" } }],
  });
  const delta = await f.pack({ cursor: baseline.cursor });
  assert.ok(delta.changes.some((row) => row.id === waiting && row.kinds.includes("unblocked")));
});
