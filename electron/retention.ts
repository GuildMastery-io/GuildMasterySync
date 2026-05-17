/**
 * Retention safety-net : drops sessions older than RETENTION_DAYS days
 * from a parsed sync payload, before it is hashed and POSTed to the backend.
 *
 * Defense-in-depth : the addon (RCLootCouncil_GuildMastery, v1.1.0+) already
 * prunes its local history via GMLootHistory:PruneOldEntries. This module
 * protects against :
 *   - users running an older addon version (< 1.1.0) without the prune,
 *   - corrupted or hand-edited SavedVariables files,
 *   - exports from very old campaigns being replayed.
 *
 * Keep RETENTION_DAYS synchronized with :
 *   - RETENTION_DAYS in RCLootCouncil_GuildMastery/History.lua
 *   - LOOT_RETENTION_DAYS in nocturnys/src/lib/loot-sessions/cleanup.ts
 */

export const RETENTION_DAYS = 180
export const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60

export interface PruneResult<T> {
  payload: T
  droppedCount: number
}

/**
 * Returns a shallow copy of `payload` with `sessions` filtered to keep only
 * entries whose `looted_at` (epoch seconds) is within the retention window.
 *
 * - Mutates nothing in the input.
 * - Sessions without a numeric `looted_at` are dropped defensively.
 * - If `payload.sessions` is not an array, returns the payload unchanged.
 */
export function pruneOldSessions<T extends { sessions?: unknown }>(
  payload: T,
): PruneResult<T> {
  if (!payload || !Array.isArray(payload.sessions)) {
    return { payload, droppedCount: 0 }
  }

  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS
  const original = payload.sessions as Array<Record<string, unknown>>
  const kept: Array<Record<string, unknown>> = []

  for (const s of original) {
    const ts = (s as { looted_at?: unknown }).looted_at
    if (typeof ts === 'number' && ts >= cutoff) {
      kept.push(s)
    }
  }

  const droppedCount = original.length - kept.length
  if (droppedCount === 0) return { payload, droppedCount: 0 }

  return {
    payload: { ...payload, sessions: kept },
    droppedCount,
  }
}
