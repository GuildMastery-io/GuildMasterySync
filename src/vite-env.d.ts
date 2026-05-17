/// <reference types="vite/client" />

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

export interface GuildMasterySyncApi {
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<true>
  selectWowPath(): Promise<string | null>
  forceSync(): Promise<true>
  testConnection(args: { apiUrl: string; apiKey: string }): Promise<ConnectionResult>
  onSyncStatus(cb: (status: SyncStatus) => void): () => void
  onLog(cb: (line: string) => void): () => void
}

declare global {
  interface Window {
    api: GuildMasterySyncApi
  }
}
