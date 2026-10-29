import { rm } from "node:fs/promises";

/** Remove a caller-owned fixture with bounded retries that rescan late cache writes. */
export function removeBunFixture(root: string): Promise<void> {
  return rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
