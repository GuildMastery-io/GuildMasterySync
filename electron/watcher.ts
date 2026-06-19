import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import chokidar, { FSWatcher } from 'chokidar'
import axios from 'axios'
import { getStoreValue, setStoreValue, type FileSyncState } from './store'
import { pruneOldSessions, RETENTION_DAYS } from './retention'
import { BrowserWindow } from 'electron'

let watcher: FSWatcher | null = null
let watchedPath: string | null = null
const lastSyncedHashes = new Map<string, string>()
const inFlight = new Set<string>()
let _logWin: BrowserWindow | null = null

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const line = `[${ts}] ${msg}`
  console.log(line)
  try { _logWin?.webContents.send('app-log', line) } catch { /* renderer gone */ }
}

/** Validate that an apiUrl is syntactically a URL and uses http(s). Returns the normalized origin or null. */
function validateApiUrl(raw: string): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return raw.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Unescape a Lua double-quoted string literal body to its raw text. */
function unescapeLuaString(s: string): string {
  return s.replace(/\\(\d{1,3}|x[0-9a-fA-F]{2}|.)/g, (_, esc) => {
    switch (esc) {
      case '\\': return '\\'
      case '"':  return '"'
      case "'":  return "'"
      case 'n':  return '\n'
      case 'r':  return '\r'
      case 't':  return '\t'
      case 'a':  return '\x07'
      case 'b':  return '\b'
      case 'f':  return '\f'
      case 'v':  return '\v'
      case '0':  return '\0'
    }
    if (esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16))
    if (/^\d+$/.test(esc))   return String.fromCharCode(parseInt(esc, 10))
    return esc
  })
}

/** Extract the value of the `syncPayload` field from the SavedVariables Lua file. */
function extractSyncPayload(luaContent: string): string | null {
  const lines = luaContent.split('\n')
  const line = lines.find(l => l.includes('"syncPayload"') || l.includes('["syncPayload"]'))
  if (!line) return null

  const eqIdx = line.indexOf('= "')
  if (eqIdx === -1) return null
  const tail = line.slice(eqIdx + 3).trimEnd()
  const body = tail.endsWith('",') ? tail.slice(0, -2) : tail.endsWith('"') ? tail.slice(0, -1) : tail
  return unescapeLuaString(body)
}

// ── Incremental sync (v2) ───────────────────────────────────────────
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000 // manifest safety net, once per day

interface V2Session {
  id?: string
  session?: number
  item_id?: number
  looted_at?: number
  updated_at?: number
  [k: string]: unknown
}

/** Stable per-entry identity. SHARED formula with the server and the addon:
 *  `${looted_at}_${session}_${item_id}`. The v2 addon already provides `id`. */
function entryIdOf(s: V2Session): string {
  if (typeof s.id === 'string' && s.id.length > 0) return s.id
  const looted = typeof s.looted_at === 'number' && s.looted_at > 0 ? s.looted_at : 0
  return `${looted}_${s.session ?? 0}_${s.item_id ?? 0}`
}

/** Per-entry content hash — MUST match the server
 *  (`computeEntryHash`: sha256(JSON.stringify(s)).slice(0,16)). */
function entryHashOf(s: V2Session): string {
  return crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16)
}

/** Detects a v2 (incremental sync) payload. */
function isV2Payload(payload: any): boolean {
  if (payload?.version && parseInt(String(payload.version), 10) >= 2) return true
  return Array.isArray(payload?.sessions) && payload.sessions.some((s: any) => typeof s?.id === 'string')
}

/**
 * Incremental sync of a v2 payload.
 *  - Manifest safety net (startup + once per day, or `force`): GET the server
 *    manifest; on drift → full reconcile (is_full_sync), otherwise nothing.
 *  - Otherwise: delta — only sends entries whose hash differs from the acked one.
 * State (acked hashes + last reconcile) is persisted per file.
 */
