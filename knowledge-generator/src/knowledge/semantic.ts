import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CodeGraphDocument } from "../codegraph/types.js";
import type { EvidenceNode } from "../domain/types.js";
import type {
  DevelopmentStandard,
  ModuleEvidenceBundle,
  PitfallGuide,
  SemanticKnowledge,
  SkillGuidance,
} from "./types.js";

const run = promisify(execFile);

export interface SemanticAnalyzerPort {
  analyze(graph: CodeGraphDocument, modules: ModuleEvidenceBundle[]): Promise<SemanticKnowledge>;
}

export class DeterministicSemanticAnalyzer implements SemanticAnalyzerPort {
  async analyze(graph: CodeGraphDocument, modules: ModuleEvidenceBundle[]): Promise<SemanticKnowledge> {
    const allEvidence = unique(modules.flatMap((module) => module.evidence), (item) => item.id);
    return {
      overview: `${graph.nodes.length} 个代码节点和 ${graph.edges.length} 条关系构成当前冻结版本；知识结论仅来自代码图谱与可追溯工程证据。`,
      standards: deterministicStandards(allEvidence),
      pitfalls: deterministicPitfalls(allEvidence),
      skills: deterministicSkills(modules),
      provider: "deterministic",
      warnings: ["未启用语义模型；保留确定性知识骨架，未对证据含义做扩展推断。"],
    };
  }
}

export interface QoderSemanticAnalyzerOptions {
  executable?: string;
  model?: string;
  timeoutSeconds?: number;
  maxOutputTokens?: number;
  required?: boolean;
  fallback?: SemanticAnalyzerPort;
}

export class QoderSemanticAnalyzer implements SemanticAnalyzerPort {
  private readonly options: Required<Omit<QoderSemanticAnalyzerOptions, "fallback">> & { fallback: SemanticAnalyzerPort };

  constructor(options: QoderSemanticAnalyzerOptions = {}) {
    this.options = {
      executable: options.executable ?? "qodercli",
      model: options.model ?? "Performance",
      timeoutSeconds: options.timeoutSeconds ?? 600,
      maxOutputTokens: options.maxOutputTokens ?? 12_000,
      required: options.required ?? false,
      fallback: options.fallback ?? new DeterministicSemanticAnalyzer(),
    };
  }

