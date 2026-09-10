/**
 * graph.json 校验（spec §8 校验规则）——Runner 与 Graph Service 双侧执行同一套逻辑。
 *
 * 1. node.id 全局唯一；edge 端点必须存在（禁止悬空边）
 * 2. kind/type 在枚举内（JSON Schema 保证）；inferred=false 必须携带非空 evidence
 * 3. path 抽样校验存在于该 commit 文件树（仅 Runner 侧有源码，通过 fileExists 回调注入）
 * 4. 敏感信息最小化：单条 evidence ≤ 40 行，密钥样式字符串打码
 * 5. 体积上限：单文件 ≤ 10MB
 */
import fs from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import type { GraphDocument, GraphStats } from "../types";

export const MAX_EVIDENCE_LINES = 40;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

function loadSchema(): object {
  const candidates = [
    path.join(__dirname, "graph.schema.json"),
    path.join(__dirname, "..", "..", "src", "schemas", "graph.schema.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as object;
  }
  throw new Error("找不到 graph.schema.json");
}

let validator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    validator = ajv.compile(loadSchema());
  }
  return validator;
}

export interface ValidateOptions {
  /** Runner 侧传入：判断 path 是否真实存在于工作区（抽样校验规则 3） */
  fileExists?: (relPath: string) => boolean;
  /** 抽样条数，默认 20 */
  sampleSize?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  stats: GraphStats;
}

export function validateGraph(doc: unknown, opts: ValidateOptions = {}): ValidationResult {
  const errors: string[] = [];
  const empty: GraphStats = { nodeCount: 0, edgeCount: 0, inferredCount: 0 };

  const validate = getValidator();
  if (!validate(doc)) {
    for (const e of validate.errors ?? []) {
      errors.push(`schema ${e.instancePath || "/"} ${e.message ?? "非法"}`);
    }
    return { ok: false, errors: errors.slice(0, 30), stats: empty };
  }

  const g = doc as GraphDocument;

  // 规则 5：体积
  const bytes = Buffer.byteLength(JSON.stringify(g), "utf8");
  if (bytes > MAX_ARTIFACT_BYTES) {
    errors.push(`产物体积 ${(bytes / 1048576).toFixed(1)}MB 超过 10MB 上限，需拆分为 overview + 按域分片`);
  }

  // 规则 1：id 唯一
  const nodeIds = new Set<string>();
  for (const n of g.nodes) {
    if (nodeIds.has(n.id)) errors.push(`节点 id 重复：${n.id}`);
    nodeIds.add(n.id);
  }
  for (const n of g.nodes) {
    if (n.parentId && !nodeIds.has(n.parentId)) {
      errors.push(`次级节点 ${n.id} 引用了不存在的 parentId ${n.parentId}`);
    }
  }
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    if (edgeIds.has(e.id)) errors.push(`边 id 重复：${e.id}`);
    edgeIds.add(e.id);
    // 规则 1：禁止悬空边
    if (!nodeIds.has(e.source)) errors.push(`悬空边 ${e.id}：source ${e.source} 不存在`);
    if (!nodeIds.has(e.target)) errors.push(`悬空边 ${e.id}：target ${e.target} 不存在`);
  }

  // 规则 2：非推断结论必须有证据
  for (const n of g.nodes) {
    const isInfra = n.kind.startsWith("infra.") || n.kind === "external" || n.kind === "domain";
    if (!n.inferred && !isInfra && (!n.evidence || n.evidence.length === 0)) {
      errors.push(`节点 ${n.id} 未标记 inferred 但缺少 evidence`);
    }
  }
  for (const e of g.edges) {
    if (!e.inferred && (!e.evidence || e.evidence.length === 0)) {
      errors.push(`边 ${e.id} 未标记 inferred 但缺少 evidence`);
    }
  }

  // 规则 4：单条 evidence 行数
  const allEvidence = [
    ...g.nodes.flatMap((n) => n.evidence ?? []),
    ...g.edges.flatMap((e) => e.evidence ?? []),
  ];
  for (const ev of allEvidence) {
    if (ev.startLine !== undefined && ev.endLine !== undefined && ev.endLine - ev.startLine + 1 > MAX_EVIDENCE_LINES) {
      errors.push(`evidence ${ev.file}:${ev.startLine}-${ev.endLine} 超过 ${MAX_EVIDENCE_LINES} 行上限`);
    }
  }

  // 视图引用完整性
  for (const v of g.views ?? []) {
    for (const id of v.nodeIds) {
      if (!nodeIds.has(id)) errors.push(`视图 ${v.id} 引用了不存在的节点 ${id}`);
    }
    for (const id of v.edgeIds) {
      if (!edgeIds.has(id)) errors.push(`视图 ${v.id} 引用了不存在的边 ${id}`);
    }
    for (const s of v.steps ?? []) {
      if (!edgeIds.has(s.edgeId)) errors.push(`视图 ${v.id} step ${s.order} 引用了不存在的边 ${s.edgeId}`);
    }
  }

  // 规则 3：path 抽样存在性（仅 Runner 侧）
  if (opts.fileExists) {
    const sample = g.nodes
      .filter((n) => typeof n.path === "string" && n.path.length > 0)
      .slice(0, opts.sampleSize ?? 20);
    for (const n of sample) {
      if (!opts.fileExists(n.path as string)) {
        errors.push(`节点 ${n.id} 的 path 不存在于该 commit 文件树：${n.path}`);
      }
    }
  }

  const stats = computeStats(g);

  // stats 自洽（若产物自带）
  if (g.stats) {
    if (g.stats.nodeCount !== stats.nodeCount || g.stats.edgeCount !== stats.edgeCount) {
      errors.push(
        `stats 与实际计数不一致：声明 ${g.stats.nodeCount}/${g.stats.edgeCount}，实际 ${stats.nodeCount}/${stats.edgeCount}`,
      );
    }
  }

  return { ok: errors.length === 0, errors: errors.slice(0, 30), stats };
}

export function computeStats(g: GraphDocument): GraphStats {
  const inferredCount =
    g.nodes.filter((n) => n.inferred === true).length + g.edges.filter((e) => e.inferred === true).length;
  return { nodeCount: g.nodes.length, edgeCount: g.edges.length, inferredCount };
}

/** 密钥样式字符串打码（spec §12-6）：长 hex/base64 串、常见 token 前缀 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g,
  /\b(sk-[A-Za-z0-9]{16,})\b/g,
  /\b(AKIA[0-9A-Z]{12,})\b/g,
  /\b([A-Fa-f0-9]{32,})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g,
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => `${m.slice(0, 4)}***MASKED***`);
  return out;
}

/**
 * 入库前脱敏：摘要打码 + 超长 evidence 截断到 40 行。
 * 就地返回新对象，不修改入参。
 */
export function sanitizeGraph(g: GraphDocument): GraphDocument {
  const fixEvidence = (list?: typeof g.nodes[number]["evidence"]) =>
    (list ?? []).map((ev) => {
      if (ev.startLine !== undefined && ev.endLine !== undefined && ev.endLine - ev.startLine + 1 > MAX_EVIDENCE_LINES) {
        return { ...ev, endLine: ev.startLine + MAX_EVIDENCE_LINES - 1 };
      }
      return ev;
    });

  return {
    ...g,
    nodes: g.nodes.map((n) => ({
      ...n,
      name: maskSecrets(n.name),
      summary: n.summary ? maskSecrets(n.summary) : n.summary,
      evidence: fixEvidence(n.evidence),
    })),
    edges: g.edges.map((e) => ({ ...e, evidence: fixEvidence(e.evidence) })),
  };
}