async function processV2(filePath: string, win: BrowserWindow, payload: any, force: boolean) {
  const apiUrl = validateApiUrl(getStoreValue('apiUrl'))
  const apiKey = getStoreValue('apiKey')
  if (!apiUrl) throw new Error('Invalid API URL — must start with http:// or https://')
  if (!apiKey) throw new Error('Missing API key — set it in the configuration.')

  const sessions: V2Session[] = Array.isArray(payload.sessions) ? payload.sessions : []

  // Local map id → { hash, session } (plain object: no Map iteration)
  const current: Record<string, { hash: string; session: V2Session }> = {}
  for (const s of sessions) current[entryIdOf(s)] = { hash: entryHashOf(s), session: s }

  const allState = (getStoreValue('syncState') ?? {}) as Record<string, FileSyncState>
  const st: FileSyncState = allState[filePath] ?? { ackedHashes: {}, lastReconcile: 0 }

  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
  const reconcileNeeded = force || (Date.now() - st.lastReconcile > RECONCILE_INTERVAL_MS)

  // ── Safety net: manifest reconciliation ────────────────────────────
  if (reconcileNeeded) {
    log(`[processV2] Manifest reconciliation (${sessions.length} local entries)…`)
    const manRes = await axios.get(`${apiUrl}/api/loot-sessions/manifest`, { headers, timeout: 30000 })
    const serverManifest: Record<string, string> = manRes.data?.entries ?? {}

    // Drift = a local entry missing/hash-mismatched on the server, OR a server orphan.
    let drift = false
    for (const [id, { hash }] of Object.entries(current)) {
      if (serverManifest[id] !== hash) { drift = true; break }
    }
    if (!drift) {
      for (const id of Object.keys(serverManifest)) {
        if (!(id in current)) { drift = true; break }
      }
    }

    if (drift) {
      log(`[processV2] Drift detected → full reconcile (is_full_sync).`)
      const res = await axios.post(
        `${apiUrl}/api/loot-sessions`,
        { ...payload, version: '2', is_full_sync: true },
        { headers, timeout: 30000 },
      )
      assertJson(res)
    } else {
      log(`[processV2] No drift — already in sync with the server.`)
    }

    // State aligned to the current local state.
    const ackedHashes: Record<string, string> = {}
    for (const [id, { hash }] of Object.entries(current)) ackedHashes[id] = hash
    allState[filePath] = { ackedHashes, lastReconcile: Date.now() }
    setStoreValue('syncState', allState)
    finishOk(win, sessions.length, payload, drift ? 'reconcile' : 'noop')
    return
  }

  // ── Delta: only changed entries ────────────────────────────────────
  const changed: V2Session[] = []
  for (const [id, { hash, session }] of Object.entries(current)) {
    if (st.ackedHashes[id] !== hash) changed.push(session)
  }

  if (changed.length === 0) {
    log('[processV2] No changed entry — nothing to send.')
    win.webContents.send('sync-status', { status: 'watching', message: 'No new data (already synced).' })
    return
  }

  log(`[processV2] Delta: ${changed.length}/${sessions.length} changed entry(ies) → upsert.`)
  const res = await axios.post(
    `${apiUrl}/api/loot-sessions`,
    { version: '2', timestamp: payload.timestamp, is_full_sync: false, sessions: changed },
    { headers, timeout: 30000 },
  )
  assertJson(res)

  // Acknowledge sent entries + drop ids that disappeared locally (180d prune).
  const ackedHashes: Record<string, string> = {}
  for (const [id, { hash }] of Object.entries(current)) ackedHashes[id] = hash
  allState[filePath] = { ackedHashes, lastReconcile: st.lastReconcile }
  setStoreValue('syncState', allState)
  finishOk(win, changed.length, payload, 'delta')
}

/** Ensures an axios response is application JSON (guards against HTML middleware). */
function assertJson(res: any) {
  const contentType = res.headers?.['content-type'] ?? ''
  if (!contentType.includes('application/json') || typeof res.data !== 'object' || res.data === null) {
    throw new Error(`The server responded with non-JSON (HTTP ${res.status}).`)
  }
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`HTTP ${res.status} — ${JSON.stringify(res.data)}`)
  }
}

