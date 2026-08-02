"use strict";

const path = require("node:path");
const {
  projectDocumentOwnerId,
} = require("./store");
const { changedFiles: readChangedFiles } = require("./git-repository");
const {
  generateModuleDocument,
  refreshModuleDocument,
  updateModuleDocument,
} = require("./module-document-agent");

function normalized(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function evidenceFiles(entity) {
  const direct = (entity.evidence || []).map((item) => item.file);
  const members = Array.isArray(entity.metadata?.members)
    ? entity.metadata.members.map((item) => item?.filePath)
    : [];
  return [...new Set([...direct, ...members].map(normalized).filter(Boolean))];
}

function impactedEntityIds(graph, files) {
  const changed = new Set(files.map((item) => normalized(item.file)));
  const direct = new Set();
  for (const entity of graph.entities) {
    const entityPath = normalized(entity.path);
    const matchesEvidence = evidenceFiles(entity).some((file) => changed.has(file));
    const matchesPath =
      entityPath &&
      [...changed].some(
        (file) => file === entityPath || file.startsWith(`${entityPath}/`),
      );
    if (matchesEvidence || matchesPath) direct.add(entity.id);
  }
  const affected = new Set(direct);
  for (const relation of graph.relations) {
    if (direct.has(relation.source)) affected.add(relation.target);
    if (direct.has(relation.target)) affected.add(relation.source);
  }
  return { direct, affected };
}

function domainDocumentAffected(entityId, graph, affected, files) {
  if (!entityId.startsWith("visual-domain:")) return false;
  const slug = entityId.split(":")[1]?.toLowerCase() || "";
  if (!slug) return false;
  const changedPaths = files.map((item) => normalized(item.file).toLowerCase());
  if (changedPaths.some((file) => file.split("/").includes(slug))) return true;
  return graph.entities
    .filter((entity) => affected.has(entity.id))
    .some((entity) => {
      const values = [entity.path, ...evidenceFiles(entity)]
        .map((value) => normalized(value).toLowerCase())
        .filter(Boolean);
      return values.some((value) => value.split("/").includes(slug));
    });
}

function shouldUpdateGlobalDocuments(files, directCount) {
  if (directCount > 1) return true;
  return files.some(({ file }) =>
    /(^|\/)(readme|architecture|docs?|api|config|schema|deploy|build|docker|package|go\.mod|pom\.xml)/i.test(
      normalized(file),
    ),
  );
}

class DocumentAutomationService {
  constructor(
    store,
    dingtalk,
    {
      generateDocument = generateModuleDocument,
      refreshDocument = refreshModuleDocument,
      updateDocument = updateModuleDocument,
      readChangedFilesImpl = readChangedFiles,
    } = {},
  ) {
    this.store = store;
    this.dingtalk = dingtalk;
    this.generateDocument = generateDocument;
    this.refreshDocument = refreshDocument;
    this.updateDocument = updateDocument;
    this.readChangedFiles = readChangedFilesImpl;
  }

  async createAndBind({ projectId, entityId, scope, onProgress }) {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("Project was not found.");
    const context = scope
      ? this.store.scopeContext(projectId, { ...scope, id: entityId })
      : this.store.entityContext(projectId, entityId);
    if (!context) throw new Error("Analysis target was not found.");

    onProgress?.({
      phase: "context",
      label: "正在检查模块上下文与钉钉连接",
      detail: context.entity.name,
      current: 1,
      total: 4,
    });
    await this.dingtalk.assertAuthenticated();

    onProgress?.({
      phase: "analysis",
      label: "Agent 正在核对源码并生成代码文档",
      detail: "职责、入口、依赖、流程与源码证据",
      current: 2,
      total: 4,
    });
    const generated = await this.generateDocument({
      repoPath: path.resolve(project.repoPath),
      project,
      context,
    });
    if (!generated.markdown || generated.action !== "create") {
      throw new Error("Agent 没有生成可发布的模块文档。");
    }

    onProgress?.({
      phase: "publish",
      label: "正在创建钉钉文档",
      detail: generated.title,
      current: 3,
      total: 4,
    });
    const remote = await this.dingtalk.create({
      name: generated.title,
      content: generated.markdown,
    });

    onProgress?.({
      phase: "bind",
      label: "正在把文档挂载到代码模块",
      detail: context.entity.name,
      current: 4,
      total: 4,
    });
    const document = this.store.addDocument(projectId, entityId, {
      provider: "dingtalk",
      externalId: remote.nodeId,
      title: generated.title,
      url: remote.url,
      summary: generated.summary,
    });
    return {
      document: this.store.updateDocumentSync(document.id, {
        syncStatus: "synced",
      }),
      title: generated.title,
      summary: generated.summary,
      provider: "dingtalk",
    };
  }

  async refreshBoundDocuments({ projectId, entityId, scope, onProgress }) {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("Project was not found.");
    const context = scope
      ? this.store.scopeContext(projectId, { ...scope, id: entityId })
      : this.store.entityContext(projectId, entityId);
    if (!context) throw new Error("Analysis target was not found.");

    const candidates = context.documents.filter(
      (document) => document.provider === "dingtalk",
    );
    if (candidates.length === 0) {
      throw new Error("当前模块没有可更新的钉钉关联文档。");
    }

    const total = 1 + candidates.length * 3;
    onProgress?.({
      phase: "context",
      label: "正在建立模块与文档上下文",
      detail: `${context.entity.name} · ${candidates.length} 篇关联文档`,
      current: 1,
      total,
    });
    await this.dingtalk.assertAuthenticated();

    const refreshed = [];
    const failures = [];
    let updatedDocuments = 0;
    let unchangedDocuments = 0;
    for (const [index, document] of candidates.entries()) {
      const offset = 2 + index * 3;
      this.store.updateDocumentSync(document.id, { syncStatus: "stale" });
      try {
        onProgress?.({
          phase: "read",
          label: "正在读取现有钉钉文档",
          detail: document.title,
          current: offset,
          total,
        });
        const currentMarkdown = await this.dingtalk.read(document.url);

        onProgress?.({
          phase: "analysis",
          label: "Agent 正在核对模块源码",
          detail: document.title,
          current: offset + 1,
          total,
        });
        const generated = await this.refreshDocument({
          repoPath: path.resolve(project.repoPath),
          project,
          context,
          document,
          currentMarkdown,
        });
        if (!["update", "no_change"].includes(generated.action)) {
          throw new Error("Agent 返回了无效的文档刷新动作。");
        }
        if (generated.action === "update" && !generated.markdown) {
          throw new Error("Agent 没有返回可写入的文档内容。");
        }

        onProgress?.({
          phase: "publish",
          label:
            generated.action === "update"
              ? "正在写回关联文档"
              : "文档已经与源码一致",
          detail: document.title,
          current: offset + 2,
          total,
        });
        if (generated.action === "update") {
          await this.dingtalk.overwrite(document.url, generated.markdown);
          updatedDocuments += 1;
        } else {
          unchangedDocuments += 1;
        }
        refreshed.push(
          this.store.updateDocumentSync(document.id, {
            title: generated.title || document.title,
            summary: generated.summary || document.summary,
            syncStatus: "synced",
          }),
        );
      } catch (error) {
        this.store.updateDocumentSync(document.id, { syncStatus: "error" });
        failures.push(`${document.title}: ${error.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`部分关联文档更新失败：${failures.join("；")}`);
    }
    return {
      documents: refreshed,
      checkedDocuments: candidates.length,
      updatedDocuments,
      unchangedDocuments,
    };
  }

  contextForDocument(projectId, document, graph, affected) {
    if (document.entityId === projectDocumentOwnerId(projectId)) {
      return this.store.scopeContext(projectId, {
        id: document.entityId,
        name: "项目全局架构",
        path: ".",
        entityIds: [...affected],
      });
    }
    if (document.entityId.startsWith("visual-domain:")) {
      const slug = document.entityId.split(":")[1]?.toLowerCase() || "";
      const memberIds = graph.entities
        .filter((entity) =>
          [entity.path, ...evidenceFiles(entity)]
            .map((value) => normalized(value).toLowerCase())
            .some((value) => value.split("/").includes(slug)),
        )
        .map((entity) => entity.id);
      return this.store.scopeContext(projectId, {
        id: document.entityId,
        name: slug || "代码领域",
        path: slug,
        entityIds: memberIds,
      });
    }
    return this.store.entityContext(projectId, document.entityId);
  }

  async syncLocalCommit({ project, before, after }) {
    const files = await this.readChangedFiles(project.repoPath, before, after);
    if (files.length === 0) {
      return { changedFiles: 0, candidateDocuments: 0, updatedDocuments: 0 };
    }
    const graph = this.store.getGraph(project.id);
    const { direct, affected } = impactedEntityIds(graph, files);
    const includeGlobal = shouldUpdateGlobalDocuments(files, direct.size);
    const owner = projectDocumentOwnerId(project.id);
    const candidates = this.store
      .listProjectDocuments(project.id)
      .filter((document) => document.provider === "dingtalk")
      .filter(
        (document) =>
          affected.has(document.entityId) ||
          domainDocumentAffected(document.entityId, graph, affected, files) ||
          (includeGlobal && document.entityId === owner),
      );
    if (candidates.length === 0) {
      return {
        changedFiles: files.length,
        candidateDocuments: 0,
        updatedDocuments: 0,
      };
    }

    await this.dingtalk.assertAuthenticated();
    let updatedDocuments = 0;
    const failures = [];
    for (const document of candidates) {
      const context = this.contextForDocument(project.id, document, graph, affected);
      if (!context) continue;
      this.store.updateDocumentSync(document.id, { syncStatus: "stale" });
      try {
        const currentMarkdown = await this.dingtalk.read(document.url);
        const generated = await this.updateDocument({
          repoPath: path.resolve(project.repoPath),
          project,
          context,
          document,
          currentMarkdown,
          before,
          after,
          changedFiles: files,
        });
        if (generated.action !== "no_change") {
          await this.dingtalk.overwrite(document.url, generated.markdown);
          updatedDocuments += 1;
        }
        this.store.updateDocumentSync(document.id, {
          title: generated.title || document.title,
          summary: generated.summary || document.summary,
          syncStatus: "synced",
        });
      } catch (error) {
        this.store.updateDocumentSync(document.id, { syncStatus: "error" });
        failures.push(`${document.title}: ${error.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`部分文档同步失败：${failures.join("；")}`);
    }
    return {
      changedFiles: files.length,
      candidateDocuments: candidates.length,
      updatedDocuments,
    };
  }
}

module.exports = {
  DocumentAutomationService,
  impactedEntityIds,
  shouldUpdateGlobalDocuments,
};
