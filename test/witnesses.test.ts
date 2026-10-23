import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { init } from "@unbrained/pm-cli/sdk";
import { create } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { checkContextWitnesses, encodeWitnessReport, parseWitnessPacket, readWitnessPacket, WitnessError } from "../index.ts";
import type { ContextClaim, WitnessPacket } from "../index.ts";

/** Explicitly scoped assertions, with no lexical inference from their citation. */
function claim(id: string, patch: Partial<ContextClaim> = {}): ContextClaim {
  return { id, kind: "state", subject: "service", field: "status", scope: "production-now", value: "open", citation: { item: "fixture-item", field: "/metadata/status" }, ...patch };
}
/** Expected refusal shape shared with the host's structured error renderer. */
function code(expected: string) { return (error: unknown) => error instanceof WitnessError && error.code === expected && error.exitCode === 2 && !!error.remedy; }
/** Hash all tracker files, including runtime metadata, to detect read-side effects. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    hash.update(entry.name);
    hash.update(entry.isSymbolicLink() ? "symbolic-link" : entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}

for (const kind of ["state", "policy", "supersession"] as const) {
  test(`${kind} returns a stable smallest cited witness with an irrelevant assertion excluded`, () => {
    const a = claim("a", kind === "policy" ? { kind: "policy", value: "required" } : {});
    const b = claim("b", kind === "policy" ? { kind: "policy", value: "forbidden" } : kind === "state" ? { value: "closed" } : { supersedes: ["a"] });
    const input = { claims: [claim("z", { subject: "other" }), b, a] };
    const before = JSON.stringify(input);
    const report = checkContextWitnesses(input);
    assert.equal(report.code, "CONTRADICTION");
    assert.equal(report.conflicting_pairs, 1);
    assert.equal(report.witness?.rule, { state: "CONFLICTING_STATE", policy: "EXCLUSIVE_POLICY", supersession: "SUPERSEDED_CLAIM" }[kind]);
    assert.deepEqual(report.witness?.claims.map((row) => row.id), ["a", "b"]);
    assert.equal(report.witness?.claims[0]?.citation.field, "/metadata/status");
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(checkContextWitnesses({ claims: [...input.claims].reverse() }), report);
    for (const removed of ["a", "b"]) {
      const reduced = input.claims.filter((row) => row.id !== removed).map(({ supersedes: _supersedes, ...row }) => row);
      assert.equal(checkContextWitnesses({ claims: reduced }).code, "NO_DECLARED_CONFLICT", "each witness assertion is necessary");
    }
  });
}

test("counts all pairs and uses code-unit ID ordering for global ties and supersession precedence", () => {
  const claims = [claim("b", { value: "closed", supersedes: ["a", "A"] }), claim("a"), claim("A")];
  const report = checkContextWitnesses({ claims });
  assert.equal(report.conflicting_pairs, 2);
  assert.deepEqual(report.witness?.claims.map((row) => row.id), ["A", "b"]);
  assert.equal(report.witness?.rule, "SUPERSEDED_CLAIM");
  const reversed = [...claims].reverse().map((row) => ({ ...row, supersedes: row.supersedes?.slice().reverse() }));
  assert.equal(encodeWitnessReport(checkContextWitnesses({ claims: reversed })), encodeWitnessReport(report));
  assert.equal(checkContextWitnesses({ claims: [claim("a", { supersedes: ["b"] }), claim("b")] }).witness?.rule, "SUPERSEDED_CLAIM");
});

test("scopes, subjects, fields and kinds are exact, and identical assertions remain compatible", () => {
  for (const patch of [{ scope: "staging" }, { subject: "other" }, { field: "priority" }, { kind: "policy" as const, value: "required" }]) {
    assert.equal(checkContextWitnesses({ claims: [claim("a"), claim("b", { value: "closed", ...patch })] }).code, "NO_DECLARED_CONFLICT");
  }
  const report = checkContextWitnesses({ claims: [claim("a"), claim("b", { supersedes: [] })] });
  assert.equal(report.code, "NO_DECLARED_CONFLICT");
  assert.equal(report.witness, null);
  assert.equal(checkContextWitnesses({ claims: [] }).checked_claims, 0);
  assert.deepEqual(decodeToon(encodeWitnessReport(report)), report);
  assert.match(report.remedy, /Free text/);
});

test("complete schema validation refuses unknown qualifiers, malformed values and missing citations", () => {
  const invalid: unknown[] = [undefined, null, [], {}, { claims: null }, { claims: [], proposals: [] }, { claims: Array.from({ length: 513 }, (_, index) => claim(`c${index}`)) }];
  for (const bad of [null, [], {}, { ...claim("a"), extra: true }, claim(""), claim("a", { kind: "unknown" as "state" }),
    claim("a", { subject: "" }), claim("a", { field: "" }), claim("a", { scope: "" }),
    claim("a", { value: "" }), claim("a", { value: "x".repeat(257) }), claim("a", { value: "one\ntwo" }),
    claim("a", { value: 1 as unknown as string }), claim("a", { kind: "policy", value: "allowed" }),
    claim("a", { citation: null as unknown as ContextClaim["citation"] }),
    claim("a", { citation: { item: "", field: "/value" } }), claim("a", { citation: { item: "x", field: "relative" } }),
    claim("a", { citation: { item: "x", field: "/bad~escape" } }), claim("a", { citation: { item: "x", field: "/" + "x".repeat(256) } }),
    claim("a", { citation: { item: "x", field: 1 as unknown as string } }),
    { ...claim("a"), citation: { item: "x", field: "/value", extra: true } },
    claim("a", { supersedes: null as unknown as string[] }), claim("a", { supersedes: [""] }), claim("a", { supersedes: ["b", "b"] }),
    claim("a", { supersedes: Array.from({ length: 513 }, (_, index) => `c${index}`) })]) invalid.push({ claims: [bad] });
  invalid.push({ claims: [claim("a"), claim("a")] }, { claims: [claim("a", { supersedes: ["missing"] })] },
    { claims: [claim("a", { supersedes: ["a"] })] }, { claims: [claim("a", { supersedes: ["b"] }), claim("b", { scope: "other" })] });
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  invalid.push(cyclic, 1n, { claims: [], huge: "x".repeat(262145) });
  for (const value of invalid) assert.throws(() => parseWitnessPacket(value), code("INVALID_PACKET"));
  const packet = { claims: [claim("a", { value: "Unicode ✓", citation: { item: "item", field: "/metadata/a~1b~0c" } })] };
  const parsed = parseWitnessPacket(packet);
  assert.deepEqual(parsed, packet);
  parsed.claims[0]!.value = "changed";
  assert.equal(packet.claims[0]!.value, "Unicode ✓");
});

test("JSON and TOON round-trip complete citations and refuse budgets without dropping evidence", () => {
  const report = checkContextWitnesses({ claims: [claim("a"), claim("b", { supersedes: ["a"] })] });
  for (const format of ["json", "toon"] as const) {
    const output = encodeWitnessReport(report, format);
    assert.deepEqual(format === "json" ? JSON.parse(output) : decodeToon(output), report);
    assert.equal(encodeWitnessReport(report, format, Buffer.byteLength(output)), output);
    assert.throws(() => encodeWitnessReport(report, format, Buffer.byteLength(output) - 1), code("BUDGET_TOO_SMALL"));
  }
  for (const budget of [NaN, Infinity, 511, 512.5, 262145]) assert.throws(() => encodeWitnessReport(report, "json", budget), code("INVALID_ARGUMENT"));
  assert.throws(() => encodeWitnessReport(report, "invalid" as "toon"), code("INVALID_ARGUMENT"));
  const empty = checkContextWitnesses({ claims: [] });
  assert.deepEqual(JSON.parse(encodeWitnessReport(empty, "json", 512)), empty);
  assert.deepEqual(decodeToon(encodeWitnessReport(checkContextWitnesses({ claims: [claim("a"), claim("b", { value: "closed", supersedes: [] })] }))), checkContextWitnesses({ claims: [claim("a"), claim("b", { value: "closed", supersedes: [] })] }));
});

test("512 claim boundary is deterministic and does not hide conflicts behind compatible pairs", () => {
  const packet = { claims: Array.from({ length: 512 }, (_, index) => claim(`c${String(index).padStart(3, "0")}`, { value: index === 511 ? "closed" : "open" })) };
  const report = checkContextWitnesses(packet);
  assert.equal(report.checked_claims, 512);
  assert.equal(report.conflicting_pairs, 511);
  assert.deepEqual(report.witness?.claims.map((row) => row.id), ["c000", "c511"]);
});

test("installed CLI and SDK work without Git and leave a real tracker byte-identical", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "witness-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents", "pm");
  await init("witness", { defaults: true, author: "fixture-agent", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const item = (await create({ title: "Recorded state", author: "fixture-agent" }, { cwd: root, pmRoot })).item;
  const packet: WitnessPacket = { claims: [claim("recorded", { value: item.status, citation: { item: item.id, field: "/metadata/status" } }), claim("other", { value: "closed" })] };
  const packetPath = join(root, "packet.json"); writeFileSync(packetPath, JSON.stringify(packet));
  assert.deepEqual(readWitnessPacket(packetPath), packet);
  assert.throws(() => readWitnessPacket(join(root, "absent.json")), code("INPUT_UNAVAILABLE"));
  const invalidPath = join(root, "invalid.json"); writeFileSync(invalidPath, "not JSON");
  assert.throws(() => readWitnessPacket(invalidPath), code("INPUT_UNAVAILABLE"));
  writeFileSync(invalidPath, "{}");
  assert.throws(() => readWitnessPacket(invalidPath), code("INVALID_PACKET"));
  const packageRoot = resolve(import.meta.dirname, "..");
  const installed = join(pmRoot, "extensions", "pm-context"); mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "manifest.json"), join(installed, "manifest.json"));
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const noGit = join(root, "no-git"); mkdirSync(noGit);
  /** Invoke the real installed command through the host parser with Git unavailable. */
  function run(args: string[]) {
    return spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-witnesses", ...args], {
      cwd: root, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM_"))), PM_PATH: pmRoot, PM_AUTHOR: "fixture-agent", PATH: noGit, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
  }
  const before = fingerprint(pmRoot);
  const base = ["--packet", packetPath];
  const json = run([...base, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal((JSON.parse(json.stdout) as { code: string }).code, "CONTRADICTION");
  assert.deepEqual(JSON.parse(json.stdout), checkContextWitnesses(packet));
  const toon = run(base);
  assert.equal(toon.status, 0, toon.stderr);
  assert.deepEqual(decodeToon(toon.stdout), checkContextWitnesses(packet));
  const explicit = run([...base, "--format", "json", "--byte-budget", "4000"]);
  assert.equal(explicit.status, 0, explicit.stderr);
  for (const args of [[], [...base, "--format", "invalid"], [...base, "extra"], [...base, "--byte-budget", "Infinity"], [...base, "--byte-budget", "512"]]) {
    const result = run([...args, "--json"]);
    assert.equal(result.status, 2, result.stderr);
    const error = JSON.parse(result.stderr) as { code: string; detail: string; next_steps: string[] };
    assert.match(error.code, /INVALID_ARGUMENT|BUDGET_TOO_SMALL/);
    assert.ok(error.next_steps.length > 0);
    // The host adds the original invocation to recovery/refusal metadata.
    // Package-owned refusal text and remedies must remain path-free.
    assert.ok(!JSON.stringify({ detail: error.detail, next_steps: error.next_steps }).includes(root));
  }
  assert.equal(fingerprint(pmRoot), before);
  const harness = await createExtensionTestHarness(extension, { name: "pm-context", capabilities: ["commands", "renderers", "schema"] });
  t.after(() => harness.deactivate());
  const result = await harness.runCommand({ command: "context-witnesses", pmRoot, options: { packet: packetPath }, global: {} });
  assert.equal(result.errorMessage, undefined);
  const global = await harness.runCommand({ command: "context-witnesses", pmRoot, options: { packet: packetPath, byteBudget: "4000" }, global: { json: true } });
  assert.equal(global.errorMessage, undefined);
});