/** Notifies the renderer of a successful v2 sync + updates lastSync. */
function finishOk(win: BrowserWindow, count: number, payload: any, mode: 'delta' | 'reconcile' | 'noop') {
  const time = new Date().toLocaleString()
  setStoreValue('lastSync', time)
  const label =
    mode === 'delta' ? `${count} vote(s) synced (delta)`
    : mode === 'reconcile' ? `Full reconcile (${count} vote(s))`
    : `Already synced (${count} vote(s))`
  log(`[processV2] ✅ ${label}`)
  win.webContents.send('sync-status', {
    status: 'success', message: label, time,
    sessionCount: count, exportTimestamp: payload.timestamp ?? 'unknown', duplicate: false,
  })
}

export function startWatching(win: BrowserWindow) {
  _logWin = win
  const wowPath = getStoreValue('wowPath')

  if (!wowPath || !fs.existsSync(wowPath)) {
    if (watcher) { watcher.close(); watcher = null; watchedPath = null }
    log('[Watcher] Chemin WoW invalide, surveillance impossible.')
    win.webContents.send('sync-status', { status: 'error', message: 'Chemin WoW invalide' })
    return
  }

  // No-op if already watching the same path
  if (watcher && watchedPath === wowPath) return

  if (watcher) { watcher.close(); watcher = null }

  const targetFilePattern = path.join(wowPath, 'WTF', 'Account', '**', 'SavedVariables', 'RCLootCouncil_GuildMastery.lua')
  log(`[Watcher] Starting watch: ${targetFilePattern}`)

  watcher = chokidar.watch(targetFilePattern, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
  })
  watchedPath = wowPath

  watcher.on('add', (filePath: string) => {
    log(`[Watcher] File detected (add): ${filePath}`)
    void processFile(filePath, win)
  })
  watcher.on('change', (filePath: string) => {
    log(`[Watcher] File changed (change): ${filePath}`)
    void processFile(filePath, win)
  })

  win.webContents.send('sync-status', { status: 'watching', message: 'Waiting for data...' })
}

export function stopWatching() {
  if (watcher) {
    watcher.close()
    watcher = null
    watchedPath = null
  }
}

export interface ConnectionResult {
  server: { ok: boolean; message: string }
  /** null = not tested because the server is unreachable */
  apiKey: { ok: boolean | null; message: string }
}

function networkErrorMessage(err: any): string {
  const code: string = err.code ?? ''
  if (code === 'ENOTFOUND')    return `Address not found — check the URL`
  if (code === 'ECONNREFUSED') return 'Connection refused — server offline or wrong port'
  if (code === 'ECONNRESET')   return 'Connection reset by the server'
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || err.message?.includes('timeout'))
                               return 'Timed out — server unreachable or too slow'
  if (code?.startsWith('CERT') || code === 'ERR_TLS_CERT_ALTNAME_INVALID')
                               return "SSL certificate error — check the URL (http vs https)"
  return `Unable to reach the server (${err.message ?? 'unknown error'})`
}

