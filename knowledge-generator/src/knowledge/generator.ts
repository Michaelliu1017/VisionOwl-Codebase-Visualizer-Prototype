import { createHash } from "node:crypto";
import type { EvidenceNode } from "../domain/types.js";
import type {
  GeneratedKnowledgeAsset,
  KnowledgeContext,
  KnowledgeFile,
  ModuleEvidenceBundle,
} from "./types.js";

export function generateKnowledgeAssets(
  context: KnowledgeContext,
  requested: Array<"wiki" | "skills">,
): GeneratedKnowledgeAsset[] {
  return requested.map((kind) => kind === "wiki" ? generateWiki(context) : generateSkills(context));
}

function generateWiki(context: KnowledgeContext): GeneratedKnowledgeAsset {
  const moduleFiles = context.modules.map((module) => markdownFile(
    `module-${shortHash(module.module.id)}`,
    module.module.name,
    `modules/${moduleSlug(module)}-${shortHash(module.module.id)}.md`,
    modulePage(module),
  ));
  const files: KnowledgeFile[] = [
    markdownFile("wiki-readme", "工程知识 Wiki", "README.md", wikiReadme(context, moduleFiles)),
    markdownFile("architecture-overview", "架构总览", "architecture/overview.md", architectureOverview(context)),
    markdownFile("development-standards", "开发规范", "engineering/development-standards.md", standardsPage(context)),
    markdownFile("pitfall-guide", "踩坑指南", "engineering/pitfalls.md", pitfallsPage(context)),
    markdownFile("ci-review", "CI 与 Review 证据", "engineering/ci-and-review.md", ciReviewPage(context)),
    ...moduleFiles,
    jsonFile("traceability", "证据追溯索引", "evidence/traceability.json", traceability(context)),
  ];
  return {
    kind: "wiki",
    title: "VisionOwl 工程知识 Wiki",
    files,
    summary: {
      modules: context.modules.length,
      repositories: context.repositories.length,
      evidence: uniqueEvidence(context).length,
      linkedEvidence: context.linked.stats.linkedEvidence,
      unresolvedEvidence: context.linked.stats.unresolvedEvidence,
      standards: context.semantic.standards.length,
      pitfalls: context.semantic.pitfalls.length,
      semanticProvider: context.semantic.provider,
    },
  };
}

function generateSkills(context: KnowledgeContext): GeneratedKnowledgeAsset {
  const skills = context.semantic.skills;
  const skillFiles = skills.map((skill) => markdownFile(
    `skill-${shortHash(skill.name)}`,
    skill.name,
    `skills/${skill.name}/SKILL.md`,
    skillPage(skill, context),
  ));
  const files: KnowledgeFile[] = [
    markdownFile("skills-readme", "候选 Skills", "README.md", skillsReadme(context, skillFiles)),
    ...skillFiles,
    jsonFile("skills-traceability", "Skill 证据追溯索引", "evidence/traceability.json", traceability(context)),
    jsonFile(
      "skill-evaluation-dataset",
      "Skill 历史评测集",
      "evaluation/dataset.json",
      skillEvaluationDataset(context),
    ),
  ];
  return {
    kind: "skills",
    title: "VisionOwl 候选 Skills",
    files,
    summary: {
      skills: skills.length,
      repositories: context.repositories.length,
      evidence: uniqueEvidence(context).length,
      semanticProvider: context.semantic.provider,
      warnings: context.semantic.warnings,
    },
  };
}

interface HistoricalEvaluationTask {
  id: string;
  requirement: string;
  baseSha: string;
  requiredRules: string[];
  criticalRules: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  metadata: Record<string, unknown>;
}

/**
 * 把已合并 PR/历史 commit 转成可复放的评测任务。Skill Lab 会在 baseSha
 * 上执行 Agent，并用 headSha 中的真实改动做宿主侧隐藏验收，避免把答案暴露给 Agent。
 */
