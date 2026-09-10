import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "../config";
import {
  artifactExists,
  integrationArtifactKey,
  readArtifact,
  readJsonArtifact,
  writeArtifact,
} from "../infra/artifacts";
import { query, queryOne, withTx } from "../infra/pg";
import { enqueueKnowledgeRun, enqueueSkillLabRun } from "../infra/redis";
import { badRequest, notFound } from "../lib/errors";
import { iso, isoReq } from "../lib/time";
import { sseHub } from "../realtime/sseHub";
import {
  assetManifestSchema,
  type AssetManifest,
  type IncomingAsset,
} from "../schemas/knowledge";
import type {
  KnowledgeAssetKind,
  KnowledgeAssetStatus,
  KnowledgeAssetSummaryDto,
  KnowledgeAssetVersionDto,
  KnowledgeRunDto,
} from "../types";
import { bindingRepositoryKey, listBindings } from "./repository";

interface AssetRow {
  asset_id: string;
  project_id: string;
  kind: string;
  asset_status: string;
  last_error: string | null;
  updated_at: Date;
  version_id: string | null;
  version_no: number | null;
  version_status: string | null;
  source_graph_version_id: string | null;
  source_graph_version_no: number | null;
  source_commit_sha: string | null;
  repository_commits: Record<string, string> | null;
  bundle_artifact_key: string | null;
  manifest_artifact_key: string | null;
  checksum: string | null;
  summary: Record<string, unknown> | null;
  version_created_at: Date | null;
}

interface VersionRow {
  id: string;
  asset_id: string;
  project_id: string;
  version_no: number;
  status: string;
  source_graph_version_id: string;
  source_graph_version_no: number;
  source_commit_sha: string;
  repository_commits: Record<string, string> | null;
  bundle_artifact_key: string;
  manifest_artifact_key: string;
  checksum: string;
  summary: Record<string, unknown> | null;
  created_at: Date;
}

