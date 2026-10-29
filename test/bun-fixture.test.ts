import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("owned Bun fixture cleanup rescans a real late write after directory enumeration", () => {
  // Start before the native remover loads, so the syscall wrappers observe both
  // synchronous and asynchronous implementations on the declared Node floor.
  const program = `
    import { removeBunFixture } from ${JSON.stringify(new URL("./bun-fixture.ts", import.meta.url).href)};
    import fs from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = fs.mkdtempSync(join(tmpdir(), 'bun-fixture-race-'));
    fs.writeFileSync(join(root, 'initial'), 'initial');
    const originalAsync = fs.rmdir, originalSync = fs.rmdirSync;
    let calls = 0, injections = 0;
    function inject(path) {
      if (String(path) === root && ++calls === 2) {
        fs.writeFileSync(join(root, 'late-cache-write'), 'late'); injections++;
      }
    }
    fs.rmdir = (path, ...args) => { inject(path); return Reflect.apply(originalAsync, fs, [path, ...args]); };
    fs.rmdirSync = (path, ...args) => { inject(path); return Reflect.apply(originalSync, fs, [path, ...args]); };
    try {
      await removeBunFixture(root);
      process.stdout.write(JSON.stringify({ injections, removed: !fs.existsSync(root) }));
    } finally {
      fs.rmdir = originalAsync; fs.rmdirSync = originalSync;
      fs.rmSync(root, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { injections: 1, removed: true });
});
