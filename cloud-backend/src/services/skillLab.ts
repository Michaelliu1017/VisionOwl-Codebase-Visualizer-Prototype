import { createHash, randomUUID } from "node:crypto";
import { config } from "../config";
import { readArtifact } from "../infra/artifacts";
import { query, queryOne, withTx } from "../infra/pg";
import { enqueueSkillLabRun } from "../infra/redis";
import { downloadRepositoryArchive } from "../infra/githubApp";
import { badRequest, notFound } from "../lib/errors";
import { iso, isoReq } from "../lib/time";
import { sseHub } from "../realtime/sseHub";
import type { IncomingAsset } from "../schemas/knowledge";
import type { SkillLabRunDto } from "../types";
import { assertRunArtifact, verifyIncomingAsset } from "./knowledge";
import { bindingRepositoryKey, getBindingById, listBindings } from "./repository";

interface SkillRunRow {
  id: string;
  project_id: string;
  input_skill_version_id: string;
  baseline_version_id: string | null;
  output_skill_version_id: string | null;
  status: string;
  progress: number;
  stage: string | null;
  note: string | null;
  command_id: string;
  idempotency_key: string;
  evaluation_dataset_ref: string;
  optimization_policy: Record<string, unknown> | null;
  scores: Record<string, unknown> | null;
  report_artifact_key: string | null;
  diff_artifact_key: string | null;
  decision: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface SkillVersionRow {
  id: string;
  asset_id: string;
  project_id: string;
  status: string;
  source_graph_version_id: string;
  source_generation_run_id: string | null;
  repository_commits: Record<string, string> | null;
  bundle_artifact_key: string;
  manifest_artifact_key: string;
  checksum: string;
  summary: Record<string, unknown> | null;
}

const RUN_COLUMNS = `id, project_id, input_skill_version_id, baseline_version_id,
  output_skill_version_id, status, progress, stage, note, command_id, idempotency_key,
  evaluation_dataset_ref, optimization_policy, scores, report_artifact_key,
  diff_artifact_key, decision, error, created_at, started_at, finished_at`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toDto(row: SkillRunRow): SkillLabRunDto {
  return {
    id: row.id,
    projectId: row.project_id,
    inputSkillVersionId: row.input_skill_version_id,
    baselineVersionId: row.baseline_version_id,
    outputSkillVersionId: row.output_skill_version_id,
    status: row.status as SkillLabRunDto["status"],
    progress: Number(row.progress),
    stage: row.stage,
    note: row.note,
    evaluationDatasetRef: row.evaluation_dataset_ref,
    optimizationPolicy: row.optimization_policy ?? {},
    scores: row.scores ?? {},
    reportUrl: row.report_artifact_key
      ? `/api/projects/${row.project_id}/skilllab-runs/${row.id}/report`
      : null,
    diffUrl: row.diff_artifact_key
      ? `/api/projects/${row.project_id}/skilllab-runs/${row.id}/diff`
      : null,
    decision: row.decision as "accepted" | "rejected" | null,
    error: row.error,
    createdAt: isoReq(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

async function getInputVersion(versionId: string): Promise<SkillVersionRow> {
  const row = await queryOne<SkillVersionRow>(
    `SELECT v.id, v.asset_id, v.project_id, v.status, v.source_graph_version_id,
            v.source_generation_run_id, v.repository_commits, v.bundle_artifact_key,
            v.manifest_artifact_key, v.checksum, v.summary
       FROM knowledge_asset_versions v
       JOIN knowledge_assets a ON a.id = v.asset_id
      WHERE v.id = $1 AND a.kind = 'skills'`,
    [versionId],
  );
  if (!row) throw notFound("候选 Skill 版本不存在");
  return row;
}

export async function createSkillLabRun(
  projectId: string,
  inputSkillVersionId: string,
): Promise<SkillLabRunDto> {
  const version = await getInputVersion(inputSkillVersionId);
  if (version.project_id !== projectId) throw notFound("候选 Skill 版本不存在");
  const asset = await queryOne<{ current_version_id: string | null }>(
    `SELECT current_version_id FROM knowledge_assets WHERE id = $1`,
    [version.asset_id],
  );
  const policy = {
    maxRounds: config.skillLabMaxRounds,
    maxPatchesPerRound: config.skillLabMaxPatchesPerRound,
    updateMode: "patch",
    requireValidationImprovement: true,
  };
  const idempotencyKey = sha256(
    `${projectId}:${inputSkillVersionId}:${config.skillLabEvaluationDatasetRef}:${JSON.stringify(policy)}`,
  );
  const existing = await queryOne<SkillRunRow>(
    `SELECT ${RUN_COLUMNS} FROM skill_evaluation_runs WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  if (existing) return toDto(existing);

  const row = await queryOne<SkillRunRow>(
    `INSERT INTO skill_evaluation_runs
       (project_id, input_skill_version_id, baseline_version_id, command_id,
        idempotency_key, evaluation_dataset_ref, optimization_policy)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING ${RUN_COLUMNS}`,
    [
      projectId,
      inputSkillVersionId,
      asset?.current_version_id ?? null,
      randomUUID(),
      idempotencyKey,
      config.skillLabEvaluationDatasetRef,
      JSON.stringify(policy),
    ],
  );
  if (!row) throw new Error("创建 Skill Lab 任务失败");
  await query(
    `UPDATE knowledge_assets SET status = 'updating', last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [version.asset_id],
  );
  const dto = toDto(row);
  sseHub.emitAsync(projectId, "skilllab.run.updated", dto);
  await dispatchSkillLabRun(dto.id).catch(() => undefined);
  return dto;
}

export async function getSkillLabRun(projectId: string, runId: string): Promise<SkillLabRunDto> {
  const row = await queryOne<SkillRunRow>(
    `SELECT ${RUN_COLUMNS} FROM skill_evaluation_runs WHERE project_id = $1 AND id = $2`,
    [projectId, runId],
  );
  if (!row) throw notFound("Skill Lab 任务不存在");
  return toDto(row);
}

export async function getSkillLabRunById(runId: string): Promise<SkillLabRunDto> {
  const row = await queryOne<SkillRunRow>(
    `SELECT ${RUN_COLUMNS} FROM skill_evaluation_runs WHERE id = $1`,
    [runId],
  );
  if (!row) throw notFound("Skill Lab 任务不存在");
  return toDto(row);
}

export async function getSkillLabRunCommand(runId: string): Promise<Record<string, unknown>> {
  const run = await queryOne<SkillRunRow>(
    `SELECT ${RUN_COLUMNS} FROM skill_evaluation_runs WHERE id = $1`,
    [runId],
  );
  if (!run) throw notFound("Skill Lab 任务不存在");
  const input = await getInputVersion(run.input_skill_version_id);
  const baseline = run.baseline_version_id ? await getInputVersion(run.baseline_version_id) : null;
  const bindings = await listBindings(run.project_id);
  return {
    schemaVersion: "1.0",
    commandId: run.command_id,
    idempotencyKey: run.idempotency_key,
    deadlineAt: new Date(
      run.created_at.getTime() + config.skillLabRunTimeoutSeconds * 1000,
    ).toISOString(),
    callbackAuth: {
      type: "service-token",
      header: "X-VisionOwl-Service-Token",
      tokenRef: "env:INTEGRATION_SERVICE_TOKEN",
    },
    runId: run.id,
    status: run.status,
    projectId: run.project_id,
    inputSkillVersionId: input.id,
    inputSkillArtifactKey: input.bundle_artifact_key,
    inputSkillManifestKey: input.manifest_artifact_key,
    inputSkillDownloadPath: `/internal/v1/skilllab-runs/${run.id}/input/skill`,
    baselineVersionId: baseline?.id ?? null,
    baselineArtifactKey: baseline?.bundle_artifact_key ?? null,
    baselineDownloadPath: baseline ? `/internal/v1/skilllab-runs/${run.id}/input/baseline` : null,
    evaluationDatasetRef: run.evaluation_dataset_ref,
    repositorySnapshots: bindings.map((binding) => ({
      bindingId: binding.id,
      repositoryKey: bindingRepositoryKey(binding),
      repoFullName: binding.repoFullName,
      branch: binding.branch,
      commitSha: (input.repository_commits ?? {})[bindingRepositoryKey(binding)]
        ?? binding.currentCommitSha,
      archiveDownloadPath: `/internal/v1/skilllab-runs/${run.id}/input/repositories/${binding.id}/archive?sha={sha}`,
    })),
    optimizationPolicy: run.optimization_policy ?? {},
    artifactUploadPath: `/internal/v1/integration-runs/${run.id}/artifacts/{fileName}`,
    callbacks: {
      progress: `/internal/v1/skilllab-runs/${run.id}/progress`,
      complete: `/internal/v1/skilllab-runs/${run.id}/complete`,
      fail: `/internal/v1/skilllab-runs/${run.id}/fail`,
    },
  };
}

export async function readSkillLabRepositoryArchive(
  runId: string,
  bindingId: string,
  commitSha: string,
): Promise<Buffer> {
  const run = await queryOne<{ project_id: string }>(
    `SELECT project_id FROM skill_evaluation_runs WHERE id = $1`,
    [runId],
  );
  if (!run) throw notFound("Skill Lab 任务不存在");
  const binding = await getBindingById(run.project_id, bindingId);
  if (!binding) throw notFound("Skill Lab 仓库绑定不存在");
  return downloadRepositoryArchive(
    binding.repoFullName,
    commitSha,
    binding.installationId,
    config.skillLabSourceArchiveMaxBytes,
  );
}

export async function readSkillLabInput(
  runId: string,
  target: "skill" | "baseline",
): Promise<Buffer> {
  const run = await queryOne<{ input_skill_version_id: string; baseline_version_id: string | null }>(
    `SELECT input_skill_version_id, baseline_version_id FROM skill_evaluation_runs WHERE id = $1`,
    [runId],
  );
  if (!run) throw notFound("Skill Lab 任务不存在");
  const versionId = target === "skill" ? run.input_skill_version_id : run.baseline_version_id;
  if (!versionId) throw notFound("该任务没有基线 Skill");
  const version = await getInputVersion(versionId);
  return readArtifact(version.bundle_artifact_key);
}

export async function updateSkillLabRunProgress(
  runId: string,
  input: {
    status: "evaluating" | "optimizing" | "validating";
    progress: number;
    stage?: string;
    note?: string;
  },
): Promise<SkillLabRunDto> {
  const row = await queryOne<SkillRunRow>(
    `UPDATE skill_evaluation_runs
        SET status = $2, progress = $3, stage = $4, note = $5,
            started_at = coalesce(started_at, now()), updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'evaluating', 'optimizing', 'validating')
      RETURNING ${RUN_COLUMNS}`,
    [runId, input.status, input.progress, input.stage ?? null, input.note ?? null],
  );
  if (!row) return getSkillLabRunById(runId);
  const dto = toDto(row);
  sseHub.emitAsync(dto.projectId, "skilllab.run.updated", dto);
  return dto;
}

export async function completeSkillLabRun(input: {
  runId: string;
  decision: "accepted" | "rejected";
  scores: Record<string, unknown>;
  reportArtifactKey?: string;
  diffArtifactKey?: string;
  output?: IncomingAsset;
  note?: string;
}): Promise<SkillLabRunDto> {
  const current = await getSkillLabRunById(input.runId);
  if (["succeeded", "rejected"].includes(current.status)) return current;
  if (current.status === "failed") throw badRequest("Skill Lab 任务已经失败");
  if (input.reportArtifactKey) {
    await assertRunArtifact(current.projectId, input.runId, input.reportArtifactKey);
  }
  if (input.diffArtifactKey) {
    await assertRunArtifact(current.projectId, input.runId, input.diffArtifactKey);
  }
  const output = input.output
    ? await verifyIncomingAsset(current.projectId, input.runId, input.output)
    : null;
  if (input.decision === "rejected" && output) {
    throw badRequest("rejected 结果不能发布 output Skill");
  }

  const inputVersion = await getInputVersion(current.inputSkillVersionId);
  let outputVersionId: string | null = null;
  await withTx(async (client) => {
    const lockedRun = await client.query<{ status: string }>(
      `SELECT status FROM skill_evaluation_runs WHERE id = $1 FOR UPDATE`,
      [input.runId],
    );
    if (!lockedRun.rows[0] || lockedRun.rows[0].status === "failed") {
      throw badRequest("Skill Lab 任务当前不可发布");
    }
    const assetResult = await client.query<{ current_version_id: string | null }>(
      `SELECT current_version_id FROM knowledge_assets WHERE id = $1 FOR UPDATE`,
      [inputVersion.asset_id],
    );
    const currentVersionId = assetResult.rows[0]?.current_version_id ?? null;

    if (input.decision === "rejected") {
      await client.query(
        `UPDATE knowledge_asset_versions SET status = 'rejected'
          WHERE id = $1 AND status = 'candidate'`,
        [inputVersion.id],
      );
      await client.query(
        `UPDATE knowledge_assets
            SET status = CASE WHEN current_version_id IS NULL THEN 'failed' ELSE 'ready' END,
                last_error = $2, updated_at = now()
          WHERE id = $1`,
        [inputVersion.asset_id, input.note ?? "Skill Lab 未接受候选版本"],
      );
    } else if (output) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO knowledge_asset_versions
           (asset_id, project_id, version_no, status, source_graph_version_id,
            source_generation_run_id, repository_commits, bundle_artifact_key,
            manifest_artifact_key, checksum, summary)
         SELECT $1, $2,
                coalesce((SELECT max(version_no) FROM knowledge_asset_versions WHERE asset_id = $1), 0) + 1,
                'published', $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb
         RETURNING id`,
        [
          inputVersion.asset_id,
          current.projectId,
          inputVersion.source_graph_version_id,
          inputVersion.source_generation_run_id,
          JSON.stringify(inputVersion.repository_commits ?? {}),
          output.input.bundleArtifactKey,
          output.input.manifestArtifactKey,
          output.input.checksum.toLowerCase(),
          JSON.stringify(output.input.summary),
        ],
      );
      outputVersionId = inserted.rows[0]!.id;
      await client.query(
        `UPDATE knowledge_asset_versions SET status = 'superseded'
          WHERE id = ANY($1::uuid[]) AND status IN ('candidate', 'published')`,
        [[inputVersion.id, ...(currentVersionId ? [currentVersionId] : [])]],
      );
    } else {
      outputVersionId = inputVersion.id;
      if (currentVersionId && currentVersionId !== inputVersion.id) {
        await client.query(
          `UPDATE knowledge_asset_versions SET status = 'superseded'
            WHERE id = $1 AND status = 'published'`,
          [currentVersionId],
        );
      }
      await client.query(
        `UPDATE knowledge_asset_versions SET status = 'published' WHERE id = $1`,
        [inputVersion.id],
      );
    }

    if (input.decision === "accepted" && outputVersionId) {
      await client.query(
        `UPDATE knowledge_assets
            SET current_version_id = $2, status = 'ready', last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [inputVersion.asset_id, outputVersionId],
      );
    }
    await client.query(
      `UPDATE skill_evaluation_runs
          SET status = $2, progress = 100, stage = 'completed', note = $3,
              output_skill_version_id = $4, scores = $5::jsonb,
              report_artifact_key = $6, diff_artifact_key = $7,
              decision = $8, error = NULL,
              started_at = coalesce(started_at, now()), finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [
        input.runId,
        input.decision === "accepted" ? "succeeded" : "rejected",
        input.note ?? null,
        outputVersionId,
        JSON.stringify(input.scores),
        input.reportArtifactKey ?? null,
        input.diffArtifactKey ?? null,
        input.decision,
      ],
    );
  });

  const dto = await getSkillLabRunById(input.runId);
  sseHub.emitAsync(dto.projectId, "skilllab.run.updated", dto);
  if (dto.decision === "accepted" && dto.outputSkillVersionId) {
    sseHub.emitAsync(dto.projectId, "skill.version.published", {
      runId: dto.id,
      versionId: dto.outputSkillVersionId,
    });
  }
  return dto;
}

export async function failSkillLabRun(runId: string, error: string): Promise<SkillLabRunDto> {
  const current = await getSkillLabRunById(runId);
  if (["succeeded", "rejected", "failed"].includes(current.status)) return current;
  const inputVersion = await getInputVersion(current.inputSkillVersionId);
  await withTx(async (client) => {
    await client.query(
      `UPDATE skill_evaluation_runs
          SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
        WHERE id = $1 AND status NOT IN ('succeeded', 'rejected', 'failed')`,
      [runId, error.slice(0, 2000)],
    );
    await client.query(
      `UPDATE knowledge_assets
          SET status = CASE WHEN current_version_id IS NULL THEN 'failed' ELSE 'ready' END,
              last_error = $2, updated_at = now()
        WHERE id = $1`,
      [inputVersion.asset_id, error.slice(0, 2000)],
    );
  });
  const dto = await getSkillLabRunById(runId);
  sseHub.emitAsync(dto.projectId, "skilllab.run.updated", dto);
  return dto;
}

export async function dispatchSkillLabRun(runId: string): Promise<void> {
  const run = await getSkillLabRunById(runId);
  if (run.status !== "queued") return;
  const identity = await queryOne<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM skill_evaluation_runs WHERE id = $1`,
    [runId],
  );
  if (!identity) throw notFound("Skill Lab 任务不存在");
  await enqueueSkillLabRun(run.id, run.projectId, identity.idempotency_key);
  await query(`UPDATE skill_evaluation_runs SET dispatched_at = now() WHERE id = $1`, [runId]);
}

export async function failTimedOutSkillLabRuns(): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM skill_evaluation_runs
      WHERE status IN ('queued', 'evaluating', 'optimizing', 'validating')
        AND coalesce(started_at, created_at) < now() - ($1 * interval '1 second')
      ORDER BY created_at LIMIT 100`,
    [config.skillLabRunTimeoutSeconds],
  );
  for (const row of rows) {
    await failSkillLabRun(row.id, "Skill Lab 执行超时").catch(() => undefined);
  }
}

export async function readSkillLabArtifact(
  projectId: string,
  runId: string,
  kind: "report" | "diff",
): Promise<Buffer> {
  const row = await queryOne<{ report_artifact_key: string | null; diff_artifact_key: string | null }>(
    `SELECT report_artifact_key, diff_artifact_key
       FROM skill_evaluation_runs WHERE project_id = $1 AND id = $2`,
    [projectId, runId],
  );
  if (!row) throw notFound("Skill Lab 任务不存在");
  const key = kind === "report" ? row.report_artifact_key : row.diff_artifact_key;
  if (!key) throw notFound(kind === "report" ? "评测报告不存在" : "Skill Diff 不存在");
  return readArtifact(key);
}
