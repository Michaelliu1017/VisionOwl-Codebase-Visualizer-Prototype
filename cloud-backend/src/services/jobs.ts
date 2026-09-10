/**
 * Job Service（契约 §4.5 / spec §4.3、§11.2）
 * 职责：任务创建（去重 + 去抖）、状态跟踪、入队；事件推送交给 SSE Hub。
 */
import { isUniqueViolation, query, queryOne } from "../infra/pg";
import { enqueueJob, shouldAcceptDebounced } from "../infra/redis";
import { config } from "../config";
import { duplicate, notFound } from "../lib/errors";
import { encodeCursor, type Cursor } from "../lib/pagination";
import { iso, isoReq } from "../lib/time";
import { sseHub } from "../realtime/sseHub";
import type { JobDto, JobStatus, JobType } from "../types";
import { audit } from "./audit";

interface JobRow {
  id: string;
  project_id: string;
  type: string;
  status: string;
  base_commit_sha: string | null;
  target_commit_sha: string | null;
  repository_commits: Record<string, string> | null;
  progress: number;
  error: string | null;
  credits: string | null;
  force_reanalysis: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const JOB_COLUMNS = `id, project_id, type, status, base_commit_sha, target_commit_sha, repository_commits,
                     progress, error, credits, force_reanalysis, created_at, started_at, finished_at`;

function toDto(row: JobRow): JobDto {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    progress: Number(row.progress ?? 0),
    baseCommitSha: row.base_commit_sha,
    targetCommitSha: row.target_commit_sha,
    repositoryCommits: row.repository_commits ?? {},
    error: row.error,
    credits: row.credits === null ? null : Number(row.credits),
    forceReanalysis: row.force_reanalysis,
    createdAt: isoReq(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

export function dedupKey(projectId: string, targetSha: string | null, type: JobType): string | null {
  return targetSha ? `${projectId}:${targetSha}:${type}` : null;
}

export interface CreateJobInput {
  projectId: string;
  type: JobType;
  actorId: string | null;
  targetCommitSha?: string | null;
  baseCommitSha?: string | null;
  /** 本次任务冻结的 repositoryId/repoFullName -> commit SHA。 */
  repositoryCommits?: Record<string, string>;
  /** Webhook 触发时开启去抖（同分支连续 push 合并到最新 SHA） */
  debounce?: boolean;
  /** 跳过同 commit 任务去重与图谱复用，仅用于用户确认后的全量重算。 */
  forceReanalysis?: boolean;
  ip?: string | null;
}

export interface CreateJobResult {
  job: JobDto;
  /** 去抖窗口内被合并，未创建新任务 */
  debounced?: boolean;
}

/**
 * 创建任务。
 * - dedup 命中 → 409 DUPLICATE，details.jobId 带上已有任务（契约 §4.5 + §13 缺口 4）
 * - debounce 命中 → 返回 debounced 标记，调用方按 202 处理但不新建任务
 */
export async function createJob(input: CreateJobInput): Promise<CreateJobResult> {
  const targetSha = input.targetCommitSha ?? null;
  const key = input.forceReanalysis ? null : dedupKey(input.projectId, targetSha, input.type);

  if (key) {
    const existing = await queryOne<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE dedup_key = $1`,
      [key],
    );
    if (existing) {
      throw duplicate("相同 commit 的同类型任务已存在", {
        jobId: existing.id,
        status: existing.status,
      });
    }
  }

  if (input.debounce) {
    const accepted = await shouldAcceptDebounced(input.projectId, config.jobDebounceSeconds);
    if (!accepted) {
      if (targetSha && key) {
        try {
          const rows = await query<JobRow>(
            `UPDATE analysis_jobs
                SET target_commit_sha = $2,
                    base_commit_sha = coalesce(base_commit_sha, $3),
                    dedup_key = $4,
                    repository_commits = $5::jsonb
              WHERE id = (
                SELECT id FROM analysis_jobs
                 WHERE project_id = $1 AND type = 'incremental' AND status = 'queued'
                 ORDER BY created_at DESC LIMIT 1
              )
              RETURNING ${JOB_COLUMNS}`,
            [
              input.projectId,
              targetSha,
              input.baseCommitSha ?? null,
              key,
              JSON.stringify(input.repositoryCommits ?? {}),
            ],
          );
          const updated = rows[0];
          if (updated) {
            const dto = toDto(updated);
            sseHub.emitAsync(dto.projectId, "job.created", dto);
            return { job: dto, debounced: true };
          }
        } catch (err) {
          if (isUniqueViolation(err)) {
            const existing = await queryOne<JobRow>(
              `SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE dedup_key = $1`,
              [key],
            );
            if (existing) return { job: toDto(existing), debounced: true };
          }
          throw err;
        }
      }
      // 已有任务开始运行时不能篡改其目标 SHA；继续创建一个最新 SHA 任务，确保最终一致。
    }
  }

  let row: JobRow;
  try {
    const rows = await query<JobRow>(
      `INSERT INTO analysis_jobs
         (project_id, type, status, base_commit_sha, target_commit_sha, repository_commits,
          dedup_key, created_by, force_reanalysis)
       VALUES ($1, $2, 'queued', $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING ${JOB_COLUMNS}`,
      [
        input.projectId,
        input.type,
        input.baseCommitSha ?? null,
        targetSha,
        JSON.stringify(input.repositoryCommits ?? {}),
        key,
        input.actorId,
        input.forceReanalysis ?? false,
      ],
    );
    row = rows[0]!;
  } catch (err) {
    if (isUniqueViolation(err) && key) {
      const existing = await queryOne<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE dedup_key = $1`,
        [key],
      );
      throw duplicate("相同 commit 的同类型任务已存在", { jobId: existing?.id ?? null });
    }
    throw err;
  }

  const dto = toDto(row);

  // 入队失败不回滚任务：Worker 启动/巡检会捞起 queued 任务（韧性优先）
  try {
    await enqueueJob(dto.id, dto.projectId);
  } catch (err) {
    console.warn(
      `[jobs] 入队失败（任务保持 queued，等待 Worker 巡检）：${err instanceof Error ? err.message : err}`,
    );
  }

  sseHub.emitAsync(dto.projectId, "job.created", dto);
  await audit({
    projectId: input.projectId,
    actorId: input.actorId,
    action: "job.created",
    targetType: "job",
    targetId: dto.id,
    detail: {
      type: input.type,
      targetCommitSha: targetSha,
      forceReanalysis: input.forceReanalysis ?? false,
      repositoryCommits: input.repositoryCommits ?? {},
    },
    ip: input.ip,
  });

  return { job: dto };
}

export async function listJobs(
  projectId: string,
  limit: number,
  cursor: Cursor | null,
): Promise<{ items: JobDto[]; nextCursor: string | null }> {
  const params: unknown[] = [projectId];
  let where = `project_id = $1`;
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM analysis_jobs
      WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toDto),
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: isoReq(last.created_at), id: last.id }) : null,
  };
}

