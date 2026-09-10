"use strict";
const electron = require("electron");
const node_path = require("node:path");
const node_child_process = require("node:child_process");
const node_fs = require("node:fs");
const promises = require("node:fs/promises");
const node_os = require("node:os");
const DWS_AUTH_TIMEOUT_MS = 10 * 60 * 1e3;
const DWS_COMMAND_TIMEOUT_MS = 3 * 60 * 1e3;
let loginInFlight = null;
function packagedBinary() {
  return node_path.join(
    electron.app.getAppPath(),
    "node_modules",
    "dingtalk-workspace-cli",
    "vendor",
    process.platform === "win32" ? "dws.exe" : "dws"
  );
}
function dwsCandidates() {
  const executable = process.platform === "win32" ? "dws.exe" : "dws";
  return [
    process.env.DWS_BIN ?? "",
    packagedBinary(),
    node_path.join(process.cwd(), "node_modules", "dingtalk-workspace-cli", "vendor", executable),
    node_path.join(__dirname, "..", "..", "node_modules", "dingtalk-workspace-cli", "vendor", executable),
    node_path.join(node_os.homedir(), ".qoderwork", "bin", executable),
    node_path.join(node_os.homedir(), ".real", ".bin", "dws", "bin", executable),
    "dws"
  ].filter(Boolean);
}
async function dwsBinary() {
  for (const candidate of dwsCandidates()) {
    if (candidate === "dws") return candidate;
    if (!node_fs.existsSync(candidate)) continue;
    try {
      await promises.access(candidate, node_fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return "dws";
}
function cleanError(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/(access|refresh)[_-]?token["'=:\s]+[^\s",}]+/gi, "$1_token=***").trim();
}
function actionableDwsError(value) {
  const cleaned = cleanError(value);
  if (/ENTERPRISE_NOT_AUTHORIZED/i.test(cleaned)) {
    return "当前钉钉企业未授权 DWS 创建文档（ENTERPRISE_NOT_AUTHORIZED）。登录成功只代表身份有效，请切换到已授权的企业身份；若必须使用当前企业，请联系企业管理员开通文档写入授权后重试。";
  }
  return cleaned;
}
async function runDws(args, options = {}) {
  const binary = await dwsBinary();
  return new Promise((resolve, reject) => {
    const child = node_child_process.spawn(binary, args, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("DWS 操作超时，请重试"));
    }, options.timeoutMs ?? DWS_COMMAND_TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(new Error(error.code === "ENOENT" ? "未找到 DWS CLI，请重新安装桌面应用" : error.message));
    });
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(actionableDwsError(stderr || stdout) || `DWS 退出码 ${code ?? "unknown"}`));
    });
  });
}
function parseJson(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    const start = raw.indexOf("{");
    if (start < 0) return null;
    try {
      const value = JSON.parse(raw.slice(start));
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
}
function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
function deepString(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key)) {
      const found = stringValue(nested);
      if (found) return found;
    }
  }
  for (const nested of Object.values(value)) {
    const found = deepString(nested, keys);
    if (found) return found;
  }
  return null;
}
async function profileList() {
  const payload = parseJson(await runDws(["profile", "list", "--format", "json"]));
  const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
  return {
    currentProfile: stringValue(payload?.currentProfile) || null,
    profiles: profiles.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const profile = item;
      const selector = stringValue(profile.profile);
      if (!selector) return [];
      return [{
        profile: selector,
        corpId: stringValue(profile.corpId),
        corpName: stringValue(profile.corpName),
        userId: stringValue(profile.userId),
        userName: stringValue(profile.userName),
        status: stringValue(profile.status) || "active",
        isCurrent: profile.isCurrent === true
      }];
    })
  };
}
async function getDwsStatus() {
  try {
    const status = parseJson(await runDws(["auth", "status", "--format", "json"])) ?? {};
    const list = await profileList().catch(() => ({
      currentProfile: null,
      profiles: []
    }));
    if (status.authenticated === true && list.profiles.length === 0) {
      const corpId = stringValue(status.corp_id ?? status.corpId);
      const userId = stringValue(status.user_id ?? status.userId);
      const profile = [corpId, userId].filter(Boolean).join(":");
      if (profile) {
        list.currentProfile = profile;
        list.profiles.push({
          profile,
          corpId,
          corpName: stringValue(status.corp_name ?? status.corpName),
          userId,
          userName: stringValue(status.user_name ?? status.userName),
          status: "active",
          isCurrent: true
        });
      }
    }
    return {
      available: true,
      authenticated: status.authenticated === true,
      message: stringValue(status.message) || (status.authenticated === true ? "已登录" : "未登录"),
      currentProfile: list.currentProfile,
      profiles: list.profiles
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = /未找到 DWS|ENOENT|not found/i.test(message);
    return {
      available: !unavailable,
      authenticated: false,
      message,
      currentProfile: null,
      profiles: []
    };
  }
}
function loginDws() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    await runDws(["auth", "login", "--recommend"], { timeoutMs: DWS_AUTH_TIMEOUT_MS });
    const status = await getDwsStatus();
    if (!status.authenticated) throw new Error("钉钉授权未完成，请重新扫码登录");
    return status;
  })().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}
