import assert from "node:assert/strict";
import test from "node:test";
import type { GraphDocument, GraphEdge, GraphNode } from "../types";
import { applyArchitectureProjection } from "./v2/architectureProjection";
import type { FactIndex, NormalizedFact } from "./v2/contracts";

const REPOSITORY_ID = "fixture/large-repo";
const COMMIT_SHA = "abcdef1";

function moduleFact(name: string, index: number): NormalizedFact {
  const id = `module:${REPOSITORY_ID}:${name}`;
  return {
    factId: `fact:module:${name}`,
    repositoryId: REPOSITORY_ID,
    commitSha: COMMIT_SHA,
    language: "manifest",
    type: "module",
    subject: { id, name, kind: "module", path: `packages/${name}` },
    evidence: [{ file: `packages/${name}/package.json`, startLine: 1, endLine: 1, excerptHash: name }],
    extractor: { name: "fixture", version: "1" },
    certainty: "exact",
    attributes: {
      nodeKind: "module",
      packageName: `@fixture/${name}`,
      fileCount: Math.max(1, 30 - index),
      domain: name === "web" ? "apps" : "packages",
    },
  };
}

function relationFact(
  name: string,
  source: string,
  relation: "import" | "read" | "write",
  target: { id: string; name: string; kind: "module" | "db" | "redis" },
  type: "import" | "db" | "redis",
): NormalizedFact {
  return {
    factId: `fact:${name}`,
    repositoryId: REPOSITORY_ID,
    commitSha: COMMIT_SHA,
    language: "typescript",
    type,
    subject: { id: source, name: source, kind: "module" },
    relation,
    object: target,
    evidence: [{ file: "src/index.ts", startLine: 1, endLine: 1, excerptHash: name }],
    extractor: { name: "fixture", version: "1" },
    certainty: "exact",
  };
}

function fixture(): { graph: GraphDocument; facts: FactIndex } {
  const names = [
    "web", "api", "worker", "executor", "scheduler", "contracts", "shared-utils", "logger",
    "date-helper", "string-helper", "test-fixtures", "examples", "scripts", "types", "config", "sdk",
  ];
  const moduleFacts = names.map(moduleFact);
  const nodes: GraphNode[] = moduleFacts.map((fact) => ({
    id: fact.subject.id,
    name: fact.subject.name,
    kind: "module",
    path: fact.subject.path,
    domain: String(fact.attributes?.domain ?? "packages"),
    parentId: null,
    summary: `${fact.subject.name} module`,
    evidence: fact.evidence.map((item) => ({ ...item, factId: fact.factId })),
    inferred: false,
    repositoryId: REPOSITORY_ID,
    factIds: [fact.factId],
    certainty: "exact",
  }));
  const byName = new Map(nodes.map((node) => [node.name, node.id]));
  const relations: NormalizedFact[] = [];
  for (const [index, target] of ["api", "worker", "executor", "scheduler", "contracts", "shared-utils"].entries()) {
    relations.push(relationFact(
      `web-${target}-${index}`,
      byName.get("web")!,
      "import",
      { id: byName.get(target)!, name: target, kind: "module" },
      "import",
    ));
  }
  relations.push(relationFact(
    "api-worker",
    byName.get("api")!,
    "import",
    { id: byName.get("worker")!, name: "worker", kind: "module" },
    "import",
  ));

  const resourceFacts: NormalizedFact[] = [];
  for (let index = 0; index < 5; index += 1) {
    const id = `db:table-${index}`;
    nodes.push({ id, name: `table_${index}`, kind: "infra.db", domain: "infra", inferred: false, repositoryId: REPOSITORY_ID });
    resourceFacts.push(relationFact(
      `db-${index}`,
      byName.get("api")!,
      "write",
      { id, name: `table_${index}`, kind: "db" },
      "db",
    ));
  }
  for (let index = 0; index < 7; index += 1) {
    const id = `redis:key-${index}`;
    nodes.push({ id, name: `cache:${index}`, kind: "infra.redis", domain: "infra", inferred: false, repositoryId: REPOSITORY_ID });
    resourceFacts.push(relationFact(
      `redis-${index}`,
      byName.get("worker")!,
      "write",
      { id, name: `cache:${index}`, kind: "redis" },
      "redis",
    ));
  }
  const allFacts = [...moduleFacts, ...relations, ...resourceFacts];
  const edges: GraphEdge[] = [...relations, ...resourceFacts].map((fact) => {
    const type: GraphEdge["type"] = fact.relation === "read"
      ? "read"
      : fact.relation === "write"
        ? "write"
        : "dependency";
    return {
      id: `edge:${fact.factId}`,
      source: fact.subject.id,
      target: fact.object!.id,
      type,
      label: fact.relation,
      inferred: false,
      evidence: fact.evidence.map((item) => ({ ...item, factId: fact.factId })),
      repositoryId: REPOSITORY_ID,
      factIds: [fact.factId],
      certainty: "exact",
    };
  });
  return {
    graph: {
      schemaVersion: "1.0",
      projectId: "fixture-project",
      repositoryId: REPOSITORY_ID,
      commitSha: COMMIT_SHA,
      generatedAt: "2026-08-09T00:00:00.000Z",
      nodes,
      edges,
      views: [{ id: "overview", name: "总体架构", nodeIds: nodes.map((node) => node.id), edgeIds: edges.map((edge) => edge.id) }],
    },
    facts: {
      schemaVersion: "2.0",
      scannerVersion: "2.1.0",
      repositoryId: REPOSITORY_ID,
      commitSha: COMMIT_SHA,
      generatedAt: "2026-08-09T00:00:00.000Z",
      parserVersions: { fixture: "1" },
      facts: allFacts,
      stats: { factCount: allFacts.length, byType: {}, byCertainty: {} },
    },
  };
}