export async function testConnection(apiUrl: string, apiKey: string): Promise<ConnectionResult> {
  const normalized = validateApiUrl(apiUrl)
  if (!normalized) {
    return {
      server: { ok: false, message: 'Invalid URL — must start with http:// or https://' },
      apiKey: { ok: null,  message: 'Not tested — invalid URL' },
    }
  }

  // ── Pass 1: server reachability (without key) ──────────────────
  let serverOk = false
  let serverMsg = ''
  try {
    const res = await axios.get(`${normalized}/api/health`, {
      timeout: 5000,
      validateStatus: () => true,
    })
    if (res.status < 500) {
      serverOk = true
      serverMsg = 'Server reachable'
    } else {
      serverMsg = `Internal server error (HTTP ${res.status})`
    }
  } catch (err: any) {
    serverMsg = networkErrorMessage(err)
  }

  if (!serverOk) {
    return {
      server: { ok: false, message: serverMsg },
      apiKey: { ok: null,  message: 'Not tested — server unreachable' },
    }
  }

  // ── Pass 2: API key validity ───────────────────────────────────
  if (!apiKey) {
    return {
      server: { ok: true, message: serverMsg },
      apiKey: { ok: false, message: 'No API key provided' },
    }
  }

  try {
    const res = await axios.get(`${normalized}/api/health`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 5000,
      validateStatus: () => true,
    })
    if (res.status === 401 || res.status === 403) {
      return {
        server: { ok: true,  message: serverMsg },
        apiKey: { ok: false, message: 'Invalid or unauthorized API key' },
      }
    }
    if (res.status === 200 || res.status === 204) {
      const body = res.data
      if (body?.ok === true && body?.guildId != null) {
        const label = body.guildName ?? `#${body.guildId}`
        return {
          server: { ok: true, message: serverMsg },
          apiKey: { ok: true, message: `Valid API key — ${label}` },
        }
      }
      return {
        server: { ok: true, message: serverMsg },
        apiKey: { ok: null, message: "Server reachable but key validation not supported — update the server" },
      }
    }
    return {
      server: { ok: true,  message: serverMsg },
      apiKey: { ok: false, message: `Unexpected response during validation (HTTP ${res.status})` },
    }
  } catch (err: any) {
    return {
      server: { ok: true,  message: serverMsg },
      apiKey: { ok: false, message: `Error while validating the key (${err.message ?? ''})` },
    }
  }
}

/** Scans the SavedVariables files and syncs them.
 *  If force=false (default for auto-detection), the sync only runs when the content changed (per-file hash). */
