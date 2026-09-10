import assert from "node:assert/strict";
import test from "node:test";
import type { GraphDocument } from "../types";
import type { InterfaceCatalog } from "./v2/contracts";
import {
  composeProjectGraph,
  linkProjectRepositories,
  projectSnapshotCommitSha,
} from "./v2/crossRepo";

function graph(repositoryId: string, moduleId: string, commitSha: string): GraphDocument {
  return {
    schemaVersion: "1.0",
    projectId: "project-1",
    repositoryId,
    commitSha,
    generatedAt: "2026-08-06T00:00:00.000Z",
    nodes: [{
      id: moduleId,
      name: moduleId,
      kind: "module",
      repositoryId,
      evidence: [{ repositoryId, file: "package.json", startLine: 1, endLine: 1 }],
    }],
    edges: [],
  };
}

function catalog(
  repositoryId: string,
  commitSha: string,
  moduleId: string,
  direction: "provides" | "requires",
): InterfaceCatalog {
  return {
    schemaVersion: "2.0",
    repositoryId,
    commitSha,
    generatedAt: "2026-08-06T00:00:00.000Z",
    interfaces: [{
      interfaceId: `${repositoryId}:POST:/payments`,
      repositoryId,
      moduleId,
      direction,
      protocol: "http",
      operation: "POST",
      address: repositoryId === "order" ? "https://payment.internal/payments" : "/payments",
      serviceIdentity: "payment-service",
      certainty: "exact",
      evidence: [{ file: "src/http.ts", startLine: 10, endLine: 10, excerptHash: repositoryId }],
    }],
  };
}

test("Cross-Repo Linker creates one exact edge from bilateral interface evidence", () => {
  const repositories = [
    { repositoryId: "order", commitSha: "aaaaaaa", graph: graph("order", "module:order:api", "aaaaaaa"), interfaceCatalog: catalog("order", "aaaaaaa", "module:order:api", "requires") },
    { repositoryId: "payment", commitSha: "bbbbbbb", graph: graph("payment", "module:payment:api", "bbbbbbb"), interfaceCatalog: catalog("payment", "bbbbbbb", "module:payment:api", "provides") },
  ];
  const report = linkProjectRepositories("project-1", repositories);
  assert.equal(report.links.length, 1);
  assert.equal(report.unresolved.length, 0);
  assert.equal(report.links[0]?.consumerRepositoryId, "order");
  assert.equal(report.links[0]?.providerRepositoryId, "payment");

  const projectGraph = composeProjectGraph("project-1", repositories, report);
  assert.equal(projectGraph.repositoryCommits?.order, "aaaaaaa");
  assert.equal(projectGraph.edges.length, 1);
  assert.equal(projectGraph.edges[0]?.sourceRepositoryId, "order");
  assert.equal(projectGraph.edges[0]?.targetRepositoryId, "payment");
  assert.equal(projectGraph.views?.[0]?.id, "project:overview");
  assert.equal(
    new Set(projectGraph.views?.map((view) => view.id)).size,
    projectGraph.views?.length,
  );
});

