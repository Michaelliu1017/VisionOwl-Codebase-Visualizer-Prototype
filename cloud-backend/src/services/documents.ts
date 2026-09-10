/**
 * Document Service（契约 §4.7 / spec §4.5）
 * - 全局/模块文档 CRUD + 历史版本
 * - 代码变化联动：impact 里的模块 → 相关文档标 maybe_stale
 * - AI 文档保留 OSS 快照，并可绑定真实钉钉文档 node
 */
import { query, queryOne, withTx } from "../infra/pg";
import { notFound } from "../lib/errors";
import { isoReq } from "../lib/time";
import { sseHub } from "../realtime/sseHub";
import type { DocScope, DocStatus, DocType, DocumentDto, DocumentRevisionDto } from "../types";
import { audit } from "./audit";

interface DocRow {
  id: string;
  project_id: string;
  scope: string;
  node_id: string | null;
  title: string;
  url: string;
  doc_type: string;
  status: string;
  generated_by_ai: boolean;
  artifact_oss_key: string | null;
  dingtalk_connection_id: string | null;
  dingtalk_node_id: string | null;
  sync_error: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const DOC_SELECT = `
  SELECT d.id, d.project_id, d.scope, d.node_id, d.title, d.url, d.doc_type, d.status,
         d.generated_by_ai, d.artifact_oss_key, d.dingtalk_connection_id, d.dingtalk_node_id,
         d.sync_error,
         d.updated_by, u.name AS updated_by_name, d.created_at, d.updated_at
    FROM document_links d
    LEFT JOIN users u ON u.id = d.updated_by
`;

function toDto(row: DocRow): DocumentDto {
  return {
    id: row.id,
    scope: row.scope as DocScope,
    nodeId: row.node_id,
    title: row.title,
    url: row.url,
    docType: row.doc_type as DocType,
    status: row.status as DocStatus,
    updatedBy: row.updated_by ? { id: row.updated_by, name: row.updated_by_name ?? "" } : null,
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
  };
}

export async function listDocuments(
  projectId: string,
  filter: { scope?: DocScope; nodeId?: string },
): Promise<DocumentDto[]> {
  const params: unknown[] = [projectId];
  let where = `d.project_id = $1`;
  if (filter.scope) {
    params.push(filter.scope);
    where += ` AND d.scope = $${params.length}`;
  }
  if (filter.nodeId) {
    params.push(filter.nodeId);
    where += ` AND d.node_id = $${params.length}`;
  }
  const rows = await query<DocRow>(
    `${DOC_SELECT} WHERE ${where} ORDER BY d.scope, d.created_at DESC`,
    params,
  );
  return rows.map(toDto);
}

export async function getDocument(projectId: string, docId: string): Promise<DocumentDto> {
  const row = await queryOne<DocRow>(`${DOC_SELECT} WHERE d.project_id = $1 AND d.id = $2`, [
    projectId,
    docId,
  ]);
  if (!row) throw notFound("文档不存在");
  return toDto(row);
}

export async function createDocument(
  projectId: string,
  actorId: string,
  input: { scope: DocScope; nodeId?: string; title: string; url: string; docType: DocType },
  ip?: string | null,
): Promise<DocumentDto> {
  const rows = await query<{ id: string }>(
    `INSERT INTO document_links (project_id, scope, node_id, title, url, doc_type, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      projectId,
      input.scope,
      input.scope === "module" ? (input.nodeId ?? null) : null,
      input.title,
      input.url,
      input.docType,
      actorId,
    ],
  );
  const dto = await getDocument(projectId, rows[0]!.id);
  sseHub.emitAsync(projectId, "document.created", dto);
  await audit({
    projectId,
    actorId,
    action: "document.created",
    targetType: "document",
    targetId: dto.id,
    detail: { scope: dto.scope, nodeId: dto.nodeId },
    ip,
  });
  return dto;
}

export async function patchDocument(
  projectId: string,
  docId: string,
  actorId: string,
  patch: { title?: string; url?: string; status?: DocStatus; changeNote?: string },
  ip?: string | null,
): Promise<DocumentDto> {
  const before = await getDocument(projectId, docId);

  await withTx(async (client) => {
    // 先留一份旧版本快照（支持查看差异与回滚）
    await client.query(
      `INSERT INTO document_revisions (document_id, snapshot, change_note, created_by)
       VALUES ($1, $2::jsonb, $3, $4)`,
      [
        docId,
        JSON.stringify({ title: before.title, url: before.url, status: before.status }),
        patch.changeNote ?? null,
        actorId,
      ],
    );

    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) {
      params.push(patch.title);
      sets.push(`title = $${params.length}`);
    }
    if (patch.url !== undefined) {
      params.push(patch.url);
      sets.push(`url = $${params.length}`);
    }
    if (patch.status !== undefined) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
    }
    params.push(actorId);
    sets.push(`updated_by = $${params.length}`);
    params.push(docId, projectId);
    await client.query(
      `UPDATE document_links SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${params.length - 1} AND project_id = $${params.length}`,
      params,
    );
  });

  const dto = await getDocument(projectId, docId);
  sseHub.emitAsync(projectId, "document.updated", dto);
  await audit({
    projectId,
    actorId,
    action: "document.updated",
    targetType: "document",
    targetId: docId,
    detail: { changed: Object.keys(patch) },
    ip,
  });
  return dto;
}

export async function deleteDocument(
  projectId: string,
  docId: string,
  actorId: string,
  ip?: string | null,
): Promise<void> {
  const rows = await query<{ id: string }>(
    `DELETE FROM document_links WHERE id = $1 AND project_id = $2 RETURNING id`,
    [docId, projectId],
  );
  if (rows.length === 0) throw notFound("文档不存在");
  sseHub.emitAsync(projectId, "document.deleted", { id: docId });
  await audit({
    projectId,
    actorId,
    action: "document.deleted",
    targetType: "document",
    targetId: docId,
    ip,
  });
}

export async function listRevisions(
  projectId: string,
  docId: string,
): Promise<DocumentRevisionDto[]> {
  await getDocument(projectId, docId); // 确保归属该项目
  const rows = await query<{
    id: string;
    change_note: string | null;
    created_by: string | null;
    created_by_name: string | null;
    created_at: Date;
  }>(
    `SELECT r.id, r.change_note, r.created_by, u.name AS created_by_name, r.created_at
       FROM document_revisions r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.document_id = $1 ORDER BY r.created_at DESC`,
    [docId],
  );
  return rows.map((r) => ({
    id: r.id,
    changeNote: r.change_note,
    createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? "" } : null,
    createdAt: isoReq(r.created_at),
  }));
}

export async function listGeneratedModuleDocuments(
  projectId: string,
  nodeIds: string[],
): Promise<Array<{ id: string; nodeId: string; connectionId: string | null; dingtalkNodeId: string | null }>> {
  if (nodeIds.length === 0) return [];
  return query<{ id: string; nodeId: string; connectionId: string | null; dingtalkNodeId: string | null }>(
    `SELECT id, node_id AS "nodeId", dingtalk_connection_id AS "connectionId",
            dingtalk_node_id AS "dingtalkNodeId"
       FROM document_links
      WHERE project_id = $1 AND generated_by_ai = true AND scope = 'module'
        AND node_id = ANY($2::text[])`,
    [projectId, nodeIds],
  );
}

export interface GeneratedDocumentTarget {
  id: string;
  connectionId: string | null;
  dingtalkNodeId: string | null;
  artifactKey: string | null;
  url: string;
}

export async function findGeneratedDocumentTarget(
  projectId: string,
  nodeId: string | null,
): Promise<GeneratedDocumentTarget | null> {
  return queryOne<GeneratedDocumentTarget>(
    nodeId
      ? `SELECT id, dingtalk_connection_id AS "connectionId", dingtalk_node_id AS "dingtalkNodeId",
                artifact_oss_key AS "artifactKey", url
           FROM document_links
          WHERE project_id = $1 AND generated_by_ai = true AND scope = 'module' AND node_id = $2`
      : `SELECT id, dingtalk_connection_id AS "connectionId", dingtalk_node_id AS "dingtalkNodeId",
                artifact_oss_key AS "artifactKey", url
           FROM document_links
          WHERE project_id = $1 AND generated_by_ai = true AND scope = 'global' AND node_id IS NULL`,
    nodeId ? [projectId, nodeId] : [projectId],
  );
}

export async function upsertGeneratedDoc(
  projectId: string,
  input: {
    scope: DocScope;
    nodeId: string | null;
    title: string;
    url: string;
    docType?: DocType;
    artifactKey?: string | null;
    dingtalkConnectionId?: string | null;
    dingtalkNodeId?: string | null;
    syncError?: string | null;
  },
  actorId: string | null,
): Promise<DocumentDto> {
  const existing = await queryOne<{ id: string }>(
    input.nodeId
      ? `SELECT id FROM document_links
          WHERE project_id = $1 AND generated_by_ai = true AND scope = $2 AND node_id = $3`
      : `SELECT id FROM document_links
          WHERE project_id = $1 AND generated_by_ai = true AND scope = $2 AND node_id IS NULL`,
    input.nodeId ? [projectId, input.scope, input.nodeId] : [projectId, input.scope],
  );
  const docType = input.docType ?? "generated";
  const status: DocStatus = input.syncError ? "sync_failed" : "ok";

  let id: string;
  if (existing) {
    const before = await getDocument(projectId, existing.id);
    await withTx(async (client) => {
      await client.query(
        `INSERT INTO document_revisions (document_id, snapshot, change_note, created_by)
         VALUES ($1, $2::jsonb, $3, $4)`,
        [
          existing.id,
          JSON.stringify({ title: before.title, url: before.url, status: before.status }),
          "AI generated document refresh",
          actorId,
        ],
      );
      await client.query(
        `UPDATE document_links
            SET title = $2, url = $3, doc_type = $4, status = $5, last_synced_at = now(),
                updated_by = $6, generated_by_ai = true, artifact_oss_key = $7,
                dingtalk_connection_id = $8, dingtalk_node_id = $9, sync_error = $10,
                updated_at = now()
          WHERE id = $1`,
        [
          existing.id,
          input.title,
          input.url,
          docType,
          status,
          actorId,
          input.artifactKey ?? null,
          input.dingtalkConnectionId ?? null,
          input.dingtalkNodeId ?? null,
          input.syncError ?? null,
        ],
      );
    });
    id = existing.id;
  } else {
    const rows = await query<{ id: string }>(
      `INSERT INTO document_links
         (project_id, scope, node_id, title, url, doc_type, status, last_synced_at, updated_by,
          generated_by_ai, artifact_oss_key, dingtalk_connection_id, dingtalk_node_id, sync_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, true, $9, $10, $11, $12)
       RETURNING id`,
      [
        projectId,
        input.scope,
        input.nodeId,
        input.title,
        input.url,
        docType,
        status,
        actorId,
        input.artifactKey ?? null,
        input.dingtalkConnectionId ?? null,
        input.dingtalkNodeId ?? null,
        input.syncError ?? null,
      ],
    );
    id = rows[0]!.id;
  }

  const dto = await getDocument(projectId, id);
  sseHub.emitAsync(projectId, existing ? "document.updated" : "document.created", dto);
  return dto;
}

export async function markGeneratedDocumentSyncFailed(
  projectId: string,
  nodeId: string | null,
  message: string,
): Promise<void> {
  await query(
    nodeId
      ? `UPDATE document_links SET status = 'sync_failed', sync_error = $3, updated_at = now()
          WHERE project_id = $1 AND generated_by_ai = true AND node_id = $2`
      : `UPDATE document_links SET status = 'sync_failed', sync_error = $2, updated_at = now()
          WHERE project_id = $1 AND generated_by_ai = true AND scope = 'global' AND node_id IS NULL`,
    nodeId ? [projectId, nodeId, message.slice(0, 500)] : [projectId, message.slice(0, 500)],
  );
}

/**
 * 增量分析联动（spec §4.5、§11.2-6）
 * 受影响模块的文档 → maybe_stale；全局结构变化 → 全局文档也标记。
 * 返回被标记的文档 id 列表。
 */
export async function markStaleByImpact(
  projectId: string,
  affectedNodeIds: string[],
  globalStructureChanged: boolean,
): Promise<string[]> {
  const marked: string[] = [];

  if (affectedNodeIds.length > 0) {
    const rows = await query<{ id: string }>(
      `UPDATE document_links SET status = 'maybe_stale', updated_at = now()
        WHERE project_id = $1 AND scope = 'module' AND node_id = ANY($2::text[]) AND status = 'ok'
        RETURNING id`,
      [projectId, affectedNodeIds],
    );
    marked.push(...rows.map((r) => r.id));
  }

  if (globalStructureChanged) {
    const rows = await query<{ id: string }>(
      `UPDATE document_links SET status = 'maybe_stale', updated_at = now()
        WHERE project_id = $1 AND scope = 'global' AND status = 'ok'
        RETURNING id`,
      [projectId],
    );
    marked.push(...rows.map((r) => r.id));
  }

  for (const id of marked) {
    const dto = await getDocument(projectId, id).catch(() => null);
    if (dto) sseHub.emitAsync(projectId, "document.updated", dto);
  }
  if (marked.length > 0) {
    await audit({
      projectId,
      actorId: null,
      action: "document.marked_stale",
      targetType: "document",
      targetId: null,
      detail: { count: marked.length, affectedNodeIds, globalStructureChanged },
    });
  }
  return marked;
}
