"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AnalysisService } = require("../src/core/analysis-service");
const { VisionStore } = require("../src/core/store");
const { RepositoryPolicy } = require("../src/security/repository-policy");

function understandGraph() {
  return {
    version: "1.0.0",
    project: {
      name: "Analysis fixture",
      languages: ["javascript"],
      frameworks: [],
      description: "Understand-Anything fixture",
      analyzedAt: new Date().toISOString(),
      gitCommitHash: "1234567890abcdef",
    },
    nodes: [
      {
        id: "file:src/index.js",
        type: "file",
        name: "index.js",
        filePath: "src/index.js",
        summary: "Application entry point.",
        tags: ["entry-point"],
        complexity: "simple",
      },
    ],
    edges: [],
    layers: [
      {
        id: "layer:application",
        name: "Application Layer",
        description: "Application entry and orchestration.",
        nodeIds: ["file:src/index.js"],
      },
    ],
    tour: [],
  };
}

test("analysis service publishes the Understand-Anything graph", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-analysis-"));
  const repoPath = path.join(root, "repository");
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, "src", "index.js"),
    "export function ready() { return true; }\n",
  );
  const store = new VisionStore(path.join(root, "visionowl.db"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const project = store.createProject({
    name: "Analysis fixture",
    repoPath,
  });
  const job = store.createJob(project.id, true);
  const service = new AnalysisService(store, {
    repositoryPolicy: new RepositoryPolicy(),
    repositoryStateImpl: async () => ({ branch: "master", commit: "abc123" }),
    analyzeRepository: async ({ onProgress, onGraph }) => {
      onProgress("ua_scan", 22, "项目扫描完成");
      onGraph(understandGraph(), {
        phase: "facts_ready",
        progress: 30,
        message: "基础事实图谱已发布",
      });
      onProgress("ua_architecture", 74, "架构层识别完成");
      return { knowledgeGraph: understandGraph() };
    },
  });
  await service.execute(job);

  const completed = store.getJob(job.id);
  const graph = store.getGraph(project.id);
  const events = store.listAnalysisEvents(project.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress, 100);
  assert.equal(graph.source, "understand-anything");
  assert.equal(graph.entities.some((entity) => entity.kind === "project"), false);
  assert.equal(graph.relations.some((relation) => relation.type === "contains"), false);
  assert.equal(
    graph.entities.find((entity) => entity.kind === "module").name,
    "Application Layer",
  );
  assert.ok(events.some((event) => event.phase === "ua_architecture"));
  assert.ok(events.some((event) => event.phase === "facts_ready"));
  assert.equal(events.at(-1).phase, "completed");
});
