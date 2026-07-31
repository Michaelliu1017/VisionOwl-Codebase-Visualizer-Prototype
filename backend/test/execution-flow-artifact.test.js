"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  adaptExecutionFlows,
  validateArtifact,
} = require("../src/core/execution-flow-artifact");

function fixture() {
  return {
    components: [
      {
        id: "controller",
        name: "Controller",
        summary: "Receives the request.",
        category: "code",
        kind: "controller",
        domain: "Service",
        evidence: [{ file: "src/controller.js", line: 4 }],
      },
      {
        id: "queue",
        name: "Redis Queue",
        summary: "Stores pending IDs.",
        category: "data",
        kind: "redis-queue",
        domain: "Redis",
        evidence: [{ file: "src/queue.js", line: 8 }],
      },
    ],
    flows: [
      {
        id: "pull",
        name: "Pull",
        summary: "Pull one task.",
        entryPoint: "Controller.receive",
        featured: true,
        lanes: ["Service", "Redis"],
        steps: ["controller", "queue"],
        transitions: [
          {
            source: "controller",
            target: "queue",
            label: "RPOP taskId",
            type: "rpop",
            evidence: [{ file: "src/queue.js", line: 8 }],
          },
        ],
      },
    ],
  };
}

test("execution artifact creates ordered code and infrastructure nodes", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-flow-"));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src/controller.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(repo, "src/queue.js"), "module.exports = {};\n");
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const graph = adaptExecutionFlows(
    fixture(),
    { id: "project-flow" },
    repo,
  );

  assert.equal(graph.entities.length, 2);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.executionFlows[0].featured, true);
  assert.equal(
    graph.entities.find((entity) => entity.name === "Redis Queue").category,
    "data",
  );
  assert.equal(graph.relations[0].label, "RPOP taskId");
  assert.equal(graph.relations[0].metadata.execution, true);
});

test("execution artifact rejects source evidence that does not exist", () => {
  assert.throws(
    () => validateArtifact(process.cwd(), fixture()),
    /missing source file/,
  );
});
