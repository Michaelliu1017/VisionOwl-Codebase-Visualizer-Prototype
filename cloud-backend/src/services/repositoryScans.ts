import { query, queryOne, withTx } from "../infra/pg";
import { iso, isoReq } from "../lib/time";
import type { BindingDto, JobDto } from "../types";
import { bindingRepositoryKey } from "./repository";

export type RepositoryScanStatus = "queued" | "running" | "succeeded" | "failed";
export const REPOSITORY_SCAN_PIPELINE_VERSION = "scanner-2.1.0:architecture-v2:agent-adaptive-v1";

interface RepositoryScanRow {
  id: string;
  job_id: string;
  project_id: string;
  binding_id: string | null;
  repo_full_name: string;
  repository_id: string;
  installation_id: string | null;
  branch: string;
  base_commit_sha: string | null;
  commit_sha: string;
  pipeline_version: string;
  status: RepositoryScanStatus;
  progress: number;
  attempts: number;
  graph_oss_key: string | null;
  interface_catalog_oss_key: string | null;
  impact_oss_key: string | null;
  credits: string | null;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, job_id, project_id, binding_id, repo_full_name, repository_id,
  installation_id, branch, base_commit_sha, commit_sha, pipeline_version, status, progress, attempts,
  graph_oss_key, interface_catalog_oss_key, impact_oss_key, credits, error,
  started_at, finished_at, created_at, updated_at`;

export interface RepositoryScanDto {
  id: string;
  jobId: string;
  projectId: string;
  bindingId: string | null;
  repositoryKey: string;
  repoFullName: string;
  installationId: number | null;
  branch: string;
  baseCommitSha: string | null;
  commitSha: string;
  pipelineVersion: string;
  status: RepositoryScanStatus;
  progress: number;
  attempts: number;
  graphArtifactKey: string | null;
  interfaceCatalogArtifactKey: string | null;
  impactArtifactKey: string | null;
  credits: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: RepositoryScanRow): RepositoryScanDto {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    bindingId: row.binding_id,
    repositoryKey: row.repository_id,
    repoFullName: row.repo_full_name,
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    branch: row.branch,
    baseCommitSha: row.base_commit_sha,
    commitSha: row.commit_sha,
    pipelineVersion: row.pipeline_version,
    status: row.status,
    progress: Number(row.progress),
    attempts: Number(row.attempts),
    graphArtifactKey: row.graph_oss_key,
    interfaceCatalogArtifactKey: row.interface_catalog_oss_key,
    impactArtifactKey: row.impact_oss_key,
    credits: row.credits === null ? null : Number(row.credits),
    error: row.error,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
  };
}

export async function createRepositoryScans(
  job: JobDto,
  bindings: BindingDto[],
): Promise<RepositoryScanDto[]> {
  return withTx(async (client) => {
    for (const binding of bindings) {
      const repositoryKey = bindingRepositoryKey(binding);
      const commitSha = job.repositoryCommits[repositoryKey];
      if (!commitSha) throw new Error(`任务缺少仓库快照：${binding.repoFullName}`);
      const reusable = job.type === "incremental" && !job.forceReanalysis
        ? (await client.query<RepositoryScanRow>(
            `SELECT ${COLUMNS}
               FROM analysis_job_repositories
              WHERE project_id = $1 AND repository_id = $2 AND commit_sha = $3
                AND pipeline_version = $4 AND status = 'succeeded'
                AND graph_oss_key IS NOT NULL AND interface_catalog_oss_key IS NOT NULL
                AND job_id <> $5
              ORDER BY finished_at DESC NULLS LAST
              LIMIT 1`,
            [
              job.projectId,
              repositoryKey,
              commitSha,
              REPOSITORY_SCAN_PIPELINE_VERSION,
              job.id,
            ],
          )).rows[0]
        : undefined;
      await client.query(
        `INSERT INTO analysis_job_repositories
           (job_id, project_id, binding_id, repo_full_name, repository_id, installation_id,
            branch, base_commit_sha, commit_sha, pipeline_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (job_id, repo_full_name, branch) DO NOTHING`,
        [
          job.id,
          job.projectId,
          binding.id,
          binding.repoFullName,
          repositoryKey,
          binding.installationId,
          binding.branch,
          binding.currentCommitSha,
          commitSha,
          REPOSITORY_SCAN_PIPELINE_VERSION,
        ],
      );
      if (reusable) {
        await client.query(
          `UPDATE analysis_job_repositories
              SET status = 'succeeded', progress = 100,
                  graph_oss_key = $4, interface_catalog_oss_key = $5,
                  impact_oss_key = NULL, credits = 0, error = NULL,
                  started_at = now(), finished_at = now(), updated_at = now()
            WHERE job_id = $1 AND repo_full_name = $2 AND branch = $3 AND status = 'queued'`,
          [
            job.id,
            binding.repoFullName,
            binding.branch,
            reusable.graph_oss_key,
            reusable.interface_catalog_oss_key,
          ],
        );
      }
    }
    const result = await client.query<RepositoryScanRow>(
      `SELECT ${COLUMNS} FROM analysis_job_repositories WHERE job_id = $1 ORDER BY repo_full_name`,
      [job.id],
    );
    return result.rows.map(toDto);
  });
}

export async function getRepositoryScan(scanId: string): Promise<RepositoryScanDto | null> {
  const row = await queryOne<RepositoryScanRow>(
    `SELECT ${COLUMNS} FROM analysis_job_repositories WHERE id = $1`,
    [scanId],
  );
  return row ? toDto(row) : null;
}

export async function listRepositoryScans(jobId: string): Promise<RepositoryScanDto[]> {
  return (await query<RepositoryScanRow>(
    `SELECT ${COLUMNS} FROM analysis_job_repositories WHERE job_id = $1 ORDER BY repo_full_name`,
    [jobId],
  )).map(toDto);
}

export async function markRepositoryScanRunning(scanId: string): Promise<RepositoryScanDto | null> {
  const rows = await query<RepositoryScanRow>(
    `UPDATE analysis_job_repositories
        SET status = 'running', progress = greatest(progress, 5), attempts = attempts + 1,
            started_at = coalesce(started_at, now()), updated_at = now(), error = NULL
      WHERE id = $1 AND status = 'queued'
      RETURNING ${COLUMNS}`,
    [scanId],
  );
  return rows[0] ? toDto(rows[0]) : null;
}

export async function markRepositoryScanProgress(scanId: string, progress: number): Promise<void> {
  await query(
    `UPDATE analysis_job_repositories SET progress = $2, updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [scanId, Math.max(0, Math.min(99, Math.round(progress)))],
  );
}

