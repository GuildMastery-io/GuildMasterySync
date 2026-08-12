import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Auto-update via electron-updater, wired to the GitHub Releases feed that
 * electron-builder already publishes (`latest.yml` + installer per release).
 *
 * Behaviour: silent background check on launch and once every 24h. When a newer
 * release is found it downloads automatically; the renderer then shows a
 * "restart to update" banner. Nothing is installed until the user clicks it
 * (or the app quits naturally — autoInstallOnAppQuit).
 *
 * NOTE: electron-updater only sees *published* GitHub releases, not drafts.
 * The build publishes as `releaseType: draft`, so a release must be published
 * on GitHub before clients pick it up.
 */

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  /** Version of the pending/available release, when known. */
  version?: string
  /** Download progress 0–100, only while state === 'downloading'. */
  percent?: number
  /** Human-readable detail (error text, etc.). */
  message?: string
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // once per day
const INITIAL_DELAY_MS = 10 * 1000           // let the app settle after launch

let win: BrowserWindow | null = null
let interval: NodeJS.Timeout | null = null
let initialTimer: NodeJS.Timeout | null = null
let lastStatus: UpdateStatus = { state: 'idle' }
let downloaded = false

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const line = `[${ts}] ${msg}`
  console.log(line)
  try { win?.webContents.send('app-log', line) } catch { /* renderer gone */ }
}

function send(status: UpdateStatus) {
  lastStatus = status
  try { win?.webContents.send('update-status', status) } catch { /* renderer gone */ }
}

/** Wire the electron-updater event handlers once. */
function wireEvents() {
  autoUpdater.autoDownload = true          // pull the installer in the background
  autoUpdater.autoInstallOnAppQuit = true  // fallback: install on next natural quit
  autoUpdater.logger = {
    info: (m: unknown) => log(`[update] ${String(m)}`),
    warn: (m: unknown) => log(`[update] ⚠ ${String(m)}`),
    error: (m: unknown) => log(`[update] ✖ ${String(m)}`),
    debug: () => { /* too noisy */ },
  }

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    log(`[update] New version available: ${info.version}`)
    send({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => send({ state: 'not-available' }))

  autoUpdater.on('download-progress', (p) => {
    send({ state: 'downloading', percent: Math.round(p.percent), version: lastStatus.version })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true
    log(`[update] Version ${info.version} ready — restart to install.`)
    send({ state: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    log(`[update] Error: ${err == null ? 'unknown' : (err.message || String(err))}`)
    send({ state: 'error', message: err?.message ?? String(err) })
  })
}

/** Initialise the updater and schedule the daily check. Safe to call once. */
export function initUpdater(window: BrowserWindow) {
  win = window

  // Auto-update only works from a packaged build; in dev there is no feed.
  if (!app.isPackaged) {
    log('[update] Dev build — auto-update disabled.')
    send({ state: 'idle' })
    return
  }

  wireEvents()

  initialTimer = setTimeout(() => { void checkForUpdates(false) }, INITIAL_DELAY_MS)
  interval = setInterval(() => { void checkForUpdates(false) }, CHECK_INTERVAL_MS)
}

/** Trigger a check. `manual` distinguishes a user-clicked check from the timer. */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (manual) send({ state: 'not-available' })
    return
  }
  if (downloaded) {
    // Already have an installer waiting — no point re-checking.
    send({ state: 'downloaded', version: lastStatus.version })
    return
  }
  try {
    if (manual) log('[update] Manual check for updates…')
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`[update] Check failed: ${message}`)
    send({ state: 'error', message })
  }
}

/** Quit and install the downloaded update. No-op if nothing is ready. */
export function quitAndInstallUpdate(): void {
  if (!downloaded) return
  log('[update] Restarting to install update…')
  // isSilent=false (show installer progress), isForceRunAfter=true (relaunch).
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

/** Latest status for late renderer subscribers. */
export function getUpdateStatus(): UpdateStatus {
  return lastStatus
}

/** Tear down timers (called on quit). */
export function stopUpdater() {
  if (interval) { clearInterval(interval); interval = null }
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null }
}
