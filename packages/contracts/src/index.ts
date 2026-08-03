export type ISODateString = string;

export type EntityCategory = "code" | "runtime" | "data" | "external";
export type HealthState = "healthy" | "warning" | "error" | "offline" | "unknown";
export type EventSeverity = "info" | "warning" | "error";

export type SourceEvidence = {
  file: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  excerpt?: string;
};

export type GraphEntity = {
  id: string;
  projectId: string;
  category: EntityCategory;
  kind: string;
  name: string;
  summary: string;
  status: HealthState;
  path?: string;
  language?: string;
  layer?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  evidence: SourceEvidence[];
  position?: { x: number; y: number };
};

export type GraphRelation = {
  id: string;
  projectId: string;
  source: string;
  target: string;
  type: string;
  label: string;
  status: HealthState;
  directed: boolean;
  generated: boolean;
  metadata: Record<string, unknown>;
  evidence: SourceEvidence[];
};

export type ExecutionFlow = {
  id: string;
  name: string;
  summary: string;
  entryPoint: string;
  featured?: boolean;
  entityIds: string[];
  relationIds: string[];
  lanes: string[];
};

export type Project = {
  id: string;
  cloudProjectId?: string;
  name: string;
  description: string;
  repoPath: string;
  branch?: string;
  commit?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  latestGraphVersionId?: string;
  nodeCount: number;
  edgeCount: number;
};

export type GraphVersion = {
  id: string;
  projectId: string;
  source: "scanner" | "scanner+codex" | "understand-anything" | "import";
  branch?: string;
  commit?: string;
  createdAt: ISODateString;
  entities: GraphEntity[];
  relations: GraphRelation[];
  executionFlows?: ExecutionFlow[];
};

export type SanitizedSourceEvidence = Omit<SourceEvidence, "excerpt">;
export type SanitizedGraphEntity = Omit<GraphEntity, "projectId" | "evidence"> & {
  evidence: SanitizedSourceEvidence[];
};
export type SanitizedGraphRelation = Omit<
  GraphRelation,
  "projectId" | "evidence"
> & {
  evidence: SanitizedSourceEvidence[];
};

export type SanitizedGraphArtifact = {
  schemaVersion: "1.0";
  project: { id: string; name: string };
  source: { branch: string; commit: string; generatedAt: ISODateString };
  graph: {
    entities: SanitizedGraphEntity[];
    relations: SanitizedGraphRelation[];
    executionFlows: ExecutionFlow[];
  };
};

export type CloudRole = "owner" | "editor" | "viewer";

export type CloudUser = {
  id: string;
  email: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt: ISODateString;
};

export type CloudSession = {
  user: CloudUser;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: ISODateString;
  refreshExpiresAt: ISODateString;
};