export async function markRepositoryScanSucceeded(
  scanId: string,
  input: {
    graphArtifactKey: string;
    interfaceCatalogArtifactKey: string;
    impactArtifactKey: string | null;
    credits: number;
  },
): Promise<void> {
  await query(
    `UPDATE analysis_job_repositories
        SET status = 'succeeded', progress = 100, graph_oss_key = $2,
            interface_catalog_oss_key = $3, impact_oss_key = $4, credits = $5,
            finished_at = now(), updated_at = now(), error = NULL
      WHERE id = $1`,
    [scanId, input.graphArtifactKey, input.interfaceCatalogArtifactKey, input.impactArtifactKey, input.credits],
  );
}

export async function requeueRepositoryScan(scanId: string, error: string): Promise<void> {
  await query(
    `UPDATE analysis_job_repositories
        SET status = 'queued', progress = 0, error = $2, updated_at = now()
      WHERE id = $1`,
    [scanId, error.slice(0, 2000)],
  );
}

export async function markRepositoryScanFailed(scanId: string, error: string): Promise<void> {
  await query(
    `UPDATE analysis_job_repositories
        SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [scanId, error.slice(0, 2000)],
  );
}

export async function listStaleRepositoryScans(
  olderThanSeconds = 30,
  limit = 20,
): Promise<RepositoryScanDto[]> {
  return (await query<RepositoryScanRow>(
    `SELECT ${COLUMNS} FROM analysis_job_repositories
      WHERE status = 'queued' AND updated_at < now() - ($1 || ' seconds')::interval
      ORDER BY updated_at LIMIT $2`,
    [String(olderThanSeconds), limit],
  )).map(toDto);
}

/** Worker 在崩溃恢复或合并锁竞争后，重新收口所有已结束的仓库子任务。 */
export async function listFinalizableRepositoryJobIds(limit = 20): Promise<string[]> {
  const rows = await query<{ job_id: string }>(
    `SELECT scans.job_id
       FROM analysis_job_repositories scans
       JOIN analysis_jobs jobs ON jobs.id = scans.job_id
      WHERE jobs.status = 'running'
      GROUP BY scans.job_id
     HAVING count(*) > 0
        AND bool_and(scans.status IN ('succeeded', 'failed'))
      ORDER BY max(scans.updated_at)
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.job_id);
}
