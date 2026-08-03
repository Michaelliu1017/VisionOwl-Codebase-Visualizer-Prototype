"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  VisionStore,
  projectDocumentOwnerId,
} = require("../src/core/store");

test("store persists graph versions, annotations, documents and conversations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-store-"));
  const store = new VisionStore(path.join(root, "visionowl.db"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const project = store.createProject({
    name: "Store fixture",
    description: "Persistence test",
    repoPath: root,
  });
  const boundProject = store.bindCloudProject(project.id, "cloud-project-1");
  assert.equal(boundProject.cloudProjectId, "cloud-project-1");
  assert.equal(store.getProject(project.id).cloudProjectId, "cloud-project-1");

  const secondProject = store.createProject({
    name: "Second fixture",
    repoPath: root,
  });
  assert.throws(
    () => store.bindCloudProject(secondProject.id, "cloud-project-1"),
    (error) => error.code === "cloud_project_already_bound",
  );
  const entity = {
    id: "module:core",
    projectId: project.id,
    category: "code",
    kind: "module",
    name: "Core",
    summary: "Core module",
    status: "healthy",
    path: "src/core",
    tags: ["typescript"],
    metadata: {},
    evidence: [{ file: "src/core/index.ts", line: 1 }],
  };
  store.saveGraph(project.id, {
    source: "scanner",
    branch: "main",
    commit: "abc123",
    entities: [entity],
    relations: [],
    executionFlows: [
      {
        id: "request",
        name: "Request",
        summary: "Request path",
        entryPoint: "Core",
        featured: true,
        entityIds: [entity.id],
        relationIds: [],
        lanes: ["Core"],
      },
    ],
  });

  store.addAnnotation(project.id, entity.id, "Alice", "Owns the API boundary.");
  store.addDocument(project.id, entity.id, {
    provider: "link",
    title: "Core design",
    url: "https://example.com/core",
    summary: "Design notes",
  });
  store.addProjectDocument(project.id, {
    provider: "dingtalk",
    title: "System architecture",
    url: "https://alidocs.dingtalk.com/i/nodes/architecture",
    summary: "Project-wide architecture",
  });

  const context = store.entityContext(project.id, entity.id);
  assert.equal(context.entity.name, "Core");
  assert.equal(context.annotations[0].author, "Alice");
  assert.equal(context.documents[0].title, "Core design");
  const projectDocuments = store.listProjectDocuments(project.id);
  assert.equal(projectDocuments.length, 2);
  assert.equal(
    projectDocuments.find((document) => document.title === "System architecture")
      .entityId,
    projectDocumentOwnerId(project.id),
  );
  assert.equal(
    store.listProjects().find((value) => value.id === project.id).nodeCount,
    1,
  );
  assert.equal(store.getGraph(project.id).executionFlows[0].name, "Request");

  const automation = store.updateAutomationSettings(project.id, {
    debugMode: true,
    branch: "main",
    observedCommit: "abc123",
    processedCommit: "abc123",
    status: "watching",
    message: "Watching local commits",
  });
  assert.equal(automation.debugMode, true);
  assert.equal(automation.branch, "main");
  assert.equal(store.listDebugAutomationSettings().length, 1);

  const scopeId = "visual-domain:core";
  store.addAnnotation(project.id, scopeId, "Bob", "Owns the whole core domain.");
  store.addDocument(project.id, scopeId, {
    provider: "dingtalk",
    title: "Core domain design",
    url: "https://alidocs.dingtalk.com/i/nodes/example",
    summary: "Domain-level design notes",
  });
  const scope = store.scopeContext(project.id, {
    id: scopeId,
    name: "Core Domain",
    path: "src/core",
    entityIds: [entity.id, "module:not-present"],
  });
  assert.equal(scope.entity.kind, "domain");
  assert.equal(scope.members.length, 1);
  assert.equal(scope.members[0].id, entity.id);
  assert.equal(scope.annotations[0].author, "Bob");
  assert.equal(scope.documents[0].provider, "dingtalk");

  const conversation = store.getOrCreateConversation(project.id, entity.id);
  store.addMessage(conversation.id, "user", "What is this?", "codex");
  const response = store.addMessage(
    conversation.id,
    "assistant",
    "It is the core module.",
    "local-fallback",
    entity.evidence,
  );
  assert.equal(store.listMessages(conversation.id).length, 2);
  assert.equal(response.citations[0].file, "src/core/index.ts");

  const interrupted = store.createJob(project.id, true);
  assert.equal(store.failInterruptedJobs(), 1);
  assert.equal(store.getJob(interrupted.id).status, "failed");
  assert.equal(store.getJob(interrupted.id).error, "analysis_interrupted");
});
