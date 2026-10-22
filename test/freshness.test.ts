import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { init, locateItem } from "@unbrained/pm-cli/sdk";
import { create, update, comments, deleteItem } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { createFreshnessReader, encodeFreshness, FRESHNESS_LIMITS, FreshnessError, parseFreshnessPacket, readFreshnessFile, readFreshnessJson, recordFreshness, resumeFreshness } from "../index.ts";
import type { FreshnessManifest, FreshnessPacket, FreshnessResult } from "../index.ts";

/** Persist real SDK trackers without any parent Git discovery. */
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "freshness-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("fresh", { defaults: true, author: "agent-a", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const client = { cwd: root, pmRoot };
  const a = (await create({ title: "API assumption", author: "agent-a" }, client)).item.id;
  const b = (await create({ title: "Independent assumption", author: "agent-a" }, client)).item.id;
  writeFileSync(join(root, "evidence.txt"), "verified API v1\n");
  const packet: FreshnessPacket = { sections: [
    { id: "api", content: "The API is available", sources: [{ kind: "item", id: a, fields: ["title", "status", "description", "tags", "missing_field"] }, { kind: "evidence", path: "evidence.txt" }], depends_on: [] },
    { id: "settings", content: "Workspace policy", sources: [{ kind: "settings", fields: ["author_default"] }], depends_on: [] },
    { id: "plan", content: "Implement against the API", sources: [], depends_on: ["api", "settings"] },
    { id: "review", content: "Review the plan", sources: [], depends_on: ["plan", "api"] },
    { id: "other", content: "Unrelated work", sources: [{ kind: "item", id: b }], depends_on: [] },
  ] };
  const read = createFreshnessReader(pmRoot, root);
  const manifest = await recordFreshness(packet, read);
  return { root, pmRoot, client, a, b, packet, manifest, read };
}
/** Confirm expected categories retain bounded remedies and usage status. */
function code(expected: string) { return (error: unknown) => error instanceof FreshnessError && error.code === expected && error.exitCode === 2 && !!error.remedy; }

test("same adapter sees later item and evidence changes, propagating only dependent assumptions", async (t) => {
  const f = await fixture(t);
  const before = readFileSync(join(f.pmRoot, "history", `${f.a}.jsonl`));
  const fresh = await resumeFreshness(f.packet, f.manifest, f.read);
  assert.equal(fresh.code, "FRESH");
  assert.equal(fresh.reusable, true);
  assert.equal(fresh.unchanged_sections, 5);
  assert.deepEqual(fresh.invalidated, []);
  await comments(f.a, { add: "Unrelated comment", author: "agent-a" }, f.client);
  assert.equal((await resumeFreshness(f.packet, f.manifest, f.read)).code, "FRESH", "unobserved fields must not invalidate the projection");
  await update(f.a, { title: "Changed API assumption", author: "agent-a" }, f.client);
  const changed = await resumeFreshness(f.packet, f.manifest, f.read);
  assert.equal(changed.code, "STALE");
  assert.equal(changed.reusable, false);
  assert.deepEqual(changed.invalidated.map((row) => row.section), ["api", "plan", "review"]);
  assert.equal(changed.unchanged_sections, 2);
  assert.ok(changed.invalidated.every((row) => row.causes.length === 1));
  writeFileSync(join(f.root, "evidence.txt"), "verified API v2\n");
  const evidence = await resumeFreshness(f.packet, f.manifest, f.read);
  assert.ok(evidence.invalidated.every((row) => row.causes.length === 2));
  assert.ok(!JSON.stringify(f.manifest).includes("verified API"), "manifests must not store evidence contents");
  assert.notDeepEqual(before, readFileSync(join(f.pmRoot, "history", `${f.a}.jsonl`)));
  const history = readFileSync(join(f.pmRoot, "history", `${f.a}.jsonl`));
  const rerecorded = await recordFreshness(f.packet, f.read);
  assert.equal((await resumeFreshness(f.packet, rerecorded, f.read)).reusable, true);
  assert.deepEqual(history, readFileSync(join(f.pmRoot, "history", `${f.a}.jsonl`)), "validation never mutates item history");
});

