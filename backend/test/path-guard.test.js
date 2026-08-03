"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  realDirectory,
  resolveExistingPathInside,
} = require("../src/security/path-guard");

test("path guard accepts files inside a real repository root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-path-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "module.exports = true;\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(realDirectory(root), fs.realpathSync.native(root));
  assert.equal(
    resolveExistingPathInside(root, "src/index.js"),
    fs.realpathSync.native(path.join(root, "src", "index.js")),
  );
});

test("path guard rejects parent traversal and symlinks leaving the repository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-path-escape-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked-secret"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(() => resolveExistingPathInside(root, "../secret.txt"), {
    code: "repository_relative_path_escape",
  });
  assert.throws(() => resolveExistingPathInside(root, "linked-secret"), {
    code: "repository_symlink_escape",
  });
});
