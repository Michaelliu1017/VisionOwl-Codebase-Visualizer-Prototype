import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GraphDocument } from "../../types";
import {
  normalizeGraphPatchAliases,
  validateGraphPatch,
  type GraphPatchDocument,
  type GraphPatchOperation,
} from "../../schemas/patchValidator";
import type { AnalysisPacket, AnalysisPlan } from "./analysisPackets";
import type {
  DiagnosticsDocument,
  FactIndex,
  InterfaceCatalog,
  ResourceCatalog,
  SymbolIndex,
} from "./contracts";

const run = promisify(execFile);
const MODULE_RESULT_SCHEMA_VERSION = "1.0" as const;

type JsonRecord = Record<string, unknown>;

export interface ModuleAgentEvidence {
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  factId?: string;
}

export interface ModuleAnalysisResult {
  schemaVersion: typeof MODULE_RESULT_SCHEMA_VERSION;
  packetId: string;
  moduleId: string;
  moduleName: string;
  moduleSummary: string;
  responsibilities: string[];
  interfaces: string[];
  dependencies: string[];
  proposedOperations: JsonRecord[];
  risks: string[];
  evidence: ModuleAgentEvidence[];
}

export interface ModuleAgentRunRecord {
  packetId: string;
  moduleId: string;
  moduleName: string;
  status: "succeeded" | "failed";
  model: string;
  durationMs: number;
  credits: number;
  attempts: 1 | 2;
  diagnostics: {
    initial: AgentPayloadDiagnostics;
    repair?: AgentPayloadDiagnostics;
  };
  result?: ModuleAnalysisResult;
  error?: string;
}

export interface ModuleAnalysisReport {
  schemaVersion: "1.0";
  generatedAt: string;
  model: string;
  concurrency: number;
  assignmentCount: number;
  packetCount: number;
  succeeded: number;
  failed: number;
  retried: number;
  recovered: number;
  credits: number;
  records: ModuleAgentRunRecord[];
}

export interface AnalysisAssignment {
  assignmentId: string;
  packets: AnalysisPacket[];
}

export interface AgentPayloadDiagnostics {
  stdoutBytes: number;
  envelopeKind: "object" | "array" | "string" | "invalid_json";
  topLevelKeys: string[];
  extractedTextBytes: number;
  jsonCandidateBytes: number;
  parseStage: "direct" | "embedded_json" | "no_json_object" | "invalid_json";
  parseErrorCode?: "missing_json_object" | "invalid_embedded_json";
}

interface AgentInvocationResult {
  payload?: unknown;
  credits: number;
  repairText: string;
  diagnostics: AgentPayloadDiagnostics;
}

interface OrchestratorInputs {
  plan: AnalysisPlan;
  facts: FactIndex;
  symbols: SymbolIndex;
  interfaces: InterfaceCatalog;
  resources: ResourceCatalog;
  diagnostics: DiagnosticsDocument;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function stringList(value: unknown, limit = 40): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item)).filter(Boolean))].slice(0, limit);
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function extractAgentText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  const object = record(value);
  if (!object) {
    if (!Array.isArray(value)) return null;
    const parts = value.map(extractAgentText).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n") : null;
  }
  for (const key of ["result", "answer", "response", "text", "content", "message", "output"]) {
    const found = extractAgentText(object[key]);
    if (found) return found;
  }
  for (const nested of Object.values(object)) {
    const found = extractAgentText(nested);
    if (found) return found;
  }
  return null;
}

export function extractCredits(value: unknown): number {
  const object = record(value);
  if (!object) {
    if (!Array.isArray(value)) return 0;
    return Math.max(0, ...value.map(extractCredits));
  }
  for (const key of ["credits", "total_credits", "usage_credits"]) {
    const parsed = numberValue(object[key]);
    if (parsed !== undefined && parsed >= 0) return parsed;
  }
  return Math.max(0, ...Object.values(object).map(extractCredits));
}

function balancedJsonSlice(input: string): string | null {
  const start = input.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
    }
  }
  return null;
}

function safeTopLevelKeys(value: unknown): string[] {
  const object = record(value);
  if (!object) return [];
  return Object.keys(object)
    .filter((key) => /^[a-zA-Z0-9_.-]{1,64}$/.test(key))
    .slice(0, 30);
}

function envelopeKind(value: unknown, parsed: boolean): AgentPayloadDiagnostics["envelopeKind"] {
  if (!parsed) return "invalid_json";
  if (Array.isArray(value)) return "array";
  if (record(value)) return "object";
  return "string";
}

/**
 * Parse model output without persisting its raw text. The repair text is kept
 * in memory only long enough for a single structure-only retry.
 */