test("settings changes, missing items and unreadable evidence fail closed with bounded receipts", async (t) => {
  const f = await fixture(t);
  const path = join(f.pmRoot, "settings.json");
  const settings = readFreshnessJson(path) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...settings, author_default: "agent-b" }));
  const changed = await resumeFreshness(f.packet, f.manifest, f.read);
  assert.deepEqual(changed.invalidated.map((row) => row.section), ["settings", "plan", "review"]);
  writeFileSync(path, JSON.stringify(settings));
  await deleteItem(f.b, { author: "agent-a" }, f.client);
  chmodSync(join(f.root, "evidence.txt"), 0);
  const missing = await resumeFreshness(f.packet, f.manifest, f.read);
  assert.equal(missing.code, "SOURCE_UNAVAILABLE");
  assert.equal(missing.unavailable_sources, 2);
  assert.equal(missing.reusable, false);
  assert.deepEqual(missing.invalidated.map((row) => row.section), ["api", "plan", "review", "other"]);
  assert.ok(Buffer.byteLength(encodeFreshness(missing, "json", 4000)) <= 4000);
  assert.ok(!JSON.stringify(missing).includes(f.root));
  await assert.rejects(recordFreshness(f.packet, f.read), code("SOURCE_UNAVAILABLE"));
  rmSync(path);
  assert.equal((await resumeFreshness(f.packet, f.manifest, f.read)).unavailable_sources, 4);
});

test("canonical property order, source sharing and field absence are stable", async (t) => {
  const f = await fixture(t);
  const packet: FreshnessPacket = { sections: [{ id: "all", content: "policy", sources: [{ kind: "settings" }, { kind: "settings" }], depends_on: [] }] };
  const baseline = await recordFreshness(packet, f.read);
  assert.equal(baseline.sources.length, 1);
  const path = join(f.pmRoot, "settings.json");
  const settings = readFreshnessJson(path) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(settings).reverse())));
  assert.equal((await resumeFreshness(packet, baseline, f.read)).reusable, true);
  const same = structuredClone(f.packet);
  same.sections[0]!.sources.reverse();
  await assert.rejects(resumeFreshness(same, f.manifest, f.read), code("INVALID_MANIFEST"));
});

test("packet parser refuses malformed, oversized, cyclic and unknown dependency declarations", () => {
  const valid = { sections: [{ id: "one", content: "fact", sources: [{ kind: "settings" }], depends_on: [] }] };
  const invalid: unknown[] = [undefined, null, [], {}, { sections: [] }, { ...valid, extra: true }, { sections: [null] }];
  const section = valid.sections[0]!;
  for (const patch of [{ id: "../private" }, { content: 3 }, { extra: true }, { sources: [] }, { depends_on: ["missing"] }, { depends_on: ["one"] }, { depends_on: ["one", "one"] }, { depends_on: [3] }, { sources: [null] }]) invalid.push({ sections: [{ ...section, ...patch }] });
  invalid.push({ sections: [section, section] }, { sections: Array.from({ length: 257 }, (_, i) => ({ ...section, id: `s${i}` })) }, { sections: [{ ...section, content: "x".repeat(FRESHNESS_LIMITS.input_bytes) }] });
  const cycle: { self?: unknown } = {}; cycle.self = cycle; invalid.push(cycle);
  const badSources: unknown[] = [{ kind: "unknown" }, { kind: "item", id: "../bad" }, { kind: "settings", id: "extra" }, { kind: "settings", fields: [] }, { kind: "settings", fields: ["title", "title"] }, { kind: "settings", fields: [3] }, { kind: "evidence", path: "../secret" }, { kind: "evidence", path: "/private" }, { kind: "evidence", path: "https://example.test" }, { kind: "evidence", path: "a\\b" }, { kind: "evidence", path: "a//b" }, { kind: "evidence", path: "" }, { kind: "evidence", path: "./a" }, { kind: "evidence", path: "x".repeat(513) }];
  for (const source of badSources) invalid.push({ sections: [{ ...section, sources: [source] }] });
  invalid.push({ sections: [{ ...section, sources: Array.from({ length: 1025 }, (_, i) => ({ kind: "item", id: `item-${i}` })) }] });
  for (const value of invalid) assert.throws(() => parseFreshnessPacket(value), code("INVALID_PACKET"));
  assert.deepEqual(parseFreshnessPacket(valid), valid);
});