  async analyze(graph: CodeGraphDocument, modules: ModuleEvidenceBundle[]): Promise<SemanticKnowledge> {
    const fallback = await this.options.fallback.analyze(graph, modules);
    const dir = await mkdtemp(join(tmpdir(), "visionowl-knowledge-"));
    const contextPath = join(dir, "knowledge-context.json");
    try {
      const context = semanticContext(graph, modules);
      await writeFile(contextPath, JSON.stringify(context, null, 2), { encoding: "utf8", mode: 0o600 });
      const { stdout } = await run(this.options.executable, [
        "--tools", "",
        "--attachment", contextPath,
        "-p", semanticPrompt(),
        "-m", this.options.model,
        "--output-format", "json",
        "--permission-mode", "dont_ask",
        "--max-turns", "1",
        "--max-output-tokens", String(this.options.maxOutputTokens),
        "--no-session-persistence",
        "--config-dir", dir,
        "-w", dir,
      ], {
        timeout: this.options.timeoutSeconds * 1000,
        maxBuffer: 24 * 1024 * 1024,
        encoding: "utf8",
        env: process.env,
      });
      const result = parseSemanticResult(stdout, new Set(context.evidence.map((item) => item.id)));
      return {
        overview: result.overview ?? fallback.overview,
        standards: result.standards.length > 0 ? result.standards : fallback.standards,
        pitfalls: result.pitfalls,
        skills: result.skills.length > 0 ? result.skills : fallback.skills,
        provider: "qoder",
        warnings: result.warnings,
      };
    } catch (error) {
      if (this.options.required) throw error;
      return {
        ...fallback,
        warnings: [...fallback.warnings, `Qoder 语义增强失败，已降级：${errorMessage(error)}`],
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function semanticContext(graph: CodeGraphDocument, modules: ModuleEvidenceBundle[]) {
  const evidence = unique(modules.flatMap((module) => module.evidence), (item) => item.id)
    .filter((item) => item.kind !== "actor" && item.kind !== "file")
    .slice(0, 500)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      state: item.state ?? null,
      title: item.title ?? null,
      content: item.content?.slice(0, 1200) ?? null,
      commitSha: item.commitSha ?? null,
      occurredAt: item.occurredAt,
      sourceUrl: item.sourceUrl,
      path: typeof item.payload.path === "string" ? item.payload.path : null,
      actor: item.actor?.login ?? null,
    }));
  return {
    schemaVersion: "knowledge-context.v1",
    project: { projectId: graph.projectId, commitSha: graph.commitSha },
    modules: modules.slice(0, 80).map((module) => ({
      id: module.module.id,
      name: module.module.name,
      kind: module.module.kind,
      path: module.module.path ?? null,
      summary: module.module.summary ?? null,
      repository: module.repository?.repoFullName ?? null,
      incoming: module.incoming.slice(0, 20),
      outgoing: module.outgoing.slice(0, 20),
      evidenceIds: module.evidence.slice(0, 40).map((item) => item.id),
    })),
    evidence,
  };
}

function semanticPrompt(): string {
  return [
    "你是 VisionOwl 工程知识提炼器。附件是冻结 commit 的代码图谱摘要与 GitHub 工程证据。",
    "只输出合法 JSON，不要 Markdown 代码围栏，不要分析过程。",
    "不得发明源码事实；每条开发规范、踩坑指南和 Skill 建议必须引用附件中真实存在的 evidenceIds。",
    "无证据的条目不要输出；CI 失败不等于已知根因，除非 Review/Comment 明确说明原因。",
    "输出结构：",
    '{"overview":"中文概览","standards":[{"title":"","rule":"","rationale":"","evidenceIds":[""]}],',
    '"pitfalls":[{"title":"","symptom":"","trigger":"","rootCause":"","fix":"","verification":"","evidenceIds":[""]}],',
    '"skills":[{"name":"lowercase-hyphen-name","description":"","trigger":"","steps":[""],"validation":[""],"evidenceIds":[""]}]}',
    "最多 12 条规范、10 条踩坑、12 个 Skill；内容使用中文，Skill name 使用小写英文连字符。",
  ].join("\n");
}

function parseSemanticResult(stdout: string, knownEvidence: Set<string>): SemanticKnowledge {
  const envelope = JSON.parse(stdout) as unknown;
  const text = extractText(envelope);
  if (!text) throw new Error("Qoder returned no semantic result");
  const parsed = JSON.parse(stripFence(text)) as Record<string, unknown>;
  const standards = array(parsed.standards).flatMap((item) => {
    const record = object(item);
    const evidenceIds = validEvidence(record?.evidenceIds, knownEvidence);
    if (!record || evidenceIds.length === 0) return [];
    const title = string(record.title);
    const rule = string(record.rule);
    const rationale = string(record.rationale);
    return title && rule && rationale ? [{ title, rule, rationale, evidenceIds }] : [];
  });
  const pitfalls = array(parsed.pitfalls).flatMap((item) => {
    const record = object(item);
    const evidenceIds = validEvidence(record?.evidenceIds, knownEvidence);
    if (!record || evidenceIds.length === 0) return [];
    const values = ["title", "symptom", "trigger", "rootCause", "fix", "verification"]
      .map((key) => string(record[key]));
    if (values.some((value) => !value)) return [];
    return [{
      title: values[0]!, symptom: values[1]!, trigger: values[2]!, rootCause: values[3]!,
      fix: values[4]!, verification: values[5]!, evidenceIds,
    }];
  });
  const skills = array(parsed.skills).flatMap((item) => {
    const record = object(item);
    const evidenceIds = validEvidence(record?.evidenceIds, knownEvidence);
    if (!record || evidenceIds.length === 0) return [];
    const name = slug(string(record.name) ?? "");
    const description = string(record.description);
    const trigger = string(record.trigger);
    const steps = stringArray(record.steps);
    const validation = stringArray(record.validation);
    if (!name || !description || !trigger || steps.length === 0 || validation.length === 0) return [];
    return [{ name, description, trigger, steps, validation, evidenceIds }];
  });
  return {
    overview: string(parsed.overview),
    standards: unique(standards, (item) => item.title),
    pitfalls: unique(pitfalls, (item) => item.title),
    skills: unique(skills, (item) => item.name),
    provider: "qoder",
    warnings: [],
  };
}

function deterministicStandards(evidence: EvidenceNode[]): DevelopmentStandard[] {
  const ciJobs = evidence
    .filter((item) => item.kind === "ci_job" && item.title)
    .slice(0, 6)
    .map((item) => ({
      title: `保持 ${item.title} 检查通过`,
      rule: `提交前验证仓库中已观测到的 CI Job：${item.title}。`,
      rationale: "该检查出现在仓库真实 CI 运行记录中；具体命令仍以仓库配置为准。",
      evidenceIds: [item.id],
    }));
  const reviewRules = evidence
    .filter((item) => item.kind === "comment" && (item.content?.trim().length ?? 0) >= 20)
    .slice(0, 6)
    .map((item) => ({
      title: `Review 约束：${short(item.content ?? "", 42)}`,
      rule: `修改 ${String(item.payload.path ?? "相关代码")} 时，检查并处理该 Review 建议：${short(item.content ?? "", 180)}`,
      rationale: "规则直接来自历史 Review 评论，发布前应结合当前代码再次核验。",
      evidenceIds: [item.id],
    }));
  return unique([...ciJobs, ...reviewRules], (item) => item.title).slice(0, 12);
}

function deterministicPitfalls(evidence: EvidenceNode[]): PitfallGuide[] {
  return evidence
    .filter((item) => (item.kind === "ci_job" || item.kind === "ci_run") && isFailure(item.state))
    .slice(0, 8)
    .map((item) => ({
      title: `${item.title ?? "CI"} 历史失败`,
      symptom: `CI 状态为 ${item.state ?? "failed"}。`,
      trigger: item.title ?? "执行仓库 CI 流程",
      rootCause: "现有结构化证据只证明失败发生，未提供足够信息确认根因。",
      fix: "打开来源记录查看失败步骤和日志，再针对当前 commit 修复；不得仅凭该条记录猜测。",
      verification: `重新执行 ${item.title ?? "对应 CI"} 并确认结论为 success。`,
      evidenceIds: [item.id],
    }));
}

function deterministicSkills(modules: ModuleEvidenceBundle[]): SkillGuidance[] {
  return modules
    .filter((module) => module.evidence.length > 0)
    .slice(0, 12)
    .map((module) => {
      const name = `${slug(module.repository?.repoFullName.split("/").pop() ?? "repository")}-${slug(module.module.name)}-change`;
      const ci = module.evidence.filter((item) => item.kind === "ci_job" && item.title).slice(0, 3);
      return {
        name,
        description: `在修改 ${module.module.name} 模块时，使用代码图谱和历史工程证据控制影响范围并完成验证。`,
        trigger: `用户修改 ${module.module.path ?? module.module.name} 或询问该模块的开发流程时。`,
        steps: [
          `确认目标版本与模块路径：${module.module.path ?? "以图谱节点为准"}。`,
          "阅读模块职责、入边、出边和直接关联的 Review/Commit 证据。",
          "仅根据当前源码与证据制定改动，无法证实的结论明确标注推断。",
          "完成改动后检查一层调用方和被调用方，避免破坏跨模块契约。",
        ],
        validation: ci.length > 0
          ? ci.map((item) => `确认 CI Job ${item.title} 通过。`)
          : ["运行模块现有测试与静态检查。", "确认代码图谱中的直接依赖关系仍成立。"],
        evidenceIds: module.evidence.slice(0, 12).map((item) => item.id),
      };
    });
}

function isFailure(state: string | undefined): boolean {
  return ["failure", "failed", "cancelled", "timed_out", "action_required"].includes(state ?? "");
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["result", "answer", "response", "text", "content", "message", "output"]) {
    const found = extractText((value as Record<string, unknown>)[key]);
    if (found) return found;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = extractText(nested);
    if (found) return found;
  }
  return undefined;
}

function stripFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function validEvidence(value: unknown, known: Set<string>): string[] {
  return stringArray(value).filter((item) => known.has(item)).slice(0, 20);
}

function stringArray(value: unknown): string[] {
  return array(value).map(string).filter((item): item is string => Boolean(item));
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function short(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
