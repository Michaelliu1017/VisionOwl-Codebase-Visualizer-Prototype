"use strict";

const fs = require("node:fs");
const path = require("node:path");

class PathGuardError extends Error {
  constructor(message, code = "repository_path_denied") {
    super(message);
    this.name = "PathGuardError";
    this.code = code;
    this.status = 403;
  }
}

function hasParentTraversal(value) {
  return String(value)
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "..");
}

function realDirectory(input, { rejectSymlink = true } = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw new PathGuardError("Repository path is required.", "invalid_repository_path");
  }
  const value = input.trim();
  if (!path.isAbsolute(value)) {
    throw new PathGuardError(
      "Repository path must be absolute.",
      "repository_path_not_absolute",
    );
  }
  if (hasParentTraversal(value)) {
    throw new PathGuardError(
      "Repository path cannot contain parent-directory traversal.",
      "repository_path_traversal",
    );
  }

  const resolved = path.resolve(value);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (_error) {
    throw new PathGuardError(
      "Repository path does not exist.",
      "repository_path_missing",
    );
  }
  if (rejectSymlink && stat.isSymbolicLink()) {
    throw new PathGuardError(
      "Repository root cannot be a symbolic link.",
      "repository_root_symlink",
    );
  }
  if (!stat.isDirectory()) {
    throw new PathGuardError(
      "Repository path must point to a directory.",
      "repository_path_not_directory",
    );
  }
  return fs.realpathSync.native(resolved);
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveExistingPathInside(rootInput, relativeInput) {
  const root = realDirectory(rootInput);
  if (typeof relativeInput !== "string" || !relativeInput.trim()) {
    throw new PathGuardError("Repository-relative path is required.", "invalid_relative_path");
  }
  const value = relativeInput.trim();
  if (path.isAbsolute(value) || hasParentTraversal(value)) {
    throw new PathGuardError(
      "Repository-relative path cannot be absolute or escape the repository.",
      "repository_relative_path_escape",
    );
  }
  const candidate = path.resolve(root, value);
  if (!isInside(root, candidate)) {
    throw new PathGuardError(
      "Resolved path escapes the authorized repository.",
      "repository_relative_path_escape",
    );
  }

  let realCandidate;
  try {
    realCandidate = fs.realpathSync.native(candidate);
  } catch (_error) {
    throw new PathGuardError(
      "Repository-relative path does not exist.",
      "repository_relative_path_missing",
    );
  }
  if (!isInside(root, realCandidate)) {
    throw new PathGuardError(
      "Repository-relative path resolves outside the authorized repository.",
      "repository_symlink_escape",
    );
  }
  return realCandidate;
}

module.exports = {
  PathGuardError,
  hasParentTraversal,
  isInside,
  realDirectory,
  resolveExistingPathInside,
};