test("manifest validation rejects corruption, mismatches, duplicate, missing and unknown sources", async (t) => {
  const f = await fixture(t);
  const entry = f.manifest.sources[0]!;
  const invalid: unknown[] = [null, {}, { ...f.manifest, extra: true }, { ...f.manifest, protocol: "next" }, { ...f.manifest, packet_digest: "0".repeat(64) }, { ...f.manifest, sources: null }, { ...f.manifest, sources: Array(1025).fill(null) }, { ...f.manifest, sources: [] }];
  for (const row of [null, {}, { ...entry, extra: true }, { ...entry, source: { kind: "unknown" } }, { ...entry, digest: 3 }, { ...entry, digest: "bad" }]) invalid.push({ ...f.manifest, sources: [row] });
  invalid.push({ ...f.manifest, sources: [...f.manifest.sources, entry] });
  for (const value of invalid) await assert.rejects(resumeFreshness(f.packet, value as FreshnessManifest, f.read), code("INVALID_MANIFEST"));
});

test("regular-file guards reject oversize, symlinks, directories, invalid JSON and escaped evidence roots", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "evidence.txt");
  assert.equal(readFreshnessFile(path).toString(), "verified API v1\n");
  assert.throws(() => readFreshnessFile(path, 2), code("INPUT_UNAVAILABLE"));
  assert.throws(() => readFreshnessFile(f.root), code("INPUT_UNAVAILABLE"));
  assert.throws(() => readFreshnessJson(path), code("INPUT_UNAVAILABLE"));
  assert.throws(() => readFreshnessFile(join(f.root, "missing")), code("INPUT_UNAVAILABLE"));
  symlinkSync(path, join(f.root, "link"));
  assert.throws(() => readFreshnessFile(join(f.root, "link")), code("INPUT_UNAVAILABLE"));
  symlinkSync(tmpdir(), join(f.root, "escape"));
  const escape = { kind: "evidence", path: "escape/outside.txt" } as const;
  await assert.rejects(f.read(escape));
  await assert.rejects(f.read({ kind: "evidence", path: "../outside" }));
  writeFileSync(path, Buffer.from([0x22, 0xff, 0x22]));
  assert.throws(() => readFreshnessJson(path), code("INPUT_UNAVAILABLE"));
  writeFileSync(path, "");
  assert.equal(readFreshnessFile(path).length, 0);
});

test("byte budgets retain complete invalidation rows and disclose omissions in JSON and TOON", async (t) => {
  const f = await fixture(t);
  await update(f.a, { title: "Changed", author: "agent-a" }, f.client);
  const report = await resumeFreshness(f.packet, f.manifest, f.read);
  const full = encodeFreshness(report, "json", 4000);
  const limited = JSON.parse(encodeFreshness(report, "json", Buffer.byteLength(full) - 1)) as FreshnessResult;
  assert.equal(limited.invalidated.length, 2);
  assert.equal(limited.omitted_sections, 1);
  assert.equal(limited.invalidated_sections, 3);
  assert.equal(limited.reusable, false);
  assert.equal(report.omitted_sections, 0, "serialization must not mutate SDK results");
  const toon = encodeFreshness(report, "toon", 4000);
  assert.deepEqual(decodeToon(toon), report);
  assert.match(toon, /invalidated\[3\]:/);
  assert.match(toon, /causes\[1\]:/);
  assert.ok(!toon.includes("other"));
  for (const budget of [NaN, 511, 1.5]) assert.throws(() => encodeFreshness(report, "json", budget), code("INVALID_ARGUMENT"));
  assert.throws(() => encodeFreshness(report, "json", 512), code("BUDGET_TOO_SMALL"));
  assert.throws(() => encodeFreshness(f.manifest, "toon", 4000), code("INVALID_ARGUMENT"));
  assert.throws(() => encodeFreshness(f.manifest, "json", 512), code("BUDGET_TOO_SMALL"));
  assert.equal((JSON.parse(encodeFreshness(f.manifest, "json", 4000)) as FreshnessManifest).protocol, f.manifest.protocol);
});

