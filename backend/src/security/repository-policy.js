"use strict";

const os = require("node:os");
const path = require("node:path");
const { realDirectory } = require("./path-guard");

class RepositoryPolicyError extends Error {
  constructor(message, code = "repository_access_denied") {
    super(message);
    this.name = "RepositoryPolicyError";
    this.code = code;
    this.status = 403;
  }
}

class RepositoryPolicy {
  authorizeRepository(repoPath, { branch } = {}) {
    const candidate = realDirectory(repoPath);
    if (candidate === path.parse(candidate).root || candidate === os.homedir()) {
      throw new RepositoryPolicyError(
        "VisionOwl cannot analyze a filesystem root or the user home directory.",
        "repository_path_too_broad",
      );
    }
    return {
      id: path.basename(candidate),
      path: candidate,
      branch: branch ? String(branch).trim() : undefined,
    };
  }

  authorizeProject(project, { branch } = {}) {
    if (!project || typeof project.repoPath !== "string") {
      throw new RepositoryPolicyError(
        "Project does not contain a local repository binding.",
        "project_repository_missing",
      );
    }
    return this.authorizeRepository(project.repoPath, {
      branch: branch || project.branch || undefined,
    });
  }

  assertBranch(entry, branch) {
    if (!branch) {
      throw new RepositoryPolicyError(
        `Repository "${entry.id}" is not checked out on a named branch.`,
        "repository_branch_missing",
      );
    }
    if (entry.branch && entry.branch !== branch) {
      throw new RepositoryPolicyError(
        `Repository "${entry.id}" is checked out on "${branch}", but this Project is bound to "${entry.branch}".`,
        "repository_branch_changed",
      );
    }
    return branch;
  }
}

module.exports = {
  RepositoryPolicy,
  RepositoryPolicyError,
};
