/** Shared deterministic routing declaration; no model inference is involved. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AnswerReduction, AnswerReductionRequest, AnswerValue } from "../answer-reduction.ts";

/** Noise appears in both branches of the table, yet never changes the route. */
export function routingRequest(item: string): AnswerReductionRequest {
  return { contract_revision: "routing-v1", variables: [{ id: "urgent", values: [false, true] }, { id: "background", values: ["brief", "detailed"] }], rules: [
    { when: [{ variable: "urgent", op: "eq", value: true }, { variable: "background", op: "eq", value: "brief" }], answer: "priority" },
    { when: [{ variable: "urgent", op: "eq", value: true }, { variable: "background", op: "eq", value: "detailed" }], answer: "priority" },
  ], fallback: "normal", fragments: [
    { id: "routing", item, field: "title", variables: ["urgent"] },
    { id: "background", item, field: "description", variables: ["background"] },
  ] };
}
/** Independent recursive oracle uses named assignments rather than production cofactor vectors. */
export function assertAnswers(packet: AnswerReduction): number {
  const request = packet.contract;
  let checked = 0;
  /** Compare one full assignment against the emitted reduced table. */
  function visit(index: number, assignment: Map<string, AnswerValue>): void {
    if (index < request.variables.length) {
      const variable = request.variables[index]!;
      for (const value of variable.values) visit(index + 1, new Map([...assignment, [variable.id, value]]));
      return;
    }
    let answer = request.fallback;
    for (const rule of request.rules) {
      let matches = true;
      for (const predicate of rule.when) {
        const equal = assignment.get(predicate.variable) === predicate.value;
        if (predicate.op === "eq" ? !equal : equal) matches = false;
      }
      if (matches) { answer = rule.answer; break; }
    }
    const key = packet.relevant_variables.map((id) => assignment.get(id));
    const reduced = packet.routing.find((row) => JSON.stringify(row.inputs) === JSON.stringify(key));
    assert.equal(reduced?.answer, answer); checked++;
  }
  visit(0, new Map()); assert.equal(checked, packet.combinations); return checked;
}
/** Hash every file in only the supplied tracker, including foreign records and runtime state. */
export function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    hash.update(entry.name); hash.update(entry.isSymbolicLink() ? "link" : entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}
