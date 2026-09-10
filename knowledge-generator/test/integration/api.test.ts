import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../../src/api/app.js";
import { MemoryEvidenceStore } from "../../src/storage/memoryStore.js";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { FixtureGitHubClient } from "../fixtures/githubFixture.js";

test("standalone HTTP API registers a source and returns a queued sync", async () => {
  const store = new MemoryEvidenceStore();
  await store.initialize();
  const orchestrator = new SyncOrchestrator({
    store,
    github: new FixtureGitHubClient(),
    dataDir: await mkdtemp(join(tmpdir(), "visionowl-api-")),
    now: () => new Date("2026-08-09T12:00:00Z"),
  });
  const app = createApp({ store, orchestrator, logger: false });

  const createResponse = await app.inject({
    method: "POST",
    url: "/v1/sources",
    payload: {
      projectId: "project-api",
      repoUrl: "https://github.com/visionowl/evidence-fixture",
      historySince: "2026-01-01T00:00:00Z",
    },
  });
  assert.equal(createResponse.statusCode, 201, createResponse.body);
  const source = createResponse.json();

  const syncResponse = await app.inject({ method: "POST", url: `/v1/sources/${source.id}/sync`, payload: {} });
  assert.equal(syncResponse.statusCode, 202, syncResponse.body);
  assert.equal(syncResponse.json().status, "queued");

  const runId = syncResponse.json().id as string;
  let terminalStatus: string | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const runResponse = await app.inject({ method: "GET", url: `/v1/sync-runs/${runId}` });
    terminalStatus = runResponse.json().status;
    if (terminalStatus === "succeeded" || terminalStatus === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(terminalStatus, "succeeded");

  const graphResponse = await app.inject({
    method: "GET",
    url: `/v1/repositories/${encodeURIComponent(source.repositoryId)}/evidence-graph`,
  });
  assert.equal(graphResponse.statusCode, 200, graphResponse.body);
  assert.ok(graphResponse.json().nodes.length > 0);

  await app.close();
});