test("wide freshness packets avoid repeated section searches and quadratic JSON or TOON trimming", async (t) => {
  const f = await fixture(t);
  const packet: FreshnessPacket = { sections: Array.from({ length: 256 }, (_, index) => ({ id: `wide-${index}-${"x".repeat(80)}`, content: "Declared assumption", sources: [{ kind: "item", id: f.a, fields: ["title"] }], depends_on: [] })) };
  const originalFind = Array.prototype.find;
  let searches = 0;
  let report: FreshnessResult;
  try {
    Array.prototype.find = (function <T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T | undefined {
      const first: unknown = this[0];
      if (first && typeof first === "object" && "id" in first && typeof first.id === "string" && first.id.startsWith("wide-")) searches++;
      return Reflect.apply(originalFind, this, [predicate, thisArg]) as T | undefined;
    }) as typeof Array.prototype.find;
    const baseline = await recordFreshness(packet, f.read);
    await update(f.a, { title: "Changed assumption", author: "agent-a" }, f.client);
    report = await resumeFreshness(packet, baseline, f.read);
    assert.equal(searches, 0, "section traversal must use the ID index");
  } finally { Array.prototype.find = originalFind; }
  for (const format of ["json", "toon"] as const) {
    const original = JSON.stringify;
    let whole = 0; let sections = 0;
    let output: string;
    try {
      JSON.stringify = ((value: unknown) => {
        if (value && typeof value === "object" && "protocol" in value && value.protocol === "pm-context-freshness/v1") whole++;
        if ((typeof value === "string" && value.startsWith("wide-")) || (value && typeof value === "object" && "section" in value)) sections++;
        return original(value);
      }) as typeof JSON.stringify;
      output = encodeFreshness(report!, format, 4000);
    } finally { JSON.stringify = original; }
    const result = (format === "json" ? JSON.parse(output!) : decodeToon(output!)) as FreshnessResult;
    assert.ok(result.invalidated.length > 0 && result.invalidated.length < 256);
    assert.equal(result.omitted_sections, 256 - result.invalidated.length);
    assert.deepEqual(result.invalidated, report!.invalidated.slice(0, result.invalidated.length));
    assert.ok(whole <= 2 && sections <= 512, `${format}: ${whole} complete encodes, ${sections} section encodes`);
    assert.ok(Buffer.byteLength(output!) <= 4000);
    assert.equal(encodeFreshness(report!, format, Buffer.byteLength(output!)), output!);
    const smaller = encodeFreshness(report!, format, Buffer.byteLength(output!) - 1);
    assert.ok(Buffer.byteLength(smaller) < Buffer.byteLength(output!));
  }
  assert.equal(report!.omitted_sections, 0);
});

