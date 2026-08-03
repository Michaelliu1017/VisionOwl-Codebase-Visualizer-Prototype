"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RepositoryWatcher } = require("../src/core/repository-watcher");
const { VisionStore } = require("../src/core/store");
const { RepositoryPolicy } = require("../src/security/repository-policy");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

test("debug watcher triggers once for a new local commit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-watcher-"));
  git(root, "init", "-b", "master");
  git(root, "config", "user.email", "visionowl@example.com");
  git(root, "config", "user.name", "VisionOwl Test");
  fs.writeFileSync(path.join(root, "index.js"), "module.exports = 1;\n");
  git(root, "add", "index.js");
  git(root, "commit", "-m", "initial");

  const store = new VisionStore(path.join(root, "visionowl.db"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = store.createProject({ name: "Watcher", repoPath: root });
  store.saveGraph(project.id, {
    source: "scanner",
    branch: "master",
    commit: git(root, "rev-parse", "HEAD"),
    entities: [],
    relations: [],
  });

  const calls = [];
  const watcher = new RepositoryWatcher(store, {
    syncLocalCommit: async (input) => {
      calls.push(input);
      return { changedFiles: 1, candidateDocuments: 0, updatedDocuments: 0 };
    },
  }, {
    repositoryPolicy: new RepositoryPolicy(),
  });
  await watcher.enable(project.id, true);

  fs.writeFileSync(path.join(root, "index.js"), "module.exports = 2;\n");
  git(root, "add", "index.js");
  git(root, "commit", "-m", "change");
  await watcher.tick();
  await watcher.tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].before !== calls[0].after, true);
  const settings = store.automationSettings(project.id);
  assert.equal(settings.status, "watching");
  assert.equal(settings.processedCommit, git(root, "rev-parse", "HEAD"));
});

test("debug watcher retries an observed commit after document sync fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-watcher-retry-"));
  git(root, "init", "-b", "master");
  git(root, "config", "user.email", "visionowl@example.com");
  git(root, "config", "user.name", "VisionOwl Test");
  fs.writeFileSync(path.join(root, "index.js"), "module.exports = 1;\n");
  git(root, "add", "index.js");
  git(root, "commit", "-m", "initial");

  const store = new VisionStore(path.join(root, "visionowl.db"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = store.createProject({ name: "Watcher retry", repoPath: root });
  store.saveGraph(project.id, {
    source: "scanner",
    branch: "master",
    commit: git(root, "rev-parse", "HEAD"),
    entities: [],
    relations: [],
  });

  let attempts = 0;
  const watcher = new RepositoryWatcher(store, {
    syncLocalCommit: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary document failure");
      return { changedFiles: 1, candidateDocuments: 1, updatedDocuments: 1 };
    },
  }, {
    repositoryPolicy: new RepositoryPolicy(),
  });
  await watcher.enable(project.id, true);

  fs.writeFileSync(path.join(root, "index.js"), "module.exports = 2;\n");
  git(root, "add", "index.js");
  git(root, "commit", "-m", "change");
  const latestCommit = git(root, "rev-parse", "HEAD");

  await watcher.tick();
  let settings = store.automationSettings(project.id);
  assert.equal(settings.status, "error");
  assert.equal(settings.observedCommit, latestCommit);
  assert.notEqual(settings.processedCommit, latestCommit);

  await watcher.tick();
  settings = store.automationSettings(project.id);
  assert.equal(attempts, 2);
  assert.equal(settings.status, "watching");
  assert.equal(settings.processedCommit, latestCommit);
});