function skillEvaluationDataset(context: KnowledgeContext): unknown {
  const tasks = context.repositories.flatMap(({ repository, snapshot }) => {
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const pullTasks = snapshot.nodes
      .filter((node) => node.kind === "change_request" && node.state === "merged")
      .map((node) => historicalPullTask(node, repository, snapshot.nodes, snapshot.edges, byId))
      .filter((task): task is HistoricalEvaluationTask => task !== null);
    const pullHeads = new Set(pullTasks.map((task) => String(task.metadata.headSha ?? "")));
    const commitTasks = snapshot.nodes
      .filter((node) => node.kind === "commit" && node.commitSha && !pullHeads.has(node.commitSha))
      .map((node) => historicalCommitTask(node, repository, snapshot.nodes))
      .filter((task): task is HistoricalEvaluationTask => task !== null);
    return [...pullTasks, ...commitTasks];
  });

  const ordered = tasks
    .sort((left, right) => String(right.metadata.occurredAt).localeCompare(String(left.metadata.occurredAt)))
    .slice(0, 8);
  const validationCount = ordered.length > 1 ? Math.max(1, Math.floor(ordered.length / 3)) : 0;
  const validationTasks = validationCount > 0 ? ordered.slice(0, validationCount) : [];
  const developmentTasks = validationCount > 0 ? ordered.slice(validationCount) : ordered;

  return {
    schemaVersion: "evaluation-dataset.v1",
    id: `project-history-${shortHash(`${context.graph.projectId}:${context.graph.commitSha}`)}`,
    version: "1.0.0",
    generatedAt: context.linked.generatedAt,
    sourceGraphCommitSha: context.graph.commitSha,
    developmentTasks,
    validationTasks,
    usable: developmentTasks.length > 0 && validationTasks.length > 0,
    warnings: developmentTasks.length > 0 && validationTasks.length > 0
      ? []
      : ["至少需要两条带 base/head SHA 与文件变更的历史记录，才能形成隔离的开发集和验证集。"],
  };
}

function historicalPullTask(
  pull: EvidenceNode,
  repository: KnowledgeContext["repositories"][number]["repository"],
  nodes: EvidenceNode[],
  edges: KnowledgeContext["repositories"][number]["snapshot"]["edges"],
  byId: Map<string, EvidenceNode>,
): HistoricalEvaluationTask | null {
  const baseSha = stringPayload(pull, "baseSha");
  const headSha = stringPayload(pull, "headSha") ?? pull.commitSha;
  if (!baseSha || !headSha) return null;
  const number = stringPayload(pull, "number") ?? pull.externalId;
  const changes = fileChanges(nodes, "pr", number);
  if (changes.length === 0) return null;
  const relatedIds = edges
    .filter((edge) => edge.fromId === pull.id && ["PR_HAS_REVIEW", "PR_HAS_COMMENT"].includes(edge.relationType))
    .map((edge) => edge.toId);
  const reviewRules = relatedIds
    .map((id) => byId.get(id)?.content?.replace(/\s+/g, " ").trim())
    .filter((value): value is string => Boolean(value))
    .slice(0, 3)
    .map((value) => value.slice(0, 240));
  return historicalTask({
    id: `github-pr-${slug(repository.repoFullName)}-${number}`,
    requirement: [pull.title, pull.content].filter(Boolean).join("\n\n"),
    baseSha,
    headSha,
    repository,
    sourceUrl: pull.sourceUrl,
    occurredAt: pull.occurredAt,
    evidenceIds: [pull.id, ...relatedIds],
    changes,
    reviewRules,
  });
}

function historicalCommitTask(
  commit: EvidenceNode,
  repository: KnowledgeContext["repositories"][number]["repository"],
  nodes: EvidenceNode[],
): HistoricalEvaluationTask | null {
  const headSha = commit.commitSha;
  const parents = Array.isArray(commit.payload.parents) ? commit.payload.parents : [];
  const baseSha = parents.find((item): item is string => typeof item === "string");
  if (!headSha || !baseSha) return null;
  const changes = fileChanges(nodes, "commit", headSha);
  if (changes.length === 0) return null;
  return historicalTask({
    id: `github-commit-${slug(repository.repoFullName)}-${headSha.slice(0, 12)}`,
    requirement: [commit.title, commit.content].filter(Boolean).join("\n\n"),
    baseSha,
    headSha,
    repository,
    sourceUrl: commit.sourceUrl,
    occurredAt: commit.occurredAt,
    evidenceIds: [commit.id],
    changes,
    reviewRules: [],
  });
}

