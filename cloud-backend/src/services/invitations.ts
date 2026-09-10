/**
 * 邀请密钥（契约 §4.3 / spec §3）
 * 服务端只存哈希；明文 key 仅在创建时返回一次；邀请码永久、无限次且只授予 Editor。
 */
import { createHash, randomBytes } from "node:crypto";
import { query, queryOne, withTx } from "../infra/pg";
import { invitationInvalid, notFound } from "../lib/errors";
import { iso, isoReq } from "../lib/time";
import type { InvitationCreatedDto, InvitationDto, Role } from "../types";
import { audit } from "./audit";

const KEY_PREFIX = "vo-inv-";

function hashKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

function generateKey(): string {
  return KEY_PREFIX + randomBytes(10).toString("hex");
}

interface InvitationRow {
  id: string;
  project_id: string;
  role: string;
  max_uses: number | null;
  used_count: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function toDto(row: InvitationRow): InvitationDto {
  return {
    id: row.id,
    role: row.role as Role,
    expiresAt: iso(row.expires_at),
    maxUses: row.max_uses,
    usedCount: row.used_count,
    revokedAt: iso(row.revoked_at),
    createdAt: isoReq(row.created_at),
  };
}

export async function createInvitation(
  projectId: string,
  actorId: string,
  ip?: string | null,
): Promise<InvitationCreatedDto> {
  const key = generateKey();

  const rows = await query<InvitationRow>(
    `INSERT INTO invitations (project_id, key_hash, role, max_uses, expires_at, created_by)
     VALUES ($1, $2, 'editor', NULL, NULL, $3)
     RETURNING id, project_id, role, max_uses, used_count, expires_at, revoked_at, created_at`,
    [projectId, hashKey(key), actorId],
  );
  const row = rows[0]!;

  await audit({
    projectId,
    actorId,
    action: "invitation.created",
    targetType: "invitation",
    targetId: row.id,
    detail: { role: "editor", unlimited: true, expiresAt: null },
    ip,
  });

  return {
    id: row.id,
    key, // 明文仅此一次
    role: row.role as Role,
    expiresAt: iso(row.expires_at),
    maxUses: null,
  };
}

export async function listInvitations(projectId: string): Promise<InvitationDto[]> {
  const rows = await query<InvitationRow>(
    `SELECT id, project_id, role, max_uses, used_count, expires_at, revoked_at, created_at
       FROM invitations WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
  return rows.map(toDto);
}

export async function revokeInvitation(
  projectId: string,
  invitationId: string,
  actorId: string,
  ip?: string | null,
): Promise<void> {
  const rows = await query<{ id: string }>(
    `UPDATE invitations SET revoked_at = now()
      WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [invitationId, projectId],
  );
  if (rows.length === 0) {
    // 已撤销或不存在：都当作不存在处理，幂等
    const exists = await queryOne<{ id: string }>(
      `SELECT id FROM invitations WHERE id = $1 AND project_id = $2`,
      [invitationId, projectId],
    );
    if (!exists) throw notFound("邀请不存在");
  }
  await audit({
    projectId,
    actorId,
    action: "invitation.revoked",
    targetType: "invitation",
    targetId: invitationId,
    ip,
  });
}

export interface RedeemResult {
  projectId: string;
  role: Role;
  /** 首次加入才为 true，用于决定是否推 member.joined 事件 */
  joined: boolean;
}

/**
 * 兑换密钥：校验哈希 / 撤销 / 过期 / 次数 → 写入成员 → 记审计。
 * 任一校验失败统一 410 INVITATION_INVALID，不泄漏具体原因。
 */
export async function redeemInvitation(
  key: string,
  userId: string,
  ip?: string | null,
): Promise<RedeemResult> {
  return withTx(async (client) => {
    const found = await client.query<InvitationRow>(
      `SELECT id, project_id, role, max_uses, used_count, expires_at, revoked_at, created_at
         FROM invitations WHERE key_hash = $1 FOR UPDATE`,
      [hashKey(key)],
    );
    const inv = found.rows[0];
    if (!inv) throw invitationInvalid();
    if (inv.revoked_at) throw invitationInvalid();
    if (inv.expires_at && inv.expires_at.getTime() <= Date.now()) throw invitationInvalid();
    if (inv.max_uses !== null && inv.used_count >= inv.max_uses) throw invitationInvalid();

    const existing = await client.query<{ role: string }>(
      `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [inv.project_id, userId],
    );
    if (existing.rows[0]) {
      // 已是成员：不消耗次数，不降级角色
      return { projectId: inv.project_id, role: existing.rows[0].role as Role, joined: false };
    }

    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)`,
      [inv.project_id, userId, inv.role],
    );
    await client.query(`UPDATE invitations SET used_count = used_count + 1 WHERE id = $1`, [inv.id]);
    await client.query(
      `INSERT INTO audit_logs (project_id, actor_id, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, 'invitation.redeemed', 'invitation', $3, $4, $5)`,
      [
        inv.project_id,
        userId,
        inv.id,
        JSON.stringify({ role: inv.role }),
        ip && /^[0-9a-fA-F.:]+$/.test(ip) ? ip : null,
      ],
    );

    return { projectId: inv.project_id, role: inv.role as Role, joined: true };
  });
}
