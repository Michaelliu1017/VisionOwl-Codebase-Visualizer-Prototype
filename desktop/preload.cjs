"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("visionOwlDesktop", {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke("visionowl:pick-directory"),
  localApiToken: () => ipcRenderer.invoke("visionowl:local-api-token"),
  cloudApiUrl: () => ipcRenderer.invoke("visionowl:cloud-api-url"),
  setCloudApiUrl: (value) => ipcRenderer.invoke("visionowl:cloud-api-url:set", value),
  getCloudSession: () => ipcRenderer.invoke("visionowl:cloud-session:get"),
  setCloudSession: (value) => ipcRenderer.invoke("visionowl:cloud-session:set", value),
  clearCloudSession: () => ipcRenderer.invoke("visionowl:cloud-session:clear"),
  startDwsAuthentication: () => ipcRenderer.invoke("visionowl:dws-auth:start"),
});
