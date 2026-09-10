import type { CodeGraphDocument, KnowledgeRunCommand, RepositorySnapshot } from "../../src/codegraph/types.js";
import type { EvidenceEdge, EvidenceNode, EvidenceSnapshot } from "../../src/domain/types.js";
import type { RepositoryEvidenceInput } from "../../src/knowledge/types.js";

export const KNOWLEDGE_COMMIT = "2222222222222222222222222222222222222222";

export const knowledgeRepository: RepositorySnapshot = {
  bindingId: "binding-1",
  repositoryKey: "github:101",
  repoFullName: "visionowl/evidence-fixture",
  branch: "main",
  commitSha: KNOWLEDGE_COMMIT,
};

export const knowledgeCommand: KnowledgeRunCommand = {
  schemaVersion: "1.0",
  commandId: "command-1",
  idempotencyKey: "knowledge-1",
  deadlineAt: "2099-01-01T00:00:00.000Z",
  runId: "run-1",
  projectId: "project-1",
  graphVersionId: "graph-1",
  graphVersionNo: 1,
  graphArtifactKey: "visionowl/project-1/graphs/1.json",
  graphDownloadPath: "/internal/v1/knowledge-runs/run-1/input/graph",
  requestedAssets: ["wiki", "skills"],
  repositorySnapshots: [knowledgeRepository],
  artifactUploadPath: "/internal/v1/integration-runs/run-1/artifacts/{fileName}",
  callbacks: {
    progress: "/internal/v1/knowledge-runs/run-1/progress",
    complete: "/internal/v1/knowledge-runs/run-1/complete",
    fail: "/internal/v1/knowledge-runs/run-1/fail",
  },
};

export const knowledgeGraph: CodeGraphDocument = {
  schemaVersion: "visionowl.graph.v1",
  projectId: "project-1",
  commitSha: KNOWLEDGE_COMMIT,
  generatedAt: "2026-08-09T00:00:00.000Z",
  repositoryCommits: { "github:101": KNOWLEDGE_COMMIT },
  nodes: [
    {
      id: "module-retry",
      name: "Retry Engine",
      kind: "module",
      path: "src",
      summary: "Bounds and schedules retries.",
      repositoryId: "github:101",
      architecture: { importance: "primary", visibleByDefault: true },
      evidence: [{ repositoryId: "github:101", file: "src/retry.ts" }],
    },
    {
      id: "module-worker",
      name: "Worker",
      kind: "module",
      path: "worker",
      summary: "Consumes work.",
      repositoryId: "github:101",
      architecture: { importance: "supporting", visibleByDefault: true },
    },
  ],
  edges: [
    { id: "edge-1", source: "module-worker", target: "module-retry", type: "calls", label: "retries" },
  ],
};

const evidenceNodes: EvidenceNode[] = [
  evidenceNode("file-change-1", "file_change", {
    title: "src/retry.ts modified",
    commitSha: KNOWLEDGE_COMMIT,
    payload: { path: "src/retry.ts", scope: "commit", scopeId: KNOWLEDGE_COMMIT },
  }),
  evidenceNode("commit-1", "commit", {
    title: "fix: bound retries",
    commitSha: KNOWLEDGE_COMMIT,
    payload: { parents: ["1111111111111111111111111111111111111111"] },
  }),
  evidenceNode("file-change-2", "file_change", {
    title: "src/retry-policy.ts modified",
    commitSha: "1111111111111111111111111111111111111111",
    payload: {
      path: "src/retry-policy.ts",
      scope: "commit",
      scopeId: "1111111111111111111111111111111111111111",
    },
  }),
  evidenceNode("commit-2", "commit", {
    title: "feat: acknowledge consumed work",
    commitSha: "1111111111111111111111111111111111111111",
    payload: { parents: ["0000000000000000000000000000000000000000"] },
  }),
  evidenceNode("ci-job-1", "ci_job", {
    title: "retry test",
    state: "failure",
    commitSha: KNOWLEDGE_COMMIT,
  }),
  evidenceNode("comment-1", "comment", {
    title: "Review comment",
    content: "Retry must have an upper limit and a regression test.",
    commitSha: KNOWLEDGE_COMMIT,
    payload: { path: "src/retry.ts", line: 12 },
  }),
];

const evidenceEdges: EvidenceEdge[] = [
  evidenceEdge("commit-file", "commit-1", "file-change-1", "COMMIT_CHANGES_FILE"),
  evidenceEdge("ci-commit", "ci-job-1", "commit-1", "CI_VALIDATES_COMMIT"),
];

export const knowledgeSnapshot: EvidenceSnapshot = {
  schemaVersion: "evidence.v1",
  repository: {
    sourceId: "source-1",
    repositoryId: "github:101",
    repoUrl: "https://github.com/visionowl/evidence-fixture",
    owner: "visionowl",
    repo: "evidence-fixture",
    branch: KNOWLEDGE_COMMIT,
    commitSha: KNOWLEDGE_COMMIT,
  },
  generatedAt: "2026-08-09T00:00:00.000Z",
  nodes: evidenceNodes,
  edges: evidenceEdges,
  pendingLinks: [],
  stats: {
    nodesByKind: { file_change: 2, commit: 2, ci_job: 1, comment: 1 },
    edgesByType: { COMMIT_CHANGES_FILE: 1, CI_VALIDATES_COMMIT: 1 },
  },
};

export const knowledgeEvidenceInput: RepositoryEvidenceInput = {
  repository: knowledgeRepository,
  snapshot: knowledgeSnapshot,
};

function evidenceNode(
  id: string,
  kind: EvidenceNode["kind"],
  patch: Partial<EvidenceNode>,
): EvidenceNode {
  return {
    id,
    schemaVersion: "evidence.v1",
    provider: "github",
    repositoryId: "github:101",
    kind,
    externalId: id,
    occurredAt: "2026-08-01T00:00:00.000Z",
    sourceUrl: `https://github.com/visionowl/evidence-fixture/${id}`,
    rawRef: `raw/${id}.json`,
    checksum: "a".repeat(64),
    payload: {},
    ...patch,
  };
}

function evidenceEdge(
  id: string,
  fromId: string,
  toId: string,
  relationType: EvidenceEdge["relationType"],
): EvidenceEdge {
  return {
    id,
    schemaVersion: "evidence.v1",
    repositoryId: "github:101",
    fromId,
    toId,
    relationType,
    basis: "controlled fixture relation",
    createdAt: "2026-08-09T00:00:00.000Z",
  };
}
