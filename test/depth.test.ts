import assert from "node:assert/strict";
import test from "node:test";
import { testDepth, testTimeout } from "./support/depth.ts";

test("depth preserves the full default and deterministic quick prefix with a 25-case floor", (t) => {
  const original = process.env.PM_TEST_DEPTH;
  t.after(() => { if (original === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = original; });
  for (const depth of [undefined, "full", "unexpected"]) {
    if (depth === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = depth;
    assert.equal(testDepth(500), 500);
  }
  process.env.PM_TEST_DEPTH = "quick";
  for (const [full, quick] of [[500, 50], [251, 26], [100, 25], [25, 25], [12, 12]]) {
    assert.equal(testDepth(full!), quick);
    assert.deepEqual(Array.from({ length: testDepth(full!) }, (_, i) => i), Array.from({ length: full! }, (_, i) => i).slice(0, quick));
  }
});

test("operational deadlines scale and reject invalid or unbounded factors", (t) => {
  const original = process.env.PM_TEST_TIME_SCALE;
  t.after(() => { if (original === undefined) delete process.env.PM_TEST_TIME_SCALE; else process.env.PM_TEST_TIME_SCALE = original; });
  delete process.env.PM_TEST_TIME_SCALE;
  assert.equal(testTimeout(5000), 5000);
  process.env.PM_TEST_TIME_SCALE = "3";
  assert.equal(testTimeout(5000), 15000);
  for (const value of ["", "0", "-1", "NaN", "Infinity", "1e309"]) {
    process.env.PM_TEST_TIME_SCALE = value;
    assert.throws(() => testTimeout(5000), /finite positive/);
  }
});
