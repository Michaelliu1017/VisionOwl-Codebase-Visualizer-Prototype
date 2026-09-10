"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("visionowl", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  dws: {
    status: () => electron.ipcRenderer.invoke("visionowl:dws:status"),
    login: () => electron.ipcRenderer.invoke("visionowl:dws:login"),
    switchProfile: (profile) => electron.ipcRenderer.invoke("visionowl:dws:switch-profile", profile),
    logoutProfile: (profile) => electron.ipcRenderer.invoke("visionowl:dws:logout-profile", profile),
    publish: (input) => electron.ipcRenderer.invoke("visionowl:dws:publish", input)
  }
});
