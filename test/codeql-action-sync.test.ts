import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
const dependabot = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
const codeqlVersion = "cdf488f595d80d6e07e03d4674febd5ab45fa938";

test("every CodeQL action uses the same current release", () => {
  const references = [...workflow.matchAll(/github\/codeql-action\/([^@\s]+)@([a-f0-9]{40})/g)];

  assert.deepEqual(
    references.map((reference) => reference[1]).sort(),
    ["analyze", "init"],
  );
  assert.deepEqual(new Set(references.map((reference) => reference[2])), new Set([codeqlVersion]));
});

test("Dependabot groups CodeQL action updates into one pull request", () => {
  assert.match(
    dependabot,
    /package-ecosystem: ["']github-actions["'][\s\S]*?groups:\s*\n\s+codeql-action:\s*\n\s+patterns:\s*\n\s+- ["']github\/codeql-action\*["']/,
  );
});