function historicalTask(input: {
  id: string;
  requirement: string;
  baseSha: string;
  headSha: string;
  repository: KnowledgeContext["repositories"][number]["repository"];
  sourceUrl: string;
  occurredAt: string;
  evidenceIds: string[];
  changes: Array<{ path: string; status: string; previousPath: string | null }>;
  reviewRules: string[];
}): HistoricalEvaluationTask {
  const goldenRule = "实现结果必须覆盖历史变更涉及的文件，并通过与真实 head commit 对照的隐藏验收";
  return {
    id: input.id,
    requirement: input.requirement.trim() || `复现历史变更 ${input.headSha.slice(0, 12)}`,
    baseSha: input.baseSha,
    requiredRules: [goldenRule, ...input.reviewRules],
    criticalRules: [goldenRule],
    allowedPaths: [...new Set(input.changes.flatMap((change) => [change.path, change.previousPath].filter((value): value is string => Boolean(value))))],
    forbiddenPaths: [".git"],
    metadata: {
      provider: "github",
      bindingId: input.repository.bindingId,
      repositoryKey: input.repository.repositoryKey,
      repoFullName: input.repository.repoFullName,
      branch: input.repository.branch,
      headSha: input.headSha,
      sourceUrl: input.sourceUrl,
      occurredAt: input.occurredAt,
      evidenceIds: input.evidenceIds,
      expectedChanges: input.changes,
      runner: { checks: [], hiddenFiles: [] },
    },
  };
}

function fileChanges(
  nodes: EvidenceNode[],
  scope: "pr" | "commit",
  scopeId: string,
): Array<{ path: string; status: string; previousPath: string | null }> {
  return nodes
    .filter((node) => node.kind === "file_change"
      && node.payload.scope === scope
      && String(node.payload.scopeId) === scopeId
      && typeof node.payload.path === "string")
    .map((node) => ({
      path: String(node.payload.path),
      status: node.state ?? "modified",
      previousPath: typeof node.payload.previousPath === "string" ? node.payload.previousPath : null,
    }));
}

