import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { init, historyCompact, createHistoryEntry, appendHistoryEntry, emptyImportedDocument } from "@unbrained/pm-cli/sdk";
import { create, comments, claim, release, update, close, reopen } from "@unbrained/pm-cli/sdk/core";
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
  await update(b, { priority: "0", author: "agent-a" }, f.client);
  await update(c, { dep: [`id=${b},kind=blocked_by`], author: "agent-a" }, f.client);
  await close(b, "Prerequisite passed", { author: "agent-a" }, f.client);
  await reopen(b, "Regression remains", { author: "agent-a" }, f.client);
  await claim(c, { author: "agent-b" }, f.client);
  await release(c, { author: "agent-b", message: "handoff: resume after the fixture repair" }, f.client);
  const created = (await create({ title: "Newly ready", author: "agent-a" }, f.client)).item.id;
  const pack = await f.pack({ cursor: baseline.cursor });
  const kinds = new Set(pack.changes.flatMap((row) => row.kinds));
  for (const kind of ["created", "closed", "reopened", "reprioritized", "blocked", "unblocked", "comment", "claim", "release", "handoff", "own_claim"]) assert.ok(kinds.has(kind), kind);
  assert.ok(pack.changes.some((row) => row.text.includes("substantive missing case")));
  assert.ok(pack.changes.some((row) => row.id === c && row.kinds.includes("unblocked")));
  assert.ok(pack.changes.some((row) => row.id === c && row.author === "agent-b" && row.op === "claim"));
  assert.ok(pack.changes.some((row) => row.id === created && row.kinds.includes("created")));
  assert.equal(pack.changes[0]!.kinds[0], "blocked");
  assert.ok(pack.changes.filter((row) => row.kinds.includes("unblocked")).every((row) => row.superseded));
  assert.equal(pack.omission_receipt.deferred_rows, 0);
  assert.deepEqual(await f.pack({ cursor: baseline.cursor }), pack, "same cursor and corpus yield byte-identical output");
  const next = await f.pack({ cursor: pack.cursor });
  assert.deepEqual(next.changes.map((row) => row.op), ["own_claim"]);
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
  await assert.rejects(f.pack({ cursor: pack.cursor, author: "agent-b" }), errorCode("CURSOR_AUTHOR_MISMATCH"));
  writeFileSync(join(f.pmRoot, SINCE_RETENTION.directory, `${pack.cursor}.json`), "{}");
  await assert.rejects(f.pack({ cursor: pack.cursor }), errorCode("INVALID_CURSOR"));
});

test("history compaction invalidates old cursors and predating --from", async (t) => {
  const f = await fixture(t);
  const id = (await create({ title: "Retained history", author: "agent-a" }, f.client)).item.id;
  await comments(id, { add: "old session", author: "agent-a" }, f.client);
  await comments(id, { add: "another session", author: "agent-a" }, f.client);
  const old = await f.pack({ from: epoch });
  await historyCompact(id, { author: "agent-a" }, f.client);
  await assert.rejects(f.pack({ cursor: old.cursor }), errorCode("HISTORY_EXPIRED"));
  await assert.rejects(f.pack({ from: epoch }), errorCode("HISTORY_EXPIRED"));
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
  assert.equal(history, readFileSync(join(f.pmRoot, "history", `${id}.jsonl`), "utf8"));
  const invalid = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"),
    "context-pack", "since", "--cursor", "bad", "--json"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, PM_PATH: f.pmRoot, PM_AUTHOR: "agent-a", PATH: emptyPath, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(invalid.status, 2);
  const failure = JSON.parse(invalid.stderr) as { code: string; next_steps: string[] };
  assert.equal(failure.code, "INVALID_CURSOR");
  assert.ok(failure.next_steps.length > 0);

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
  const state = { author: "agent-a", seen: [], pending };
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
  const refreshed = await f.pack({ cursor: pack.cursor });
  assert.ok(existsSync(join(directory, `${refreshed.cursor}.json`)));
  const files = readdirSync(directory);
  assert.ok(files.length <= SINCE_RETENTION.count);
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
    { id: "delta-a", title: "Repaired title", status: "open", dependencies: [{ id: "delta-b", kind: "blocks" }] },
    { id: "delta-a", status: "closed" },
  ]);
  await stream("delta-b", [
    { id: "delta-b", status: "open", dependencies: [{ id: "missing", kind: "related" }] },
    { id: "delta-b", status: "closed" },
  ]);
  // Append a structurally valid legacy record with malformed optional collections.
  // Activity can surface it; the delta must safely omit non-prose collection values.
  const empty = emptyImportedDocument();
  await appendHistoryEntry(join(f.pmRoot, "history", "delta-legacy.jsonl"), {
    ...createHistoryEntry({ nowIso: time, author: "agent-a", op: "legacy", before: empty, after: empty }),
    patch: [{ op: "add", path: "/metadata/comments", value: [null] }, { op: "add", path: "/metadata/dependencies", value: [null] }],
  });
  writeFileSync(join(f.pmRoot, "history", ".keep"), "not a history stream");
  const pack = await buildSincePack(f.pmRoot, [{ id: "delta-own", assignee: "agent-a", status: "open" }], terminal, { author: "agent-a", from: epoch, tokenBudget: 100000 });
  assert.ok(pack.changes.some((row) => row.id === "delta-b" && row.kinds.includes("blocked")));
  assert.ok(pack.changes.some((row) => row.id === "delta-a" && row.kinds.includes("unblocked")));
  assert.ok(pack.changes.some((row) => row.title === "delta-b"));
  assert.ok(pack.changes.some((row) => row.ts < time));
  const cursor = pack.cursor;
  const before = emptyImportedDocument();
  const after = { metadata: { id: "delta-c", title: "Late old-clock event", status: "open", priority: 4 } as unknown as ItemMetadata, body: "" };
  await appendHistoryEntry(join(f.pmRoot, "history", "delta-c.jsonl"), createHistoryEntry({ nowIso: "2020-01-01T00:00:00Z", author: "agent-a", op: "create", before, after }));
  const late = await buildSincePack(f.pmRoot, [], terminal, { author: "agent-a", cursor, tokenBudget: 100000 });
  assert.ok(late.changes.some((row) => row.id === "delta-c"));
});
