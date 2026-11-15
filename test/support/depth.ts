/**
 * Keep full local/release depth by default; quick runs the same deterministic
 * seed prefix at one tenth depth, with at least 25 cases (capped by full count).
 * Callers keep seed generation and per-case assertions identical in both modes.
 */
export function testDepth(full: number): number {
  return process.env.PM_TEST_DEPTH === "quick" ? Math.min(full, Math.max(25, Math.ceil(full / 10))) : full;
}

/** Scale operational test deadlines on slow runners without permitting unbounded waits. */
export function testTimeout(milliseconds: number): number {
  const scale = Number(process.env.PM_TEST_TIME_SCALE ?? "1");
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(milliseconds * scale)) {
    throw new Error("PM_TEST_TIME_SCALE must be a finite positive factor");
  }
  return Math.ceil(milliseconds * scale);
}
