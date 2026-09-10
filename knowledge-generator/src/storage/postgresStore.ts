import pg from "pg";
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

const { Pool } = pg;

export class PostgresEvidenceStore implements EvidenceStore {
  private readonly pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createSource(source: RepositorySource): Promise<RepositorySource> {
    await this.pool.query(
      `insert into knowledge_generator.repository_sources (id, project_id, repository_id, payload)
       values ($1, $2, $3, $4::jsonb)`,
      [source.id, source.projectId, source.repositoryId ?? null, JSON.stringify(source)],
    );
    return structuredClone(source);
  }

  async getSource(sourceId: string): Promise<RepositorySource | undefined> {
    return this.getPayload<RepositorySource>(
      "select payload from knowledge_generator.repository_sources where id = $1",
      [sourceId],
    );
  }

  async listSources(): Promise<RepositorySource[]> {
    return this.listPayloads<RepositorySource>(
      "select payload from knowledge_generator.repository_sources order by created_at",
      [],
    );
  }

  async updateSource(source: RepositorySource): Promise<void> {
    await this.pool.query(
      `update knowledge_generator.repository_sources
       set repository_id = $2, payload = $3::jsonb, updated_at = now()
       where id = $1`,
      [source.id, source.repositoryId ?? null, JSON.stringify(source)],
    );
  }

  async createSyncRun(run: SyncRun): Promise<SyncRun> {
    await this.pool.query(
      `insert into knowledge_generator.sync_runs (id, source_id, status, payload)
       values ($1, $2, $3, $4::jsonb)`,
      [run.id, run.sourceId, run.status, JSON.stringify(run)],
    );
    return structuredClone(run);
  }

  async getSyncRun(runId: string): Promise<SyncRun | undefined> {
    return this.getPayload<SyncRun>("select payload from knowledge_generator.sync_runs where id = $1", [runId]);
  }

  async updateSyncRun(run: SyncRun): Promise<void> {
    await this.pool.query(
      `update knowledge_generator.sync_runs set status = $2, payload = $3::jsonb, updated_at = now() where id = $1`,
      [run.id, run.status, JSON.stringify(run)],
    );
  }

  async upsertRawRecords(records: RawRecord[]): Promise<void> {
    await this.batch(records, async (record) => {
      await this.pool.query(
        `insert into knowledge_generator.raw_records
           (id, repository_id, resource_type, external_id, checksum, payload)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (id) do nothing`,
        [record.id, record.repositoryId, record.resourceType, record.externalId, record.checksum, JSON.stringify(record)],
      );
    });
  }

  async upsertNodes(nodes: EvidenceNode[]): Promise<void> {
    await this.batch(nodes, async (node) => {
      await this.pool.query(
        `insert into knowledge_generator.evidence_nodes
           (id, repository_id, kind, external_id, checksum, payload)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (id) do update set
           checksum = excluded.checksum,
           payload = excluded.payload,
           updated_at = now()`,
        [node.id, node.repositoryId, node.kind, node.externalId, node.checksum, JSON.stringify(node)],
      );
    });
  }

  async upsertEdges(edges: EvidenceEdge[]): Promise<void> {
    await this.batch(edges, async (edge) => {
      await this.pool.query(
        `insert into knowledge_generator.evidence_edges
           (id, repository_id, from_id, to_id, relation_type, payload)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (id) do update set payload = excluded.payload`,
        [edge.id, edge.repositoryId, edge.fromId, edge.toId, edge.relationType, JSON.stringify(edge)],
      );
    });
  }

  async replacePendingLinks(repositoryId: string, links: PendingLink[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from knowledge_generator.pending_links where repository_id = $1", [repositoryId]);
      for (const link of links) {
        await client.query(
          `insert into knowledge_generator.pending_links
             (id, repository_id, from_id, expected_to_id, relation_type, payload)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [link.id, link.repositoryId, link.fromId, link.expectedToId, link.relationType, JSON.stringify(link)],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRawRecords(repositoryId: string): Promise<RawRecord[]> {
    return this.listPayloads<RawRecord>(
      "select payload from knowledge_generator.raw_records where repository_id = $1 order by id",
      [repositoryId],
    );
  }

  async listNodes(repositoryId: string): Promise<EvidenceNode[]> {
    return this.listPayloads<EvidenceNode>(
      "select payload from knowledge_generator.evidence_nodes where repository_id = $1 order by id",
      [repositoryId],
    );
  }

  async listEdges(repositoryId: string): Promise<EvidenceEdge[]> {
    return this.listPayloads<EvidenceEdge>(
      "select payload from knowledge_generator.evidence_edges where repository_id = $1 order by id",
      [repositoryId],
    );
  }

  async listPendingLinks(repositoryId: string): Promise<PendingLink[]> {
    return this.listPayloads<PendingLink>(
      "select payload from knowledge_generator.pending_links where repository_id = $1 order by id",
      [repositoryId],
    );
  }

  async putCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
    await this.pool.query(
      `insert into knowledge_generator.sync_checkpoints (source_id, resource_type, payload)
       values ($1, $2, $3::jsonb)
       on conflict (source_id, resource_type) do update set payload = excluded.payload, updated_at = now()`,
      [checkpoint.sourceId, checkpoint.resourceType, JSON.stringify(checkpoint)],
    );
  }

  async getCheckpoint(sourceId: string, resourceType: string): Promise<SyncCheckpoint | undefined> {
    return this.getPayload<SyncCheckpoint>(
      `select payload from knowledge_generator.sync_checkpoints
       where source_id = $1 and resource_type = $2`,
      [sourceId, resourceType],
    );
  }

  private async getPayload<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    const result = await this.pool.query<{ payload: T }>(sql, params);
    return result.rows[0]?.payload;
  }

  private async listPayloads<T>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await this.pool.query<{ payload: T }>(sql, params);
    return result.rows.map((row) => row.payload);
  }

  private async batch<T>(items: T[], operation: (item: T) => Promise<void>): Promise<void> {
    for (const item of items) await operation(item);
  }
}
