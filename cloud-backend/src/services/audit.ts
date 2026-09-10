/** 审计日志（spec §12-4）：角色变更、密钥生成/撤销、仓库绑定、分析触发、版本回滚 */
import { query } from "../infra/pg";

export interface AuditEntry {
  projectId: string | null;
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/** 审计失败绝不影响主流程，只记 console */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (project_id, actor_id, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.projectId,
        entry.actorId,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        JSON.stringify(entry.detail ?? {}),
        entry.ip && /^[0-9a-fA-F.:]+$/.test(entry.ip) ? entry.ip : null,
      ],
    );
  } catch (err) {
    console.error("[audit] 写入失败:", err instanceof Error ? err.message : err);
  }
}
