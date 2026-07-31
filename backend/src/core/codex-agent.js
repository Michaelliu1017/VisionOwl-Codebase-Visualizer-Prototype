"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("node:child_process");

function codexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return fs.existsSync(bundled) ? bundled : "codex";
}

function collectThreadId(line, current) {
  try {
    const event = JSON.parse(line);
    return (
      event.thread_id ||
      event.threadId ||
      event.thread?.id ||
      event.session_id ||
      current
    );
  } catch (_error) {
    return current;
  }
}

function codexFailureDetail(stdout, stderr) {
  const structured = stdout
    .split("\n")
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .find((event) => event?.error || event?.message || event?.msg);
  const eventDetail =
    structured?.error?.message ||
    structured?.error ||
    structured?.message ||
    structured?.msg;
  return (
    (typeof eventDetail === "string" ? eventDetail : "") ||
    stderr.trim() ||
    stdout.trim().slice(-4000)
  );
}

function runCodex({
  repoPath,
  prompt,
  schemaPath,
  threadId,
  timeoutMs = 180000,
  idleTimeoutMs = 0,
  sandbox = "read-only",
  onStdout,
  env = {},
  completionCheck,
  activityCheck,
  completionGraceMs = 15000,
  reasoningEffort,
}) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(
      os.tmpdir(),
      `visionowl-codex-${process.pid}-${Date.now()}.txt`,
    );
    const reasoningArgs = reasoningEffort
      ? ["-c", `model_reasoning_effort="${reasoningEffort}"`]
      : [];
    const args = threadId
      ? [
          "exec",
          "resume",
          ...reasoningArgs,
          threadId,
          "--json",
          "--output-last-message",
          outputPath,
          "--skip-git-repo-check",
          ...(schemaPath ? ["--output-schema", schemaPath] : []),
          "-",
        ]
      : [
          "exec",
          ...reasoningArgs,
          "-C",
          repoPath,
          "--sandbox",
          sandbox,
          "--skip-git-repo-check",
          "--json",
          "--output-last-message",
          outputPath,
          ...(schemaPath ? ["--output-schema", schemaPath] : []),
          "-",
        ];
    const child = spawn(codexBinary(), args, {
      cwd: repoPath,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let resolvedThreadId = threadId;
    let completedByArtifact = false;
    let forceKillTimer;
    let settled = false;
    let activitySignature;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;

    const markActivity = () => {
      lastActivityAt = Date.now();
    };
    const stopChild = () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      stopChild();
      reject(error);
    };
    const timeoutPoll = setInterval(() => {
      if (settled || completedByArtifact) return;
      if (activityCheck) {
        try {
          const nextSignature = String(activityCheck() ?? "");
          if (nextSignature !== activitySignature) {
            activitySignature = nextSignature;
            markActivity();
          }
        } catch (_error) {
          // Activity probes are best-effort and must not interrupt Codex.
        }
      }

      const now = Date.now();
      if (timeoutMs > 0 && now - startedAt >= timeoutMs) {
        rejectOnce(
          new Error(
            `Codex exceeded the maximum runtime of ${Math.ceil(timeoutMs / 60000)} minutes.`,
          ),
        );
        return;
      }
      if (idleTimeoutMs > 0 && now - lastActivityAt >= idleTimeoutMs) {
        rejectOnce(
          new Error(
            `Codex produced no output or analysis artifacts for ${Math.ceil(idleTimeoutMs / 60000)} minutes.`,
          ),
        );
      }
    }, 1000);
    const completionPoll = completionCheck
      ? setInterval(() => {
          if (completedByArtifact) return;
          try {
            if (!completionCheck()) return;
          } catch (_error) {
            return;
          }
          completedByArtifact = true;
          clearInterval(timeoutPoll);
          setTimeout(() => {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            forceKillTimer = setTimeout(() => {
              if (child.exitCode === null) child.kill("SIGKILL");
            }, 5000);
          }, completionGraceMs);
        }, 1000)
      : null;

    const clearTimers = () => {
      clearInterval(timeoutPoll);
      if (completionPoll) clearInterval(completionPoll);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      markActivity();
      stdout += text;
      onStdout?.(text);
      for (const line of text.split("\n")) {
        resolvedThreadId = collectThreadId(line, resolvedThreadId);
      }
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") rejectOnce(error);
    });
    child.stdin.end(prompt);
    child.stderr.on("data", (chunk) => {
      markActivity();
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimers();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimers();
      if (settled) {
        fs.rmSync(outputPath, { force: true });
        return;
      }
      if (code !== 0 && !completedByArtifact) {
        settled = true;
        reject(
          new Error(
            codexFailureDetail(stdout, stderr) ||
              `Codex exited with status ${code}.`,
          ),
        );
        return;
      }
      try {
        const content = fs.existsSync(outputPath)
          ? fs.readFileSync(outputPath, "utf8").trim()
          : "";
        fs.rmSync(outputPath, { force: true });
        settled = true;
        resolve({ content, threadId: resolvedThreadId, stdout });
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
  });
}

