import type {
  EvidenceEdge,
  EvidenceNode,
  PendingLink,
  RawRecord,
  RepositorySource,
  SyncCheckpoint,
  SyncRun,
} from "../domain/types.js";
import type { EvidenceStore } from "./store.js";

export class MemoryEvidenceStore implements EvidenceStore {
  protected readonly sources = new Map<string, RepositorySource>();
  protected readonly syncRuns = new Map<string, SyncRun>();
  protected readonly rawRecords = new Map<string, RawRecord>();
  protected readonly nodes = new Map<string, EvidenceNode>();
  protected readonly edges = new Map<string, EvidenceEdge>();
  protected readonly pendingLinks = new Map<string, PendingLink>();
  protected readonly checkpoints = new Map<string, SyncCheckpoint>();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async createSource(source: RepositorySource): Promise<RepositorySource> {
    this.sources.set(source.id, structuredClone(source));
    return structuredClone(source);
  }

  async getSource(sourceId: string): Promise<RepositorySource | undefined> {
    return cloneOptional(this.sources.get(sourceId));
  }

  async listSources(): Promise<RepositorySource[]> {
    return [...this.sources.values()]
      .map((source) => structuredClone(source))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateSource(source: RepositorySource): Promise<void> {
    this.sources.set(source.id, structuredClone(source));
  }

  async createSyncRun(run: SyncRun): Promise<SyncRun> {
    this.syncRuns.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async getSyncRun(runId: string): Promise<SyncRun | undefined> {
    return cloneOptional(this.syncRuns.get(runId));
  }

  async updateSyncRun(run: SyncRun): Promise<void> {
    this.syncRuns.set(run.id, structuredClone(run));
  }

  async upsertRawRecords(records: RawRecord[]): Promise<void> {
    for (const record of records) this.rawRecords.set(record.id, structuredClone(record));
  }

  async upsertNodes(nodes: EvidenceNode[]): Promise<void> {
    for (const node of nodes) this.nodes.set(node.id, structuredClone(node));
  }

  async upsertEdges(edges: EvidenceEdge[]): Promise<void> {
    for (const edge of edges) this.edges.set(edge.id, structuredClone(edge));
  }

  async replacePendingLinks(repositoryId: string, links: PendingLink[]): Promise<void> {
    for (const [id, link] of this.pendingLinks) {
      if (link.repositoryId === repositoryId) this.pendingLinks.delete(id);
    }
    for (const link of links) this.pendingLinks.set(link.id, structuredClone(link));
  }

  async listRawRecords(repositoryId: string): Promise<RawRecord[]> {
    return valuesForRepository(this.rawRecords, repositoryId);
  }

  async listNodes(repositoryId: string): Promise<EvidenceNode[]> {
    return valuesForRepository(this.nodes, repositoryId);
  }

  async listEdges(repositoryId: string): Promise<EvidenceEdge[]> {
    return valuesForRepository(this.edges, repositoryId);
  }

  async listPendingLinks(repositoryId: string): Promise<PendingLink[]> {
    return valuesForRepository(this.pendingLinks, repositoryId);
  }

  async putCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
    this.checkpoints.set(checkpointKey(checkpoint.sourceId, checkpoint.resourceType), structuredClone(checkpoint));
  }

  async getCheckpoint(sourceId: string, resourceType: string): Promise<SyncCheckpoint | undefined> {
    return cloneOptional(this.checkpoints.get(checkpointKey(sourceId, resourceType)));
  }

  protected exportState(): PersistedState {
    return {
      sources: [...this.sources.values()],
      syncRuns: [...this.syncRuns.values()],
      rawRecords: [...this.rawRecords.values()],
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      pendingLinks: [...this.pendingLinks.values()],
      checkpoints: [...this.checkpoints.values()],
    };
  }

  protected importState(state: Partial<PersistedState>): void {
    replaceMap(this.sources, state.sources ?? []);
    replaceMap(this.syncRuns, state.syncRuns ?? []);
    replaceMap(this.rawRecords, state.rawRecords ?? []);
    replaceMap(this.nodes, state.nodes ?? []);
    replaceMap(this.edges, state.edges ?? []);
    replaceMap(this.pendingLinks, state.pendingLinks ?? []);
    this.checkpoints.clear();
    for (const checkpoint of state.checkpoints ?? []) {
      this.checkpoints.set(checkpointKey(checkpoint.sourceId, checkpoint.resourceType), structuredClone(checkpoint));
    }
  }
}

export interface PersistedState {
  sources: RepositorySource[];
  syncRuns: SyncRun[];
  rawRecords: RawRecord[];
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
  pendingLinks: PendingLink[];
  checkpoints: SyncCheckpoint[];
}

function valuesForRepository<T extends { repositoryId: string }>(map: Map<string, T>, repositoryId: string): T[] {
  return [...map.values()]
    .filter((value) => value.repositoryId === repositoryId)
    .map((value) => structuredClone(value))
    .sort((a, b) => ("id" in a && "id" in b ? String(a.id).localeCompare(String(b.id)) : 0));
}

function replaceMap<T extends { id: string }>(map: Map<string, T>, values: T[]): void {
  map.clear();
  for (const value of values) map.set(value.id, structuredClone(value));
}

function checkpointKey(sourceId: string, resourceType: string): string {
  return `${sourceId}:${resourceType}`;
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
