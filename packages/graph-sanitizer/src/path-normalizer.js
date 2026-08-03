"use strict";

const fs = require("node:fs");
const path = require("node:path");

class ArtifactPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactPathError";
    this.code = "sanitized_graph_path_invalid";
    this.status = 422;
  }
}

function hasParentTraversal(value) {
  return String(value)
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "..");
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function realDirectory(input) {
  const resolved = path.resolve(String(input || ""));
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ArtifactPathError("Repository root must be a real directory.");
  }
  return fs.realpathSync.native(resolved);
}

function normalizeRepositoryPath(value, repositoryRoot) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const configuredRoot = path.resolve(String(repositoryRoot || ""));
  const root = realDirectory(configuredRoot);
  const input = String(value).trim();
  if (input.includes("\0") || hasParentTraversal(input)) {
    throw new ArtifactPathError("Graph paths cannot contain traversal segments.");
  }

  let relative;
  if (path.isAbsolute(input)) {
    const configuredCandidate = path.resolve(input);
    relative = path.relative(configuredRoot, configuredCandidate);
    if (relative.startsWith(`..${path.sep}`) || relative === "..") {
      throw new ArtifactPathError("Graph path points outside the authorized repository.");
    }
    const candidate = path.resolve(root, relative);
    const checkedCandidate = fs.existsSync(candidate)
      ? fs.realpathSync.native(candidate)
      : candidate;
    if (!isInside(root, checkedCandidate)) {
      throw new ArtifactPathError("Graph path resolves outside the authorized repository.");
    }
  } else {
    relative = path.normalize(input);
    const candidate = path.resolve(root, relative);
    if (!isInside(root, candidate)) {
      throw new ArtifactPathError("Graph path escapes the authorized repository.");
    }
  }

  const portable = relative.split(path.sep).join("/").replace(/^\.\//, "");
  return portable || ".";
}

module.exports = { ArtifactPathError, normalizeRepositoryPath };
