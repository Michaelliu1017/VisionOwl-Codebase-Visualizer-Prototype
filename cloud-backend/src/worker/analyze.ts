/**
 * 分析执行器（三种模式，spec §7）
 *
 *  demo   —— 不克隆仓库，复用 seed 演示图谱：冒烟验证全链路（队列→版本→SSE）
 *  local  —— 宿主机 git clone + 确定性扫描（阶段一），零 credit、无需 qodercli/ACR
 *  runner —— 完整两段式：一次性容器内 扫描 + qodercli headless 语义增强
 *
 * 凭证一律运行时注入，绝不落盘、绝不进日志。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config";
import { createInstallationToken } from "../infra/githubApp";
import { computeImpact } from "../scanner/scan";
import { scanRepositoryV2 } from "../scanner/v2/factIndex";
import { compareScannerVersions } from "../scanner/v2/baseline";
import { postprocessGraph } from "../scanner/v2/postprocess";
import { emptyGraphPatch } from "../schemas/patchValidator";
import { validateGraph } from "../schemas/graphValidator";
import { loadDemoGraph } from "../seed/demoGraph";
import type { BindingDto, GraphDocument, ImpactReport, JobDto } from "../types";
import { bindingRepositoryKey } from "../services/repository";

/** 一律 execFile + argv 数组：不经 shell，仓库名/分支等外部输入无法注入 */
const run = promisify(execFile);

interface SourceCacheMarker {
  commitSha: string;
  createdAt: string;
  lastUsedAt: string;
}

const sourceCacheRoot = () => path.join(config.workspaceDir, "source-cache");
const safeCacheSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");
const sourceCacheEntry = (projectId: string, repositoryKey: string, commitSha: string) =>
  path.join(
    sourceCacheRoot(),
    safeCacheSegment(projectId),
    safeCacheSegment(repositoryKey),
    safeCacheSegment(commitSha),
  );
const hasCachedSourceTree = (entry: string) =>
  existsSync(path.join(entry, "repo", ".git")) ||
  existsSync(path.join(entry, "repo", ".visionowl-commit"));

const runnerEnvValue = (value: string | number | null | undefined) =>
  String(value ?? "").replace(/[\r\n]/g, "");

async function writeRunnerEnv(
  file: string,
  values: Record<string, string | number | null | undefined>,
): Promise<void> {
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${runnerEnvValue(value)}`)
    .join("\n");
  await fs.writeFile(file, `${body}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function cleanupOrphanRunners(): Promise<number> {
  const { stdout } = await run(
    "docker",
    ["ps", "-aq", "--filter", "label=visionowl.runner=true"],
    { timeout: 30_000 },
  );
  const containerIds = stdout.split("\n").map((item) => item.trim()).filter(Boolean);
  if (containerIds.length === 0) return 0;
  await run("docker", ["rm", "-f", ...containerIds], { timeout: 30_000 });
  return containerIds.length;
}

async function readSourceCacheMarker(entry: string): Promise<SourceCacheMarker | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(entry, "cache.json"), "utf8")) as Partial<SourceCacheMarker>;
    if (
      typeof marker.commitSha !== "string" ||
      typeof marker.createdAt !== "string" ||
      typeof marker.lastUsedAt !== "string"
    ) return null;
    return marker as SourceCacheMarker;
  } catch {
    return null;
  }
}

async function touchSourceCache(entry: string, marker: SourceCacheMarker): Promise<void> {
  await fs.writeFile(
    path.join(entry, "cache.json"),
    JSON.stringify({ ...marker, lastUsedAt: new Date().toISOString() }),
    "utf8",
  );
}

