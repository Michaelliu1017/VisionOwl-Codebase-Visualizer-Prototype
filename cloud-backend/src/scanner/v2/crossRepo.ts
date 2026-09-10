import type { Evidence, GraphDocument, GraphEdge, GraphView } from "../../types";
import { computeStats } from "../../schemas/graphValidator";
import { orderGraphViews } from "../../schemas/viewOrder";
import type { InterfaceCatalog, InterfaceRecord } from "./contracts";
import { stableHash } from "./ids";

export interface RepositorySnapshotInput {
  repositoryId: string;
  repositoryName?: string;
  commitSha: string;
  graph: GraphDocument;
  interfaceCatalog: InterfaceCatalog;
}

export interface CrossRepoLink {
  linkId: string;
  consumerRepositoryId: string;
  consumerModuleId: string;
  providerRepositoryId: string;
  providerModuleId: string;
  protocol: InterfaceRecord["protocol"];
  operation: string;
  address: string;
  certainty: "exact";
  consumerEvidence: Evidence[];
  providerEvidence: Evidence[];
}

export interface UnresolvedCrossRepoLink {
  candidateId: string;
  consumerRepositoryId: string;
  consumerModuleId: string;
  protocol: InterfaceRecord["protocol"];
  operation: string;
  address: string;
  reason: "missing_identity" | "no_provider" | "ambiguous_provider";
  candidateProviderRepositoryIds: string[];
}

export interface CrossRepoLinkReport {
  schemaVersion: "1.0";
  projectId: string;
  projectSnapshotId: string;
  generatedAt: string;
  repositoryCommits: Record<string, string>;
  links: CrossRepoLink[];
  unresolved: UnresolvedCrossRepoLink[];
}

export function projectSnapshotCommitSha(repositoryCommits: Record<string, string>): string {
  const ordered = Object.fromEntries(
    Object.entries(repositoryCommits).sort(([left], [right]) => left.localeCompare(right)),
  );
  return stableHash(JSON.stringify(ordered));
}

function normalizedKey(record: InterfaceRecord): string | null {
  const address = record.protocol === "http"
    ? record.address.replace(/^https?:\/\/[^/]+/i, "").replace(/\/+$/, "") || "/"
    : record.protocol === "package"
      ? record.address.trim().toLowerCase().replace(/[._]+/g, "-")
    : record.address;
  if (record.protocol === "http" && !record.serviceIdentity) return null;
  if (record.protocol === "event" && !record.contractId) return null;
  return [
    record.protocol,
    record.serviceIdentity ?? "-",
    record.contractId ?? "-",
    record.operation.toUpperCase(),
    address,
  ].join(":");
}

function evidenceFor(record: InterfaceRecord): Evidence[] {
  return record.evidence.map((item) => ({
    repositoryId: record.repositoryId,
    file: item.file,
    startLine: item.startLine,
    endLine: item.endLine,
    excerptHash: item.excerptHash,
  }));
}

