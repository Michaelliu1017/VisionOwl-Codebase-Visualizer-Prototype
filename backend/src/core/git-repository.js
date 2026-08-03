"use strict";

const { execFile } = require("node:child_process");
const { realDirectory } = require("../security/path-guard");

function git(repoPath, args) {
  const safeRepoPath = realDirectory(repoPath);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", safeRepoPath, ...args],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              String(stderr || stdout || error.message).trim() ||
                `git ${args.join(" ")} failed`,
            ),
          );
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

async function repositoryState(repoPath, preferredBranch) {
  const currentBranch = await git(repoPath, ["branch", "--show-current"]);
  if (preferredBranch && currentBranch && currentBranch !== preferredBranch) {
    throw new Error(
      `Repository is checked out on "${currentBranch}", but project policy requires "${preferredBranch}".`,
    );
  }
  const branch = preferredBranch || currentBranch || "master";
  const commit = await git(repoPath, ["rev-parse", `refs/heads/${branch}`]);
  return { branch, commit };
}

async function changedFiles(repoPath, before, after) {
  if (!before || !after || before === after) return [];
  const output = await git(repoPath, [
    "diff",
    "--name-status",
    "--find-renames",
    before,
    after,
    "--",
  ]);
  if (!output) return [];
  return output.split(/\r?\n/).flatMap((line) => {
    const values = line.split("\t");
    const status = values[0] || "M";
    const paths = status.startsWith("R") ? values.slice(1, 3) : values.slice(1, 2);
    return paths.filter(Boolean).map((file) => ({ status, file }));
  });
}

module.exports = {
  changedFiles,
  git,
  repositoryState,
};
