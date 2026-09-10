/**
 * 契约 DTO 类型（协同开发.md §4-§8）——响应体字段必须与契约逐字一致。
 * 桌面端 app/frontend/src/api/types.ts 是本文件的镜像副本，改动走契约 §13。
 */

export type Role = "owner" | "editor";
export type JobType = "full" | "incremental";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type DocScope = "global" | "module";
export type DocType = "dingtalk" | "external" | "generated";
export type DocStatus = "ok" | "maybe_stale" | "sync_failed";
export type ProjectStatus = "active" | "archived";
export type AnnotationTarget = "node" | "edge";
export type KnowledgeAssetKind = "wiki" | "skills";
export type KnowledgeAssetStatus = "pending" | "generating" | "ready" | "updating" | "failed" | "stale";
export type KnowledgeRunStatus = "queued" | "running" | "publishing" | "succeeded" | "failed" | "canceled";
export type SkillLabRunStatus =
  | "queued"
  | "evaluating"
  | "optimizing"
  | "validating"
  | "succeeded"
  | "rejected"
  | "failed";

export const NODE_KINDS = [
  "domain",
  "module",
  "submodule",
  "class",
  "function",
  "interface",
  "config",
  "infra.redis",
  "infra.mq",
  "infra.db",
  "external",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = [
  "call",
  "dependency",
  "read",
  "write",
  "publish",
  "consume",
  "implement",
  "contains",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const ROLE_RANK: Record<Role, number> = { editor: 1, owner: 2 };

// ── 用户 / 项目 ────────────────────────────────────────────────────────
export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface UserRefDto {
  id: string;
  name: string;
}

export interface DingtalkConnectionDto {
  id: string;
  profileKey: string;
  corpId: string;
  corpName: string;
  userId: string;
  userName: string;
  status: "active" | "reauth_required";
  isDefault: boolean;
  workspaceId: string | null;
  folderId: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DingtalkAuthTaskDto {
  taskId: string;
  status: "pending" | "waiting" | "succeeded" | "failed";
  stage: "starting" | "waiting_authorization" | "completed" | "failed";
  authorizationUrl: string | null;
  userCode: string | null;
  expiresAt: string;
  connection: DingtalkConnectionDto | null;
  error: string | null;
}

export interface BindingDto {
  id: string;
  repoFullName: string;
  branch: string;
  repositoryId: number | null;
  installationId: number | null;
  currentCommitSha: string | null;
  isPrimary: boolean;
}

export interface CurrentGraphDto {
  versionNo: number;
  commitSha: string;
  repositoryCommits: Record<string, string>;
  createdAt: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  status: ProjectStatus;
  myRole: Role;
  owner: UserRefDto;
  repositories: BindingDto[];
  /** 兼容旧客户端：指向主仓库或第一条仓库绑定。 */
  binding: BindingDto | null;
  currentGraph: CurrentGraphDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummaryDto {
  id: string;
  name: string;
  status: ProjectStatus;
  myRole: Role;
  repo: string | null;
  branch: string | null;
  repositoryCount: number;
  currentCommitSha: string | null;
  lastAnalyzedAt: string | null;
  updatedAt: string;
}

// ── 邀请 / 成员 ────────────────────────────────────────────────────────
export interface InvitationCreatedDto {
  id: string;
  key: string;
  role: Role;
  expiresAt: string | null;
  maxUses: number | null;
}

export interface InvitationDto {
  id: string;
  role: Role;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: string | null;
  createdAt: string;
}

export interface MemberDto {
  user: { id: string; name: string; email: string };
  role: Role;
  joinedAt: string;
}

// ── 任务 / 图谱 ────────────────────────────────────────────────────────
export interface JobDto {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  baseCommitSha: string | null;
  targetCommitSha: string | null;
  repositoryCommits: Record<string, string>;
  error: string | null;
  credits: number | null;
  forceReanalysis: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  inferredCount: number;
}

export interface GraphVersionDto {
  versionNo: number;
  commitSha: string;
  repositoryCommits: Record<string, string>;
  jobId: string | null;
  stats: GraphStats;
  artifactUrl: string;
  createdAt: string;
}

// ── 文档 / 批注 ────────────────────────────────────────────────────────
export interface DocumentDto {
  id: string;
  scope: DocScope;
  nodeId: string | null;
  title: string;
  url: string;
  docType: DocType;
  status: DocStatus;
  updatedBy: UserRefDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRevisionDto {
  id: string;
  changeNote: string | null;
  createdBy: UserRefDto | null;
  createdAt: string;
}

export interface AnnotationDto {
  id: string;
  targetKind: AnnotationTarget;
  targetId: string;
  body: string;
  author: UserRefDto | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── 工程知识资产 ──────────────────────────────────────────────────────
export interface KnowledgeAssetEntryDto {
  id: string;
  title: string;
  path: string;
  mediaType: string;
  size: number | null;
}

export interface KnowledgeAssetSummaryDto {
  id: string;
  projectId: string;
  kind: KnowledgeAssetKind;
  status: KnowledgeAssetStatus;
  version: number | null;
  versionId: string | null;
  sourceGraphVersionId: string | null;
  sourceGraphVersionNo: number | null;
  sourceCommitSha: string | null;
  repositoryCommits: Record<string, string>;
  entries: KnowledgeAssetEntryDto[];
  downloadUrl: string | null;
  error: string | null;
  updatedAt: string;
}

export interface KnowledgeAssetVersionDto {
  id: string;
  version: number;
  status: "candidate" | "published" | "rejected" | "superseded";
  sourceGraphVersionId: string;
  sourceGraphVersionNo: number;
  sourceCommitSha: string;
  repositoryCommits: Record<string, string>;
  checksum: string;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface KnowledgeRunDto {
  id: string;
  projectId: string;
  graphVersionId: string;
  graphVersionNo: number;
  requestedAssets: KnowledgeAssetKind[];
  status: KnowledgeRunStatus;
  progress: number;
  stage: string | null;
  note: string | null;
  outputVersionIds: string[];
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SkillLabRunDto {
  id: string;
  projectId: string;
  inputSkillVersionId: string;
  baselineVersionId: string | null;
  outputSkillVersionId: string | null;
  status: SkillLabRunStatus;
  progress: number;
  stage: string | null;
  note: string | null;
  evaluationDatasetRef: string;
  optimizationPolicy: Record<string, unknown>;
  scores: Record<string, unknown>;
  reportUrl: string | null;
  diffUrl: string | null;
  decision: "accepted" | "rejected" | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ── graph.json（spec §8） ──────────────────────────────────────────────
export interface Evidence {
  /** 多仓库 Project 图谱中证据所属仓库；单仓库图谱可省略。 */
  repositoryId?: string;
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  /** Fact Index v2 中可追溯的确定性事实。 */
  factId?: string;
  /** 证据片段摘要；用于验证证据未被静默替换，不保存源码全文。 */
  excerptHash?: string;
}

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  path?: string | null;
  range?: { startLine: number; endLine: number } | null;
  domain?: string | null;
  /** 次级节点所属的顶层模块。为空时表示总览层节点。 */
  parentId?: string | null;
  summary?: string;
  evidence?: Evidence[];
  inferred?: boolean;
  docRefs?: string[];
  repositoryId?: string;
  factIds?: string[];
  certainty?: "exact" | "resolved" | "configured" | "unresolved";
  analysisStatus?: "complete" | "incomplete" | "warning";
  /** 架构展示层元数据。机器事实与面向人的展示图通过该字段建立可追溯映射。 */
  architecture?: {
    role: "frontend" | "backend" | "worker" | "executor" | "data" | "shared" | "domain" | "external";
    importance: "primary" | "supporting" | "detail";
    score?: number;
    visibleByDefault: boolean;
    source: "deterministic" | "semantic";
    rationale?: string;
    memberNodeIds?: string[];
    displayGroup?: "client" | "local-runtime" | "cloud-runtime" | "shared" | "external";
    groupLabel?: string;
  };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  inferred?: boolean;
  evidence?: Evidence[];
  repositoryId?: string;
  factIds?: string[];
  certainty?: "exact" | "resolved" | "configured" | "unresolved";
  label?: string;
  sourceRepositoryId?: string;
  targetRepositoryId?: string;
}

export interface GraphView {
  id: string;
  name: string;
  nodeIds: string[];
  edgeIds: string[];
  steps?: Array<{ order: number; edgeId: string; label?: string }>;
}

export interface GraphDocument {
  schemaVersion: string;
  projectId: string;
  commitSha: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  views?: GraphView[];
  stats?: GraphStats;
  repositoryId?: string;
  repositoryCommits?: Record<string, string>;
  factSchemaVersion?: string;
  graphLayer?: "base" | "final";
  baseGraphVersion?: string;
  acceptedPatchCount?: number;
  architectureProjection?: {
    version: "1.0" | "2.0";
    visibleNodeCount: number;
    visibleModuleCount: number;
    hiddenDetailCount: number;
    sourceNodeCount?: number;
    sourceEdgeCount?: number;
    detailNodeCount?: number;
  };
}

/** Runner 产出的受影响清单，驱动文档 maybe_stale */
export interface ImpactReport {
  commitSha: string;
  baseCommitSha: string | null;
  changedFiles: string[];
  affectedNodeIds: string[];
  globalStructureChanged: boolean;
}

/** 事件类型（契约 §5） */
export type EventType =
  | "repository.push.received"
  | "job.created"
  | "job.progress"
  | "job.succeeded"
  | "job.failed"
  | "graph.version.switched"
  | "document.created"
  | "document.updated"
  | "document.deleted"
  | "document.publication.ready"
  | "knowledge.run.updated"
  | "knowledge.asset.published"
  | "skilllab.run.updated"
  | "skill.version.published"
  | "annotation.created"
  | "annotation.updated"
  | "annotation.deleted"
  | "member.joined";
