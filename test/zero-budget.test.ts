import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { packSharedEvidence, encodeSharedEvidence, packCriterionEvidence, encodeEvidencePack, createSdkPacker } from "../index.ts";
import * as built from "../dist/index.js";

/** No field read is necessary for receipt-only boundary packets. */
async function unread(): Promise<never> { assert.fail("receipt-only packet read a source"); }

test("zero remaining capacity is successful for every evidence producer and transport at exact receipt boundaries", async () => {
  let seed = 196;
  for (let i = 0; i < 500; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const format = i % 2 ? "toon" : "json";
    const representation = i % 4 < 2 ? "factored" : "expanded";
    const criteria = [{ id: "A", text: "x".repeat(200 + seed % 200), evidence: [] }];
    for (const api of [{ packSharedEvidence, encodeSharedEvidence, packCriterionEvidence, encodeEvidencePack }, built]) {
      // Iterate the public producer's own measurement until budget digits settle.
      let budget = 4000;
      for (let settle = 0; settle < 3; settle++) budget = (await api.packSharedEvidence({ criteria, format, representation, byte_budget: budget }, unread)).byte_upper_bound;
      for (const delta of [-1, 0, 1]) {
        try {
          const pack = await api.packSharedEvidence({ criteria, format, representation, byte_budget: budget + delta }, unread);
          assert.ok(delta >= 0); const encoded = api.encodeSharedEvidence(pack, format);
          assert.ok(Buffer.byteLength(encoded) <= budget + delta);
          assert.deepEqual(format === "json" ? JSON.parse(encoded) : decodeToon(encoded), pack);
        } catch (error) { assert.ok(delta === -1 && isPmCliExpectedError(error) && error.code === "BUDGET_TOO_SMALL"); }
      }
      let legacyBudget = 4000;
      for (let settle = 0; settle < 3; settle++) legacyBudget = (await api.packCriterionEvidence({ criteria }, unread, { format, byteBudget: legacyBudget })).byte_upper_bound;
      const legacy = await api.packCriterionEvidence({ criteria }, unread, { format, byteBudget: legacyBudget });
      assert.ok(Buffer.byteLength(api.encodeEvidencePack(legacy, format)) <= legacyBudget);
    }
  }
  assert.deepEqual(createSdkPacker([], [])([], [], 0), { focus: [], neighbors: [] });
  // Exhaustion after admitting evidence must terminate just like a receipt
  // that consumes the entire ceiling before selection starts.
  for (const api of [{ packSharedEvidence, encodeSharedEvidence }, built]) for (const format of ["json", "toon"] as const) for (const representation of ["factored", "expanded"] as const) {
    const criteria = [{ id: "bound", text: "Recorded evidence", evidence: [{ item: "source", field: "body" }] }];
    const read = async () => ({ revision: "revision-1", value: "recorded fragment".repeat(30) });
    let budget = 4000;
    for (let settle = 0; settle < 3; settle++) {
      const pack = await api.packSharedEvidence({ criteria, format, representation, byte_budget: budget }, read);
      assert.equal(pack.criteria[0]!.state, "linked"); budget = pack.byte_upper_bound;
    }
    const exact = await api.packSharedEvidence({ criteria, format, representation, byte_budget: budget }, read);
    assert.equal(Buffer.byteLength(api.encodeSharedEvidence(exact, format)), budget);
  }
  console.log("Bound-evidence equality checks passed");
});

test("exact 512-byte receipt succeeds through installed Node and Bun CLI without Git", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "zero-budget-")); t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pmRoot = join(root, "tracker"); await init("zero", { defaults: true, agentGuidance: "skip", author: "fixture" }, { cwd: root, pmRoot });
  const packageRoot = resolve(import.meta.dirname, ".."); const extension = join(pmRoot, "extensions", "pm-context"); mkdirSync(extension, { recursive: true });
  cpSync(join(packageRoot, "dist"), join(extension, "dist"), { recursive: true }); cpSync(join(packageRoot, "manifest.json"), join(extension, "manifest.json"));
  symlinkSync(join(packageRoot, "node_modules"), join(extension, "node_modules"), "dir");
  const packet = join(root, "packet.json"); writeFileSync(packet, JSON.stringify({ criteria: [{ id: "A", text: "x".repeat(79), evidence: [] }], byte_budget: 512, format: "json" }));
  const noGit = join(root, "no-git"); mkdirSync(noGit);
  const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }); assert.equal(bun.status, 0);
  for (const runtime of [process.execPath, bun.stdout]) {
    const result = spawnSync(runtime, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "context-evidence-shared", "--packet", packet], { cwd: root, encoding: "utf8", env: { PATH: noGit, HOME: root, PM_PATH: pmRoot, GIT_CEILING_DIRECTORIES: tmpdir() } });
    assert.equal(result.status, 0, result.stderr); assert.equal(Buffer.byteLength(result.stdout), 512); assert.equal(JSON.parse(result.stdout).criteria[0].state, "unlinked");
  }
});
