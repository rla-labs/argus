// == ARGUS AGENT PROJECT ==
/**
 * The `runtime_state` repository.
 *
 * Small pieces of state that must survive a restart but are not a domain entity:
 * the governor's panic mode, the scheduler's bookkeeping, a health checkpoint.
 * Values are JSON text, so a caller stores a structured value without a schema
 * change.
 *
 * This is deliberately the **only** generic key/value table. Anything with a
 * shape the system reasons about belongs in a real table, where its columns are
 * typed and indexed.
 *
 * @module @argus-agent/store/repositories/runtime-state
 */
import type { DatabaseHandle } from '../connection.js'

/** The `runtime_state` repository. */
export class RuntimeStateRepository {
  private readonly getStmt
  private readonly setStmt
  private readonly deleteStmt
  private readonly listStmt

  constructor(private readonly db: DatabaseHandle) {
    this.getStmt = db.prepare('SELECT value FROM runtime_state WHERE key = ?')
    this.setStmt = db.prepare(`
      INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    this.deleteStmt = db.prepare('DELETE FROM runtime_state WHERE key = ?')
    this.listStmt = db.prepare('SELECT key, value, updated_at FROM runtime_state ORDER BY key')
  }

  /**
   * Read a raw string value.
   * @param key the key.
   * @returns the value, or `undefined` when unset.
   */
  getRaw(key: string): string | undefined {
    const row = this.getStmt.get(key) as { value: string } | undefined
    return row?.value
  }

  /**
   * Read and parse a JSON value.
   *
   * A value that fails to parse returns `undefined` rather than throwing: a
   * stale or hand-edited key must not prevent startup.
   *
   * @param key the key.
   * @returns the parsed value, or `undefined` when unset or unparseable.
   */
  get<T>(key: string): T | undefined {
    const raw = this.getRaw(key)
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  /**
   * Write a raw string value.
   * @param key the key.
   * @param value the value.
   * @param now the current time.
   */
  setRaw(key: string, value: string, now: number): void {
    this.setStmt.run(key, value, now)
  }

  /**
   * Write a JSON value.
   * @param key the key.
   * @param value the value to serialize.
   * @param now the current time.
   */
  set(key: string, value: unknown, now: number): void {
    this.setStmt.run(key, JSON.stringify(value), now)
  }

  /**
   * Remove a key.
   * @param key the key.
   * @returns whether a row was deleted.
   */
  delete(key: string): boolean {
    return this.deleteStmt.run(key).changes > 0
  }

  /**
   * Every key and its raw value.
   * @returns the rows.
   */
  list(): Array<{ key: string; value: string; updated_at: number }> {
    return this.listStmt.all() as Array<{ key: string; value: string; updated_at: number }>
  }
}
