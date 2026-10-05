// == ARGUS AGENT PROJECT ==
/**
 * The database connection.
 *
 * One `better-sqlite3` handle per process, opened in WAL mode. Every repository
 * runs on this handle, so WAL's single-writer constraint is a non-issue: there
 * is one writer by construction (ADR 0003).
 *
 * @module @argus-agent/store/connection
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database, { type Database as DatabaseHandle } from 'better-sqlite3'
import { OpsError } from '@argus-agent/types'

/** Options for {@link openDatabase}. */
export interface OpenOptions {
  /**
   * The database path, or `':memory:'` for a transient one.
   *
   * A file path's parent directory is created when absent.
   */
  readonly path: string
  /**
   * Milliseconds to wait for a lock before failing.
   *
   * Defaults to 5000. Without it, a second process touching the file fails
   * immediately with `SQLITE_BUSY` and no useful explanation.
   */
  readonly busyTimeoutMs?: number
  /** Open read-only. Used by diagnostics and by the backup verifier. */
  readonly readonly?: boolean
}

/** The pragmas the store requires, and why. */
export const REQUIRED_PRAGMAS = {
  /**
   * Write-ahead logging: readers never block the writer, and a crash mid-write
   * leaves the database recoverable rather than corrupt.
   */
  journal_mode: 'WAL',
  /**
   * `NORMAL` fsyncs at checkpoints rather than on every commit. With WAL this
   * is crash-safe (a torn tail is discarded) and far faster than `FULL`, which
   * matters because usage events are written continuously.
   */
  synchronous: 'NORMAL',
  /** Enforce `REFERENCES` clauses, so an orphaned `runs` row cannot exist. */
  foreign_keys: 'ON',
  /** Wait for a lock rather than failing instantly. */
  busy_timeout: 5000,
} as const

/**
 * Open the database and apply the required pragmas.
 *
 * @param options the path and tuning.
 * @returns the open handle.
 * @throws {OpsError} `STORE_ERROR` when the file cannot be opened, or when a
 *   required pragma cannot be applied.
 */
export function openDatabase(options: OpenOptions): DatabaseHandle {
  const { path } = options
  if (path !== ':memory:') {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch (error) {
      throw new OpsError('STORE_ERROR', `cannot create the database directory for ${path}: ${(error as Error).message}`, {
        path,
      })
    }
  }

  let db: DatabaseHandle
  try {
    db = new Database(path, { readonly: options.readonly ?? false })
  } catch (error) {
    throw new OpsError('STORE_ERROR', `cannot open the database at ${path}: ${(error as Error).message}`, { path })
  }

  try {
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? REQUIRED_PRAGMAS.busy_timeout}`)
    db.pragma('foreign_keys = ON')
    if (!options.readonly) {
      // WAL is persistent: it is a property of the file, not the connection. An
      // in-memory database cannot use it, and SQLite reports `memory` instead.
      if (path !== ':memory:') {
        const mode = db.pragma('journal_mode = WAL', { simple: true })
        if (mode !== 'wal') {
          throw new OpsError('STORE_ERROR', `could not enable WAL mode (journal_mode is ${String(mode)})`, { path })
        }
      }
      db.pragma('synchronous = NORMAL')
    }
  } catch (error) {
    db.close()
    if (OpsError.is(error)) throw error
    throw new OpsError('STORE_ERROR', `cannot configure the database at ${path}: ${(error as Error).message}`, {
      path,
    })
  }

  return db
}

/**
 * Verify that the database file is structurally sound.
 *
 * Used by a health check and by the crash-safety test. `integrity_check` scans
 * every page, so it is not free; a health check should sample it rather than run
 * it on every request.
 *
 * @param db the open handle.
 * @returns `'ok'` when sound, otherwise the reported problem.
 */
export function integrityCheck(db: DatabaseHandle): string {
  const row = db.pragma('integrity_check', { simple: true })
  return typeof row === 'string' ? row : String(row)
}

/**
 * Wrap a function in a `better-sqlite3` transaction.
 *
 * The returned function is synchronous, because `better-sqlite3` is: a
 * transaction cannot span an `await`. Every multi-table operation in the store
 * is therefore expressed as one synchronous unit — which is what makes
 * admission (update `inbound` + insert `runs`) atomic without a lock.
 *
 * @param db the open handle.
 * @param fn the work to run transactionally.
 * @returns a function that runs `fn` inside a transaction.
 */
export function transaction<T>(db: DatabaseHandle, fn: () => T): () => T {
  return db.transaction(fn)
}

/** Re-export the handle type so repositories do not import `better-sqlite3`. */
export type { DatabaseHandle }
