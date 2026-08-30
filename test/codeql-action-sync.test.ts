import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(workflowDirectory)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => readFileSync(new URL(file, workflowDirectory), "utf8"))
  .join("\n");
const dependabot = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");

test("every CodeQL action in every workflow uses the same pinned release", () => {
  const references = [...workflows.matchAll(/github\/codeql-action\/([^@\s]+)@([^\s]+)/g)];
  const actions = new Set(references.map((reference) => reference[1]));
  const revisions = new Set(references.map((reference) => reference[2]));

  assert.ok(actions.has("init"), "a CodeQL init action must be configured");
  assert.ok(actions.has("analyze"), "a CodeQL analyze action must be configured");
  assert.equal(revisions.size, 1, "every CodeQL action must use the same revision");
  assert.match([...revisions][0] ?? "", /^[a-f0-9]{40}$/, "the shared CodeQL revision must be a commit SHA");
});

test("Dependabot groups CodeQL action updates in the GitHub Actions entry", () => {
  const config: unknown = parse(dependabot);
  const updates = (config as {
    updates?: Array<{
      "package-ecosystem"?: unknown;
      groups?: Record<string, unknown>;
    }>;
  }).updates;
  const githubActions = updates?.find((update) => update["package-ecosystem"] === "github-actions");

  assert.deepEqual(githubActions?.groups?.["codeql-action"], {
    patterns: ["github/codeql-action*"],
  });
  assert.deepEqual(githubActions?.groups?.["codeql-action-security"], {
    "applies-to": "security-updates",
    patterns: ["github/codeql-action*"],
  });
});
