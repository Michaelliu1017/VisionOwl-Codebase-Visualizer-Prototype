"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { repositoryState } = require("../src/core/git-repository");

test("repository state rejects a worktree switched away from the Project branch", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-branch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["-C", root, "init", "-b", "master"]);
  execFileSync("git", ["-C", root, "checkout", "-b", "feature"]);

  await assert.rejects(repositoryState(root, "master"), /checked out on "feature"/);
});
