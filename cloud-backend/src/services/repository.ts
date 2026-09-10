/** Project 仓库集合：一个 Project 可绑定多个仓库与目标分支。 */
import { isUniqueViolation, query, queryOne, withTx } from "../infra/pg";
import { duplicate, notFound } from "../lib/errors";
import type { BindingDto } from "../types";
import { audit } from "./audit";

interface BindingRow {
  id: string;
  project_id: string;
  repo_full_name: string;
  repository_id: string | null;
  installation_id: string | null;
  branch: string;
  current_commit_sha: string | null;
  is_primary: boolean;
}

const BINDING_COLUMNS = `id, project_id, repo_full_name, repository_id, installation_id,
                         branch, current_commit_sha, is_primary`;

function toDto(row: BindingRow): BindingDto {
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    repositoryId: row.repository_id === null ? null : Number(row.repository_id),
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    currentCommitSha: row.current_commit_sha,
    isPrimary: row.is_primary,
  };
}

export function bindingRepositoryKey(binding: BindingDto): string {
  return binding.repositoryId === null ? binding.repoFullName : String(binding.repositoryId);
}

export async function listBindings(projectId: string): Promise<BindingDto[]> {
  const rows = await query<BindingRow>(
    `SELECT ${BINDING_COLUMNS}
       FROM repository_bindings
      WHERE project_id = $1
      ORDER BY is_primary DESC, created_at, id`,
    [projectId],
  );
  return rows.map(toDto);
}

/** 兼容旧调用：返回主仓库；未设置主仓库时返回第一条绑定。 */
export async function getBinding(projectId: string): Promise<BindingDto | null> {
  return (await listBindings(projectId))[0] ?? null;
}

export async function getBindingById(projectId: string, bindingId: string): Promise<BindingDto | null> {
  const row = await queryOne<BindingRow>(
    `SELECT ${BINDING_COLUMNS}
       FROM repository_bindings
      WHERE project_id = $1 AND id = $2`,
    [projectId, bindingId],
  );
  return row ? toDto(row) : null;
}

/** 图谱节点使用 GitHub repository_id；公开仓库缺失该值时退化为 owner/repo。 */
export async function getBindingForRepository(
  projectId: string,
  repositoryKey: string | null | undefined,
): Promise<BindingDto | null> {
  if (!repositoryKey) return getBinding(projectId);
  const row = await queryOne<BindingRow>(
    `SELECT ${BINDING_COLUMNS}
       FROM repository_bindings
      WHERE project_id = $1
        AND (repository_id::text = $2 OR repo_full_name = $2)
      ORDER BY is_primary DESC, created_at
      LIMIT 1`,
    [projectId, repositoryKey],
  );
  return row ? toDto(row) : null;
}

export async function bindRepository(
  projectId: string,
  actorId: string,
  input: {
    installationId?: number;
    repoFullName: string;
    branch: string;
    repositoryId?: number;
  },
  ip?: string | null,
): Promise<BindingDto> {
  try {
    const row = await withTx(async (client) => {
      // 同一 Project 的并发绑定串行化，保证只产生一个主仓库。
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [projectId]);
      const result = await client.query<BindingRow>(
        `INSERT INTO repository_bindings
           (project_id, repo_full_name, repository_id, installation_id, branch, is_primary)
         SELECT $1, $2, $3, $4, $5,
                NOT EXISTS (SELECT 1 FROM repository_bindings WHERE project_id = $1)
         RETURNING ${BINDING_COLUMNS}`,
        [
          projectId,
          input.repoFullName,
          input.repositoryId ?? null,
          input.installationId ?? null,
          input.branch,
        ],
      );
      return result.rows[0]!;
    });
    await audit({
      projectId,
      actorId,
      action: "repository.bound",
      targetType: "repository",
      targetId: input.repoFullName,
      detail: { branch: input.branch, installationId: input.installationId ?? null },
      ip,
    });
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw duplicate("该仓库与分支已绑定到当前 Project", {
        repoFullName: input.repoFullName,
        branch: input.branch,
      });
    }
    throw err;
  }
}

export async function deleteBinding(
  projectId: string,
  bindingId: string,
  actorId: string,
  ip?: string | null,
): Promise<void> {
  const deleted = await withTx(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [projectId]);
    const result = await client.query<BindingRow>(
      `DELETE FROM repository_bindings
        WHERE project_id = $1 AND id = $2
        RETURNING ${BINDING_COLUMNS}`,
      [projectId, bindingId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.is_primary) {
      await client.query(
        `UPDATE repository_bindings
            SET is_primary = true, updated_at = now()
          WHERE id = (
            SELECT id FROM repository_bindings
             WHERE project_id = $1
             ORDER BY created_at, id LIMIT 1
          )`,
        [projectId],
      );
    }
    return row;
  });
  if (!deleted) throw notFound("仓库绑定不存在");
  await audit({
    projectId,
    actorId,
    action: "repository.unbound",
    targetType: "repository",
    targetId: deleted.repo_full_name,
    detail: { branch: deleted.branch },
    ip,
  });
}

/** 分析成功后仅更新本次扫描对应的仓库。 */
export async function updateBindingSha(bindingId: string, commitSha: string): Promise<void> {
  await query(
    `UPDATE repository_bindings
        SET current_commit_sha = $2, updated_at = now()
      WHERE id = $1`,
    [bindingId, commitSha],
  );
}

/** Webhook 用：按 repo + branch 反查所有绑定该分支的 Project。 */
export async function findProjectsByRepoBranch(
  repoFullName: string,
  branch: string,
): Promise<Array<{
  projectId: string;
  bindingId: string;
  repositoryKey: string;
  installationId: number | null;
  currentCommitSha: string | null;
}>> {
  const rows = await query<{
    id: string;
    project_id: string;
    repository_id: string | null;
    installation_id: string | null;
    current_commit_sha: string | null;
  }>(
    `SELECT id, project_id, repository_id, installation_id, current_commit_sha
       FROM repository_bindings
      WHERE repo_full_name = $1 AND branch = $2`,
    [repoFullName, branch],
  );
  return rows.map((row) => ({
    projectId: row.project_id,
    bindingId: row.id,
    repositoryKey: row.repository_id ?? repoFullName,
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    currentCommitSha: row.current_commit_sha,
  }));
}

export async function requireBinding(projectId: string): Promise<BindingDto> {
  const binding = await getBinding(projectId);
  if (!binding) throw notFound("该项目尚未绑定仓库");
  return binding;
}

/** GitHub App 安装回调目前只带 projectId，因此更新该 Project 下尚未授权的绑定。 */
export async function recordInstallation(projectId: string, installationId: number): Promise<void> {
  await query(
    `UPDATE repository_bindings
        SET installation_id = $2, updated_at = now()
      WHERE project_id = $1 AND installation_id IS NULL`,
    [projectId, installationId],
  );
  await audit({
    projectId,
    actorId: null,
    action: "github.app_installed",
    targetType: "installation",
    targetId: String(installationId),
  });
}
