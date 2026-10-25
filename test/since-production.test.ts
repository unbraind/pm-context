import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { createHistoryEntry, emptyImportedDocument, historyCompact, init } from "@unbrained/pm-cli/sdk";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import { claim, close, comments, create, release, update } from "@unbrained/pm-cli/sdk/core";
import { readPmItems } from "../index.ts";
import { buildSincePack, packSinceRows, saveCheckpoint, SINCE_RETENTION, SinceError } from "../since.ts";
import type { Checkpoint, SincePack, StreamFingerprint } from "../since.ts";

const epoch = "2000-01-01T00:00:00Z";
const terminal = new Set(["closed", "canceled"]);

/** Initialize the real SDK in a disposable directory outside Git. */
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "since-production-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("delta", { defaults: true, author: "agent-a", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const client = { cwd: root, pmRoot };
  /** Exercise the public builder with complete real tracker metadata. */
  const pack = async (options: { from?: string; cursor?: string; tokenBudget?: number } = { from: epoch }) => buildSincePack(pmRoot, await readPmItems(pmRoot), terminal, { author: "agent-a", tokenBudget: 1_000_000, ...options });
  return { root, pmRoot, client, pack, directory: join(pmRoot, SINCE_RETENTION.directory) };
}

/** Persist SDK-produced sparse history, including intentionally malformed legacy timestamp input. */
async function stream(pmRoot: string, id: string, snapshots: Array<{ ts: string; metadata: Record<string, unknown>; op?: string }>) {
  let before = emptyImportedDocument();
  const entries = [];
  for (const snapshot of snapshots) {
    const after = { metadata: snapshot.metadata as unknown as ItemMetadata, body: "" };
    const entry = createHistoryEntry({ nowIso: epoch, author: "agent-a", op: snapshot.op ?? "update", before, after });
    entries.push({ ...entry, ts: snapshot.ts });
    before = after;
  }
  writeFileSync(join(pmRoot, "history", `${id}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

test("raw history spellings retain invalid-row diagnostics and offset ordering across TZs", async (t) => {
  const f = await fixture(t);
  await stream(f.pmRoot, "delta-time-a", [{ ts: "2020-01-01T10:00:00+02:00", op: "create", metadata: { id: "delta-time-a", title: "Waiting", status: "open", dependencies: [{ id: "delta-time-b", kind: "blocked_by" }] } }]);
  await stream(f.pmRoot, "delta-time-b", [{ ts: "2020-01-01T08:30:00Z", op: "create", metadata: { id: "delta-time-b", title: "Prerequisite", status: "closed" } }]);
  await stream(f.pmRoot, "delta-bad", [
    { ts: " 2020-01-01T07:30:00Z", metadata: {} }, { ts: "2020-01-01T07:30:00Z ", metadata: {} },
  ]);
  await stream(f.pmRoot, "delta-baseline", [{ ts: " 2020-01-01T07:30:00Z", op: "history_compact_baseline", metadata: {} }]);
  const originalTZ = process.env.TZ;
  const packs: SincePack[] = [];
  try {
    for (const tz of ["UTC", "America/New_York"]) {
      process.env.TZ = tz;
      packs.push(await f.pack({ from: "2020-01-01T08:00:00Z" }));
    }
  } finally { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }
  assert.deepEqual(packs[0], packs[1]);
  const pack = packs[0]!;
  assert.equal(pack.omission_receipt.invalid_timestamp_rows, 3);
  assert.deepEqual(pack.omission_receipt.invalid_timestamp_examples.map((row) => [row.id, row.ordinal]), [["delta-bad", 0], ["delta-bad", 1], ["delta-baseline", 0]]);
  assert.deepEqual(pack.omission_receipt.expired_streams, ["delta-baseline"]);
  assert.ok(!pack.changes.some((row) => row.id === "delta-bad"));
  assert.ok(pack.changes.some((row) => row.id === "delta-time-a" && row.op === "unblocked"), "offset replay must close the prerequisite after the waiting item exists");
  assert.deepEqual(pack.changes.filter((row) => row.op === "create").map((row) => row.id), ["delta-time-b", "delta-time-a"], "same-rank rows sort by instant, not timestamp spelling");
  assert.equal(existsSync(join(f.root, ".git")), false);
});

test("ordinary release prose stays below unblocked work while explicit handoffs and releases retain rank", async (t) => {
  const f = await fixture(t);
  const prerequisite = (await create({ title: "Prerequisite", author: "agent-a" }, f.client)).item.id;
  const waiting = (await create({ title: "Waiting", author: "agent-a" }, f.client)).item.id;
  await update(waiting, { dep: [`id=${prerequisite},kind=blocked_by`], author: "agent-a" }, f.client);
  const baseline = await f.pack();
  for (const text of ["Prepared the release notes draft", "The word handoff appears in the docs", "handoff: inspect the parser", "Hand over: run the checks"]) await comments(prerequisite, { add: text, author: "agent-a" }, f.client);
  await claim(prerequisite, { author: "agent-a" }, f.client);
  await release(prerequisite, { author: "agent-a" }, f.client);
  await close(prerequisite, "Release notes complete", { author: "agent-a" }, f.client);
  const pack = await f.pack({ cursor: baseline.cursor });
  const ordinary = pack.changes.find((row) => row.text === "Prepared the release notes draft")!;
  assert.deepEqual(ordinary.kinds, ["comment"]);
  assert.ok(!pack.changes.find((row) => row.text === "The word handoff appears in the docs")!.kinds.includes("handoff"));
  assert.ok(!pack.changes.find((row) => row.op === "close")!.kinds.includes("handoff"));
  assert.ok(pack.changes.find((row) => row.text === "handoff: inspect the parser")!.kinds.includes("handoff"));
  assert.ok(pack.changes.find((row) => row.text === "Hand over: run the checks")!.kinds.includes("handoff"));
  assert.ok(pack.changes.some((row) => row.op === "release" && row.kinds.includes("handoff")));
  assert.ok(pack.changes.indexOf(ordinary) > pack.changes.findIndex((row) => row.op === "unblocked"));
});

test("shared checkpoint inventories retain an idle agent through 199 polls and support 40000 streams", async (t) => {
  const f = await fixture(t);
  const empty = emptyImportedDocument();
  const entry = createHistoryEntry({ nowIso: epoch, author: "agent-a", op: "update", before: empty, after: empty });
  for (let index = 0; index < 1261; index++) writeFileSync(join(f.pmRoot, "history", `delta-scale-${index}.jsonl`), JSON.stringify(entry) + "\n");
  const first = await f.pack({ from: "2099-01-01T00:00:00Z" });
  assert.equal(typeof first.served_at, "string", "the response must expose its serving boundary");
  assert.equal(typeof first.restart_from, "string", "the response must expose a conservative restart boundary");
  assert.match(first.served_at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(first.restart_from, epoch);
  const stored = JSON.parse(readFileSync(join(f.directory, `${first.cursor}.json`), "utf8")) as { streams: string | StreamFingerprint[] };
  const streams = typeof stored.streams === "string" ? JSON.parse(gunzipSync(readFileSync(join(f.directory, `i1_${stored.streams}.gz`))).toString("utf8")) as StreamFingerprint[] : stored.streams;
  for (let index = 1; index < 200; index++) await saveCheckpoint(f.directory, { generation: index, author: `poller-${index % 3}`, streams, pending: [], served_at: first.served_at });
  assert.equal(readdirSync(f.directory).filter((file) => file.endsWith(".json")).length, 200);
  assert.equal((await f.pack({ cursor: first.cursor })).omission_receipt.expired_streams.length, 0, "an idle agent survives all 199 other bounded checkpoints");
  const large = Array.from({ length: 40000 }, (_, index) => ({ id: `delta-large-${index}`, count: 1, hash: createHash("sha256").update(String(index)).digest("hex") }));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > SINCE_RETENTION.bytes);
  const publication = await saveCheckpoint(f.directory, { generation: 201, author: "scale", streams: large, pending: [] });
  assert.ok(existsSync(join(f.directory, `${publication.cursor}.json`)));
  const bytes = readdirSync(f.directory).filter((file) => /\.(?:json|gz)$/.test(file)).reduce((sum, file) => sum + readFileSync(join(f.directory, file)).length, 0);
  assert.ok(bytes <= SINCE_RETENTION.bytes);
});

test("single-stream compaction preserves frozen pages and continues unaffected streams with a receipt", async (t) => {
  const f = await fixture(t);
  const a = (await create({ title: "Compacted", author: "agent-a" }, f.client)).item.id;
  const b = (await create({ title: "Unaffected", author: "agent-a" }, f.client)).item.id;
  const baseline = await f.pack();
  for (let index = 0; index < 8; index++) await comments(a, { add: `Frozen comment ${index}: ${"x".repeat(300)}`, author: "agent-a" }, f.client);
  const complete = await f.pack({ cursor: baseline.cursor });
  let page = await f.pack({ cursor: baseline.cursor, tokenBudget: 2000 });
  assert.ok(page.omission_receipt.deferred_rows > 0);
  await historyCompact(a, { author: "agent-a" }, f.client);
  await comments(a, { add: "Retained after compaction", author: "agent-a" }, f.client);
  await comments(b, { add: "Unaffected after compaction", author: "agent-a" }, f.client);
  const collected = [...page.changes];
  while (page.omission_receipt.deferred_rows) { page = await f.pack({ cursor: page.cursor, tokenBudget: 2000 }); collected.push(...page.changes); }
  assert.deepEqual(collected, complete.changes);
  const next = await f.pack({ cursor: page.cursor });
  assert.deepEqual(next.omission_receipt.expired_streams, [a]);
  assert.ok(next.changes.some((row) => row.text.includes("Unaffected after compaction")));
  assert.ok(next.changes.some((row) => row.text.includes("Retained after compaction")));
  const restart = await f.pack({ from: complete.restart_from });
  assert.ok(restart.changes.some((row) => row.text.includes("Unaffected after compaction")));
  assert.deepEqual(restart.omission_receipt.expired_streams, [a]);
  assert.deepEqual((await f.pack({ cursor: next.cursor })).omission_receipt.expired_streams, []);
});

test("incremental budget packing serializes 500 rows linearly in under one second", async (t) => {
  const f = await fixture(t);
  await create({ title: "Packing row", author: "agent-a" }, f.client);
  const seed = await f.pack();
  for (const count of [125, 250, 500]) {
    const pack = structuredClone(seed);
    pack.budget.ceiling = 8_000_000;
    const rows = Array.from({ length: count }, (_, index) => ({ ...seed.changes[0]!, key: String(index), op: index % 2 ? "own_claim" : "update", text: "αβ".repeat(1000), excerpt_omitted_chars: index % 7 }));
    const original = JSON.stringify;
    let packSerializations = 0;
    const started = performance.now();
    try {
      JSON.stringify = ((value: unknown) => {
        if (value && typeof value === "object" && "protocol" in value && value.protocol === "pm-context-since/v1") packSerializations++;
        return original(value);
      }) as typeof JSON.stringify;
      assert.equal(packSinceRows(pack, rows), count);
    } finally { JSON.stringify = original; }
    const elapsed = performance.now() - started;
    assert.ok(packSerializations <= 2, `whole-pack serializations: ${packSerializations}`);
    assert.ok(elapsed < 1000, `${count} rows took ${elapsed.toFixed(2)} ms`);
    assert.equal(Buffer.byteLength(JSON.stringify(pack) + "\n"), pack.budget.token_upper_bound);
    t.diagnostic(`${count} rows: ${elapsed.toFixed(2)} ms, ${packSerializations} whole-pack serializations, ${pack.budget.token_upper_bound} bytes`);
  }
});

test("graph events update reverse adjacency without full document scans and preserve shared edges", async (t) => {
  const f = await fixture(t);
  const sentinel = "delta-index-000";
  for (let index = 0; index < 64; index++) {
    const id = `delta-index-${String(index).padStart(3, "0")}`;
    await stream(f.pmRoot, id, ["open", "blocked", "open"].map((status, step) => ({ ts: `2020-01-01T00:00:0${step}Z`, metadata: { id, title: index ? "Independent" : "Graph sentinel", status } })));
  }
  const originalIterator = Map.prototype[Symbol.iterator];
  const originalKeys = Map.prototype.keys;
  const originalGet = Map.prototype.get;
  let fullScans = 0;
  /** Count only complete iteration of the actual replay document map. */
  function count(map: Map<unknown, unknown>): void {
    const value: unknown = originalGet.call(map, sentinel);
    if (value && typeof value === "object" && "title" in value && value.title === "Graph sentinel") fullScans++;
  }
  try {
    Map.prototype[Symbol.iterator] = function <K, V>(this: Map<K, V>): MapIterator<[K, V]> { count(this); return originalIterator.call(this) as MapIterator<[K, V]>; };
    Map.prototype.keys = function <K, V>(this: Map<K, V>): MapIterator<K> { count(this); return originalKeys.call(this) as MapIterator<K>; };
    const pack = await f.pack();
    assert.equal(pack.changes.filter((row) => row.op === "unblocked").length, 64);
    assert.ok(fullScans <= 1, `192 graph events caused ${fullScans} whole-document scans`);
  } finally { Map.prototype[Symbol.iterator] = originalIterator; Map.prototype.keys = originalKeys; }
  const a = (await create({ title: "Shared waiter", author: "agent-a" }, f.client)).item.id;
  const b = (await create({ title: "Shared prerequisite", author: "agent-a" }, f.client)).item.id;
  await update(a, { dep: [`id=${b},kind=blocked_by`], author: "agent-a" }, f.client);
  await update(b, { dep: [`id=${a},kind=blocks`], author: "agent-a" }, f.client);
  const before = await f.pack();
  await update(a, { depRemove: [b], author: "agent-a" }, f.client);
  const shared = await f.pack({ cursor: before.cursor });
  assert.ok(!shared.changes.some((row) => row.id === a && row.op === "unblocked"));
  await close(b, "Ready", { author: "agent-a" }, f.client);
  assert.equal((await f.pack({ cursor: shared.cursor })).changes.filter((row) => row.id === a && row.op === "unblocked").length, 1);
});

test("shared inventory corruption expires safely and invalid timestamp diagnostics stay bounded", async (t) => {
  const f = await fixture(t);
  await stream(f.pmRoot, "delta-invalid", Array.from({ length: 12 }, () => ({ ts: " ".repeat(1000) + epoch, metadata: {} })));
  const pack = await f.pack();
  assert.equal(pack.omission_receipt.invalid_timestamp_rows, 12);
  assert.equal(pack.omission_receipt.invalid_timestamp_examples.length, 8);
  assert.ok(pack.omission_receipt.invalid_timestamp_examples.every((row) => row.ts.length === 128));
  const raw = readFileSync(join(f.directory, `${pack.cursor}.json`), "utf8");
  const stored = JSON.parse(raw) as Omit<Checkpoint, "streams"> & { streams: string };
  const path = join(f.directory, `i1_${stored.streams}.gz`);
  for (const bytes of [Buffer.from("bad gzip"), gzipSync("[]")]) {
    writeFileSync(path, bytes);
    await assert.rejects(f.pack({ cursor: pack.cursor }), (error: unknown) => error instanceof SinceError && error.code === "CURSOR_EXPIRED");
    assert.equal((await f.pack()).cursor, pack.cursor, "a fresh window repairs damaged inventory atomically");
  }
  rmSync(path);
  await assert.rejects(f.pack({ cursor: pack.cursor }), (error: unknown) => error instanceof SinceError && error.code === "CURSOR_EXPIRED");
  assert.equal((await f.pack()).cursor, pack.cursor);
  const malformed = { ...stored, streams: "../outside", generation: 20 };
  const { served_at: _servedAt, ...identity } = malformed;
  const badCursor = `s1_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  writeFileSync(join(f.directory, `${badCursor}.json`), JSON.stringify(malformed));
  await assert.rejects(f.pack({ cursor: badCursor }), (error: unknown) => error instanceof SinceError && error.code === "CURSOR_EXPIRED");
  for (const damaged of ["{", JSON.stringify({ ...stored, served_at: undefined }), JSON.stringify({ ...stored, served_at: "bad" }), JSON.stringify({ ...stored, served_at: epoch }), JSON.stringify({ ...stored, served_at: "9999-99-99T99:99:99.999Z" }), JSON.stringify({ ...stored, generation: 400 })]) {
    writeFileSync(join(f.directory, `${pack.cursor}.json`), damaged);
    assert.match((await f.pack()).served_at, /^\d{4}-/);
  }
  for (const value of [null, 5]) {
    const bad = JSON.stringify(value);
    const token = `s1_${createHash("sha256").update(bad).digest("hex")}`;
    writeFileSync(join(f.directory, `${token}.json`), bad);
    await assert.rejects(f.pack({ cursor: token }), (error: unknown) => error instanceof SinceError && error.code === "INVALID_CURSOR");
    rmSync(join(f.directory, `${token}.json`));
  }
  // Force collection of both missing and last-referenced valid inventories.
  rmSync(path);
  writeFileSync(join(f.directory, `i1_${"f".repeat(64)}.gz`), gzipSync("[]"));
  const state: Checkpoint = { generation: 100, author: "agent-a", streams: [], pending: [] };
  await assert.rejects(saveCheckpoint(f.directory, { ...state, served_at: "bad" }), (error: unknown) => error instanceof SinceError && error.code === "INVALID_CURSOR");
  assert.equal((await saveCheckpoint(f.directory, { ...state, served_at: epoch })).served_at, "2000-01-01T00:00:00.000Z");
  await saveCheckpoint(f.directory, { ...state, generation: 101, streams: [{ id: "delta-old", count: 1, hash: "0".repeat(64) }] });
  for (let index = 0; index < 201; index++) writeFileSync(join(f.directory, `s1_${index.toString(16).padStart(64, "0")}.json`), " ".repeat(22000));
  await saveCheckpoint(f.directory, { ...state, generation: 102 });
  assert.ok(!existsSync(join(f.directory, `i1_${"f".repeat(64)}.gz`)));
});
