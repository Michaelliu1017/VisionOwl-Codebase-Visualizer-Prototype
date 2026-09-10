export const EVIDENCE_SCHEMA_VERSION = "evidence.v1" as const;

export type EvidenceKind =
  | "repository"
  | "actor"
  | "commit"
  | "change_request"
  | "review"
  | "comment"
  | "file"
  | "file_change"
  | "ci_run"
  | "ci_job";

export type EvidenceRelationType =
  | "REPOSITORY_HAS_EVIDENCE"
  | "ACTOR_AUTHORED"
  | "COMMIT_PARENT_OF"
  | "COMMIT_CHANGES_FILE"
  | "FILE_CHANGE_TARGETS_FILE"
  | "PR_CONTAINS_COMMIT"
  | "PR_CHANGES_FILE"
  | "PR_HAS_REVIEW"
  | "PR_HAS_COMMENT"
  | "REVIEW_HAS_COMMENT"
  | "COMMENT_REPLIES_TO"
  | "COMMENT_TARGETS_FILE"
  | "CI_VALIDATES_COMMIT"
  | "CI_VALIDATES_CHANGE_REQUEST"
  | "CI_CONTAINS_JOB"
  | "PR_MERGED_AS_COMMIT"
  | "EVIDENCE_AFFECTS_MODULE";

export interface ActorRef {
  id: string;
  login: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface EvidenceNode {
  id: string;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  provider: "github";
  repositoryId: string;
  kind: EvidenceKind;
  externalId: string;
  state?: string;
  actor?: ActorRef;
  title?: string;
  content?: string;
  commitSha?: string;
  occurredAt: string;
  updatedAt?: string;
  sourceUrl: string;
  rawRef: string;
  checksum: string;
  payload: Record<string, unknown>;
}

export interface EvidenceEdge {
  id: string;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  repositoryId: string;
  fromId: string;
  toId: string;
  relationType: EvidenceRelationType;
  basis: string;
  rawRef?: string;
  createdAt: string;
}

export interface PendingLink {
  id: string;
  repositoryId: string;
  fromId: string;
  expectedToId: string;
  relationType: EvidenceRelationType;
  basis: string;
  createdAt: string;
}

export interface RawRecord {
  id: string;
  provider: "github";
  repositoryId: string;
  resourceType: string;
  externalId: string;
  requestUrl: string;
  fetchedAt: string;
  etag?: string;
  checksum: string;
  payload: unknown;
}

export interface RepositorySource {
  id: string;
  projectId: string;
  provider: "github";
  repoUrl: string;
  owner: string;
  repo: string;
  externalRepositoryId?: string;
  repositoryId?: string;
  defaultBranch?: string;
  branch?: string;
  historySince?: string;
  status: "pending" | "ready" | "syncing" | "error";
  lastSyncedAt?: string;
  lastDefaultBranchSha?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type SyncRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface SyncCounts {
  rawRecords: number;
  nodes: number;
  edges: number;
  pendingLinks: number;
  apiRequests: number;
}

export interface SyncRun {
  id: string;
  sourceId: string;
  mode: "initial" | "incremental";
  status: SyncRunStatus;
  phase: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  counts: SyncCounts;
  warnings: string[];
  error?: string;
  snapshotPath?: string;
}

export interface SyncCheckpoint {
  sourceId: string;
  resourceType: string;
  cursor?: string;
  lastSuccessfulAt: string;
  metadata: Record<string, unknown>;
}

export interface EvidenceSnapshot {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  repository: {
    sourceId: string;
    repositoryId: string;
    repoUrl: string;
    owner: string;
    repo: string;
    branch: string;
    commitSha?: string;
  };
  generatedAt: string;
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
  pendingLinks: PendingLink[];
  stats: {
    nodesByKind: Record<string, number>;
    edgesByType: Record<string, number>;
  };
}

export interface SyncRequestOptions {
  historySince?: string;
  maxItems?: number;
  maxConcurrency?: number;
  /** Integrated runs pin collection to the exact GraphVersion commit. */
  targetCommitSha?: string;
}