async function findSourceCache(
  projectId: string,
  repositoryKey: string,
  commitSha: string,
): Promise<string | null> {
  if (!commitSha) return null;
  const entry = sourceCacheEntry(projectId, repositoryKey, commitSha);
  const marker = await readSourceCacheMarker(entry);
  if (!marker || marker.commitSha !== commitSha || !hasCachedSourceTree(entry)) {
    return null;
  }
  const lastUsed = Date.parse(marker.lastUsedAt);
  if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > config.sourceCacheTtlSeconds * 1000) {
    await fs.rm(entry, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
  await touchSourceCache(entry, marker).catch(() => undefined);
  return path.join(entry, "repo");
}

async function promoteSourceCache(
  jobWork: string,
  projectId: string,
  repositoryKey: string,
  expectedCommitSha?: string,
): Promise<string | null> {
  const staged = path.join(jobWork, "source-cache");
  const marker = await readSourceCacheMarker(staged);
  if (
    !marker ||
    (expectedCommitSha && marker.commitSha !== expectedCommitSha) ||
    !hasCachedSourceTree(staged)
  ) return null;

  const target = sourceCacheEntry(projectId, repositoryKey, marker.commitSha);
  const existing = await readSourceCacheMarker(target);
  if (existing?.commitSha === marker.commitSha && hasCachedSourceTree(target)) {
    await touchSourceCache(target, existing).catch(() => undefined);
    await fs.rm(staged, { recursive: true, force: true }).catch(() => undefined);
    return path.join(target, "repo");
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.rename(staged, temporary);
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    const winner = await readSourceCacheMarker(target);
    if (winner?.commitSha !== marker.commitSha) throw error;
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
  await touchSourceCache(target, marker).catch(() => undefined);
  return path.join(target, "repo");
}

let lastSourceCachePruneAt = 0;
export async function pruneSourceCaches(): Promise<number> {
  const now = Date.now();
  if (now - lastSourceCachePruneAt < 5 * 60_000) return 0;
  lastSourceCachePruneAt = now;
  let removed = 0;
  const pruneEntry = async (entryDir: string): Promise<boolean> => {
    const marker = await readSourceCacheMarker(entryDir);
    const lastUsed = marker ? Date.parse(marker.lastUsedAt) : Number.NaN;
    if (!Number.isFinite(lastUsed) || now - lastUsed > config.sourceCacheTtlSeconds * 1000) {
      await fs.rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
      return true;
    }
    return false;
  };
  const projects = await fs.readdir(sourceCacheRoot(), { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(sourceCacheRoot(), project.name);
    const repositories = await fs.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const repository of repositories) {
      if (!repository.isDirectory()) continue;
      const repositoryDir = path.join(projectDir, repository.name);
      // 兼容升级前 project/commit 的旧缓存布局。
      if (await readSourceCacheMarker(repositoryDir)) {
        if (await pruneEntry(repositoryDir)) removed += 1;
        continue;
      }
      const commits = await fs.readdir(repositoryDir, { withFileTypes: true }).catch(() => []);
      for (const commit of commits) {
        if (!commit.isDirectory()) continue;
        if (await pruneEntry(path.join(repositoryDir, commit.name))) removed += 1;
      }
    }
  }
  return removed;
}

export interface AnalyzeResult {
  graph: GraphDocument;
  facts: unknown | null;
  impact: ImpactReport | null;
  credits: number;
  semanticEnhanced: boolean;
  commitSha: string;
  logs: string[];
  archDoc: string | null;
  /** Fact Index、Base Graph、Patch 与质量报告等可复用扫描产物。 */
  scanArtifacts: Record<string, unknown>;
}

export type ProgressFn = (progress: number, note?: string) => void | Promise<void>;

export async function analyze(
  job: JobDto,
  binding: BindingDto | null,
  onProgress: ProgressFn,
): Promise<AnalyzeResult> {
  switch (config.analyzerMode) {
    case "demo":
      return analyzeDemo(job, binding, onProgress);
    case "local":
      return analyzeLocal(job, binding, onProgress);
    case "runner":
      return analyzeRunner(job, binding, onProgress);
    default:
      throw new Error(`未知 ANALYZER_MODE: ${config.analyzerMode as string}`);
  }
}

// ── demo ──────────────────────────────────────────────────────────────
async function analyzeDemo(
  job: JobDto,
  binding: BindingDto | null,
  onProgress: ProgressFn,
): Promise<AnalyzeResult> {
  await onProgress(30, "读取演示图谱");
  const demo = loadDemoGraph();
  const commitSha = job.targetCommitSha ?? demo.commitSha;
  const repositoryId = binding ? bindingRepositoryKey(binding) : job.projectId;
  const ids = new Map(demo.nodes.map((node) => [node.id, `${repositoryId}:${node.id}`]));
  const graph: GraphDocument = {
    ...demo,
    projectId: job.projectId,
    repositoryId,
    commitSha,
    nodes: demo.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      parentId: node.parentId ? ids.get(node.parentId) ?? null : node.parentId,
      repositoryId,
      evidence: node.evidence?.map((evidence) => ({ ...evidence, repositoryId })),
    })),
    edges: demo.edges.map((edge) => ({
      ...edge,
      id: `${repositoryId}:${edge.id}`,
      source: ids.get(edge.source) ?? edge.source,
      target: ids.get(edge.target) ?? edge.target,
      repositoryId,
      sourceRepositoryId: repositoryId,
      targetRepositoryId: repositoryId,
      evidence: edge.evidence?.map((evidence) => ({ ...evidence, repositoryId })),
    })),
    views: demo.views?.map((view) => ({
      ...view,
      id: `${repositoryId}:${view.id}`,
      nodeIds: view.nodeIds.map((id) => ids.get(id) ?? id),
      edgeIds: view.edgeIds.map((id) => `${repositoryId}:${id}`),
      steps: view.steps?.map((step) => ({
        ...step,
        edgeId: `${repositoryId}:${step.edgeId}`,
      })),
    })),
  };
  await onProgress(80, "校验");
  const result = validateGraph(graph);
  if (!result.ok) throw new Error(`演示图谱校验失败：${result.errors.join("; ")}`);
  return {
    graph,
    facts: null,
    impact: null,
    credits: 0,
    semanticEnhanced: false,
    commitSha,
    logs: ["ANALYZER_MODE=demo：复用 seed 演示图谱，未克隆仓库"],
    archDoc: null,
    scanArtifacts: {},
  };
}

