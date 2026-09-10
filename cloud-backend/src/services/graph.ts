/**
 * Graph Service（契约 §4.6 / spec §8）
 * - 只读四接口 + artifact 直出
 * - saveVersion：Schema 双侧校验 → 脱敏 → 落产物 → 写索引 → 原子切换 current
 * - 版本只追加，绝不覆盖；同一 commitSha 复用已有版本（成本铁律）
 */
import { isUniqueViolation, query, queryOne, withTx } from "../infra/pg";
import { artifactKey, readArtifact, readJsonArtifact, writeJsonArtifact } from "../infra/artifacts";
import { badRequest, notFound } from "../lib/errors";
import { encodeCursor, type Cursor } from "../lib/pagination";
import { isoReq } from "../lib/time";
import { computeStats, sanitizeGraph, validateGraph } from "../schemas/graphValidator";
import type { GraphDocument, GraphStats, GraphVersionDto } from "../types";

interface VersionRow {
  id: string;
  project_id: string;
  version_no: number;
  commit_sha: string;
  repository_commits: Record<string, string> | null;
  job_id: string | null;
  artifact_oss_key: string;
  stats: GraphStats | null;
  created_at: Date;
}

function artifactUrl(projectId: string, versionNo: number): string {
  return `/api/projects/${projectId}/graph/versions/${versionNo}/artifact`;
}

function toDto(row: VersionRow): GraphVersionDto {
  return {
    versionNo: row.version_no,
    commitSha: row.commit_sha,
    repositoryCommits: row.repository_commits ?? {},
    jobId: row.job_id,
    stats: row.stats ?? { nodeCount: 0, edgeCount: 0, inferredCount: 0 },
    artifactUrl: artifactUrl(row.project_id, row.version_no),
    createdAt: isoReq(row.created_at),
  };
}

const VERSION_COLUMNS = `id, project_id, version_no, commit_sha, repository_commits,
                         job_id, artifact_oss_key, stats, created_at`;

export async function getCurrentVersion(projectId: string): Promise<GraphVersionDto> {
  const row = await queryOne<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM graph_versions
      WHERE id = (SELECT current_graph_version_id FROM projects WHERE id = $1)`,
    [projectId],
  );
  if (!row) throw notFound("该项目尚无图谱版本");
  return toDto(row);
}

export async function setCurrentByCommit(
  projectId: string,
  commitSha: string,
): Promise<GraphVersionDto | null> {
  const row = await queryOne<VersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM graph_versions
      WHERE project_id = $1 AND commit_sha = $2
      ORDER BY version_no DESC LIMIT 1`,
    [projectId, commitSha],
  );
  if (!row) return null;
  await query(
    `UPDATE projects SET current_graph_version_id = $2, updated_at = now() WHERE id = $1`,
    [projectId, row.id],
  );
  return toDto(row);
}

export async function listVersions(
  projectId: string,
  limit: number,
  cursor: Cursor | null,
): Promise<{ items: GraphVersionDto[]; nextCursor: string | null }> {
  const params: unknown[] = [projectId];
  let where = `project_id = $1`;
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = await query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM graph_versions
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toDto),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: isoReq(last.created_at), id: last.id }) : null,
  };
}

export async function getVersion(projectId: string, versionNo: number): Promise<GraphVersionDto> {
  const row = await queryOne<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM graph_versions WHERE project_id = $1 AND version_no = $2`,
    [projectId, versionNo],
  );
  if (!row) throw notFound("图谱版本不存在");
  return toDto(row);
}

export async function findVersionByCommit(
  projectId: string,
  commitSha: string,
): Promise<GraphVersionDto | null> {
  const row = await queryOne<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM graph_versions
      WHERE project_id = $1 AND commit_sha = $2
      ORDER BY version_no DESC LIMIT 1`,
    [projectId, commitSha],
  );
  return row ? toDto(row) : null;
}

