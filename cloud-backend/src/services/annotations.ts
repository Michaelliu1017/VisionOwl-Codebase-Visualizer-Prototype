/**
 * 批注（契约 §4.8 / spec §4.5）
 * 编辑/删除限"本人或 owner"；所有变更推 SSE，保证双端实时一致。
 */
import { query, queryOne } from "../infra/pg";
import { forbidden, notFound } from "../lib/errors";
import { isoReq } from "../lib/time";
import { sseHub } from "../realtime/sseHub";
import type { AnnotationDto, AnnotationTarget, Role } from "../types";
import { audit } from "./audit";

interface AnnRow {
  id: string;
  project_id: string;
  target_kind: string;
  target_id: string;
  body: string;
  author_id: string | null;
  author_name: string | null;
  resolved: boolean;
  created_at: Date;
  updated_at: Date;
}

const ANN_SELECT = `
  SELECT a.id, a.project_id, a.target_kind, a.target_id, a.body,
         a.author_id, u.name AS author_name, a.resolved, a.created_at, a.updated_at
    FROM annotations a
    LEFT JOIN users u ON u.id = a.author_id
`;

function toDto(row: AnnRow): AnnotationDto {
  return {
    id: row.id,
    targetKind: row.target_kind as AnnotationTarget,
    targetId: row.target_id,
    body: row.body,
    author: row.author_id ? { id: row.author_id, name: row.author_name ?? "" } : null,
    resolved: row.resolved,
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
  };
}

export async function listAnnotations(
  projectId: string,
  filter: { targetId?: string },
): Promise<AnnotationDto[]> {
  const params: unknown[] = [projectId];
  let where = `a.project_id = $1`;
  if (filter.targetId) {
    params.push(filter.targetId);
    where += ` AND a.target_id = $${params.length}`;
  }
  const rows = await query<AnnRow>(`${ANN_SELECT} WHERE ${where} ORDER BY a.created_at DESC`, params);
  return rows.map(toDto);
}

export async function getAnnotation(projectId: string, annId: string): Promise<AnnotationDto> {
  const row = await queryOne<AnnRow>(`${ANN_SELECT} WHERE a.project_id = $1 AND a.id = $2`, [
    projectId,
    annId,
  ]);
  if (!row) throw notFound("批注不存在");
  return toDto(row);
}

export async function createAnnotation(
  projectId: string,
  actorId: string,
  input: { targetKind: AnnotationTarget; targetId: string; body: string },
  ip?: string | null,
): Promise<AnnotationDto> {
  const rows = await query<{ id: string }>(
    `INSERT INTO annotations (project_id, target_kind, target_id, body, author_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [projectId, input.targetKind, input.targetId, input.body, actorId],
  );
  const dto = await getAnnotation(projectId, rows[0]!.id);
  sseHub.emitAsync(projectId, "annotation.created", dto);
  await audit({
    projectId,
    actorId,
    action: "annotation.created",
    targetType: "annotation",
    targetId: dto.id,
    detail: { targetKind: dto.targetKind, targetId: dto.targetId },
    ip,
  });
  return dto;
}

/** 本人或 owner 才能改/删（契约 §4.8） */
async function assertCanMutate(
  projectId: string,
  annId: string,
  actorId: string,
  actorRole: Role,
): Promise<void> {
  const row = await queryOne<{ author_id: string | null }>(
    `SELECT author_id FROM annotations WHERE project_id = $1 AND id = $2`,
    [projectId, annId],
  );
  if (!row) throw notFound("批注不存在");
  if (actorRole !== "owner" && row.author_id !== actorId) {
    throw forbidden("只能修改自己的批注");
  }
}

export async function patchAnnotation(
  projectId: string,
  annId: string,
  actor: { id: string; role: Role },
  patch: { body?: string; resolved?: boolean },
  ip?: string | null,
): Promise<AnnotationDto> {
  await assertCanMutate(projectId, annId, actor.id, actor.role);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.body !== undefined) {
    params.push(patch.body);
    sets.push(`body = $${params.length}`);
  }
  if (patch.resolved !== undefined) {
    params.push(patch.resolved);
    sets.push(`resolved = $${params.length}`);
  }
  params.push(annId, projectId);
  await query(
    `UPDATE annotations SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $${params.length - 1} AND project_id = $${params.length}`,
    params,
  );

  const dto = await getAnnotation(projectId, annId);
  sseHub.emitAsync(projectId, "annotation.updated", dto);
  await audit({
    projectId,
    actorId: actor.id,
    action: "annotation.updated",
    targetType: "annotation",
    targetId: annId,
    detail: { changed: Object.keys(patch) },
    ip,
  });
  return dto;
}

export async function deleteAnnotation(
  projectId: string,
  annId: string,
  actor: { id: string; role: Role },
  ip?: string | null,
): Promise<void> {
  await assertCanMutate(projectId, annId, actor.id, actor.role);
  await query(`DELETE FROM annotations WHERE id = $1 AND project_id = $2`, [annId, projectId]);
  sseHub.emitAsync(projectId, "annotation.deleted", { id: annId });
  await audit({
    projectId,
    actorId: actor.id,
    action: "annotation.deleted",
    targetType: "annotation",
    targetId: annId,
    ip,
  });
}
