/** Reproducible public-copy session benchmark; never writes to the source checkout. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claim, comments, create } from "@unbrained/pm-cli/sdk/core";
import { buildSincePack } from "../since.ts";
import type { SincePack } from "../since.ts";
import { readPmItems } from "../index.ts";

const source = process.argv[2];
assert.ok(source, "Usage: node test/measure-since.ts <public-checkout> [commit]");
const ref = process.argv[3] ?? "HEAD";
const packageRoot = resolve(import.meta.dirname, "..");
const output = join(packageRoot, "coverage", "since-benchmark");
const root = mkdtempSync(join(tmpdir(), "public-delta-benchmark-"));
const cli = process.env.PM_BENCHMARK_CLI ?? "pm";
const author = "delta-benchmark";
const pmRoot = join(root, ".agents", "pm");

/** Invoke the installed current host against only the isolated tracker copy. */
function run(args: string[]): string {
  const result = spawnSync(cli, ["--pm-path", pmRoot, ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PM_AUTHOR: author, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

try {
  const archive = execFileSync("git", ["-C", source, "archive", ref, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", root], { input: archive });
  const install = join(pmRoot, "extensions", "pm-context");
  mkdirSync(install, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(install, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(install, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(install, "node_modules"), "dir");
  const items = await readPmItems(pmRoot);
  const publicSha = execFileSync("git", ["-C", source, "rev-parse", ref], { encoding: "utf8" }).trim();
  console.log(JSON.stringify({ item_count: items.length, public_sha: publicSha, cli_version: execFileSync(cli, ["--version"], { encoding: "utf8" }).trim() }));
  const client = { cwd: root, pmRoot };
  const seeded = (await create({ title: "Synthetic resume session on a public tracker copy", author }, client)).item;
  const id = seeded.id;
  await claim(id, { author }, client);
  const baseline = await buildSincePack(pmRoot, await readPmItems(pmRoot), new Set(["closed", "canceled"]), {
    author, tokenBudget: 12000, from: new Date(Date.now() + 86_400_000).toISOString(),
  });
  let cursor = baseline.cursor;
  for (const session of [1, 2]) {
    const from = new Date().toISOString();
    const text = `handoff session ${session}: acceptance is ready; next implement the parser edge case and rerun focused checks.`;
    await comments(id, { add: text, author }, client);
    const core = [run(["activity", "--from", from]), run(["activity", "--from", from, "--raw"]), run(["comments", id])];
    const delta = run(["context-pack", "since", "--cursor", cursor, "--token-budget", "12000"]);
    const pack = JSON.parse(delta) as SincePack;
    // This fourth, oracle-only read is validation instrumentation, not part of either measured route.
    const oracle = JSON.parse(run(["activity", "--from", from, "--raw", "--json", "--unbounded"])) as {
      compact_activity: Array<{ id: string; op: string; ts: string; author: string }>;
    };
    const missing = oracle.compact_activity.filter((event) => !pack.changes.some((row) => row.id === event.id && row.op === event.op && row.ts === event.ts && row.author === event.author));
    assert.deepEqual(missing, []);
    assert.ok(pack.changes.some((row) => row.text.includes(text)));
    assert.ok(pack.changes.some((row) => row.id === id && row.title === seeded.title && row.status === seeded.status && row.type === seeded.type));
    assert.equal(pack.omission_receipt.deferred_rows, 0);
    const directory = join(output, `session-${session}`);
    mkdirSync(directory, { recursive: true });
    core.forEach((value, index) => writeFileSync(join(directory, `core-${index + 1}.txt`), value));
    writeFileSync(join(directory, "delta.json"), delta);
    console.log(JSON.stringify({ session, core_calls: 3, delta_calls: 1, core_bytes: core.reduce((sum, value) => sum + Buffer.byteLength(value), 0), delta_bytes: Buffer.byteLength(delta), covered_events: oracle.compact_activity.length, missing_events: missing.length, substantive_comment: true, deferred_rows: pack.omission_receipt.deferred_rows }));
    cursor = pack.cursor;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
