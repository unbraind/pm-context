import { removeBunFixture } from "./bun-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, init, readLocatedItem, readSettings, schemaAddField, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import { listGetProjectionFields, listListProjectionFields } from "@unbrained/pm-cli/sdk/query";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { buildPhaseContext, encodePhaseContext, TASK_PHASES } from "../index.ts";
import type { PhaseContextPacket, PhaseContextRequest } from "../index.ts";

/** Enforce the semantic restoration contract independently of selector acceptance. */
function inspect(packet: PhaseContextPacket, state: Record<string, unknown>, collisions: readonly string[]) {
  for (const binding of packet.bindings) {
    const fact = packet.facts.find((row) => row.id === binding.fact)!;
    assert.ok("value_json" in fact);
    assert.deepEqual(JSON.parse(fact.value_json), state[binding.field]);
  }
  for (const field of collisions) {
    const row = packet.bindings.find((binding) => binding.field === field)
      ?? packet.omission_receipt.omitted_field_groups.find((group) => group.name.endsWith(`.${field}`));
    assert.ok(row, `missing collision receipt: ${field}`);
    assert.equal(Object.hasOwn(row, "restore_argv"), false, `derived selector must not restore raw ${field}`);
    assert.equal(Object.hasOwn(row, "restore_with"), false);
    assert.equal(row.restore_unavailable?.code, "UNSUPPORTED_FIELD_PROJECTION");
    assert.match(row.restore_unavailable!.reason, /derived output/);
  }
  assert.ok(packet.bindings.find((row) => row.field === "custom_signal")!.restore_argv);
  assert.deepEqual(packet.session_restore!.argv.slice(3), ["--fields", "id", "--output-budget", "unbounded", "--json"], "session recovery must not suggest a broad projection that overwrites raw metadata");
}