export function linkProjectRepositories(
  projectId: string,
  repositories: RepositorySnapshotInput[],
): CrossRepoLinkReport {
  const orderedRepositories = [...repositories].sort((left, right) =>
    left.repositoryId.localeCompare(right.repositoryId),
  );
  const repositoryCommits = Object.fromEntries(
    orderedRepositories.map((repository) => [repository.repositoryId, repository.commitSha]),
  );
  const projectSnapshotId = `snapshot:${projectSnapshotCommitSha(repositoryCommits)}`;
  const providers = new Map<string, InterfaceRecord[]>();
  const requirements: InterfaceRecord[] = [];
  for (const repository of orderedRepositories) {
    if (
      repository.interfaceCatalog.repositoryId !== repository.repositoryId ||
      repository.interfaceCatalog.commitSha !== repository.commitSha ||
      repository.graph.repositoryId !== repository.repositoryId ||
      repository.graph.commitSha !== repository.commitSha
    ) {
      throw new Error(`仓库快照产物不一致：${repository.repositoryId}@${repository.commitSha}`);
    }
    for (const record of repository.interfaceCatalog.interfaces) {
      if (record.direction === "provides") {
        const key = normalizedKey(record);
        if (!key) continue;
        providers.set(key, [...(providers.get(key) ?? []), record]);
      } else {
        requirements.push(record);
      }
    }
  }

  const links: CrossRepoLink[] = [];
  const unresolved: UnresolvedCrossRepoLink[] = [];
  for (const requirement of requirements.sort((left, right) => left.interfaceId.localeCompare(right.interfaceId))) {
    const key = normalizedKey(requirement);
    if (!key) {
      unresolved.push({
        candidateId: `candidate:${stableHash(requirement.repositoryId, requirement.moduleId, requirement.interfaceId)}`,
        consumerRepositoryId: requirement.repositoryId,
        consumerModuleId: requirement.moduleId,
        protocol: requirement.protocol,
        operation: requirement.operation,
        address: requirement.address,
        reason: "missing_identity",
        candidateProviderRepositoryIds: [],
      });
      continue;
    }
    const candidates = (providers.get(key) ?? [])
      .filter((provider) => provider.repositoryId !== requirement.repositoryId)
      .sort((left, right) => `${left.repositoryId}:${left.moduleId}`.localeCompare(`${right.repositoryId}:${right.moduleId}`));
    if (candidates.length !== 1) {
      unresolved.push({
        candidateId: `candidate:${stableHash(requirement.repositoryId, requirement.moduleId, key)}`,
        consumerRepositoryId: requirement.repositoryId,
        consumerModuleId: requirement.moduleId,
        protocol: requirement.protocol,
        operation: requirement.operation,
        address: requirement.address,
        reason: candidates.length === 0 ? "no_provider" : "ambiguous_provider",
        candidateProviderRepositoryIds: [...new Set(candidates.map((candidate) => candidate.repositoryId))],
      });
      continue;
    }
    const provider = candidates[0]!;
    links.push({
      linkId: `cross:${stableHash(requirement.repositoryId, requirement.moduleId, provider.repositoryId, provider.moduleId, key)}`,
      consumerRepositoryId: requirement.repositoryId,
      consumerModuleId: requirement.moduleId,
      providerRepositoryId: provider.repositoryId,
      providerModuleId: provider.moduleId,
      protocol: requirement.protocol,
      operation: requirement.operation,
      address: requirement.address,
      certainty: "exact",
      consumerEvidence: evidenceFor(requirement),
      providerEvidence: evidenceFor(provider),
    });
  }

  return {
    schemaVersion: "1.0",
    projectId,
    projectSnapshotId,
    generatedAt: new Date().toISOString(),
    repositoryCommits,
    links,
    unresolved,
  };
}

