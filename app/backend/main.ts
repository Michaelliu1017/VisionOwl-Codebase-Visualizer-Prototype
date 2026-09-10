import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import {
  getDwsStatus,
  loginDws,
  logoutDwsProfile,
  publishDwsDocument,
  switchDwsProfile,
  type DwsPublishInput
} from './dws'

function registerIpc(): void {
  ipcMain.handle('visionowl:dws:status', () => getDwsStatus())
  ipcMain.handle('visionowl:dws:login', () => loginDws())
  ipcMain.handle('visionowl:dws:switch-profile', (_event, profile: string) => switchDwsProfile(profile))
  ipcMain.handle('visionowl:dws:logout-profile', (_event, profile: string) => logoutDwsProfile(profile))
  ipcMain.handle('visionowl:dws:publish', (_event, input: DwsPublishInput) => publishDwsDocument(input))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1160,
    minHeight: 720,
    show: false,
    backgroundColor: '#050605',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // 外链一律交系统浏览器,渲染层不允许开新窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
