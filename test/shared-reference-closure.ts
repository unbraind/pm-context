import assert from "node:assert/strict";
import type { SharedEvidencePack } from "../index.ts";

/** Resolve wire references by their advertised address, independently of producer lookup logic. */
export function assertSharedReferenceClosure(pack: SharedEvidencePack): void {
  assert.equal(pack.reference_scope, "packet:fragments:<id>");
  const used = new Set<string>();
  for (const row of [...pack.bindings, ...pack.evidence]) {
    const targets = pack.fragments.filter((fragment) => row.context_ref === `packet:fragments:${fragment.id}`);
    assert.equal(targets.length, 1, `unresolvable or ambiguous reference: ${row.context_ref}`);
    assert.equal(row.id, targets[0]!.id);
    assert.equal(pack.criteria.filter((criterion) => criterion.id === row.criterion).length, 1);
    used.add(targets[0]!.id);
  }
  for (const row of pack.evidence) {
    const target = pack.fragments.find((fragment) => row.context_ref === `packet:fragments:${fragment.id}`)!;
    assert.equal(row.revision, target.revision);
    assert.equal(row.value_json, target.value_json);
  }
  assert.equal(pack.fragments.length, used.size, "every target is unique and referenced");
}