export function composeProjectGraph(
  projectId: string,
  repositories: RepositorySnapshotInput[],
  report: CrossRepoLinkReport,
): GraphDocument {
  const nodes = repositories.flatMap((repository) => repository.graph.nodes);
  const edges = repositories.flatMap((repository) => repository.graph.edges);
  const crossEdges: GraphEdge[] = report.links.map((link) => ({
    id: link.linkId,
    source: link.consumerModuleId,
    target: link.providerModuleId,
    type: "call",
    label: link.protocol === "package" ? `uses ${link.address}` : `${link.operation} ${link.address}`,
    inferred: false,
    certainty: "exact",
    repositoryId: `${link.consumerRepositoryId}->${link.providerRepositoryId}`,
    sourceRepositoryId: link.consumerRepositoryId,
    targetRepositoryId: link.providerRepositoryId,
    evidence: [...link.consumerEvidence, ...link.providerEvidence],
  }));
  const allEdges = [...edges, ...crossEdges]
    .sort((left, right) => left.id.localeCompare(right.id));
  const overviewViews = repositories.flatMap((repository) =>
    (repository.graph.views ?? []).filter((view) => view.id === "overview"),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const crossRepoNodeIds = report.links.flatMap((link) => [link.consumerModuleId, link.providerModuleId]);
  const repositoryAnchors = repositories.flatMap((repository) => {
    const overviewIds = repository.graph.views?.find((view) => view.id === "overview")?.nodeIds ?? [];
    const anchor = overviewIds
      .map((id) => nodeById.get(id))
      .filter((node) => node?.repositoryId === repository.repositoryId)
      .sort((left, right) => {
        const rank = (node: typeof left): number => {
          if (node?.architecture?.importance === "primary") return 0;
          if (node?.architecture?.importance === "supporting") return 1;
          return 2;
        };
        return rank(left) - rank(right) || (left?.id ?? "").localeCompare(right?.id ?? "");
      })[0];
    return anchor ? [anchor.id] : [];
  });
  const mandatoryNodeIds = [...new Set([...crossRepoNodeIds, ...repositoryAnchors])]
    .filter((id) => nodeById.has(id));
  const mandatorySet = new Set(mandatoryNodeIds);
  const rankedCandidates = [...new Set(overviewViews.flatMap((view) => view.nodeIds))]
    .filter((id) => nodeById.has(id) && !mandatorySet.has(id))
    .sort((left, right) => {
      const leftNode = nodeById.get(left);
      const rightNode = nodeById.get(right);
      const rank = (node: typeof leftNode): number => {
        if (node?.architecture?.importance === "primary") return 0;
        if (node?.architecture?.importance === "supporting") return 1;
        if (node?.kind.startsWith("infra.")) return 2;
        return 3;
      };
      return rank(leftNode) - rank(rightNode) || left.localeCompare(right);
    });
  // 跨仓库关系端点与每个仓库的代表节点是总览硬约束，不能被 18 节点上限裁掉。
  const overviewLimit = Math.max(18, mandatoryNodeIds.length);
  const overviewNodeIds = [...mandatoryNodeIds, ...rankedCandidates].slice(0, overviewLimit);
  const overviewSet = new Set(overviewNodeIds);
  const projectOverview: GraphView = {
    id: "project:overview",
    name: "联合架构总览",
    nodeIds: overviewNodeIds,
    edgeIds: allEdges
      .filter((edge) => overviewSet.has(edge.source) && overviewSet.has(edge.target))
      .map((edge) => edge.id),
  };
  const crossView: GraphView = {
    id: "project:cross-repository",
    name: "跨仓库调用",
    nodeIds: [...new Set(report.links.flatMap((link) => [link.consumerModuleId, link.providerModuleId]))].sort(),
    edgeIds: crossEdges.map((edge) => edge.id),
  };
  const mergedFlowViews = ["flow:request", "flow:async", "flow:data", "flow:external"]
    .map((viewId): GraphView | null => {
      const sourceViews = repositories.flatMap((repository) =>
        (repository.graph.views ?? []).filter((view) => view.id === viewId),
      );
      if (sourceViews.length === 0) return null;
      const nodeIds = [...new Set(sourceViews.flatMap((view) => view.nodeIds))].slice(0, 18);
      const nodeSet = new Set(nodeIds);
      const viewEdges = allEdges.filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target));
      if (nodeIds.length < 2 || viewEdges.length === 0) return null;
      const name = sourceViews[0]?.name ?? viewId;
      return { id: viewId, name, nodeIds, edgeIds: viewEdges.map((edge) => edge.id) };
    })
    .filter((view): view is GraphView => Boolean(view));
  const graph: GraphDocument = {
    schemaVersion: "1.0",
    projectId,
    commitSha: report.projectSnapshotId.replace("snapshot:", "").slice(0, 40),
    generatedAt: new Date().toISOString(),
    nodes: [...new Map(nodes.map((node) => [node.id, node])).values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...new Map(allEdges.map((edge) => [edge.id, edge])).values()],
    views: orderGraphViews([
      projectOverview,
      ...(crossEdges.length > 0 ? [crossView] : []),
      ...mergedFlowViews,
    ]),
    repositoryCommits: report.repositoryCommits,
    graphLayer: "final",
    architectureProjection: {
      version: "2.0",
      visibleNodeCount: projectOverview.nodeIds.length,
      visibleModuleCount: projectOverview.nodeIds.filter((id) => nodeById.get(id)?.kind === "module").length,
      hiddenDetailCount: repositories.reduce((sum, repository) =>
        sum + (repository.graph.architectureProjection?.hiddenDetailCount ?? 0), 0),
      sourceNodeCount: repositories.reduce((sum, repository) =>
        sum + (repository.graph.architectureProjection?.sourceNodeCount ?? repository.graph.nodes.length), 0),
      sourceEdgeCount: repositories.reduce((sum, repository) =>
        sum + (repository.graph.architectureProjection?.sourceEdgeCount ?? repository.graph.edges.length), 0),
      detailNodeCount: repositories.reduce((sum, repository) =>
        sum + (repository.graph.architectureProjection?.detailNodeCount ?? 0), 0),
    },
  };
  graph.stats = computeStats(graph);
  return graph;
}
