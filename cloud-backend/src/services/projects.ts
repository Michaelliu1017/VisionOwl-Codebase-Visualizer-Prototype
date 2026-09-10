/**
 * Project 与成员身份（契约 §4.2）
 * 权限执行规则（spec §3）：所有 Project 级操作必须先过 requireMembership。
 */
import { config } from "../config";
import { query, queryOne, withTx } from "../infra/pg";
import { forbidden, notFound } from "../lib/errors";
import { iso, isoReq } from "../lib/time";
import { ROLE_RANK, type ProjectDto, type ProjectStatus, type ProjectSummaryDto, type Role } from "../types";
import { listBindings } from "./repository";

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  owner_id: string;
  owner_name: string;
  current_graph_version_id: string | null;
  created_at: Date;
  updated_at: Date;
  // current graph
  version_no: number | null;
  graph_commit_sha: string | null;
  repository_commits: Record<string, string> | null;
  graph_created_at: Date | null;
}

const PROJECT_SELECT = `
  SELECT p.id, p.name, p.status, p.owner_id, u.name AS owner_name,
         p.current_graph_version_id, p.created_at, p.updated_at,
         gv.version_no, gv.commit_sha AS graph_commit_sha, gv.repository_commits,
         gv.created_at AS graph_created_at
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    LEFT JOIN graph_versions gv ON gv.id = p.current_graph_version_id
`;

function toDto(row: ProjectRow, myRole: Role, repositories: ProjectDto["repositories"]): ProjectDto {
  const primary = repositories[0] ?? null;
  return {
    id: row.id,
    name: row.name,
    status: row.status as ProjectStatus,
    myRole,
    owner: { id: row.owner_id, name: row.owner_name },
    repositories,
    binding: primary,
    currentGraph:
      row.version_no !== null && row.graph_commit_sha
        ? {
            versionNo: row.version_no,
            commitSha: row.graph_commit_sha,
            repositoryCommits: row.repository_commits ?? {},
            createdAt: isoReq(row.graph_created_at ?? row.created_at),
          }
        : null,
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
  };
}

// ── 成员身份 ───────────────────────────────────────────────────────────
export interface Membership {
  projectId: string;
  userId: string;
  role: Role;
}

export async function findMembership(projectId: string, userId: string): Promise<Membership | null> {
  const row = await queryOne<{ role: string }>(
    `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId],
  );
  return row ? { projectId, userId, role: row.role as Role } : null;
}

/**
 * 校验成员身份与最低角色。
 * - 非成员 → 404（防枚举，契约 §3.1）
 * - 成员但角色不足 → 403
 */
export async function requireMembership(
  projectId: string,
  userId: string,
  minRole: Role = "editor",
): Promise<Membership> {
  const m = await findMembership(projectId, userId);
  if (!m) throw notFound("项目不存在");
  if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) {
    throw forbidden(`该操作需要 ${minRole} 及以上角色，当前角色 ${m.role}`);
  }
  return m;
}

// ── 查询 ──────────────────────────────────────────────────────────────
interface SummaryRow {
  id: string;
  name: string;
  status: string;
  my_role: string;
  repo_full_name: string | null;
  branch: string | null;
  repository_count: string;
  current_commit_sha: string | null;
  graph_commit_sha: string | null;
  last_analyzed_at: Date | null;
  updated_at: Date;
}

export async function listMyProjects(userId: string): Promise<ProjectSummaryDto[]> {
  const rows = await query<SummaryRow>(
    `SELECT p.id, p.name, p.status, pm.role AS my_role,
            b.repo_full_name, b.branch, b.current_commit_sha,
            coalesce(bc.repository_count, 0)::text AS repository_count,
            gv.commit_sha AS graph_commit_sha,
            (SELECT max(j.finished_at) FROM analysis_jobs j
              WHERE j.project_id = p.id AND j.status = 'succeeded') AS last_analyzed_at,
            p.updated_at
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
       LEFT JOIN LATERAL (
         SELECT repo_full_name, branch, current_commit_sha
           FROM repository_bindings
          WHERE project_id = p.id
          ORDER BY is_primary DESC, created_at, id
          LIMIT 1
       ) b ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS repository_count
           FROM repository_bindings
          WHERE project_id = p.id
       ) bc ON true
       LEFT JOIN graph_versions gv ON gv.id = p.current_graph_version_id
      ORDER BY p.updated_at DESC`,
    [userId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status as ProjectStatus,
    myRole: row.my_role as Role,
    repo: row.repo_full_name,
    branch: row.branch,
    repositoryCount: Number(row.repository_count),
    currentCommitSha: row.current_commit_sha ?? row.graph_commit_sha,
    lastAnalyzedAt: iso(row.last_analyzed_at),
    updatedAt: isoReq(row.updated_at),
  }));
}

export async function getProject(projectId: string, membership: Membership): Promise<ProjectDto> {
  const [row, repositories] = await Promise.all([
    queryOne<ProjectRow>(`${PROJECT_SELECT} WHERE p.id = $1`, [projectId]),
    listBindings(projectId),
  ]);
  if (!row) throw notFound("项目不存在");
  return toDto(row, membership.role, repositories);
}

// ── 写入 ──────────────────────────────────────────────────────────────
export async function createProject(userId: string, name: string): Promise<ProjectDto> {
  const projectId = await withTx(async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id`,
      [name, userId],
    );
    const id = res.rows[0]!.id;
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, userId],
    );
    if (config.knowledgeIntegrationEnabled) {
      await client.query(
        `INSERT INTO knowledge_assets (project_id, kind)
         VALUES ($1, 'wiki'), ($1, 'skills')
         ON CONFLICT (project_id, kind) DO NOTHING`,
        [id],
      );
    }
    return id;
  });
  return getProject(projectId, { projectId, userId, role: "owner" });
}

export async function patchProject(
  projectId: string,
  membership: Membership,
  patch: { name?: string; status?: ProjectStatus },
): Promise<ProjectDto> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.status !== undefined) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
  }
  params.push(projectId);
  await query(
    `UPDATE projects SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );
  return getProject(projectId, membership);
}

export async function touchProject(projectId: string): Promise<void> {
  await query(`UPDATE projects SET updated_at = now() WHERE id = $1`, [projectId]);
}

export async function deleteProject(projectId: string): Promise<void> {
  const rows = await query<{ id: string }>(
    `DELETE FROM projects WHERE id = $1 RETURNING id`,
    [projectId],
  );
  if (rows.length === 0) throw notFound("项目不存在");
}
