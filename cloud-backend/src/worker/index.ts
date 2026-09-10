/**
 * Analysis Worker（spec §11.1 / §11.2）
 * 消费 Redis Stream → 拉起分析 → 落图谱版本 → 联动文档 → 推事件。
 * 并发上限 WORKER_CONCURRENCY（ECS 16G 下为 3），超出的任务在流里排队。
 */
import { randomUUID } from "node:crypto";
import { config } from "../config";
import {
  artifactKey,
  ensureArtifactsDir,
  readJsonArtifact,
  writeArtifact,
  writeJsonArtifact,
} from "../infra/artifacts";
import { closeDb, pingDb } from "../infra/pg";
import {
  ackJob,
  acquireLock,
  claimStaleJobs,
  clearQueuedJob,
  clearQueuedRepositoryScan,
  closeRedis,
  ensureConsumerGroup,
  enqueueDocgen,
  enqueueJob,
  enqueueRepositoryScan,
  getChatTaskState,
  getDocgenState,
  readJobs,
  releaseLock,
  setChatTaskState,
  setDocgenState,
  type StreamMessage,
  waitForRedis,
} from "../infra/redis";
import {
  listGeneratedModuleDocuments,
  markGeneratedDocumentSyncFailed,
  markStaleByImpact,
  upsertGeneratedDoc,
} from "../services/documents";
import { findVersionByCommit, saveVersion, setCurrentByCommit } from "../services/graph";
import { markKnowledgeAssetsForGraph } from "../services/knowledge";
import {
  dedupKey,
  failStuckRunningJobs,
  getJob,
  listStaleQueuedJobs,
  markFailed,
  markProgress,
  markRunning,
  markSucceeded,
  setResolvedTargetSha,
  setResolvedRepositorySnapshot,
} from "../services/jobs";
import {
  bindingRepositoryKey,
  getBindingForRepository,
  listBindings,
  updateBindingSha,
} from "../services/repository";
import {
  createRepositoryScans,
  getRepositoryScan,
  listFinalizableRepositoryJobIds,
  listRepositoryScans,
  listStaleRepositoryScans,
  markRepositoryScanFailed,
  markRepositoryScanProgress,
  markRepositoryScanRunning,
  markRepositoryScanSucceeded,
  requeueRepositoryScan,
  type RepositoryScanDto,
} from "../services/repositoryScans";
import {
  composeProjectGraph,
  linkProjectRepositories,
  projectSnapshotCommitSha,
  type RepositorySnapshotInput,
} from "../scanner/v2/crossRepo";
import type { InterfaceCatalog } from "../scanner/v2/contracts";
import { validateGraph } from "../schemas/graphValidator";
import type { BindingDto, GraphDocument, ImpactReport, JobDto } from "../types";
import { sseHub } from "../realtime/sseHub";
import {
  analyze,
  buildArchDoc,
  cleanupOrphanRunners,
  pruneSourceCaches,
  runDocgen,
  runSourceChat,
} from "./analyze";

const CONSUMER = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
let inflight = 0;
let stopping = false;

function log(...args: unknown[]): void {
  console.log(`[worker ${CONSUMER}]`, ...args);
}

async function syncKnowledgeAssets(projectId: string, versionNo: number): Promise<void> {
  if (!config.knowledgeIntegrationEnabled) return;
  await markKnowledgeAssetsForGraph(projectId, versionNo).catch((err) => {
    log(`知识资产状态联动失败：${err instanceof Error ? err.message : String(err)}`);
  });
}

