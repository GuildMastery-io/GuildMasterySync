import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

export interface AppSettings {
  wowPath: string
  apiUrl: string
  autoStart: boolean
  apiKey: string
  lastSync: string
}

export interface SyncStatus {
  status: 'watching' | 'syncing' | 'success' | 'duplicate' | 'error' | 'waiting'
  message: string
  time?: string
  sessionCount?: number | string
  exportTimestamp?: string
  duplicate?: boolean
}

export interface ConnectionResult {
  server: { ok: boolean; message: string }
  apiKey: { ok: boolean | null; message: string }
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
}

const SYNC_CHANNEL = 'sync-status'
const LOG_CHANNEL = 'app-log'
const UPDATE_CHANNEL = 'update-status'

const api = {
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('get-settings'),

  saveSettings: (settings: AppSettings): Promise<true> =>
    ipcRenderer.invoke('save-settings', settings),

  selectWowPath: (): Promise<string | null> =>
    ipcRenderer.invoke('select-wow-path'),

  forceSync: (): Promise<true> =>
    ipcRenderer.invoke('force-sync'),

  testConnection: (args: { apiUrl: string; apiKey: string }): Promise<ConnectionResult> =>
    ipcRenderer.invoke('test-connection', args),

  onSyncStatus: (cb: (status: SyncStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: SyncStatus) => cb(data)
    ipcRenderer.on(SYNC_CHANNEL, listener)
    return () => ipcRenderer.off(SYNC_CHANNEL, listener)
  },

  onLog: (cb: (line: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, line: string) => cb(line)
    ipcRenderer.on(LOG_CHANNEL, listener)
    return () => ipcRenderer.off(LOG_CHANNEL, listener)
  },

  // ── Auto-update ──────────────────────────────────────────────
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('get-app-version'),

  getUpdateStatus: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke('get-update-status'),

  checkForUpdates: (): Promise<true> =>
    ipcRenderer.invoke('check-for-updates'),

  installUpdate: (): Promise<true> =>
    ipcRenderer.invoke('install-update'),

  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: UpdateStatus) => cb(data)
    ipcRenderer.on(UPDATE_CHANNEL, listener)
    return () => ipcRenderer.off(UPDATE_CHANNEL, listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type GuildMasterySyncApi = typeof api
