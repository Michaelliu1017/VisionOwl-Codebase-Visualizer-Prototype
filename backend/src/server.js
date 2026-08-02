"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { randomUUID } = require("node:crypto");
const { AnalysisService } = require("./core/analysis-service");
const { askAboutEntity } = require("./core/codex-agent");
const { DingTalkDocuments } = require("./core/dingtalk-documents");
const { DocumentAutomationService } = require("./core/document-automation");
const { repositoryState } = require("./core/git-repository");
const { headers, readJson, sendJson, serveStatic } = require("./core/http-utils");
const { PluginManager } = require("./core/plugin-manager");
const { RepositoryWatcher } = require("./core/repository-watcher");
const { VisionStore } = require("./core/store");

const root = path.resolve(__dirname, "../..");
const dataFile =
  process.env.VISIONOWL_DB || path.join(root, "data", "visionowl.db");
const publicRoot =
  process.env.PUBLIC_ROOT || path.join(root, "frontend", "dist");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 17300);

const store = new VisionStore(dataFile);
store.failInterruptedJobs();
const analysis = new AnalysisService(store);
const dingtalk = new DingTalkDocuments();
const documentAutomation = new DocumentAutomationService(store, dingtalk);
const repositoryWatcher = new RepositoryWatcher(store, documentAutomation, {
  intervalMs: Number(process.env.VISIONOWL_REPO_WATCH_INTERVAL_MS || 10000),
});
if (String(process.env.VISIONOWL_ENABLE_REPO_WATCHER || "true") !== "false") {
  repositoryWatcher.start();
}
const plugins = new PluginManager(path.join(__dirname, "plugins"));
const runtimePluginsEnabled =
  String(process.env.VISIONOWL_ENABLE_RUNTIME_PLUGINS || "false") === "true";
if (runtimePluginsEnabled) {
  plugins.load();
  plugins.startAll();
}
const m5 = plugins.get("m5-synthetic-monitor");

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${name} is required.`), { status: 400 });
  }
  return value.trim();
}

async function automationSnapshot(project, settings) {
  try {
    const state = await repositoryState(
      project.repoPath,
      settings.branch || project.branch,
    );
    return { ...settings, currentCommit: state.commit };
  } catch (_error) {
    return settings;
  }
}

function projectRoute(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/projects/([^/]+)/${suffix}$`)
    : /^\/api\/projects\/([^/]+)$/;
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeCompatibilityUrl(requestUrl) {
  const value = new URL(requestUrl, "http://localhost");
  if (value.pathname.startsWith("/api-local")) {
    value.pathname = value.pathname.replace(/^\/api-local/, "/api");
    value.searchParams.set("mode", "local");
  } else if (value.pathname.startsWith("/api-online")) {
    value.pathname = value.pathname.replace(/^\/api-online/, "/api");
    value.searchParams.set("mode", "online");
  }
  return value;
}

function writeSseHead(response) {
  response.writeHead(
    200,
    headers({
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    }),
  );
}

