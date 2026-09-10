import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EvidenceEdge,
  EvidenceNode,
  PendingLink,
  RawRecord,
  RepositorySource,
  SyncCheckpoint,
  SyncRun,
} from "../domain/types.js";
import { MemoryEvidenceStore, type PersistedState } from "./memoryStore.js";

export class FileEvidenceStore extends MemoryEvidenceStore {
  private readonly statePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    super();
    this.statePath = join(dataDir, "store.json");
  }

  override async initialize(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      const content = await readFile(this.statePath, "utf8");
      this.importState(JSON.parse(content) as Partial<PersistedState>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  override async close(): Promise<void> {
    await this.writeChain;
  }

  override async createSource(source: RepositorySource): Promise<RepositorySource> {
    const result = await super.createSource(source);
    await this.persist();
    return result;
  }

  override async updateSource(source: RepositorySource): Promise<void> {
    await super.updateSource(source);
    await this.persist();
  }

  override async createSyncRun(run: SyncRun): Promise<SyncRun> {
    const result = await super.createSyncRun(run);
    await this.persist();
    return result;
  }

  override async updateSyncRun(run: SyncRun): Promise<void> {
    await super.updateSyncRun(run);
    await this.persist();
  }

  override async upsertRawRecords(records: RawRecord[]): Promise<void> {
    await super.upsertRawRecords(records);
    await this.persist();
  }

  override async upsertNodes(nodes: EvidenceNode[]): Promise<void> {
    await super.upsertNodes(nodes);
    await this.persist();
  }

  override async upsertEdges(edges: EvidenceEdge[]): Promise<void> {
    await super.upsertEdges(edges);
    await this.persist();
  }

  override async replacePendingLinks(repositoryId: string, links: PendingLink[]): Promise<void> {
    await super.replacePendingLinks(repositoryId, links);
    await this.persist();
  }

  override async putCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
    await super.putCheckpoint(checkpoint);
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const tempPath = `${this.statePath}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(this.exportState(), null, 2)}\n`, "utf8");
      await rename(tempPath, this.statePath);
    });
    await this.writeChain;
  }
}
