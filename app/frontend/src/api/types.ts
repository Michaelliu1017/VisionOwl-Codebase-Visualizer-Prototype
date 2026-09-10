/**
 * VisionOwl 契约类型 —— 与根目录《协同开发.md》contract-v1.0 逐字段对应。
 * 本文件是协议类型在客户端的唯一副本;修改必须先改契约文档。
 */

// ---------- 共享枚举(契约 §3.2) ----------

export type Role = 'owner' | 'editor'
export type JobType = 'full' | 'incremental'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type DocScope = 'global' | 'module'
export type DocType = 'dingtalk' | 'external' | 'generated'
export type DocStatus = 'ok' | 'maybe_stale' | 'sync_failed'
export type NodeKind =
  | 'domain' | 'module' | 'submodule' | 'class' | 'function' | 'interface' | 'config'
  | 'infra.redis' | 'infra.mq' | 'infra.db' | 'external'
export type EdgeType =
  | 'call' | 'dependency' | 'read' | 'write'
  | 'publish' | 'consume' | 'implement' | 'contains'
export type AnnotationTargetKind = 'node' | 'edge'
export type KnowledgeAssetKind = 'wiki' | 'skills'
export type KnowledgeAssetStatus = 'pending' | 'generating' | 'ready' | 'updating' | 'failed' | 'stale'
export type KnowledgeRunStatus = 'queued' | 'running' | 'publishing' | 'succeeded' | 'failed' | 'canceled'
export type SkillLabRunStatus =
  | 'queued' | 'evaluating' | 'optimizing' | 'validating' | 'succeeded' | 'rejected' | 'failed'

// ---------- 错误(契约 §3.1) ----------

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

// ---------- Auth(契约 §4.1) ----------

export interface User {
  id: string
  email: string
  name: string
  createdAt: string
}

export interface AuthResult {
  user: User
  token: string
}

