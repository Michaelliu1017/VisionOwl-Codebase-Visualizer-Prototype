import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanRepositoryV2 } from "./v2/factIndex";
import { graphFingerprint, evaluateSemanticQuality } from "../schemas/semanticQuality";
import {
  baseGraphVersionFor,
  type GraphPatchDocument,
  validateGraphPatch,
} from "../schemas/patchValidator";
import { mergeAcceptedPatches } from "../schemas/patchMerger";
import { compareScannerVersions } from "./v2/baseline";

const COMMIT_SHA = "abc1234";
const REPOSITORY_ID = "fixture/order-service";

function write(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-scan-v2-"));
  write(root, "package.json", JSON.stringify({
    name: "order-platform",
    private: true,
    workspaces: ["packages/*"],
  }));
  write(root, "src/server.ts", `
    import express from "express";
    import { createOrder } from "../packages/orders/src/index";
    import { generateReport } from "../packages/reports/src/index";

    const app = express();
    app.post("/orders", createOrder);
    app.get("/reports", generateReport);
    app.listen(Number(process.env.PORT ?? 3000));
  `);
  write(root, "src/client.ts", `
    const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:8080";
    export async function loadOrders(path: string): Promise<Response> {
      return fetch(\`${"${API_BASE}"}${"${path}"}\`);
    }
    const client = { query: async (_sql: string) => undefined };
    export async function finishTransaction(): Promise<void> {
      await client.query("COMMIT");
    }
  `);
  write(root, "packages/orders/package.json", JSON.stringify({
    name: "@fixture/orders",
    version: "1.0.0",
  }));
  write(root, "packages/orders/src/index.ts", `
    const redis = {
      get: async (_key: string) => null,
      set: async (_key: string, _value: string) => "OK",
    };
    const db = { query: async (_sql: string) => ({ rows: [] }) };

    export async function createOrder(): Promise<void> {
      const cached = await redis.get("orders:latest");
      if (!cached) {
        await db.query("INSERT INTO orders(id) VALUES (1)");
        await redis.set("orders:latest", "1");
      }
    }
  `);
  write(root, "packages/reports/package.json", JSON.stringify({
    name: "@fixture/reports",
    version: "1.0.0",
  }));
  write(root, "packages/reports/src/index.ts", `
    export async function generateReport(): Promise<string> {
      return "ready";
    }
  `);
  return root;
}

function scan(root: string) {
  return scanRepositoryV2(root, {
    projectId: "fixture-project",
    repositoryId: REPOSITORY_ID,
    commitSha: COMMIT_SHA,
  });
}

function createPolyglotWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-polyglot-"));
  write(root, "service-api/pom.xml", "<project><artifactId>service-api</artifactId></project>");
  write(root, "service-api/src/main/java/demo/Api.java", `
    package demo;
    import org.springframework.jdbc.core.JdbcTemplate;
    import com.example.CommonRedisUtils;
    public class Api { JdbcTemplate db; }
  `);
  write(root, "service-worker/pom.xml", "<project><artifactId>service-worker</artifactId></project>");
  write(root, "service-worker/src/main/java/demo/Worker.java", `
    package demo;
    import org.apache.kafka.clients.consumer.KafkaConsumer;
    public class Worker { KafkaConsumer<String, String> consumer; }
  `);
  write(root, "probe/go.mod", "module example.com/probe\n\ngo 1.22\n");
  write(root, "probe/main.go", "package main\nfunc main() {}\n");
  write(root, "web/package.json", JSON.stringify({ name: "@fixture/web", dependencies: { react: "latest" } }));
  write(root, "web/src/app.tsx", "export function App() { return <main>ok</main>; }\n");
  return root;
}

