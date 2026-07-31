"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { runCodex } = require("./codex-agent");
const {
  readSemanticCache,
  writeSemanticCache,
} = require("./analysis-cache");
const { batchGraph } = require("./understand-static-graph");

function trimStructure(result) {
  if (!result) return null;
  return {
    path: result.path,
    language: result.language,
    fileCategory: result.fileCategory,
    totalLines: result.totalLines,
    nonEmptyLines: result.nonEmptyLines,
    metrics: result.metrics,
    functions: result.functions?.slice(0, 24),
    classes: result.classes?.slice(0, 12),
    exports: result.exports?.slice(0, 24),
    callGraph: result.callGraph?.slice(0, 36),
    services: result.services?.slice(0, 12),
    endpoints: result.endpoints?.slice(0, 20),
    steps: result.steps?.slice(0, 20),
    resources: result.resources?.slice(0, 20),
    definitions: result.definitions?.slice(0, 20),
  };
}

function compactNode(node) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    filePath: node.filePath,
    lineRange: node.lineRange,
    summary: node.summary,
    tags: node.tags,
    complexity: node.complexity,
  };
}

function compactEdge(edge) {
  return {
    source: edge.source,
    target: edge.target,
    type: edge.type,
    direction: edge.direction,
    weight: edge.weight,
  };
}

function fileContentHash(repoPath, filePath) {
  try {
    return createHash("sha256")
      .update(fs.readFileSync(path.join(repoPath, filePath)))
      .digest("hex");
  } catch (_error) {
    return "unreadable";
  }
}

function semanticBatchInput(batch, graph, structuresByPath, repoPath) {
  const staticBatch = batchGraph(graph, batch);
  return {
    schemaVersion: 1,
    batchIndex: batch.batchIndex,
    files: (batch.files || []).map((file) => trimStructure(structuresByPath.get(file.path))),
    contentHashes: Object.fromEntries(
      (batch.files || []).map((file) => [
        file.path,
        fileContentHash(repoPath, file.path),
      ]),
    ),
    nodes: staticBatch.nodes.map(compactNode),
    immutableEdges: staticBatch.edges.map(compactEdge),
    neighborMap: batch.neighborMap || {},
  };
}

function batchScore(batch) {
  const crossBatchReferences = Object.values(batch.neighborMap || {}).reduce(
    (count, neighbors) => count + (Array.isArray(neighbors) ? neighbors.length : 0),
    0,
  );
  const sourceLines = (batch.files || []).reduce(
    (count, file) => count + Number(file.sizeLines || 0),
    0,
  );
  return crossBatchReferences * 1_000_000 + sourceLines;
}

function selectSemanticBatches(values, maxBatches) {
  if (maxBatches <= 0 || values.length <= maxBatches) return [...values];
  const ranked = [...values].sort(
    (left, right) =>
      batchScore(right) - batchScore(left) ||
      Number(left.batchIndex) - Number(right.batchIndex),
  );
  const selected = new Map();
  for (const batch of ranked) {
    for (const file of batch.files || []) {
      const domain = String(file.path || "").split("/").filter(Boolean)[0];
      if (domain && !selected.has(domain)) selected.set(domain, batch);
    }
  }
  const result = [...new Set(selected.values())].slice(0, maxBatches);
  for (const batch of ranked) {
    if (result.length >= maxBatches) break;
    if (!result.includes(batch)) result.push(batch);
  }
  return result.sort(
    (left, right) => Number(left.batchIndex) - Number(right.batchIndex),
  );
}

function semanticBatchPrompt(skillPath, input) {
  const rulesPath = path.resolve(path.dirname(skillPath), "../../agents/file-analyzer.md");
  return [
    "你是 VisionOwl 的 Understand Anything 语义分析器。",
    `原始语义规则位于 ${rulesPath}，本任务实现其中 Phase 2 Semantic Analysis。`,
    "结构提取、文件节点、Import、contains 和 exports 关系已经由原项目脚本确定。",
    "不要执行命令，不要创建文件，不要重新扫描仓库。",
    "只为输入中的现有节点补充准确的中文 summary、tags、complexity 和可选 languageNotes。",
    "只在源码证据明确且输入节点 ID 均存在时补充语义边。",
    "不得改变、删除或重复 immutableEdges，不得创造新节点 ID。",
    "结果必须严格满足输出 Schema。",
    "",
    JSON.stringify(input),
  ].join("\n");
}

async function mapConcurrent(values, limit, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, limit), Math.max(1, values.length)) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

