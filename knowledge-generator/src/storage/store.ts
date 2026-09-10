import type {
  EvidenceEdge,
  EvidenceNode,
  PendingLink,
  RawRecord,
  RepositorySource,
  SyncCheckpoint,
  SyncRun,
} from "../domain/types.js";

export interface EvidenceStore {
  initialize(): Promise<void>;
  close(): Promise<void>;

  createSource(source: RepositorySource): Promise<RepositorySource>;
  getSource(sourceId: string): Promise<RepositorySource | undefined>;
  listSources(): Promise<RepositorySource[]>;
  updateSource(source: RepositorySource): Promise<void>;

  createSyncRun(run: SyncRun): Promise<SyncRun>;
  getSyncRun(runId: string): Promise<SyncRun | undefined>;
  updateSyncRun(run: SyncRun): Promise<void>;

  upsertRawRecords(records: RawRecord[]): Promise<void>;
  upsertNodes(nodes: EvidenceNode[]): Promise<void>;
  upsertEdges(edges: EvidenceEdge[]): Promise<void>;
  replacePendingLinks(repositoryId: string, links: PendingLink[]): Promise<void>;

  listRawRecords(repositoryId: string): Promise<RawRecord[]>;
  listNodes(repositoryId: string): Promise<EvidenceNode[]>;
  listEdges(repositoryId: string): Promise<EvidenceEdge[]>;
  listPendingLinks(repositoryId: string): Promise<PendingLink[]>;

  putCheckpoint(checkpoint: SyncCheckpoint): Promise<void>;
  getCheckpoint(sourceId: string, resourceType: string): Promise<SyncCheckpoint | undefined>;
}