test("Fact Index v2 extracts stable code and resource facts", () => {
  const root = createFixture();
  try {
    const first = scan(root);
    const second = scan(root);

    assert.equal(first.factIndex.schemaVersion, "2.0");
    assert.deepEqual(
      first.factIndex.facts.map((fact) => fact.factId),
      second.factIndex.facts.map((fact) => fact.factId),
    );
    assert.equal(graphFingerprint(first.baseGraph), graphFingerprint(second.baseGraph));
    assert.ok(first.factIndex.facts.some((fact) => fact.type === "route" && fact.attributes?.path === "/orders"));
    assert.ok(first.factIndex.facts.some((fact) => fact.type === "redis"));
    assert.ok(first.factIndex.facts.some((fact) => fact.type === "db"));
    assert.ok(first.factIndex.facts.some((fact) => fact.type === "config"));
    assert.ok(first.factIndex.facts.some((fact) =>
      fact.type === "http_client" && fact.attributes?.target === "${API_BASE}${path}",
    ));
    assert.ok(!first.factIndex.facts.some((fact) =>
      fact.type === "http_client" && fact.object?.name === "COMMIT",
    ));
    assert.ok(first.baseGraph.nodes.every((node) => node.repositoryId === REPOSITORY_ID));
    const overview = first.baseGraph.views?.find((view) => view.id === "overview");
    const overviewModuleCount = first.baseGraph.nodes.filter((node) =>
      node.kind === "module" && overview?.nodeIds.includes(node.id),
    ).length;
    assert.equal(first.analysisPlan.packets.length, overviewModuleCount);
    assert.ok(first.analysisPlan.packets.some((packet) => packet.entryFactIds.length > 0));
    assert.deepEqual(
      first.analysisPlan.packets.map((packet) => packet.packetHash),
      second.analysisPlan.packets.map((packet) => packet.packetHash),
    );
    const comparison = compareScannerVersions("fixture-project", first);
    assert.ok(comparison.v2.factCount > 0);
    assert.ok(comparison.v2.nodeCount >= comparison.v1.nodeCount);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("incremental analysis only schedules changed modules and one-hop neighbors", () => {
  const root = createFixture();
  try {
    const full = scan(root);
    const incremental = scanRepositoryV2(root, {
      projectId: "fixture-project",
      repositoryId: REPOSITORY_ID,
      commitSha: COMMIT_SHA,
      changedFiles: ["packages/orders/src/index.ts"],
    });
    assert.ok(incremental.analysisPlan.packets.length < full.analysisPlan.packets.length);
    assert.ok(incremental.analysisPlan.packets.some((packet) => packet.module.path === "packages/orders"));
    assert.ok(!incremental.analysisPlan.packets.some((packet) => packet.module.path === "packages/reports"));
    assert.equal(incremental.analysisPlan.plannerVersion, "1.1.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Python package manifests emit exact cross-repository package contracts", () => {
  const providerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-pybanner-provider-"));
  const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-pybanner-consumer-"));
  try {
    write(providerRoot, "setup.py", `from setuptools import setup\nsetup(name="pybanner", version="1.0.0")\n`);
    write(providerRoot, "src/pybanner/__init__.py", "def render():\n    return 'banner'\n");
    write(consumerRoot, "requirements.txt", "pybanner @ git+https://github.com/example/PyBanner.git@abc123\n");
    write(consumerRoot, "src/banner.py", "from pybanner import render\nprint(render())\n");

    const provider = scanRepositoryV2(providerRoot, {
      projectId: "fixture-project",
      repositoryId: "fixture/pybanner",
      commitSha: "provider-sha",
    });
    const consumer = scanRepositoryV2(consumerRoot, {
      projectId: "fixture-project",
      repositoryId: "fixture/visionowl",
      commitSha: "consumer-sha",
    });
    assert.ok(provider.baseGraph.nodes.some((node) => node.kind === "module" && node.name === "pybanner"));
    assert.ok(provider.interfaceCatalog.interfaces.some((record) =>
      record.direction === "provides" && record.protocol === "package" && record.address === "pybanner",
    ));
    assert.ok(consumer.interfaceCatalog.interfaces.some((record) =>
      record.direction === "requires" && record.protocol === "package" && record.address === "pybanner",
    ));
  } finally {
    fs.rmSync(providerRoot, { recursive: true, force: true });
    fs.rmSync(consumerRoot, { recursive: true, force: true });
  }
});

test("polyglot workspace keeps repository roots and extracts shared infrastructure", () => {
  const root = createPolyglotWorkspace();
  try {
    const bundle = scan(root);
    const modulePaths = bundle.factIndex.facts
      .filter((fact) => fact.type === "module" && fact.attributes?.nodeKind === "module")
      .map((fact) => fact.subject.path)
      .sort();
    assert.deepEqual(modulePaths, ["probe", "service-api", "service-worker", "web"]);
    assert.ok(!modulePaths.some((modulePath) => modulePath?.endsWith("/src")));
    assert.ok(bundle.factIndex.facts.some((fact) => fact.type === "redis" && fact.subject.path === "service-api"));
    assert.ok(bundle.factIndex.facts.some((fact) => fact.type === "db" && fact.subject.path === "service-api"));
    assert.ok(bundle.factIndex.facts.some((fact) => fact.type === "mq" && fact.subject.path === "service-worker"));

    const overview = bundle.baseGraph.views?.find((view) => view.id === "overview");
    assert.ok(overview);
    const overviewNodes = bundle.baseGraph.nodes.filter((node) => overview.nodeIds.includes(node.id));
    assert.ok(overviewNodes.some((node) => node.name === "Redis"));
    assert.ok(overviewNodes.some((node) => node.name === "Database"));
    assert.ok(overviewNodes.some((node) => node.name === "Message Queue"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Graph Patch accepts grounded changes and rejects a stale base", () => {
  const root = createFixture();
  try {
    const bundle = scan(root);
    const moduleFact = bundle.factIndex.facts.find((fact) =>
      fact.type === "module" && fact.attributes?.nodeKind === "module",
    );
    assert.ok(moduleFact?.evidence?.[0]);
    const moduleNode = bundle.baseGraph.nodes.find((node) => node.id === moduleFact.subject.id);
    assert.ok(moduleNode);
    const evidence = moduleFact.evidence.map((item) => ({ ...item, factId: moduleFact.factId }));

    const patch: GraphPatchDocument = {
      schemaVersion: "1.0",
      baseGraphVersion: baseGraphVersionFor(bundle.baseGraph),
      repositoryId: REPOSITORY_ID,
      commitSha: COMMIT_SHA,
      generator: "test-agent",
      skillVersion: "test-v1",
      operations: [{
        operationId: "summary-1",
        op: "update_summary",
        reason: "Clarify the module responsibility from its manifest.",
        evidence,
        confidence: 0.9,
        nodeId: moduleNode.id,
        summary: "Owns the order API and coordinates persistence and cache access.",
      }],
    };
    const options = {
      baseGraph: bundle.baseGraph,
      factIndex: bundle.factIndex,
      symbolIndex: bundle.symbolIndex,
      fileExists: (relativePath: string) => fs.existsSync(path.join(root, relativePath)),
    };
    const valid = validateGraphPatch(patch, options);
    assert.equal(valid.ok, true);
    assert.equal(valid.accepted.length, 1, JSON.stringify(valid, null, 2));
    assert.equal(valid.rejected.length, 0);
    assert.equal(valid.conflicts.length, 0);

    const merged = mergeAcceptedPatches(bundle.baseGraph, valid.accepted);
    assert.equal(merged.nodes.find((node) => node.id === moduleNode.id)?.summary, patch.operations[0]?.summary);
    assert.equal(merged.graphLayer, "final");
    assert.equal(merged.acceptedPatchCount, 1);
    assert.equal(merged.views?.[0]?.id, "overview", "patch merging must preserve overview-first ordering");

    const stale = validateGraphPatch({ ...patch, baseGraphVersion: "base-v2:stale" }, options);
    assert.equal(stale.ok, false);
    assert.match(stale.documentErrors.join("\n"), /baseGraphVersion/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Graph Patch rejects malformed graph items and isolates edge conflicts", () => {
  const root = createFixture();
  try {
    const bundle = scan(root);
    const baseEdge = bundle.baseGraph.edges[0];
    assert.ok(baseEdge?.evidence?.[0]);
    const common = {
      schemaVersion: "1.0" as const,
      baseGraphVersion: baseGraphVersionFor(bundle.baseGraph),
      repositoryId: REPOSITORY_ID,
      commitSha: COMMIT_SHA,
      generator: "test-agent",
      skillVersion: "test-v1",
    };
    const options = {
      baseGraph: bundle.baseGraph,
      factIndex: bundle.factIndex,
      symbolIndex: bundle.symbolIndex,
      fileExists: (relativePath: string) => fs.existsSync(path.join(root, relativePath)),
    };
    const malformed = validateGraphPatch({
      ...common,
      operations: [{
        operationId: "bad-node",
        op: "add_node",
        reason: "Missing repository ownership.",
        confidence: 0.9,
        evidence: baseEdge.evidence,
        node: { id: "node:bad", name: "bad", kind: "module" },
      }],
    }, options);
    assert.equal(malformed.ok, false);
    assert.match(malformed.documentErrors.join("\n"), /repositoryId/);

    const conflictingType = baseEdge.type === "call" ? "dependency" : "call";
    const conflict = validateGraphPatch({
      ...common,
      operations: [{
        operationId: "conflicting-edge",
        op: "add_edge",
        reason: "Deliberately conflicts with the deterministic relation.",
        confidence: 0.9,
        evidence: baseEdge.evidence,
        edge: {
          id: "edge:conflict",
          source: baseEdge.source,
          target: baseEdge.target,
          type: conflictingType,
          repositoryId: REPOSITORY_ID,
        },
      }],
    }, options);
    assert.equal(conflict.accepted.length, 0);
    assert.equal(conflict.rejected.length, 0);
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.conflicts[0]?.conflictingEdgeId, baseEdge.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Semantic quality gate publishes a complete deterministic base graph", () => {
  const root = createFixture();
  try {
    const first = scan(root);
    const second = scan(root);
    const report = evaluateSemanticQuality(first.baseGraph, first.factIndex, first.diagnostics, {
      fileExists: (relativePath) => fs.existsSync(path.join(root, relativePath)),
      previousBaseGraph: second.baseGraph,
    });

    assert.equal(report.publishable, true);
    assert.notEqual(report.disposition, "hard_fail");
    assert.equal(report.metrics.find((metric) => metric.id === "declared_module_coverage")?.value, 1);
    assert.equal(report.metrics.find((metric) => metric.id === "deterministic_rerun_stability")?.value, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Semantic quality gate does not publish retry-level graphs", () => {
  const root = createFixture();
  try {
    const bundle = scan(root);
    const graph = structuredClone(bundle.baseGraph);
    const deterministicEdge = graph.edges.find((edge) =>
      edge.inferred !== true && !edge.id.startsWith("architecture-projection:"),
    );
    assert.ok(deterministicEdge);
    deterministicEdge.factIds = [];
    const report = evaluateSemanticQuality(graph, bundle.factIndex, bundle.diagnostics, {
      fileExists: (relativePath) => fs.existsSync(path.join(root, relativePath)),
    });
    assert.equal(report.disposition, "retry");
    assert.equal(report.publishable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
