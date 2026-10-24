// == ARGUS AGENT PROJECT ==
/**
 * The `triggers` repository: what each trigger watches, where its source stopped, and
 * how its checks went.
 *
 * @module @argus-agent/store/repositories/triggers
 */
import type { DatabaseHandle } from '../connection.js'
import type { TriggerInput, TriggerRow } from '../types.js'

/** `enabled` is 0/1 in SQLite and a boolean in the row. */
function decode(row: Record<string, unknown> | undefined): TriggerRow | undefined {
  if (row === undefined) return undefined
  return { ...row, enabled: row['enabled'] === 1 } as unknown as TriggerRow
}

/** The `triggers` repository. */
export class TriggersRepository {
  private readonly insertStmt
  private readonly getStmt
  private readonly listStmt
  private readonly dueStmt
  private readonly checkedStmt
  private readonly cursorStmt
  private readonly enabledStmt
  private readonly deleteStmt

  constructor(db: DatabaseHandle) {
    this.insertStmt = db.prepare(`
      INSERT INTO triggers (id, project_id, source, config_json, reply_chat, enabled, next_check_at, created_at)
      VALUES (@id, @project_id, @source, @config_json, @reply_chat, @enabled, @next_check_at, @created_at)
    `)
    this.getStmt = db.prepare('SELECT * FROM triggers WHERE id = ?')
    this.listStmt = db.prepare('SELECT * FROM triggers ORDER BY project_id, id')
    this.dueStmt = db.prepare('SELECT * FROM triggers WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at')
    this.checkedStmt = db.prepare(`
      UPDATE triggers SET last_check_at = @at, next_check_at = @next, last_error = @error, failures = @failures,
        last_match_at = COALESCE(@matched, last_match_at)
      WHERE id = @id
    `)
    this.cursorStmt = db.prepare('UPDATE triggers SET cursor_json = ?, runs_json = ? WHERE id = ?')
    this.enabledStmt = db.prepare('UPDATE triggers SET enabled = ?, next_check_at = ?, failures = 0 WHERE id = ?')
    this.deleteStmt = db.prepare('DELETE FROM triggers WHERE id = ?')
  }

  insert(input: TriggerInput, now: number): void {
    this.insertStmt.run({ ...input, enabled: input.enabled === false ? 0 : 1, created_at: now })
  }

  get(id: string): TriggerRow | undefined {
    return decode(this.getStmt.get(id) as Record<string, unknown> | undefined)
  }

  list(): TriggerRow[] {
    return (this.listStmt.all() as Array<Record<string, unknown>>).map((row) => decode(row) as TriggerRow)
  }

  /** Enabled triggers whose check is due. */
  due(now: number): TriggerRow[] {
    return (this.dueStmt.all(now) as Array<Record<string, unknown>>).map((row) => decode(row) as TriggerRow)
  }

  /** Record a check: when, the next one, its error (null when it went well), and a match. */
  checked(id: string, at: number, next: number, error: string | null, failures: number, matched: number | null): void {
    this.checkedStmt.run({ id, at, next, error, failures, matched })
  }

  /** Move the source's cursor and the runs of the last hour, before the run they start. */
  setCursor(id: string, cursorJson: string, runsJson: string): void {
    this.cursorStmt.run(cursorJson, runsJson, id)
  }

  /** Turn a trigger on (checked at `next`) or off. */
  setEnabled(id: string, enabled: boolean, next: number): boolean {
    return this.enabledStmt.run(enabled ? 1 : 0, next, id).changes > 0
  }

  delete(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0
  }
}