test("architecture projection keeps source counts but publishes only primary modules and aggregate resources", () => {
  const { graph, facts } = fixture();
  const sourceNodeCount = graph.nodes.length;
  const projected = applyArchitectureProjection(graph, facts);
  const overview = projected.views?.find((view) => view.id === "overview");
  assert.ok(overview);
  assert.equal(projected.views?.[0]?.id, "overview", "architecture overview must be the first renderable view");

  for (const name of ["web", "api", "worker", "executor", "scheduler"]) {
    const id = `module:${REPOSITORY_ID}:${name}`;
    assert.ok(overview.nodeIds.includes(id), `${name} should be visible`);
  }
  assert.ok(!overview.nodeIds.includes(`module:${REPOSITORY_ID}:test-fixtures`));
  assert.ok(!overview.nodeIds.includes("db:table-0"));
  assert.ok(!overview.nodeIds.includes("redis:key-0"));
  assert.ok(!projected.nodes.some((node) => node.id === "db:table-0"), "raw resource facts must stay out of the public graph");
  assert.equal(projected.architectureProjection?.sourceNodeCount, sourceNodeCount);
  assert.equal(projected.architectureProjection?.version, "2.0");

  const projectedInfra = projected.nodes.filter((node) =>
    node.id.startsWith("architecture-projection:") && node.kind.startsWith("infra."),
  );
  assert.equal(projectedInfra.length, 2);
  assert.ok(projectedInfra.every((node) => overview.nodeIds.includes(node.id)));
  assert.ok((projected.architectureProjection?.visibleModuleCount ?? 99) <= 12);
  assert.ok(projected.nodes.length < sourceNodeCount, "presentation must be smaller than the source graph");

  const rerun = applyArchitectureProjection(projected, facts);
  assert.deepEqual(
    rerun.nodes.map((node) => node.id),
    projected.nodes.map((node) => node.id),
    "projection must be idempotent",
  );
});

test("architecture projection keeps only a bounded set of important internals for the detail panel", () => {
  const { graph, facts } = fixture();
  const apiId = `module:${REPOSITORY_ID}:api`;
  for (let index = 0; index < 14; index += 1) {
    graph.nodes.push({
      id: `function:api:${index}`,
      name: index < 3 ? `OrderController${index}` : `helper${index}`,
      kind: index < 3 ? "class" : "function",
      parentId: apiId,
      path: `packages/api/src/${index < 3 ? "controllers" : "helpers"}/${index}.ts`,
      summary: index < 3 ? "Handles an important API workflow" : "Small implementation helper",
      evidence: [{ file: `packages/api/src/${index}.ts`, startLine: 1, endLine: 3 }],
      repositoryId: REPOSITORY_ID,
    });
  }

  const projected = applyArchitectureProjection(graph, facts);
  const api = projected.nodes.find((node) => node.id === apiId);
  const internals = projected.nodes.filter((node) => node.parentId === apiId);
  const overview = projected.views?.find((view) => view.id === "overview");

  assert.ok(api);
  assert.ok(internals.length > 0 && internals.length <= 6);
  assert.deepEqual(
    [...(api?.architecture?.memberNodeIds ?? [])].sort(),
    internals.map((node) => node.id).sort(),
  );
  assert.ok(internals.some((node) => node.name.startsWith("OrderController")));
  assert.ok(internals.every((node) => !overview?.nodeIds.includes(node.id)));
});

test("semantic architecture decisions override deterministic ranking", () => {
  const { graph, facts } = fixture();
  graph.nodes = graph.nodes.map((node) => {
    if (node.name === "api") {
      return {
        ...node,
        architecture: {
          role: "backend",
          importance: "detail",
          visibleByDefault: false,
          source: "semantic",
          rationale: "fixture override",
        },
      };
    }
    if (node.name === "date-helper") {
      return {
        ...node,
        architecture: {
          role: "domain",
          importance: "primary",
          visibleByDefault: true,
          source: "semantic",
          rationale: "fixture override",
        },
      };
    }
    return node;
  });
  const overview = applyArchitectureProjection(graph, facts).views?.find((view) => view.id === "overview");
  assert.ok(overview);
  assert.ok(!overview.nodeIds.includes(`module:${REPOSITORY_ID}:api`));
  assert.ok(overview.nodeIds.includes(`module:${REPOSITORY_ID}:date-helper`));
});

test("architecture projection normalizes a root module and never duplicates aggregate nodes", () => {
  const { graph, facts } = fixture();
  const rootId = `module:${REPOSITORY_ID}:web`;
  graph.nodes = graph.nodes.map((node) => node.id === rootId
    ? { ...node, name: ".", path: "." }
    : node);
  facts.facts = facts.facts.map((fact) => fact.subject.id === rootId && fact.type === "module"
    ? { ...fact, subject: { ...fact.subject, name: "visionowl-app", path: "." } }
    : fact);
  for (let index = 0; index < 5; index += 1) {
    const externalId = `external:${index}`;
    graph.nodes.push({
      id: externalId,
      name: `service-${index}`,
      kind: "external",
      repositoryId: REPOSITORY_ID,
    });
    graph.edges.push({
      id: `external-edge:${index}`,
      source: rootId,
      target: externalId,
      type: "call",
      repositoryId: REPOSITORY_ID,
    });
  }

  const projected = applyArchitectureProjection(graph, facts);
  const rootNode = projected.nodes.find((node) => node.id === rootId);
  const overview = projected.views?.find((view) => view.id === "overview");

  assert.equal(rootNode?.name, "visionowl-app");
  assert.equal(new Set(overview?.nodeIds ?? []).size, overview?.nodeIds.length ?? 0);
  assert.equal(projected.nodes.filter((node) => node.name === "External Services").length, 1);
});
