// == ARGUS AGENT PROJECT ==
/**
 * The `audit_log` repository.
 *
 * Every state-changing action a human or the system takes is recorded here: an
 * approval decision, a budget override, a model change, a project reset, a
 * panic. It is **never pruned**, because the question it answers — "who did
 * this, and when?" — is asked months later.
 *
 * @module @argus-agent/store/repositories/audit
 */
import type { DatabaseHandle } from '../connection.js'
import type { AuditInput, AuditRow } from '../types.js'

/** The `audit_log` repository. */
export class AuditRepository {
  private readonly insertStmt
  private readonly byTargetStmt
  private readonly recentStmt
  private readonly byActionStmt
  private readonly countStmt

  constructor(private readonly db: DatabaseHandle) {
    this.insertStmt = db.prepare(
      'INSERT INTO audit_log (ts, actor, action, target, details_json) VALUES (?, ?, ?, ?, ?)',
    )
    this.byTargetStmt = db.prepare(
      'SELECT * FROM audit_log WHERE target = ? ORDER BY ts DESC, id DESC LIMIT ?',
    )
    this.recentStmt = db.prepare('SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?')
    this.byActionStmt = db.prepare(
      'SELECT * FROM audit_log WHERE action = ? ORDER BY ts DESC, id DESC LIMIT ?',
    )
    this.countStmt = db.prepare('SELECT COUNT(*) AS count FROM audit_log')
  }

  /**
   * Record an entry.
   *
   * @param input the actor, action, target and structured details. `details` is
   *   serialized here, so a caller cannot store a non-JSON value.
   * @param now the current time, used when the input omits `ts`.
   * @returns the id of the new row.
   */
  write(input: AuditInput, now: number): number {
    const details =
      input.details_json === undefined || input.details_json === null ? null : input.details_json
    const result = this.insertStmt.run(input.ts ?? now, input.actor, input.action, input.target, details)
    return Number(result.lastInsertRowid)
  }

  /**
   * Record an entry from a plain object.
   *
   * A convenience over {@link write} for the common case, so a caller does not
   * have to serialize by hand.
   *
   * @param entry the actor, action, target and details.
   * @param now the current time.
   * @returns the id of the new row.
   */
  record(
    entry: {
      readonly actor: string
      readonly action: string
      readonly target?: string | null
      readonly details?: Record<string, unknown>
      readonly ts?: number
    },
    now: number,
  ): number {
    return this.write(
      {
        actor: entry.actor,
        action: entry.action,
        target: entry.target ?? null,
        details_json: entry.details === undefined ? null : JSON.stringify(entry.details),
        ...(entry.ts !== undefined ? { ts: entry.ts } : {}),
      },
      now,
    )
  }

  /**
   * Entries about one target, newest first.
   * @param target the project, run or scope.
   * @param limit the maximum number to return.
   * @returns the rows.
   */
  byTarget(target: string, limit = 100): AuditRow[] {
    return this.byTargetStmt.all(target, limit) as AuditRow[]
  }

  /**
   * Recent entries.
   * @param limit the maximum number to return.
   * @returns the rows, newest first.
   */
  recent(limit = 100): AuditRow[] {
    return this.recentStmt.all(limit) as AuditRow[]
  }

  /**
   * Entries of one action, newest first.
   * @param action the action name.
   * @param limit the maximum number to return.
   * @returns the rows.
   */
  byAction(action: string, limit = 100): AuditRow[] {
    return this.byActionStmt.all(action, limit) as AuditRow[]
  }

  /**
   * The total number of entries.
   * @returns the count.
   */
  count(): number {
    const row = this.countStmt.get() as { count: number }
    return row.count
  }
}
