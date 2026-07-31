"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("node:child_process");
const { runCodex } = require("./codex-agent");
const {
  runDirectUnderstandAnything,
} = require("./direct-understand-engine");

const DEFAULT_MAX_RUNTIME_MS = 8 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const PHASE_RANK = {
  ua_preflight: 0,
  ua_scan: 1,
  ua_analyze: 2,
  ua_review: 3,
  ua_architecture: 4,
  ua_tour: 5,
  ua_validate: 6,
  ua_save: 7,
};

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

function findUnderstandSkillPath() {
  const skillPath = firstExisting([
    process.env.VISIONOWL_UNDERSTAND_SKILL_PATH,
    path.resolve(
      __dirname,
      "../../../../../Understand-Anything/understand-anything-plugin/skills/understand/SKILL.md",
    ),
    path.join(os.homedir(), ".agents", "skills", "understand", "SKILL.md"),
    path.join(os.homedir(), ".codex", "skills", "understand", "SKILL.md"),
  ]);
  if (!skillPath) {
    throw new Error(
      "Understand-Anything skill is not installed. Set VISIONOWL_UNDERSTAND_SKILL_PATH to its SKILL.md.",
    );
  }
  return fs.realpathSync(skillPath);
}

function understandDataDir(repoPath) {
  const legacy = path.join(repoPath, ".understand-anything");
  return fs.existsSync(legacy) ? legacy : path.join(repoPath, ".ua");
}

function freshFile(filePath, startedAt) {
  try {
    return fs.statSync(filePath).mtimeMs >= startedAt - 1000;
  } catch (_error) {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function isKnowledgeGraph(value) {
  return Boolean(
    value && Array.isArray(value.nodes) && Array.isArray(value.edges),
  );
}

function repositoryUnchanged(repoPath, dataDir) {
  const meta = readJson(path.join(dataDir, "meta.json"));
  if (!meta?.gitCommitHash) return false;
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commit || commit !== meta.gitCommitHash) return false;

    const status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return status
      .split("\n")
      .filter(Boolean)
      .every((line) => {
        const changedPath = line.slice(3).replace(/^"|"$/g, "");
        return (
          changedPath === ".ua" ||
          changedPath.startsWith(".ua/") ||
          changedPath === ".understand-anything" ||
          changedPath.startsWith(".understand-anything/")
        );
      });
  } catch (_error) {
    return false;
  }
}

function batchProgress(dataDir, startedAt) {
  const intermediate = path.join(dataDir, "intermediate");
  const batches = readJson(path.join(intermediate, "batches.json"));
  const total = Math.max(0, batches?.batches?.length || 0);
  if (!fs.existsSync(intermediate)) return { completed: 0, total };

  const completedIndices = new Set();
  for (const file of fs.readdirSync(intermediate)) {
    const match = file.match(/^batch-(\d+)(?:-part-\d+)?\.json$/);
    if (!match || !freshFile(path.join(intermediate, file), startedAt)) continue;
    completedIndices.add(Number(match[1]));
  }
  return {
    completed: total > 0 ? Math.min(total, completedIndices.size) : completedIndices.size,
    total,
  };
}

function artifactActivitySignature(dataDir) {
  const markers = [];
  for (const directory of [
    dataDir,
    path.join(dataDir, "tmp"),
    path.join(dataDir, "intermediate"),
  ]) {
    try {
      const stat = fs.statSync(directory);
      markers.push(`${directory}:${stat.mtimeMs}:${fs.readdirSync(directory).length}`);
    } catch (_error) {
      markers.push(`${directory}:missing`);
    }
  }
  for (const file of ["knowledge-graph.json", "meta.json", "fingerprints.json"]) {
    const filePath = path.join(dataDir, file);
    try {
      const stat = fs.statSync(filePath);
      markers.push(`${file}:${stat.mtimeMs}:${stat.size}`);
    } catch (_error) {
      markers.push(`${file}:missing`);
    }
  }
  return markers.join("|");
}