/** 同一 commit 强制重算时给产物加任务后缀，确保历史 GraphVersion 仍可读取。 */
function artifactFileForJob(
  job: { id: string; forceReanalysis: boolean },
  file: string,
): string {
  if (!job.forceReanalysis) return file;
  const slash = file.lastIndexOf("/");
  const directory = slash >= 0 ? file.slice(0, slash + 1) : "";
  const name = slash >= 0 ? file.slice(slash + 1) : file;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${directory}${name}.rerun-${job.id}`;
  return `${directory}${name.slice(0, dot)}.rerun-${job.id}${name.slice(dot)}`;
}

function singleRepositoryCommits(binding: BindingDto, commitSha: string): Record<string, string> {
  return { [bindingRepositoryKey(binding)]: commitSha };
}

function childJob(parent: JobDto, scan: RepositoryScanDto): JobDto {
  return {
    ...parent,
    id: scan.id,
    status: "running",
    progress: scan.progress,
    baseCommitSha: scan.baseCommitSha,
    targetCommitSha: scan.commitSha,
    repositoryCommits: { [scan.repositoryKey]: scan.commitSha },
  };
}

function childBinding(scan: RepositoryScanDto): BindingDto {
  const numericRepositoryId = Number(scan.repositoryKey);
  return {
    id: scan.bindingId ?? scan.id,
    repoFullName: scan.repoFullName,
    branch: scan.branch,
    repositoryId: Number.isSafeInteger(numericRepositoryId) ? numericRepositoryId : null,
    installationId: scan.installationId,
    currentCommitSha: scan.baseCommitSha,
    isPrimary: false,
  };
}

async function refreshParentProgress(jobId: string): Promise<void> {
  const scans = await listRepositoryScans(jobId);
  if (scans.length === 0) return;
  const average = scans.reduce((sum, scan) => sum + scan.progress, 0) / scans.length;
  await markProgress(jobId, 10 + average * 0.72, `并行扫描 ${scans.filter((scan) => scan.status === "succeeded").length}/${scans.length} 个仓库`);
}

async function enqueueMultiRepositoryJob(job: JobDto, bindings: BindingDto[]): Promise<void> {
  const scans = await createRepositoryScans(job, bindings);
  const reused = scans.filter((scan) => scan.status === "succeeded");
  for (const scan of scans) {
    if (scan.status === "queued") {
      await enqueueRepositoryScan(scan.id, scan.projectId);
    }
  }
  await refreshParentProgress(job.id);
  if (reused.length > 0) {
    log(`增量任务复用 ${reused.length}/${scans.length} 个未变仓库的扫描产物`);
  }
  if (reused.length === scans.length) {
    await finalizeMultiRepositoryJob(job.id);
  }
}

async function processJob(jobId: string): Promise<void> {
  inflight += 1;
  let lockKey: string | null = null;
  let lockOwner: string | null = null;
  try {
    const pendingJob = await getJob(jobId).catch(() => null);
    if (!pendingJob) {
      log(`任务 ${jobId} 不存在，跳过`);
      return;
    }
    if (pendingJob.status !== "queued") {
      log(`任务 ${jobId} 状态为 ${pendingJob.status}，跳过重复投递`);
      return;
    }

    lockKey = dedupKey(pendingJob.projectId, pendingJob.targetCommitSha, pendingJob.type) ?? pendingJob.id;
    const timeoutSec = pendingJob.type === "full" ? config.jobTimeoutFull : config.jobTimeoutIncremental;
    lockOwner = await acquireLock(lockKey, timeoutSec + 60);
    if (!lockOwner) {
      log(`任务 ${jobId} 正被其它 Worker 处理，跳过`);
      return;
    }

    const job = await markRunning(jobId);
    if (!job) {
      log(`任务 ${jobId} 已被其它 Worker 抢占，跳过`);
      return;
    }
    await clearQueuedJob(jobId).catch(() => undefined);
    log(`开始 ${job.type} 任务 ${jobId}（mode=${config.analyzerMode}）`);

    // 成本铁律：同一 commit 已有图谱版本 → 直接复用，不重复分析
    if (!job.forceReanalysis && job.targetCommitSha) {
      const cached = await findVersionByCommit(job.projectId, job.targetCommitSha);
      if (cached) {
        log(`commit ${job.targetCommitSha.slice(0, 7)} 已有 v${cached.versionNo}，复用`);
        const switched = await setCurrentByCommit(job.projectId, job.targetCommitSha);
        if (switched) {
          const bindings = await listBindings(job.projectId);
          await Promise.all(bindings.map((binding) => {
            const commit = job.repositoryCommits[bindingRepositoryKey(binding)] ?? job.targetCommitSha!;
            return updateBindingSha(binding.id, commit).catch(() => undefined);
          }));
          sseHub.emitAsync(job.projectId, "graph.version.switched", switched);
          await syncKnowledgeAssets(job.projectId, switched.versionNo);
        }
        await markSucceeded(jobId, 0);
        return;
      }
    }

    const bindings = await listBindings(job.projectId);
    if (bindings.length === 0) throw new Error("项目未绑定仓库");
    if (bindings.length > 1) {
      await enqueueMultiRepositoryJob(job, bindings);
      log(`父任务 ${job.id} 已拆分为 ${bindings.length} 个仓库扫描`);
      return;
    }
    const binding = bindings[0]!;
    const result = await analyze(job, binding, async (progress, note) => {
      await markProgress(jobId, progress, note);
      if (note) log(`  ${progress}% ${note}`);
    });
    for (const line of result.logs) log(`  ${line}`);
    await setResolvedTargetSha(jobId, result.commitSha);
    const repositoryCommits = Object.keys(job.repositoryCommits).length > 0
      ? job.repositoryCommits
      : singleRepositoryCommits(binding, result.commitSha);
    await setResolvedRepositorySnapshot(jobId, result.commitSha, repositoryCommits);

    if (result.facts) {
      await writeJsonArtifact(
        artifactKey(job.projectId, result.commitSha, artifactFileForJob(job, "facts.json")),
        result.facts,
      );
    }
    if (result.impact) {
      await writeJsonArtifact(
        artifactKey(job.projectId, result.commitSha, artifactFileForJob(job, "impact.json")),
        result.impact,
      );
    }
    for (const [name, artifact] of Object.entries(result.scanArtifacts)) {
      await writeJsonArtifact(
        artifactKey(job.projectId, result.commitSha, artifactFileForJob(job, name)),
        artifact,
      );
    }
    await writeJsonArtifact(
      artifactKey(job.projectId, result.commitSha, artifactFileForJob(job, "graph.final.json")),
      result.graph,
    );

    await markProgress(jobId, 85);
    const version = await saveVersion({
      projectId: job.projectId,
      commitSha: result.commitSha,
      jobId: job.id,
      graph: result.graph,
      repositoryCommits,
      reuseSameCommit: !job.forceReanalysis,
      artifactFile: artifactFileForJob(job, "graph.json"),
    });
    sseHub.emitAsync(job.projectId, "graph.version.switched", version);
    await syncKnowledgeAssets(job.projectId, version.versionNo);
    log(`图谱 v${version.versionNo} @ ${version.commitSha.slice(0, 7)}：` +
      `${version.stats.nodeCount} 节点 / ${version.stats.edgeCount} 边 / ${version.stats.inferredCount} 推断`);

    await updateBindingSha(binding.id, result.commitSha).catch(() => undefined);

    // 文档过期联动（spec §11.2-6）
    if (result.impact) {
      const marked = await markStaleByImpact(
        job.projectId,
        result.impact.affectedNodeIds,
        result.impact.globalStructureChanged,
      );
      if (marked.length > 0) log(`标记 ${marked.length} 篇文档为 maybe_stale`);

      const generated = await listGeneratedModuleDocuments(
        job.projectId,
        result.impact.affectedNodeIds,
      );
      for (const document of generated) {
        const taskId = randomUUID();
        await setDocgenState(taskId, {
          status: "pending",
          projectId: job.projectId,
          nodeId: document.nodeId,
          actorId: "",
          commitSha: result.commitSha,
          repositoryId: result.graph.nodes.find((node) => node.id === document.nodeId)?.repositoryId,
          existingDingtalkNodeId: document.dingtalkNodeId ?? "",
        });
        await enqueueDocgen(taskId, job.projectId);
      }
      if (generated.length > 0) log(`已排队刷新 ${generated.length} 篇 AI 模块文档`);
    }

    if (result.archDoc) {
      const key = artifactKey(
        job.projectId,
        result.commitSha,
        artifactFileForJob(job, "ARCHITECTURE.md"),
      );
      await writeArtifact(key, result.archDoc);
      await upsertGeneratedDoc(
        job.projectId,
        {
          scope: "global",
          nodeId: null,
          title: "架构总览（AI 自动维护）",
          url: `visionowl://artifact/${key}`,
          docType: "generated",
          artifactKey: key,
        },
        null,
      );
    }

    await markProgress(jobId, 95, "保存图谱与更新文档");
    await markSucceeded(jobId, result.credits);
    log(`任务 ${jobId} 完成，credits=${result.credits}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] 任务 ${jobId} 失败：${message}`);
    await markFailed(jobId, message).catch(() => undefined);
  } finally {
    if (lockKey && lockOwner) await releaseLock(lockKey, lockOwner);
    inflight -= 1;
  }
}