// ── local ─────────────────────────────────────────────────────────────
/**
 * 穿越抖动链路的克隆（ECS 实测：到 github.com 的连通性分钟级抖动，
 * 同一宿主机 3 分钟内从 6/6 变 1/6）：
 *  1 每轮先用 ls-remote 预检窗口（几 KB，秒级），差窗口不浪费克隆尝试
 *  2 好窗口内立即克隆，blob:limit 把传输量压到最小，缩短暴露时间
 *  3 失败退避重试，穿越到下一个好窗口
 */
async function cloneWithRetry(
  url: string,
  branch: string,
  repoDir: string,
  logs: string[],
  onAttempt?: (attempt: number, max: number) => Promise<void>,
): Promise<void> {
  const gitOpts = [
    "-c", "http.version=HTTP/1.1",
    "-c", "http.postBuffer=524288000",
    "-c", "core.compression=0",
    "-c", "http.lowSpeedLimit=1024",
    "-c", "http.lowSpeedTime=40",
  ];
  const MAX = 5;
  const BACKOFF = [0, 20_000, 40_000, 60_000, 90_000];

  for (let attempt = 1; attempt <= MAX; attempt += 1) {
    if (attempt > 1) {
      const wait = BACKOFF[attempt - 1] ?? 60_000;
      logs.push(`第 ${attempt}/${MAX} 次尝试，退避 ${wait / 1000}s 等待好窗口`);
      await new Promise((r) => setTimeout(r, wait));
    }
    await onAttempt?.(attempt, MAX);

    // 预检：当前窗口能否完成 ref listing
    const probe = await run("git", [...gitOpts, "ls-remote", url, "HEAD"], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    }).then(() => true).catch(() => false);
    if (!probe) {
      logs.push(`预检失败（窗口不可用），跳过本轮克隆`);
      continue;
    }

    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
    try {
      // 优先部分克隆（代码分析不需要大二进制文件），不支持则退化浅克隆
      await run(
        "git",
        [...gitOpts, "clone", "--depth=50", "--single-branch", "--branch", branch,
         "--filter=blob:limit=2m", url, repoDir],
        { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      );
      logs.push(`克隆成功（第 ${attempt} 次，partial clone）`);
      return;
    } catch (err) {
      logs.push(`partial clone 失败：${err instanceof Error ? err.message.slice(0, 100) : err}`);
      await fs.rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
      try {
        await run(
          "git",
          [...gitOpts, "clone", "--depth=50", "--single-branch", "--branch", branch, url, repoDir],
          { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
        );
        logs.push(`克隆成功（第 ${attempt} 次，浅克隆）`);
        return;
      } catch (err2) {
        logs.push(`浅克隆也失败：${err2 instanceof Error ? err2.message.slice(0, 100) : err2}`);
      }
    }
  }
  throw new Error(`克隆失败：${MAX} 次尝试（含预检+退避）均未穿越到可用窗口`);
}

async function analyzeLocal(
  job: JobDto,
  binding: BindingDto | null,
  onProgress: ProgressFn,
): Promise<AnalyzeResult> {
  const logs: string[] = [];
  const workDir = path.join(config.workspaceDir, job.id);
  const repoDir = process.env.LOCAL_REPO_PATH
    ? path.resolve(process.env.LOCAL_REPO_PATH)
    : path.join(workDir, "repo");

  let commitSha = job.targetCommitSha ?? "";
  let changedFiles: string[] = [];

  if (process.env.LOCAL_REPO_PATH) {
    logs.push(`使用本地目录分析：${repoDir}（LOCAL_REPO_PATH）`);
    commitSha = commitSha || (await gitHead(repoDir).catch(() => "0000000"));
  } else {
    if (!binding) throw new Error("未绑定仓库，无法克隆");
    await fs.mkdir(workDir, { recursive: true });
    await onProgress(15, "克隆仓库");

    const token = binding.installationId
      ? (await createInstallationToken(binding.installationId).catch(() => null))?.token
      : undefined;
    const url = token
      ? `https://x-access-token:${token}@github.com/${binding.repoFullName}.git`
      : `https://github.com/${binding.repoFullName}.git`;

    await cloneWithRetry(url, binding.branch, repoDir, logs, async (attempt, max) => {
      // 重试进度对用户可见：15% 起步，每轮 +3%
      await onProgress(15 + (attempt - 1) * 3, `克隆仓库（第 ${attempt}/${max} 次）`);
    });

    if (commitSha) {
      try {
        await run("git", ["-C", repoDir, "checkout", "--detach", commitSha], { timeout: 60_000 });
      } catch {
        await run("git", ["-C", repoDir, "fetch", "--depth=1", "origin", commitSha], { timeout: 120_000 });
        await run("git", ["-C", repoDir, "checkout", "--detach", commitSha], { timeout: 60_000 });
      }
      const resolved = await gitHead(repoDir);
      if (resolved !== commitSha) throw new Error(`精确 SHA 校验失败：期望 ${commitSha}，实际 ${resolved}`);
    } else {
      commitSha = await gitHead(repoDir);
    }

    if (job.type === "incremental" && job.baseCommitSha) {
      changedFiles = await gitDiff(repoDir, job.baseCommitSha, commitSha).catch((err: unknown) => {
        logs.push(`git diff 失败（改为全量重扫）：${err instanceof Error ? err.message : err}`);
        return [];
      });
      if (changedFiles.length > 0) logs.push(`变更文件 ${changedFiles.length} 个`);
    }
  }

  await onProgress(42, "构建 Fact Index v2");
  const repositoryId = binding?.repositoryId !== null && binding?.repositoryId !== undefined
    ? String(binding.repositoryId)
    : binding?.repoFullName ?? job.projectId;
  const bundle = scanRepositoryV2(repoDir, {
    projectId: job.projectId,
    repositoryId,
    commitSha,
    changedFiles,
  });
  await onProgress(65, "构建确定性图谱与质量报告");
  const patch = emptyGraphPatch(bundle.baseGraph, repositoryId);
  const processed = postprocessGraph({
    baseGraph: bundle.baseGraph,
    factIndex: bundle.factIndex,
    symbolIndex: bundle.symbolIndex,
    diagnostics: bundle.diagnostics,
    patch,
    fileExists: (relativePath) => existsSync(path.join(repoDir, relativePath)),
  });
  const facts = bundle.legacyFacts;
  const graph = processed.graph;
  if (!processed.quality.publishable) {
    throw new Error(`语义质量门禁拒绝发布：${processed.quality.issues.slice(0, 5).map((issue) => issue.message).join("; ")}`);
  }
  logs.push(
    `扫描完成：${facts.modules.length} 模块 + ${facts.submodules.length} 次级模块 / ${facts.fileCount} 文件 / ` +
    `${bundle.factIndex.stats.factCount} facts → ${graph.nodes.length} 节点 / ${graph.edges.length} 边，质量=${processed.quality.disposition}`,
  );

  await onProgress(80, "校验");
  const result = validateGraph(graph, {
    fileExists: (rel) => existsSync(path.join(repoDir, rel)),
  });
  if (!result.ok) throw new Error(`graph.json 校验失败：${result.errors.slice(0, 5).join("; ")}`);

  const impact =
    changedFiles.length > 0
      ? {
          commitSha,
          baseCommitSha: job.baseCommitSha,
          changedFiles,
          ...computeImpact(graph, changedFiles),
        }
      : null;

  // 工作目录用完即删（源码不留存，spec §12-2）
  if (!process.env.LOCAL_REPO_PATH) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    graph,
    facts,
    impact,
    credits: 0,
    semanticEnhanced: false,
    commitSha,
    logs,
    archDoc: buildArchDoc(graph),
    scanArtifacts: {
      "facts.v2.json": bundle.factIndex,
      "symbol-index.json": bundle.symbolIndex,
      "interface-catalog.json": bundle.interfaceCatalog,
      "resource-catalog.json": bundle.resourceCatalog,
      "diagnostics.json": bundle.diagnostics,
      "analysis-packets.json": bundle.analysisPlan,
      "scanner-comparison.json": compareScannerVersions(job.projectId, bundle),
      "graph.base.json": bundle.baseGraph,
      "graph-patch.json": patch,
      "patch-validation.json": processed.validation,
      "accepted-patches.json": processed.validation.accepted,
      "rejected-patches.json": processed.validation.rejected,
      "conflicting-patches.json": processed.validation.conflicts,
      "quality-report.json": processed.quality,
      "scanner-manifest.json": {
        schemaVersion: "1.0",
        scannerVersion: bundle.factIndex.scannerVersion,
        factSchemaVersion: bundle.factIndex.schemaVersion,
        repositoryId,
        commitSha,
        generatedAt: bundle.factIndex.generatedAt,
        parserVersions: bundle.factIndex.parserVersions,
      },
    },
  };
}

