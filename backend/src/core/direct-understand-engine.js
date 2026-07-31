"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  analyzeArchitecture,
  analyzeSemanticBatches,
  mapConcurrent,
} = require("./semantic-analyzer");
const {
  applySemanticEnrichment,
  batchGraph,
  buildStaticGraph,
  fileNodeId,
} = require("./understand-static-graph");
const {
  buildArchitectureGroups,
  buildLayers,
  buildTour,
} = require("./architecture-metrics");
const { runProcess } = require("./understand-process");

const DIRECT_ENGINE_VERSION = "direct-v2-repository-boundaries";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}

function scanExcludeArgs(repoPath) {
  const patterns = [
    ".DS_Store",
    "**/.DS_Store",
    "Thumbs.db",
    "**/Thumbs.db",
    "*.tsbuildinfo",
    "**/*.tsbuildinfo",
    ".ua",
    ".ua/**",
    "**/.ua",
    "**/.ua/**",
    ".understand-anything",
    ".understand-anything/**",
    "**/.understand-anything",
    "**/.understand-anything/**",
  ];
  try {
    const gitIgnore = fs
      .readFileSync(path.join(repoPath, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    patterns.push(...gitIgnore);
  } catch (_error) {
    // Repositories without a root .gitignore still receive the OS-noise defaults.
  }
  return [...new Set(patterns)].flatMap((pattern) => ["--exclude", pattern]);
}

function gitCommit(repoPath) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_error) {
    return "";
  }
}

function python310Binary() {
  const candidates = [
    process.env.PYTHON_BIN,
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
    "/opt/homebrew/bin/python3.13",
    "/opt/homebrew/bin/python3.12",
    "/usr/local/bin/python3.12",
    "/usr/local/bin/python3.11",
    "python3",
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const result = spawnSync(
      candidate,
      ["-c", "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)"],
      { encoding: "utf8" },
    );
    if (result.status === 0 && Number(result.stdout.trim()) >= 310) {
      return candidate;
    }
  }
  throw new Error(
    "Understand Anything graph merge requires Python 3.10 or newer. Set PYTHON_BIN to a compatible interpreter.",
  );
}

function readManifest(repoPath) {
  for (const name of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    const filePath = path.join(repoPath, name);
    if (!fs.existsSync(filePath)) continue;
    if (name === "package.json") {
      try {
        return { kind: name, value: readJson(filePath) };
      } catch (_error) {
        return { kind: name, value: {} };
      }
    }
    try {
      return { kind: name, value: fs.readFileSync(filePath, "utf8") };
    } catch (_error) {
      return { kind: name, value: "" };
    }
  }
  return { kind: "", value: {} };
}

function projectName(repoPath, manifest) {
  if (manifest.kind === "package.json" && manifest.value.name) {
    return manifest.value.name;
  }
  if (manifest.kind === "go.mod") {
    return manifest.value.match(/^module\s+(.+)$/m)?.[1] || path.basename(repoPath);
  }
  return path.basename(repoPath);
}

