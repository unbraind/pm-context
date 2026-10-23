/** Two-process crash and bounded-contention checks against actual receipt writes. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { RECEIPT_LOCK, RECEIPTS_RELATIVE_PATH, serveContextReceipt, recordReceiptUsage, reportContextReceipts } from "../context-receipts.ts";
import type { ContextReceipt } from "../context-receipts.ts";

/** Initialize a non-git tracker, block its actual receipt writer and await persistence. */
async function blockedWriter(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "context-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("receipt-lock", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const fifo = join(root, "blocked-output");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const noGitPath = join(root, "no-git-bin");
  mkdirSync(noGitPath);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/receipt-lock-writer.ts", import.meta.url))], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: noGitPath,
      GIT_CEILING_DIRECTORIES: dirname(root), RECEIPT_PM_ROOT: pmRoot, RECEIPT_FIFO: fifo },
  });
  let diagnostics = "";
  child.stderr.on("data", (data: Buffer) => { diagnostics += data.toString(); });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const directory = join(pmRoot, RECEIPTS_RELATIVE_PATH);
  const deadline = Date.now() + 15_000;
  let receiptPath: string | undefined;
  while (!receiptPath && Date.now() < deadline) {
    assert.equal(child.exitCode, null, diagnostics);
    if (existsSync(directory)) {
      const name = readdirSync(directory).find(name => name.endsWith(".json"));
      if (name) receiptPath = join(directory, name);
    }
    if (!receiptPath) await setTimeout(10);
  }
  assert.ok(receiptPath, `child must persist a receipt while holding the store lock: ${diagnostics}`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as ContextReceipt;
  const previousPath = process.env.PATH;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = noGitPath;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  });
  return { root, pmRoot, directory, receiptPath, receipt, child, exited };
}

test("F07: killed receipt writer recovers before TTL and permits another write and usage update without git", async (t) => {
  const f = await blockedWriter(t);
  f.child.kill("SIGKILL");
  await f.exited;
  const next = await serveContextReceipt(f.pmRoot, "## Focus\n- item-2\n", "text",
    { item_ids: ["item-2"], files: [] }, { author: "recovery-writer", command: "context-pack" });
  await recordReceiptUsage(f.pmRoot, { receipt_id: f.receipt.receipt_id,
    citations: [f.receipt.facts[0].id], touched_items: [], edited_files: [] });
  assert.equal(reportContextReceipts(f.pmRoot, { limit: 20 }).retained_receipts, 2);
  assert.equal(reportContextReceipts(f.pmRoot, { receipt_id: f.receipt.receipt_id, limit: 20 }).totals.cited_facts, 1);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  for (const path of [f.receiptPath, join(f.directory, `${next.receipt.receipt_id}.json`)]) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.ok(!existsSync(join(f.directory, ".lock")));
});

test("live receipt writer refuses within its bounded wait, even with a longer environment wait", async (t) => {
  const f = await blockedWriter(t);
  const before = readFileSync(f.receiptPath, "utf8");
  const previous = process.env.PM_LOCK_WAIT_MS;
  process.env.PM_LOCK_WAIT_MS = "60000";
  const started = Date.now();
  try {
    await assert.rejects(() => recordReceiptUsage(f.pmRoot, { receipt_id: f.receipt.receipt_id,
      citations: [f.receipt.facts[0].id], touched_items: [], edited_files: [] }), (error: unknown) => {
      assert.ok(isPmCliExpectedError(error));
      assert.match(error.message, /lock/i);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = previous;
  }
  assert.ok(Date.now() - started < 5000, `contention must obey the ${RECEIPT_LOCK.waitMs}ms native budget`);
  assert.equal(f.child.exitCode, null);
  assert.equal(readFileSync(f.receiptPath, "utf8"), before);
});

test("legacy ownerless directories are retained and explain explicit recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "context-legacy-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("legacy", { defaults: true, author: "test", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const legacy = join(pmRoot, RECEIPTS_RELATIVE_PATH, ".lock");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "sentinel"), "unverifiable owner");
  await assert.rejects(() => serveContextReceipt(pmRoot, "# Pack\n", "text", { item_ids: [], files: [] },
    { author: "test", command: "context-pack" }), /no verifiable owner.*explicitly recover/);
  assert.equal(readFileSync(join(legacy, "sentinel"), "utf8"), "unverifiable owner");
});