export type CloudProject = {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  repositoryFingerprint?: string;
  defaultBranch: string;
  currentGraphVersionId?: string;
  role: CloudRole;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type CloudProjectMember = {
  projectId: string;
  userId: string;
  role: CloudRole;
  email: string;
  displayName: string;
  joinedAt: ISODateString;
  updatedAt: ISODateString;
};

export type CloudProjectInvite = {
  id: string;
  projectId: string;
  role: Exclude<CloudRole, "owner">;
  maxUses: number;
  useCount: number;
  expiresAt: ISODateString;
  revokedAt?: ISODateString;
  createdAt: ISODateString;
  token?: string;
};

export type CloudGraphVersion = {
  id: string;
  projectId: string;
  parentVersionId?: string;
  source: "local-agent" | "shared-draft" | "import";
  branch: string;
  commit: string;
  status: "uploading" | "validating" | "ready" | "active" | "failed" | "archived";
  checksum: string;
  artifactUri?: string;
  engineVersion?: string;
  skillVersion?: string;
  createdBy: string;
  createdAt: ISODateString;
  activatedAt?: ISODateString;
  artifact?: SanitizedGraphArtifact;
};

export type CloudDocument = {
  id: string;
  projectId: string;
  stableEntityId?: string;
  scope: "global" | "module";
  provider: "link" | "dingtalk" | "local";
  externalId?: string;
  title: string;
  url: string;
  summary: string;
  syncStatus: "linked" | "synced" | "stale" | "error";
  version: number;
  createdBy: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type CloudAnnotation = {
  id: string;
  projectId: string;
  stableEntityId: string;
  author: string;
  body: string;
  version: number;
  createdBy: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
};

export type CloudRealtimeEvent = {
  sequence: number;
  projectId: string;
  type:
    | "project.member.joined"
    | "project.member.updated"
    | "project.member.removed"
    | "graph.version.ready"
    | "graph.version.activated"
    | "document.created"
    | "document.updated"
    | "document.deleted"
    | "annotation.created"
    | "annotation.updated"
    | "annotation.deleted";
  payload: Record<string, unknown>;
  actorId?: string;
  createdAt: ISODateString;
};

export type AnalysisPhase =
  | "queued"
  | "ua_preflight"
  | "ua_scan"
  | "facts_ready"
  | "ua_analyze"
  | "enriching"
  | "ua_review"
  | "ua_architecture"
  | "architecture_ready"
  | "ua_tour"
  | "ua_validate"
  | "ua_save"
  // Retained so older analysis jobs already stored in SQLite still render.
  | "inventory"
  | "facts"
  | "codex"
  | "validate"
  | "publish"
  | "completed"
  | "failed";

export type AnalysisJob = {
  id: string;
  projectId: string;
  status: "running" | "completed" | "failed";
  phase: AnalysisPhase;
  progress: number;
  message: string;
  useCodex: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  error?: string;
};

export type AnalysisEvent = {
  id: string;
  jobId: string;
  projectId: string;
  phase: AnalysisPhase;
  progress: number;
  message: string;
  createdAt: ISODateString;
};

export type Annotation = {
  id: string;
  projectId: string;
  entityId: string;
  author: string;
  body: string;
  createdAt: ISODateString;
};

export const PROJECT_DOCUMENT_OWNER_PREFIX = "project-documents:";

export function projectDocumentOwnerId(projectId: string) {
  return `${PROJECT_DOCUMENT_OWNER_PREFIX}${projectId}`;
}

export type DocumentBinding = {
  id: string;
  projectId: string;
  entityId: string;
  provider: "link" | "dingtalk" | "local";
  externalId?: string;
  title: string;
  url: string;
  summary: string;
  syncStatus: "linked" | "synced" | "stale" | "error";
  updatedAt: ISODateString;
};

export type DocumentGenerationProgress = {
  phase: "context" | "analysis" | "publish" | "bind";
  label: string;
  detail?: string;
  current: number;
  total: number;
};

export type DocumentGenerationCompletion = {
  document: DocumentBinding;
  title: string;
  summary: string;
  provider: "dingtalk";
};

export type DocumentRefreshProgress = {
  phase: "context" | "read" | "analysis" | "publish";
  label: string;
  detail?: string;
  current: number;
  total: number;
};

export type DocumentRefreshCompletion = {
  documents: DocumentBinding[];
  checkedDocuments: number;
  updatedDocuments: number;
  unchangedDocuments: number;
};

export type ProjectAutomationSettings = {
  projectId: string;
  debugMode: boolean;
  branch?: string;
  currentCommit?: string;
  observedCommit?: string;
  processedCommit?: string;
  status: "idle" | "watching" | "running" | "error";
  message: string;
  updatedAt: ISODateString;
};

export type EntityScope = {
  id: string;
  name: string;
  path?: string;
  summary?: string;
  entityIds: string[];
};

export type EntityContext = {
  entity: GraphEntity;
  incoming: GraphRelation[];
  outgoing: GraphRelation[];
  internal?: GraphRelation[];
  members?: GraphEntity[];
  annotations: Annotation[];
  documents: DocumentBinding[];
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  provider: "codex" | "local-fallback";
  citations: SourceEvidence[];
  createdAt: ISODateString;
};

export type ChatAnswer = {
  conclusion: string;
  purpose: string;
  callChain: string[];
  facts: string[];
  inferences: string[];
  notes: string[];
  citations: SourceEvidence[];
};

export type ChatProgress = {
  phase: "context" | "evidence" | "analysis" | "format";
  label: string;
  detail?: string;
  current: number;
  total: number;
};

export type ChatCompletion = {
  conversationId: string;
  message: ChatMessage;
  answer: ChatAnswer;
};

export type RuntimeEvent = {
  id: string;
  provider: string;
  entityId?: string;
  relationId?: string;
  type: string;
  severity: EventSeverity;
  title: string;
  detail: string;
  observedAt: ISODateString;
  metadata: Record<string, unknown>;
};

export type RuntimeTopology = {
  provider: string;
  mocked: boolean;
  generatedAt: ISODateString;
  entities: GraphEntity[];
  relations: GraphRelation[];
  metrics: Record<string, number>;
};

export type RuntimePlugin = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  mocked: boolean;
  capabilities: string[];
};
