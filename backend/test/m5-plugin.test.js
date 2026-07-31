"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { genericTopology } = require("../src/plugins/m5");

test("M5 adapter maps native nodes and edges into generic runtime contracts", () => {
  const topology = genericTopology({
    mocked: true,
    generatedAt: "2026-07-28T00:00:00.000Z",
    metrics: { workers: 1 },
    nodes: [
      {
        id: "worker",
        category: "compute",
        entityType: "worker",
        title: "Worker",
        subtitle: "scheduler",
        status: "healthy",
      },
      {
        id: "redis",
        category: "redis-store",
        entityType: "redis",
        title: "Redis",
        status: "warning",
      },
    ],
    edges: [
      {
        id: "worker-redis",
        source: "worker",
        target: "redis",
        relationKind: "writes_to",
        label: "dispatch",
        severity: "warning",
      },
    ],
  });

  assert.equal(topology.provider, "m5-synthetic-monitor");
  assert.equal(topology.entities.length, 2);
  assert.equal(topology.entities[1].category, "data");
  assert.equal(topology.relations[0].type, "writes_to");
  assert.equal(topology.relations[0].status, "warning");
});