export function inspectAgentPayload(stdout: string): AgentInvocationResult {
  let envelope: unknown;
  let parsedEnvelope = true;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = stdout;
    parsedEnvelope = false;
  }
  const credits = extractCredits(envelope);
  const direct = record(envelope);
  if (direct && (Array.isArray(direct.results) || direct.decision || text(direct.packetId))) {
    const repairText = JSON.stringify(direct);
    return {
      payload: direct,
      credits,
      repairText,
      diagnostics: {
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        envelopeKind: envelopeKind(envelope, parsedEnvelope),
        topLevelKeys: safeTopLevelKeys(envelope),
        extractedTextBytes: Buffer.byteLength(repairText, "utf8"),
        jsonCandidateBytes: Buffer.byteLength(repairText, "utf8"),
        parseStage: "direct",
      },
    };
  }
  const responseText = extractAgentText(envelope) ?? stdout;
  const candidate = balancedJsonSlice(responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  const baseDiagnostics = {
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    envelopeKind: envelopeKind(envelope, parsedEnvelope),
    topLevelKeys: safeTopLevelKeys(envelope),
    extractedTextBytes: Buffer.byteLength(responseText, "utf8"),
  };
  if (!candidate) {
    return {
      credits,
      repairText: responseText,
      diagnostics: {
        ...baseDiagnostics,
        jsonCandidateBytes: 0,
        parseStage: "no_json_object",
        parseErrorCode: "missing_json_object",
      },
    };
  }
  try {
    return {
      payload: JSON.parse(candidate),
      credits,
      repairText: candidate,
      diagnostics: {
        ...baseDiagnostics,
        jsonCandidateBytes: Buffer.byteLength(candidate, "utf8"),
        parseStage: "embedded_json",
      },
    };
  } catch {
    return {
      credits,
      repairText: candidate,
      diagnostics: {
        ...baseDiagnostics,
        jsonCandidateBytes: Buffer.byteLength(candidate, "utf8"),
        parseStage: "invalid_json",
        parseErrorCode: "invalid_embedded_json",
      },
    };
  }
}

export function parseAgentPayload(stdout: string): AgentInvocationResult {
  const inspected = inspectAgentPayload(stdout);
  if (inspected.payload === undefined) {
    throw new Error(inspected.diagnostics.parseErrorCode === "invalid_embedded_json"
      ? "Agent 返回的 JSON 无法解析"
      : "Agent 未返回 JSON 对象");
  }
  return inspected;
}

/**
 * A single-packet model may omit the outer `results` array even when the
 * prompt requests it. Accept that shape without weakening packet/evidence
 * validation performed by normalizeModuleResult.
 */
export function moduleResultCandidates(payload: unknown): unknown[] {
  const visited = new Set<unknown>();
  const collect = (value: unknown, depth: number): unknown[] => {
    if (depth > 5 || value === null || visited.has(value)) return [];
    if (typeof value === "object") visited.add(value);
    if (Array.isArray(value)) return value.flatMap((item) => collect(item, depth + 1));
    const object = record(value);
    if (!object) return [];
    if (text(object.packetId) || text(object.moduleSummary)) return [object];
    const preferredKeys = ["results", "result", "data", "output", "response", "content", "analysis"];
    const preferred = preferredKeys.flatMap((key) => collect(object[key], depth + 1));
    if (preferred.length > 0) return preferred;
    return Object.values(object).flatMap((item) => collect(item, depth + 1));
  };
  return collect(payload, 0);
}

function related(left: AnalysisPacket, right: AnalysisPacket): boolean {
  return left.incomingModuleIds.includes(right.module.id) ||
    left.outgoingModuleIds.includes(right.module.id) ||
    right.incomingModuleIds.includes(left.module.id) ||
    right.outgoingModuleIds.includes(left.module.id);
}

/**
 * 模块少时一包一任务；模块很多时优先把依赖邻近模块放在同一任务，防止 Agent 调用数失控。
 * 无论如何都不会丢弃 packet。
 */
export function buildAssignments(packets: AnalysisPacket[], maxTasks: number): AnalysisAssignment[] {
  if (packets.length === 0) return [];
  const taskCount = Math.max(1, Math.min(packets.length, Math.floor(maxTasks) || 1));
  const maxPerTask = Math.ceil(packets.length / taskCount);
  const groups: AnalysisPacket[][] = Array.from({ length: taskCount }, () => []);
  const ordered = [...packets].sort((left, right) =>
    Number(right.priority === "changed") - Number(left.priority === "changed") ||
    left.module.id.localeCompare(right.module.id),
  );
  for (const packet of ordered) {
    const linked = groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.length > 0 && group.length < maxPerTask && group.some((item) => related(item, packet)))
      .sort((left, right) => left.group.length - right.group.length)[0];
    const target = linked ?? groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.length < maxPerTask)
      .sort((left, right) => left.group.length - right.group.length || left.index - right.index)[0];
    if (!target) throw new Error("无法为分析包分配 Agent 任务");
    target.group.push(packet);
  }
  return groups.filter((group) => group.length > 0).map((group, index) => ({
    assignmentId: `assignment-${String(index + 1).padStart(3, "0")}`,
    packets: group,
  }));
}

export interface AdaptiveTaskOptions {
  singleAgentMaxPackets: number;
  maxAgents: number;
  packetsPerAgent: number;
}

/**
 * 普通仓库只启动一个强 Agent。只有分析包确实超过单 Agent 预算时，
 * 才扩展为少量领域 Agent，避免重新引入无限并行和重型串行汇总。
 */
