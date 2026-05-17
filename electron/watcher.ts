import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import chokidar, { FSWatcher } from 'chokidar'
import axios from 'axios'
import { getStoreValue, setStoreValue } from './store'
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
  log(`[Watcher] Démarrage surveillance : ${targetFilePattern}`)

  watcher = chokidar.watch(targetFilePattern, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
  })
  watchedPath = wowPath

  watcher.on('add', (filePath: string) => {
    log(`[Watcher] Fichier détecté (add) : ${filePath}`)
    void processFile(filePath, win)
  })
  watcher.on('change', (filePath: string) => {
    log(`[Watcher] Fichier modifié (change) : ${filePath}`)
    void processFile(filePath, win)
  })

  win.webContents.send('sync-status', { status: 'watching', message: 'En attente de données...' })
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
  /** null = non testé car serveur inaccessible */
  apiKey: { ok: boolean | null; message: string }
}

function networkErrorMessage(err: any): string {
  const code: string = err.code ?? ''
  if (code === 'ENOTFOUND')    return `Adresse introuvable — vérifiez l'URL`
  if (code === 'ECONNREFUSED') return 'Connexion refusée — serveur hors ligne ou mauvais port'
  if (code === 'ECONNRESET')   return 'Connexion interrompue par le serveur'
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || err.message?.includes('timeout'))
                               return 'Délai dépassé — serveur inaccessible ou trop lent'
  if (code?.startsWith('CERT') || code === 'ERR_TLS_CERT_ALTNAME_INVALID')
                               return "Erreur de certificat SSL — vérifiez l'URL (http vs https)"
  return `Impossible de joindre le serveur (${err.message ?? 'erreur inconnue'})`
}

export async function testConnection(apiUrl: string, apiKey: string): Promise<ConnectionResult> {
  const normalized = validateApiUrl(apiUrl)
  if (!normalized) {
    return {
      server: { ok: false, message: 'URL invalide — doit commencer par http:// ou https://' },
      apiKey: { ok: null,  message: 'Non testé — URL invalide' },
    }
  }

  // ── Passe 1 : joignabilité du serveur (sans clé) ──────────────
  let serverOk = false
  let serverMsg = ''
  try {
    const res = await axios.get(`${normalized}/api/health`, {
      timeout: 5000,
      validateStatus: () => true,
    })
    if (res.status < 500) {
      serverOk = true
      serverMsg = 'Serveur joignable'
    } else {
      serverMsg = `Erreur interne du serveur (HTTP ${res.status})`
    }
  } catch (err: any) {
    serverMsg = networkErrorMessage(err)
  }

  if (!serverOk) {
    return {
      server: { ok: false, message: serverMsg },
      apiKey: { ok: null,  message: 'Non testé — serveur inaccessible' },
    }
  }

  // ── Passe 2 : validité de la clé API ─────────────────────────
  if (!apiKey) {
    return {
      server: { ok: true, message: serverMsg },
      apiKey: { ok: false, message: 'Aucune clé API renseignée' },
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
        apiKey: { ok: false, message: 'Clé API invalide ou non autorisée' },
      }
    }
    if (res.status === 200 || res.status === 204) {
      const body = res.data
      if (body?.ok === true && body?.guildId != null) {
        const label = body.guildName ?? `#${body.guildId}`
        return {
          server: { ok: true, message: serverMsg },
          apiKey: { ok: true, message: `Clé API valide — ${label}` },
        }
      }
      return {
        server: { ok: true, message: serverMsg },
        apiKey: { ok: null, message: "Serveur joignable mais validation de clé non supportée — mettez à jour le serveur" },
      }
    }
    return {
      server: { ok: true,  message: serverMsg },
      apiKey: { ok: false, message: `Réponse inattendue lors de la validation (HTTP ${res.status})` },
    }
  } catch (err: any) {
    return {
      server: { ok: true,  message: serverMsg },
      apiKey: { ok: false, message: `Erreur lors de la validation de la clé (${err.message ?? ''})` },
    }
  }
}

/** Scanne les fichiers SavedVariables et les synchronise.
 *  Si force=false (défaut pour la détection auto), la synchro n'a lieu que si le contenu a changé (hash par fichier). */