async function switchDwsProfile(profile) {
  if (!profile.trim()) throw new Error("钉钉身份不能为空");
  await runDws(["profile", "switch", profile, "--format", "json"]);
  return getDwsStatus();
}
async function logoutDwsProfile(profile) {
  if (!profile.trim()) throw new Error("钉钉身份不能为空");
  await runDws(["auth", "logout", "--profile", profile]);
  return getDwsStatus();
}
async function publishDwsDocument(input) {
  const title = input.title.trim();
  const profile = input.profile.trim();
  if (!profile) throw new Error("请先选择钉钉身份");
  if (!title) throw new Error("文档标题不能为空");
  if (!input.markdown.trim()) throw new Error("文档内容不能为空");
  if (input.markdown.length > 2e6) throw new Error("文档内容过大，暂不支持发布");
  const root = await promises.mkdtemp(node_path.join(node_os.tmpdir(), "visionowl-dingtalk-"));
  const markdownFile = node_path.join(root, "document.md");
  await promises.writeFile(markdownFile, input.markdown, "utf8");
  try {
    let nodeId = input.existingNodeId?.trim() || "";
    if (nodeId) {
      await runDws([
        "--profile",
        profile,
        "--format",
        "json",
        "--yes",
        "doc",
        "update",
        "--node",
        nodeId,
        "--content-file",
        markdownFile,
        "--mode",
        "overwrite"
      ]);
    } else {
      const args = [
        "--profile",
        profile,
        "--format",
        "json",
        "--yes",
        "doc",
        "create",
        "--name",
        title,
        "--content-file",
        markdownFile
      ];
      if (input.folderId?.trim()) args.push("--folder", input.folderId.trim());
      else if (input.workspaceId?.trim()) args.push("--workspace", input.workspaceId.trim());
      const created = parseJson(await runDws(args)) ?? {};
      nodeId = deepString(created, /* @__PURE__ */ new Set(["nodeId", "node_id", "uuid", "id"])) ?? "";
      if (!nodeId) throw new Error("钉钉文档已创建，但 DWS 未返回 nodeId");
    }
    await runDws([
      "--profile",
      profile,
      "doc",
      "read",
      "--node",
      nodeId,
      "--format",
      "raw"
    ]);
    return {
      nodeId,
      url: `https://alidocs.dingtalk.com/i/nodes/${encodeURIComponent(nodeId)}`
    };
  } finally {
    await promises.rm(root, { recursive: true, force: true }).catch(() => void 0);
  }
}
function registerIpc() {
  electron.ipcMain.handle("visionowl:dws:status", () => getDwsStatus());
  electron.ipcMain.handle("visionowl:dws:login", () => loginDws());
  electron.ipcMain.handle("visionowl:dws:switch-profile", (_event, profile) => switchDwsProfile(profile));
  electron.ipcMain.handle("visionowl:dws:logout-profile", (_event, profile) => logoutDwsProfile(profile));
  electron.ipcMain.handle("visionowl:dws:publish", (_event, input) => publishDwsDocument(input));
}
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1160,
    minHeight: 720,
    show: false,
    backgroundColor: "#050605",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      electron.shell.openExternal(url);
    }
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(() => {
  registerIpc();
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
