// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/health/backup` — the daily database copy, and its rotation.
 *
 * **This backs up the SQLite database only.** Session transcripts, project
 * workspaces and the memory state tree are files, and they are covered by a
 * volume-level backup — `docs/user/backup-and-upgrade.md#backup-and-restore` says so, and this module's
 * documentation repeats it, because the most dangerous misunderstanding about a
 * backup is thinking it covers more than it does.
 *
 * @module @argus-agent/health/backup
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'

/** The prefix every backup filename carries. */
export const BACKUP_PREFIX = 'ops-'

/**
 * The backup path for a date.
 *
 * `ops-<YYYY-MM-DD>.sqlite`, so a directory listing sorts chronologically and a
 * person can tell what a file is without opening it.
 *
 * @param dataDir the data directory.
 * @param day the date.
 * @returns the absolute path.
 */
export function backupPath(dataDir: string, day: string): string {
  return join(dataDir, 'backups', `${BACKUP_PREFIX}${day}.sqlite`)
}

/**
 * The backups present, newest first.
 *
 * Only files matching the prefix and the date pattern are considered, so an
 * unrelated file in the directory is never deleted by rotation — the failure mode
 * of a rotation that globs too broadly is deleting something it did not create.
 *
 * @param dataDir the data directory.
 * @returns the paths, newest first.
 */
export function listBackups(dataDir: string): string[] {
  const dir = join(dataDir, 'backups')
  if (!existsSync(dir)) return []
  const pattern = new RegExp(`^${BACKUP_PREFIX}\\d{4}-\\d{2}-\\d{2}\\.sqlite$`)
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name))
    .sort()
    .reverse()
}

/**
 * The backups to delete so that `keep` remain.
 *
 * `keep` counts **including** the one just written, which is the reading a person
 * expects: "keep 7" means seven files, not eight.
 *
 * @param existing the paths, newest first.
 * @param keep how many to keep.
 * @returns the paths to delete.
 */
export function backupsToPrune(existing: readonly string[], keep: number): string[] {
  if (keep <= 0) return [...existing]
  return existing.slice(keep)
}

/**
 * Prepare the directory and return where to write.
 *
 * @param dataDir the data directory.
 * @param day the date.
 * @returns the path.
 */
export function prepareBackup(dataDir: string, day: string): string {
  const dir = join(dataDir, 'backups')
  mkdirSync(dir, { recursive: true })
  return backupPath(dataDir, day)
}

/**
 * Delete the backups beyond the keep count.
 *
 * @param dataDir the data directory.
 * @param keep how many to keep.
 * @returns the paths that were deleted.
 */
export function pruneBackups(dataDir: string, keep: number): string[] {
  const doomed = backupsToPrune(listBackups(dataDir), keep)
  for (const path of doomed) rmSync(path, { force: true })
  return doomed
}

/**
 * How much of the filesystem a path's mount has used.
 *
 * `statfs` is the honest source: a data directory's own `du` says nothing about
 * whether the **filesystem** is about to fill, which is the thing that stops the
 * system writing sessions.
 *
 * @param path the path to stat.
 * @returns the used percentage and free bytes, or `undefined` when it cannot be read.
 */
export function diskUsage(path: string): { readonly usedPct: number; readonly freeBytes: number } | undefined {
  try {
    if (!existsSync(path)) return undefined
    // `statfsSync` is the honest source: a directory's own size says nothing about
    // whether the FILESYSTEM is about to fill, and that is what stops the system
    // writing sessions. Read through a proper import — `require` does not exist in
    // an ES module, and the version that tried to produced `undefined` silently.
    const statfs = statfsSync(path)
    const total = statfs.blocks * statfs.bsize
    const free = statfs.bfree * statfs.bsize
    if (total === 0) return undefined
    return { usedPct: ((total - free) / total) * 100, freeBytes: free }
  } catch {
    return undefined
  }
}
