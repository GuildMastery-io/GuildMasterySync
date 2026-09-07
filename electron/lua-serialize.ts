/**
 * Pure JS→Lua literal serialization for the addon inbox. No side effects, no
 * electron/fs imports → unit-testable in isolation. UTF-8 bytes pass through
 * unescaped (WoW stores item names that way).
 */

export const INBOX_BEGIN = '-- >>> GuildMasterySync inbox (managed) >>>'
export const INBOX_END = '-- <<< GuildMasterySync inbox (managed) <<<'

function luaString(s: string): string {
  const escaped = s.replace(/[\\"\n\r\t\0]/g, (c) => {
    switch (c) {
      case '\\': return '\\\\'
      case '"':  return '\\"'
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\t': return '\\t'
      case '\0': return '\\0'
      default:   return c
    }
  })
  return `"${escaped}"`
}

/** Serialize a JSON-ish value to a Lua literal. */
export function toLua(v: unknown): string {
  if (v === null || v === undefined) return 'nil'
  switch (typeof v) {
    case 'string':  return luaString(v)
    case 'number':  return Number.isFinite(v) ? String(v) : '0'
    case 'boolean': return v ? 'true' : 'false'
  }
  if (Array.isArray(v)) {
    return `{${v.map((e) => toLua(e)).join(',')}}`
  }
  if (typeof v === 'object') {
    const parts: string[] = []
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue
      parts.push(`[${luaString(k)}]=${toLua(val)}`)
    }
    return `{${parts.join(',')}}`
  }
  return 'nil'
}

/** The sentinel-delimited managed block assigning the inbox SavedVariable. */
export function inboxBlock(entries: unknown[]): string {
  const payload = toLua({ entries })
  return `\n${INBOX_BEGIN}\nRCLootCouncil_GuildMasterySyncInbox = ${payload}\n${INBOX_END}\n`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Remove any previously written managed block from a SavedVariables file body. */
export function stripInboxBlock(content: string): string {
  const re = new RegExp(`\\n?${escapeRegExp(INBOX_BEGIN)}[\\s\\S]*?${escapeRegExp(INBOX_END)}\\n?`, 'g')
  return content.replace(re, '')
}