function readDescription(repoPath, manifest) {
  if (manifest.kind === "package.json" && manifest.value.description) {
    return manifest.value.description;
  }
  const readme = ["README.md", "README.MD", "README", "readme.md"]
    .map((name) => path.join(repoPath, name))
    .find((filePath) => fs.existsSync(filePath));
  if (!readme) return `代码仓库 ${path.basename(repoPath)}。`;
  try {
    const paragraph = fs
      .readFileSync(readme, "utf8")
      .split(/\n\s*\n/)
      .map((value) =>
        value
          .replace(/^---[\s\S]*?---\s*/m, "")
          .replace(/^#+\s*/gm, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .trim(),
      )
      .find((value) => value && !/^<[^>]+>/.test(value));
    return paragraph?.slice(0, 500) || `代码仓库 ${path.basename(repoPath)}。`;
  } catch (_error) {
    return `代码仓库 ${path.basename(repoPath)}。`;
  }
}

function detectFrameworks(manifest) {
  if (manifest.kind !== "package.json") return [];
  const dependencies = {
    ...(manifest.value.dependencies || {}),
    ...(manifest.value.devDependencies || {}),
  };
  const known = [
    "react",
    "next",
    "vue",
    "vite",
    "express",
    "fastify",
    "nestjs",
    "@nestjs/core",
    "electron",
  ];
  return known.filter((name) => dependencies[name]);
}

function projectMetadata(repoPath, scan, analyzedAt) {
  const manifest = readManifest(repoPath);
  const languageCounts = scan.stats?.byLanguage || {};
  const languages = Object.entries(languageCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([language]) => language);
  return {
    name: projectName(repoPath, manifest),
    languages,
    frameworks: detectFrameworks(manifest),
    description: readDescription(repoPath, manifest),
    analyzedAt,
    gitCommitHash: gitCommit(repoPath) || scan.contentDigest || "unknown",
  };
}

function knowledgeGraph(project, graph, layers, tour) {
  return {
    version: "1.0.0",
    kind: "codebase",
    project,
    nodes: graph.nodes,
    edges: graph.edges,
    layers,
    tour,
  };
}

function clearBatchArtifacts(intermediateDir) {
  if (!fs.existsSync(intermediateDir)) return;
  for (const file of fs.readdirSync(intermediateDir)) {
    if (
      /^batch-(?:existing|\d+(?:-part-\d+)?)\.json$/.test(file) ||
      ["assembled-graph.json", "assemble-review.json", "layers.json", "tour.json"].includes(
        file,
      )
    ) {
      fs.rmSync(path.join(intermediateDir, file), { force: true });
    }
  }
}

function validGraph(value) {
  return Boolean(
    value &&
      Array.isArray(value.nodes) &&
      Array.isArray(value.edges) &&
      Array.isArray(value.layers),
  );
}

function ensureGraphIntegrity(graph) {
  const nodeIds = new Set();
  graph.nodes = graph.nodes.filter((node) => {
    if (!node.id || nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
    return true;
  });
  const edgeKeys = new Set();
  graph.edges = graph.edges.filter((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false;
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    if (edge.source === edge.target || edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    return true;
  });
  graph.layers = graph.layers
    .map((layer) => ({
      ...layer,
      nodeIds: [...new Set(layer.nodeIds)].filter((id) => nodeIds.has(id)),
    }))
    .filter((layer) => layer.nodeIds.length > 0);
  const layerIds = new Set(graph.layers.map((layer) => layer.id));
  graph.tour = graph.tour
    .filter((step) => step.nodeIds.some((id) => nodeIds.has(id)))
    .map((step, index) => ({
      ...step,
      order: index + 1,
      nodeIds: step.nodeIds.filter((id) => nodeIds.has(id)),
    }));
  if (graph.layers.length === 0 || layerIds.size !== graph.layers.length) {
    throw new Error("Direct Understand Engine could not produce valid architecture layers.");
  }
  return graph;
}

function graphQuality(graph, scan) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const representedFiles = new Set(
    graph.nodes.map((node) => node.filePath).filter(Boolean),
  );
  const expectedImports = Object.values(scan.importMap || {}).reduce(
    (sum, targets) => sum + targets.length,
    0,
  );
  const actualImports = graph.edges.filter((edge) => edge.type === "imports").length;
  const layered = new Set(graph.layers.flatMap((layer) => layer.nodeIds));
  const fileNodeIds = scan.files.map(fileNodeId);
  return {
    scannedFiles: scan.files.length,
    representedFiles: representedFiles.size,
    fileCoverage:
      scan.files.length === 0 ? 1 : representedFiles.size / scan.files.length,
    expectedImports,
    actualImports,
    importRecall: expectedImports === 0 ? 1 : actualImports / expectedImports,
    danglingEdges: graph.edges.filter(
      (edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target),
    ).length,
    architectureCoverage:
      fileNodeIds.length === 0
        ? 1
        : fileNodeIds.filter((id) => layered.has(id)).length / fileNodeIds.length,
  };
}

async function extractStructures({
  repoPath,
  skillDir,
  dataDir,
  batches,
  runProcessImpl,
  onProgress,
}) {
  const tmpDir = path.join(dataDir, "tmp");
  const structuresByPath = new Map();
  const values = batches.batches || [];
  let completed = 0;
  const concurrency = Number(process.env.VISIONOWL_STRUCTURE_CONCURRENCY || 5);
  await mapConcurrent(values, concurrency, async (batch) => {
    const inputPath = path.join(tmpDir, `direct-structure-${batch.batchIndex}.json`);
    const outputPath = path.join(tmpDir, `direct-structure-${batch.batchIndex}-output.json`);
    writeJson(inputPath, {
      projectRoot: repoPath,
      batchFiles: batch.files || [],
      batchImportData: batch.batchImportData || {},
    });
    await runProcessImpl({
      command: process.execPath,
      args: [path.join(skillDir, "extract-structure.mjs"), inputPath, outputPath],
      cwd: repoPath,
      timeoutMs: Number(
        process.env.VISIONOWL_STRUCTURE_TIMEOUT_MS || 5 * 60 * 1000,
      ),
      label: `Understand Anything structure batch ${batch.batchIndex}`,
    });
    const output = readJson(outputPath);
    for (const result of output.results || []) {
      structuresByPath.set(result.path, result);
    }
    completed += 1;
    onProgress(completed, values.length);
  });
  return structuresByPath;
}

async function runDirectUnderstandAnything({
  repoPath,
  skillPath,
  dataDir,
  repositoryUnchanged,
  onProgress = () => {},
  onGraph = () => {},
  runProcessImpl = runProcess,
  semanticBatchesImpl = analyzeSemanticBatches,
  architectureImpl = analyzeArchitecture,
}) {
  const skillDir = path.dirname(skillPath);
  const intermediateDir = path.join(dataDir, "intermediate");
  const tmpDir = path.join(dataDir, "tmp");
  const graphPath = path.join(dataDir, "knowledge-graph.json");
  const metaPath = path.join(dataDir, "meta.json");
  const existingGraph = fs.existsSync(graphPath) ? readJson(graphPath) : null;
  const existingMeta = fs.existsSync(metaPath) ? readJson(metaPath) : null;
  const analyzedAt = new Date().toISOString();
  const pipelineStartedAt = Date.now();
  const performanceMs = {};

  onProgress(
    "ua_preflight",
    4,
    "Direct Understand Engine 正在检查缓存和原始 Understand Anything 脚本",
  );
  if (
    existingMeta?.directEngineVersion === DIRECT_ENGINE_VERSION &&
    validGraph(existingGraph) &&
    repositoryUnchanged(repoPath, dataDir)
  ) {
    onProgress("ua_save", 97, "代码没有变化，已复用现有 Understand Anything 图谱");
    return {
      knowledgeGraph: existingGraph,
      graphPath,
      skillPath,
      reused: true,
      engine: "direct",
    };
  }

  fs.mkdirSync(intermediateDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  clearBatchArtifacts(intermediateDir);

  const staticStartedAt = Date.now();
  const rawScanPath = path.join(tmpDir, "direct-scan.json");
  onProgress("ua_scan", 8, "正在直接运行 Understand Anything 项目扫描器");
  await runProcessImpl({
    command: process.execPath,
    args: [
      path.join(skillDir, "scan-project.mjs"),
      repoPath,
      rawScanPath,
      "--exclude-analysis-data",
      ...scanExcludeArgs(repoPath),
    ],
    cwd: repoPath,
    timeoutMs: Number(process.env.VISIONOWL_SCAN_TIMEOUT_MS || 5 * 60 * 1000),
    label: "Understand Anything project scan",
  });
  const rawScan = readJson(rawScanPath);
  if (!Array.isArray(rawScan.files) || rawScan.files.length === 0) {
    throw new Error(
      "Understand Anything did not find any analyzable files in this repository.",
    );
  }
  if (
    validGraph(existingGraph) &&
    existingMeta?.contentDigest &&
    existingMeta.contentDigest === rawScan.contentDigest &&
    existingMeta.directEngineVersion === DIRECT_ENGINE_VERSION
  ) {
    onProgress("ua_save", 97, "仓库内容指纹没有变化，已复用现有图谱");
    return {
      knowledgeGraph: existingGraph,
      graphPath,
      skillPath,
      reused: true,
      engine: "direct",
    };
  }

  const importInputPath = path.join(tmpDir, "direct-import-input.json");
  const importOutputPath = path.join(tmpDir, "direct-import-output.json");
  writeJson(importInputPath, {
    projectRoot: repoPath,
    files: rawScan.files,
  });
  onProgress(
    "ua_scan",
    15,
    `已识别 ${rawScan.totalFiles} 个文件，正在提取项目内部 Import Map`,
  );
  await runProcessImpl({
    command: process.execPath,
    args: [
      path.join(skillDir, "extract-import-map.mjs"),
      importInputPath,
      importOutputPath,
    ],
    cwd: repoPath,
    timeoutMs: Number(process.env.VISIONOWL_IMPORT_TIMEOUT_MS || 10 * 60 * 1000),
    label: "Understand Anything import map",
  });
  const importOutput = readJson(importOutputPath);
  const project = projectMetadata(repoPath, rawScan, analyzedAt);
  const scan = {
    ...rawScan,
    name: project.name,
    description: project.description,
    languages: project.languages,
    frameworks: project.frameworks,
    importMap: importOutput.importMap || {},
  };
  const scanPath = path.join(intermediateDir, "scan-result.json");
  const batchesPath = path.join(intermediateDir, "batches.json");
  writeJson(scanPath, scan);
  onProgress(
    "ua_scan",
    22,
    `项目事实扫描完成：${scan.totalFiles} 个文件，${importOutput.stats?.totalEdges || 0} 条 Import`,
  );

  await runProcessImpl({
    command: process.execPath,
    args: [
      path.join(skillDir, "compute-batches.mjs"),
      repoPath,
      `--scan-result=${scanPath}`,
      `--output=${batchesPath}`,
    ],
    cwd: repoPath,
    timeoutMs: Number(process.env.VISIONOWL_BATCH_TIMEOUT_MS || 10 * 60 * 1000),
    label: "Understand Anything Louvain batches",
  });
  const batches = readJson(batchesPath);
  const facts = buildStaticGraph({ scan });
  const factsGroups = buildArchitectureGroups({
    scan,
    batches,
    graph: facts,
    repoPath,
  });
  const factsLayers = buildLayers(factsGroups, null);
  const factsTour = buildTour(factsLayers, null);
  const factsKnowledgeGraph = ensureGraphIntegrity(
    knowledgeGraph(project, facts, factsLayers, factsTour),
  );
  onGraph(factsKnowledgeGraph, {
    phase: "facts_ready",
    progress: 30,
    message: `基础事实图谱已就绪：${facts.nodes.length} 个节点，${facts.edges.length} 条关系`,
  });
  performanceMs.staticPipeline = Date.now() - staticStartedAt;
  onProgress(
    "ua_analyze",
    31,
    `基础事实图谱已就绪，正在提取 ${batches.totalBatches || 0} 个结构批次`,
  );

  const structureStartedAt = Date.now();
  const structuresByPath = await extractStructures({
    repoPath,
    skillDir,
    dataDir,
    batches,
    runProcessImpl,
    onProgress: (completed, total) => {
      const progress = 34 + Math.floor((completed / Math.max(1, total)) * 16);
      onProgress(
        "ua_analyze",
        progress,
        `结构提取完成 ${completed} / ${total} 批`,
      );
    },
  });
  performanceMs.structureExtraction = Date.now() - structureStartedAt;
  const structural = buildStaticGraph({ scan, structuresByPath });
  const structuralGroups = buildArchitectureGroups({
    scan,
    batches,
    graph: structural,
    repoPath,
  });
  const structuralLayers = buildLayers(structuralGroups, null);
  const structuralTour = buildTour(structuralLayers, null);
  onGraph(
    ensureGraphIntegrity(
      knowledgeGraph(project, structural, structuralLayers, structuralTour),
    ),
    {
      phase: "enriching",
      progress: 52,
      message: `函数和类结构已加入图谱，正在并行补充代码语义`,
    },
  );

  const semanticStartedAt = Date.now();
  const semantic = await semanticBatchesImpl({
    repoPath,
    dataDir,
    batches,
    graph: structural,
    structuresByPath,
    skillPath,
    onProgress: (completed, total, message) => {
      const progress = 52 + Math.floor((completed / Math.max(1, total)) * 16);
      onProgress("enriching", progress, message);
    },
  });
  performanceMs.semanticEnrichment = Date.now() - semanticStartedAt;
  const enriched = applySemanticEnrichment(structural, semantic.results || []);
  for (const batch of batches.batches || []) {
    writeJson(
      path.join(intermediateDir, `batch-${batch.batchIndex}.json`),
      batchGraph(enriched, batch),
    );
  }

  onProgress(
    "ua_review",
    70,
    `正在使用 Understand Anything 合并器规范化 ${enriched.nodes.length} 个节点`,
  );
  const mergeStartedAt = Date.now();
  await runProcessImpl({
    command: python310Binary(),
    args: [path.join(skillDir, "merge-batch-graphs.py"), repoPath],
    cwd: repoPath,
    timeoutMs: Number(process.env.VISIONOWL_MERGE_TIMEOUT_MS || 5 * 60 * 1000),
    label: "Understand Anything graph merge",
  });
  const assembled = readJson(path.join(intermediateDir, "assembled-graph.json"));
  performanceMs.graphMerge = Date.now() - mergeStartedAt;

  onProgress(
    "ua_architecture",
    76,
    "正在计算架构分组、依赖方向和 Fan-in/Fan-out",
  );
  const architectureStartedAt = Date.now();
  const groups = buildArchitectureGroups({
    scan,
    batches,
    graph: assembled,
    repoPath,
  });
  let semanticArchitecture = null;
  try {
    semanticArchitecture = await architectureImpl({
      repoPath,
      dataDir,
      groups,
      skillPath,
    });
  } catch (error) {
    const warning = `架构语义命名失败，保留确定性分组：${error.message}`;
    semantic.warnings.push(warning);
    onProgress("ua_architecture", 84, warning);
  }
  const layers = buildLayers(groups, semanticArchitecture);
  const tour = buildTour(layers, semanticArchitecture);
  performanceMs.architecture = Date.now() - architectureStartedAt;
  writeJson(path.join(intermediateDir, "layers.json"), { layers });
  writeJson(path.join(intermediateDir, "tour.json"), { tour });

  const finalGraph = ensureGraphIntegrity(
    knowledgeGraph(project, assembled, layers, tour),
  );
  const quality = graphQuality(finalGraph, scan);
  onGraph(finalGraph, {
    phase: "architecture_ready",
    progress: 88,
    message: `架构分层完成：${layers.length} 个模块`,
  });
  onProgress(
    "ua_tour",
    90,
    `已按依赖方向生成 ${tour.length} 个代码阅读步骤`,
  );
  onProgress(
    "ua_validate",
    93,
    `正在校验 ${finalGraph.nodes.length} 个节点、${finalGraph.edges.length} 条关系`,
  );
  writeJson(graphPath, finalGraph);

  const commit = project.gitCommitHash;
  const fingerprintInput = path.join(tmpDir, "direct-fingerprint-input.json");
  writeJson(fingerprintInput, {
    projectRoot: repoPath,
    sourceFilePaths: scan.files.map((file) => file.path),
    gitCommitHash: commit,
  });
  const fingerprintStartedAt = Date.now();
  try {
    await runProcessImpl({
      command: process.execPath,
      args: [path.join(skillDir, "build-fingerprints.mjs"), fingerprintInput],
      cwd: repoPath,
      timeoutMs: Number(
        process.env.VISIONOWL_FINGERPRINT_TIMEOUT_MS || 10 * 60 * 1000,
      ),
      label: "Understand Anything fingerprints",
    });
  } catch (error) {
    onProgress(
      "ua_save",
      97,
      `图谱已保存，但增量指纹生成失败：${error.message}`,
    );
  }
  performanceMs.fingerprints = Date.now() - fingerprintStartedAt;
  performanceMs.total = Date.now() - pipelineStartedAt;
  writeJson(metaPath, {
    lastAnalyzedAt: analyzedAt,
    gitCommitHash: commit,
    version: "1.0.0",
    analyzedFiles: scan.files.length,
    contentDigest: scan.contentDigest,
    directEngineVersion: DIRECT_ENGINE_VERSION,
    semanticWarnings: semantic.warnings || [],
    performanceMs,
    quality,
  });
  onProgress(
    "ua_save",
    98,
    `Direct Understand Engine 已保存图谱，语义缓存命中 ${semantic.cacheHits || 0} 批`,
  );
  return {
    knowledgeGraph: finalGraph,
    graphPath,
    skillPath,
    reused: false,
    engine: "direct",
    warnings: semantic.warnings || [],
    performanceMs,
    quality,
  };
}

module.exports = {
  DIRECT_ENGINE_VERSION,
  ensureGraphIntegrity,
  graphQuality,
  python310Binary,
  projectMetadata,
  runDirectUnderstandAnything,
};
