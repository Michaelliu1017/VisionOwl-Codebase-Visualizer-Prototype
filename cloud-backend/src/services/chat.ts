/**
 * AI 对话（契约 §6 / spec §4.6）
 *
 * 先用图谱事实生成受约束草稿，再通过 Redis/Worker/Runner 让 qodercli 在当前
 * commit 的真实源码目录中回答；Qoder 不可用时自动降级，流协议与证据/高亮行为保持不变。
 */
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config";
import {
  appendChatTurn,
  chatTurnCount,
  enqueueChat,
  getChatAnswerCache,
  getChatTaskState,
  setChatAnswerCache,
  setChatTaskState,
  waitForRedis,
} from "../infra/redis";
import { notFound } from "../lib/errors";
import type { Evidence, GraphDocument, GraphEdge, GraphNode } from "../types";
import { listDocuments } from "./documents";
import { getCurrentGraphDocument } from "./graph";
import { listJobs } from "./jobs";

export const MAX_TURNS_PER_SESSION = 15;

export interface ChatAnswer {
  sessionId: string;
  /** 供 SSE 逐段下发 */
  chunks: string[];
  evidence: Evidence[];
  action: { type: "highlight"; nodeIds: string[]; edgeIds: string[] } | null;
  inferred: boolean;
  credits: number;
  provider: "qoder" | "rules";
}

export interface ChatStatus {
  stage: "queued" | "preparing_source" | "cache_hit" | "reading_source" | "finalizing" | "fallback";
  note: string;
}

export type ChatStatusFn = (status: ChatStatus) => void | Promise<void>;

type Intent =
  | "responsibility"
  | "callers"
  | "callees"
  | "dataflow"
  | "impact"
  | "docs"
  | "recent"
  | "overview";

export function detectIntent(question: string): Intent {
  const q = question.toLowerCase();
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  if (has("影响", "impact", "波及", "改了会", "修改这个", "牵连")) return "impact";
  if (has("被谁调用", "谁调用", "被哪些", "调用方", "上游", "callers")) return "callers";
  if (has("调用了", "依赖哪些", "下游", "callees", "用到了")) return "callees";
  if (has("数据", "流转", "dataflow", "读写", "存到", "落库")) return "dataflow";
  if (has("文档", "过期", "stale", "说明")) return "docs";
  if (has("最近", "最新", "更新", "改了什么", "recent", "commit")) return "recent";
  if (has("功能", "职责", "作用", "是什么", "干什么", "做什么")) return "responsibility";
  return "overview";
}

interface Adjacency {
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
  byId: Map<string, GraphNode>;
}

export function buildAdjacency(graph: GraphDocument): Adjacency {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  for (const e of graph.edges) {
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
  }
  return { outgoing, incoming, byId };
}

const label = (adj: Adjacency, id: string): string => adj.byId.get(id)?.name ?? id;

