"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const QODERWORK_DWS = path.join(os.homedir(), ".qoderwork", "bin", "dws");
const REAL_DWS = path.join(os.homedir(), ".real", ".bin", "dws", "bin", "dws");
const DWS_AUTH_REQUIRED = "dws_auth_required";

function dwsBinary() {
  if (process.env.DWS_BIN) return process.env.DWS_BIN;
  if (fs.existsSync(QODERWORK_DWS)) return QODERWORK_DWS;
  return fs.existsSync(REAL_DWS) ? REAL_DWS : "dws";
}

function runDws(args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(dwsBinary(), args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(
        new Error(
          error.code === "ENOENT"
            ? "未找到 DWS CLI，请安装 DWS 或设置 DWS_BIN。"
            : error.message,
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout).trim() || `dws exited with ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function deepValue(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = deepValue(item, keys);
    if (found) return found;
  }
  return undefined;
}

async function withContentFile(content, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-dingtalk-"));
  const file = path.join(root, "document.md");
  fs.writeFileSync(file, content, "utf8");
  try {
    return await callback(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

class DingTalkDocuments {
  constructor({ run = runDws } = {}) {
    this.run = run;
  }

  async status() {
    const raw = await this.run(["auth", "status", "--format", "json"]);
    const value = parseJson(raw) || {};
    return {
      authenticated: value.authenticated === true,
      message: value.message || (value.authenticated ? "已登录" : "未登录"),
    };
  }

  async assertAuthenticated() {
    const status = await this.status();
    if (!status.authenticated) {
      throw Object.assign(
        new Error(
          "DWS 尚未登录，无法创建或更新钉钉文档。请先完成 DWS OAuth 认证后重试。",
        ),
        { code: DWS_AUTH_REQUIRED, status: 401 },
      );
    }
    return status;
  }

  async create({ name, content }) {
    await this.assertAuthenticated();
    const raw = await withContentFile(content, (file) => {
      const args = [
        "doc",
        "create",
        "--name",
        name,
        "--content-file",
        file,
        "--format",
        "json",
        "--yes",
      ];
      if (process.env.VISIONOWL_DINGTALK_FOLDER) {
        args.push("--folder", process.env.VISIONOWL_DINGTALK_FOLDER);
      } else if (process.env.VISIONOWL_DINGTALK_WORKSPACE) {
        args.push("--workspace", process.env.VISIONOWL_DINGTALK_WORKSPACE);
      }
      return this.run(args);
    });
    const value = parseJson(raw) || {};
    const nodeId = deepValue(value, ["nodeId", "node_id", "uuid", "id"]);
    const url =
      deepValue(value, ["url", "docUrl", "doc_url", "link"]) ||
      (nodeId ? `https://alidocs.dingtalk.com/i/nodes/${nodeId}` : "");
    if (!nodeId || !url) {
      throw new Error("钉钉文档已创建，但 DWS 没有返回可挂载的文档节点。");
    }
    return { nodeId, url, raw: value };
  }

  async read(node) {
    await this.assertAuthenticated();
    const raw = await this.run([
      "doc",
      "read",
      "--node",
      node,
      "--format",
      "raw",
    ]);
    const value = parseJson(raw);
    return typeof value?.markdown === "string" ? value.markdown : raw;
  }

  async overwrite(node, content) {
    await this.assertAuthenticated();
    await withContentFile(content, (file) =>
      this.run([
        "doc",
        "update",
        "--node",
        node,
        "--content-file",
        file,
        "--mode",
        "overwrite",
        "--yes",
        "--format",
        "json",
      ]),
    );
  }
}

module.exports = {
  DWS_AUTH_REQUIRED,
  DingTalkDocuments,
  dwsBinary,
  runDws,
};
