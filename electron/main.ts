import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import * as path from 'path'
import { store } from './store'
import { startWatching, stopWatching, forceSync, testConnection } from './watcher'
import { initUpdater, checkForUpdates, quitAndInstallUpdate, getUpdateStatus, stopUpdater } from './updater'

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null = null
let autoSyncInterval: NodeJS.Timeout | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC || '', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    width: 820,
    height: 760,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#141517',
      symbolColor: '#c1c2c5',
      height: 44,
    },
  })

  // Block any attempt to open new windows or navigate away — defense in depth.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return
    event.preventDefault()
  })

  // ── IPC handlers ─────────────────────────────────────────────
  ipcMain.handle('get-settings', () => store.store)

  ipcMain.handle('save-settings', (_, newSettings) => {
    const prevPath = store.get('wowPath')
    store.store = newSettings
    if (newSettings.autoStart) {
      app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe') })
    } else {
      app.setLoginItemSettings({ openAtLogin: false })
    }
    // Only restart watcher if the path actually changed
    if (newSettings.wowPath !== prevPath && win) {
      startWatching(win)
    }
    return true
  })

  ipcMain.handle('select-wow-path', async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (!result.canceled) return result.filePaths[0]
    return null
  })

  ipcMain.handle('force-sync', async () => {
    if (win) await forceSync(win, true)
    return true
  })

  ipcMain.handle('test-connection', async (_, { apiUrl, apiKey }: { apiUrl: string; apiKey: string }) =>
    testConnection(apiUrl, apiKey)
  )

  // ── Auto-update ──────────────────────────────────────────────
  ipcMain.handle('get-app-version', () => app.getVersion())
  ipcMain.handle('get-update-status', () => getUpdateStatus())
  ipcMain.handle('check-for-updates', async () => { await checkForUpdates(true); return true })
  ipcMain.handle('install-update', () => { quitAndInstallUpdate(); return true })

  // Auto-sync poll: 60s, no overlap (per-file mutex inside forceSync/processFile).
  autoSyncInterval = setInterval(() => {
    if (win && !win.isDestroyed()) void forceSync(win, false)
  }, 60 * 1000)

  startWatching(win)
  initUpdater(win)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(process.env.DIST || '', 'index.html'))
  }
}

function cleanup() {
  if (autoSyncInterval) { clearInterval(autoSyncInterval); autoSyncInterval = null }
  stopUpdater()
  stopWatching()
}

app.on('window-all-closed', () => {
  cleanup()
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})
app.on('before-quit', cleanup)

app.whenReady().then(createWindow)