export async function getJobRaw(jobId: string): Promise<JobRow | null> {
  return queryOne<JobRow>(`SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE id = $1`, [jobId]);
}

export async function getJob(jobId: string): Promise<JobDto> {
  const row = await getJobRaw(jobId);
  if (!row) throw notFound("任务不存在");
  return toDto(row);
}

/** 任务归属的 projectId（api 层用于鉴权） */
export async function getJobProjectId(jobId: string): Promise<string | null> {
  const row = await queryOne<{ project_id: string }>(
    `SELECT project_id FROM analysis_jobs WHERE id = $1`,
    [jobId],
  );
  return row?.project_id ?? null;
}

// ── Worker 侧状态流转 ─────────────────────────────────────────────────
export async function markRunning(jobId: string): Promise<JobDto | null> {
  const rows = await query<JobRow>(
    `UPDATE analysis_jobs SET status = 'running', started_at = coalesce(started_at, now()), progress = 5
      WHERE id = $1 AND status = 'queued'
      RETURNING ${JOB_COLUMNS}`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  const dto = toDto(row);
  sseHub.emitAsync(dto.projectId, "job.progress", {
    id: dto.id,
    status: "running",
    progress: dto.progress,
  });
  return dto;
}

export async function markProgress(jobId: string, progress: number, note?: string): Promise<void> {
  const clamped = Math.max(0, Math.min(99, Math.round(progress)));
  const rows = await query<JobRow>(
    `UPDATE analysis_jobs SET progress = $2 WHERE id = $1 AND status = 'running'
      RETURNING ${JOB_COLUMNS}`,
    [jobId, clamped],
  );
  const row = rows[0];
  if (!row) return;
  sseHub.emitAsync(row.project_id, "job.progress", {
    id: row.id,
    status: "running",
    progress: clamped,
    ...(note ? { note } : {}),
  });
}

export async function setResolvedTargetSha(jobId: string, commitSha: string): Promise<void> {
  await query(
    `UPDATE analysis_jobs
        SET target_commit_sha = coalesce(target_commit_sha, $2)
      WHERE id = $1`,
    [jobId, commitSha],
  );
}

export async function setResolvedRepositorySnapshot(
  jobId: string,
  commitSha: string,
  repositoryCommits: Record<string, string>,
): Promise<void> {
  await query(
    `UPDATE analysis_jobs
        SET target_commit_sha = $2,
            repository_commits = $3::jsonb
      WHERE id = $1`,
    [jobId, commitSha, JSON.stringify(repositoryCommits)],
  );
}

export async function markSucceeded(jobId: string, credits: number | null): Promise<JobDto | null> {
  const rows = await query<JobRow>(
    `UPDATE analysis_jobs
        SET status = 'succeeded', progress = 100, finished_at = now(), credits = $2, error = NULL
      WHERE id = $1
      RETURNING ${JOB_COLUMNS}`,
    [jobId, credits],
  );
  const row = rows[0];
  if (!row) return null;
  const dto = toDto(row);
  sseHub.emitAsync(dto.projectId, "job.succeeded", dto);
  return dto;
}

export async function markFailed(
  jobId: string,
  message: string,
  credits: number | null = null,
): Promise<JobDto | null> {
  const rows = await query<JobRow>(
    `UPDATE analysis_jobs
        SET status = 'failed', finished_at = now(), error = $2, credits = coalesce($3, credits)
      WHERE id = $1
      RETURNING ${JOB_COLUMNS}`,
    [jobId, message.slice(0, 2000), credits],
  );
  const row = rows[0];
  if (!row) return null;
  const dto = toDto(row);
  sseHub.emitAsync(dto.projectId, "job.failed", dto);
  return dto;
}

/** Worker 巡检：捞起入队失败或超时未消费的 queued 任务 */
export async function listStaleQueuedJobs(olderThanSeconds = 30, limit = 20): Promise<JobDto[]> {
  const rows = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM analysis_jobs
      WHERE status = 'queued' AND created_at < now() - ($1 || ' seconds')::interval
      ORDER BY created_at LIMIT $2`,
    [String(olderThanSeconds), limit],
  );
  return rows.map(toDto);
}

/** 重启时把 running 但已失联的任务标失败（避免永久 running） */
export async function failStuckRunningJobs(olderThanSeconds: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE analysis_jobs
        SET status = 'failed', finished_at = now(), error = 'Worker 重启或任务超时，未收到结果'
      WHERE status = 'running' AND started_at < now() - ($1 || ' seconds')::interval
      RETURNING id`,
    [String(olderThanSeconds)],
  );
  return rows.length;
}
