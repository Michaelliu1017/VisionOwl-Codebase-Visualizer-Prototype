"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");

function isoNow() {
  return new Date().toISOString();
}

function json(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function projectDocumentOwnerId(projectId) {
  return `project-documents:${projectId}`;
}

function documentFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    entityId: row.entity_id,
    provider: row.provider,
    externalId: row.external_id || undefined,
    title: row.title,
    url: row.url,
    summary: row.summary,
    syncStatus: row.sync_status,
    updatedAt: row.updated_at,
  };
}

class VisionStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        cloud_project_id TEXT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        repo_path TEXT NOT NULL,
        branch TEXT,
        commit_hash TEXT,
        latest_graph_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS graph_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        branch TEXT,
        commit_hash TEXT,
        graph_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        progress INTEGER NOT NULL,
        message TEXT NOT NULL,
        use_codex INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS analysis_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        progress INTEGER NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        sync_status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        codex_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        provider TEXT NOT NULL,
        citations_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_automation_settings (
        project_id TEXT PRIMARY KEY,
        debug_mode INTEGER NOT NULL DEFAULT 0,
        branch TEXT,
        observed_commit TEXT,
        processed_commit TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        message TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `);

    const projectColumns = this.db
      .prepare("PRAGMA table_info(projects)")
      .all()
      .map((column) => column.name);
    if (!projectColumns.includes("cloud_project_id")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN cloud_project_id TEXT;");
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_cloud_project_id
      ON projects(cloud_project_id)
      WHERE cloud_project_id IS NOT NULL;
    `);
  }

  close() {
    this.db.close();
  }

  createProject({
    name,
    description = "",
    repoPath,
    branch,
    commit,
    cloudProjectId,
  }) {
    const id = randomUUID();
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO projects
          (id, cloud_project_id, name, description, repo_path, branch, commit_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        cloudProjectId || null,
        name,
        description,
        repoPath,
        branch || null,
        commit || null,
        now,
        now,
      );
    return this.getProject(id);
  }

  bindCloudProject(id, cloudProjectId) {
    const current = this.getProject(id);
    if (!current) return null;
    const conflict = this.db
      .prepare(
        "SELECT id FROM projects WHERE cloud_project_id = ? AND id <> ?",
      )
      .get(cloudProjectId, id);
    if (conflict) {
      throw Object.assign(
        new Error("This cloud Project is already bound to another local repository."),
        { status: 409, code: "cloud_project_already_bound" },
      );
    }
    this.db
      .prepare(
        "UPDATE projects SET cloud_project_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(cloudProjectId, isoNow(), id);
    return this.getProject(id);
  }

  listProjects() {
    const rows = this.db
      .prepare(
        `SELECT p.*,
          COALESCE(json_array_length(g.graph_json, '$.entities'), 0) AS node_count,
          COALESCE(json_array_length(g.graph_json, '$.relations'), 0) AS edge_count
         FROM projects p
         LEFT JOIN graph_versions g ON g.id = p.latest_graph_version_id
         ORDER BY p.updated_at DESC`,
      )
      .all();
    return rows.map((row) => this.projectRow(row));
  }

  getProject(id) {
    const row = this.db
      .prepare(
        `SELECT p.*,
          COALESCE(json_array_length(g.graph_json, '$.entities'), 0) AS node_count,
          COALESCE(json_array_length(g.graph_json, '$.relations'), 0) AS edge_count
         FROM projects p
         LEFT JOIN graph_versions g ON g.id = p.latest_graph_version_id
         WHERE p.id = ?`,
      )
      .get(id);
    return row ? this.projectRow(row) : null;
  }

  projectRow(row) {
    return {
      id: row.id,
      cloudProjectId: row.cloud_project_id || undefined,
      name: row.name,
      description: row.description,
      repoPath: row.repo_path,
      branch: row.branch || undefined,
      commit: row.commit_hash || undefined,
      latestGraphVersionId: row.latest_graph_version_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodeCount: Number(row.node_count || 0),
      edgeCount: Number(row.edge_count || 0),
    };
  }

  createJob(projectId, useCodex) {
    const id = randomUUID();
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO analysis_jobs
          (id, project_id, status, phase, progress, message, use_codex, created_at, updated_at)
         VALUES (?, ?, 'running', 'queued', 0, '分析任务已进入队列', ?, ?, ?)`,
      )
      .run(id, projectId, useCodex ? 1 : 0, now, now);
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE id = ?").get(id);
    return row ? this.jobRow(row) : null;
  }

  listJobs(projectId) {
    return this.db
      .prepare(
        "SELECT * FROM analysis_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20",
      )
      .all(projectId)
      .map((row) => this.jobRow(row));
  }

  failInterruptedJobs() {
    const now = isoNow();
    return this.db
      .prepare(
        `UPDATE analysis_jobs
         SET status = 'failed',
             phase = 'failed',
             progress = 100,
             message = '上次分析因应用重启而中断，请重新运行',
             error = 'analysis_interrupted',
             updated_at = ?
         WHERE status = 'running'`,
      )
      .run(now).changes;
  }

  jobRow(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      phase: row.phase,
      progress: Number(row.progress),
      message: row.message,
      useCodex: Boolean(row.use_codex),
      error: row.error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateJob(id, { status, phase, progress, message, error }) {
    const current = this.getJob(id);
    if (!current) return null;
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE analysis_jobs
         SET status = ?, phase = ?, progress = ?, message = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status || current.status,
        phase || current.phase,
        progress ?? current.progress,
        message || current.message,
        error || null,
        now,
        id,
      );
    return this.getJob(id);
  }

  addAnalysisEvent(jobId, projectId, phase, progress, message) {
    const value = {
      id: randomUUID(),
      jobId,
      projectId,
      phase,
      progress,
      message,
      createdAt: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO analysis_events
          (id, job_id, project_id, phase, progress, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.jobId,
        value.projectId,
        value.phase,
        value.progress,
        value.message,
        value.createdAt,
      );
    return value;
  }

  listAnalysisEvents(projectId, after = "") {
    return this.db
      .prepare(
        `SELECT * FROM analysis_events
         WHERE project_id = ? AND created_at > ?
         ORDER BY created_at ASC LIMIT 200`,
      )
      .all(projectId, after)
      .map((row) => ({
        id: row.id,
        jobId: row.job_id,
        projectId: row.project_id,
        phase: row.phase,
        progress: Number(row.progress),
        message: row.message,
        createdAt: row.created_at,
      }));
  }

  saveGraph(projectId, graph) {
    const id = randomUUID();
    const now = isoNow();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO graph_versions
            (id, project_id, source, branch, commit_hash, graph_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          graph.source,
          graph.branch || null,
          graph.commit || null,
          JSON.stringify({
            entities: graph.entities,
            relations: graph.relations,
            executionFlows: graph.executionFlows || [],
          }),
          now,
        );
      this.db
        .prepare(
          `UPDATE projects
           SET latest_graph_version_id = ?, branch = ?, commit_hash = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(id, graph.branch || null, graph.commit || null, now, projectId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getGraph(projectId);
  }

  getGraph(projectId) {
    const row = this.db
      .prepare(
        `SELECT g.*
         FROM graph_versions g
         JOIN projects p ON p.latest_graph_version_id = g.id
         WHERE p.id = ?`,
      )
      .get(projectId);
    if (!row) {
      return {
        id: "",
        projectId,
        source: "scanner",
        createdAt: "",
        entities: [],
        relations: [],
      };
    }
    const graph = json(row.graph_json, { entities: [], relations: [] });
    return {
      id: row.id,
      projectId: row.project_id,
      source: row.source,
      branch: row.branch || undefined,
      commit: row.commit_hash || undefined,
      createdAt: row.created_at,
      entities: graph.entities || [],
      relations: graph.relations || [],
      executionFlows: graph.executionFlows || [],
    };
  }

  entityContext(projectId, entityId) {
    const graph = this.getGraph(projectId);
    const entity = graph.entities.find((item) => item.id === entityId);
    if (!entity) return null;
    return {
      entity,
      incoming: graph.relations.filter((item) => item.target === entityId),
      outgoing: graph.relations.filter((item) => item.source === entityId),
      annotations: this.listAnnotations(projectId, entityId),
      documents: this.listDocuments(projectId, entityId),
    };
  }

  scopeContext(projectId, input) {
    const graph = this.getGraph(projectId);
    const requestedIds = Array.isArray(input?.entityIds)
      ? [...new Set(input.entityIds.map(String))]
      : [];
    const requestedIdSet = new Set(requestedIds);
    const members = graph.entities.filter((entity) =>
      requestedIdSet.has(entity.id),
    );
    if (!input?.id || members.length === 0) return null;

    const memberIds = new Set(members.map((entity) => entity.id));
    const internal = graph.relations.filter(
      (relation) =>
        memberIds.has(relation.source) && memberIds.has(relation.target),
    );
    const incoming = graph.relations.filter(
      (relation) =>
        !memberIds.has(relation.source) && memberIds.has(relation.target),
    );
    const outgoing = graph.relations.filter(
      (relation) =>
        memberIds.has(relation.source) && !memberIds.has(relation.target),
    );
    const evidence = [
      ...members.flatMap((entity) => entity.evidence || []),
      ...internal.flatMap((relation) => relation.evidence || []),
      ...incoming.flatMap((relation) => relation.evidence || []),
      ...outgoing.flatMap((relation) => relation.evidence || []),
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
      .slice(0, 24);
    const statusRank = {
      healthy: 0,
      unknown: 1,
      warning: 2,
      offline: 3,
      error: 4,
    };
    const status = members.reduce(
      (current, member) =>
        (statusRank[member.status] ?? 1) > (statusRank[current] ?? 1)
          ? member.status
          : current,
      "healthy",
    );
    const languages = [
      ...new Set(members.map((member) => member.language).filter(Boolean)),
    ];
    const tags = [
      ...new Set(members.flatMap((member) => member.tags || [])),
    ].slice(0, 12);
    const name = String(input.name || "代码领域").trim() || "代码领域";
    const scopeId = String(input.id);
    const entity = {
      id: scopeId,
      projectId,
      category: "code",
      kind: "domain",
      name,
      summary:
        String(input.summary || "").trim() ||
        `${name} 聚合 ${members.length} 个代码节点、${internal.length} 条内部关系，以及 ${incoming.length + outgoing.length} 条跨领域关系。`,
      status,
      ...(input.path ? { path: String(input.path) } : {}),
      ...(languages.length === 1 ? { language: languages[0] } : {}),
      layer: "domain",
      tags,
      metadata: {
        scope: true,
        memberEntityIds: members.map((member) => member.id),
        memberNames: members.map((member) => member.name),
        internalRelationCount: internal.length,
      },
      evidence,
    };

    return {
      entity,
      members,
      internal,
      incoming,
      outgoing,
      annotations: this.listAnnotations(projectId, scopeId),
      documents: this.listDocuments(projectId, scopeId),
    };
  }

  addAnnotation(projectId, entityId, author, body) {
    const value = {
      id: randomUUID(),
      projectId,
      entityId,
      author,
      body,
      createdAt: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO annotations
          (id, project_id, entity_id, author, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(value.id, projectId, entityId, author, body, value.createdAt);
    return value;
  }

  listAnnotations(projectId, entityId) {
    return this.db
      .prepare(
        `SELECT * FROM annotations
         WHERE project_id = ? AND entity_id = ?
         ORDER BY created_at DESC`,
      )
      .all(projectId, entityId)
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        entityId: row.entity_id,
        author: row.author,
        body: row.body,
        createdAt: row.created_at,
      }));
  }

  addDocument(projectId, entityId, input) {
    const value = {
      id: randomUUID(),
      projectId,
      entityId,
      provider: input.provider || "link",
      externalId: input.externalId,
      title: input.title,
      url: input.url,
      summary: input.summary || "",
      syncStatus: "linked",
      updatedAt: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO documents
          (id, project_id, entity_id, provider, external_id, title, url, summary, sync_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        projectId,
        entityId,
        value.provider,
        value.externalId || null,
        value.title,
        value.url,
        value.summary,
        value.syncStatus,
        value.updatedAt,
      );
    return value;
  }

  addProjectDocument(projectId, input) {
    return this.addDocument(projectId, projectDocumentOwnerId(projectId), input);
  }

  listDocuments(projectId, entityId) {
    return this.db
      .prepare(
        `SELECT * FROM documents
         WHERE project_id = ? AND entity_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(projectId, entityId)
      .map(documentFromRow);
  }

  listProjectDocuments(projectId) {
    return this.db
      .prepare(
        `SELECT * FROM documents
         WHERE project_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(projectId)
      .map(documentFromRow);
  }

  updateDocumentSync(id, { title, summary, syncStatus, updatedAt } = {}) {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    if (!row) return null;
    const nextUpdatedAt = updatedAt || isoNow();
    this.db
      .prepare(
        `UPDATE documents
         SET title = ?, summary = ?, sync_status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        title || row.title,
        summary ?? row.summary,
        syncStatus || row.sync_status,
        nextUpdatedAt,
        id,
      );
    return documentFromRow(
      this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id),
    );
  }

  automationSettings(projectId) {
    let row = this.db
      .prepare("SELECT * FROM project_automation_settings WHERE project_id = ?")
      .get(projectId);
    if (!row) {
      const now = isoNow();
      this.db
        .prepare(
          `INSERT INTO project_automation_settings
            (project_id, debug_mode, status, message, updated_at)
           VALUES (?, 0, 'idle', 'Debug 文档同步未启用', ?)`,
        )
        .run(projectId, now);
      row = this.db
        .prepare("SELECT * FROM project_automation_settings WHERE project_id = ?")
        .get(projectId);
    }
    return {
      projectId: row.project_id,
      debugMode: Boolean(row.debug_mode),
      branch: row.branch || undefined,
      observedCommit: row.observed_commit || undefined,
      processedCommit: row.processed_commit || undefined,
      status: row.status,
      message: row.message,
      updatedAt: row.updated_at,
    };
  }

  updateAutomationSettings(projectId, patch = {}) {
    const current = this.automationSettings(projectId);
    const next = {
      debugMode: patch.debugMode ?? current.debugMode,
      branch: patch.branch ?? current.branch,
      observedCommit: patch.observedCommit ?? current.observedCommit,
      processedCommit: patch.processedCommit ?? current.processedCommit,
      status: patch.status || current.status,
      message: patch.message ?? current.message,
      updatedAt: isoNow(),
    };
    this.db
      .prepare(
        `UPDATE project_automation_settings
         SET debug_mode = ?, branch = ?, observed_commit = ?, processed_commit = ?,
             status = ?, message = ?, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(
        next.debugMode ? 1 : 0,
        next.branch || null,
        next.observedCommit || null,
        next.processedCommit || null,
        next.status,
        next.message,
        next.updatedAt,
        projectId,
      );
    return this.automationSettings(projectId);
  }

  listDebugAutomationSettings() {
    return this.db
      .prepare(
        "SELECT project_id FROM project_automation_settings WHERE debug_mode = 1",
      )
      .all()
      .map((row) => this.automationSettings(row.project_id));
  }

  getOrCreateConversation(projectId, entityId, conversationId) {
    if (conversationId) {
      const existing = this.db
        .prepare("SELECT * FROM conversations WHERE id = ? AND project_id = ?")
        .get(conversationId, projectId);
      if (existing) return existing;
    }
    const now = isoNow();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO conversations
          (id, project_id, entity_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, entityId, now, now);
    return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
  }

  setConversationThread(id, threadId) {
    this.db
      .prepare(
        "UPDATE conversations SET codex_thread_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(threadId, isoNow(), id);
  }

  addMessage(conversationId, role, content, provider, citations = []) {
    const value = {
      id: randomUUID(),
      conversationId,
      role,
      content,
      provider,
      citations,
      createdAt: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO messages
          (id, conversation_id, role, content, provider, citations_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        conversationId,
        role,
        content,
        provider,
        JSON.stringify(citations),
        value.createdAt,
      );
    return value;
  }

  listMessages(conversationId) {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
      )
      .all(conversationId)
      .map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content: row.content,
        provider: row.provider,
        citations: json(row.citations_json, []),
        createdAt: row.created_at,
      }));
  }
}

module.exports = {
  VisionStore,
  projectDocumentOwnerId,
};
