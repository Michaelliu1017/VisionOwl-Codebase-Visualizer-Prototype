"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RepositoryPolicy } = require("../src/security/repository-policy");

test("repository policy accepts user-selected directories and pins a Project branch", (t) => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-first-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-second-"));
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  const policy = new RepositoryPolicy();

  assert.equal(policy.authorizeRepository(first).path, fs.realpathSync(first));
  assert.equal(policy.authorizeRepository(second).path, fs.realpathSync(second));

  const binding = policy.authorizeRepository(first, { branch: "master" });
  assert.equal(policy.assertBranch(binding, "master"), "master");
  assert.throws(() => policy.assertBranch(binding, "develop"), {
    code: "repository_branch_changed",
  });
  assert.throws(() => policy.authorizeRepository(path.parse(first).root), {
    code: "repository_path_too_broad",
  });
  assert.throws(() => policy.authorizeRepository(os.homedir()), {
    code: "repository_path_too_broad",
  });
});
