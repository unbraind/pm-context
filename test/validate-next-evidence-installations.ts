/** Exercise one captured package artifact through isolated npm/Bun host installations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { init } from "@unbrained/pm-cli/sdk";
import { decodePmTableRows } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import type { NextEvidencePacket, NextEvidencePlan } from "../index.ts";

const artifact = resolve(process.argv[2]);
const digest = () => createHash("sha256").update(readFileSync(artifact)).digest("hex");
const artifactSha256 = digest();
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { devDependencies: Record<string, string> };
const host = `@unbrained/pm-cli@${manifest.devDependencies["@unbrained/pm-cli"]}`;
const fixture = JSON.parse(readFileSync(new URL("fixtures/next-evidence-v1.json", import.meta.url), "utf8")) as { packet: NextEvidencePacket; plan: NextEvidencePlan };
const root = mkdtempSync(join(tmpdir(), "acquisition-installations-"));
const globalConfig = join(root, "empty-global-config"); writeFileSync(globalConfig, "");
// Only environment names are inspected. Never read credential configuration.
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PM_|TOKEN|SECRET|PASSWORD|CREDENTIAL|API.?KEY|NPM_MEDIA_SERVER/i.test(key)));
const childEnv = { ...clean, NPM_CONFIG_USERCONFIG: devNull, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_IGNORE_SCRIPTS: "true", GIT_CEILING_DIRECTORIES: tmpdir(), BUN_INSTALL_GLOBAL_DIR: join(root, "bun-global"), BUN_INSTALL_BIN: join(root, "bun-bin") };

/** Run sequentially with bounded output and no inherited registry credentials. */
function run(executable: string, args: string[], cwd: string, pmRoot?: string, expectedStatus = 0): string {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 240000, env: { ...childEnv, ...(pmRoot ? { PM_PATH: pmRoot, PM_AUTHOR: "fixture-agent" } : {}) } });
  assert.equal(result.status, expectedStatus, `${executable.split(/[\\/]/).at(-1)} failed: ${(result.stderr + result.stdout).replaceAll(root, "<scratch>")}`);
  return expectedStatus === 0 ? result.stdout : result.stderr;
}

try {
  const local = join(root, "npm-local"); mkdirSync(local);
  console.log("Installing captured artifact and pinned host locally with npm");
  run("npm", ["install", "--prefix", local, "--ignore-scripts", "--no-audit", "--no-fund", artifact, host], root);
  const npmGlobal = join(root, "npm-global");
  console.log("Installing pinned host through npm global in an isolated prefix");
  run("npm", ["install", "--global", "--prefix", npmGlobal, "--ignore-scripts", "--no-audit", "--no-fund", host], root);
  const bunLocal = join(root, "bun-local"); mkdirSync(bunLocal);
  console.log("Installing captured artifact and pinned host locally with Bun");
  run("bun", ["add", "--cwd", bunLocal, "--ignore-scripts", artifact, host], root);
  console.log("Installing pinned host through Bun global in isolated directories");
  run("bun", ["add", "--global", "--ignore-scripts", host], root);
  const launchers = [
    { mode: "npm-project-local", executable: join(local, "node_modules/.bin/pm"), args: [] },
    { mode: "bun-project-local", executable: join(bunLocal, "node_modules/.bin/pm"), args: [] },
    { mode: "npm-global", executable: join(npmGlobal, "bin/pm"), args: [] },
    { mode: "bun-global", executable: join(root, "bun-bin/pm"), args: [] },
    { mode: "npx", executable: "npx", args: ["--yes", `--package=${host}`, "pm"] },
    { mode: "bunx", executable: "bunx", args: [`--package=${host}`, "pm"] },
  ];
  const results: { mode: string; assertions: number }[] = [];
  for (const launcher of launchers) {
    console.log(`Checking ${launcher.mode}`);
    const workspace = join(root, launcher.mode); mkdirSync(workspace, { recursive: true });
    const pmRoot = join(workspace, ".agents/pm");
    await init("acquisition", { defaults: true, author: "fixture-agent", agentGuidance: "skip" }, { cwd: workspace, pmRoot });
    const invoke = (args: string[], expectedStatus = 0) => run(launcher.executable, [...launcher.args, ...args], workspace, pmRoot, expectedStatus);
    assert.equal(invoke(["--version"]).trim(), manifest.devDependencies["@unbrained/pm-cli"]);
    invoke(["package", "install", artifact, "--project"]);
    const packet = join(workspace, "packet.json"); writeFileSync(packet, JSON.stringify(fixture.packet));
    const saved = join(workspace, "plan.json");
    const output = invoke(["context-next-evidence", "--packet", packet, "--format", "json"]);
    assert.deepEqual(JSON.parse(output), fixture.plan); writeFileSync(saved, output);
    assert.deepEqual(JSON.parse(invoke(["context-next-evidence", "--packet", packet, "--check", saved, "--json"])), fixture.plan);
    const { steps, steps_encoding, ...summary } = decodeToon(invoke(["context-next-evidence", "--packet", packet, "--format", "toon"])) as Record<string, unknown>;
    assert.deepEqual({ ...summary, steps: decodePmTableRows({ rows: steps, encoding: steps_encoding } as Parameters<typeof decodePmTableRows>[0]) }, fixture.plan);
    assert.equal(JSON.parse(invoke(["context-next-evidence", "--packet", packet, "--check", " \r\n ", "--json"], 2)).code, "INVALID_ARGUMENT");
    assert.equal(digest(), artifactSha256);
    results.push({ mode: launcher.mode, assertions: 6 });
  }
  console.log(JSON.stringify({ artifact_sha256: artifactSha256, host, launchers: results, assertions: 36, artifact_unchanged: true }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