function stringPayload(node: EvidenceNode, key: string): string | null {
  const value = node.payload[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function wikiReadme(context: KnowledgeContext, moduleFiles: KnowledgeFile[]): string {
  return lines(
    "# 工程知识 Wiki",
    "",
    "> 本文档由 VisionOwl Knowledge Generator 基于冻结的代码图谱和 GitHub 工程证据生成。结论绑定具体 commit，不代表当前远端分支的实时状态。",
    "",
    "## 版本范围",
    "",
    ...context.repositories.map(({ repository }) => `- \`${repository.repoFullName}@${repository.commitSha}\`（分支 \`${repository.branch}\`）`),
    "",
    "## 概览",
    "",
    context.semantic.overview ?? "未生成语义概览。",
    "",
    `- 代码模块：${context.modules.length}`,
    `- 代码关系：${context.graph.edges.length}`,
    `- 工程证据：${uniqueEvidence(context).length}`,
    `- 已关联证据：${context.linked.stats.linkedEvidence}`,
    `- 未关联证据：${context.linked.stats.unresolvedEvidence}`,
    "",
    "## 导航",
    "",
    "- [架构总览](architecture/overview.md)",
    "- [开发规范](engineering/development-standards.md)",
    "- [踩坑指南](engineering/pitfalls.md)",
    "- [CI 与 Review 证据](engineering/ci-and-review.md)",
    ...moduleFiles.map((file) => `- [${file.title}](${file.path})`),
    "",
    warnings(context.semantic.warnings),
  );
}

function architectureOverview(context: KnowledgeContext): string {
  const primary = context.modules.filter((item) => item.module.architecture?.importance === "primary");
  const displayed = primary.length > 0 ? primary : context.modules;
  return lines(
    "# 架构总览",
    "",
    context.semantic.overview ?? "架构由冻结代码图谱中的节点和关系构成。",
    "",
    "## 主要模块",
    "",
    ...displayed.flatMap((item) => [
      `### ${escapeMarkdown(item.module.name)}`,
      "",
      item.module.summary ?? "图谱未提供模块摘要。",
      "",
      `- 类型：\`${item.module.kind}\``,
      `- 路径：${code(item.module.path ?? "未提供")}`,
      `- 仓库：${code(item.repository?.repoFullName ?? "未确定")}`,
      `- 入向关系：${item.incoming.length}`,
      `- 出向关系：${item.outgoing.length}`,
      `- 工程证据：${item.evidence.length}`,
      "",
    ]),
    "## 跨模块关系",
    "",
    ...context.graph.edges.map((edge) => {
      const source = context.graph.nodes.find((item) => item.id === edge.source)?.name ?? edge.source;
      const target = context.graph.nodes.find((item) => item.id === edge.target)?.name ?? edge.target;
      return `- ${escapeMarkdown(source)} → ${escapeMarkdown(target)}：\`${edge.label ?? edge.type}\``;
    }),
  );
}

function modulePage(bundle: ModuleEvidenceBundle): string {
  const evidence = bundle.evidence.slice(0, 80);
  return lines(
    `# ${escapeMarkdown(bundle.module.name)}`,
    "",
    bundle.module.summary ?? "代码图谱未提供模块摘要。",
    "",
    "## 模块边界",
    "",
    `- 类型：\`${bundle.module.kind}\``,
    `- 路径：${code(bundle.module.path ?? "未提供")}`,
    `- 仓库：${code(bundle.repository?.repoFullName ?? "未确定")}`,
    `- 冻结版本：${code(bundle.repository?.commitSha ?? "未确定")}`,
    "",
    "## 调用与依赖",
    "",
    "### 入向",
    "",
    ...(bundle.incoming.length > 0
      ? bundle.incoming.map((item) => `- ${escapeMarkdown(item.source)} → 本模块：\`${item.label ?? item.type}\``)
      : ["- 无图谱入向关系。"]),
    "",
    "### 出向",
    "",
    ...(bundle.outgoing.length > 0
      ? bundle.outgoing.map((item) => `- 本模块 → ${escapeMarkdown(item.target)}：\`${item.label ?? item.type}\``)
      : ["- 无图谱出向关系。"]),
    "",
    "## 关联工程证据",
    "",
    ...(evidence.length > 0 ? evidence.map(evidenceLine) : ["- 当前采集范围内没有可精确关联的工程证据。"]),
    "",
    "## 追溯说明",
    "",
    ...bundle.links.slice(0, 80).map((link) => `- \`${link.evidenceId}\`：${link.confidence}，${link.basis}`),
  );
}

function standardsPage(context: KnowledgeContext): string {
  return lines(
    "# 开发规范",
    "",
    "> 规范候选项来自历史 CI、Review 与代码图谱。采用前应由团队确认；每条均保留证据引用。",
    "",
    ...(context.semantic.standards.length > 0
      ? context.semantic.standards.flatMap((item, index) => [
        `## ${index + 1}. ${escapeMarkdown(item.title)}`,
        "",
        `**要求：** ${item.rule}`,
        "",
        `**原因：** ${item.rationale}`,
        "",
        evidenceReferences(item.evidenceIds, context),
        "",
      ])
      : ["当前证据不足，未生成开发规范候选项。"]),
  );
}

function pitfallsPage(context: KnowledgeContext): string {
  return lines(
    "# 踩坑指南",
    "",
    "> 只有得到证据支持的历史问题才进入本页；未知根因会明确标注，不进行猜测。",
    "",
    ...(context.semantic.pitfalls.length > 0
      ? context.semantic.pitfalls.flatMap((item, index) => [
        `## ${index + 1}. ${escapeMarkdown(item.title)}`,
        "",
        `- 症状：${item.symptom}`,
        `- 触发条件：${item.trigger}`,
        `- 根因：${item.rootCause}`,
        `- 修复：${item.fix}`,
        `- 验证：${item.verification}`,
        `- 证据：${evidenceReferences(item.evidenceIds, context)}`,
        "",
      ])
      : ["当前证据不足，未生成可确认的踩坑指南。"]),
  );
}

function ciReviewPage(context: KnowledgeContext): string {
  const evidence = uniqueEvidence(context)
    .filter((item) => ["ci_run", "ci_job", "review", "comment", "change_request"].includes(item.kind))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  return lines(
    "# CI 与 Review 证据",
    "",
    `共 ${evidence.length} 条可追溯记录。`,
    "",
    ...evidence.slice(0, 400).map(evidenceLine),
  );
}

function skillsReadme(context: KnowledgeContext, files: KnowledgeFile[]): string {
  return lines(
    "# 候选 Skills",
    "",
    "> 这些 Skill 是基于冻结图谱与工程证据生成的候选版本。发布前还应由 Skill Lab 评估、优化和验证。",
    "",
    `- 语义提供方：\`${context.semantic.provider}\``,
    `- Skill 数量：${files.length}`,
    `- 证据数量：${uniqueEvidence(context).length}`,
    "",
    "## 目录",
    "",
    ...(files.length > 0
      ? files.map((file) => `- [${file.title}](${file.path})`)
      : ["- 当前证据不足，未生成 Skill 候选项。"]),
    "",
    warnings(context.semantic.warnings),
  );
}

function skillPage(skill: KnowledgeContext["semantic"]["skills"][number], context: KnowledgeContext): string {
  return lines(
    "---",
    `name: ${skill.name}`,
    `description: ${yamlString(skill.description)}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    skill.description,
    "",
    "## Trigger",
    "",
    skill.trigger,
    "",
    "## Workflow",
    "",
    ...skill.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Validation",
    "",
    ...skill.validation.map((step) => `- ${step}`),
    "",
    "## Evidence",
    "",
    ...skill.evidenceIds.map((id) => `- ${evidenceReference(id, context)}`),
  );
}

function traceability(context: KnowledgeContext): unknown {
  return {
    schemaVersion: "knowledge-traceability.v1",
    projectId: context.graph.projectId,
    graphCommitSha: context.graph.commitSha,
    repositoryCommits: Object.fromEntries(context.repositories.map(({ repository }) => [
      repository.repositoryKey,
      repository.commitSha,
    ])),
    generatedAt: context.linked.generatedAt,
    semanticProvider: context.semantic.provider,
    warnings: context.semantic.warnings,
    links: context.linked.links,
    unresolved: context.linked.unresolved,
    evidence: uniqueEvidence(context).map((item) => ({
      id: item.id,
      kind: item.kind,
      state: item.state ?? null,
      title: item.title ?? null,
      commitSha: item.commitSha ?? null,
      occurredAt: item.occurredAt,
      sourceUrl: item.sourceUrl,
      repositoryId: item.repositoryId,
    })),
  };
}

function uniqueEvidence(context: KnowledgeContext): EvidenceNode[] {
  return [...new Map(context.repositories
    .flatMap((item) => item.snapshot.nodes)
    .map((item) => [item.id, item])).values()];
}

function evidenceReferences(ids: string[], context: KnowledgeContext): string {
  return ids.map((id) => evidenceReference(id, context)).join("；") || "无";
}

function evidenceReference(id: string, context: KnowledgeContext): string {
  const item = uniqueEvidence(context).find((candidate) => candidate.id === id);
  if (!item) return `\`${id}\`（未找到）`;
  return `[${escapeMarkdown(item.title ?? `${item.kind}:${item.externalId}`)}](${item.sourceUrl}) \`${id}\``;
}

function evidenceLine(item: EvidenceNode): string {
  const title = item.title ?? `${item.kind}:${item.externalId}`;
  const state = item.state ? `，状态 \`${item.state}\`` : "";
  const path = typeof item.payload.path === "string" ? `，路径 ${code(item.payload.path)}` : "";
  return `- [${escapeMarkdown(title)}](${item.sourceUrl})（${item.kind}${state}${path}，${item.occurredAt}）\`${item.id}\``;
}

function markdownFile(id: string, title: string, path: string, content: string): KnowledgeFile {
  return { id, title, path, mediaType: "text/markdown; charset=utf-8", content: Buffer.from(content, "utf8") };
}

function jsonFile(id: string, title: string, path: string, value: unknown): KnowledgeFile {
  return {
    id,
    title,
    path,
    mediaType: "application/json; charset=utf-8",
    content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  };
}

function moduleSlug(module: ModuleEvidenceBundle): string {
  return slug(`${module.repository?.repoFullName.split("/").pop() ?? "repo"}-${module.module.name}`);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "module";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+.!|>-])/g, "\\$1");
}

function warnings(items: string[]): string {
  if (items.length === 0) return "";
  return lines("## 生成警告", "", ...items.map((item) => `- ${item}`));
}

function lines(...values: string[]): string {
  return `${values.filter((value, index) => value !== "" || values[index - 1] !== "").join("\n").trim()}\n`;
}
