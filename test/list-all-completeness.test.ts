/**
 * Regression tests for the list-all completeness refusal.
 *
 * The 2026.8.14 failure mode this file pins: pm's list engine defaulted the
 * list to a truncated answer (10 of 682 items on this host's fixture
 * workspace) and `readPmItems` consumed `.items` without consulting the
 * result's completeness receipt — a context pack built from ten items that
 * reported success. The read must REFUSE any result whose receipt says the
 * answer was not the whole workspace, naming the tripped signal and the
 * count/total figures.
 *
 * Every refusal below is driven from a REAL envelope (captured from the real
 * pm CLI's `list-all --json` output against a real workspace) with exactly one
 * field mutated, injected through the readPmItems list-action seam — not a
 * hand-written mock of the envelope shape.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  CommandError,
  assertListResultComplete,
  readPmItems,
  type PmListAction,
} from "../index.ts";

/** True when a `pm` CLI is on PATH for envelope capture. */
function hasPmCli(): boolean {
  try {
    return spawnSync("pm", ["--version"], { encoding: "utf-8" }).status === 0;
  } catch {
    return false;
  }
}

/** Captured real `pm list-all --json` envelope plus the root it came from. */
interface EnvelopeFixture {
  pmRoot: string;
  envelope: Record<string, unknown>;
}

let cached: EnvelopeFixture | undefined;

/** Build a real 3-item workspace once and capture the CLI's actual envelope. */
function realEnvelope(): EnvelopeFixture {
  if (cached) return cached;
  const root = mkdtempSync(join(tmpdir(), "ctx-envelope-"));
  const pmRoot = join(root, ".agents", "pm");
  mkdirSync(pmRoot, { recursive: true });
  const init = spawnSync("pm", ["--path", pmRoot, "init"], { encoding: "utf-8" });
  assert.strictEqual(init.status, 0, `pm init failed: ${init.stderr}`);
  for (const title of ["Envelope Alpha", "Envelope Beta", "Envelope Gamma"]) {
    const created = spawnSync(
      "pm",
      ["--path", pmRoot, "--json", "create", "--title", title, "--type", "Task", "--status", "open"],
      { encoding: "utf-8" },
    );
    assert.strictEqual(created.status, 0, `pm create failed: ${created.stderr}`);
  }
  const read = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "list-all", "--full", "--include-body"],
    { encoding: "utf-8" },
  );
  assert.strictEqual(read.status, 0, `pm list-all failed: ${read.stderr}`);
  cached = { pmRoot, envelope: JSON.parse(read.stdout) as Record<string, unknown> };
  // One captured fixture serves every test; tear the workspace down once the
  // whole file has run so nothing leaks into /tmp across local runs.
  after(() => rmSync(root, { recursive: true, force: true }));
  return cached;
}

/** Deep-copy the real envelope, apply one mutation, and return it. */
function mutatedEnvelope(mutate: (env: Record<string, unknown>) => void): Record<string, unknown> {
  const env = JSON.parse(JSON.stringify(realEnvelope().envelope)) as Record<string, unknown>;
  mutate(env);
  return env;
}

/** Seam resolving a canned envelope as the SDK list result. */
function seamFor(envelope: Record<string, unknown>): PmListAction {
  return (async () => envelope) as unknown as PmListAction;
}

test("real list-all envelope baseline is complete with all items", { skip: !hasPmCli() }, async () => {
  const fx = realEnvelope();
  assert.strictEqual(fx.envelope.truncated, false);
  assert.strictEqual(fx.envelope.has_more, false);
  assert.strictEqual(
    (fx.envelope.completeness as Record<string, unknown>).status,
    "complete",
  );
  const omission = fx.envelope.omission_receipt as Record<string, unknown> | undefined;
  assert.ok(omission === undefined || omission.has_omissions === false);
  assert.strictEqual(Array.isArray(fx.envelope.items) && fx.envelope.items.length, 3);
  assert.strictEqual(fx.envelope.count, 3);
  assert.strictEqual(fx.envelope.total, 3);

  // The real (unmutated) read path returns every item.
  const items = await readPmItems(fx.pmRoot);
  assert.deepStrictEqual(
    items.map((it) => it.title).sort(),
    ["Envelope Alpha", "Envelope Beta", "Envelope Gamma"],
  );
});

test("readPmItems refuses a result with truncated=true", { skip: !hasPmCli() }, async () => {
  const env = mutatedEnvelope((e) => { e.truncated = true; });
  await assert.rejects(
    () => readPmItems(realEnvelope().pmRoot, seamFor(env)),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /truncated=true/, "message must name the tripped signal");
      assert.match(err.message, /count 3 of total 3/, "message must name the counts");
      return true;
    },
  );
});