test("installed CLI records/resumes without a Git executable and returns typed refusals", async (t) => {
  const f = await fixture(t);
  const packageRoot = resolve(import.meta.dirname, "..");
  const install = join(f.pmRoot, "extensions", "pm-context");
  mkdirSync(install, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(install, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(install, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(install, "node_modules"), "dir");
  const emptyPath = join(f.root, "empty-path"); mkdirSync(emptyPath);
  const packetPath = join(f.root, "packet.json"); writeFileSync(packetPath, JSON.stringify(f.packet));
  const manifestPath = join(f.root, "manifest.json");
  /** Exercise the real parser and package loader, with a PATH that cannot launch Git. */
  function run(args: string[]) {
    return spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-freshness", ...args], { cwd: f.root, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM_"))), PM_PATH: f.pmRoot, PM_AUTHOR: "agent-a", PATH: emptyPath, GIT_CEILING_DIRECTORIES: tmpdir() } });
  }
  const history = readFileSync(join(f.pmRoot, "history", `${f.a}.jsonl`));
  const captured = run(["record", "--packet", packetPath, "--evidence-root", f.root]);
  assert.equal(captured.status, 0, captured.stderr);
  writeFileSync(manifestPath, captured.stdout);
  const base = ["resume", "--packet", packetPath, "--manifest", manifestPath, "--evidence-root", f.root];
  const fresh = run([...base, "--json"]);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal((JSON.parse(fresh.stdout) as FreshnessResult).reusable, true);
  const defaultRoot = run(["resume", "--packet", packetPath, "--manifest", manifestPath, "--json"]);
  assert.equal(defaultRoot.status, 0, defaultRoot.stderr);
  assert.equal((JSON.parse(defaultRoot.stdout) as FreshnessResult).reusable, true);
  const toon = run(base); assert.equal(toon.status, 0, toon.stderr); assert.match(toon.stdout, /code: "FRESH"/);
  assert.deepEqual(history, readFileSync(join(f.pmRoot, "history", `${f.a}.jsonl`)));
  chmodSync(join(f.root, "evidence.txt"), 0);
  const refused = run([...base, "--format", "json", "--byte-budget", "1500"]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal((JSON.parse(refused.stdout) as FreshnessResult).code, "SOURCE_UNAVAILABLE");
  assert.ok(Buffer.byteLength(refused.stdout) <= 1500);
  const invalid = run(["record", "--packet", packetPath, "--format", "invalid", "--json"]);
  assert.equal(invalid.status, 2);
  assert.equal((JSON.parse(invalid.stderr) as { code: string }).code, "INVALID_ARGUMENT");
  for (const budget of ["Infinity", "512.5", "511"]) assert.equal(run([...base, "--byte-budget", budget, "--json"]).status, 2);
  for (const args of [["record"], ["resume", "--packet", packetPath], ["record", "--packet", packetPath, "--manifest", manifestPath], ["record", "--packet", packetPath, "--format", "toon"]]) assert.equal(run([...args, "--json"]).status, 2);
});

test("registered handlers honor defaults and expose both renderer formats", async (t) => {
  const f = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
  t.after(() => harness.deactivate());
  const packet = join(f.root, "packet.json"); writeFileSync(packet, JSON.stringify(f.packet));
  const manifest = join(f.root, "manifest.json"); writeFileSync(manifest, JSON.stringify(f.manifest));
  const small: FreshnessPacket = { sections: [{ id: "policy", content: "Policy", sources: [{ kind: "settings" }], depends_on: [] }] };
  const smallPath = join(f.root, "small.json"); writeFileSync(smallPath, JSON.stringify(small));
  const defaults = await harness.runCommand({ command: "context-freshness record", pmRoot: f.pmRoot, options: { packet: smallPath }, global: { json: false } });
  assert.equal(defaults.errorMessage, undefined);
  for (const action of ["record", "resume"]) {
    const result = await harness.runCommand({ command: `context-freshness ${action}`, pmRoot: f.pmRoot, options: { packet, ...(action === "resume" ? { manifest } : {}), "evidence-root": f.root }, global: {} });
    assert.equal(result.errorMessage, undefined);
  }
});


