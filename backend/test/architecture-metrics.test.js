"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildArchitectureGroups,
} = require("../src/core/architecture-metrics");
const { fileNodeId } = require("../src/core/understand-static-graph");

function sourceFile(filePath) {
  return {
    path: filePath,
    fileCategory: "code",
    language: filePath.endsWith(".go") ? "go" : "java",
    sizeLines: 20,
  };
}

test("architecture groups never cross independent repository boundaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-groups-"));
  try {
    for (const repository of ["GoProbe", "smartalibench-worker"]) {
      fs.mkdirSync(path.join(root, repository, ".git"), { recursive: true });
    }
    const files = [
      sourceFile("GoProbe/cmsprobe/probe/fetch.go"),
      sourceFile("GoProbe/cmsprobe/task/task.go"),
      sourceFile(
        "smartalibench-worker/src/main/java/example/TaskDispatch.java",
      ),
      sourceFile(
        "smartalibench-worker/src/main/java/example/TaskScheduler.java",
      ),
    ];
    const scan = { files };
    const batches = {
      batches: [
        {
          batchIndex: 1,
          files: files.map((file) => ({ path: file.path })),
        },
      ],
    };
    const graph = {
      nodes: files.map((file) => ({
        id: fileNodeId(file),
        filePath: file.path,
        summary: `${file.path} fixture`,
      })),
      edges: [],
    };

    const groups = buildArchitectureGroups({
      scan,
      batches,
      graph,
      repoPath: root,
    });

    assert.deepEqual(
      [...new Set(groups.map((group) => group.repository))].sort(),
      ["GoProbe", "smartalibench-worker"],
    );
    assert.ok(
      groups.some((group) => group.repository === "smartalibench-worker"),
    );
    for (const group of groups) {
      const repositories = new Set(
        group.facts.paths.map((filePath) => filePath.split("/")[0]),
      );
      assert.equal(repositories.size, 1);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
