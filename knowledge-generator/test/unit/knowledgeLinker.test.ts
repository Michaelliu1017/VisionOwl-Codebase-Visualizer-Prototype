import assert from "node:assert/strict";
import test from "node:test";
import { buildModuleEvidenceBundles, linkEvidenceToCodeGraph } from "../../src/knowledge/linker.js";
import {
  knowledgeCommand,
  knowledgeEvidenceInput,
  knowledgeGraph,
} from "../fixtures/knowledgeFixture.js";

test("links engineering evidence to code modules using deterministic repository and path facts", () => {
  const linked = linkEvidenceToCodeGraph(knowledgeCommand, knowledgeGraph, [knowledgeEvidenceInput]);
  const bundles = buildModuleEvidenceBundles(knowledgeGraph, [knowledgeEvidenceInput], linked);
  const retry = bundles.find((item) => item.module.id === "module-retry");

  assert.ok(retry);
  assert.deepEqual(retry.evidence.map((item) => item.id).sort(), [
    "ci-job-1",
    "comment-1",
    "commit-1",
    "file-change-1",
    "file-change-2",
  ]);
  assert.equal(linked.stats.exactLinks >= 2, true);
  assert.equal(linked.stats.derivedLinks >= 2, true);
  assert.equal(linked.links.every((item) => item.moduleId === "module-retry"), true);
});
