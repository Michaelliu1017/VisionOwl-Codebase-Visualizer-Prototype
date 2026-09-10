import type { EdgeType, GraphDocument, GraphEdge, GraphNode, NodeKind } from "../../types";
import type { FactEndpoint, FactIndex, FactRelation, NormalizedFact } from "./contracts";
import { stableHash } from "./ids";

function nodeKind(endpoint: FactEndpoint): NodeKind {
  switch (endpoint.kind) {
    case "module": return "module";
    case "submodule": return "submodule";
    case "class": return "class";
    case "interface": return "interface";
    case "function":
    case "method":
    case "variable":
    case "route": return "function";
    case "db": return "infra.db";
    case "redis": return "infra.redis";
    case "mq": return "infra.mq";
    case "config": return "config";
    default: return "external";
  }
}

function edgeType(relation: FactRelation): EdgeType {
  switch (relation) {
    case "contains": return "contains";
    case "call": return "call";
    case "read": return "read";
    case "write": return "write";
    case "publish": return "publish";
    case "consume": return "consume";
    case "import":
    case "require":
    case "configure":
    case "provide": return "dependency";
  }
}

function summaryFor(endpoint: FactEndpoint, fact: NormalizedFact): string {
  const configured = fact.attributes?.description;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  switch (endpoint.kind) {
    case "module": return `${endpoint.name} 代码模块`;
    case "submodule": return `${endpoint.name} 内部代码分区`;
    case "route": return `对外提供 ${endpoint.name} HTTP 接口`;
    case "db": return `${endpoint.name} 数据存储`;
    case "redis": return `${endpoint.name} Redis 资源`;
    case "mq": return `${endpoint.name} 消息资源`;
    case "config": return `${endpoint.name} 配置项`;
    default: return `${endpoint.kind} ${endpoint.name}`;
  }
}

function toEvidence(fact: NormalizedFact): GraphNode["evidence"] {
  return fact.evidence.map((evidence) => ({
    file: evidence.file,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    symbol: evidence.symbol,
    factId: fact.factId,
    excerptHash: evidence.excerptHash,
  }));
}

function shouldMaterialize(endpoint: FactEndpoint): boolean {
  return endpoint.kind !== "unknown";
}

export function buildBaseGraph(index: FactIndex, projectId: string): GraphDocument {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const ensureNode = (endpoint: FactEndpoint, fact: NormalizedFact): void => {
    if (!shouldMaterialize(endpoint)) return;
    const current = nodes.get(endpoint.id);
    if (current) {
      // contains facts may materialize the parent first with a generic domain label (for example "root").
      // The module declaration is authoritative for its display name and path.
      if (endpoint.kind === "module" && fact.attributes?.nodeKind === "module") {
        current.name = endpoint.name;
        current.path = endpoint.path ?? null;
        current.domain = fact.attributes?.domain ? String(fact.attributes.domain) : current.domain;
        current.summary = summaryFor(endpoint, fact);
      }
      current.factIds = [...new Set([...(current.factIds ?? []), fact.factId])].sort();
      current.evidence = [...(current.evidence ?? []), ...(toEvidence(fact) ?? [])].slice(0, 8);
      return;
    }
    const parentId = endpoint.moduleId && endpoint.id !== endpoint.moduleId ? endpoint.moduleId : null;
    nodes.set(endpoint.id, {
      id: endpoint.id,
      name: endpoint.name,
      kind: nodeKind(endpoint),
      path: endpoint.path ?? null,
      domain: fact.attributes?.domain ? String(fact.attributes.domain) : null,
      parentId,
      summary: summaryFor(endpoint, fact),
      evidence: toEvidence(fact),
      inferred: false,
      repositoryId: index.repositoryId,
      factIds: [fact.factId],
      certainty: fact.certainty,
    });
  };

  for (const fact of index.facts) {
    ensureNode(fact.subject, fact);
    if (fact.object) ensureNode(fact.object, fact);
    if (!fact.relation || !fact.object || fact.subject.id === fact.object.id) continue;
    const type = fact.relation === "provide" && fact.object.kind === "route"
      ? "contains"
      : edgeType(fact.relation);
    const id = `edge:${stableHash(index.repositoryId, fact.subject.id, type, fact.object.id)}`;
    const current = edges.get(id);
    if (current) {
      current.factIds = [...new Set([...(current.factIds ?? []), fact.factId])].sort();
      current.evidence = [...(current.evidence ?? []), ...(toEvidence(fact) ?? [])].slice(0, 8);
      continue;
    }
    edges.set(id, {
      id,
      source: fact.subject.id,
      target: fact.object.id,
      type,
      inferred: false,
      evidence: toEvidence(fact),
      repositoryId: index.repositoryId,
      factIds: [fact.factId],
      certainty: fact.certainty,
      label: fact.relation,
    });
  }

  const graphNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const graphEdges = [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
  const overviewNodeIds = graphNodes
    .filter((node) => node.kind === "module" || node.kind.startsWith("infra.") || node.kind === "external")
    .map((node) => node.id);
  const overviewSet = new Set(overviewNodeIds);
  const overviewEdgeIds = graphEdges
    .filter((edge) => overviewSet.has(edge.source) && overviewSet.has(edge.target))
    .map((edge) => edge.id);
  const interfaceNodeIds = graphNodes
    .filter((node) => node.kind === "function" || node.kind === "external")
    .map((node) => node.id);
  const interfaceSet = new Set([...overviewNodeIds, ...interfaceNodeIds]);

  return {
    schemaVersion: "1.0",
    projectId,
    commitSha: index.commitSha,
    generatedAt: index.generatedAt,
    repositoryId: index.repositoryId,
    repositoryCommits: { [index.repositoryId]: index.commitSha },
    factSchemaVersion: index.schemaVersion,
    graphLayer: "base",
    nodes: graphNodes,
    edges: graphEdges,
    views: [
      { id: "overview", name: "总体架构", nodeIds: overviewNodeIds, edgeIds: overviewEdgeIds },
      {
        id: "interfaces",
        name: "接口与资源",
        nodeIds: [...interfaceSet].sort(),
        edgeIds: graphEdges.filter((edge) => interfaceSet.has(edge.source) && interfaceSet.has(edge.target)).map((edge) => edge.id),
      },
    ],
    stats: {
      nodeCount: graphNodes.length,
      edgeCount: graphEdges.length,
      inferredCount: 0,
    },
  };
}