/** 反向可达闭包（影响面分析），最多 depth 层 */
function reverseClosure(adj: Adjacency, start: string, depth: number): { nodeIds: string[]; edgeIds: string[] } {
  const seen = new Set<string>([start]);
  const edges = new Set<string>();
  let frontier = [start];
  for (let d = 0; d < depth; d += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of adj.incoming.get(id) ?? []) {
        edges.add(e.id);
        if (!seen.has(e.source)) {
          seen.add(e.source);
          next.push(e.source);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  seen.delete(start);
  return { nodeIds: [...seen], edgeIds: [...edges] };
}

export async function answerQuestion(input: {
  projectId: string;
  question: string;
  nodeId?: string | null;
  sessionId?: string | null;
  onStatus?: ChatStatusFn;
}): Promise<ChatAnswer> {
  const sessionId = input.sessionId ?? randomUUID();
  const graph = await getCurrentGraphDocument(input.projectId);
  if (!graph) throw notFound("该项目尚无图谱版本，无法回答；请先完成一次分析");

  const adj = buildAdjacency(graph);
  const intent = detectIntent(input.question);
  const node = input.nodeId ? adj.byId.get(input.nodeId) : undefined;

  const lines: string[] = [];
  const evidence: Evidence[] = [];
  const highlightNodes = new Set<string>();
  const highlightEdges = new Set<string>();
  let inferred = false;

  if (node) {
    highlightNodes.add(node.id);
    for (const ev of node.evidence ?? []) evidence.push(ev);
    if (node.inferred) inferred = true;
  }

  const pushEdgeList = (edges: GraphEdge[], direction: "in" | "out") => {
    for (const e of edges) {
      highlightEdges.add(e.id);
      const other = direction === "in" ? e.source : e.target;
      highlightNodes.add(other);
      const mark = e.inferred ? "（推断）" : "";
      if (e.inferred) inferred = true;
      lines.push(
        direction === "in"
          ? `- ${label(adj, e.source)} --[${e.type}]--> 本模块${mark}`
          : `- 本模块 --[${e.type}]--> ${label(adj, e.target)}${mark}`,
      );
      for (const ev of e.evidence ?? []) evidence.push(ev);
    }
  };

  switch (intent) {
    case "responsibility": {
      if (!node) {
        lines.push(`当前项目图谱共 ${graph.nodes.length} 个节点、${graph.edges.length} 条关系。`);
        lines.push("请在画布上选中一个模块再提问，我会给出该模块的职责与证据。");
        break;
      }
      const outs = adj.outgoing.get(node.id) ?? [];
      const ins = adj.incoming.get(node.id) ?? [];
      lines.push(`## ${node.name}：职责与边界`);
      lines.push("");
      lines.push("### 已知职责");
      lines.push("");
      lines.push(node.summary ? node.summary : "该节点暂无职责摘要（等待语义增强阶段补充）。");
      lines.push("");
      lines.push("### 图谱中的结构边界");
      lines.push("");
      lines.push(`- **类型**：${node.kind}`);
      lines.push(`- **源码路径**：${node.path ? `\`${node.path}\`` : "未记录"}`);
      lines.push(`- **直接依赖**：${outs.length > 0 ? outs.map((edge) => label(adj, edge.target)).join("、") : "无"}`);
      lines.push(`- **上游调用方**：${ins.length > 0 ? ins.map((edge) => label(adj, edge.source)).join("、") : "无"}`);
      break;
    }
    case "callers": {
      if (!node) {
        lines.push("请先选中一个节点，我才能回答「谁调用它」。");
        break;
      }
      const ins = adj.incoming.get(node.id) ?? [];
      lines.push(`**${node.name}** 的上游共 ${ins.length} 个：`);
      if (ins.length === 0) lines.push("- 无（当前图谱中没有指向它的关系）");
      pushEdgeList(ins, "in");
      break;
    }
    case "callees": {
      if (!node) {
        lines.push("请先选中一个节点，我才能回答「它调用了谁」。");
        break;
      }
      const outs = adj.outgoing.get(node.id) ?? [];
      lines.push(`**${node.name}** 的下游共 ${outs.length} 个：`);
      if (outs.length === 0) lines.push("- 无（当前图谱中它没有出边）");
      pushEdgeList(outs, "out");
      break;
    }
    case "dataflow": {
      const dataEdges = graph.edges.filter((e) =>
        ["read", "write", "publish", "consume"].includes(e.type),
      );
      const scoped = node
        ? dataEdges.filter((e) => e.source === node.id || e.target === node.id)
        : dataEdges;
      lines.push(
        node
          ? `与 **${node.name}** 相关的数据流关系 ${scoped.length} 条：`
          : `项目内数据流关系共 ${scoped.length} 条（read/write/publish/consume）：`,
      );
      for (const e of scoped.slice(0, 30)) {
        highlightEdges.add(e.id);
        highlightNodes.add(e.source);
        highlightNodes.add(e.target);
        if (e.inferred) inferred = true;
        lines.push(
          `- ${label(adj, e.source)} --[${e.type}]--> ${label(adj, e.target)}${e.inferred ? "（推断）" : ""}`,
        );
        for (const ev of e.evidence ?? []) evidence.push(ev);
      }
      break;
    }
    case "impact": {
      if (!node) {
        lines.push("影响面分析需要先选中一个节点。");
        break;
      }
      const closure = reverseClosure(adj, node.id, 2);
      lines.push(`修改 **${node.name}** 可能影响以下 ${closure.nodeIds.length} 个组件（2 层反向闭包）：`);
      for (const id of closure.nodeIds) {
        highlightNodes.add(id);
        lines.push(`- ${label(adj, id)}${adj.byId.get(id)?.path ? ` · ${adj.byId.get(id)!.path}` : ""}`);
      }
      for (const id of closure.edgeIds) highlightEdges.add(id);
      const docs = await listDocuments(input.projectId, {});
      const related = docs.filter((d) => d.nodeId && closure.nodeIds.concat(node.id).includes(d.nodeId));
      if (related.length > 0) {
        lines.push("", "关联文档（可能需要同步更新）：");
        for (const d of related) {
          lines.push(`- ${d.title}${d.status === "maybe_stale" ? " ⚠ 可能过期" : ""} — ${d.url}`);
        }
      }
      break;
    }
    case "docs": {
      const docs = await listDocuments(input.projectId, node ? { nodeId: node.id } : {});
      const stale = docs.filter((d) => d.status === "maybe_stale");
      lines.push(`共 ${docs.length} 篇文档，其中 ${stale.length} 篇标记为「可能过期」。`);
      for (const d of docs) {
        lines.push(`- [${d.scope}] ${d.title}${d.status === "maybe_stale" ? " ⚠ 可能过期" : ""} — ${d.url}`);
        if (d.nodeId) highlightNodes.add(d.nodeId);
      }
      break;
    }
    case "recent": {
      const jobs = await listJobs(input.projectId, 3, null);
      lines.push(`当前图谱绑定 commit \`${graph.commitSha}\`，生成于 ${graph.generatedAt}。`);
      if (jobs.items.length === 0) lines.push("尚无分析任务记录。");
      for (const j of jobs.items) {
        lines.push(
          `- ${j.type} 任务 ${j.status}${j.targetCommitSha ? ` @ ${j.targetCommitSha.slice(0, 7)}` : ""}` +
            `${j.credits !== null ? ` · ${j.credits} credits` : ""}`,
        );
      }
      break;
    }
    case "overview":
    default: {
      const byKind = new Map<string, number>();
      for (const n of graph.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
      lines.push(
        `图谱 commit \`${graph.commitSha}\`：${graph.nodes.length} 节点 / ${graph.edges.length} 关系。`,
      );
      lines.push(
        "节点构成：" + [...byKind.entries()].map(([k, c]) => `${k} ${c}`).join("、"),
      );
      if (node) {
        lines.push("", `当前选中：**${node.name}**${node.summary ? ` —— ${node.summary}` : ""}`);
      } else {
        lines.push("", "选中画布上的节点后再提问，可获得职责、调用关系、影响面等具体回答。");
      }
      break;
    }
  }

  const draft: ChatAnswer = {
    sessionId,
    chunks: chunkText(lines.join("\n")),
    evidence: dedupeEvidence(evidence).slice(0, 12),
    action:
      highlightNodes.size > 0 || highlightEdges.size > 0
        ? { type: "highlight", nodeIds: [...highlightNodes], edgeIds: [...highlightEdges] }
        : null,
    inferred,
    credits: 0,
    provider: "rules",
  };
  const answer = await enhanceWithQoder({
    projectId: input.projectId,
    commitSha: graph.commitSha,
    repositoryCommits: graph.repositoryCommits ?? {},
    question: input.question,
    node: node ?? null,
    draft,
    onStatus: input.onStatus,
  });

  await appendChatTurn(input.projectId, sessionId, {
    at: new Date().toISOString(),
    question: input.question,
    nodeId: input.nodeId ?? null,
    intent,
    answer: answer.chunks.join(""),
    provider: answer.provider,
    credits: answer.credits,
  });

  return answer;
}

async function enhanceWithQoder(input: {
  projectId: string;
  commitSha: string;
  repositoryCommits: Record<string, string>;
  question: string;
  node: GraphNode | null;
  draft: ChatAnswer;
  onStatus?: ChatStatusFn;
}): Promise<ChatAnswer> {
  const fallback = async (note: string): Promise<ChatAnswer> => {
    await input.onStatus?.({ stage: "fallback", note });
    return {
      ...input.draft,
      chunks: chunkText(`> ⚠️ ${note}。以下内容仅基于当前图谱事实，不代表本轮源码深读结果。\n\n${input.draft.chunks.join("")}`),
    };
  };
  if (!config.qoderPat) return fallback("Qoder 未配置，使用图谱规则回答");

  const fingerprint = createHash("sha256")
    .update(JSON.stringify([
      input.projectId,
      input.commitSha,
      input.node?.id ?? "",
      input.question.trim().replace(/\s+/g, " ").toLowerCase(),
    ]))
    .digest("hex");
  const cachedAnswer = await getChatAnswerCache(fingerprint);
  if (cachedAnswer?.trim()) {
    await input.onStatus?.({ stage: "cache_hit", note: "已复用当前提交的 Agent 回答缓存" });
    return {
      ...input.draft,
      chunks: chunkText(cachedAnswer.trim()),
      credits: 0,
      provider: "qoder",
    };
  }

  const taskId = randomUUID();
  const sourceCommitSha = input.node?.repositoryId
    ? input.repositoryCommits[input.node.repositoryId] ?? input.commitSha
    : input.commitSha;
  try {
    if (!(await waitForRedis(5_000))) return fallback("Agent 队列暂不可用，使用图谱规则回答");
    await setChatTaskState(taskId, {
      status: "pending",
      stage: "queued",
      note: "任务已进入 Agent 队列",
      projectId: input.projectId,
      commitSha: sourceCommitSha,
      repositoryId: input.node?.repositoryId,
      question: input.question,
      nodeId: input.node?.id ?? "",
      nodeName: input.node?.name ?? "",
      nodePath: input.node?.path ?? "",
      groundedDraft: input.draft.chunks.join("").slice(0, 24_000),
    });
    await enqueueChat(taskId, input.projectId);
    await input.onStatus?.({ stage: "queued", note: "任务已进入 Agent 队列" });

    const queuedAt = Date.now();
    let deadline = queuedAt + config.qoderChatQueueTimeoutSeconds * 1000;
    let runnerStartedAt: number | null = null;
    let nextProgressAt = queuedAt + 15_000;
    let lastStage = "queued";
    let lastNote = "任务已进入 Agent 队列";
    while (Date.now() < deadline) {
      const state = await getChatTaskState(taskId);
      if (state?.status === "running" && runnerStartedAt === null) {
        runnerStartedAt = Date.now();
        deadline = runnerStartedAt + config.qoderChatTimeoutSeconds * 1000 + 5_000;
      }
      if (state?.stage && state.note && (state.stage !== lastStage || state.note !== lastNote)) {
        lastStage = state.stage;
        lastNote = state.note;
        await input.onStatus?.({
          stage: state.stage as ChatStatus["stage"],
          note: state.note,
        });
      }
      if (Date.now() >= nextProgressAt) {
        const elapsedSeconds = Math.max(
          1,
          Math.round((Date.now() - (runnerStartedAt ?? queuedAt)) / 1000),
        );
        await input.onStatus?.({
          stage: runnerStartedAt ? "reading_source" : "queued",
          note: runnerStartedAt
            ? `Qoder 正在阅读源码并生成回答（已等待 ${elapsedSeconds} 秒）`
            : `Agent 正在排队等待可用 Runner（已等待 ${elapsedSeconds} 秒）`,
        });
        nextProgressAt = Date.now() + 15_000;
      }
      if (state?.status === "succeeded" && state.text?.trim()) {
        await setChatAnswerCache(
          fingerprint,
          state.text.trim(),
          config.chatAnswerCacheTtlSeconds,
        );
        return {
          ...input.draft,
          chunks: chunkText(state.text.trim()),
          credits: Number(state.credits ?? 0) || 0,
          provider: "qoder",
        };
      }
      if (state?.status === "failed") return fallback("Qoder 执行失败，已降级为图谱规则回答");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (runnerStartedAt === null) {
      await setChatTaskState(taskId, {
        status: "failed",
        error: `Agent 队列等待超过 ${config.qoderChatQueueTimeoutSeconds} 秒`,
      }).catch(() => undefined);
      return fallback("Agent 队列等待超时，已降级为图谱规则回答");
    }
    return fallback("Qoder 推理超时，已降级为图谱规则回答");
  } catch {
    return fallback("Agent 服务暂不可用，已降级为图谱规则回答");
  }
}

/** 会话是否已超 max-turns（契约 §6：超限返回 chat.error RATE_LIMITED） */
export async function isSessionExhausted(projectId: string, sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false;
  const turns = await chatTurnCount(projectId, sessionId);
  return turns >= MAX_TURNS_PER_SESSION;
}

function dedupeEvidence(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const ev of list) {
    const key = `${ev.file}:${ev.startLine ?? ""}-${ev.endLine ?? ""}:${ev.symbol ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

/** 切成便于流式下发的小段，拼接后必须与原 Markdown 完全一致。 */
export function chunkText(text: string, size = 120): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks.length > 0 ? chunks : [""];
}