test("Cross-Repo Linker connects exact Python package requirements and keeps them in overview", () => {
  const packageCatalog = (
    repositoryId: string,
    commitSha: string,
    moduleId: string,
    direction: "provides" | "requires",
  ): InterfaceCatalog => ({
    schemaVersion: "2.0",
    repositoryId,
    commitSha,
    generatedAt: "2026-08-10T00:00:00.000Z",
    interfaces: [{
      interfaceId: `${repositoryId}:package:pybanner`,
      repositoryId,
      moduleId,
      direction,
      protocol: "package",
      operation: "IMPORT",
      address: direction === "requires" ? "PyBanner" : "pybanner",
      contractId: "python-package:pybanner",
      certainty: "exact",
      evidence: [{
        file: direction === "requires" ? "requirements.txt" : "setup.py",
        startLine: 1,
        endLine: 1,
        excerptHash: repositoryId,
      }],
    }],
  });
  const repositories = [
    {
      repositoryId: "visionowl",
      commitSha: "aaaaaaa",
      graph: graph("visionowl", "module:visionowl:root", "aaaaaaa"),
      interfaceCatalog: packageCatalog("visionowl", "aaaaaaa", "module:visionowl:root", "requires"),
    },
    {
      repositoryId: "pybanner",
      commitSha: "bbbbbbb",
      graph: graph("pybanner", "module:pybanner:root", "bbbbbbb"),
      interfaceCatalog: packageCatalog("pybanner", "bbbbbbb", "module:pybanner:root", "provides"),
    },
  ];
  const report = linkProjectRepositories("project-1", repositories);
  assert.equal(report.links.length, 1);
  assert.equal(report.links[0]?.protocol, "package");
  const projectGraph = composeProjectGraph("project-1", repositories, report);
  assert.equal(projectGraph.edges[0]?.label, "uses PyBanner");
  const overview = projectGraph.views?.find((view) => view.id === "project:overview");
  assert.ok(overview?.nodeIds.includes("module:visionowl:root"));
  assert.ok(overview?.nodeIds.includes("module:pybanner:root"));
});

test("Cross-Repo Linker keeps ambiguous providers unresolved", () => {
  const repositories = [
    { repositoryId: "order", commitSha: "aaaaaaa", graph: graph("order", "module:order:api", "aaaaaaa"), interfaceCatalog: catalog("order", "aaaaaaa", "module:order:api", "requires") },
    { repositoryId: "payment-a", commitSha: "bbbbbbb", graph: graph("payment-a", "module:payment-a:api", "bbbbbbb"), interfaceCatalog: catalog("payment-a", "bbbbbbb", "module:payment-a:api", "provides") },
    { repositoryId: "payment-b", commitSha: "ccccccc", graph: graph("payment-b", "module:payment-b:api", "ccccccc"), interfaceCatalog: catalog("payment-b", "ccccccc", "module:payment-b:api", "provides") },
  ];
  const report = linkProjectRepositories("project-1", repositories);
  assert.equal(report.links.length, 0);
  assert.equal(report.unresolved[0]?.reason, "ambiguous_provider");
  assert.deepEqual(report.unresolved[0]?.candidateProviderRepositoryIds, ["payment-a", "payment-b"]);
});

test("Cross-Repo Linker refuses path-only HTTP matches without service identity", () => {
  const consumer = catalog("order", "aaaaaaa", "module:order:api", "requires");
  delete consumer.interfaces[0]?.serviceIdentity;
  const repositories = [
    { repositoryId: "order", commitSha: "aaaaaaa", graph: graph("order", "module:order:api", "aaaaaaa"), interfaceCatalog: consumer },
    { repositoryId: "payment", commitSha: "bbbbbbb", graph: graph("payment", "module:payment:api", "bbbbbbb"), interfaceCatalog: catalog("payment", "bbbbbbb", "module:payment:api", "provides") },
  ];
  const report = linkProjectRepositories("project-1", repositories);
  assert.equal(report.links.length, 0);
  assert.equal(report.unresolved[0]?.reason, "missing_identity");
});

test("Cross-Repo Linker rejects mixed-commit artifacts", () => {
  const repositories = [
    { repositoryId: "order", commitSha: "aaaaaaa", graph: graph("order", "module:order:api", "stale00"), interfaceCatalog: catalog("order", "aaaaaaa", "module:order:api", "requires") },
  ];
  assert.throws(() => linkProjectRepositories("project-1", repositories), /仓库快照产物不一致/);
});

test("Project snapshot hash is stable across repository ordering", () => {
  const first = projectSnapshotCommitSha({ order: "aaaaaaa", payment: "bbbbbbb" });
  const reordered = projectSnapshotCommitSha({ payment: "bbbbbbb", order: "aaaaaaa" });
  const changed = projectSnapshotCommitSha({ order: "aaaaaaa", payment: "ccccccc" });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});