async function analyzeSemanticBatches({
  repoPath,
  dataDir,
  batches,
  graph,
  structuresByPath,
  skillPath,
  onProgress = () => {},
  runCodexImpl = runCodex,
}) {
  if (String(process.env.VISIONOWL_CODEX_ENABLED || "true") === "false") {
    return {
      results: [],
      warnings: ["Codex 语义增强已通过 VISIONOWL_CODEX_ENABLED=false 关闭"],
      cacheHits: 0,
    };
  }

  const schemaPath = path.resolve(
    __dirname,
    "../schemas/understand-semantic-batch.schema.json",
  );
  const values = batches.batches || [];
  const warnings = [];
  let completed = 0;
  let cacheHits = 0;
  const configuredMaxBatches = Number(
    process.env.VISIONOWL_SEMANTIC_MAX_BATCHES || 12,
  );
  const maxBatches = Number.isFinite(configuredMaxBatches)
    ? Math.max(0, Math.floor(configuredMaxBatches))
    : 12;
  const selectedValues = selectSemanticBatches(values, maxBatches);
  const skippedBatches = Math.max(0, values.length - selectedValues.length);
  const configuredConcurrency = Number(
    process.env.VISIONOWL_SEMANTIC_CONCURRENCY || 4,
  );
  const concurrency = Number.isFinite(configuredConcurrency)
    ? Math.max(1, Math.floor(configuredConcurrency))
    : 4;
  const configuredTimeoutMs = Number(
    process.env.VISIONOWL_SEMANTIC_TIMEOUT_MS || 60 * 1000,
  );
  const timeoutMs = Number.isFinite(configuredTimeoutMs)
    ? Math.max(1000, configuredTimeoutMs)
    : 60 * 1000;
  const configuredBudgetMs = Number(
    process.env.VISIONOWL_SEMANTIC_BUDGET_MS || 3 * 60 * 1000,
  );
  const budgetMs = Number.isFinite(configuredBudgetMs)
    ? Math.max(1000, configuredBudgetMs)
    : 3 * 60 * 1000;
  const deadline = Date.now() + Math.max(1000, budgetMs);

  if (skippedBatches > 0) {
    const warning =
      `大型仓库共有 ${values.length} 个批次；选择 ${selectedValues.length} 个关键批次做语义增强，` +
      `其余 ${skippedBatches} 批保留完整静态代码事实`;
    warnings.push(warning);
    onProgress(0, selectedValues.length, warning);
  }

  const results = await mapConcurrent(selectedValues, concurrency, async (batch) => {
    const input = semanticBatchInput(batch, graph, structuresByPath, repoPath);
    const cached = readSemanticCache(dataDir, input);
    if (cached) {
      cacheHits += 1;
      completed += 1;
      onProgress(
        completed,
        selectedValues.length,
        `已复用第 ${batch.batchIndex} 批语义缓存`,
      );
      return cached;
    }

    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("语义增强总时间预算已用完");
      }
      const response = await runCodexImpl({
        repoPath,
        prompt: semanticBatchPrompt(skillPath, input),
        schemaPath,
        timeoutMs: Math.min(timeoutMs, remainingMs),
        sandbox: "read-only",
      });
      const parsed = JSON.parse(response.content);
      writeSemanticCache(dataDir, input, parsed);
      completed += 1;
      onProgress(
        completed,
        selectedValues.length,
        `已完成第 ${batch.batchIndex} 批语义增强`,
      );
      return parsed;
    } catch (error) {
      completed += 1;
      const warning = `第 ${batch.batchIndex} 批语义增强失败，保留静态事实：${error.message}`;
      warnings.push(warning);
      onProgress(completed, selectedValues.length, warning);
      return { nodes: [], edges: [] };
    }
  });

  return {
    results,
    warnings,
    cacheHits,
    analyzedBatches: selectedValues.length,
    skippedBatches,
  };
}

async function analyzeArchitecture({
  repoPath,
  dataDir,
  groups,
  skillPath,
  runCodexImpl = runCodex,
}) {
  if (
    groups.length === 0 ||
    String(process.env.VISIONOWL_CODEX_ENABLED || "true") === "false"
  ) {
    return null;
  }
  const input = {
    schemaVersion: 1,
    groups: groups.map((group) => ({
      id: group.id,
      defaultName: group.defaultName,
      facts: group.facts,
    })),
  };
  const cached = readSemanticCache(dataDir, {
    kind: "architecture",
    ...input,
  });
  if (cached) return cached;

  const schemaPath = path.resolve(
    __dirname,
    "../schemas/understand-architecture.schema.json",
  );
  const rulesPath = path.resolve(
    path.dirname(skillPath),
    "../../agents/architecture-analyzer.md",
  );
  const prompt = [
    "你是 VisionOwl 的 Understand Anything 架构命名器。",
    `参考原始规则 ${rulesPath}，但目录分组、依赖指标和节点归属已经由后端确定。`,
    "不要执行命令，不要读取或修改文件，不要改变分组 ID，也不要重新分配文件。",
    "根据 facts 为每个输入分组给出准确、简洁的中文架构名称和职责描述。",
    "repository 是不可跨越的服务边界；名称必须描述该仓库内模块的真实职责，不能使用泛化的元数据或文件分类名称。",
    "description 要说明入口、调度、协议、存储或结果处理等具体用途，不要把文件数和语言作为主要描述。",
    "同时按新成员最容易理解的顺序，为每个分组生成一个 tour 项。",
    "layers 和 tour 必须各覆盖每个输入分组恰好一次。",
    "",
    JSON.stringify(input),
  ].join("\n");
  const response = await runCodexImpl({
    repoPath,
    prompt,
    schemaPath,
    timeoutMs: Number(
      process.env.VISIONOWL_ARCHITECTURE_TIMEOUT_MS || 5 * 60 * 1000,
    ),
    sandbox: "read-only",
  });
  const parsed = JSON.parse(response.content);
  writeSemanticCache(
    dataDir,
    {
      kind: "architecture",
      ...input,
    },
    parsed,
  );
  return parsed;
}

module.exports = {
  analyzeArchitecture,
  analyzeSemanticBatches,
  mapConcurrent,
  selectSemanticBatches,
  semanticBatchInput,
};