export function buildArchDoc(graph: GraphDocument): string {
  const modules = graph.nodes.filter((node) => node.kind === "module");
  const infrastructure = graph.nodes.filter((node) => node.kind.startsWith("infra"));
  const lines = [
    "# 架构总览（自动生成）",
    "",
    `> commit \`${graph.commitSha}\` · ${graph.nodes.length} 节点 / ${graph.edges.length} 边`,
    "",
    "## 模块清单",
    "",
    "| 模块 | 路径 | 职责摘要 |",
    "|---|---|---|",
    ...modules.map(
      (module) =>
        `| ${module.name} | \`${module.path ?? "-"}\` | ${(module.summary ?? "—").replace(/\|/g, "/").slice(0, 100)} |`,
    ),
    "",
    "## 基础设施依赖",
    "",
    ...(infrastructure.length > 0
      ? infrastructure.map((node) => `- **${node.name}**（${node.kind}）`)
      : ["- 未从代码中识别出基础设施组件"]),
    "",
    "## 模块关系",
    "",
    ...graph.edges.slice(0, 200).map((edge) => {
      const source = graph.nodes.find((node) => node.id === edge.source)?.name ?? edge.source;
      const target = graph.nodes.find((node) => node.id === edge.target)?.name ?? edge.target;
      const evidence = edge.evidence?.[0];
      return `- ${source} → ${target}（${edge.type}${edge.inferred ? "，【推断】" : ""}）${
        evidence ? ` — \`${evidence.file}:${evidence.startLine}\`` : ""
      }`;
    }),
  ];
  return lines.join("\n");
}

// ── runner（完整两段式） ────────────────────────────────────────────────
async function analyzeRunner(
  job: JobDto,
  binding: BindingDto | null,
  onProgress: ProgressFn,
): Promise<AnalyzeResult> {
  if (!binding) throw new Error("未绑定仓库，无法拉起 Runner");
  const logs: string[] = [];
  const jobWork = path.join(config.workspaceDir, job.id);
  const containerName = `visionowl-job-${safeCacheSegment(job.id)}`;
  const runnerEnvFile = path.join(jobWork, "runner.env");
  await fs.mkdir(path.join(jobWork, "out"), { recursive: true });

  const installation = binding.installationId
    ? await createInstallationToken(binding.installationId)
    : null;
  // 无 installation 时不阻断：公开仓库由 entrypoint 走无 token 克隆（GIT_TOKEN 置空），
  // 私有仓库会在容器内 clone 阶段失败并把真实原因带回任务日志
  if (!installation) logs.push("无 Installation Token，按公开仓库方式克隆（契约 v1.1）");

  const maxTurns = job.type === "full" ? config.maxTurnsFull : config.maxTurnsIncremental;
  const timeout = (job.type === "full" ? config.jobTimeoutFull : config.jobTimeoutIncremental) * 1000;
  const repositoryKey = bindingRepositoryKey(binding);
  const cachedRepo = job.targetCommitSha
    ? await findSourceCache(job.projectId, repositoryKey, job.targetCommitSha)
    : null;
  logs.push(cachedRepo ? "命中当前 commit 源码缓存，跳过 GitHub 下载" : "当前 commit 无源码缓存，本次完成后暂存复用");

  await onProgress(20, "拉起 Runner 容器");
  await writeRunnerEnv(runnerEnvFile, {
    QODER_PERSONAL_ACCESS_TOKEN: config.qoderPat,
    AGENT_ORCHESTRATION_MODE: config.agentOrchestrationMode,
    MODULE_MODEL: config.qoderModuleModel,
    SYNTHESIS_MODEL: config.qoderSynthesisModel,
    SYNTHESIS_MAX_TURNS: config.qoderSynthesisMaxTurns,
    ADAPTIVE_SINGLE_AGENT_MAX_PACKETS: config.adaptiveSingleAgentMaxPackets,
    ADAPTIVE_MAX_AGENTS: config.adaptiveMaxAgents,
    ADAPTIVE_PACKETS_PER_AGENT: config.adaptivePacketsPerAgent,
    MODULE_AGENT_CONCURRENCY: config.moduleAgentConcurrency,
    MODULE_AGENT_MAX_TASKS: config.moduleAgentMaxTasks,
    MODULE_AGENT_TIMEOUT_SECONDS: config.moduleAgentTimeoutSeconds,
    MODULE_AGENT_MAX_OUTPUT_TOKENS: config.moduleAgentMaxOutputTokens,
    MODULE_AGENT_CONTEXT_MAX_BYTES: config.moduleAgentContextMaxBytes,
    MODULE_AGENT_CONTEXT_MAX_FILES: config.moduleAgentContextMaxFiles,
    MODULE_AGENT_REPAIR_ENABLED: config.moduleAgentRepairEnabled ? "1" : "0",
    MODULE_REPAIR_MODEL: config.qoderModuleRepairModel,
    MODULE_AGENT_REPAIR_MAX_OUTPUT_TOKENS: config.moduleAgentRepairMaxOutputTokens,
    MODULE_AGENT_REPAIR_MAX_CANDIDATE_BYTES: config.moduleAgentRepairMaxCandidateBytes,
    GIT_TOKEN: installation?.token ?? "",
    REPO: binding.repoFullName,
    BRANCH: binding.branch,
    COMMIT_SHA: job.targetCommitSha ?? "",
    BASE_SHA: job.baseCommitSha ?? "",
    JOB_TYPE: job.type,
    PROJECT_ID: job.projectId,
    MAX_TURNS: maxTurns,
    SOURCE_PREPARED: cachedRepo ? "1" : "0",
    EXPORT_SOURCE_CACHE: cachedRepo ? "0" : "1",
    REPOSITORY_ID: binding.repositoryId !== null ? String(binding.repositoryId) : binding.repoFullName,
  });
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--label",
    "visionowl.runner=true",
    "--label",
    `visionowl.job-id=${job.id}`,
    `--memory=${config.runnerMemory}`,
    `--cpus=${config.runnerCpus}`,
    `--network=${config.runnerNetwork}`,
    "--env-file",
    runnerEnvFile,
    "-v",
    `${jobWork}:/workspace`,
  ];
  if (cachedRepo) {
    args.push("-v", `${cachedRepo}:/workspace/repo:ro`);
  }
  args.push(config.runnerImage);

  const stageProgress: Record<string, [number, string]> = {
    cache_hit: [24, "复用当前提交源码缓存"],
    checking_repository: [25, "检查 GitHub 仓库连通性"],
    waiting_repository: [27, "GitHub 链路波动，10 秒后重试"],
    cloning_repository: [30, "拉取目标提交源码"],
    downloading_archive: [32, "Git 通道不可用，切换 GitHub 官方源码归档"],
    source_ready: [38, "源码准备完成"],
    scanning: [45, "扫描代码结构与依赖"],
    fact_indexing: [52, "构建 Fact Index 与符号索引"],
    adaptive_analysis: [60, "自适应 Agent 正在分析关键架构模块"],
    module_analysis: [58, "模块 Agent 正在并行分析"],
    global_synthesis: [66, "全局 Agent 正在汇总代码架构"],
    semantic_analysis: [66, "Qoder 正在增强图谱与架构文档"],
    patch_validation: [72, "校验 Agent 图谱修正"],
    quality_review: [74, "执行语义质量门禁"],
    validating: [70, "校验图谱产物"],
    completed: [74, "Runner 分析完成"],
  };
  let lastStage = "";
  let progressChain = Promise.resolve();
  const pollStage = async (): Promise<void> => {
    const stage = await fs
      .readFile(path.join(jobWork, "out", "runner-stage"), "utf8")
      .then((value) => value.trim())
      .catch(() => "");
    if (!stage || stage === lastStage || !stageProgress[stage]) return;
    lastStage = stage;
    const [progress, note] = stageProgress[stage];
    progressChain = progressChain
      .then(() => onProgress(progress, note))
      .then(() => undefined)
      .catch(() => undefined);
    await progressChain;
  };

  await run("docker", ["rm", "-f", containerName], { timeout: 30_000 }).catch(() => undefined);
  const stageTimer = setInterval(() => void pollStage(), 500);

  try {
    const { stdout, stderr } = await run("docker", args, {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    // 日志中可能出现 token，统一屏蔽
    logs.push(scrub(stdout).slice(-4000));
    if (stderr) logs.push(scrub(stderr).slice(-2000));
  } catch (err) {
    const message = commandErrorMessage(err);
    if (!cachedRepo) {
      await promoteSourceCache(jobWork, job.projectId, repositoryKey, job.targetCommitSha ?? undefined).catch(
        () => null,
      );
    }
    await fs.rm(jobWork, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Runner 执行失败：${message}`);
  } finally {
    clearInterval(stageTimer);
    await pollStage();
    await run("docker", ["rm", "-f", containerName], { timeout: 30_000 }).catch(() => undefined);
    await fs.rm(runnerEnvFile, { force: true }).catch(() => undefined);
  }

  if (!cachedRepo) {
    const promoted = await promoteSourceCache(
      jobWork,
      job.projectId,
      repositoryKey,
      job.targetCommitSha ?? undefined,
    );
    if (promoted) logs.push("已缓存当前 commit 源码，后续 Agent 对话无需重新下载");
  }

  await onProgress(75, "回收产物");
  const graph = JSON.parse(
    await fs.readFile(path.join(jobWork, "out", "graph.json"), "utf8"),
  ) as GraphDocument;

  let facts: unknown | null = null;
  try {
    facts = JSON.parse(await fs.readFile(path.join(jobWork, "out", "facts.json"), "utf8"));
  } catch {
    facts = null;
  }

  let impact: ImpactReport | null = null;
  try {
    impact = JSON.parse(await fs.readFile(path.join(jobWork, "out", "impact.json"), "utf8")) as ImpactReport;
  } catch {
    impact = null;
  }

  let credits = 0;
  let semanticEnhanced = false;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(jobWork, "out", "meta.json"), "utf8")) as {
      credits?: number;
      semanticEnhanced?: boolean;
    };
    credits = typeof meta.credits === "number" ? meta.credits : 0;
    semanticEnhanced = meta.semanticEnhanced === true;
  } catch {
    credits = 0;
  }

  const result = validateGraph(graph);
  if (!result.ok) throw new Error(`Runner 产物校验失败：${result.errors.slice(0, 5).join("; ")}`);
  if (job.targetCommitSha && graph.commitSha !== job.targetCommitSha) {
    throw new Error(`Runner commit 不一致：期望 ${job.targetCommitSha}，实际 ${graph.commitSha}`);
  }

  let archDoc: string | null = null;
  try {
    archDoc = await fs.readFile(path.join(jobWork, "out", "ARCHITECTURE.md"), "utf8");
  } catch {
    archDoc = buildArchDoc(graph);
    logs.push("Qoder 未产出 ARCHITECTURE.md，使用确定性文档兜底");
  }
  logs.push(semanticEnhanced ? "Qoder 语义增强完成" : "Qoder 未完成语义增强，使用确定性图谱");

  const scanArtifactNames = [
    "facts.v2.json",
    "symbol-index.json",
    "interface-catalog.json",
    "resource-catalog.json",
    "diagnostics.json",
    "analysis-packets.json",
    "scanner-comparison.json",
    "graph.base.json",
    "graph-patch.json",
    "patch-validation.json",
    "accepted-patches.json",
    "rejected-patches.json",
    "conflicting-patches.json",
    "agent-patch.rejected.json",
    "agent-patch-validation.rejected.json",
    "agent-rejected-patches.json",
    "agent-conflicting-patches.json",
    "module-analysis-report.json",
    "module-agent-meta.json",
    "analysis-summary.json",
    "quality-report.json",
    "scanner-manifest.json",
  ] as const;
  const scanArtifacts: Record<string, unknown> = {};
  for (const name of scanArtifactNames) {
    try {
      scanArtifacts[name] = JSON.parse(await fs.readFile(path.join(jobWork, "out", name), "utf8")) as unknown;
    } catch {
      // 兼容灰度期间仍运行 v1 镜像的任务。
    }
  }

  // 容器与工作目录一并销毁（--rm 已回收容器）
  await fs.rm(jobWork, { recursive: true, force: true }).catch(() => undefined);

  return {
    graph,
    facts,
    impact,
    credits,
    semanticEnhanced,
    commitSha: graph.commitSha,
    logs,
    archDoc,
    scanArtifacts,
  };
}