export async function forceSync(win: BrowserWindow, force = true) {
  _logWin = win
  const wowPath = getStoreValue('wowPath')
  if (!wowPath || !fs.existsSync(wowPath)) {
    win.webContents.send('sync-status', { status: 'error', message: 'Chemin WoW invalide' })
    return
  }

  const wtfPath = path.join(wowPath, 'WTF', 'Account')
  if (!fs.existsSync(wtfPath)) {
    win.webContents.send('sync-status', { status: 'error', message: `Dossier WTF/Account introuvable dans ${wowPath}` })
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

  log(`[forceSync] force=${force} — ${luaFiles.length} fichier(s) trouvé(s)`)

  if (luaFiles.length === 0) {
    win.webContents.send('sync-status', {
      status: 'error',
      message: 'Aucun fichier RCLootCouncil_GuildMastery.lua trouvé dans WTF/Account/*/SavedVariables/',
    })
    return
  }

  win.webContents.send('sync-status', {
    status: 'syncing',
    message: `${luaFiles.length} fichier(s) trouvé(s), synchronisation en cours…`,
  })

  for (const file of luaFiles) {
    await processFile(file, win, force)
  }
}

async function processFile(filePath: string, win: BrowserWindow, force = false) {
  // Mutex per file — silently skip if a sync is already in flight for this file.
  if (inFlight.has(filePath)) {
    log(`[processFile] Synchro déjà en cours pour ${path.basename(filePath)} — skip.`)
    return
  }
  inFlight.add(filePath)

  try {
    const fileStats = fs.statSync(filePath)
    log(`[processFile] Lecture : ${path.basename(filePath)} (${fileStats.size} octets, modifié : ${fileStats.mtime.toLocaleString()})`)

    win.webContents.send('sync-status', { status: 'syncing', message: 'Nouvelles données détectées ! Synchronisation...' })

    const luaContent = fs.readFileSync(filePath, 'utf-8')
    const rawJson = extractSyncPayload(luaContent)
    if (!rawJson) {
      throw new Error(
        "Aucun historique complet (syncPayload) trouvé dans le fichier Lua.\n" +
        "Connecte-toi en jeu ou fais un /reload pour forcer la génération."
      )
    }

    let payload: any
    try {
      payload = JSON.parse(rawJson)
    } catch (e: any) {
      throw new Error(`Échec du parsing JSON du payload Lua : ${e.message}`)
    }
    if (!payload) throw new Error("Unable to parse JSON payload from Lua file.")

    // ── Retention safety-net : drop sessions older than RETENTION_DAYS days
    // BEFORE hashing and POSTing. Le hash est calculé sur le payload filtré
    // pour qu'une session qui franchit le seuil entre deux reads déclenche
    // une re-sync (le serveur reçoit alors un payload sans elle).
    const { payload: filtered, droppedCount } = pruneOldSessions(payload)
    if (droppedCount > 0) {
      log(`[Retention] ${droppedCount} session(s) > ${RETENTION_DAYS} days dropped before send`)
      payload = filtered
    }

    const filteredJson = JSON.stringify(payload)
    const hash = crypto.createHash('sha1').update(filteredJson).digest('hex')
    const prev = lastSyncedHashes.get(filePath) ?? ''
    log(`[processFile] Hash : ${hash.slice(0, 12)}… | précédent : ${prev ? prev.slice(0, 12) + '…' : '(vide)'} | force=${force}`)

    if (!force && hash === prev) {
      log(`[processFile] Contenu identique — aucune action.`)
      win.webContents.send('sync-status', {
        status: 'watching',
        message: 'Aucune nouvelle donnée (déjà synchronisé localement).',
      })
      return
    }

    const sessionCount = Array.isArray(payload.sessions) ? payload.sessions.length : '?'
    const exportTimestamp: string = payload.timestamp ?? 'inconnu'
    const addonVersion: string = payload.version ?? '?'
    log(`[processFile] Payload → sessions: ${sessionCount} | timestamp: ${exportTimestamp} | addon: ${addonVersion}`)

    const apiUrl = validateApiUrl(getStoreValue('apiUrl'))
    const apiKey = getStoreValue('apiKey')

    if (!apiUrl) {
      throw new Error("URL d'API invalide — doit commencer par http:// ou https://")
    }
    if (!apiKey) {
      throw new Error("Clé API manquante — renseignez-la dans la configuration.")
    }

    const endpoint = `${apiUrl}/api/loot-sessions`
    log(`[processFile] Envoi POST ${endpoint} ...`)

    const res = await axios.post(endpoint, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 30000,
    })

    log(`[processFile] Réponse serveur : HTTP ${res.status} → ${JSON.stringify(res.data).slice(0, 200)}`)

    const contentType = res.headers?.['content-type'] ?? ''
    if (!contentType.includes('application/json') || typeof res.data !== 'object' || res.data === null) {
      throw new Error(
        `Le serveur a répondu avec du HTML au lieu de JSON (HTTP ${res.status}).\n` +
        `Le middleware bloque peut-être la requête — vérifiez la configuration du serveur.`
      )
    }

    if (res.status === 200 || res.status === 201) {
      const isDuplicate = res.data?.duplicate === true
      lastSyncedHashes.set(filePath, hash)
      const time = new Date().toLocaleString()
      setStoreValue('lastSync', time)

      if (isDuplicate) {
        log(`[processFile] ⚠️ DOUBLON — export déjà connu du serveur.`)
        win.webContents.send('sync-status', {
          status: 'duplicate',
          message: `Déjà synchronisé (${sessionCount} vote(s) — doublon côté serveur)`,
          time, sessionCount, exportTimestamp, duplicate: true,
        })
      } else {
        log(`[processFile] ✅ Synchronisation réussie ! ${sessionCount} session(s).`)
        win.webContents.send('sync-status', {
          status: 'success',
          message: `${sessionCount} vote(s) synchronisé(s)`,
          time, sessionCount, exportTimestamp, duplicate: false,
        })
      }
    } else {
      throw new Error(`HTTP ${res.status} — ${JSON.stringify(res.data)}`)
    }

  } catch (error: any) {
    const errMsg = error?.response?.data?.message ?? error?.response?.data?.error ?? error.message ?? String(error)
    log(`[processFile] ❌ Erreur : ${errMsg}`)
    win.webContents.send('sync-status', {
      status: 'error',
      message: `Erreur: ${errMsg}`,
    })
  } finally {
    inFlight.delete(filePath)
  }
}