export async function forceSync(win: BrowserWindow, force = true) {
  _logWin = win
  const wowPath = getStoreValue('wowPath')
  if (!wowPath || !fs.existsSync(wowPath)) {
    win.webContents.send('sync-status', { status: 'error', message: 'Invalid WoW path' })
    return
  }

  const wtfPath = path.join(wowPath, 'WTF', 'Account')
  if (!fs.existsSync(wtfPath)) {
    win.webContents.send('sync-status', { status: 'error', message: `WTF/Account folder not found in ${wowPath}` })
    return
  }

  const luaFiles: string[] = []
  function findLuaFiles(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          findLuaFiles(fullPath)
        } else if (entry.name === 'RCLootCouncil_GuildMastery.lua') {
          luaFiles.push(fullPath)
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
  findLuaFiles(wtfPath)

  log(`[forceSync] force=${force} — ${luaFiles.length} file(s) found`)

  if (luaFiles.length === 0) {
    win.webContents.send('sync-status', {
      status: 'error',
      message: 'No RCLootCouncil_GuildMastery.lua file found in WTF/Account/*/SavedVariables/',
    })
    return
  }

  win.webContents.send('sync-status', {
    status: 'syncing',
    message: `${luaFiles.length} file(s) found, syncing…`,
  })

  for (const file of luaFiles) {
    await processFile(file, win, force)
  }
}

async function processFile(filePath: string, win: BrowserWindow, force = false) {
  // Mutex per file — silently skip if a sync is already in flight for this file.
  if (inFlight.has(filePath)) {
    log(`[processFile] Sync already in flight for ${path.basename(filePath)} — skip.`)
    return
  }
  inFlight.add(filePath)

  try {
    const fileStats = fs.statSync(filePath)
    log(`[processFile] Reading: ${path.basename(filePath)} (${fileStats.size} bytes, modified: ${fileStats.mtime.toLocaleString()})`)

    win.webContents.send('sync-status', { status: 'syncing', message: 'New data detected! Syncing...' })

    const luaContent = fs.readFileSync(filePath, 'utf-8')
    const rawJson = extractSyncPayload(luaContent)
    if (!rawJson) {
      throw new Error(
        "No full history (syncPayload) found in the Lua file.\n" +
        "Log in to the game or run a /reload to force generation."
      )
    }

    let payload: any
    try {
      payload = JSON.parse(rawJson)
    } catch (e: any) {
      throw new Error(`Failed to parse the Lua payload JSON: ${e.message}`)
    }
    if (!payload) throw new Error("Unable to parse JSON payload from Lua file.")

    // ── Retention safety-net: drop sessions older than RETENTION_DAYS days
    // BEFORE hashing and POSTing. The hash is computed on the filtered payload
    // so that a session crossing the threshold between two reads triggers a
    // re-sync (the server then receives a payload without it).
    const { payload: filtered, droppedCount } = pruneOldSessions(payload)
    if (droppedCount > 0) {
      log(`[Retention] ${droppedCount} session(s) > ${RETENTION_DAYS} days dropped before send`)
      payload = filtered
    }

    // ── Incremental sync v2 (addon >= v2) ─────────────────────────────
    // A v2 payload carries a stable `id` per entry → only the delta is sent
    // (plus a manifest reconciliation safety net). The v1 path below stays
    // intact for addons that are not upgraded yet.
    if (isV2Payload(payload)) {
      win.webContents.send('sync-status', { status: 'syncing', message: 'Incremental sync…' })
      await processV2(filePath, win, payload, force)
      return
    }

    const filteredJson = JSON.stringify(payload)
    const hash = crypto.createHash('sha1').update(filteredJson).digest('hex')
    const prev = lastSyncedHashes.get(filePath) ?? ''
    log(`[processFile] Hash: ${hash.slice(0, 12)}… | previous: ${prev ? prev.slice(0, 12) + '…' : '(empty)'} | force=${force}`)

    if (!force && hash === prev) {
      log(`[processFile] Identical content — no action.`)
      win.webContents.send('sync-status', {
        status: 'watching',
        message: 'No new data (already synced locally).',
      })
      return
    }

    const sessionCount = Array.isArray(payload.sessions) ? payload.sessions.length : '?'
    const exportTimestamp: string = payload.timestamp ?? 'unknown'
    const addonVersion: string = payload.version ?? '?'
    log(`[processFile] Payload → sessions: ${sessionCount} | timestamp: ${exportTimestamp} | addon: ${addonVersion}`)

    const apiUrl = validateApiUrl(getStoreValue('apiUrl'))
    const apiKey = getStoreValue('apiKey')

    if (!apiUrl) {
      throw new Error("Invalid API URL — must start with http:// or https://")
    }
    if (!apiKey) {
      throw new Error("Missing API key — set it in the configuration.")
    }

    const endpoint = `${apiUrl}/api/loot-sessions`
    log(`[processFile] Sending POST ${endpoint} ...`)

    const res = await axios.post(endpoint, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 30000,
    })

    log(`[processFile] Server response: HTTP ${res.status} → ${JSON.stringify(res.data).slice(0, 200)}`)

    const contentType = res.headers?.['content-type'] ?? ''
    if (!contentType.includes('application/json') || typeof res.data !== 'object' || res.data === null) {
      throw new Error(
        `The server responded with HTML instead of JSON (HTTP ${res.status}).\n` +
        `The middleware may be blocking the request — check the server configuration.`
      )
    }

    if (res.status === 200 || res.status === 201) {
      const isDuplicate = res.data?.duplicate === true
      lastSyncedHashes.set(filePath, hash)
      const time = new Date().toLocaleString()
      setStoreValue('lastSync', time)

      if (isDuplicate) {
        log(`[processFile] ⚠️ DUPLICATE — export already known by the server.`)
        win.webContents.send('sync-status', {
          status: 'duplicate',
          message: `Already synced (${sessionCount} vote(s) — duplicate on the server)`,
          time, sessionCount, exportTimestamp, duplicate: true,
        })
      } else {
        log(`[processFile] ✅ Sync successful! ${sessionCount} session(s).`)
        win.webContents.send('sync-status', {
          status: 'success',
          message: `${sessionCount} vote(s) synced`,
          time, sessionCount, exportTimestamp, duplicate: false,
        })
      }
    } else {
      throw new Error(`HTTP ${res.status} — ${JSON.stringify(res.data)}`)
    }

  } catch (error: any) {
    const errMsg = error?.response?.data?.message ?? error?.response?.data?.error ?? error.message ?? String(error)
    log(`[processFile] ❌ Error: ${errMsg}`)
    win.webContents.send('sync-status', {
      status: 'error',
      message: `Error: ${errMsg}`,
    })
  } finally {
    inFlight.delete(filePath)
  }
}
