import { removeBunFixture } from "./bun-fixture.ts";
/** Install one captured artifact through real isolated npm/Bun global and local hosts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { create, init } from "@unbrained/pm-cli/sdk";
import { packSharedEvidence, encodeSharedEvidence } from "../index.ts";

const artifact = resolve(process.argv[2]!); const version = process.argv[3] ?? "2026.10.28";
assert.match(version, /^\d{4}\.\d{1,2}\.\d{1,2}$/);
const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
const root = mkdtempSync(join(tmpdir(), "shared-packed-"));
const home = join(root, "home"); mkdirSync(home);
// A narrow allowlist prevents inherited credentials from reaching install/lifecycle tools.
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "SYSTEMROOT"].includes(key))), HOME: home, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull, CI: "1", GIT_CEILING_DIRECTORIES: tmpdir(), BUN_INSTALL_GLOBAL_DIR: join(root, "bun-global"), BUN_INSTALL_BIN: join(root, "bun-bin") };
/** Keep potentially verbose install diagnostics local; only fail with the command's result. */
function run(command: string, args: string[], cwd = root, extra: Record<string, string> = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180000, env: { ...environment, ...extra } });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`); return result.stdout;
}
try {
  const project = join(root, "local"); mkdirSync(project);
  process.stderr.write("Installing project-local host\n");
  run("npm", ["install", "--prefix", project, "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", `@unbrained/pm-cli@${version}`, artifact]);
  const npmGlobal = join(root, "npm-global");
  process.stderr.write("Installing npm-global host\n");
  run("npm", ["install", "--global", "--prefix", npmGlobal, "--ignore-scripts", "--no-audit", "--no-fund", `@unbrained/pm-cli@${version}`, artifact]);
  process.stderr.write("Installing bun-global host\n");
  run("bun", ["add", "--global", "--ignore-scripts", `@unbrained/pm-cli@${version}`, artifact]);
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("packed", { defaults: true, agentGuidance: "skip", author: "fixture" }, client);
  const { item } = await create({ title: "Packed shared evidence", description: "Recorded fragment ".repeat(100), author: "fixture", parent: "none", goal: "none", objective: "none", assignee: "none", clearDeps: true }, client);
  const input = { criteria: Array.from({ length: 20 }, (_, i) => ({ id: `AC${i}`, text: `Criterion ${i}`, evidence: [{ item: item.id, field: "description" }] })), byte_budget: 20000, format: "json" };
  const packet = join(root, "packet.json"); writeFileSync(packet, JSON.stringify(input));
  const extensionParent = join(client.pmRoot, "extensions"); mkdirSync(extensionParent, { recursive: true });
  const extensionPath = join(extensionParent, "pm-context");
  const results: string[] = [];
  const modes = [
    { name: "project-local", directory: join(project, "node_modules", "pm-context"), command: join(project, "node_modules", ".bin", "pm"), args: [], cwd: project },
    { name: "npm-global", directory: join(npmGlobal, "lib", "node_modules", "pm-context"), command: join(npmGlobal, "bin", "pm"), args: [], cwd: root },
    { name: "bun-global", directory: join(environment.BUN_INSTALL_GLOBAL_DIR, "node_modules", "pm-context"), command: join(environment.BUN_INSTALL_BIN, "pm"), args: [], cwd: root },
    { name: "npx", directory: join(project, "node_modules", "pm-context"), command: "npx", args: ["--no-install", "pm"], cwd: project },
    { name: "bunx", directory: join(project, "node_modules", "pm-context"), command: "bunx", args: ["--no-install", "pm"], cwd: project },
  ];
  for (const mode of modes) {
    process.stderr.write(`Checking ${mode.name}\n`);
    // The host deliberately ignores symlinked extension directories. Copy the
    // captured installed files and bind dependencies through normal package
    // resolution in that installation, as a package installer does.
    rmSync(extensionPath, { recursive: true, force: true }); mkdirSync(extensionPath);
    for (const path of ["dist", "manifest.json", "package.json"]) cpSync(join(mode.directory, path), join(extensionPath, path), { recursive: true });
    const require = createRequire(join(mode.directory, "package.json"));
    for (const [name, target] of [["@unbrained/pm-cli", dirname(require.resolve("@unbrained/pm-cli/package.json"))], ["@toon-format/toon", dirname(dirname(require.resolve("@toon-format/toon")))]] as const) {
      mkdirSync(dirname(join(extensionPath, "node_modules", name)), { recursive: true }); symlinkSync(target, join(extensionPath, "node_modules", name), "dir");
    }
    const output = run(mode.command, [...mode.args, "context-evidence-shared", "--packet", packet, "--json"], mode.cwd, { PM_PATH: client.pmRoot, PM_AUTHOR: "fixture" });
    const result = JSON.parse(output); assert.equal(result.bindings.length, 20); assert.equal(result.fragments.length, 1);
    assert.equal(JSON.parse(result.fragments[0].value_json), item.description); results.push(mode.name);
    if (!["npx", "bunx"].includes(mode.name)) {
      const consume = join(mode.directory, "consume.mjs");
      writeFileSync(consume, `import {readFileSync} from 'node:fs'; import {packSharedEvidence,createSharedEvidenceReader,encodeSharedEvidence} from './dist/index.js'; const input=JSON.parse(readFileSync(process.argv[2],'utf8')); process.stdout.write(encodeSharedEvidence(await packSharedEvidence(input,createSharedEvidenceReader(process.argv[3])),'json'));`);
      const sdk = JSON.parse(run(process.execPath, [consume, packet, client.pmRoot])); assert.deepEqual(sdk, result); results.push(`${mode.name}-sdk`);
    }
    for (const format of ["json", "toon"] as const) {
      const criteria = [{ id: "A", text: "x", evidence: [] }];
      const base = await packSharedEvidence({ criteria, format, byte_budget: 512 }, async () => { assert.fail("empty packet read a field"); });
      criteria[0]!.text = "x".repeat(1 + 512 - Buffer.byteLength(encodeSharedEvidence(base, format)));
      writeFileSync(packet, JSON.stringify({ criteria, format, byte_budget: 512 }));
      const exact = run(mode.command, [...mode.args, "context-evidence-shared", "--packet", packet, "--format", format], mode.cwd, { PM_PATH: client.pmRoot, PM_AUTHOR: "fixture" });
      assert.equal(Buffer.byteLength(exact), 512); results.push(`${mode.name}-exact-${format}`);
      if (!["npx", "bunx"].includes(mode.name)) {
        const consume = join(mode.directory, "consume.mjs");
        writeFileSync(consume, `import {readFileSync} from 'node:fs'; import {packSharedEvidence,createSharedEvidenceReader,encodeSharedEvidence} from './dist/index.js'; const input=JSON.parse(readFileSync(process.argv[2],'utf8')); process.stdout.write(encodeSharedEvidence(await packSharedEvidence(input,createSharedEvidenceReader(process.argv[3])),input.format));`);
        for (const runtime of [process.execPath, "bun"]) assert.equal(run(runtime, [consume, packet, client.pmRoot]), exact);
        results.push(`${mode.name}-sdk-node-${format}`, `${mode.name}-sdk-bun-${format}`);
      }
    }
    writeFileSync(packet, JSON.stringify(input));
  }
  assert.equal(createHash("sha256").update(readFileSync(artifact)).digest("hex"), digest);
  process.stdout.write(`${JSON.stringify({ artifact_sha256: digest, host_version: version, passed: results.length, modes: results })}\n`);
} finally { await removeBunFixture(root); }
