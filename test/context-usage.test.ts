import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import {
  DEFAULT_REPORT_LIMIT,
  LEDGER_RELATIVE_PATH,
  buildUsageReport,
  parseLedgerLine,
  readLedger,
  renderUsageReport,
  reportContextUsage,
  resolveSince,
} from "../context-usage.ts";

import type { ContextUsageEvent } from "@unbrained/pm-cli/sdk";

/** Build a serve event without repeating the row boilerplate in every case. */
function serve(
  at: string,
  author: string,
  surface: "context" | "next",
  rows: Array<[string, number, boolean]>,
): ContextUsageEvent {
  return { kind: "serve", at, author, surface, profile: surface, rows: rows.map(([id, rank, included]) => ({ id, rank, included })) };
}

/** Build a touch event. */
function touch(at: string, author: string, itemId: string, intent = "update"): ContextUsageEvent {
  return { kind: "touch", at, author, item_id: itemId, intent };
}

/** Create a throwaway tracker root, optionally seeded with ledger text. */
function trackerWithLedger(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "pm-context-usage-"));
  if (contents !== undefined) {
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, LEDGER_RELATIVE_PATH), contents, "utf-8");
  }
  return root;
}

test("resolveSince accepts day offsets in signed, unsigned, and fractional forms", () => {
  const now = new Date("2026-07-20T00:00:00.000Z");
  assert.equal(resolveSince("7d", now), "2026-07-13T00:00:00.000Z");
  assert.equal(resolveSince("-7d", now), "2026-07-13T00:00:00.000Z");
  assert.equal(resolveSince("7", now), "2026-07-13T00:00:00.000Z");
  assert.equal(resolveSince("0.5d", now), "2026-07-19T12:00:00.000Z");
});

test("resolveSince accepts an ISO timestamp and rejects blank or unparseable text", () => {
  assert.equal(resolveSince("2026-01-02T03:04:05.000Z"), "2026-01-02T03:04:05.000Z");
  assert.equal(resolveSince(""), null);
  assert.equal(resolveSince("   "), null);
  assert.equal(resolveSince("last tuesday"), null);
});

test("resolveSince defaults its clock to now", () => {
  const before = Date.now();
  const resolved = resolveSince("1d");
  assert.ok(resolved);
  const delta = before - Date.parse(resolved);
  assert.ok(delta >= 86_400_000 - 5_000 && delta <= 86_400_000 + 5_000, `unexpected delta ${delta}`);
});

test("parseLedgerLine decodes well-formed touch and serve rows", () => {
  assert.deepEqual(
    parseLedgerLine('{"kind":"touch","at":"2026-07-01T00:00:00.000Z","author":"a","item_id":"x-1","intent":"create"}'),
    { kind: "touch", at: "2026-07-01T00:00:00.000Z", author: "a", item_id: "x-1", intent: "create" },
  );
  assert.deepEqual(
    parseLedgerLine('{"kind":"serve","at":"2026-07-01T00:00:01.000Z","author":"a","surface":"next","profile":"next","rows":[{"id":"x-1","rank":1,"included":true}]}'),
    { kind: "serve", at: "2026-07-01T00:00:01.000Z", author: "a", surface: "next", profile: "next", rows: [{ id: "x-1", rank: 1, included: true }] },
  );
});

test("parseLedgerLine decodes a well-formed delivery row, including an omitted result", () => {
  assert.deepEqual(
    parseLedgerLine('{"kind":"delivery","schema_version":2,"serve_id":"s1","at":"2026-07-01T00:00:02.000Z","author":"a","surface":"context","result_omitted":false,"delivered_item_ids":["x-1"]}'),
    {
      kind: "delivery",
      schema_version: 2,
      serve_id: "s1",
      at: "2026-07-01T00:00:02.000Z",
      author: "a",
      surface: "context",
      result_omitted: false,
      delivered_item_ids: ["x-1"],
    },
  );
  assert.deepEqual(
    parseLedgerLine('{"kind":"delivery","schema_version":2,"serve_id":"s2","at":"2026-07-01T00:00:03.000Z","author":"a","surface":"next","result_omitted":true,"delivered_item_ids":[]}'),
    {
      kind: "delivery",
      schema_version: 2,
      serve_id: "s2",
      at: "2026-07-01T00:00:03.000Z",
      author: "a",
      surface: "next",
      result_omitted: true,
      delivered_item_ids: [],
    },
  );
});