/** artifact 直出：读 ARTIFACTS_DIR 下的产物本体（二期换 OSS 签名 URL，接口不变） */
export async function readVersionArtifact(projectId: string, versionNo: number): Promise<Buffer> {
  const row = await queryOne<{ artifact_oss_key: string }>(
    `SELECT artifact_oss_key FROM graph_versions WHERE project_id = $1 AND version_no = $2`,
    [projectId, versionNo],
  );
  if (!row) throw notFound("图谱版本不存在");
  return readArtifact(row.artifact_oss_key);
}

/** 当前图谱文档（chat 与 impact 计算用） */
export async function getCurrentGraphDocument(projectId: string): Promise<GraphDocument | null> {
  const row = await queryOne<{ artifact_oss_key: string }>(
    `SELECT artifact_oss_key FROM graph_versions
      WHERE id = (SELECT current_graph_version_id FROM projects WHERE id = $1)`,
    [projectId],
  );
  if (!row) return null;
  try {
    return await readJsonArtifact<GraphDocument>(row.artifact_oss_key);
  } catch {
    return null;
  }
}

export interface SaveVersionInput {
  projectId: string;
  commitSha: string;
  jobId: string | null;
  graph: GraphDocument;
  repositoryCommits?: Record<string, string>;
  /** 已存在同 commit 版本时是否复用（默认 true，成本铁律） */
  reuseSameCommit?: boolean;
  /** 强制重算时使用独立文件名，避免覆盖同 commit 的历史版本产物。 */
  artifactFile?: string;
}

/**
 * 保存新图谱版本。
 * 校验失败抛 400（Runner 侧已校验过一次，这里是第二道闸）。
 */
export async function saveVersion(input: SaveVersionInput): Promise<GraphVersionDto> {
  const { projectId, commitSha, jobId } = input;

  if (input.reuseSameCommit !== false) {
    const existing = await findVersionByCommit(projectId, commitSha);
    if (existing) return existing;
  }

  // 强制对齐 projectId / commitSha，避免 Runner 传错串项目
  const graph: GraphDocument = sanitizeGraph({
    ...input.graph,
    schemaVersion: "1.0",
    projectId,
    commitSha,
    generatedAt: input.graph.generatedAt || new Date().toISOString(),
  });
  const stats = computeStats(graph);
  graph.stats = stats;

  const result = validateGraph(graph);
  if (!result.ok) {
    throw badRequest("graph.json 校验失败", { errors: result.errors });
  }

  const key = artifactKey(projectId, commitSha, input.artifactFile ?? "graph.json");
  await writeJsonArtifact(key, graph);

  const repositoryCommits = input.repositoryCommits ?? graph.repositoryCommits ?? {};
  const row = await insertVersionWithRetry({
    projectId,
    commitSha,
    repositoryCommits,
    jobId,
    key,
    stats,
  });
  return toDto(row);
}

async function insertVersionWithRetry(args: {
  projectId: string;
  commitSha: string;
  repositoryCommits: Record<string, string>;
  jobId: string | null;
  key: string;
  stats: GraphStats;
}): Promise<VersionRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTx(async (client) => {
        const res = await client.query<VersionRow>(
          `INSERT INTO graph_versions
             (project_id, version_no, commit_sha, repository_commits, job_id, artifact_oss_key, stats)
           SELECT $1,
                  coalesce((SELECT max(version_no) FROM graph_versions WHERE project_id = $1), 0) + 1,
                  $2, $3::jsonb, $4, $5, $6::jsonb
           RETURNING ${VERSION_COLUMNS}`,
          [
            args.projectId,
            args.commitSha,
            JSON.stringify(args.repositoryCommits),
            args.jobId,
            args.key,
            JSON.stringify(args.stats),
          ],
        );
        const row = res.rows[0]!;
        // 原子切换 current（spec §11.1-8）
        await client.query(
          `UPDATE projects SET current_graph_version_id = $2, updated_at = now() WHERE id = $1`,
          [args.projectId, row.id],
        );
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 2) continue; // version_no 竞争，重试
      throw err;
    }
  }
  throw new Error("写入图谱版本失败：version_no 竞争超过重试次数");
}
