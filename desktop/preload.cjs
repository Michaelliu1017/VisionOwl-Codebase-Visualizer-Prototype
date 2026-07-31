"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("visionOwlDesktop", {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke("visionowl:pick-directory"),
});