interface KnowledgeRunRow {
  id: string;
  project_id: string;
  graph_version_id: string;
  graph_version_no: number;
  requested_assets: string[];
  status: string;
  progress: number;
  stage: string | null;
  note: string | null;
  command_id: string;
  idempotency_key: string;
  output_version_ids: string[] | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface GraphInputRow {
  id: string;
  project_id: string;
  version_no: number;
  commit_sha: string;
  repository_commits: Record<string, string> | null;
  artifact_oss_key: string;
}

export interface VerifiedIncomingAsset {
  input: IncomingAsset;
  manifest: AssetManifest;
}

const ASSET_SELECT = `
  SELECT a.id AS asset_id, a.project_id, a.kind, a.status AS asset_status,
         a.last_error, a.updated_at,
         v.id AS version_id, v.version_no, v.status AS version_status,
         v.source_graph_version_id, gv.version_no AS source_graph_version_no,
         gv.commit_sha AS source_commit_sha, v.repository_commits,
         v.bundle_artifact_key, v.manifest_artifact_key, v.checksum, v.summary,
         v.created_at AS version_created_at
    FROM knowledge_assets a
    LEFT JOIN knowledge_asset_versions v ON v.id = a.current_version_id
    LEFT JOIN graph_versions gv ON gv.id = v.source_graph_version_id
`;

const VERSION_SELECT = `
  SELECT v.id, v.asset_id, v.project_id, v.version_no, v.status,
         v.source_graph_version_id, gv.version_no AS source_graph_version_no,
         gv.commit_sha AS source_commit_sha, v.repository_commits,
         v.bundle_artifact_key, v.manifest_artifact_key, v.checksum, v.summary, v.created_at
    FROM knowledge_asset_versions v
    JOIN graph_versions gv ON gv.id = v.source_graph_version_id
`;

const RUN_SELECT = `
  SELECT r.id, r.project_id, r.graph_version_id, gv.version_no AS graph_version_no,
         r.requested_assets, r.status, r.progress, r.stage, r.note, r.command_id, r.idempotency_key,
         r.output_version_ids, r.error, r.created_at, r.started_at, r.finished_at
    FROM knowledge_generation_runs r
    JOIN graph_versions gv ON gv.id = r.graph_version_id
`;

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Wiki 始终直接发布；首版 Skill 直接发布，后续 Skill 先进入评估优化。 */
export function knowledgeAssetVersionStatus(
  kind: KnowledgeAssetKind,
  hasCurrentVersion: boolean,
): "candidate" | "published" {
  return kind === "skills" && hasCurrentVersion ? "candidate" : "published";
}

function runDto(row: KnowledgeRunRow): KnowledgeRunDto {
  return {
    id: row.id,
    projectId: row.project_id,
    graphVersionId: row.graph_version_id,
    graphVersionNo: row.graph_version_no,
    requestedAssets: row.requested_assets as KnowledgeAssetKind[],
    status: row.status as KnowledgeRunDto["status"],
    progress: Number(row.progress),
    stage: row.stage,
    note: row.note,
    outputVersionIds: row.output_version_ids ?? [],
    error: row.error,
    createdAt: isoReq(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

function versionDto(row: VersionRow): KnowledgeAssetVersionDto {
  return {
    id: row.id,
    version: row.version_no,
    status: row.status as KnowledgeAssetVersionDto["status"],
    sourceGraphVersionId: row.source_graph_version_id,
    sourceGraphVersionNo: row.source_graph_version_no,
    sourceCommitSha: row.source_commit_sha,
    repositoryCommits: row.repository_commits ?? {},
    checksum: row.checksum,
    summary: row.summary ?? {},
    createdAt: isoReq(row.created_at),
  };
}

function runArtifactPrefix(projectId: string, runId: string): string {
  return `visionowl/integrations/${projectId}/${runId}/`;
}

export async function ensureProjectKnowledgeAssets(projectId: string): Promise<void> {
  await query(
    `INSERT INTO knowledge_assets (project_id, kind)
     VALUES ($1, 'wiki'), ($1, 'skills')
     ON CONFLICT (project_id, kind) DO NOTHING`,
    [projectId],
  );
}

async function readManifestOrEmpty(key: string | null): Promise<AssetManifest | null> {
  if (!key) return null;
  try {
    const raw = await readJsonArtifact<unknown>(key);
    const parsed = assetManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function listKnowledgeAssets(projectId: string): Promise<KnowledgeAssetSummaryDto[]> {
  await ensureProjectKnowledgeAssets(projectId);
  const rows = await query<AssetRow>(
    `${ASSET_SELECT} WHERE a.project_id = $1 ORDER BY CASE a.kind WHEN 'wiki' THEN 1 ELSE 2 END`,
    [projectId],
  );
  return Promise.all(rows.map(async (row) => {
    const manifest = await readManifestOrEmpty(row.manifest_artifact_key);
    return {
      id: row.asset_id,
      projectId: row.project_id,
      kind: row.kind as KnowledgeAssetKind,
      status: row.asset_status as KnowledgeAssetStatus,
      version: row.version_no,
      versionId: row.version_id,
      sourceGraphVersionId: row.source_graph_version_id,
      sourceGraphVersionNo: row.source_graph_version_no,
      sourceCommitSha: row.source_commit_sha,
      repositoryCommits: row.repository_commits ?? {},
      entries: (manifest?.files ?? []).map((file) => ({
        id: file.id,
        title: file.title,
        path: file.path,
        mediaType: file.mediaType,
        size: file.size ?? null,
      })),
      downloadUrl: row.version_id
        ? `/api/projects/${projectId}/knowledge-assets/${row.asset_id}/download`
        : null,
      error: row.last_error,
      updatedAt: isoReq(row.updated_at),
    };
  }));
}

async function getAssetRow(projectId: string, assetId: string): Promise<AssetRow> {
  const row = await queryOne<AssetRow>(
    `${ASSET_SELECT} WHERE a.project_id = $1 AND a.id = $2`,
    [projectId, assetId],
  );
  if (!row) throw notFound("知识资产不存在");
  return row;
}

export async function listKnowledgeAssetVersions(
  projectId: string,
  assetId: string,
): Promise<KnowledgeAssetVersionDto[]> {
  await getAssetRow(projectId, assetId);
  const rows = await query<VersionRow>(
    `${VERSION_SELECT} WHERE v.project_id = $1 AND v.asset_id = $2 ORDER BY v.version_no DESC`,
    [projectId, assetId],
  );
  return rows.map(versionDto);
}

export async function getKnowledgeAssetManifest(
  projectId: string,
  assetId: string,
): Promise<AssetManifest> {
  const row = await getAssetRow(projectId, assetId);
  if (!row.manifest_artifact_key) throw notFound("知识资产尚未生成");
  const parsed = assetManifestSchema.safeParse(
    await readJsonArtifact<unknown>(row.manifest_artifact_key),
  );
  if (!parsed.success) throw badRequest("知识资产目录损坏");
  return parsed.data;
}

export async function readKnowledgeAssetContent(
  projectId: string,
  assetId: string,
  targetPath: string,
): Promise<{ content: Buffer; mediaType: string; fileName: string }> {
  const manifest = await getKnowledgeAssetManifest(projectId, assetId);
  const file = manifest.files.find((entry) => entry.path === targetPath);
  if (!file) throw notFound("知识资产文件不存在");
  const row = await getAssetRow(projectId, assetId);
  if (!file.artifactKey.startsWith(`visionowl/integrations/${projectId}/`)) {
    throw notFound("知识资产文件不属于该项目");
  }
  if (!row.version_id) throw notFound("知识资产尚未生成");
  return {
    content: await readArtifact(file.artifactKey),
    mediaType: file.mediaType,
    fileName: file.path.split("/").pop() ?? "asset.txt",
  };
}

export async function readKnowledgeAssetBundle(
  projectId: string,
  assetId: string,
): Promise<{ content: Buffer; fileName: string }> {
  const row = await getAssetRow(projectId, assetId);
  if (!row.bundle_artifact_key || !row.version_no) throw notFound("知识资产尚未生成");
  return {
    content: await readArtifact(row.bundle_artifact_key),
    fileName: `${row.kind}-v${row.version_no}.zip`,
  };
}

async function currentGraphInput(projectId: string, versionNo?: number): Promise<GraphInputRow> {
  const row = versionNo === undefined
    ? await queryOne<GraphInputRow>(
        `SELECT id, project_id, version_no, commit_sha, repository_commits, artifact_oss_key
           FROM graph_versions
          WHERE id = (SELECT current_graph_version_id FROM projects WHERE id = $1)`,
        [projectId],
      )
    : await queryOne<GraphInputRow>(
        `SELECT id, project_id, version_no, commit_sha, repository_commits, artifact_oss_key
           FROM graph_versions WHERE project_id = $1 AND version_no = $2`,
        [projectId, versionNo],
      );
  if (!row) throw badRequest("项目尚无可用于知识生成的图谱版本");
  return row;
}

function knowledgeIdempotencyKey(
  projectId: string,
  graphVersionId: string,
  requestedAssets: KnowledgeAssetKind[],
): string {
  return sha256(`${projectId}:${graphVersionId}:${[...requestedAssets].sort().join(",")}`);
}

export async function createKnowledgeRun(input: {
  projectId: string;
  actorId: string | null;
  requestedAssets: KnowledgeAssetKind[];
  force?: boolean;
  graphVersionNo?: number;
}): Promise<KnowledgeRunDto> {
  await ensureProjectKnowledgeAssets(input.projectId);
  const graph = await currentGraphInput(input.projectId, input.graphVersionNo);
  const requestedAssets = [...new Set(input.requestedAssets)].sort() as KnowledgeAssetKind[];
  const baseKey = knowledgeIdempotencyKey(input.projectId, graph.id, requestedAssets);
  const existing = await queryOne<KnowledgeRunRow>(
    `${RUN_SELECT} WHERE r.idempotency_key = $1`,
    [baseKey],
  );
  if (existing && !input.force && !["failed", "canceled"].includes(existing.status)) {
    return runDto(existing);
  }

  const commandId = randomUUID();
  const idempotencyKey = input.force || existing ? `${baseKey}:${commandId}` : baseKey;
  const row = await queryOne<KnowledgeRunRow>(
    `WITH inserted AS (
       INSERT INTO knowledge_generation_runs
         (project_id, graph_version_id, requested_assets, command_id, idempotency_key, created_by)
       VALUES ($1, $2, $3::text[], $4, $5, $6)
       RETURNING *
     )
     SELECT i.id, i.project_id, i.graph_version_id, gv.version_no AS graph_version_no,
            i.requested_assets, i.status, i.progress, i.stage, i.note, i.command_id, i.idempotency_key,
            i.output_version_ids, i.error, i.created_at, i.started_at, i.finished_at
       FROM inserted i JOIN graph_versions gv ON gv.id = i.graph_version_id`,
    [input.projectId, graph.id, requestedAssets, commandId, idempotencyKey, input.actorId],
  );
  if (!row) throw new Error("创建知识生成任务失败");

  await query(
    `UPDATE knowledge_assets
        SET status = CASE WHEN current_version_id IS NULL THEN 'generating' ELSE 'updating' END,
            last_error = NULL, updated_at = now()
      WHERE project_id = $1 AND kind = ANY($2::text[])`,
    [input.projectId, requestedAssets],
  );
  const dto = runDto(row);
  sseHub.emitAsync(input.projectId, "knowledge.run.updated", dto);
  await dispatchKnowledgeRun(dto.id).catch(() => undefined);
  return dto;
}

export async function getKnowledgeRun(projectId: string, runId: string): Promise<KnowledgeRunDto> {
  const row = await queryOne<KnowledgeRunRow>(
    `${RUN_SELECT} WHERE r.project_id = $1 AND r.id = $2`,
    [projectId, runId],
  );
  if (!row) throw notFound("知识生成任务不存在");
  return runDto(row);
}

export async function getKnowledgeRunById(runId: string): Promise<KnowledgeRunDto> {
  const row = await queryOne<KnowledgeRunRow>(`${RUN_SELECT} WHERE r.id = $1`, [runId]);
  if (!row) throw notFound("知识生成任务不存在");
  return runDto(row);
}

export async function getKnowledgeRunCommand(runId: string): Promise<Record<string, unknown>> {
  const row = await queryOne<KnowledgeRunRow & GraphInputRow>(
    `SELECT r.id, r.project_id, r.graph_version_id, gv.version_no AS graph_version_no,
            r.requested_assets, r.status, r.progress, r.stage, r.note, r.command_id, r.idempotency_key,
            r.output_version_ids, r.error, r.created_at, r.started_at, r.finished_at,
            gv.commit_sha, gv.repository_commits, gv.artifact_oss_key
       FROM knowledge_generation_runs r
       JOIN graph_versions gv ON gv.id = r.graph_version_id
      WHERE r.id = $1`,
    [runId],
  );
  if (!row) throw notFound("知识生成任务不存在");
  const bindings = await listBindings(row.project_id);
  return {
    schemaVersion: "1.0",
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    deadlineAt: new Date(
      row.created_at.getTime() + config.knowledgeRunTimeoutSeconds * 1000,
    ).toISOString(),
    callbackAuth: {
      type: "service-token",
      header: "X-VisionOwl-Service-Token",
      tokenRef: "env:INTEGRATION_SERVICE_TOKEN",
    },
    runId: row.id,
    projectId: row.project_id,
    graphVersionId: row.graph_version_id,
    graphVersionNo: row.graph_version_no,
    graphArtifactKey: row.artifact_oss_key,
    graphDownloadPath: `/internal/v1/knowledge-runs/${row.id}/input/graph`,
    requestedAssets: row.requested_assets,
    repositorySnapshots: bindings.map((binding) => ({
      bindingId: binding.id,
      repositoryKey: bindingRepositoryKey(binding),
      repoFullName: binding.repoFullName,
      branch: binding.branch,
      commitSha: (row.repository_commits ?? {})[bindingRepositoryKey(binding)]
        ?? binding.currentCommitSha,
    })),
    artifactUploadPath: `/internal/v1/integration-runs/${row.id}/artifacts/{fileName}`,
    callbacks: {
      progress: `/internal/v1/knowledge-runs/${row.id}/progress`,
      complete: `/internal/v1/knowledge-runs/${row.id}/complete`,
      fail: `/internal/v1/knowledge-runs/${row.id}/fail`,
    },
  };
}

export async function readKnowledgeRunGraph(runId: string): Promise<Buffer> {
  const row = await queryOne<{ project_id: string; artifact_oss_key: string }>(
    `SELECT r.project_id, gv.artifact_oss_key
       FROM knowledge_generation_runs r
       JOIN graph_versions gv ON gv.id = r.graph_version_id
      WHERE r.id = $1`,
    [runId],
  );
  if (!row) throw notFound("知识生成任务不存在");
  if (!row.artifact_oss_key.startsWith(`visionowl/${row.project_id}/`)) {
    throw notFound("图谱产物不属于当前任务");
  }
  return readArtifact(row.artifact_oss_key);
}

export async function updateKnowledgeRunProgress(
  runId: string,
  input: { status: "running" | "publishing"; progress: number; stage?: string; note?: string },
): Promise<KnowledgeRunDto> {
  const row = await queryOne<KnowledgeRunRow>(
    `WITH updated AS (
       UPDATE knowledge_generation_runs
          SET status = $2, progress = $3, stage = $4, note = $5,
              started_at = coalesce(started_at, now()), updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'running', 'publishing')
        RETURNING *
     )
     SELECT u.id, u.project_id, u.graph_version_id, gv.version_no AS graph_version_no,
            u.requested_assets, u.status, u.progress, u.stage, u.note, u.command_id, u.idempotency_key,
            u.output_version_ids, u.error, u.created_at, u.started_at, u.finished_at
       FROM updated u JOIN graph_versions gv ON gv.id = u.graph_version_id`,
    [runId, input.status, input.progress, input.stage ?? null, input.note ?? null],
  );
  if (!row) return getKnowledgeRunById(runId);
  const dto = runDto(row);
  sseHub.emitAsync(dto.projectId, "knowledge.run.updated", dto);
  return dto;
}

export async function assertRunArtifact(
  projectId: string,
  runId: string,
  key: string,
): Promise<void> {
  if (!key.startsWith(runArtifactPrefix(projectId, runId))) {
    throw badRequest("回调引用了当前任务目录之外的产物");
  }
  if (!(await artifactExists(key))) throw badRequest(`产物不存在：${key}`);
}

export async function verifyIncomingAsset(
  projectId: string,
  runId: string,
  input: IncomingAsset,
): Promise<VerifiedIncomingAsset> {
  await Promise.all([
    assertRunArtifact(projectId, runId, input.bundleArtifactKey),
    assertRunArtifact(projectId, runId, input.manifestArtifactKey),
  ]);
  const bundle = await readArtifact(input.bundleArtifactKey);
  if (sha256(bundle) !== input.checksum.toLowerCase()) {
    throw badRequest(`${input.kind} bundle checksum 不一致`);
  }
  const parsed = assetManifestSchema.safeParse(
    await readJsonArtifact<unknown>(input.manifestArtifactKey),
  );
  if (!parsed.success || parsed.data.kind !== input.kind) {
    throw badRequest(`${input.kind} Manifest 格式或类型不匹配`);
  }
  for (const file of parsed.data.files) {
    await assertRunArtifact(projectId, runId, file.artifactKey);
    if (file.sha256) {
      const content = await readArtifact(file.artifactKey);
      if (sha256(content) !== file.sha256.toLowerCase()) {
        throw badRequest(`Manifest 文件 checksum 不一致：${file.path}`);
      }
    }
  }
  return { input, manifest: parsed.data };
}

async function insertAssetVersion(
  client: PoolClient,
  input: {
    projectId: string;
    kind: KnowledgeAssetKind;
    graphVersionId: string;
    generationRunId: string;
    repositoryCommits: Record<string, string>;
    artifact: IncomingAsset;
  },
): Promise<{ versionId: string; status: "candidate" | "published" }> {
  const asset = await client.query<{ id: string; current_version_id: string | null }>(
    `SELECT id, current_version_id FROM knowledge_assets
      WHERE project_id = $1 AND kind = $2 FOR UPDATE`,
    [input.projectId, input.kind],
  );
  const assetRow = asset.rows[0];
  if (!assetRow) throw new Error(`缺少 ${input.kind} 资产记录`);
  const status = knowledgeAssetVersionStatus(
    input.kind,
    assetRow.current_version_id !== null,
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO knowledge_asset_versions
       (asset_id, project_id, version_no, status, source_graph_version_id,
        source_generation_run_id, repository_commits, bundle_artifact_key,
        manifest_artifact_key, checksum, summary)
     SELECT $1, $2,
            coalesce((SELECT max(version_no) FROM knowledge_asset_versions WHERE asset_id = $1), 0) + 1,
            $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb
     RETURNING id`,
    [
      assetRow.id,
      input.projectId,
      status,
      input.graphVersionId,
      input.generationRunId,
      JSON.stringify(input.repositoryCommits),
      input.artifact.bundleArtifactKey,
      input.artifact.manifestArtifactKey,
      input.artifact.checksum.toLowerCase(),
      JSON.stringify(input.artifact.summary),
    ],
  );
  const versionId = inserted.rows[0]!.id;
  if (status === "published") {
    if (assetRow.current_version_id) {
      await client.query(
        `UPDATE knowledge_asset_versions SET status = 'superseded'
          WHERE id = $1 AND status = 'published'`,
        [assetRow.current_version_id],
      );
    }
    await client.query(
      `UPDATE knowledge_assets
          SET current_version_id = $2, status = 'ready', last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [assetRow.id, versionId],
    );
  } else {
    await client.query(
      `UPDATE knowledge_assets SET status = 'updating', last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [assetRow.id],
    );
  }
  return { versionId, status };
}

export async function completeKnowledgeRun(
  runId: string,
  artifacts: IncomingAsset[],
): Promise<{ run: KnowledgeRunDto; candidateSkillVersionIds: string[] }> {
  const current = await getKnowledgeRunById(runId);
  if (current.status === "succeeded") {
    const candidates = await query<{ id: string }>(
      `SELECT v.id
         FROM knowledge_asset_versions v
         JOIN knowledge_assets a ON a.id = v.asset_id
        WHERE v.id = ANY($1::uuid[]) AND a.kind = 'skills' AND v.status = 'candidate'`,
      [current.outputVersionIds],
    );
    return {
      run: current,
      candidateSkillVersionIds: candidates.map((row) => row.id),
    };
  }
  if (["failed", "canceled"].includes(current.status)) throw badRequest("知识生成任务已经结束");

  const kinds = artifacts.map((artifact) => artifact.kind);
  if (new Set(kinds).size !== kinds.length) throw badRequest("同一类型资产不能重复提交");
  const expected = [...current.requestedAssets].sort().join(",");
  if ([...kinds].sort().join(",") !== expected) throw badRequest("回调资产类型与任务请求不一致");
  const verified = await Promise.all(
    artifacts.map((artifact) => verifyIncomingAsset(current.projectId, runId, artifact)),
  );

  const graph = await queryOne<{ repository_commits: Record<string, string> | null }>(
    `SELECT repository_commits FROM graph_versions WHERE id = $1`,
    [current.graphVersionId],
  );
  if (!graph) throw notFound("任务绑定的图谱版本不存在");
  const candidateSkillVersionIds: string[] = [];
  const publishedAssets: Array<{ versionId: string; kind: KnowledgeAssetKind }> = [];
  await withTx(async (client) => {
    const locked = await client.query<{ status: string }>(
      `SELECT status FROM knowledge_generation_runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    if (!locked.rows[0] || ["failed", "canceled"].includes(locked.rows[0].status)) {
      throw badRequest("知识生成任务当前不可发布");
    }
    const ids: string[] = [];
    for (const item of verified) {
      const inserted = await insertAssetVersion(client, {
        projectId: current.projectId,
        kind: item.input.kind,
        graphVersionId: current.graphVersionId,
        generationRunId: runId,
        repositoryCommits: graph.repository_commits ?? {},
        artifact: item.input,
      });
      ids.push(inserted.versionId);
      if (inserted.status === "candidate") {
        candidateSkillVersionIds.push(inserted.versionId);
      } else {
        publishedAssets.push({ versionId: inserted.versionId, kind: item.input.kind });
      }
    }
    await client.query(
      `UPDATE knowledge_generation_runs
          SET status = 'succeeded', progress = 100, stage = 'completed',
              output_version_ids = $2::jsonb, error = NULL,
              started_at = coalesce(started_at, now()), finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [runId, JSON.stringify(ids)],
    );
  });

  const run = await getKnowledgeRunById(runId);
  sseHub.emitAsync(run.projectId, "knowledge.run.updated", run);
  for (const asset of publishedAssets) {
    sseHub.emitAsync(run.projectId, "knowledge.asset.published", asset);
  }
  return { run, candidateSkillVersionIds };
}

export async function failKnowledgeRun(runId: string, error: string): Promise<KnowledgeRunDto> {
  const current = await getKnowledgeRunById(runId);
  await withTx(async (client) => {
    await client.query(
      `UPDATE knowledge_generation_runs
          SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
        WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'canceled')`,
      [runId, error.slice(0, 2000)],
    );
    await client.query(
      `UPDATE knowledge_assets
          SET status = CASE WHEN current_version_id IS NULL THEN 'failed' ELSE 'ready' END,
              last_error = $2, updated_at = now()
        WHERE project_id = $1 AND kind = ANY($3::text[])`,
      [current.projectId, error.slice(0, 2000), current.requestedAssets],
    );
  });
  const run = await getKnowledgeRunById(runId);
  sseHub.emitAsync(run.projectId, "knowledge.run.updated", run);
  return run;
}

export async function getIntegrationRunContext(
  runId: string,
): Promise<{ module: "knowledge" | "skilllab"; projectId: string; status: string }> {
  const row = await queryOne<{ module: "knowledge" | "skilllab"; project_id: string; status: string }>(
    `SELECT 'knowledge'::text AS module, project_id, status
       FROM knowledge_generation_runs WHERE id = $1
     UNION ALL
     SELECT 'skilllab'::text AS module, project_id, status
       FROM skill_evaluation_runs WHERE id = $1
     LIMIT 1`,
    [runId],
  );
  if (!row) throw notFound("集成任务不存在");
  return { module: row.module, projectId: row.project_id, status: row.status };
}

export async function uploadIntegrationArtifact(
  runId: string,
  fileName: string,
  content: Buffer,
  expectedChecksum?: string,
): Promise<{ artifactKey: string; checksum: string; size: number }> {
  const context = await getIntegrationRunContext(runId);
  if (["succeeded", "rejected", "failed", "canceled"].includes(context.status)) {
    throw badRequest("集成任务已经结束，不能继续上传产物");
  }
  if (content.length > config.integrationArtifactMaxBytes) {
    throw badRequest("单个集成产物超过大小限制");
  }
  const actualChecksum = sha256(content);
  if (expectedChecksum && expectedChecksum.toLowerCase() !== actualChecksum) {
    throw badRequest("上传产物 checksum 不一致");
  }
  const key = integrationArtifactKey(context.projectId, runId, fileName);
  await writeArtifact(key, content);
  return { artifactKey: key, checksum: actualChecksum, size: content.length };
}

export async function dispatchKnowledgeRun(runId: string): Promise<void> {
  const run = await getKnowledgeRunById(runId);
  if (run.status !== "queued") return;
  const identity = await queryOne<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM knowledge_generation_runs WHERE id = $1`,
    [runId],
  );
  if (!identity) throw notFound("知识生成任务不存在");
  await enqueueKnowledgeRun(run.id, run.projectId, identity.idempotency_key);
  await query(`UPDATE knowledge_generation_runs SET dispatched_at = now() WHERE id = $1`, [runId]);
}

export async function dispatchPendingIntegrationRuns(): Promise<void> {
  const knowledgeRuns = await query<{ id: string }>(
    `SELECT id FROM knowledge_generation_runs
      WHERE status = 'queued'
        AND (dispatched_at IS NULL OR dispatched_at < now() - interval '5 minutes')
      ORDER BY created_at LIMIT 50`,
  );
  for (const run of knowledgeRuns) await dispatchKnowledgeRun(run.id).catch(() => undefined);

  const skillRuns = await query<{ id: string; project_id: string; idempotency_key: string }>(
    `SELECT id, project_id, idempotency_key FROM skill_evaluation_runs
      WHERE status = 'queued'
        AND (dispatched_at IS NULL OR dispatched_at < now() - interval '5 minutes')
      ORDER BY created_at LIMIT 50`,
  );
  for (const run of skillRuns) {
    try {
      await enqueueSkillLabRun(run.id, run.project_id, run.idempotency_key);
      await query(`UPDATE skill_evaluation_runs SET dispatched_at = now() WHERE id = $1`, [run.id]);
    } catch {
      // 下一轮继续投递；runId 是消费者幂等键。
    }
  }
}

export async function failTimedOutKnowledgeRuns(): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM knowledge_generation_runs
      WHERE status IN ('queued', 'running', 'publishing')
        AND coalesce(started_at, created_at) < now() - ($1 * interval '1 second')
      ORDER BY created_at LIMIT 100`,
    [config.knowledgeRunTimeoutSeconds],
  );
  for (const row of rows) {
    await failKnowledgeRun(row.id, "Knowledge Generator 执行超时").catch(() => undefined);
  }
}

export async function markKnowledgeAssetsForGraph(
  projectId: string,
  graphVersionNo: number,
): Promise<void> {
  await ensureProjectKnowledgeAssets(projectId);
  await query(
    `UPDATE knowledge_assets a
        SET status = 'stale', updated_at = now()
       FROM knowledge_asset_versions v, graph_versions gv
      WHERE a.project_id = $1
        AND a.current_version_id = v.id
        AND v.source_graph_version_id = gv.id
        AND gv.version_no <> $2`,
    [projectId, graphVersionNo],
  );
  if (config.knowledgeAutoGenerate) {
    await createKnowledgeRun({
      projectId,
      actorId: null,
      requestedAssets: ["wiki", "skills"],
      graphVersionNo,
    }).catch(() => undefined);
  }
}
