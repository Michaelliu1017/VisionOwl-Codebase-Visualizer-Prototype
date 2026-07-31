"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { adaptUnderstandGraph } = require("../src/core/understand-adapter");

const project = {
  id: "project-understand",
  name: "Checkout",
  description: "Checkout service",
};

function fixture() {
  return {
    version: "1.0.0",
    project: {
      name: "Checkout",
      languages: ["typescript"],
      frameworks: ["Fastify"],
      description: "Checkout service",
      analyzedAt: "2026-07-28T10:00:00.000Z",
      gitCommitHash: "abcdef1234567890",
    },
    nodes: [
      {
        id: "file:src/api/order.ts",
        type: "file",
        name: "order.ts",
        filePath: "src/api/order.ts",
        summary: "Accepts order requests.",
        tags: ["http"],
        complexity: "moderate",
      },
      {
        id: "function:createOrder",
        type: "function",
        name: "createOrder",
        filePath: "src/api/order.ts",
        lineRange: [14, 30],
        summary: "Creates an order.",
        tags: ["order"],
        complexity: "moderate",
      },
      {
        id: "file:src/storage/order-store.ts",
        type: "file",
        name: "order-store.ts",
        filePath: "src/storage/order-store.ts",
        summary: "Persists orders.",
        tags: ["storage"],
        complexity: "simple",
      },
    ],
    edges: [
      {
        source: "function:createOrder",
        target: "file:src/storage/order-store.ts",
        type: "calls",
        direction: "forward",
        weight: 0.9,
      },
    ],
    layers: [
      {
        id: "layer:api",
        name: "API Layer",
        description: "Inbound HTTP boundary.",
        nodeIds: ["file:src/api/order.ts"],
      },
      {
        id: "layer:storage",
        name: "Storage Layer",
        description: "Order persistence.",
        nodeIds: ["file:src/storage/order-store.ts"],
      },
    ],
    tour: [],
  };
}

test("adapter turns architecture layers into evidence-backed modules", () => {
  const graph = adaptUnderstandGraph(fixture(), project, process.cwd());
  const modules = graph.entities.filter((entity) => entity.kind === "module");
  const api = modules.find((entity) => entity.name === "API Layer");
  const storage = modules.find((entity) => entity.name === "Storage Layer");
  const relation = graph.relations.find(
    (item) => item.source === api.id && item.target === storage.id,
  );

  assert.equal(graph.source, "understand-anything");
  assert.equal(graph.entities.some((entity) => entity.kind === "project"), false);
  assert.equal(graph.relations.some((item) => item.type === "contains"), false);
  assert.deepEqual(
    modules.map((module) => module.name),
    ["API Layer", "Storage Layer"],
  );
  assert.equal(api.metadata.memberCount, 1);
  assert.equal(relation.type, "calls");
  assert.equal(relation.metadata.references, 1);
  assert.equal(relation.evidence[0].file, "src/api/order.ts");
  assert.equal(relation.evidence[0].line, 14);
});

test("adapter refuses to invent modules when the skill produced no layers", () => {
  assert.throws(
    () =>
      adaptUnderstandGraph(
        { ...fixture(), layers: [] },
        project,
        process.cwd(),
      ),
    /no architecture layers/,
  );
});

test("adapter rejects unevidenced static edges across repository boundaries", () => {
  const graph = fixture();
  graph.layers = graph.layers.map((layer, index) => ({
    ...layer,
    repository: index === 0 ? "frontend" : "backend",
  }));

  const adapted = adaptUnderstandGraph(
    graph,
    project,
    process.cwd(),
    { components: [], flows: [] },
  );

  assert.equal(
    adapted.relations.some(
      (relation) => relation.metadata.analyzer === "understand-anything",
    ),
    false,
  );
});

test("adapter promotes evidence-backed data dependencies into architecture overview", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-resource-"));
  try {
    fs.mkdirSync(path.join(root, "service"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "service", "main.go"),
      "package main\nfunc main() {}\n",
    );
    const graph = {
      ...fixture(),
      nodes: [
        {
          id: "file:service/main.go",
          type: "file",
          name: "main.go",
          filePath: "service/main.go",
          summary: "Service entry point.",
          tags: ["entry-point"],
          complexity: "simple",
        },
      ],
      edges: [],
      layers: [
        {
          id: "layer:service",
          name: "Service",
          description: "Runs the service.",
          repository: "service",
          nodeIds: ["file:service/main.go"],
        },
      ],
    };
    const artifact = {
      components: [
        {
          id: "service",
          name: "Service Handler",
          category: "code",
          kind: "service",
          domain: "Service",
          path: "service/main.go",
          evidence: [{ file: "service/main.go", line: 1 }],
        },
        {
          id: "redis-queue",
          name: "Redis · Execution Queue",
          category: "data",
          kind: "redis-queue",
          domain: "Redis",
          evidence: [{ file: "service/main.go", line: 2 }],
        },
      ],
      flows: [
        {
          id: "dispatch",
          name: "Dispatch",
          steps: ["service", "redis-queue"],
          transitions: [
            {
              source: "service",
              target: "redis-queue",
              type: "pushes",
              label: "写入任务",
              evidence: [{ file: "service/main.go", line: 2 }],
            },
          ],
        },
      ],
    };

    const adapted = adaptUnderstandGraph(graph, project, root, artifact);
    const resource = adapted.entities.find(
      (entity) => entity.metadata.architectureResource === true,
    );
    const service = adapted.entities.find(
      (entity) => entity.name === "Service" && entity.kind === "module",
    );
    const relation = adapted.relations.find(
      (item) =>
        item.source === service.id &&
        item.target === resource.id &&
        item.metadata.architectureResource === true,
    );

    assert.equal(resource.name, "Redis · Execution Queue");
    assert.equal(resource.metadata.execution, false);
    assert.equal(resource.metadata.domain, "Redis");
    assert.equal(relation.label, "写入任务");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
