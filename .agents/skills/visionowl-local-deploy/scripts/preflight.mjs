#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "../../../..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function command(commandName, args = ["--version"]) {
  const result = spawnSync(commandName, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split("\n")[0];
}

function atLeast(version, minimum) {
  const current = String(version).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!current) return false;
  const parts = current.slice(1).map((value) => Number(value || 0));
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
}

function gitValue(repoPath, args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function row(name, status, detail, required = true) {
  return { name, status, detail, required };
}

const packageFile = path.join(projectRoot, "package.json");
let packageName = "";
try {
  packageName = JSON.parse(fs.readFileSync(packageFile, "utf8")).name || "";
} catch (_error) {
  // Reported below as a hard failure.
}

const npmVersion = command("npm");
const gitVersion = command("git");
let pythonPath = process.env.PYTHON_BIN || "";
try {
  const { python310Binary } = require(
    path.join(projectRoot, "backend/src/core/direct-understand-engine.js"),
  );
  pythonPath ||= python310Binary();
} catch (_error) {
  pythonPath ||= "python3";
}
const pythonVersion = command(pythonPath);
const targetInput = argument("--repo") || projectRoot;
const targetRoot = fs.existsSync(targetInput)
  ? gitValue(path.resolve(targetInput), ["rev-parse", "--show-toplevel"])
  : "";
const targetBranch = targetRoot
  ? gitValue(targetRoot, ["branch", "--show-current"])
  : "";

let understandPath = "";
try {
  const { findUnderstandSkillPath } = require(
    path.join(projectRoot, "backend/src/core/understand-anything.js"),
  );
  understandPath = findUnderstandSkillPath();
} catch (_error) {
  // Optional for startup, required before repository analysis.
}

let dwsPath = "";
let dwsAuthenticated = false;
try {
  const { dwsBinary } = require(
    path.join(projectRoot, "backend/src/core/dingtalk-documents.js"),
  );
  dwsPath = dwsBinary();
  const status = spawnSync(dwsPath, ["auth", "status", "--format", "json"], {
    encoding: "utf8",
  });
  if (status.status === 0) {
    dwsAuthenticated = JSON.parse(status.stdout).authenticated === true;
  }
} catch (_error) {
  // DingTalk document automation is optional.
}

const codexPath = process.env.CODEX_BIN ||
  (fs.existsSync("/Applications/ChatGPT.app/Contents/Resources/codex")
    ? "/Applications/ChatGPT.app/Contents/Resources/codex"
    : command("codex", ["--version"])
      ? "codex"
      : "");

const checks = [
  row("VisionOwl workspace", packageName === "visionowl", projectRoot),
  row("Node.js >= 22.5", atLeast(process.versions.node, [22, 5, 0]), process.versions.node),
  row("npm", Boolean(npmVersion), npmVersion || "not found"),
  row("Git", Boolean(gitVersion), gitVersion || "not found"),
  row(
    "Python >= 3.10",
    atLeast(pythonVersion, [3, 10, 0]),
    pythonVersion ? `${pythonVersion} (${pythonPath})` : "not found",
  ),
  row(
    "Target repository",
    Boolean(targetRoot) && targetRoot !== "/" && targetRoot !== os.homedir(),
    targetRoot || "not a Git repository",
  ),
  row("Target branch", Boolean(targetBranch), targetBranch || "detached or unavailable"),
  row("npm dependencies", fs.existsSync(path.join(projectRoot, "node_modules")), fs.existsSync(path.join(projectRoot, "node_modules")) ? "installed" : "run npm ci", false),
  row("Understand Anything", Boolean(understandPath), understandPath || "not installed", false),
  row("Codex", Boolean(codexPath), codexPath || "deterministic mode only", false),
  row("DWS", Boolean(dwsPath && (dwsPath !== "dws" || command("dws", ["--version"]))), dwsPath ? `${dwsPath}; authenticated=${dwsAuthenticated}` : "not installed", false),
];

console.log("VisionOwl local deployment preflight\n");
for (const check of checks) {
  const marker = check.status ? "PASS" : check.required ? "FAIL" : "OPTIONAL";
  console.log(`${marker.padEnd(8)} ${check.name}: ${check.detail}`);
}

const failed = checks.filter((check) => check.required && !check.status);
if (failed.length > 0) {
  console.error(`\nPreflight failed: ${failed.map((check) => check.name).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nPreflight passed.");
}
