export interface CodeEvidence {
  repositoryId?: string;
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  factId?: string;
}

export interface CodeGraphNode {
  id: string;
  name: string;
  kind: string;
  path?: string | null;
  range?: { startLine: number; endLine: number } | null;
  parentId?: string | null;
  summary?: string;
  evidence?: CodeEvidence[];
  repositoryId?: string;
  architecture?: {
    role?: string;
    importance?: "primary" | "supporting" | "detail";
    visibleByDefault?: boolean;
    memberNodeIds?: string[];
  };
}

export interface CodeGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label?: string;
  repositoryId?: string;
  sourceRepositoryId?: string;
  targetRepositoryId?: string;
  evidence?: CodeEvidence[];
}

export interface CodeGraphView {
  id: string;
  name: string;
  nodeIds: string[];
  edgeIds: string[];
}

export interface CodeGraphDocument {
  schemaVersion: string;
  projectId: string;
  commitSha: string;
  generatedAt: string;
  repositoryId?: string;
  repositoryCommits?: Record<string, string>;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  views?: CodeGraphView[];
}

export interface RepositorySnapshot {
  bindingId: string;
  repositoryKey: string;
  repoFullName: string;
  branch: string;
  commitSha: string | null;
}

export interface KnowledgeRunCommand {
  schemaVersion: "1.0";
  commandId: string;
  idempotencyKey: string;
  deadlineAt: string;
  runId: string;
  projectId: string;
  graphVersionId: string;
  graphVersionNo: number;
  graphArtifactKey: string;
  graphDownloadPath: string;
  requestedAssets: Array<"wiki" | "skills">;
  repositorySnapshots: RepositorySnapshot[];
  artifactUploadPath: string;
  callbacks: {
    progress: string;
    complete: string;
    fail: string;
  };
}

export function validateCodeGraph(value: unknown, command?: KnowledgeRunCommand): CodeGraphDocument {
  if (!isRecord(value)) throw new Error("code graph must be an object");
  if (typeof value.projectId !== "string" || typeof value.commitSha !== "string") {
    throw new Error("code graph is missing projectId or commitSha");
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("code graph is missing nodes or edges");
  }
  const graph = value as unknown as CodeGraphDocument;
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || typeof node.name !== "string" || typeof node.kind !== "string") {
      throw new Error("code graph contains an invalid node");
    }
    if (ids.has(node.id)) throw new Error(`code graph contains duplicate node ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== "string" || !ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error(`code graph contains an invalid or dangling edge ${edge?.id ?? "unknown"}`);
    }
  }
  if (command) {
    if (graph.projectId !== command.projectId) {
      throw new Error(`code graph project mismatch: ${graph.projectId} != ${command.projectId}`);
    }
    for (const repository of command.repositorySnapshots) {
      if (!repository.commitSha) throw new Error(`repository ${repository.repoFullName} has no frozen commit`);
      const graphCommit = graph.repositoryCommits?.[repository.repositoryKey];
      if (graphCommit && graphCommit !== repository.commitSha) {
        throw new Error(`repository commit mismatch for ${repository.repoFullName}`);
      }
    }
  }
  return graph;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
