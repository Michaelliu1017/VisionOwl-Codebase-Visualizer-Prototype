"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const {
  artifactProgress,
  findUnderstandSkillPath,
  outputProgress,
  repositoryUnchanged,
  runUnderstandAnything,
} = require("../src/core/understand-anything");

test("VisionOwl resolves the original Understand-Anything skill", () => {
  const skillPath = findUnderstandSkillPath();
  assert.match(
    skillPath,
    /Understand-Anything\/understand-anything-plugin\/skills\/understand\/SKILL\.md$/,
  );
});

test("Understand-Anything phase output maps to visible progress", () => {
  assert.deepEqual(outputProgress("[Phase 4/7] Architecture analysis..."), {
    phase: "ua_architecture",
    progress: 69,
    message: "[Phase 4/7] Architecture analysis...",
  });
  assert.deepEqual(
    outputProgress(
      "[Phase 2/7] Analyzing files...\nAnalyzing batch 3/10 (files: a.ts)",
    ),
    {
      phase: "ua_analyze",
      progress: 38,
      message: "正在处理第 3 / 10 个文件批次",
    },
  );
});

test("split batch files count as one completed semantic batch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-ua-progress-"));
  const intermediate = path.join(root, "intermediate");
  fs.mkdirSync(intermediate, { recursive: true });
  const startedAt = Date.now();
  fs.writeFileSync(
    path.join(intermediate, "batches.json"),
    JSON.stringify({ batches: [{}, {}] }),
  );
  fs.writeFileSync(path.join(intermediate, "batch-1-part-1.json"), "{}");
  fs.writeFileSync(path.join(intermediate, "batch-1-part-2.json"), "{}");

  const progress = artifactProgress(root, startedAt);
  assert.equal(progress.phase, "ua_analyze");
  assert.equal(progress.progress, 46);
  assert.match(progress.message, /已完成 1 \/ 2/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an existing graph is reusable only while repository code is unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-ua-cache-"));
  const dataDir = path.join(root, ".ua");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(root, "main.js"), "export const value = 1;\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "main.js"], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=VisionOwl",
      "-c",
      "user.email=visionowl@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: root, stdio: "ignore" },
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  fs.writeFileSync(
    path.join(dataDir, "meta.json"),
    JSON.stringify({ gitCommitHash: commit }),
  );
  fs.writeFileSync(
    path.join(dataDir, "knowledge-graph.json"),
    JSON.stringify({ nodes: [], edges: [] }),
  );

  assert.equal(repositoryUnchanged(root, dataDir), true);
  fs.writeFileSync(path.join(root, "main.js"), "export const value = 2;\n");
  assert.equal(repositoryUnchanged(root, dataDir), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("analysis engine selector rejects unknown engines", async () => {
  const previous = process.env.VISIONOWL_ANALYSIS_ENGINE;
  process.env.VISIONOWL_ANALYSIS_ENGINE = "unknown";
  try {
    await assert.rejects(
      runUnderstandAnything({ repoPath: os.tmpdir() }),
      /Use "direct" or "legacy"/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.VISIONOWL_ANALYSIS_ENGINE;
    } else {
      process.env.VISIONOWL_ANALYSIS_ENGINE = previous;
    }
  }
});