test("parseLedgerLine rejects every malformed shape rather than admitting partial rows", () => {
  const base = '"at":"2026-07-01T00:00:00.000Z","author":"a"';
  for (const line of [
    "",
    "{not json",
    "123",
    "null",
    '{"kind":"touch","author":"a"}',
    `{"kind":"touch",${base}}`,
    `{"kind":"touch",${base},"item_id":"x-1"}`,
    `{"kind":"other",${base}}`,
    `{"kind":"serve",${base},"surface":"next","rows":[]}`,
    `{"kind":"serve",${base},"surface":"next","profile":"next","rows":{}}`,
    `{"kind":"serve",${base},"surface":"elsewhere","profile":"p","rows":[]}`,
    `{"kind":"serve",${base},"surface":"next","profile":"next","rows":[null]}`,
    `{"kind":"serve",${base},"surface":"next","profile":"next","rows":[{"rank":1,"included":true}]}`,
    `{"kind":"serve",${base},"surface":"next","profile":"next","rows":[{"id":"x","rank":"1","included":true}]}`,
    `{"kind":"serve",${base},"surface":"next","profile":"next","rows":[{"id":"x","rank":1}]}`,
    `{"kind":"delivery",${base},"serve_id":"s1","surface":"context","result_omitted":false,"delivered_item_ids":[]}`,
    `{"kind":"delivery",${base},"schema_version":1,"serve_id":"s1","surface":"context","result_omitted":false,"delivered_item_ids":[]}`,
    `{"kind":"delivery",${base},"schema_version":2,"surface":"context","result_omitted":false,"delivered_item_ids":[]}`,
    `{"kind":"delivery",${base},"schema_version":2,"serve_id":"s1","surface":"context","delivered_item_ids":[]}`,
    `{"kind":"delivery",${base},"schema_version":2,"serve_id":"s1","surface":"context","result_omitted":false,"delivered_item_ids":{}}`,
    `{"kind":"delivery",${base},"schema_version":2,"serve_id":"s1","surface":"elsewhere","result_omitted":false,"delivered_item_ids":[]}`,
    `{"kind":"delivery",${base},"schema_version":2,"serve_id":"s1","surface":"context","result_omitted":false,"delivered_item_ids":[1]}`,
  ]) {
    assert.equal(parseLedgerLine(line), null, `expected null for ${line || "<empty>"}`);
  }
});

test("parseLedgerLine rejects a timestamp that is not canonical ISO", () => {
  // Every window filter, bound, and conversion check compares `at` as a string, and
  // "…00.500Z" sorts before "…00Z" because "." precedes "Z" — so a non-canonical
  // spelling would silently invert chronological order rather than fail loudly.
  for (const at of ["not-a-time", "2026-07-01T00:00:00Z", "2026-07-01", "2026-07-01T00:00:00+02:00"]) {
    assert.equal(
      parseLedgerLine(`{"kind":"touch","at":"${at}","author":"a","item_id":"x-1","intent":"create"}`),
      null,
      `expected null for ${at}`,
    );
  }
  assert.ok(parseLedgerLine('{"kind":"touch","at":"2026-07-01T00:00:00.000Z","author":"a","item_id":"x-1","intent":"create"}'));
});

test("buildUsageReport separates ranked-but-excluded from served across repeated events", () => {
  const report = buildUsageReport([
    serve("2026-07-01T00:00:00.000Z", "a", "context", [["x-1", 3, false]]),
    serve("2026-07-02T00:00:00.000Z", "a", "context", [["x-1", 1, true]]),
    touch("2026-07-03T00:00:00.000Z", "a", "x-1"),
  ]);
  const [entry] = report.items;
  assert.equal(entry.ranked, 2, "ranked in both events");
  assert.equal(entry.serves, 1, "but only shown in the second");
  assert.equal(entry.conversions, 1);
  assert.equal(entry.last_served_at, "2026-07-02T00:00:00.000Z", "the excluded event must not set last_served_at");
  assert.equal(report.conversion_rate, 1, "the excluded row is not a judgment, so it cannot dilute conversion");
});

