"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runCodex } = require("./codex-agent");

const root = path.resolve(__dirname, "../../..");
const skillPath = path.join(root, "skills", "module-documentation", "SKILL.md");
const schemaPath = path.resolve(
  __dirname,
  "../schemas/module-document.schema.json",
);

function compactContext(context) {
  const relation = (item, direction) => ({
    direction,
    type: item.type,
    label: item.label,
    source: item.source,
    target: item.target,
    evidence: (item.evidence || []).slice(0, 4),
  });
  return {
    entity: {
      id: context.entity.id,
      name: context.entity.name,
      kind: context.entity.kind,
      summary: context.entity.summary,
      path: context.entity.path,
      language: context.entity.language,
      metadata: context.entity.metadata,
      evidence: (context.entity.evidence || []).slice(0, 16),
    },
    members: (context.members || []).map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      summary: item.summary,
      evidence: (item.evidence || []).slice(0, 4),
    })),
    relations: [
      ...context.incoming.map((item) => relation(item, "incoming")),
      ...context.outgoing.map((item) => relation(item, "outgoing")),
      ...(context.internal || []).map((item) => relation(item, "internal")),
    ].slice(0, 40),
    annotations: context.annotations,
    documents: context.documents,
  };
}

function parseResult(result) {
  const parsed = JSON.parse(result.content);
  return {
    action: parsed.action,
    title: String(parsed.title || "").trim(),
    summary: String(parsed.summary || "").trim(),
    reason: String(parsed.reason || "").trim(),
    markdown: String(parsed.markdown || "").trim(),
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
  };
}

async function generateModuleDocument({ repoPath, project, context }) {
  const skill = fs.readFileSync(skillPath, "utf8");
  const prompt = [
    "为选中的代码模块生成一篇可直接发布的工程文档。",
    "必须先按下面 Skill 工作，并核对必要源码；禁止修改仓库。",
    "严格返回 JSON Schema，不要输出 Markdown 代码围栏。",
    "action 必须为 create。markdown 字段放完整文档。",
    "",
    skill,
    "",
    `项目：${project.name}`,
    `模块上下文：${JSON.stringify(compactContext(context))}`,
  ].join("\n");
  return parseResult(
    await runCodex({
      repoPath,
      prompt,
      schemaPath,
      reasoningEffort: "medium",
      timeoutMs: 180000,
    }),
  );
}

async function updateModuleDocument({
  repoPath,
  project,
  context,
  document,
  currentMarkdown,
  before,
  after,
  changedFiles,
}) {
  const skill = fs.readFileSync(skillPath, "utf8");
  const prompt = [
    "根据一次本地 Git Commit 更新现有代码文档。",
    "必须先按下面 Skill 工作，并核对 diff 与必要源码；禁止修改仓库。",
    "只修正受到本次 Commit 影响的内容。若文档事实未变化，action 返回 no_change。",
    "严格返回 JSON Schema，不要输出 Markdown 代码围栏。",
    "",
    skill,
    "",
    `项目：${project.name}`,
    `Commit：${before}..${after}`,
    `变化文件：${JSON.stringify(changedFiles)}`,
    `模块上下文：${JSON.stringify(compactContext(context))}`,
    `文档元信息：${JSON.stringify(document)}`,
    `现有文档：\n${currentMarkdown}`,
  ].join("\n");
  return parseResult(
    await runCodex({
      repoPath,
      prompt,
      schemaPath,
      reasoningEffort: "medium",
      timeoutMs: 180000,
    }),
  );
}

async function refreshModuleDocument({
  repoPath,
  project,
  context,
  document,
  currentMarkdown,
}) {
  const skill = fs.readFileSync(skillPath, "utf8");
  const prompt = [
    "根据当前代码完整校准选中模块已经挂载的工程文档。",
    "这是用户主动触发的模块文档刷新，不依赖 Git diff。",
    "必须先按下面 Skill 工作，并核对模块源码、直接入口和依赖边界；禁止修改仓库。",
    "保留仍然准确的人工内容，只修正过时事实并补充重要缺失信息。",
    "文档已经准确时 action 返回 no_change；需要写入时 action 返回 update。",
    "严格返回 JSON Schema，不要输出 Markdown 代码围栏。",
    "",
    skill,
    "",
    `项目：${project.name}`,
    `模块上下文：${JSON.stringify(compactContext(context))}`,
    `文档元信息：${JSON.stringify(document)}`,
    `现有文档：\n${currentMarkdown}`,
  ].join("\n");
  return parseResult(
    await runCodex({
      repoPath,
      prompt,
      schemaPath,
      reasoningEffort: "medium",
      timeoutMs: 180000,
    }),
  );
}

module.exports = {
  generateModuleDocument,
  refreshModuleDocument,
  updateModuleDocument,
};
