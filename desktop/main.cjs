"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require("electron");
const { createDwsAuthCoordinator } = require("./dws-auth.cjs");

const API_HOST = "127.0.0.1";
const API_PORT = 17300;
const API_URL = `http://${API_HOST}:${API_PORT}`;
const DEFAULT_CLOUD_API_URL = (process.env.VISIONOWL_CLOUD_API_URL || "http://127.0.0.1:17800").replace(/\/$/, "");
const LOCAL_API_TOKEN = randomBytes(32).toString("base64url");
const dwsAuth = createDwsAuthCoordinator();
let backend;

function cloudSessionPath() {
  return path.join(app.getPath("userData"), "cloud-session.enc");
}

function cloudConfigPath() {
  return path.join(app.getPath("userData"), "cloud-config.json");
}

function validateCloudApiUrl(value) {
  const url = new URL(String(value || "").trim());
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Cloud API must use HTTPS. HTTP is allowed only for local development.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readCloudApiUrl() {
  try {
    const value = JSON.parse(fs.readFileSync(cloudConfigPath(), "utf8"));
    return validateCloudApiUrl(value.apiUrl);
  } catch (_error) {
    return DEFAULT_CLOUD_API_URL;
  }
}

function writeCloudApiUrl(value) {
  const apiUrl = validateCloudApiUrl(value);
  const configFile = cloudConfigPath();
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, `${JSON.stringify({ apiUrl }, null, 2)}\n`, { mode: 0o600 });
  clearCloudSession();
  return apiUrl;
}

function readCloudSession() {
  const sessionFile = cloudSessionPath();
  if (!fs.existsSync(sessionFile) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = fs.readFileSync(sessionFile);
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch (_error) {
    return null;
  }
}

function writeCloudSession(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("System credential encryption is unavailable.");
  }
  const sessionFile = cloudSessionPath();
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    sessionFile,
    safeStorage.encryptString(JSON.stringify(value)),
    { mode: 0o600 },
  );
  return true;
}

function clearCloudSession() {
  try {
    fs.unlinkSync(cloudSessionPath());
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return true;
}

function projectRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : path.resolve(__dirname, "..");
}

function startBackend() {
  const root = projectRoot();
  backend = spawn(process.execPath, [path.join(root, "backend", "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOST: API_HOST,
      PORT: String(API_PORT),
      PUBLIC_ROOT: path.join(root, "frontend", "dist"),
      VISIONOWL_DB: path.join(app.getPath("userData"), "visionowl.db"),
      VISIONOWL_LOCAL_TOKEN: LOCAL_API_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.on("data", (chunk) => process.stdout.write(chunk));
  backend.stderr.on("data", (chunk) => process.stderr.write(chunk));
  backend.on("exit", (code, signal) => {
    if (!app.isQuitting) {
      console.error(`VisionOwl backend stopped: code=${code} signal=${signal}`);
    }
  });
}

async function waitForBackend(timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${API_URL}/api/health`, {
        headers: { "X-VisionOwl-Local-Token": LOCAL_API_TOKEN },
      });
      if (response.ok) return;
    } catch (_error) {
      // The local server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error("VisionOwl local API did not become ready.");
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#050605",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(API_URL);
}

ipcMain.handle("visionowl:pick-directory", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择需要分析的代码仓库",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle("visionowl:local-api-token", () => LOCAL_API_TOKEN);
ipcMain.handle("visionowl:cloud-api-url", () => readCloudApiUrl());
ipcMain.handle("visionowl:cloud-api-url:set", (_event, value) => writeCloudApiUrl(value));
ipcMain.handle("visionowl:cloud-session:get", () => readCloudSession());
ipcMain.handle("visionowl:cloud-session:set", (_event, value) => writeCloudSession(value));
ipcMain.handle("visionowl:cloud-session:clear", () => clearCloudSession());
ipcMain.handle("visionowl:dws-auth:start", () => dwsAuth.start());

app.whenReady().then(async () => {
  startBackend();
  try {
    await waitForBackend();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox("VisionOwl 启动失败", error.message);
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (backend && !backend.killed) backend.kill("SIGTERM");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