function artifactProgress(dataDir, startedAt) {
  const intermediate = path.join(dataDir, "intermediate");
  const finalGraph = path.join(dataDir, "knowledge-graph.json");
  const artifacts = {
    scan: path.join(intermediate, "scan-result.json"),
    batches: path.join(intermediate, "batches.json"),
    assembled: path.join(intermediate, "assembled-graph.json"),
    assembleReview: path.join(intermediate, "assemble-review.json"),
    layers: path.join(intermediate, "layers.json"),
    tour: path.join(intermediate, "tour.json"),
    review: path.join(intermediate, "review.json"),
    finalGraph,
  };

  if (freshFile(artifacts.finalGraph, startedAt)) {
    return {
      phase: "ua_save",
      progress: 97,
      message: "[Phase 7/7] Understand-Anything 已生成最终知识图谱",
    };
  }
  if (freshFile(artifacts.review, startedAt)) {
    return {
      phase: "ua_validate",
      progress: 91,
      message: "[Phase 6/7] 正在校验节点、关系与架构完整性",
    };
  }
  if (freshFile(artifacts.tour, startedAt)) {
    return {
      phase: "ua_tour",
      progress: 83,
      message: "[Phase 5/7] 项目学习路径已经生成",
    };
  }
  if (freshFile(artifacts.layers, startedAt)) {
    return {
      phase: "ua_architecture",
      progress: 74,
      message: "[Phase 4/7] 架构层识别完成",
    };
  }
  if (
    freshFile(artifacts.assembleReview, startedAt) ||
    freshFile(artifacts.assembled, startedAt)
  ) {
    return {
      phase: "ua_review",
      progress: 64,
      message: "[Phase 3/7] 正在审查合并后的知识图谱",
    };
  }

  if (fs.existsSync(intermediate)) {
    const { completed, total } = batchProgress(dataDir, startedAt);
    if (completed > 0) {
      const safeTotal = Math.max(1, total || completed);
      const scaleHint =
        safeTotal >= 40 ? `，大型代码库共 ${safeTotal} 批，仍在持续运行` : "";
      return {
        phase: "ua_analyze",
        progress: 34 + Math.floor((completed / safeTotal) * 24),
        message: `[Phase 2/7] 已完成 ${completed} / ${safeTotal} 个语义分析批次${scaleHint}`,
      };
    }
  }

  if (freshFile(artifacts.batches, startedAt)) {
    const batches = readJson(artifacts.batches);
    const total = batches?.batches?.length || 0;
    return {
      phase: "ua_analyze",
      progress: 33,
      message: `[Phase 2/7] 已生成 ${total} 个语义分析批次`,
    };
  }
  if (freshFile(artifacts.scan, startedAt)) {
    const scan = readJson(artifacts.scan);
    const count = scan?.files?.length || scan?.fileList?.length || 0;
    return {
      phase: "ua_scan",
      progress: 22,
      message: `[Phase 1/7] 项目扫描完成，共识别 ${count} 个文件`,
    };
  }
  return null;
}

