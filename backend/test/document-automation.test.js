"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DocumentAutomationService } = require("../src/core/document-automation");
const { DingTalkDocuments } = require("../src/core/dingtalk-documents");
const { VisionStore } = require("../src/core/store");

function fixtureStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-docs-"));
  const store = new VisionStore(path.join(root, "visionowl.db"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = store.createProject({
    name: "Docs fixture",
    repoPath: root,
  });
  store.saveGraph(project.id, {
    source: "scanner",
    branch: "master",
    commit: "abc123",
    entities: [
      {
        id: "module:api",
        projectId: project.id,
        category: "code",
        kind: "module",
        name: "API",
        summary: "HTTP API",
        status: "healthy",
        path: "src/api",
        tags: [],
        metadata: {},
        evidence: [{ file: "src/api/index.js", line: 1 }],
      },
    ],
    relations: [],
  });
  return { root, store, project };
}

test("DingTalk adapter creates a document and returns a mountable URL", async () => {
  const calls = [];
  const adapter = new DingTalkDocuments({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "auth") {
        return JSON.stringify({ authenticated: true, message: "ok" });
      }
      return JSON.stringify({ success: true, nodeId: "node-123" });
    },
  });
  const result = await adapter.create({ name: "API", content: "# API" });
  assert.equal(result.nodeId, "node-123");
  assert.equal(result.url, "https://alidocs.dingtalk.com/i/nodes/node-123");
  assert.equal(calls.some((args) => args.includes("--content-file")), true);
});

test("DingTalk adapter extracts Markdown from the open DWS response", async () => {
  const adapter = new DingTalkDocuments({
    run: async (args) => {
      if (args[0] === "auth") {
        return JSON.stringify({ authenticated: true, message: "ok" });
      }
      return JSON.stringify({
        success: true,
        nodeId: "node-123",
        markdown: "# API\n\nCurrent module documentation.",
      });
    },
  });

  const markdown = await adapter.read(
    "https://alidocs.dingtalk.com/i/nodes/node-123",
  );

  assert.equal(markdown, "# API\n\nCurrent module documentation.");
});

test("module document generation publishes and mounts the DingTalk document", async (t) => {
  const { store, project } = fixtureStore(t);
  const progress = [];
  const service = new DocumentAutomationService(
    store,
    {
      assertAuthenticated: async () => ({ authenticated: true }),
      create: async () => ({
        nodeId: "node-api",
        url: "https://alidocs.dingtalk.com/i/nodes/node-api",
      }),
    },
    {
      generateDocument: async () => ({
        action: "create",
        title: "API 代码说明",
        summary: "API module documentation",
        reason: "created",
        markdown: "# API",
        evidence: [],
      }),
    },
  );

  const result = await service.createAndBind({
    projectId: project.id,
    entityId: "module:api",
    onProgress: (item) => progress.push(item),
  });
  assert.equal(result.document.provider, "dingtalk");
  assert.equal(result.document.syncStatus, "synced");
  assert.equal(store.listDocuments(project.id, "module:api").length, 1);
  assert.deepEqual(
    progress.map((item) => item.phase),
    ["context", "analysis", "publish", "bind"],
  );
});

test("manual module refresh updates existing DingTalk documents in place", async (t) => {
  const { store, project } = fixtureStore(t);
  const dingtalkDocument = store.addDocument(project.id, "module:api", {
    provider: "dingtalk",
    title: "API 代码说明",
    url: "https://alidocs.dingtalk.com/i/nodes/node-api",
    summary: "Old summary",
  });
  store.addDocument(project.id, "module:api", {
    provider: "link",
    title: "External reference",
    url: "https://example.com/reference",
    summary: "Read only",
  });
  const writes = [];
  const progress = [];
  const service = new DocumentAutomationService(
    store,
    {
      assertAuthenticated: async () => ({ authenticated: true }),
      read: async (url) => {
        assert.equal(url, dingtalkDocument.url);
        return "# API\n\nOld content.";
      },
      overwrite: async (url, markdown) => writes.push({ url, markdown }),
    },
    {
      refreshDocument: async ({ context, currentMarkdown }) => {
        assert.equal(context.entity.id, "module:api");
        assert.equal(currentMarkdown, "# API\n\nOld content.");
        return {
          action: "update",
          title: "API 模块说明",
          summary: "Current API module documentation",
          reason: "source verified",
          markdown: "# API\n\nCurrent content.",
          evidence: [],
        };
      },
    },
  );

  const result = await service.refreshBoundDocuments({
    projectId: project.id,
    entityId: "module:api",
    onProgress: (item) => progress.push(item),
  });

  assert.equal(result.checkedDocuments, 1);
  assert.equal(result.updatedDocuments, 1);
  assert.equal(result.unchangedDocuments, 0);
  assert.deepEqual(writes, [
    {
      url: dingtalkDocument.url,
      markdown: "# API\n\nCurrent content.",
    },
  ]);
  assert.equal(result.documents[0].title, "API 模块说明");
  assert.equal(result.documents[0].syncStatus, "synced");
  assert.deepEqual(
    progress.map((item) => item.phase),
    ["context", "read", "analysis", "publish"],
  );
});