function writeSseEvent(response, event, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function chatAnswerAsText(answer) {
  return [
    answer.conclusion,
    answer.purpose,
    answer.callChain.length > 0
      ? `调用链：${answer.callChain.join(" -> ")}`
      : "",
    ...answer.facts.map((fact) => `事实：${fact}`),
    ...answer.inferences.map((inference) => `推断：${inference}`),
    ...answer.notes.map((note) => `说明：${note}`),
  ]
    .filter(Boolean)
    .join("\n");
}

function prepareEntityChat(projectId, body) {
  const project = store.getProject(projectId);
  if (!project) {
    throw Object.assign(new Error("Project was not found."), { status: 404 });
  }
  const entityId = required(body.entityId, "entityId");
  const question = required(body.question, "question");
  const context =
    body.scope && typeof body.scope === "object"
      ? store.scopeContext(projectId, {
          ...body.scope,
          id: entityId,
        })
      : store.entityContext(projectId, entityId);
  if (!context) {
    throw Object.assign(new Error("Analysis target was not found."), {
      status: 404,
    });
  }
  const conversation = store.getOrCreateConversation(
    projectId,
    entityId,
    body.conversationId,
  );
  store.addMessage(conversation.id, "user", question, "codex");
  const graph = store.getGraph(projectId);
  const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const memberIds = new Set(
    context.members?.map((entity) => entity.id) || [entityId],
  );
  const compactRelation = (relation, direction) => ({
    direction,
    type: relation.type,
    label: relation.label,
    source: entityById.get(relation.source)?.name || relation.source,
    target: entityById.get(relation.target)?.name || relation.target,
  });
  const graphContext = {
    members: (context.members || []).map((entity) => ({
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      summary: entity.summary,
      path: entity.path,
    })),
    neighbors: [
      ...context.incoming.map((relation) =>
        compactRelation(relation, "incoming"),
      ),
      ...context.outgoing.map((relation) =>
        compactRelation(relation, "outgoing"),
      ),
      ...(context.internal || []).map((relation) =>
        compactRelation(relation, "internal"),
      ),
    ],
    executionFlows: (graph.executionFlows || [])
      .filter((flow) =>
        flow.entityIds.some((flowEntityId) => memberIds.has(flowEntityId)),
      )
      .map((flow) => ({
        name: flow.name,
        summary: flow.summary,
        entryPoint: flow.entryPoint,
        steps: flow.entityIds.map(
          (stepId) => entityById.get(stepId)?.name || stepId,
        ),
      })),
  };
  return { project, context, graphContext, question, conversation };
}

async function answerEntityChat(prepared, onProgress) {
  const { project, context, graphContext, question, conversation } = prepared;
  let answer;
  let provider = "codex";
  let threadId = conversation.codex_thread_id;
  try {
    const result = await askAboutEntity({
      repoPath: project.repoPath,
      project,
      context,
      question,
      threadId,
      onProgress,
      graphContext,
    });
    answer = result.answer;
    threadId = result.threadId || threadId;
    if (threadId) store.setConversationThread(conversation.id, threadId);
  } catch (error) {
    provider = "local-fallback";
    const fallbackEvidence = (context.entity.evidence || []).slice(0, 6);
    answer = {
      conclusion: `Codex 暂时无法完成 ${context.entity.name} 的深度分析。`,
      purpose: context.entity.summary || "当前图谱没有提供模块职责摘要。",
      callChain: [],
      facts: [
        `当前模块有 ${context.incoming.length} 条入向关系和 ${context.outgoing.length} 条出向关系。`,
      ],
      inferences: [],
      notes: [error.message],
      citations: fallbackEvidence,
    };
  }
  const citations =
    answer.citations.length > 0
      ? answer.citations
      : (context.entity.evidence || []).slice(0, 6);
  const message = store.addMessage(
    conversation.id,
    "assistant",
    chatAnswerAsText(answer),
    provider,
    citations,
  );
  return {
    conversationId: conversation.id,
    message,
    answer: { ...answer, citations },
    messages: store.listMessages(conversation.id),
  };
}

function m5Compatibility(request, response, requestUrl) {
  if (!m5) return false;
  const pathname = requestUrl.pathname;
  const mode = requestUrl.searchParams.get("mode") === "online" ? "online" : "local";
  const selected = m5.monitor(mode);

  if (pathname === "/health") {
    sendJson(response, 200, selected.health());
    return true;
  }
  if (pathname === "/api/v1/topology") {
    sendJson(response, 200, selected.topology());
    return true;
  }
  if (pathname === "/api/v1/health-summary") {
    sendJson(
      response,
      mode === "online" ? 200 : 404,
      mode === "online"
        ? m5.online.healthSummary()
        : { error: "health summary is only available online" },
    );
    return true;
  }
  if (pathname === "/api/v1/incidents") {
    sendJson(
      response,
      200,
      mode === "online" ? m5.online.incidents() : { mocked: false, incidents: [] },
    );
    return true;
  }
  if (pathname === "/api/v1/events") {
    sendJson(response, 200, {
      events: selected.events.list({
        after: requestUrl.searchParams.get("after") || 0,
        limit: requestUrl.searchParams.get("limit") || 200,
      }),
      cursor: selected.events.sequence,
    });
    return true;
  }
  if (pathname === "/api/v1/stream") {
    writeSseHead(response);
    const requestedAfter =
      request.headers["last-event-id"] || requestUrl.searchParams.get("after");
    const numericAfter = Number(requestedAfter);
    const after =
      requestedAfter === null ||
      requestedAfter === undefined ||
      !Number.isFinite(numericAfter) ||
      numericAfter < 0
        ? selected.events.sequence
        : numericAfter;
    selected.events.subscribe(response, after);
    return true;
  }
  const incidentMatch = pathname.match(/^\/api\/v1\/incidents\/([^/]+)$/);
  if (incidentMatch) {
    const item =
      mode === "online"
        ? m5.online.incident(decodeURIComponent(incidentMatch[1]))
        : null;
    sendJson(response, item ? 200 : 404, item || { error: "not_found" });
    return true;
  }
  const entityMatch = pathname.match(/^\/api\/v1\/entities\/([^/]+)$/);
  if (entityMatch) {
    const item = selected.entity(decodeURIComponent(entityMatch[1]));
    sendJson(response, item ? 200 : 404, item || { error: "not_found" });
    return true;
  }
  const executionMatch = pathname.match(
    /^\/api\/v1\/tasks\/([^/]+)\/executions$/,
  );
  if (executionMatch) {
    const taskId = decodeURIComponent(executionMatch[1]);
    sendJson(
      response,
      200,
      mode === "local"
        ? m5.local.executions(taskId)
        : { taskId, taskUrl: null, reports: [], events: [], mocked: true },
    );
    return true;
  }
  return false;
}

async function route(request, response) {
  const requestUrl = normalizeCompatibilityUrl(request.url);
  const pathname = requestUrl.pathname;

  if (request.method === "OPTIONS") {
    response.writeHead(204, headers());
    response.end();
    return;
  }

  if (request.method === "GET" && m5Compatibility(request, response, requestUrl)) {
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "visionowl-api",
      storage: "sqlite",
      plugins: plugins.list().length,
      runtimePluginsEnabled,
      codexEnabled: String(process.env.VISIONOWL_CODEX_ENABLED || "true") !== "false",
      time: new Date().toISOString(),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/plugins") {
    sendJson(response, 200, plugins.list());
    return;
  }

  if (request.method === "GET" && pathname === "/api/runtime/topology") {
    const providerId = requestUrl.searchParams.get("provider");
    const provider = providerId
      ? plugins.get(providerId)
      : plugins.firstWithCapability("runtime-topology");
    if (!provider || typeof provider.genericTopology !== "function") {
      sendJson(response, 404, { error: "runtime_provider_not_found" });
      return;
    }
    sendJson(
      response,
      200,
      provider.genericTopology(
        requestUrl.searchParams.get("mode") === "online" ? "online" : "local",
      ),
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/projects") {
    sendJson(response, 200, store.listProjects());
    return;
  }

  if (request.method === "POST" && pathname === "/api/projects") {
    const body = await readJson(request);
    const repoPath = path.resolve(required(body.repoPath, "repoPath"));
    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      throw Object.assign(new Error("repoPath must point to a readable directory."), {
        status: 400,
      });
    }
    const project = store.createProject({
      name: required(body.name, "name"),
      description: String(body.description || ""),
      repoPath,
    });
    sendJson(response, 201, project);
    return;
  }

  const projectId = projectRoute(pathname);
  if (request.method === "GET" && projectId) {
    const project = store.getProject(projectId);
    sendJson(
      response,
      project ? 200 : 404,
      project || { error: "project_not_found" },
    );
    return;
  }

  const graphProjectId = projectRoute(pathname, "graph");
  if (request.method === "GET" && graphProjectId) {
    const project = store.getProject(graphProjectId);
    if (!project) {
      sendJson(response, 404, { error: "project_not_found" });
      return;
    }
    sendJson(response, 200, store.getGraph(graphProjectId));
    return;
  }

  const analyzeProjectId = projectRoute(pathname, "analyze");
  if (request.method === "POST" && analyzeProjectId) {
    if (!store.getProject(analyzeProjectId)) {
      sendJson(response, 404, { error: "project_not_found" });
      return;
    }
    await readJson(request);
    const job = store.createJob(analyzeProjectId, true);
    analysis.start(job);
    sendJson(response, 202, job);
    return;
  }

  const jobsProjectId = projectRoute(pathname, "jobs");
  if (request.method === "GET" && jobsProjectId) {
    sendJson(response, 200, store.listJobs(jobsProjectId));
    return;
  }

  const automationProjectId = projectRoute(pathname, "automation");
  if (request.method === "GET" && automationProjectId) {
    const project = store.getProject(automationProjectId);
    if (!project) {
      sendJson(response, 404, { error: "project_not_found" });
      return;
    }
    sendJson(
      response,
      200,
      await automationSnapshot(
        project,
        store.automationSettings(automationProjectId),
      ),
    );
    return;
  }
  if (request.method === "PATCH" && automationProjectId) {
    const body = await readJson(request);
    const value = await repositoryWatcher.enable(
      automationProjectId,
      body.debugMode === true,
    );
    const project = store.getProject(automationProjectId);
    sendJson(
      response,
      200,
      project ? await automationSnapshot(project, value) : value,
    );
    return;
  }

  const documentsProjectId = projectRoute(pathname, "documents");
  if (request.method === "GET" && documentsProjectId) {
    sendJson(response, 200, store.listProjectDocuments(documentsProjectId));
    return;
  }
  if (request.method === "POST" && documentsProjectId) {
    const body = await readJson(request);
    const value = store.addProjectDocument(documentsProjectId, {
      provider: body.provider || "link",
      externalId: body.externalId,
      title: required(body.title, "title"),
      url: required(body.url, "url"),
      summary: String(body.summary || ""),
    });
    sendJson(response, 201, value);
    return;
  }

  const eventProjectId = projectRoute(pathname, "events");
  if (request.method === "GET" && eventProjectId) {
    writeSseHead(response);
    const history = store.listAnalysisEvents(
      eventProjectId,
      requestUrl.searchParams.get("after") || "",
    );
    for (const event of history) {
      response.write(`id: ${event.id}\nevent: analysis\ndata: ${JSON.stringify(event)}\n\n`);
    }
    const listener = (event) => {
      response.write(`id: ${event.id}\nevent: analysis\ndata: ${JSON.stringify(event)}\n\n`);
    };
    analysis.on(`project:${eventProjectId}`, listener);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20000);
    request.on("close", () => {
      clearInterval(heartbeat);
      analysis.off(`project:${eventProjectId}`, listener);
    });
    return;
  }

  const contextMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/entities\/([^/]+)$/,
  );
  if (request.method === "GET" && contextMatch) {
    const [projectValue, entityValue] = contextMatch.slice(1).map(decodeURIComponent);
    const context = store.entityContext(projectValue, entityValue);
    sendJson(response, context ? 200 : 404, context || { error: "entity_not_found" });
    return;
  }

  const scopeContextProjectId = projectRoute(pathname, "scopes/context");
  if (request.method === "POST" && scopeContextProjectId) {
    const body = await readJson(request);
    const context = store.scopeContext(scopeContextProjectId, {
      id: required(body.id, "id"),
      name: required(body.name, "name"),
      path: body.path,
      summary: body.summary,
      entityIds: Array.isArray(body.entityIds) ? body.entityIds : [],
    });
    sendJson(
      response,
      context ? 200 : 404,
      context || { error: "scope_not_found" },
    );
    return;
  }

  const annotationMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/entities\/([^/]+)\/annotations$/,
  );
  if (request.method === "POST" && annotationMatch) {
    const [projectValue, entityValue] = annotationMatch.slice(1).map(decodeURIComponent);
    const body = await readJson(request);
    const value = store.addAnnotation(
      projectValue,
      entityValue,
      required(body.author, "author"),
      required(body.body, "body"),
    );
    sendJson(response, 201, value);
    return;
  }

  const documentMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/entities\/([^/]+)\/documents$/,
  );
  if (request.method === "POST" && documentMatch) {
    const [projectValue, entityValue] = documentMatch.slice(1).map(decodeURIComponent);
    const body = await readJson(request);
    const value = store.addDocument(projectValue, entityValue, {
      provider: body.provider || "link",
      externalId: body.externalId,
      title: required(body.title, "title"),
      url: required(body.url, "url"),
      summary: String(body.summary || ""),
    });
    sendJson(response, 201, value);
    return;
  }

  const generateDocumentMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/entities\/([^/]+)\/documents\/generate\/stream$/,
  );
  if (request.method === "POST" && generateDocumentMatch) {
    const [projectValue, entityValue] = generateDocumentMatch
      .slice(1)
      .map(decodeURIComponent);
    const body = await readJson(request);
    writeSseHead(response);
    try {
      const result = await documentAutomation.createAndBind({
        projectId: projectValue,
        entityId: entityValue,
        scope:
          body.scope && typeof body.scope === "object" ? body.scope : undefined,
        onProgress: (progress) =>
          writeSseEvent(response, "progress", progress),
      });
      writeSseEvent(response, "complete", result);
    } catch (error) {
      writeSseEvent(response, "error", {
        message: error.message,
        requestId: randomUUID(),
      });
    }
    response.end();
    return;
  }

  const refreshDocumentsMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/entities\/([^/]+)\/documents\/refresh\/stream$/,
  );
  if (request.method === "POST" && refreshDocumentsMatch) {
    const [projectValue, entityValue] = refreshDocumentsMatch
      .slice(1)
      .map(decodeURIComponent);
    const body = await readJson(request);
    writeSseHead(response);
    try {
      const result = await documentAutomation.refreshBoundDocuments({
        projectId: projectValue,
        entityId: entityValue,
        scope:
          body.scope && typeof body.scope === "object" ? body.scope : undefined,
        onProgress: (progress) =>
          writeSseEvent(response, "progress", progress),
      });
      writeSseEvent(response, "complete", result);
    } catch (error) {
      writeSseEvent(response, "error", {
        message: error.message,
        requestId: randomUUID(),
      });
    }
    response.end();
    return;
  }

  const streamChatProjectId = projectRoute(pathname, "chat/stream");
  if (request.method === "POST" && streamChatProjectId) {
    const body = await readJson(request);
    const prepared = prepareEntityChat(streamChatProjectId, body);
    writeSseHead(response);
    writeSseEvent(response, "progress", {
      phase: "context",
      label: "正在建立模块分析上下文",
      detail: prepared.context.entity.name,
      current: 1,
      total: 4,
    });
    try {
      const result = await answerEntityChat(prepared, (progress) => {
        writeSseEvent(response, "progress", progress);
      });
      writeSseEvent(response, "complete", result);
    } catch (error) {
      writeSseEvent(response, "error", {
        message: error.message,
        requestId: randomUUID(),
      });
    }
    response.end();
    return;
  }

  const chatProjectId = projectRoute(pathname, "chat");
  if (request.method === "POST" && chatProjectId) {
    const body = await readJson(request);
    const prepared = prepareEntityChat(chatProjectId, body);
    const result = await answerEntityChat(prepared);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && !pathname.startsWith("/api")) {
    serveStatic(publicRoot, pathname, response);
    return;
  }

  sendJson(response, 404, { error: "not_found", path: pathname });
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, error.status || 500, {
        error: error.status ? "invalid_request" : "internal_error",
        message: error.message,
        requestId: randomUUID(),
      });
    } else {
      response.end();
    }
  });
});

server.listen(port, host, () => {
  console.log(`VisionOwl API listening on http://${host}:${port}`);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  repositoryWatcher.stop();
  plugins.stopAll();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => server.closeAllConnections?.(), 250).unref();
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