export interface DingtalkConnection {
  id: string
  profileKey: string
  corpId: string
  corpName: string
  userId: string
  userName: string
  status: 'active' | 'reauth_required'
  isDefault: boolean
  workspaceId: string | null
  folderId: string | null
  lastVerifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DingtalkAuthTask {
  taskId: string
  status: 'pending' | 'waiting' | 'succeeded' | 'failed'
  stage: 'starting' | 'waiting_authorization' | 'completed' | 'failed'
  authorizationUrl: string | null
  userCode: string | null
  expiresAt: string
  connection: DingtalkConnection | null
  error: string | null
}

// ---------- Project(契约 §4.2) ----------

export interface ProjectSummary {
  id: string
  name: string
  status: 'active' | 'archived'
  myRole: Role
  repo: string | null
  branch: string | null
  repositoryCount: number
  currentCommitSha: string | null
  lastAnalyzedAt: string | null
  updatedAt: string
}

export interface RepositoryBinding {
  id: string
  repoFullName: string
  branch: string
  repositoryId: number | null
  installationId: number | null
  currentCommitSha: string | null
  isPrimary: boolean
}

export interface PublicRepository {
  id: number
  fullName: string
  defaultBranch: string
  htmlUrl: string
}

export interface PublicBranch {
  name: string
  commitSha: string
}

export interface Project {
  id: string
  name: string
  status: 'active' | 'archived'
  myRole: Role
  owner: { id: string; name: string }
  repositories: RepositoryBinding[]
  /** 兼容旧图层：主仓库或第一条仓库绑定。 */
  binding: RepositoryBinding | null
  currentGraph: {
    versionNo: number
    commitSha: string
    repositoryCommits: Record<string, string>
    createdAt: string
  } | null
  createdAt: string
  updatedAt: string
}

export interface InvitationCreated {
  id: string
  key: string
  role: 'editor'
  expiresAt: null
  maxUses: null
}

export interface InvitationRedeemed {
  projectId: string
  role: Role
}

// ---------- 任务(契约 §4.5) ----------

export interface CreateProjectInput {
  name: string
}

/** 契约 v1.1:installationId 可选,repoUrl 与 repoFullName 二者其一 */
export interface BindRepoInput {
  repoUrl?: string
  repoFullName?: string
  branch: string
  installationId?: number
}

export interface Job {
  id: string
  projectId: string
  type: JobType
  status: JobStatus
  progress: number
  baseCommitSha: string | null
  targetCommitSha: string | null
  repositoryCommits: Record<string, string>
  error: string | null
  credits: number | null
  forceReanalysis: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface DocgenTask {
  taskId: string
  status: 'pending' | 'running' | 'ready_to_publish' | 'succeeded' | 'failed'
  nodeId: string
  commitSha: string
  docId: string | null
  error: string | null
  credits: number | null
}

export interface DocgenPublication {
  taskId: string
  nodeId: string
  title: string
  markdown: string
  existingDingtalkNodeId: string | null
}

export interface GeneratedDocumentContent {
  docId: string
  title: string
  updatedAt: string
  markdown: string
}

// ---------- 图谱(契约 §4.6 / spec.md §8) ----------

export interface GraphVersion {
  versionNo: number
  commitSha: string
  repositoryCommits: Record<string, string>
  jobId: string | null
  stats: { nodeCount: number; edgeCount: number; inferredCount: number }
  artifactUrl: string
  createdAt: string
}

export interface Evidence {
  repositoryId?: string
  file: string
  startLine: number
  endLine?: number
  symbol?: string
}

export interface GraphNode {
  id: string
  name: string
  kind: NodeKind
  path: string | null
  range?: { startLine: number; endLine: number }
  domain: string
  /** 次级节点所属的顶层模块。为空时表示总览层节点。 */
  parentId?: string | null
  summary: string
  evidence: Evidence[]
  inferred: boolean
  docRefs: string[]
  repositoryId?: string
  architecture?: {
    role: 'frontend' | 'backend' | 'worker' | 'executor' | 'data' | 'shared' | 'domain' | 'external'
    importance: 'primary' | 'supporting' | 'detail'
    score?: number
    visibleByDefault: boolean
    source: 'deterministic' | 'semantic'
    rationale?: string
    memberNodeIds?: string[]
    displayGroup?: 'client' | 'local-runtime' | 'cloud-runtime' | 'shared' | 'external'
    groupLabel?: string
  }
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: EdgeType
  inferred: boolean
  evidence: Evidence[]
  repositoryId?: string
  sourceRepositoryId?: string
  targetRepositoryId?: string
}

export interface GraphView {
  id: string
  name: string
  nodeIds: string[]
  edgeIds: string[]
  steps?: { order: number; edgeId: string; label: string }[]
}

export interface GraphArtifact {
  schemaVersion: string
  projectId: string
  commitSha: string
  repositoryCommits?: Record<string, string>
  generatedAt: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  views: GraphView[]
  stats: { nodeCount: number; edgeCount: number; inferredCount: number }
  architectureProjection?: {
    version: '1.0' | '2.0'
    visibleNodeCount: number
    visibleModuleCount: number
    hiddenDetailCount: number
    sourceNodeCount?: number
    sourceEdgeCount?: number
    detailNodeCount?: number
  }
}

// ---------- 文档与批注(契约 §4.7 / §4.8) ----------

export interface DocumentLink {
  id: string
  scope: DocScope
  nodeId: string | null
  title: string
  url: string
  docType: DocType
  status: DocStatus
  updatedBy: { id: string; name: string }
  createdAt: string
  updatedAt: string
}

export interface Annotation {
  id: string
  targetKind: AnnotationTargetKind
  targetId: string
  body: string
  author: { id: string; name: string }
  resolved: boolean
  createdAt: string
  updatedAt: string
}

// ---------- 工程知识资产 ----------

export interface KnowledgeAssetEntry {
  id: string
  title: string
  path: string
  mediaType: string
  size: number | null
}

export interface KnowledgeAssetSummary {
  id: string
  projectId: string
  kind: KnowledgeAssetKind
  status: KnowledgeAssetStatus
  version: number | null
  versionId: string | null
  sourceGraphVersionId: string | null
  sourceGraphVersionNo: number | null
  sourceCommitSha: string | null
  repositoryCommits: Record<string, string>
  entries: KnowledgeAssetEntry[]
  downloadUrl: string | null
  error: string | null
  updatedAt: string
}

export interface KnowledgeRun {
  id: string
  projectId: string
  graphVersionId: string
  graphVersionNo: number
  requestedAssets: KnowledgeAssetKind[]
  status: KnowledgeRunStatus
  progress: number
  stage: string | null
  note: string | null
  outputVersionIds: string[]
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface SkillLabRun {
  id: string
  projectId: string
  inputSkillVersionId: string
  baselineVersionId: string | null
  outputSkillVersionId: string | null
  status: SkillLabRunStatus
  progress: number
  stage: string | null
  note: string | null
  evaluationDatasetRef: string
  optimizationPolicy: Record<string, unknown>
  scores: Record<string, unknown>
  reportUrl: string | null
  diffUrl: string | null
  decision: 'accepted' | 'rejected' | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

// ---------- Chat 流(契约 §6) ----------

export type ChatEvent =
  | { type: 'chat.meta'; sessionId: string }
  | {
      type: 'chat.status'
      stage: 'queued' | 'preparing_source' | 'cache_hit' | 'reading_source' | 'finalizing' | 'fallback'
      note: string
    }
  | { type: 'chat.delta'; text: string }
  | { type: 'chat.evidence'; items: Evidence[] }
  | { type: 'chat.action'; action: 'highlight'; nodeIds: string[]; edgeIds: string[] }
  | { type: 'chat.done'; sessionId: string; credits: number; inferred: boolean; provider: 'qoder' | 'rules' }
  | { type: 'chat.error'; code: string; message: string }

export interface ProjectEvent {
  id: number
  type:
    | 'repository.push.received'
    | 'job.created' | 'job.progress' | 'job.succeeded' | 'job.failed'
    | 'graph.version.switched'
    | 'document.created' | 'document.updated' | 'document.deleted' | 'document.publication.ready'
    | 'annotation.created' | 'annotation.updated' | 'annotation.deleted'
    | 'knowledge.run.updated' | 'knowledge.asset.published'
    | 'skilllab.run.updated' | 'skill.version.published'
    | 'member.joined'
  data: unknown
}