function outputProgress(output) {
  const phaseMatches = [...output.matchAll(/\[Phase\s+([1-7])\/7\]\s*([^"\n\\]*)/gi)];
  const latest = phaseMatches.at(-1);
  if (!latest) return null;

  const phaseNumber = Number(latest[1]);
  const values = {
    1: ["ua_scan", 8, "正在扫描项目文件与语言结构"],
    2: ["ua_analyze", 26, "正在逐批分析文件语义与代码关系"],
    3: ["ua_review", 60, "正在审查合并后的知识图谱"],
    4: ["ua_architecture", 69, "正在识别系统架构层与模块边界"],
    5: ["ua_tour", 79, "正在构建项目理解导览"],
    6: ["ua_validate", 88, "正在校验知识图谱完整性"],
    7: ["ua_save", 95, "正在保存 Understand-Anything 最终产物"],
  };
  const [phase, baseProgress, fallback] = values[phaseNumber];

  if (phaseNumber === 2) {
    const batches = [...output.matchAll(/Analyzing batch\s+(\d+)\/(\d+)/gi)].at(-1);
    if (batches) {
      const current = Number(batches[1]);
      const total = Math.max(1, Number(batches[2]));
      const completedBeforeCurrent = Math.max(0, Math.min(current - 1, total));
      return {
        phase,
        progress: 34 + Math.floor((completedBeforeCurrent / total) * 24),
        message: `正在处理第 ${current} / ${total} 个文件批次`,
      };
    }
  }

  const detail = latest[2]?.trim().replace(/[`"\\]+$/g, "");
  return {
    phase,
    progress: baseProgress,
    message: detail ? `[Phase ${phaseNumber}/7] ${detail}` : fallback,
  };
}

function outputPhaseReady(value, dataDir, startedAt) {
  if (!value) return false;
  const intermediate = path.join(dataDir, "intermediate");
  const ready = {
    ua_scan: true,
    ua_analyze: freshFile(
      path.join(intermediate, "scan-result.json"),
      startedAt,
    ),
    ua_review: (() => {
      const { completed, total } = batchProgress(dataDir, startedAt);
      return total > 0 && completed >= total;
    })(),
    ua_architecture: freshFile(
      path.join(intermediate, "assemble-review.json"),
      startedAt,
    ),
    ua_tour: freshFile(path.join(intermediate, "layers.json"), startedAt),
    ua_validate: freshFile(path.join(intermediate, "tour.json"), startedAt),
    ua_save: freshFile(path.join(intermediate, "review.json"), startedAt),
  };
  return Boolean(ready[value.phase]);
}

function buildUnderstandPrompt(skillPath, repoPath, forceFull) {
  const modeArguments = forceFull
    ? `${repoPath} --full --language zh --no-auto-update --exclude ".ua/**,.understand-anything/**"`
    : `${repoPath} --language zh --no-auto-update --exclude ".ua/**,.understand-anything/**"`;
  return [
    "Invoke and follow the installed `understand-anything:understand` skill.",
    "You must use the original Understand-Anything `understand` skill.",
    `Read the complete skill instructions at: ${skillPath}`,
    "Do not substitute a custom scanner, simplified prompt, or another skill.",
    `Treat the arguments as: ${modeArguments}`,
    forceFull
      ? "No valid existing graph was found, so execute the original skill's full-analysis path."
      : "A graph already exists. Follow the original skill's incremental decision path; if the graph is already current and the repository is unchanged, choose option (c), keep the existing graph, and finish without a forced rebuild.",
    "This is a non-interactive VisionOwl run.",
    "The operator has approved generating or reusing the default .understandignore and continuing without a confirmation pause.",
    "Set UNDERSTAND_NO_WORKTREE_REDIRECT=1 so the artifact remains in the repository selected by VisionOwl.",
    "Execute every required phase and write the final artifact to the repository's .ua/knowledge-graph.json (or the legacy .understand-anything directory when required by the skill).",
    "Do not modify repository files outside the Understand-Anything data directory.",
    "Report the phase transitions required by the skill.",
  ].join("\n");
}

function finalArtifactsReady(dataDir, startedAt) {
  return ["knowledge-graph.json", "meta.json", "fingerprints.json"].every(
    (file) => freshFile(path.join(dataDir, file), startedAt),
  );
}

async function runLegacyUnderstandAnything({ repoPath, onProgress = () => {} }) {
  const skillPath = findUnderstandSkillPath();
  const dataDir = understandDataDir(repoPath);
  const graphPath = path.join(dataDir, "knowledge-graph.json");
  const hadExistingGraph = fs.existsSync(graphPath);
  const pluginRoot = path.resolve(path.dirname(skillPath), "../..");
  const startedAt = Date.now();
  let lastSignature = "";
  let lastRank = 0;
  let lastProgress = 0;
  let outputBuffer = "";

  const publish = (value) => {
    if (!value) return;
    const rank = PHASE_RANK[value.phase] ?? lastRank;
    if (rank < lastRank || (rank === lastRank && value.progress < lastProgress)) {
      return;
    }
    const signature = `${value.phase}|${value.progress}|${value.message}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    lastRank = rank;
    lastProgress = value.progress;
    onProgress(value.phase, value.progress, value.message);
  };

  publish({
    phase: "ua_preflight",
    progress: 4,
    message: "正在启动 Understand-Anything Skill 并检查分析环境",
  });

  const existingGraph = hadExistingGraph ? readJson(graphPath) : null;
  if (
    isKnowledgeGraph(existingGraph) &&
    repositoryUnchanged(repoPath, dataDir)
  ) {
    publish({
      phase: "ua_save",
      progress: 97,
      message: "代码没有变化，已复用现有 Understand-Anything 知识图谱",
    });
    return {
      knowledgeGraph: existingGraph,
      graphPath,
      skillPath,
      reused: true,
    };
  }

  const watcher = setInterval(() => {
    publish(artifactProgress(dataDir, startedAt));
  }, 1000);

  try {
    await runCodex({
      repoPath,
      prompt: buildUnderstandPrompt(skillPath, repoPath, !hadExistingGraph),
      sandbox: "workspace-write",
      env: {
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        UNDERSTAND_NO_WORKTREE_REDIRECT: "1",
      },
      onStdout: (chunk) => {
        outputBuffer = `${outputBuffer}${chunk}`.slice(-32000);
        const value = outputProgress(outputBuffer);
        if (!outputPhaseReady(value, dataDir, startedAt)) return;
        const artifactValue = artifactProgress(dataDir, startedAt);
        const artifactRank = PHASE_RANK[artifactValue?.phase] ?? -1;
        const outputRank = PHASE_RANK[value?.phase] ?? -1;
        if (
          artifactValue &&
          (artifactRank > outputRank ||
            (artifactRank === outputRank &&
              artifactValue.progress >= value.progress))
        ) {
          publish(artifactValue);
          return;
        }
        publish(value);
      },
      completionCheck: () => finalArtifactsReady(dataDir, startedAt),
      activityCheck: () => artifactActivitySignature(dataDir),
      idleTimeoutMs: Number(
        process.env.VISIONOWL_UNDERSTAND_IDLE_TIMEOUT_MS ||
          DEFAULT_IDLE_TIMEOUT_MS,
      ),
      timeoutMs: Number(
        process.env.VISIONOWL_UNDERSTAND_MAX_RUNTIME_MS ||
          process.env.VISIONOWL_UNDERSTAND_TIMEOUT_MS ||
          DEFAULT_MAX_RUNTIME_MS,
      ),
    });
  } finally {
    clearInterval(watcher);
  }

  publish(artifactProgress(dataDir, startedAt));
  if (!freshFile(graphPath, startedAt) && !hadExistingGraph) {
    throw new Error(
      `Understand-Anything did not produce a fresh knowledge graph at ${graphPath}.`,
    );
  }

  const knowledgeGraph = readJson(graphPath);
  if (!isKnowledgeGraph(knowledgeGraph)) {
    throw new Error("Understand-Anything produced an invalid knowledge-graph.json.");
  }
  return { knowledgeGraph, graphPath, skillPath, reused: false };
}

async function runUnderstandAnything({
  repoPath,
  onProgress = () => {},
  onGraph = () => {},
}) {
  const engine = String(
    process.env.VISIONOWL_ANALYSIS_ENGINE || "direct",
  ).toLowerCase();
  if (engine === "legacy") {
    return runLegacyUnderstandAnything({ repoPath, onProgress });
  }
  if (engine !== "direct") {
    throw new Error(
      `Unknown VISIONOWL_ANALYSIS_ENGINE "${engine}". Use "direct" or "legacy".`,
    );
  }
  const skillPath = findUnderstandSkillPath();
  return runDirectUnderstandAnything({
    repoPath,
    skillPath,
    dataDir: understandDataDir(repoPath),
    repositoryUnchanged,
    onProgress,
    onGraph,
  });
}

module.exports = {
  artifactActivitySignature,
  artifactProgress,
  batchProgress,
  finalArtifactsReady,
  findUnderstandSkillPath,
  outputProgress,
  outputPhaseReady,
  repositoryUnchanged,
  runLegacyUnderstandAnything,
  runUnderstandAnything,
  understandDataDir,
};
