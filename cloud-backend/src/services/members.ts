/** 成员管理（契约 §4.3）：成员均为 Editor；Owner 自身不可被改/移除。 */
import { query, queryOne } from "../infra/pg";
import { forbidden, notFound } from "../lib/errors";
import { isoReq } from "../lib/time";
import type { MemberDto, Role } from "../types";
import { audit } from "./audit";

interface MemberRow {
  user_id: string;
  name: string;
  email: string;
  role: string;
  joined_at: Date;
}

function toDto(row: MemberRow): MemberDto {
  return {
    user: { id: row.user_id, name: row.name, email: row.email },
    role: row.role as Role,
    joinedAt: isoReq(row.joined_at),
  };
}

export async function listMembers(projectId: string): Promise<MemberDto[]> {
  const rows = await query<MemberRow>(
    `SELECT pm.user_id, u.name, u.email, pm.role, pm.joined_at
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1
      ORDER BY CASE pm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, pm.joined_at`,
    [projectId],
  );
  return rows.map(toDto);
}

export async function updateMemberRole(
  projectId: string,
  targetUserId: string,
  role: Exclude<Role, "owner">,
  actorId: string,
  ip?: string | null,
): Promise<MemberDto> {
  const current = await queryOne<{ role: string }>(
    `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
    [projectId, targetUserId],
  );
  if (!current) throw notFound("成员不存在");
  if (current.role === "owner") throw forbidden("不能修改 Owner 的角色");

  const rows = await query<MemberRow>(
    `UPDATE project_members pm SET role = $3
      WHERE pm.project_id = $1 AND pm.user_id = $2
      RETURNING pm.user_id, pm.role, pm.joined_at,
                (SELECT name FROM users WHERE id = pm.user_id) AS name,
                (SELECT email FROM users WHERE id = pm.user_id) AS email`,
    [projectId, targetUserId, role],
  );
  await audit({
    projectId,
    actorId,
    action: "member.role_changed",
    targetType: "user",
    targetId: targetUserId,
    detail: { from: current.role, to: role },
    ip,
  });
  return toDto(rows[0]!);
}

export async function removeMember(
  projectId: string,
  targetUserId: string,
  actorId: string,
  ip?: string | null,
): Promise<void> {
  const current = await queryOne<{ role: string }>(
    `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
    [projectId, targetUserId],
  );
  if (!current) throw notFound("成员不存在");
  if (current.role === "owner") throw forbidden("不能移除 Owner");

  await query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [
    projectId,
    targetUserId,
  ]);
  await audit({
    projectId,
    actorId,
    action: "member.removed",
    targetType: "user",
    targetId: targetUserId,
    detail: { role: current.role },
    ip,
  });
}

export async function getMember(projectId: string, userId: string): Promise<MemberDto | null> {
  const row = await queryOne<MemberRow>(
    `SELECT pm.user_id, u.name, u.email, pm.role, pm.joined_at
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1 AND pm.user_id = $2`,
    [projectId, userId],
  );
  return row ? toDto(row) : null;
}
