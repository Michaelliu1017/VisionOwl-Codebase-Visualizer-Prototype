import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGraphPatchAliases } from "./patchValidator";

test("normalizes legacy patch aliases without changing semantic fields", () => {
  const raw = {
    schemaVersion: "1.0",
    operations: [{
      operationId: "summary-api",
      operation: "update_summary",
      targetId: "module:api",
      summary: "API module",
      reason: "source evidence",
      confidence: 0.9,
      evidence: [{ file: "src/api.ts", startLine: 1, endLine: 3 }],
    }],
  };

  const normalized = normalizeGraphPatchAliases(raw) as typeof raw & {
    operations: Array<Record<string, unknown>>;
  };
  assert.equal(normalized.operations[0]?.op, "update_summary");
  assert.equal(normalized.operations[0]?.nodeId, "module:api");
  assert.equal("operation" in normalized.operations[0]!, false);
  assert.equal("targetId" in normalized.operations[0]!, false);
  assert.equal(normalized.operations[0]?.summary, "API module");
});
