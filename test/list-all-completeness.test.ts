/** Real non-git corpus certification and certificate tampering regressions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { checkExtensionManifestCompatibility, init, schemaAddType, listAllComplete } from "@unbrained/pm-cli/sdk";
import { create, close } from "@unbrained/pm-cli/sdk/core";
import { certifyCompleteListResult, PmCompleteListValidationError } from "@unbrained/pm-cli/sdk/query";
import { assertListResultComplete, readPmItems, buildContextPack } from "../index.ts";

/** Initialize a real tracker outside Git with custom, terminal and body evidence. */
async function realCorpus(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "context-corpus-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = { cwd: root, pmRoot: join(root, ".agents", "pm"), noExtensions: true };
  await init("corpus", { defaults: true, author: "test", agentGuidance: "skip" }, client);
  await schemaAddType("Evidence", { folder: "evidence", author: "test" }, client);
  const custom = await create({ title: "Custom corpus item", type: "Evidence", body: "Custom body evidence", author: "test" }, client);
  const terminal = await create({ title: "Terminal corpus item", author: "test" }, client);
  await close(terminal.item.id, "Completed corpus fixture", { author: "test" }, client);
  const result = await listAllComplete({ includeBody: true }, client);
  return { root, client, result, ids: [custom.item.id, terminal.item.id].sort() };
}

test("F01: non-git complete context input includes custom and terminal items and refuses missing certificates", async (t) => {
  const f = await realCorpus(t);
  const items = await readPmItems(f.client.pmRoot);
  assert.deepEqual(items.map(item => item.id).sort(), f.ids);
  assert.equal(items.find(item => item.type === "Evidence")?.body, "Custom body evidence");
  assert.ok(items.some(item => item.status === "closed"));
  assertListResultComplete(f.result);
  const stripped = structuredClone(f.result) as Partial<typeof f.result>;
  delete stripped.complete_list;
  // The SDK certifier constructs a certificate. The consumer requires the
  // producer's proof too, then re-certifies its evidence rather than trusting it.
  assert.doesNotThrow(() => certifyCompleteListResult(stripped));
  assert.throws(() => {
    assertListResultComplete(stripped);
    buildContextPack(stripped.items, { ids: f.ids });
  }, (error: unknown) => {
    assert.ok(error instanceof PmCompleteListValidationError);
    assert.match(error.receipt.findings[0].message, /complete_list/);
    return true;
  });
  const mismatched = structuredClone(f.result);
  mismatched.complete_list.item_count++;
  assert.throws(() => assertListResultComplete(mismatched), PmCompleteListValidationError);

  const noGitPath = join(f.root, "no-git-bin");
  mkdirSync(noGitPath);
  const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { readPmItems } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    process.stdout.write(JSON.stringify(await readPmItems(process.env.CORPUS_PM_ROOT)));
  `], { cwd: f.root, encoding: "utf8", env: { ...process.env, PATH: noGitPath,
    GIT_CEILING_DIRECTORIES: dirname(f.root), CORPUS_PM_ROOT: f.client.pmRoot } });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual((JSON.parse(probe.stdout) as { id: string }[]).map(item => item.id).sort(), f.ids);
});

test("canonical consumer rejects damaged receipts, filters, duplicates and missing projection evidence", async (t) => {
  const f = await realCorpus(t);
  const mutations: Array<[string, (result: Record<string, unknown>) => void]> = [
    ["page_incomplete", result => { result.truncated = true; }],
    ["page_incomplete", result => { result.has_more = true; }],
    ["source_unchecked", result => { delete result.completeness; }],
    ["source_incomplete", result => { (result.completeness as { status: string }).status = "partial"; }],
    ["field_omission", result => { (result.omission_receipt as { has_omissions: boolean }).has_omissions = true; }],
    ["filtered_corpus", result => { (result.filters as { status: string }).status = "open"; }],
    ["projection_incomplete", result => { delete result.projection; }],
    ["read_output_missing", result => { delete result.read_output; }],
    ["count_mismatch", result => { result.count = 0; }],
    ["duplicate_item_id", result => { const rows = result.items as { id: string }[]; rows[1].id = rows[0].id; }],
  ];
  for (const [code, mutate] of mutations) {
    const candidate = structuredClone(f.result) as unknown as Record<string, unknown>;
    mutate(candidate);
    assert.throws(() => assertListResultComplete(candidate), (error: unknown) => {
      assert.ok(error instanceof PmCompleteListValidationError);
      assert.ok(error.receipt.findings.some(finding => finding.code === code), code);
      assert.match(error.receipt.recovery.sdk, /listAllComplete/);
      return true;
    });
  }
});

test("complete read preserves the SDK typed refusal for a malformed real tracker", async (t) => {
  const f = await realCorpus(t);
  rmSync(join(f.client.pmRoot, "settings.json"));
  await assert.rejects(() => readPmItems(f.client.pmRoot), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.notEqual(error.name, "CommandError");
    return true;
  });
});

/**
 * `package.json` and `manifest.json` state the same host-compatibility fact to
 * two different installers: npm reads the `peerDependencies` floor, the pm host
 * reads `manifest.json`'s `pm_min_version` when it loads the extension. Nothing
 * bound them, and this package had drifted furthest of all: its manifest carried
 * a `compatibility: { pm: "..." }` block the host's version gate never reads, so
 * `checkExtensionManifestCompatibility` returned `compatible: true` for every
 * host back to 2026.7.1 — including the 2026.8.14 release whose truncated
 * `list-all` is the exact defect this file's refusals exist to catch. The floor
 * is now declared in the field the gate actually reads, and bound here.
 */
test("the manifest host floor matches the package peer floor", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  ) as { pm_min_version?: string };
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { peerDependencies?: Record<string, string> };
  const peer = pkg.peerDependencies?.["@unbrained/pm-cli"] ?? "";
  assert.match(peer, /^>=\d+\.\d+\.\d+$/, "the peer declaration must be a concrete >= floor");
  assert.equal(
    manifest.pm_min_version,
    peer.replace(/^>=/, ""),
    `manifest.json pm_min_version "${manifest.pm_min_version}" must equal the @unbrained/pm-cli peer floor "${peer}": they are the same claim to two different installers`,
  );
});

/**
 * The floor above is only worth stating if the host actually enforces it. This
 * runs the SDK's own gate — the author-time inverse of the loader's runtime
 * check — against the manifest bytes on disk, so a floor moved back into a field
 * the gate ignores fails here instead of shipping as an unenforced claim.
 */
test("the pm host gate refuses every version below the declared floor", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const below = checkExtensionManifestCompatibility(manifest, { pmVersion: "2026.8.14" });
  assert.equal(below.compatible, false, "the known-bad 2026.8.14 host must be refused");
  assert.deepStrictEqual(below.findings.map((f) => f.code), ["pm_min_version_unmet"]);
  assert.equal(
    checkExtensionManifestCompatibility(manifest, { pmVersion: "2026.10.23" }).compatible,
    true,
    "the declared floor itself must load",
  );
  assert.equal(
    checkExtensionManifestCompatibility(manifest, { pmVersion: "2027.1.1" }).compatible,
    true,
    "a floor must not reject later hosts: that is what an exact pin would do",
  );
});