function skillText() {
  const filePath = path.resolve(
    __dirname,
    "../../../../skills/repository-understanding/SKILL.md",
  );
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

async function enrichGraph(repoPath, graph) {
  if (String(process.env.VISIONOWL_CODEX_ENABLED || "true") === "false") {
    return { graph, usedCodex: false, reason: "disabled" };
  }
  const modules = graph.entities
    .filter((entity) => entity.kind === "module")
    .slice(0, 80)
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      path: entity.path,
      language: entity.language,
      files: entity.metadata.files?.slice(0, 12),
      currentSummary: entity.summary,
    }));
  if (modules.length === 0) return { graph, usedCodex: false, reason: "empty" };

  const schemaPath = path.resolve(
    __dirname,
    "../schemas/module-enrichment.schema.json",
  );
  const prompt = [
    "You are enriching a deterministic code graph for VisionOwl.",
    "Follow the repository-understanding skill below.",
    "Do not add, remove, or rename modules and do not invent relationships.",
    "Read source files only when needed. Return concise Chinese summaries and useful tags.",
    "",
    skillText(),
    "",
    "Modules:",
    JSON.stringify(modules),
  ].join("\n");

  const result = await runCodex({ repoPath, prompt, schemaPath });
  const parsed = JSON.parse(result.content);
  const enrichmentById = new Map(
    (parsed.modules || []).map((item) => [item.id, item]),
  );
  return {
    graph: {
      ...graph,
      source: "scanner+codex",
      entities: graph.entities.map((entity) => {
        const value = enrichmentById.get(entity.id);
        return value
          ? {
              ...entity,
              summary: value.summary || entity.summary,
              tags: [...new Set([...entity.tags, ...(value.tags || [])])].slice(0, 10),
            }
          : entity;
      }),
    },
    usedCodex: true,
    threadId: result.threadId,
  };
}

