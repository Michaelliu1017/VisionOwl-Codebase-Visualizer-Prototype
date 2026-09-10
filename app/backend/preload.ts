import { contextBridge, ipcRenderer } from 'electron'

// 白名单桥:MVP 仅暴露平台与版本信息;
// 后续 token 安全存储(safeStorage)、窗口控制等能力一律经此扩展,禁止直通 Node API。
contextBridge.exposeInMainWorld('visionowl', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  dws: {
    status: () => ipcRenderer.invoke('visionowl:dws:status'),
    login: () => ipcRenderer.invoke('visionowl:dws:login'),
    switchProfile: (profile: string) => ipcRenderer.invoke('visionowl:dws:switch-profile', profile),
    logoutProfile: (profile: string) => ipcRenderer.invoke('visionowl:dws:logout-profile', profile),
    publish: (input: unknown) => ipcRenderer.invoke('visionowl:dws:publish', input)
  }
})
