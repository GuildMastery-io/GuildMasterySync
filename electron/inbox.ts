/**
 * Return channel (v3): deliver the server's canonical loot entries back to the
 * addon by writing a dedicated SavedVariable (`RCLootCouncil_GuildMasterySyncInbox`)
 * into the addon's `.lua` file — but ONLY while WoW is closed (WoW rewrites its
 * SavedVariables at logout, so a write during a session would be lost).
 *
 * We only ever write our own sentinel-delimited block; the addon's history DB in
 * the same file is never touched.
 */
import * as fs from 'fs'
import { exec } from 'child_process'
import { getStoreValue, setStoreValue } from './store'
import { inboxBlock, stripInboxBlock } from './lua-serialize'

/** Append/replace our managed inbox block in the SavedVariables file. */
function writeInboxFile(filePath: string, entries: unknown[]): void {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
  content = stripInboxBlock(content)
  content = content.replace(/\s*$/, '\n') + inboxBlock(entries)
  fs.writeFileSync(filePath, content, 'utf-8')
}

// ── WoW process detection (Windows) ─────────────────────────────────
/** True if a WoW client process is running. Conservative: on any doubt → true. */
export function isWowRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq Wow.exe" /FI "IMAGENAME eq WowClassic.exe" /NH', (err, stdout) => {
      if (err) return resolve(true) // can't tell → assume running, never risk a lost write
      resolve(/Wow(Classic)?\.exe/i.test(stdout))
    })
  })
}

// ── Pending queue (persisted) ───────────────────────────────────────
/** Queue canonical entries for a file, merged by entry id (newer replaces). */
export function enqueueInbox(filePath: string, entries: unknown[]): void {
  if (!entries || entries.length === 0) return
  const pending = (getStoreValue('inboxPending') ?? {}) as Record<string, unknown[]>
  const existing = Array.isArray(pending[filePath]) ? pending[filePath] : []
  const byId = new Map<string, unknown>()
  for (const e of existing) byId.set(idOf(e), e)
  for (const e of entries) byId.set(idOf(e), e)
  pending[filePath] = Array.from(byId.values())
  setStoreValue('inboxPending', pending)
}

function idOf(e: unknown): string {
  const id = (e as { id?: unknown })?.id
  return typeof id === 'string' ? id : JSON.stringify(e)
}

/**
 * Flush every file's pending entries to its addon inbox — but only if WoW is
 * closed. If WoW is running, keep the queue and try again later.
 */
export async function flushPendingInbox(log: (msg: string) => void): Promise<void> {
  const pending = (getStoreValue('inboxPending') ?? {}) as Record<string, unknown[]>
  const files = Object.keys(pending).filter((f) => Array.isArray(pending[f]) && pending[f].length > 0)
  if (files.length === 0) return

  if (await isWowRunning()) {
    log(`[inbox] ${files.length} file(s) pending — WoW is running, will write once it closes.`)
    return
  }

  for (const filePath of files) {
    const entries = pending[filePath]
    try {
      if (!fs.existsSync(filePath)) {
        log(`[inbox] File missing, keeping pending: ${filePath}`)
        continue
      }
      writeInboxFile(filePath, entries)
      log(`[inbox] ✅ Wrote ${entries.length} canonical entry(ies) to the addon inbox (WoW closed).`)
      delete pending[filePath]
    } catch (e: unknown) {
      log(`[inbox] ❌ Failed to write inbox for ${filePath}: ${(e as Error).message}`)
    }
  }
  setStoreValue('inboxPending', pending)
}