async function askAboutEntity({
  repoPath,
  project,
  context,
  question,
  threadId,
  onProgress,
  graphContext,
}) {
  if (String(process.env.VISIONOWL_CODEX_ENABLED || "true") === "false") {
    throw new Error("Codex integration is disabled in this runtime.");
  }

  const emitProgress = (() => {
    let previous = "";
    return (progress) => {
      const signature = JSON.stringify(progress);
      if (signature === previous) return;
      previous = signature;
      onProgress?.(progress);
    };
  })();

  const compactValue = (value, depth = 0) => {
    if (typeof value === "string") return value.slice(0, 600);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (depth >= 2) return undefined;
    if (Array.isArray(value)) {
      return value
        .slice(0, 12)
        .map((item) => compactValue(item, depth + 1))
        .filter((item) => item !== undefined);
    }
    if (typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 20)
          .map(([key, item]) => [key, compactValue(item, depth + 1)])
          .filter(([, item]) => item !== undefined),
      );
    }
    return undefined;
  };

  const neighboringRelations = [
    ...context.incoming,
    ...context.outgoing,
    ...(context.internal || []),
  ];
  const needsSourceExploration =
    /逐行|源码实现|具体代码|为什么|根因|风险|缺陷|bug|错误|性能|安全|完整分析|深入/.test(
      question.toLowerCase(),
    );
  const compactEntity = {
    id: context.entity.id,
    name: context.entity.name,
    kind: context.entity.kind,
    category: context.entity.category,
    summary: context.entity.summary,
    path: context.entity.path,
    language: context.entity.language,
    tags: context.entity.tags,
    metadata: compactValue(context.entity.metadata),
    evidence: context.entity.evidence,
  };
  emitProgress({
    phase: "context",
    label: `已装载 ${context.entity.name} 的模块上下文`,
    detail: `${neighboringRelations.length} 条直接关系`,
    current: 1,
    total: 4,
  });

  const evidence = [
    ...(context.entity.evidence || []),
    ...neighboringRelations.flatMap((relation) => relation.evidence || []),
  ]
    .filter((item) => item?.file)
    .filter(
      (item, index, values) =>
        values.findIndex(
          (candidate) =>
            candidate.file === item.file &&
            candidate.line === item.line &&
            candidate.symbol === item.symbol,
        ) === index,
    )
    .slice(0, 8);

  const sourceSnippets = evidence.flatMap((item) => {
    const root = path.resolve(repoPath);
    const absolute = path.resolve(root, item.file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return [];
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return [];
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    const line = Math.max(1, Number(item.line) || 1);
    const start = Math.max(1, line - 3);
    const end = Math.min(lines.length, line + 5);
    const excerpt = lines
      .slice(start - 1, end)
      .map((value, offset) => `${start + offset}: ${value}`)
      .join("\n")
      .slice(0, 2400);
    return [
      {
        file: item.file,
        line: item.line,
        symbol: item.symbol,
        excerpt,
      },
    ];
  });
  emitProgress({
    phase: "evidence",
    label: `已准备 ${sourceSnippets.length} 处源码证据`,
    detail:
      sourceSnippets.length > 0
        ? sourceSnippets.map((item) => item.symbol || item.file).slice(0, 3).join(" · ")
        : "需要时由 Codex 继续核对源码",
    current: 2,
    total: 4,
  });

  let stdoutBuffer = "";
  const handleCodexOutput = (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      const itemType = event?.item?.type || event?.type || "";
      if (
        itemType.includes("command_execution") ||
        itemType.includes("tool_call") ||
        itemType.includes("mcp")
      ) {
        emitProgress({
          phase: "analysis",
          label: "正在核对相关源码与调用关系",
          detail: context.entity.name,
          current: 3,
          total: 4,
        });
      } else if (
        itemType.includes("agent_message") ||
        itemType.includes("message")
      ) {
        emitProgress({
          phase: "format",
          label: "正在整理结构化答案",
          detail: "结论、职责、调用链与源码证据",
          current: 4,
          total: 4,
        });
      }
    }
  };

  emitProgress({
    phase: "analysis",
    label: "Codex 正在分析模块职责",
    detail: "优先使用现有图谱与源码证据",
    current: 3,
    total: 4,
  });
  const schemaPath = path.resolve(
    __dirname,
    "../schemas/chat-answer.schema.json",
  );
  const prompt = [
    `你正在回答项目 ${project.name} 中分析对象 ${context.entity.name} 的问题。`,
    "只读分析，不得修改代码。",
    "优先使用下面已经整理好的结构化事实和源码片段；只有证据不足时才继续读取仓库源码。",
    needsSourceExploration
      ? "这是源码深问，可以按需读取少量直接相关文件，但不要扫描整个仓库。"
      : "这是模块职责或调用关系问题；现有图谱证据足够，不得运行命令、调用工具或继续扫描仓库。",
    "最终严格按照 JSON Schema 返回，不要输出 Markdown。",
    "conclusion 用一句话直接回答问题；purpose 用一到两句话说明模块职责。",
    "callChain 只放符号或步骤名，按真实调用方向排列，最多 8 项。",
    "facts 只保留最关键的代码事实，最多 6 条；推断只放入 inferences。",
    "没有相关文档时不要专门说明“没有文档”；notes 只保留真正影响结论的限制。",
    "不要输出 Git 元数据、新鲜度或通用免责声明，除非它会实质影响答案。",
    "citations 必须来自实际读取到的源码；缺失值使用 null。",
    "",
    `模块：${JSON.stringify(compactEntity)}`,
    `关系：${JSON.stringify(neighboringRelations)}`,
    `图谱上下文：${JSON.stringify(graphContext || {})}`,
    `文档：${JSON.stringify(context.documents)}`,
    `批注：${JSON.stringify(context.annotations)}`,
    `源码片段：${JSON.stringify(sourceSnippets)}`,
    "",
    `用户问题：${question}`,
  ].join("\n");
  const result = await runCodex({
    repoPath,
    prompt,
    threadId,
    schemaPath,
    onStdout: handleCodexOutput,
    reasoningEffort: needsSourceExploration ? "medium" : "low",
    timeoutMs: needsSourceExploration ? 180000 : 60000,
  });
  emitProgress({
    phase: "format",
    label: "正在整理结构化答案",
    detail: "结论、职责、调用链与源码证据",
    current: 4,
    total: 4,
  });

  const parsed = JSON.parse(result.content);
  const citations = (parsed.citations || []).map((item) => ({
    file: String(item.file || ""),
    ...(Number.isInteger(item.line) ? { line: item.line } : {}),
    ...(Number.isInteger(item.endLine) ? { endLine: item.endLine } : {}),
    ...(typeof item.symbol === "string" && item.symbol
      ? { symbol: item.symbol }
      : {}),
    ...(typeof item.excerpt === "string" && item.excerpt
      ? { excerpt: item.excerpt }
      : {}),
  }));
  return {
    ...result,
    answer: {
      conclusion: String(parsed.conclusion || "").trim(),
      purpose: String(parsed.purpose || "").trim(),
      callChain: (parsed.callChain || []).map(String).filter(Boolean).slice(0, 8),
      facts: (parsed.facts || []).map(String).filter(Boolean).slice(0, 6),
      inferences: (parsed.inferences || []).map(String).filter(Boolean).slice(0, 3),
      notes: (parsed.notes || []).map(String).filter(Boolean).slice(0, 3),
      citations: citations.filter((item) => item.file),
    },
  };
}

module.exports = {
  askAboutEntity,
  codexBinary,
  enrichGraph,
  runCodex,
};
