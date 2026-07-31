"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");

const API_HOST = "127.0.0.1";
const API_PORT = 17300;
const API_URL = `http://${API_HOST}:${API_PORT}`;
let backend;

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
      const response = await fetch(`${API_URL}/api/health`);
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