export function adaptiveTaskCount(packetCount: number, options: AdaptiveTaskOptions): number {
  if (packetCount <= 0) return 0;
  const singleAgentMaxPackets = Math.max(1, Math.floor(options.singleAgentMaxPackets));
  if (packetCount <= singleAgentMaxPackets) return 1;
  const packetsPerAgent = Math.max(1, Math.floor(options.packetsPerAgent));
  const maxAgents = Math.max(2, Math.floor(options.maxAgents));
  return Math.min(maxAgents, Math.max(2, Math.ceil(packetCount / packetsPerAgent)));
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(items.length || 1, Math.floor(concurrency) || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}

function safeFile(repoRoot: string, relativePath: string): string | null {
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(root, relativePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

interface SourceRange {
  start: number;
  end: number;
}

export interface SourceContextOptions {
  maxBytes?: number;
  maxFiles?: number;
  contextLines?: number;
  fallbackLines?: number;
  maxBytesPerFile?: number;
}

function mergeSourceRanges(ranges: SourceRange[]): SourceRange[] {
  const ordered = [...ranges]
    .filter((range) => range.start > 0 && range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SourceRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Read only evidence-adjacent source windows. This keeps module prompts small
 * while preserving original line numbers used by evidence validation.
 */
export async function buildSourceContext(
  repoRoot: string,
  packets: AnalysisPacket[],
  options: SourceContextOptions = {},
): Promise<string> {
  const packetByteBudget = Math.max(...packets.map((packet) => packet.budget.maxSourceBytes), 0);
  const packetFileBudget = Math.max(...packets.map((packet) => packet.budget.maxFiles), 0);
  const totalBudget = Math.max(4_000, Math.min(options.maxBytes ?? (packetByteBudget || 60_000), 60_000));
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? (packetFileBudget || 24), 24));
  const contextLines = Math.max(0, Math.min(options.contextLines ?? 12, 40));
  const fallbackLines = Math.max(10, Math.min(options.fallbackLines ?? 80, 200));
  const maxBytesPerFile = Math.max(2_000, Math.min(options.maxBytesPerFile ?? 12_000, 20_000));
  const rangesByFile = new Map<string, SourceRange[]>();
  for (const packet of packets) {
    for (const evidence of packet.evidence) {
      const start = Math.max(1, Math.floor(evidence.startLine || 1) - contextLines);
      const end = Math.max(start, Math.floor(evidence.endLine || evidence.startLine || 1) + contextLines);
      rangesByFile.set(evidence.file, [...(rangesByFile.get(evidence.file) ?? []), { start, end }]);
    }
  }
  const files = [...new Set(packets.flatMap((packet) => packet.allowedFiles))]
    .sort((left, right) => Number(rangesByFile.has(right)) - Number(rangesByFile.has(left)) || left.localeCompare(right))
    .slice(0, maxFiles);
  const blocks: string[] = [];
  let remaining = totalBudget;
  for (const relativePath of files) {
    if (remaining < 256) break;
    const absolutePath = safeFile(repoRoot, relativePath);
    if (!absolutePath) continue;
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
    if (!raw || raw.includes("\0")) continue;
    const lines = raw.split("\n");
    const configuredRanges = rangesByFile.get(relativePath);
    const ranges = mergeSourceRanges(configuredRanges?.length
      ? configuredRanges.map((range) => ({ start: range.start, end: Math.min(lines.length, range.end) }))
      : [{ start: 1, end: Math.min(lines.length, fallbackLines) }]);
    const header = `<source file="${relativePath}">\n`;
    const footer = "\n</source>";
    const fileBudget = Math.min(maxBytesPerFile, remaining) - Buffer.byteLength(header + footer, "utf8");
    if (fileBudget <= 0) continue;
    const rendered: string[] = [];
    let used = 0;
    for (const [rangeIndex, range] of ranges.entries()) {
      if (rangeIndex > 0) {
        const marker = "... omitted ...\n";
        const markerBytes = Buffer.byteLength(marker, "utf8");
        if (used + markerBytes > fileBudget) break;
        rendered.push(marker.trimEnd());
        used += markerBytes;
      }
      for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
        const line = `${lineNumber}| ${lines[lineNumber - 1] ?? ""}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (used + lineBytes > fileBudget) break;
        rendered.push(line.trimEnd());
        used += lineBytes;
      }
      if (used >= fileBudget) break;
    }
    if (rendered.length === 0) continue;
    const block = `${header}${rendered.join("\n")}${footer}`;
    blocks.push(block);
    remaining -= Buffer.byteLength(block, "utf8");
  }
  return blocks.join("\n\n");
}

function packetFacts(
  inputs: OrchestratorInputs,
  packets: AnalysisPacket[],
  compact = false,
): JsonRecord {
  const factIds = new Set(packets.flatMap((packet) => packet.relatedFactIds));
  const symbolIds = new Set(packets.flatMap((packet) => packet.publicSymbolIds));
  const interfaceIds = new Set(packets.flatMap((packet) => packet.interfaceIds));
  const resourceIds = new Set(packets.flatMap((packet) => packet.resourceIds));
  const diagnosticIds = new Set(packets.flatMap((packet) => packet.diagnosticIds));
  const factPriority = new Map<string, number>([
    ["route", 0],
    ["rpc", 1],
    ["mq", 2],
    ["db", 3],
    ["cache", 4],
    ["config", 5],
  ]);
  const relatedFacts = inputs.facts.facts
    .filter((item) => factIds.has(item.factId))
    .sort((left, right) =>
      (factPriority.get(left.type) ?? 20) - (factPriority.get(right.type) ?? 20) ||
      left.factId.localeCompare(right.factId),
    );
  const take = <T>(items: T[], limit: number): T[] => compact ? items.slice(0, limit) : items;
  return {
    packets: packets.map((packet) => ({
      packetId: packet.packetId,
      module: packet.module,
      priority: packet.priority,
      entryFactIds: take(packet.entryFactIds, 30),
      publicSymbolIds: take(packet.publicSymbolIds, 50),
      relatedFactIds: take(packet.relatedFactIds, 120),
      incomingModuleIds: take(packet.incomingModuleIds, 30),
      outgoingModuleIds: take(packet.outgoingModuleIds, 30),
      interfaceIds: take(packet.interfaceIds, 40),
      resourceIds: take(packet.resourceIds, 40),
      diagnosticIds: take(packet.diagnosticIds, 20),
      allowedFiles: packet.allowedFiles.slice(0, compact ? Math.min(16, packet.budget.maxFiles) : packet.budget.maxFiles),
      evidence: packet.evidence.slice(0, compact ? 60 : 100),
      questions: packet.questions,
      budget: packet.budget,
    })),
    facts: take(relatedFacts, 240),
    symbols: take(inputs.symbols.definitions.filter((item) => symbolIds.has(item.symbolId)), 120),
    interfaces: take(inputs.interfaces.interfaces.filter((item) => interfaceIds.has(item.interfaceId)), 80),
    resources: take(inputs.resources.resources.filter((item) => resourceIds.has(item.resourceId)), 80),
    diagnostics: take(inputs.diagnostics.diagnostics.filter((item) => diagnosticIds.has(item.diagnosticId)), 40),
  };
}

async function buildModulePrompt(
  repoRoot: string,
  assignment: AnalysisAssignment,
  inputs: OrchestratorInputs,
  compactContext = false,
): Promise<string> {
  const context = packetFacts(inputs, assignment.packets, compactContext);
  const configuredBytes = Number(process.env.MODULE_AGENT_CONTEXT_MAX_BYTES || 60_000);
  const configuredFiles = Number(process.env.MODULE_AGENT_CONTEXT_MAX_FILES || 24);
  const sources = await buildSourceContext(repoRoot, assignment.packets, {
    maxBytes: compactContext
      ? Math.min(Number.isFinite(configuredBytes) ? configuredBytes : 60_000, 40_000)
      : Number.isFinite(configuredBytes) ? configuredBytes : 60_000,
    maxFiles: compactContext
      ? Math.min(Number.isFinite(configuredFiles) ? configuredFiles : 24, 16)
      : Number.isFinite(configuredFiles) ? configuredFiles : 24,
  });
  return [
    "你是 VisionOwl 的模块代码分析 Agent。所有源码上下文已预读取，当前没有工具；禁止修改文件或输出分析过程。",
    "逐个分析 assignment 中的模块，只能提交有真实源码证据的结论。Fact Index 是确定性骨架；发现遗漏、方向错误或主次分级错误时可提出 Patch 建议，但不得凭模块名称猜测。不得输出密钥、令牌、密码或其他凭证值。",
    "只输出一个合法 JSON 对象，不要 Markdown 代码围栏。格式必须为：",
    JSON.stringify({
      schemaVersion: MODULE_RESULT_SCHEMA_VERSION,
      results: [{
        packetId: "必须与输入一致",
        moduleSummary: "一句话职责",
        responsibilities: ["职责"],
        interfaces: ["入口、协议或对外契约"],
        dependencies: ["依赖与调用方向"],
        proposedOperations: [{
          operationId: "稳定且唯一",
          op: "update_summary|set_architecture|add_node|add_edge|replace_edge|suppress_edge|add_view",
          reason: "修正原因",
          evidence: [{ file: "路径", startLine: 1, endLine: 2, factId: "可选" }],
          confidence: 0.8,
          nodeId: "set_architecture/update_summary 使用真实节点 ID",
          architecture: {
            role: "frontend|backend|worker|executor|data|shared|domain|external",
            importance: "primary|supporting|detail",
            visibleByDefault: true,
            rationale: "为何它应出现在或退出默认架构总览",
          },
        }],
        risks: ["风险或维护约束"],
        evidence: [{ file: "路径", startLine: 1, endLine: 2, factId: "可选" }],
      }],
    }, null, 2),
    "每个输入 packet 必须恰好返回一条 results；无法确认时保留空数组并说明风险，不要伪造证据。",
    `ASSIGNMENT=${assignment.assignmentId}`,
    `FACT_CONTEXT=${JSON.stringify(context)}`,
    sources ? `SOURCE_CONTEXT=\n${sources}` : "SOURCE_CONTEXT=无可读源码，只能使用 Fact Context。",
  ].join("\n\n");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/**
 * The retry receives only the first model answer and the output contract. It
 * cannot re-read source or introduce new findings.
 */
export function buildModuleRepairPrompt(
  assignmentId: string,
  packets: AnalysisPacket[],
  candidateText: string,
  maxCandidateBytes = 60_000,
): string {
  const packetIds = packets.map((packet) => packet.packetId);
  const candidate = truncateUtf8(candidateText, Math.max(4_000, maxCandidateBytes));
  return [
    "你是 JSON 结构修复器，不是代码分析 Agent。禁止读取源码、重新分析、补充新事实或输出解释。",
    "只把 FIRST_OUTPUT 中已经存在的信息整理成下面的合法 JSON；没有的信息使用空数组。moduleSummary 只能忠实压缩已有文字，不能猜测。",
    `必须且只能返回这些 packetId：${JSON.stringify(packetIds)}`,
    "只输出一个 JSON 对象，不要 Markdown 代码围栏。格式为：",
    JSON.stringify({
      schemaVersion: MODULE_RESULT_SCHEMA_VERSION,
      results: [{
        packetId: "输入中的 packetId",
        moduleSummary: "已有内容的一句话摘要",
        responsibilities: [],
        interfaces: [],
        dependencies: [],
        proposedOperations: [],
        risks: [],
        evidence: [],
      }],
    }, null, 2),
    `ASSIGNMENT=${assignmentId}`,
    `<FIRST_OUTPUT>\n${candidate}\n</FIRST_OUTPUT>`,
  ].join("\n\n");
}

function evidenceList(value: unknown, packet: AnalysisPacket): ModuleAgentEvidence[] {
  if (!Array.isArray(value)) return [];
  const allowedFiles = new Set(packet.allowedFiles);
  const factIds = new Set(packet.relatedFactIds);
  return value.flatMap((item): ModuleAgentEvidence[] => {
    const object = record(item);
    const file = text(object?.file);
    if (!object || !allowedFiles.has(file)) return [];
    const startLine = numberValue(object.startLine);
    const endLine = numberValue(object.endLine);
    const factId = text(object.factId);
    return [{
      file,
      startLine: startLine && startLine > 0 ? Math.floor(startLine) : undefined,
      endLine: endLine && endLine > 0 ? Math.floor(endLine) : undefined,
      symbol: text(object.symbol) || undefined,
      factId: factId && factIds.has(factId) ? factId : undefined,
    }];
  }).slice(0, 40);
}

function proposedOperations(value: unknown, packet: AnalysisPacket): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): JsonRecord[] => {
    const object = record(item);
    if (!object) return [];
    const evidence = evidenceList(object.evidence, packet);
    if (evidence.length === 0) return [];
    return [{ ...object, evidence }];
  }).slice(0, 100);
}

export function normalizeModuleResult(value: unknown, packet: AnalysisPacket): ModuleAnalysisResult | null {
  const object = record(value);
  if (!object || text(object.packetId) !== packet.packetId) return null;
  const summary = text(object.moduleSummary);
  const evidence = evidenceList(object.evidence, packet);
  if (!summary) return null;
  return {
    schemaVersion: MODULE_RESULT_SCHEMA_VERSION,
    packetId: packet.packetId,
    moduleId: packet.module.id,
    moduleName: packet.module.name,
    moduleSummary: summary.slice(0, 2_000),
    responsibilities: stringList(object.responsibilities),
    interfaces: stringList(object.interfaces),
    dependencies: stringList(object.dependencies),
    proposedOperations: proposedOperations(object.proposedOperations, packet),
    risks: stringList(object.risks),
    evidence,
  };
}

async function invokeQoder(input: {
  prompt: string;
  model: string;
  cwd: string;
  timeoutMs: number;
  maxOutputTokens: number;
  label: string;
}): Promise<AgentInvocationResult> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), `visionowl-${input.label}-`));
  const promptFile = path.join(configDir, "module-context.md");
  try {
    await fs.writeFile(promptFile, input.prompt, { encoding: "utf8", mode: 0o600 });
    const { stdout } = await run("qodercli", buildQoderInvocationArgs({
      model: input.model,
      cwd: input.cwd,
      maxOutputTokens: input.maxOutputTokens,
      configDir,
      promptFile,
    }), {
      timeout: input.timeoutMs,
      maxBuffer: 24 * 1024 * 1024,
      encoding: "utf8",
      env: process.env,
    });
    return inspectAgentPayload(stdout);
  } finally {
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function buildQoderInvocationArgs(input: {
  model: string;
  cwd: string;
  maxOutputTokens: number;
  configDir: string;
  promptFile: string;
}): string[] {
  return [
    "--tools", "",
    "--attachment", input.promptFile,
    "-p", "严格按照附件中的完整任务说明分析模块，只输出任务要求的合法 JSON。",
    "-m", input.model,
    "--output-format", "json",
    "--permission-mode", "dont_ask",
    "--max-turns", "1",
    "--max-output-tokens", String(input.maxOutputTokens),
    "--no-session-persistence",
    "--config-dir", input.configDir,
    "-w", input.cwd,
  ];
}

function safeOutputName(packetId: string): string {
  return packetId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function normalizeAssignmentResults(
  payload: unknown,
  packets: AnalysisPacket[],
): Map<string, ModuleAnalysisResult> {
  const rawResults = moduleResultCandidates(payload);
  const normalized = new Map<string, ModuleAnalysisResult>();
  for (const packet of packets) {
    const result = rawResults
      .map((item) => {
        const candidate = record(item);
        const singlePacketCandidate = packets.length === 1 && candidate && !text(candidate.packetId)
          ? { ...candidate, packetId: packet.packetId }
          : item;
        return normalizeModuleResult(singlePacketCandidate, packet);
      })
      .find((item): item is ModuleAnalysisResult => Boolean(item));
    if (result) normalized.set(packet.packetId, result);
  }
  return normalized;
}

function unavailableDiagnostics(): AgentPayloadDiagnostics {
  return {
    stdoutBytes: 0,
    envelopeKind: "invalid_json",
    topLevelKeys: [],
    extractedTextBytes: 0,
    jsonCandidateBytes: 0,
    parseStage: "no_json_object",
    parseErrorCode: "missing_json_object",
  };
}

async function runAssignment(input: {
  assignment: AnalysisAssignment;
  inputs: OrchestratorInputs;
  repoRoot: string;
  outputDir: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  repairEnabled: boolean;
  repairModel: string;
  repairMaxOutputTokens: number;
  repairMaxCandidateBytes: number;
  compactContext?: boolean;
}): Promise<ModuleAgentRunRecord[]> {
  const startedAt = Date.now();
  try {
    const prompt = await buildModulePrompt(
      input.repoRoot,
      input.assignment,
      input.inputs,
      input.compactContext,
    );
    const invocation = await invokeQoder({
      prompt,
      model: input.model,
      cwd: input.repoRoot,
      timeoutMs: input.timeoutMs,
      maxOutputTokens: input.maxOutputTokens,
      label: input.assignment.assignmentId,
    });
    const initialResults = normalizeAssignmentResults(invocation.payload, input.assignment.packets);
    const failedPackets = input.assignment.packets.filter((packet) => !initialResults.has(packet.packetId));
    let repairInvocation: AgentInvocationResult | undefined;
    let repairResults = new Map<string, ModuleAnalysisResult>();
    let repairInvocationFailed = false;
    if (input.repairEnabled && failedPackets.length > 0 && invocation.repairText.trim()) {
      try {
        repairInvocation = await invokeQoder({
          prompt: buildModuleRepairPrompt(
            input.assignment.assignmentId,
            failedPackets,
            invocation.repairText,
            input.repairMaxCandidateBytes,
          ),
          model: input.repairModel,
          cwd: input.repoRoot,
          timeoutMs: input.timeoutMs,
          maxOutputTokens: input.repairMaxOutputTokens,
          label: `${input.assignment.assignmentId}-repair`,
        });
        repairResults = normalizeAssignmentResults(repairInvocation.payload, failedPackets);
      } catch {
        repairInvocationFailed = true;
      }
    }
    const initialCreditsPerPacket = input.assignment.packets.length > 0
      ? invocation.credits / input.assignment.packets.length
      : 0;
    const repairCreditsPerPacket = failedPackets.length > 0
      ? (repairInvocation?.credits ?? 0) / failedPackets.length
      : 0;
    return await Promise.all(input.assignment.packets.map(async (packet) => {
      const initialResult = initialResults.get(packet.packetId);
      const repairedResult = repairResults.get(packet.packetId);
      const normalized = initialResult ?? repairedResult;
      const attemptedRepair = !initialResult && Boolean(repairInvocation || repairInvocationFailed);
      const diagnostics = {
        initial: invocation.diagnostics,
        ...(attemptedRepair ? { repair: repairInvocation?.diagnostics ?? unavailableDiagnostics() } : {}),
      };
      const recordValue: ModuleAgentRunRecord = normalized ? {
        packetId: packet.packetId,
        moduleId: packet.module.id,
        moduleName: packet.module.name,
        status: "succeeded",
        model: input.model,
        durationMs: Date.now() - startedAt,
        credits: initialCreditsPerPacket + (attemptedRepair ? repairCreditsPerPacket : 0),
        attempts: attemptedRepair ? 2 : 1,
        diagnostics,
        result: normalized,
      } : {
        packetId: packet.packetId,
        moduleId: packet.module.id,
        moduleName: packet.module.name,
        status: "failed",
        model: input.model,
        durationMs: Date.now() - startedAt,
        credits: initialCreditsPerPacket + (attemptedRepair ? repairCreditsPerPacket : 0),
        attempts: attemptedRepair ? 2 : 1,
        diagnostics,
        error: attemptedRepair
          ? "Agent 输出结构校验失败，已完成一次格式修复重试；保留 Fact Index 骨架"
          : "Agent 未返回该 packet 的合法结构化结果；保留 Fact Index 骨架",
      };
      await fs.writeFile(
        path.join(input.outputDir, `${safeOutputName(packet.packetId)}.json`),
        JSON.stringify(recordValue, null, 2),
      );
      return recordValue;
    }));
  } catch (error) {
    const errorCode = error instanceof Error && error.name === "TimeoutError"
      ? "module_agent_timeout"
      : "module_agent_invocation_failed";
    return await Promise.all(input.assignment.packets.map(async (packet) => {
      const recordValue: ModuleAgentRunRecord = {
        packetId: packet.packetId,
        moduleId: packet.module.id,
        moduleName: packet.module.name,
        status: "failed",
        model: input.model,
        durationMs: Date.now() - startedAt,
        credits: 0,
        attempts: 1,
        diagnostics: { initial: unavailableDiagnostics() },
        error: `${errorCode}；保留 Fact Index 骨架`,
      };
      await fs.writeFile(
        path.join(input.outputDir, `${safeOutputName(packet.packetId)}.json`),
        JSON.stringify(recordValue, null, 2),
      );
      return recordValue;
    }));
  }
}

async function readInputs(outDir: string): Promise<OrchestratorInputs> {
  const read = async <T>(file: string): Promise<T> => JSON.parse(
    await fs.readFile(path.join(outDir, file), "utf8"),
  ) as T;
  return {
    plan: await read<AnalysisPlan>("analysis-packets.json"),
    facts: await read<FactIndex>("facts.v2.json"),
    symbols: await read<SymbolIndex>("symbol-index.json"),
    interfaces: await read<InterfaceCatalog>("interface-catalog.json"),
    resources: await read<ResourceCatalog>("resource-catalog.json"),
    diagnostics: await read<DiagnosticsDocument>("diagnostics.json"),
  };
}

interface RunModulesOptions {
  concurrency?: number;
  maxTasks?: number;
  compactContext?: boolean;
}

async function runModules(
  repoRoot: string,
  outDir: string,
  options: RunModulesOptions = {},
): Promise<ModuleAnalysisReport> {
  const inputs = await readInputs(outDir);
  const model = process.env.MODULE_MODEL || "Performance";
  const concurrency = Math.max(
    1,
    options.concurrency ?? Number(process.env.MODULE_AGENT_CONCURRENCY || 3),
  );
  const maxTasks = Math.max(
    1,
    options.maxTasks ?? Number(process.env.MODULE_AGENT_MAX_TASKS || 24),
  );
  const timeoutMs = Math.max(30_000, Number(process.env.MODULE_AGENT_TIMEOUT_SECONDS || 300) * 1_000);
  const maxOutputTokens = Math.max(1_000, Number(process.env.MODULE_AGENT_MAX_OUTPUT_TOKENS || 4_000));
  const repairEnabled = !["0", "false"].includes((process.env.MODULE_AGENT_REPAIR_ENABLED || "true").toLowerCase());
  const repairModel = process.env.MODULE_REPAIR_MODEL || model;
  const repairMaxOutputTokens = Math.max(
    1_000,
    Number(process.env.MODULE_AGENT_REPAIR_MAX_OUTPUT_TOKENS || maxOutputTokens),
  );
  const repairMaxCandidateBytes = Math.max(
    4_000,
    Number(process.env.MODULE_AGENT_REPAIR_MAX_CANDIDATE_BYTES || 60_000),
  );
  const outputDir = path.join(outDir, "module-results");
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const assignments = buildAssignments(inputs.plan.packets, maxTasks);
  const nestedRecords = await mapConcurrent(assignments, concurrency, async (assignment) => runAssignment({
    assignment,
    inputs,
    repoRoot,
    outputDir,
    model,
    timeoutMs,
    maxOutputTokens,
    repairEnabled,
    repairModel,
    repairMaxOutputTokens,
    repairMaxCandidateBytes,
    compactContext: options.compactContext,
  }));
  const records = nestedRecords.flat().sort((left, right) => left.packetId.localeCompare(right.packetId));
  const report: ModuleAnalysisReport = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    model,
    concurrency,
    assignmentCount: assignments.length,
    packetCount: inputs.plan.packets.length,
    succeeded: records.filter((item) => item.status === "succeeded").length,
    failed: records.filter((item) => item.status === "failed").length,
    retried: records.filter((item) => item.attempts === 2).length,
    recovered: records.filter((item) => item.attempts === 2 && item.status === "succeeded").length,
    credits: records.reduce((total, item) => total + item.credits, 0),
    records,
  };
  await fs.writeFile(path.join(outDir, "module-analysis-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(outDir, "module-agent-meta.json"), JSON.stringify({
    credits: report.credits,
    semanticEnhanced: report.succeeded > 0,
    retried: report.retried,
    recovered: report.recovered,
  }, null, 2));
  console.log(
    `[orchestrator] assignments=${assignments.length} packets=${report.packetCount} ` +
    `succeeded=${report.succeeded} failed=${report.failed} retried=${report.retried} ` +
    `recovered=${report.recovered} model=${model}`,
  );
  return report;
}

export interface AdaptivePatchAssembly {
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  conflictCount: number;
}

/**
 * Module Agent 已经返回结构化 proposedOperations。自适应模式直接使用现有
 * Patch Validator 逐条校验并由代码合并，避免再启动一个读取全仓上下文的 Agent。
 */
export async function assembleAdaptivePatch(
  repoRoot: string,
  outDir: string,
  inputs: OrchestratorInputs,
  report: ModuleAnalysisReport,
): Promise<AdaptivePatchAssembly> {
  const read = async <T>(file: string): Promise<T> => JSON.parse(
    await fs.readFile(path.join(outDir, file), "utf8"),
  ) as T;
  const baseGraph = await read<GraphDocument>("graph.base.json");
  const emptyPatch = await read<GraphPatchDocument>("graph-patch.empty.json").catch(() =>
    read<GraphPatchDocument>("graph-patch.json"),
  );
  const candidates = report.records
    .flatMap((recordValue) => recordValue.result?.proposedOperations ?? [])
    .filter((operation, index, all) => {
      const operationId = text(operation.operationId);
      return Boolean(operationId) && all.findIndex((item) => text(item.operationId) === operationId) === index;
    });
  const validatorOptions = {
    baseGraph,
    factIndex: inputs.facts,
    symbolIndex: inputs.symbols,
    fileExists: (relativePath: string): boolean => {
      const root = path.resolve(repoRoot);
      const candidate = path.resolve(root, relativePath);
      return candidate.startsWith(`${root}${path.sep}`) && existsSync(candidate);
    },
  };
  const individuallyAccepted: GraphPatchOperation[] = [];
  let individuallyRejected = 0;
  for (const operation of candidates) {
    const candidateDocument = normalizeGraphPatchAliases({
      ...emptyPatch,
      generator: "visionowl-adaptive-orchestrator",
      skillVersion: "adaptive-1.0.0",
      operations: [operation],
    });
    const validation = validateGraphPatch(candidateDocument, validatorOptions);
    if (validation.documentErrors.length === 0 && validation.accepted.length === 1) {
      individuallyAccepted.push(validation.accepted[0]!);
    } else {
      individuallyRejected += 1;
    }
  }
  const combinedDocument: GraphPatchDocument = {
    ...emptyPatch,
    generator: "visionowl-adaptive-orchestrator",
    skillVersion: "adaptive-1.0.0",
    operations: individuallyAccepted,
  };
  const combinedValidation = validateGraphPatch(combinedDocument, validatorOptions);
  const finalDocument: GraphPatchDocument = {
    ...combinedDocument,
    operations: combinedValidation.documentErrors.length === 0 ? combinedValidation.accepted : [],
  };
  await fs.writeFile(path.join(outDir, "graph-patch.json"), JSON.stringify(finalDocument, null, 2));
  return {
    candidateCount: candidates.length,
    acceptedCount: finalDocument.operations.length,
    rejectedCount: individuallyRejected + combinedValidation.rejected.length,
    conflictCount: combinedValidation.conflicts.length,
  };
}

async function runAdaptive(repoRoot: string, outDir: string): Promise<void> {
  const inputs = await readInputs(outDir);
  const singleAgentMaxPackets = Math.max(
    1,
    Number(process.env.ADAPTIVE_SINGLE_AGENT_MAX_PACKETS || 8),
  );
  const maxAgents = Math.max(2, Number(process.env.ADAPTIVE_MAX_AGENTS || 4));
  const packetsPerAgent = Math.max(1, Number(process.env.ADAPTIVE_PACKETS_PER_AGENT || 5));
  const taskCount = adaptiveTaskCount(inputs.plan.packets.length, {
    singleAgentMaxPackets,
    maxAgents,
    packetsPerAgent,
  });
  const configuredConcurrency = Math.max(1, Number(process.env.MODULE_AGENT_CONCURRENCY || 3));
  const report = await runModules(repoRoot, outDir, {
    maxTasks: Math.max(1, taskCount),
    concurrency: Math.max(1, Math.min(taskCount || 1, configuredConcurrency)),
    compactContext: true,
  });
  const assembly = await assembleAdaptivePatch(repoRoot, outDir, inputs, report);
  const strategy = taskCount <= 1 ? "single_agent" : "bounded_multi_agent";
  await fs.writeFile(path.join(outDir, "adaptive-orchestration.json"), JSON.stringify({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    mode: "adaptive",
    strategy,
    packetCount: inputs.plan.packets.length,
    taskCount,
    singleAgentMaxPackets,
    maxAgents,
    packetsPerAgent,
    skippedHeavyGlobalSynthesis: true,
    patchAssembly: assembly,
  }, null, 2));
  await fs.writeFile(path.join(outDir, "module-agent-meta.json"), JSON.stringify({
    credits: report.credits,
    semanticEnhanced: assembly.acceptedCount > 0,
    retried: report.retried,
    recovered: report.recovered,
    orchestrationMode: "adaptive",
    strategy,
    taskCount,
  }, null, 2));
  console.log(
    `[orchestrator] mode=adaptive strategy=${strategy} packets=${inputs.plan.packets.length} ` +
    `tasks=${taskCount} accepted=${assembly.acceptedCount} rejected=${assembly.rejectedCount} ` +
    `conflicts=${assembly.conflictCount}`,
  );
}

async function main(): Promise<void> {
  const phaseIndex = process.argv.indexOf("--phase");
  const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : "modules";
  const repoRoot = path.resolve(process.env.REPO_DIR || "/workspace/repo");
  const outDir = path.resolve(process.env.OUT_DIR || "/workspace/out");
  if (phase === "modules") await runModules(repoRoot, outDir);
  else if (phase === "adaptive") await runAdaptive(repoRoot, outDir);
  else throw new Error(`未知编排阶段：${phase}`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