test("readLedger reports absence without throwing", () => {
  const root = trackerWithLedger();
  try {
    assert.deepEqual(readLedger(root), { present: false, events: [], malformed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readLedger skips blank lines and counts malformed ones separately", () => {
  const root = trackerWithLedger(
    [
      '{"kind":"touch","at":"2026-07-01T00:00:00.000Z","author":"a","item_id":"x-1","intent":"create"}',
      "",
      "   ",
      "{truncated",
      '{"kind":"serve","at":"2026-07-01T00:00:01.000Z","author":"a","surface":"context","profile":"context","rows":[]}',
    ].join("\n"),
  );
  try {
    const ledger = readLedger(root);
    assert.equal(ledger.present, true);
    assert.equal(ledger.events.length, 2);
    assert.equal(ledger.malformed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readLedger does not count a well-formed delivery row as malformed", () => {
  const root = trackerWithLedger(
    [
      '{"kind":"serve","at":"2026-07-01T00:00:00.000Z","author":"a","surface":"context","profile":"context","rows":[]}',
      '{"kind":"delivery","schema_version":2,"serve_id":"s1","at":"2026-07-01T00:00:01.000Z","author":"a","surface":"context","result_omitted":false,"delivered_item_ids":["x-1"]}',
    ].join("\n"),
  );
  try {
    const ledger = readLedger(root);
    assert.equal(ledger.present, true);
    assert.equal(ledger.malformed, 0);
    assert.equal(ledger.events.length, 2);
    assert.equal(ledger.events[1]?.kind, "delivery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildUsageReport ignores delivery events so they cannot skew serve counts or conversion", () => {
  const delivery: ContextUsageEvent = {
    kind: "delivery",
    schema_version: 2,
    serve_id: "s1",
    at: "2026-07-01T00:00:02.000Z",
    author: "a",
    surface: "context",
    result_omitted: false,
    delivered_item_ids: ["x-9"],
  };
  const report = buildUsageReport([
    serve("2026-07-01T00:00:00.000Z", "a", "context", [["x-1", 1, true]]),
    delivery,
    touch("2026-07-01T00:01:00.000Z", "a", "x-1"),
  ]);
  assert.equal(report.event_count, 2, "delivery is recognized but not a serve or touch");
  assert.equal(report.serve_event_count, 1);
  assert.equal(report.touch_event_count, 1);
  assert.deepEqual(report.waste, []);
  assert.deepEqual(report.misses, []);
  assert.equal(report.conversion_rate, 1);
  assert.equal(report.items.some((item) => item.id === "x-9"), false, "delivered ids are not imputed as serves");
});

test("buildUsageReport converts a serve only when the same author touches it later", () => {
  const report = buildUsageReport([
    serve("2026-07-01T00:00:00.000Z", "a", "context", [["x-1", 1, true], ["x-2", 2, true]]),
    touch("2026-07-01T00:01:00.000Z", "a", "x-1", "update"),
    touch("2026-06-30T00:00:00.000Z", "a", "x-2", "create"),
  ]);
  assert.equal(report.conversion_rate, 0.5);
  assert.deepEqual(report.waste, ["x-2"]);
  assert.deepEqual(report.misses, []);
  const [first, second] = report.items;
  assert.equal(first.id, "x-1");
  assert.equal(first.conversions, 1);
  assert.equal(second.conversions, 0);
  assert.equal(second.touches, 1);
});

test("buildUsageReport does not credit a touch recorded by a different author", () => {
  const report = buildUsageReport([
    serve("2026-07-01T00:00:00.000Z", "a", "context", [["x-1", 1, true]]),
    touch("2026-07-01T00:01:00.000Z", "b", "x-1"),
  ]);
  assert.equal(report.conversion_rate, 0);
  assert.deepEqual(report.waste, ["x-1"]);
  assert.deepEqual(report.authors, ["a", "b"]);
});

test("buildUsageReport counts a ranked-but-excluded row as ranked, never as served or wasted", () => {
  const report = buildUsageReport([serve("2026-07-01T00:00:00.000Z", "a", "context", [["x-1", 1, false]])]);
  assert.equal(report.conversion_rate, null);
  const [entry] = report.items;
  assert.equal(entry.ranked, 1, "the row was ranked");
  assert.equal(entry.serves, 0, "but it never made the pack, so it was never shown");
  assert.equal(entry.last_served_at, null);
  assert.equal(entry.best_rank, 1, "best_rank still reflects where the ranker placed it");
  assert.deepEqual(report.waste, [], "an item the agent never saw cannot be wasted context");
  assert.deepEqual(report.misses, [], "and it was not touched either");
});

test("buildUsageReport reports never-served touched items as ranking misses", () => {
  const report = buildUsageReport([touch("2026-07-01T00:00:00.000Z", "a", "x-9", "close")]);
  assert.deepEqual(report.misses, ["x-9"]);
  assert.deepEqual(report.waste, []);
  assert.equal(report.conversion_rate, null);
  assert.equal(report.touch_event_count, 1);
  assert.equal(report.serve_event_count, 0);
  assert.deepEqual(report.surfaces, []);
});

test("buildUsageReport keeps the best rank, latest timestamps, and deduplicated intents", () => {
  const report = buildUsageReport([
    serve("2026-07-01T00:00:00.000Z", "a", "context", [["x-1", 5, true]]),
    serve("2026-07-02T00:00:00.000Z", "a", "next", [["x-1", 2, true]]),
    serve("2026-07-03T00:00:00.000Z", "a", "next", [["x-1", 9, true]]),
    touch("2026-07-04T00:00:00.000Z", "a", "x-1", "update"),
    touch("2026-07-05T00:00:00.000Z", "a", "x-1", "update"),
    touch("2026-07-06T00:00:00.000Z", "a", "x-1", "close"),
  ]);
  const [entry] = report.items;
  assert.equal(entry.best_rank, 2);
  assert.equal(entry.last_served_at, "2026-07-03T00:00:00.000Z");
  assert.equal(entry.last_touched_at, "2026-07-06T00:00:00.000Z");
  assert.deepEqual(entry.intents, ["close", "update"]);
  assert.equal(entry.touches, 3);
  assert.equal(entry.conversions, 3);
  assert.equal(report.from, "2026-07-01T00:00:00.000Z");
  assert.equal(report.to, "2026-07-06T00:00:00.000Z");
  assert.deepEqual(report.surfaces, ["context", "next"]);
});

test("buildUsageReport filters by author, surface, and since", () => {
  const events = [
    serve("2026-07-01T00:00:00.000Z", "a", "context", [["x-1", 1, true]]),
    serve("2026-07-05T00:00:00.000Z", "b", "next", [["x-2", 1, true]]),
    touch("2026-07-06T00:00:00.000Z", "b", "x-2"),
  ];
  assert.deepEqual(buildUsageReport(events, { author: "b" }).authors, ["b"]);
  assert.equal(buildUsageReport(events, { since: "2026-07-04T00:00:00.000Z" }).event_count, 2);
  const bySurface = buildUsageReport(events, { surface: "next" });
  assert.deepEqual(bySurface.surfaces, ["next"]);
  assert.equal(bySurface.serve_event_count, 1);
  assert.equal(bySurface.touch_event_count, 1);
});

test("buildUsageReport orders by serves, then conversions, then id, and honours the limit", () => {
  const events = [
    serve("2026-07-01T00:00:00.000Z", "a", "context", [["b-2", 1, true], ["b-1", 2, true], ["c-1", 3, true]]),
    serve("2026-07-02T00:00:00.000Z", "a", "context", [["b-2", 1, true], ["b-1", 2, true]]),
    touch("2026-07-03T00:00:00.000Z", "a", "b-2"),
  ];
  const report = buildUsageReport(events);
  assert.deepEqual(report.items.map((entry) => entry.id), ["b-2", "b-1", "c-1"]);
  assert.deepEqual(buildUsageReport(events, { limit: 1 }).items.map((entry) => entry.id), ["b-2"]);
  assert.deepEqual(buildUsageReport(events, { limit: 0 }).items, []);
  assert.deepEqual(buildUsageReport(events, { limit: -5 }).items, []);
  assert.equal(buildUsageReport(events).items.length <= DEFAULT_REPORT_LIMIT, true);
});

test("buildUsageReport returns an empty report for an empty ledger", () => {
  const report = buildUsageReport([]);
  assert.deepEqual(report.items, []);
  assert.equal(report.from, null);
  assert.equal(report.to, null);
  assert.equal(report.conversion_rate, null);
  assert.deepEqual(report.authors, []);
});

test("reportContextUsage reads a tracker end to end", () => {
  const root = trackerWithLedger(
    [
      '{"kind":"serve","at":"2026-07-01T00:00:00.000Z","author":"a","surface":"context","profile":"context","rows":[{"id":"x-1","rank":1,"included":true}]}',
      '{"kind":"touch","at":"2026-07-01T00:05:00.000Z","author":"a","item_id":"x-1","intent":"update"}',
      "{bad",
    ].join("\n"),
  );
  try {
    const report = reportContextUsage(root);
    assert.equal(report.ledger_present, true);
    assert.equal(report.malformed_line_count, 1);
    assert.equal(report.conversion_rate, 1);
    assert.deepEqual(report.waste, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reportContextUsage reports an absent ledger without throwing", () => {
  const root = trackerWithLedger();
  try {
    const report = reportContextUsage(root);
    assert.equal(report.ledger_present, false);
    assert.equal(report.malformed_line_count, 0);
    assert.deepEqual(report.items, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderUsageReport explains an absent ledger instead of rendering empty metrics", () => {
  const output = renderUsageReport({
    ledger_present: false,
    event_count: 0,
    malformed_line_count: 0,
    serve_event_count: 0,
    touch_event_count: 0,
    authors: [],
    surfaces: [],
    from: null,
    to: null,
    items: [],
    waste: [],
    misses: [],
    conversion_rate: null,
  });
  assert.match(output, /No ledger at/);
  assert.match(output, /pm writes it on the first/);
});

test("renderUsageReport renders metrics, both failure lists, and the item table", () => {
  const root = trackerWithLedger(
    [
      '{"kind":"serve","at":"2026-07-01T00:00:00.000Z","author":"a","surface":"context","profile":"context","rows":[{"id":"x-1","rank":1,"included":true},{"id":"x-2","rank":2,"included":true}]}',
      '{"kind":"touch","at":"2026-07-01T00:05:00.000Z","author":"a","item_id":"x-1","intent":"update"}',
      '{"kind":"touch","at":"2026-07-01T00:06:00.000Z","author":"a","item_id":"x-9","intent":"create"}',
      "{bad",
    ].join("\n"),
  );
  try {
    const output = renderUsageReport(reportContextUsage(root));
    assert.match(output, /conversion: \*\*50\.0%\*\*/);
    assert.match(output, /malformed lines skipped: 1/);
    assert.match(output, /## Waste \(served, never touched\)\n\n- x-2/);
    assert.match(output, /## Misses \(touched, never served\)\n\n- x-9/);
    assert.match(output, /\| x-1 \| 1 \| 1 \| 1 \| 1 \| 1 \|/);
    assert.match(output, /\| x-9 \| 0 \| 0 \| 0 \| 1 \| - \| - \|/);
    assert.match(output, /surfaces: context/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderUsageReport degrades every optional field to a placeholder", () => {
  const output = renderUsageReport({
    ledger_present: true,
    event_count: 0,
    malformed_line_count: 0,
    serve_event_count: 0,
    touch_event_count: 0,
    authors: [],
    surfaces: [],
    from: null,
    to: null,
    items: [],
    waste: [],
    misses: [],
    conversion_rate: null,
  });
  assert.match(output, /conversion: \*\*n\/a\*\*/);
  assert.match(output, /window: n\/a \.\. n\/a/);
  assert.match(output, /authors: n\/a/);
  assert.match(output, /surfaces: n\/a/);
  assert.match(output, /## Waste \(served, never touched\)\n\n_none_/);
  assert.match(output, /## Misses \(touched, never served\)\n\n_none_/);
  assert.doesNotMatch(output, /malformed lines skipped/);
  assert.doesNotMatch(output, /## Items/);
});

test("renderUsageReport renders the affinity section with entries", () => {
  const output = renderUsageReport({
    ledger_present: true,
    event_count: 1,
    malformed_line_count: 0,
    serve_event_count: 1,
    touch_event_count: 0,
    authors: ["a"],
    surfaces: ["context"],
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-01T00:05:00.000Z",
    items: [],
    waste: [],
    misses: [],
    conversion_rate: null,
    affinity: { affinity: { "x-1": 0.5, "x-2": 0.2 }, positive_judgments: 2, serving_events: 1 },
  });
  assert.match(output, /## Author affinity \(SDK decayed\)/);
  assert.match(output, /positive judgments: 2/);
  assert.match(output, /serving events: 1/);
  assert.match(output, /- x-1: 0\.500/);
  assert.match(output, /- x-2: 0\.200/);
});

test("renderUsageReport renders the affinity section with no entries", () => {
  const output = renderUsageReport({
    ledger_present: true,
    event_count: 1,
    malformed_line_count: 0,
    serve_event_count: 1,
    touch_event_count: 0,
    authors: ["a"],
    surfaces: ["context"],
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-01T00:05:00.000Z",
    items: [],
    waste: [],
    misses: [],
    conversion_rate: null,
    affinity: { affinity: {}, positive_judgments: 0, serving_events: 1 },
  });
  assert.match(output, /## Author affinity \(SDK decayed\)/);
  assert.match(output, /serving events: 1/);
  assert.match(output, /_no decayed affinity yet\._/);
});

/** Activate the extension through the SDK host harness with the manifest's real capabilities. */
async function harness() {
  const created = await createExtensionTestHarness(extension, {
    name: "pm-context",
    capabilities: ["commands", "renderers", "schema"],
  });
  assert.deepEqual(created.activation.failed, [], "activation must not fail");
  return created;
}

/** Unwrap the `{ handled, result }` envelope the host returns from a command run. */
function commandResult<TResult>(result: unknown): TResult {
  return (result as { result: TResult }).result;
}

/** Parse a JSON-rendered extension command result. */
function jsonCommandResult<TResult>(result: unknown): TResult {
  const output = commandResult<{ output?: string }>(result).output;
  assert.ok(output, "expected rendered JSON output");
  return JSON.parse(output) as TResult;
}

/** A tracker seeded with one converted serve and one unserved touch. */
function seededTracker(): string {
  return trackerWithLedger(
    [
      '{"kind":"serve","at":"2026-07-01T00:00:00.000Z","author":"a","surface":"context","profile":"context","rows":[{"id":"x-1","rank":1,"included":true},{"id":"x-2","rank":2,"included":true}]}',
      '{"kind":"touch","at":"2026-07-01T00:05:00.000Z","author":"a","item_id":"x-1","intent":"update"}',
      '{"kind":"touch","at":"2026-07-01T00:06:00.000Z","author":"a","item_id":"x-9","intent":"create"}',
    ].join("\n"),
  );
}

test("context-usage renders markdown by default", async () => {
  const root = seededTracker();
  try {
    // The SDK harness defaults global.json to true; markdown is the CLI default.
    const result = await (await harness()).runCommand({ command: "context-usage", pmRoot: root, global: { json: false } });
    const output = commandResult<{ output?: string }>(result).output;
    assert.ok(output, "expected rendered output");
    assert.match(output, /# Context usage/);
    assert.match(output, /conversion: \*\*50\.0%\*\*/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-usage renders valid JSON for --format json and the global --json alike", async () => {
  const root = seededTracker();
  try {
    const runner = await harness();
    for (const run of [{ options: { format: "json" } }, { global: { json: true } }]) {
      const result = await runner.runCommand({ command: "context-usage", pmRoot: root, ...run });
      const report = jsonCommandResult<{ ledger_present?: boolean; conversion_rate?: number | null }>(result);
      assert.equal(report.ledger_present, true);
      assert.equal(report.conversion_rate, 0.5);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-usage forwards author, surface, since, and limit filters", async () => {
  const root = seededTracker();
  try {
    const result = await (await harness()).runCommand({
      command: "context-usage",
      pmRoot: root,
      global: { json: true },
      options: { by: "a", surface: "next", since: "2020-01-01T00:00:00.000Z", limit: "1" },
    });
    const report = jsonCommandResult<{ items: Array<{ id: string }>; serve_event_count: number }>(result);
    assert.equal(report.serve_event_count, 0, "the only serve event is on the context surface");
    assert.equal(report.items.length, 1, "limit must cap the item rows");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-usage rejects an unknown format, surface, or since value", async () => {
  const root = seededTracker();
  try {
    const runner = await harness();
    await assert.rejects(
      () => runner.runCommand({ command: "context-usage", pmRoot: root, options: { format: "yaml" } }),
      /--format must be markdown or json/,
    );
    await assert.rejects(
      () => runner.runCommand({ command: "context-usage", pmRoot: root, options: { surface: "sideways" } }),
      /--surface must be context or next/,
    );
    await assert.rejects(
      () => runner.runCommand({ command: "context-usage", pmRoot: root, options: { since: "last tuesday" } }),
      /is not an ISO timestamp or a day offset/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context-usage reports an absent ledger through the command surface", async () => {
  const root = trackerWithLedger();
  try {
    const result = await (await harness()).runCommand({ command: "context-usage", pmRoot: root, global: { json: true } });
    assert.equal(jsonCommandResult<{ ledger_present?: boolean }>(result).ledger_present, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