function interfaceCatalogFromResult(
  scan: RepositoryScanDto,
  result: Awaited<ReturnType<typeof analyze>>,
): InterfaceCatalog {
  const candidate = result.scanArtifacts["interface-catalog.json"] as Partial<InterfaceCatalog> | undefined;
  if (
    candidate?.schemaVersion === "2.0" &&
    candidate.repositoryId === scan.repositoryKey &&
    candidate.commitSha === scan.commitSha &&
    Array.isArray(candidate.interfaces)
  ) {
    return candidate as InterfaceCatalog;
  }
  return {
    schemaVersion: "2.0",
    repositoryId: scan.repositoryKey,
    commitSha: scan.commitSha,
    generatedAt: new Date().toISOString(),
    interfaces: [],
  };
}

async function finalizeMultiRepositoryJob(jobId: string): Promise<void> {
  const lockKey = `multi-finalize:${jobId}`;
  let lockOwner: string | null = null;
  // 仓库子任务可能同时结束。短暂等待前一个“尚未齐备”的检查释放锁，避免漏掉最终收口。
  for (let attempt = 0; attempt < 12 && !lockOwner; attempt += 1) {
    lockOwner = await acquireLock(lockKey, config.jobTimeoutFull + 120);
    if (!lockOwner) await sleep(100);
  }
  if (!lockOwner) return;
  try {
    const job = await getJob(jobId);
    if (job.status !== "running") return;
    const scans = await listRepositoryScans(jobId);
    if (scans.length === 0 || scans.some((scan) => scan.status === "queued" || scan.status === "running")) {
      return;
    }
    const failed = scans.filter((scan) => scan.status === "failed");
    if (failed.length > 0) {
      await markFailed(
        job.id,
        `联合分析失败：${failed.map((scan) => `${scan.repoFullName}: ${scan.error ?? "未知错误"}`).join("; ")}`,
        scans.reduce((sum, scan) => sum + (scan.credits ?? 0), 0),
      );
      return;
    }

    await markProgress(job.id, 84, "汇总仓库图谱并计算跨仓库关系");
    const repositories: RepositorySnapshotInput[] = await Promise.all(scans.map(async (scan) => ({
      repositoryId: scan.repositoryKey,
      repositoryName: scan.repoFullName,
      commitSha: scan.commitSha,
      graph: await readJsonArtifact<GraphDocument>(scan.graphArtifactKey!),
      interfaceCatalog: await readJsonArtifact<InterfaceCatalog>(scan.interfaceCatalogArtifactKey!),
    })));
    const report = linkProjectRepositories(job.projectId, repositories);
    const graph = composeProjectGraph(job.projectId, repositories, report);
    const validation = validateGraph(graph);
    if (!validation.ok) {
      throw new Error(`联合图谱校验失败：${validation.errors.slice(0, 8).join("; ")}`);
    }
    const snapshotSha = projectSnapshotCommitSha(report.repositoryCommits);
    await setResolvedRepositorySnapshot(job.id, snapshotSha, report.repositoryCommits);

    await writeJsonArtifact(
      artifactKey(job.projectId, snapshotSha, artifactFileForJob(job, "cross-repository-links.json")),
      report,
    );
    await writeJsonArtifact(
      artifactKey(job.projectId, snapshotSha, artifactFileForJob(job, "graph.final.json")),
      graph,
    );
    const version = await saveVersion({
      projectId: job.projectId,
      commitSha: snapshotSha,
      repositoryCommits: report.repositoryCommits,
      jobId: job.id,
      graph,
      reuseSameCommit: !job.forceReanalysis,
      artifactFile: artifactFileForJob(job, "graph.json"),
    });
    sseHub.emitAsync(job.projectId, "graph.version.switched", version);
    await syncKnowledgeAssets(job.projectId, version.versionNo);

    const impacts = (await Promise.all(scans.map(async (scan) =>
      scan.impactArtifactKey
        ? readJsonArtifact<ImpactReport>(scan.impactArtifactKey).catch(() => null)
        : null
    ))).filter((impact): impact is ImpactReport => impact !== null);
    if (impacts.length > 0) {
      const affectedNodeIds = [...new Set(impacts.flatMap((impact) => impact.affectedNodeIds))];
      const globalStructureChanged = impacts.some((impact) => impact.globalStructureChanged);
      const marked = await markStaleByImpact(job.projectId, affectedNodeIds, globalStructureChanged);
      if (marked.length > 0) log(`标记 ${marked.length} 篇文档为 maybe_stale`);
      const generated = await listGeneratedModuleDocuments(job.projectId, affectedNodeIds);
      for (const document of generated) {
        const node = graph.nodes.find((item) => item.id === document.nodeId);
        const taskId = randomUUID();
        await setDocgenState(taskId, {
          status: "pending",
          projectId: job.projectId,
          nodeId: document.nodeId,
          nodePath: node?.path ?? undefined,
          repositoryId: node?.repositoryId,
          actorId: "",
          commitSha: node?.repositoryId
            ? report.repositoryCommits[node.repositoryId] ?? snapshotSha
            : snapshotSha,
          existingDingtalkNodeId: document.dingtalkNodeId ?? "",
        });
        await enqueueDocgen(taskId, job.projectId);
      }
    }

    const archKey = artifactKey(
      job.projectId,
      snapshotSha,
      artifactFileForJob(job, "ARCHITECTURE.md"),
    );
    await writeArtifact(archKey, buildArchDoc(graph));
    await upsertGeneratedDoc(
      job.projectId,
      {
        scope: "global",
        nodeId: null,
        title: "架构总览（AI 自动维护）",
        url: `visionowl://artifact/${archKey}`,
        docType: "generated",
        artifactKey: archKey,
      },
      null,
    );

    await markProgress(job.id, 95, "发布联合图谱与更新文档");
    const credits = scans.reduce((sum, scan) => sum + (scan.credits ?? 0), 0);
    await markSucceeded(job.id, credits);
    log(
      `联合图谱 v${version.versionNo} 完成：${scans.length} 仓库 / ${report.links.length} 条跨仓库关系 / ${report.unresolved.length} 条待确认候选`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(jobId, `联合图谱合并失败：${message}`).catch(() => undefined);
    console.error(`[worker] 联合图谱 ${jobId} 合并失败：${message}`);
  } finally {
    await releaseLock(lockKey, lockOwner);
  }
}

async function processRepositoryScan(scanId: string): Promise<void> {
  inflight += 1;
  const lockKey = `repository-scan:${scanId}`;
  let lockOwner: string | null = null;
  try {
    lockOwner = await acquireLock(lockKey, config.jobTimeoutFull + 60);
    if (!lockOwner) return;
    const existing = await getRepositoryScan(scanId);
    if (!existing || existing.status === "succeeded" || existing.status === "failed") {
      if (existing?.status === "succeeded") await finalizeMultiRepositoryJob(existing.jobId);
      return;
    }
    const scan = await markRepositoryScanRunning(scanId);
    if (!scan) return;
    await clearQueuedRepositoryScan(scanId).catch(() => undefined);
    const parent = await getJob(scan.jobId);
    if (parent.status !== "running") return;

    const binding = childBinding(scan);
    log(`扫描仓库 ${scan.repoFullName}@${scan.commitSha.slice(0, 7)}（${scan.attempts}/${config.repositoryScanMaxAttempts}）`);
    const result = await analyze(childJob(parent, scan), binding, async (progress, note) => {
      await markRepositoryScanProgress(scan.id, progress);
      await refreshParentProgress(parent.id);
      if (note) log(`  ${scan.repoFullName} ${progress}% ${note}`);
    });
    if (result.commitSha !== scan.commitSha) {
      throw new Error(`仓库 commit 不一致：期望 ${scan.commitSha}，实际 ${result.commitSha}`);
    }

    const snapshotSha = parent.targetCommitSha ?? projectSnapshotCommitSha(parent.repositoryCommits);
    const prefix = `repositories/${scan.id}`;
    const graphKey = artifactKey(parent.projectId, snapshotSha, `${prefix}/graph.json`);
    const interfaceKey = artifactKey(parent.projectId, snapshotSha, `${prefix}/interface-catalog.json`);
    const impactKey = result.impact
      ? artifactKey(parent.projectId, snapshotSha, `${prefix}/impact.json`)
      : null;
    await writeJsonArtifact(graphKey, result.graph);
    await writeJsonArtifact(interfaceKey, interfaceCatalogFromResult(scan, result));
    if (impactKey && result.impact) await writeJsonArtifact(impactKey, result.impact);
    for (const [name, artifact] of Object.entries(result.scanArtifacts)) {
      await writeJsonArtifact(
        artifactKey(parent.projectId, snapshotSha, `${prefix}/${name}`),
        artifact,
      );
    }
    await markRepositoryScanSucceeded(scan.id, {
      graphArtifactKey: graphKey,
      interfaceCatalogArtifactKey: interfaceKey,
      impactArtifactKey: impactKey,
      credits: result.credits,
    });
    if (scan.bindingId) await updateBindingSha(scan.bindingId, scan.commitSha).catch(() => undefined);
    await refreshParentProgress(parent.id);
    await finalizeMultiRepositoryJob(parent.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const scan = await getRepositoryScan(scanId).catch(() => null);
    if (scan && scan.attempts < config.repositoryScanMaxAttempts) {
      await requeueRepositoryScan(scan.id, message);
      await enqueueRepositoryScan(scan.id, scan.projectId).catch(() => undefined);
      log(`仓库 ${scan.repoFullName} 扫描失败，已重新排队：${message}`);
    } else if (scan) {
      await markRepositoryScanFailed(scan.id, message);
      await finalizeMultiRepositoryJob(scan.jobId).catch(() => undefined);
      console.error(`[worker] 仓库 ${scan.repoFullName} 最终失败：${message}`);
    }
  } finally {
    if (lockOwner) await releaseLock(lockKey, lockOwner);
    inflight -= 1;
  }
}

async function processDocgen(taskId: string): Promise<void> {
  inflight += 1;
  const lockKey = `docgen:${taskId}`;
  let lockOwner: string | null = null;
  try {
    lockOwner = await acquireLock(lockKey, config.jobTimeoutIncremental + 60);
    if (!lockOwner) {
      log(`docgen ${taskId} 正被处理，跳过重复投递`);
      return;
    }
    const state = await getDocgenState(taskId);
    if (!state || (state.status !== "pending" && state.status !== "running")) return;
    const binding = await getBindingForRepository(state.projectId, state.repositoryId);
    if (!binding) throw new Error("项目未绑定仓库");
    await setDocgenState(taskId, { status: "running" });

    const { markdown, credits } = await runDocgen(
      taskId,
      state.projectId,
      binding,
      state.nodeId,
      state.nodePath,
      state.commitSha,
    );
    const safeNodeId = state.nodeId.replace(/[^\w.-]/g, "_");
    const key = artifactKey(
      state.projectId,
      state.commitSha,
      `modules/${safeNodeId}.md`,
    );
    await writeArtifact(key, markdown);

    const nodeName = state.nodeId.startsWith("module:") ? state.nodeId.slice(7) : state.nodeId;
    const title = `${nodeName} 代码文档（AI 生成）`;
    await setDocgenState(taskId, {
      status: "ready_to_publish",
      artifactKey: key,
      title,
      credits: String(credits),
    });
    sseHub.emitAsync(state.projectId, "document.publication.ready", {
      taskId,
      nodeId: state.nodeId,
      automatic: !state.actorId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedState = await getDocgenState(taskId).catch(() => null);
    if (failedState) {
      await markGeneratedDocumentSyncFailed(failedState.projectId, failedState.nodeId, message).catch(
        () => undefined,
      );
    }
    await setDocgenState(taskId, { status: "failed", error: message.slice(0, 300) }).catch(
      () => undefined,
    );
    console.error(`[worker] docgen ${taskId} 失败：${message}`);
  } finally {
    if (lockOwner) await releaseLock(lockKey, lockOwner);
    inflight -= 1;
  }
}

async function processChat(taskId: string): Promise<void> {
  inflight += 1;
  const lockKey = `chat:${taskId}`;
  let lockOwner: string | null = null;
  try {
    lockOwner = await acquireLock(lockKey, config.qoderChatTimeoutSeconds + 60);
    if (!lockOwner) {
      log(`chat ${taskId} 正被处理，跳过重复投递`);
      return;
    }
    const state = await getChatTaskState(taskId);
    if (!state || (state.status !== "pending" && state.status !== "running")) return;
    const binding = await getBindingForRepository(state.projectId, state.repositoryId);
    if (!binding) throw new Error("项目未绑定仓库");
    await setChatTaskState(taskId, {
      status: "running",
      stage: "queued",
      note: "任务已进入 Agent 队列",
    });

    const result = await runSourceChat(
      taskId,
      state.projectId,
      binding,
      state.commitSha,
      {
        question: state.question,
        nodeId: state.nodeId,
        nodeName: state.nodeName,
        nodePath: state.nodePath,
        groundedDraft: state.groundedDraft,
      },
      async ({ stage, note }) => {
        await setChatTaskState(taskId, { stage, note });
      },
    );
    await setChatTaskState(taskId, {
      status: "succeeded",
      text: result.text,
      credits: String(result.credits),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setChatTaskState(taskId, { status: "failed", error: message.slice(0, 300) }).catch(
      () => undefined,
    );
    console.error(`[worker] chat ${taskId} 失败：${message}`);
  } finally {
    if (lockOwner) await releaseLock(lockKey, lockOwner);
    inflight -= 1;
  }
}

function processMessage(message: StreamMessage): Promise<void> {
  if (message.kind === "repository_scan") return processRepositoryScan(message.jobId);
  if (message.kind === "docgen") return processDocgen(message.jobId);
  if (message.kind === "chat") return processChat(message.jobId);
  return processJob(message.jobId);
}

/** 消费组自愈：BUSYGROUP 视为成功，其它错误只记日志由下次循环重试 */
async function ensureGroupSafely(): Promise<void> {
  try {
    await ensureConsumerGroup();
  } catch (err) {
    console.warn(`[worker] 建消费组失败（稍后重试）：${err instanceof Error ? err.message : err}`);
  }
}

/** 巡检：捞起入队失败（Redis 当时不可用）或长时间未消费的 queued 任务 */
async function sweep(): Promise<void> {
  try {
    const pruned = await pruneSourceCaches();
    if (pruned > 0) log(`已清理 ${pruned} 个过期源码缓存`);
    const capacity = Math.max(0, config.workerConcurrency - inflight);
    const claimed = capacity > 0
      ? await claimStaleJobs(
          CONSUMER,
          (Math.max(config.jobTimeoutFull, config.qoderChatTimeoutSeconds) + 60) * 1000,
          capacity,
        ).catch(() => [])
      : [];
    for (const message of claimed) {
      const task = processMessage(message);
      void task.finally(() => void ackJob(message.messageId).catch(() => undefined));
    }

    const stale = await listStaleQueuedJobs(30, config.workerConcurrency * 2);
    for (const job of stale) {
      log(`巡检重新入队 ${job.id}`);
      await enqueueJob(job.id, job.projectId).catch(() => undefined);
    }
    const staleScans = await listStaleRepositoryScans(30, config.workerConcurrency * 2);
    for (const scan of staleScans) {
      log(`巡检重新入队仓库扫描 ${scan.repoFullName} (${scan.id})`);
      await enqueueRepositoryScan(scan.id, scan.projectId).catch(() => undefined);
    }
    const finalizableJobs = await listFinalizableRepositoryJobIds(config.workerConcurrency * 2);
    for (const jobId of finalizableJobs) {
      log(`巡检收口多仓库父任务 ${jobId}`);
      await finalizeMultiRepositoryJob(jobId);
    }
  } catch (err) {
    console.warn(`[worker] 巡检失败：${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
  log(
    `启动：并发=${config.workerConcurrency} mode=${config.analyzerMode} ` +
    `agentOrchestration=${config.agentOrchestrationMode}`,
  );
  await ensureArtifactsDir();
  const orphanedRunners = await cleanupOrphanRunners().catch((error) => {
    console.warn(`[worker] 清理孤儿 Runner 失败：${error instanceof Error ? error.message : error}`);
    return 0;
  });
  if (orphanedRunners > 0) log(`已清理 ${orphanedRunners} 个孤儿 Runner 容器`);
  if (!(await pingDb())) {
    console.error("[worker] 数据库不可达，退出");
    process.exit(1);
  }
  sseHub.init();

  // 必须等连接就绪再建组：未就绪时命令直接失败，会导致后续 XREADGROUP 一直 NOGROUP
  if (!(await waitForRedis())) {
    console.warn("[worker] Redis 15s 内未就绪，将在循环中重试建组");
  }
  await ensureGroupSafely();

  const stuck = await failStuckRunningJobs(config.jobTimeoutFull * 2).catch(() => 0);
  if (stuck > 0) log(`已把 ${stuck} 个失联 running 任务标记为 failed`);

  await sweep(); // 启动即巡检一次，捞起上次宕机遗留的 queued 任务
  const sweepTimer = setInterval(() => void sweep(), 60_000);

  while (!stopping) {
    const capacity = config.workerConcurrency - inflight;
    if (capacity <= 0) {
      await sleep(200);
      continue;
    }
    let messages: Awaited<ReturnType<typeof readJobs>> = [];
    try {
      messages = await readJobs(CONSUMER, capacity, 5_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 消费组缺失（Redis 重启/首次启动竞态）→ 自愈重建，不刷屏
      if (message.includes("NOGROUP")) {
        await ensureGroupSafely();
        await sleep(1_000);
        continue;
      }
      console.warn(`[worker] 读取队列失败：${message}`);
      await sleep(3_000);
      continue;
    }
    for (const msg of messages) {
      const task = processMessage(msg);
      void task.finally(() => {
        void ackJob(msg.messageId).catch(() => undefined);
      });
    }
  }

  clearInterval(sweepTimer);
  log("等待在途任务结束…");
  while (inflight > 0) await sleep(500);
  await Promise.allSettled([closeDb(), closeRedis()]);
  log("已退出");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(0);
    stopping = true;
    log(`收到 ${sig}，优雅退出中…`);
  });
}

void main().catch((err) => {
  console.error("[worker] 致命错误：", err);
  process.exit(1);
});