test("readPmItems refuses a result with has_more=true", { skip: !hasPmCli() }, async () => {
  const env = mutatedEnvelope((e) => { e.has_more = true; });
  await assert.rejects(
    () => readPmItems(realEnvelope().pmRoot, seamFor(env)),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /has_more=true/, "message must name the tripped signal");
      assert.match(err.message, /count 3 of total 3/, "message must name the counts");
      return true;
    },
  );
});

test("readPmItems refuses a result with completeness.status partial", { skip: !hasPmCli() }, async () => {
  const env = mutatedEnvelope((e) => {
    (e.completeness as Record<string, unknown>).status = "partial";
  });
  await assert.rejects(
    () => readPmItems(realEnvelope().pmRoot, seamFor(env)),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /completeness\.status="partial"/, "message must name the tripped signal");
      assert.match(err.message, /unreadable_item_count=0/);
      assert.match(err.message, /count 3 of total 3/, "message must name the counts");
      return true;
    },
  );
});

test("readPmItems refuses a result with omission_receipt.has_omissions=true", { skip: !hasPmCli() }, async () => {
  const env = mutatedEnvelope((e) => {
    (e.omission_receipt as Record<string, unknown>).has_omissions = true;
  });
  await assert.rejects(
    () => readPmItems(realEnvelope().pmRoot, seamFor(env)),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /omission_receipt\.has_omissions=true/, "message must name the tripped signal");
      assert.match(err.message, /count 3 of total 3/, "message must name the counts");
      return true;
    },
  );
});

test("happy path: a complete envelope flows every item through unchanged", { skip: !hasPmCli() }, async () => {
  const env = mutatedEnvelope(() => { /* unmutated */ });
  const items = await readPmItems(realEnvelope().pmRoot, seamFor(env));
  assert.deepStrictEqual(
    items.map((it) => it.title).sort(),
    ["Envelope Alpha", "Envelope Beta", "Envelope Gamma"],
  );
});

test("assertListResultComplete rejects a result with no completeness receipt", () => {
  assert.throws(
    () => assertListResultComplete({
      items: [],
      count: 0,
      total: 0,
      truncated: false,
      has_more: false,
    } as unknown as Parameters<typeof assertListResultComplete>[0]),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /completeness\.status=\(missing\)/);
      return true;
    },
  );
});

test("assertListResultComplete names listed omitted field groups", () => {
  assert.throws(
    () => assertListResultComplete({
      items: [],
      count: 0,
      total: 0,
      truncated: false,
      has_more: false,
      completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
      omission_receipt: { has_omissions: true },
    } as unknown as Parameters<typeof assertListResultComplete>[0]),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /omitted_field_groups: \(none listed\)/);
      return true;
    },
  );
  assert.throws(
    () => assertListResultComplete({
      items: [],
      count: 0,
      total: 0,
      truncated: false,
      has_more: false,
      completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
      omission_receipt: { has_omissions: true, omitted_field_groups: ["body"] },
    } as unknown as Parameters<typeof assertListResultComplete>[0]),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /omitted_field_groups: body/);
      return true;
    },
  );
});

test("assertListResultComplete falls back to row counts when count/total are absent", () => {
  // Fallback figures inside a refusal message: count from items.length.
  assert.throws(
    () => assertListResultComplete({
      items: [{ id: "a" }, { id: "b" }],
      truncated: true,
      has_more: false,
      completeness: { status: "complete" },
    } as unknown as Parameters<typeof assertListResultComplete>[0]),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /count 2 of total 2/);
      return true;
    },
  );
  // Unreadable sub-counts fall back to zero when the receipt omits them.
  assert.throws(
    () => assertListResultComplete({
      items: [],
      count: 0,
      total: 0,
      truncated: false,
      has_more: false,
      completeness: { status: "partial" },
    } as unknown as Parameters<typeof assertListResultComplete>[0]),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /unreadable_item_count=0, unreadable_directory_count=0/);
      return true;
    },
  );
  // A complete bare receipt (no count/total) does not throw.
  assert.doesNotThrow(() => assertListResultComplete({
    items: [{ id: "a" }],
    truncated: false,
    has_more: false,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    omission_receipt: { has_omissions: false },
  } as unknown as Parameters<typeof assertListResultComplete>[0]));
});

test("readPmItems classifies non-Error rejections from the list action", async () => {
  const throwing = (async () => {
    throw "tracker exploded";
  }) as unknown as PmListAction;
  await assert.rejects(
    () => readPmItems("/does/not/matter", throwing),
    /Could not read pm items via SDK list: tracker exploded/,
  );
});
