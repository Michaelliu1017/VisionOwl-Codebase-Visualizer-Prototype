import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateSnapshot } from "../../src/evidence/validator.js";
import { MemoryEvidenceStore } from "../../src/storage/memoryStore.js";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { FixtureGitHubClient } from "../fixtures/githubFixture.js";

test("collects a complete deterministic Evidence Graph and remains idempotent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "visionowl-evidence-"));
  const store = new MemoryEvidenceStore();
  await store.initialize();
  const github = new FixtureGitHubClient();
  const now = () => new Date("2026-08-09T12:00:00Z");
  const orchestrator = new SyncOrchestrator({ store, github, dataDir, now });

  const source = await orchestrator.registerSource({
    projectId: "project-fixture",
    repoUrl: "https://github.com/visionowl/evidence-fixture",
    historySince: "2026-01-01T00:00:00Z",
  });
  const firstRun = await orchestrator.runSync(source.id, { maxItems: 100, maxConcurrency: 2 });
  assert.equal(firstRun.status, "succeeded", firstRun.error);
  assert.ok(firstRun.snapshotPath);

  const firstSnapshot = JSON.parse(await readFile(firstRun.snapshotPath!, "utf8"));
  const expectedSummary = JSON.parse(
    await readFile(new URL("../golden/expected-summary.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(firstSnapshot.stats.nodesByKind, expectedSummary.nodesByKind);
  assert.equal(firstSnapshot.pendingLinks.length, expectedSummary.pendingLinks);
  assert.equal(validateSnapshot(firstSnapshot).valid, true);

  const firstCounts = {
    nodes: firstSnapshot.nodes.length,
    edges: firstSnapshot.edges.length,
    raw: (await store.listRawRecords(source.repositoryId!)).length,
  };
  const secondRun = await orchestrator.runSync(source.id, { maxItems: 100, maxConcurrency: 2 });
  assert.equal(secondRun.status, "succeeded", secondRun.error);
  const secondCounts = {
    nodes: (await store.listNodes(source.repositoryId!)).length,
    edges: (await store.listEdges(source.repositoryId!)).length,
    raw: (await store.listRawRecords(source.repositoryId!)).length,
  };
  assert.deepEqual(secondCounts, firstCounts);

  const reviewComment = (await store.listNodes(source.repositoryId!)).find(
    (node) => node.externalId === "review:401",
  );
  assert.equal(reviewComment?.payload.path, "src/retry.ts");
  assert.equal(reviewComment?.payload.line, 10);

  const ciEdges = (await store.listEdges(source.repositoryId!)).filter(
    (edge) => edge.relationType === "CI_VALIDATES_COMMIT",
  );
  assert.equal(ciEdges.length, 2);
});