test("source adapters reject missing values and guarded reads detect concurrent growth or rewrites", async (t) => {
  const f = await fixture(t);
  // This custom backend violates the documented reader contract after a real source read.
  await assert.rejects(recordFreshness(f.packet, async (source) => { await f.read(source); return undefined; }), code("SOURCE_UNAVAILABLE"));
  const path = join(f.root, "evidence.txt");
  const originalRead = fs.readSync;
  const originalStat = fs.fstatSync;
  try {
    let first = true;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      if (first) { first = false; writeFileSync(path, "a larger concurrent replacement"); }
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    assert.throws(() => readFreshnessFile(path), code("INPUT_UNAVAILABLE"));
    fs.readSync = originalRead;
    let calls = 0;
    fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
      if (++calls === 2) writeFileSync(path, "x");
      return Reflect.apply(originalStat, fs, args);
    }) as typeof fs.fstatSync;
    syncBuiltinESMExports();
    assert.throws(() => readFreshnessFile(path), code("INPUT_UNAVAILABLE"));
  } finally { fs.readSync = originalRead; fs.fstatSync = originalStat; syncBuiltinESMExports(); }
});


test("item source changes during SDK parsing refuse rather than certifying mismatched bytes", async (t) => {
  const f = await fixture(t);
  const located = await locateItem(f.pmRoot, f.a);
  assert.ok(located);
  const original = fsPromises.readFile;
  let changed = false;
  try {
    fsPromises.readFile = (async (...args: Parameters<typeof fsPromises.readFile>) => {
      if (args[0] === located.itemPath && !changed) {
        changed = true;
        writeFileSync(located.itemPath, readFileSync(located.itemPath, "utf8") + "\n");
      }
      return Reflect.apply(original, fsPromises, args);
    }) as typeof fsPromises.readFile;
    const result = await resumeFreshness(f.packet, f.manifest, f.read);
    assert.equal(result.code, "SOURCE_UNAVAILABLE");
    assert.equal(result.unavailable_sources, 1);
    assert.ok(changed);
  } finally { fsPromises.readFile = original; }
});


test("handlers reject malformed flags and return unavailable receipts without process leakage", async (t) => {
  const f = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
  t.after(() => harness.deactivate());
  const packet = join(f.root, "packet.json"); writeFileSync(packet, JSON.stringify(f.packet));
  const manifest = join(f.root, "manifest.json"); writeFileSync(manifest, JSON.stringify(f.manifest));
  for (const options of [{}, { packet, manifest }, { packet, format: "invalid" }, { packet, format: "toon" }, { packet, "byte-budget": "Infinity" }, { packet, "byte-budget": "511" }]) {
    await assert.rejects(harness.runCommand({ command: "context-freshness record", pmRoot: f.pmRoot, options, global: {} }), code("INVALID_ARGUMENT"));
  }
  await assert.rejects(harness.runCommand({ command: "context-freshness resume", pmRoot: f.pmRoot, options: { packet }, global: {} }), code("INVALID_ARGUMENT"));
  const toon = await harness.runCommand({ command: "context-freshness resume", pmRoot: f.pmRoot, options: { packet, manifest, "evidence-root": f.root }, global: { json: false } });
  assert.equal((decodeToon((toon.result as { output: string }).output) as unknown as FreshnessResult).code, "FRESH");
  chmodSync(join(f.root, "evidence.txt"), 0);
  const savedExit = process.exitCode;
  try {
    const result = await harness.runCommand({ command: "context-freshness resume", pmRoot: f.pmRoot, options: { packet, manifest, "evidence-root": f.root }, global: {} });
    assert.equal(process.exitCode, 2);
    assert.equal((JSON.parse((result.result as { output: string }).output) as FreshnessResult).code, "SOURCE_UNAVAILABLE");
  } finally { process.exitCode = savedExit; }
});

test("a descriptor close failure is sanitized and never exposes raw exception text", async (t) => {
  const f = await fixture(t);
  const original = fs.closeSync;
  try {
    fs.closeSync = (fd: number) => { original(fd); throw new Error("private IO detail"); };
    syncBuiltinESMExports();
    assert.throws(() => readFreshnessFile(join(f.root, "evidence.txt")), (error: unknown) => code("INPUT_UNAVAILABLE")(error) && error instanceof Error && !error.message.includes("private IO detail"));
  } finally { fs.closeSync = original; syncBuiltinESMExports(); }
});