test("500 replayed runtime-field models exclude every SDK-derived collision in SDK, CLI and packed Node/Bun packets", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "phase-meaning-"));
  t.after(() => removeBunFixture(root));
  const client = { cwd: root, pmRoot: join(root, "tracker"), noExtensions: true };
  await init("meaning", { defaults: true, agentGuidance: "skip", author: "fixture" }, client);
  const metadata = new Set(listListProjectionFields());
  const collisions = listGetProjectionFields().filter((name) => !metadata.has(name) && !name.includes("."));
  assert.ok(collisions.includes("notes_count") && collisions.includes("linked"));
  for (const [i, key] of [...collisions, "custom_signal"].entries()) {
    await schemaAddField(key, { type: "string", cliFlag: `restoration-${i}`, commands: ["create", "update"], author: "fixture" }, client);
  }
  const { item } = await create({ title: "Stored metadata, not derived facets", author: "fixture" }, client);
  const itemPath = join(client.pmRoot, "tasks", `${item.id}.toon`);
  const located = { id: item.id, type: "Task", itemPath, item_format: "toon" as const };
  const schema = (await readSettings(client.pmRoot)).schema;
  const { document } = await readLocatedItem(located, { schema });
  const all = ["title", ...collisions];
  const request: PhaseContextRequest = {
    items: [item.id], phase: "investigation", include_fields: ["custom_signal"], byte_budget: 60000,
    contracts: { investigation: all, implementation: ["title", ...collisions.slice(0, 3)], review: ["title", ...collisions.slice(3, 6)], handoff: ["title", "custom_signal"] },
    session: { version: 1, id: "meaning", token_budget: 50000, spent_tokens: 0, seen_item_ids: [] },
  };
  let seed = 0x181da7a;
  /** Generate deterministic state transitions, including replays and hostile strings. */
  function random(max: number) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
  const atoms = ["", " ", "\r\n", "\n", "\t", "'\"", ";|&$()<>`", "-leading", "é📚"];
  let model: Record<string, string> = Object.fromEntries([...collisions, "custom_signal"].map((field) => [field, `stored:${field}:initial`]));
  const old: Record<string, string>[] = [];
  let state: Record<string, unknown> = {};
  for (let sequence = 0; sequence < 500; sequence++) {
    old.push({ ...model });
    if (sequence > 0 && random(3) === 0) model = { ...old[random(old.length)]! };
    else for (const field of [...collisions, "custom_signal"]) model[field] = `stored:${field}:${sequence}:${atoms[random(atoms.length)]}${atoms[random(atoms.length)]}:end`;
    Object.assign(document.metadata, model);
    writeFileSync(itemPath, serializeItemDocument(document, { format: "toon" }));
    const current = (await readLocatedItem(located, { schema })).document;
    state = { ...current.metadata, body: current.body };
    assert.deepEqual(Object.fromEntries(Object.keys(model).map((field) => [field, state[field]])), model, "SDK read-back must match the literal reference model without normalization");
    const format = Math.floor(sequence / 4) % 2 ? "json" : "toon";
    const packet = await buildPhaseContext({ ...request, phase: TASK_PHASES[sequence % 4]!, format }, client.pmRoot);
    const encoded = encodePhaseContext(packet);
    const decoded = format === "json" ? JSON.parse(encoded) : decodeToon(encoded);
    assert.deepEqual(decoded, packet);
    inspect(packet, state, collisions);
  }
  const before = readFileSync(itemPath);
  const packageRoot = resolve(import.meta.dirname, "..");
  // Consume the actual npm artifact. Supply the already-pinned dependencies to
  // keep the test offline; CI separately proves npm and Bun dependency installs.
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: packageRoot, encoding: "utf8", timeout: 30000 });
  assert.equal(packed.status, 0, packed.stderr);
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename;
  const consumer = join(root, "consumer");
  const modules = join(consumer, "node_modules");
  const installed = join(modules, "pm-context"); mkdirSync(installed, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", join(root, filename), "--strip-components=1", "-C", installed], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  for (const scope of ["@unbrained", "@toon-format"]) symlinkSync(join(packageRoot, "node_modules", scope), join(modules, scope), "dir");
  const extensionParent = join(client.pmRoot, "extensions"); mkdirSync(extensionParent, { recursive: true });
  const cliExtension = join(extensionParent, "pm-context");
  cpSync(installed, cliExtension, { recursive: true });
  symlinkSync(modules, join(cliExtension, "node_modules"), "dir");
  const script = join(consumer, "consume.mjs");
  writeFileSync(script, 'import {readFileSync} from "node:fs"; import {buildPhaseContext,encodePhaseContext} from "pm-context"; const request=JSON.parse(readFileSync(process.argv[2],"utf8")); process.stdout.write(encodePhaseContext(await buildPhaseContext(request,process.argv[3])));\n');
  const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" });
  assert.equal(bun.status, 0, bun.stderr);
  const noGit = join(root, "no-executables"); mkdirSync(noGit);
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM_"))), HOME: root, PM_PATH: client.pmRoot, PM_AUTHOR: "fixture", PATH: noGit, GIT_CEILING_DIRECTORIES: tmpdir() };
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  let executions = 0;
  for (const format of ["json", "toon"] as const) {
    const input = { ...request, format };
    const path = join(root, "request.json"); writeFileSync(path, JSON.stringify(input));
    const expected = await buildPhaseContext(input, client.pmRoot);
    for (const [runtime, args] of [[process.execPath, [script, path, client.pmRoot]], [bun.stdout, [script, path, client.pmRoot]], [process.execPath, [cli, "context-phase", "--packet", path]]] as const) {
      const result = spawnSync(runtime, [...args], { cwd: consumer, env: environment, encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
      const packet = (format === "json" ? JSON.parse(result.stdout) : decodeToon(result.stdout)) as PhaseContextPacket;
      assert.deepEqual(packet, expected);
      inspect(packet, state, collisions);
      // Exit zero is insufficient: every concrete restoration must return the
      // stored SDK field value, including the generic session identity probe.
      const commands = [...packet.bindings, ...packet.omission_receipt.omitted_field_groups].flatMap((row) => row.restore_argv ? [row.restore_argv] : []);
      commands.push(packet.session_restore!.argv);
      for (const argv of commands) {
        const restored = spawnSync(process.execPath, [cli, ...argv.slice(1)], { cwd: consumer, env: environment, encoding: "utf8", timeout: 15000 });
        assert.equal(restored.status, 0, restored.stderr);
        const output = JSON.parse(restored.stdout) as { item: Record<string, unknown> };
        const field = argv[argv.indexOf("--fields") + 1]!;
        assert.ok(Object.hasOwn(output.item, field), `missing restored ${field}`);
        assert.deepEqual(Object.keys(output.item).sort(), [...new Set(["id", field])].sort(), "single-field recovery must not smuggle derived metadata into the item");
        assert.deepEqual(output.item[field], state[field], `restoration changed stored ${field}`);
        executions++;
      }
    }
  }
  assert.deepEqual(readFileSync(itemPath), before);
  t.diagnostic(`500 models; ${collisions.length} registered derived-name collisions; 6 packed Node/Bun/CLI packets; ${executions} exact value restorations outside Git`);
});