export interface DocgenResult {
  markdown: string;
  credits: number;
}

export interface SourceChatInput {
  question: string;
  nodeId: string;
  nodeName: string;
  nodePath: string;
  groundedDraft: string;
}

export interface SourceChatResult {
  text: string;
  credits: number;
}

export type SourceChatStage =
  | "queued"
  | "preparing_source"
  | "cache_hit"
  | "reading_source"
  | "finalizing";

export interface SourceChatStatus {
  stage: SourceChatStage;
  note: string;
}

export type SourceChatProgressFn = (status: SourceChatStatus) => void | Promise<void>;

const SOURCE_CHAT_NOTES: Record<SourceChatStage, string> = {
  queued: "任务已进入 Agent 队列",
  preparing_source: "首次对话：正在准备当前提交源码",
  cache_hit: "已复用当前提交源码缓存",
  reading_source: "Qoder 正在阅读当前提交源码",
  finalizing: "正在整理代码证据与回答",
};

export async function runDocgen(
  taskId: string,
  projectId: string,
  binding: BindingDto,
  nodeId: string,
  nodePath: string | undefined,
  commitSha: string,
): Promise<DocgenResult> {
  const jobWork = path.join(config.workspaceDir, `docgen-${taskId}`);
  await fs.mkdir(path.join(jobWork, "out"), { recursive: true });
  const repositoryKey = bindingRepositoryKey(binding);
  const cachedRepo = await findSourceCache(projectId, repositoryKey, commitSha);

  const installation = binding.installationId
    ? await createInstallationToken(binding.installationId).catch(() => null)
    : null;
  const args = [
    "run",
    "--rm",
    "--memory=4g",
    "--cpus=2",
    `--network=${config.runnerNetwork}`,
    "-e",
    "RUN_MODE=docgen",
    "-e",
    `DOC_NODE_ID=${nodeId}`,
    "-e",
    `DOC_NODE_PATH=${nodePath ?? ""}`,
    "-e",
    `QODER_PERSONAL_ACCESS_TOKEN=${config.qoderPat}`,
    "-e",
    `GIT_TOKEN=${installation?.token ?? ""}`,
    "-e",
    `REPO=${binding.repoFullName}`,
    "-e",
    `BRANCH=${binding.branch}`,
    "-e",
    `COMMIT_SHA=${commitSha}`,
    "-e",
    `MAX_TURNS=${config.maxTurnsIncremental}`,
    "-v",
    `${jobWork}:/workspace`,
  ];
  if (cachedRepo) {
    args.push("-e", "SOURCE_PREPARED=1", "-v", `${cachedRepo}:/workspace/repo:ro`);
  } else {
    args.push("-e", "EXPORT_SOURCE_CACHE=1");
  }
  args.push(config.runnerImage);

  try {
    const { stdout } = await run("docker", args, {
      timeout: config.jobTimeoutIncremental * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (stdout) console.log(`[docgen ${taskId}] ${scrub(stdout).slice(-1200)}`);
    const markdown = await fs.readFile(path.join(jobWork, "out", "moduledoc.md"), "utf8");
    const meta = await fs
      .readFile(path.join(jobWork, "out", "meta.json"), "utf8")
      .then((raw) => JSON.parse(raw) as { credits?: number })
      .catch((): { credits?: number } => ({}));
    return { markdown, credits: typeof meta.credits === "number" ? meta.credits : 0 };
  } catch (error) {
    const message = commandErrorMessage(error);
    throw new Error(`Docgen Runner 执行失败：${message}`);
  } finally {
    if (!cachedRepo) {
      await promoteSourceCache(jobWork, projectId, repositoryKey, commitSha).catch(() => null);
    }
    await fs.rm(jobWork, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runSourceChat(
  taskId: string,
  projectId: string,
  binding: BindingDto,
  commitSha: string,
  input: SourceChatInput,
  onProgress?: SourceChatProgressFn,
): Promise<SourceChatResult> {
  const jobWork = path.join(config.workspaceDir, `chat-${taskId}`);
  const containerName = `visionowl-chat-${safeCacheSegment(taskId)}`;
  await fs.mkdir(path.join(jobWork, "out"), { recursive: true });
  await fs.writeFile(path.join(jobWork, "input.json"), JSON.stringify(input), "utf8");
  const repositoryKey = bindingRepositoryKey(binding);
  const cachedRepo = await findSourceCache(projectId, repositoryKey, commitSha);
  let lastStage: SourceChatStage | null = null;
  let progressChain = Promise.resolve();
  const report = async (stage: SourceChatStage): Promise<void> => {
    if (stage === lastStage) return;
    lastStage = stage;
    progressChain = progressChain
      .then(() => onProgress?.({ stage, note: SOURCE_CHAT_NOTES[stage] }))
      .then(() => undefined)
      .catch(() => undefined);
    await progressChain;
  };
  const pollStage = async (): Promise<void> => {
    const raw = await fs.readFile(path.join(jobWork, "out", "chat-stage"), "utf8").catch(() => "");
    const stage = raw.trim() as SourceChatStage;
    if (Object.hasOwn(SOURCE_CHAT_NOTES, stage)) await report(stage);
  };
  await report(cachedRepo ? "cache_hit" : "preparing_source");

  const installation = binding.installationId
    ? await createInstallationToken(binding.installationId).catch(() => null)
    : null;
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--memory=4g",
    "--cpus=2",
    `--network=${config.runnerNetwork}`,
    "-e",
    "RUN_MODE=chat",
    "-e",
    `QODER_PERSONAL_ACCESS_TOKEN=${config.qoderPat}`,
    "-e",
    `CHAT_MODEL=${config.qoderChatModel}`,
    "-e",
    `GIT_TOKEN=${installation?.token ?? ""}`,
    "-e",
    `REPO=${binding.repoFullName}`,
    "-e",
    `BRANCH=${binding.branch}`,
    "-e",
    `COMMIT_SHA=${commitSha}`,
    "-e",
    `MAX_TURNS=${config.qoderChatMaxTurns}`,
    "-e",
    `MAX_OUTPUT_TOKENS=${config.qoderChatMaxOutputTokens}`,
    "-v",
    `${jobWork}:/workspace`,
  ];
  if (cachedRepo) {
    args.push("-e", "SOURCE_PREPARED=1", "-v", `${cachedRepo}:/workspace/repo:ro`);
  } else {
    args.push("-e", "EXPORT_SOURCE_CACHE=1");
  }
  args.push(config.runnerImage);

  const stageTimer = setInterval(() => void pollStage(), 200);

  try {
    const { stdout, stderr } = await run("docker", args, {
      timeout: config.qoderChatTimeoutSeconds * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    await pollStage();
    if (stdout) console.log(`[chat ${taskId}] ${scrub(stdout).slice(-1200)}`);
    if (stderr) console.warn(`[chat ${taskId}] ${scrub(stderr).slice(-600)}`);
    const result = JSON.parse(
      await fs.readFile(path.join(jobWork, "out", "chat.json"), "utf8"),
    ) as { text?: unknown; credits?: unknown };
    if (typeof result.text !== "string" || result.text.trim().length === 0) {
      throw new Error("Chat Runner 未返回回答正文");
    }
    return {
      text: result.text.trim(),
      credits: typeof result.credits === "number" ? result.credits : 0,
    };
  } catch (error) {
    const message = error instanceof Error ? scrub(error.message) : String(error);
    throw new Error(`Chat Runner 执行失败：${message}`);
  } finally {
    clearInterval(stageTimer);
    await pollStage();
    await run("docker", ["rm", "-f", containerName], { timeout: 30_000 }).catch(() => undefined);
    if (!cachedRepo) {
      await promoteSourceCache(jobWork, projectId, repositoryKey, commitSha).catch(() => null);
    }
    await fs.rm(jobWork, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────
async function gitHead(repoDir: string): Promise<string> {
  const { stdout } = await run("git", ["-C", repoDir, "rev-parse", "HEAD"], { timeout: 30_000 });
  return stdout.trim().slice(0, 40);
}

async function gitDiff(repoDir: string, base: string, head: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", repoDir, "diff", "--name-only", `${base}..${head}`], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 日志脱敏：任何 token 样式串一律屏蔽 */
function scrub(text: string): string {
  return text
    .replace(/x-access-token:[^@\s]+/g, "x-access-token:***")
    .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, "gh*_***")
    .replace(/[A-Za-z0-9_-]{40,}/g, (m) => `${m.slice(0, 6)}***`);
}

function commandErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return scrub(String(error));
  const output = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  const details = [output.stdout, output.stderr]
    .map((value) => value?.toString().trim() ?? "")
    .filter(Boolean)
    .join("\n");
  return scrub(details || error.message).slice(-4000);
}
