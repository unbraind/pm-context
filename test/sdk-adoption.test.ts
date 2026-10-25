import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create, createHistoryEntry, emptyImportedDocument, init, listAllComplete, PmCliError } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/query";
import { readFileFocusItems } from "../file-focus.ts";
import { buildSincePack, SINCE_RETENTION } from "../since.ts";

test("complete-list adoption needs a cache-free SDK policy to preserve file-focus reads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "context-sdk-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("policy", { defaults: true, agentGuidance: "skip" }, client);
  const { item } = await create({ title: "Read policy", author: "fixture" }, client);
  assert.equal(existsSync(join(root, ".git")), false);
  const runtime = join(client.pmRoot, "runtime");
  assert.equal(existsSync(runtime), false);
  assert.deepEqual((await readFileFocusItems(client.pmRoot)).map((row) => row.id), [item.id]);
  assert.equal(existsSync(runtime), false, "file focus must remain free of cache writes");
  const complete = certifyCompleteListResult(await listAllComplete({ includeBody: true }, client));
  assert.deepEqual(complete.items.map((row) => row.id), [item.id]);
  assert.ok(readdirSync(runtime).includes("metadata-cache.json"), "the proposed SDK replacement currently writes caches");
});

test("SDK event admission refuses malformed and sub-millisecond history before publishing a cursor", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "context-sdk-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("events", { defaults: true, agentGuidance: "skip" }, client);
  const empty = emptyImportedDocument();
  const entry = createHistoryEntry({ nowIso: "2020-01-01T00:00:00.000Z", author: "fixture", op: "update", before: empty, after: empty });
  for (const ts of ["2020-01-01T00:00:00", "unparseable", "2020-01-01T00:00:00.0001Z"]) {
    writeFileSync(join(client.pmRoot, "history", "events-legacy.jsonl"), JSON.stringify({ ...entry, ts }) + "\n");
    await assert.rejects(buildSincePack(client.pmRoot, [], new Set(["closed", "canceled"]), {
      from: "2000-01-01T00:00:00Z", author: "fixture", tokenBudget: 100_000,
    }), (error: unknown) => error instanceof PmCliError && error.code === "history_timestamp_invalid");
    assert.equal(existsSync(join(client.pmRoot, SINCE_RETENTION.directory)), false);
  }
});
