// == ARGUS AGENT PROJECT ==
/**
 * The `schedules` repository.
 *
 * The scheduler keeps one timer armed for the earliest `next_run_at`, so
 * {@link SchedulesRepository.due} and the `(enabled, next_run_at)` index are the
 * hot path. Firing a schedule and computing its next time must be one
 * transaction, or a crash between them double-fires or skips.
 *
 * @module @argus-agent/store/repositories/schedules
 */
import type { DatabaseHandle } from '../connection.js'
import type { ScheduleInput, ScheduleRow } from '../types.js'

/**
 * SQLite has no boolean type, so `enabled` is stored as 0/1 and converted at
 * this boundary. The row type declares a real `boolean`, and returning a raw
 * `0` would make `if (row.enabled)` correct while `row.enabled === false` was
 * not — exactly the kind of half-truth that produces a bug nobody can see.
 *
 * @param row the raw row.
 * @returns the row with `enabled` as a boolean.
 */
function decodeSchedule(row: Record<string, unknown> | undefined): ScheduleRow | undefined {
  if (row === undefined) return undefined
  return { ...row, enabled: row['enabled'] === 1 || row['enabled'] === true } as unknown as ScheduleRow
}

/** The `schedules` repository. */
export class SchedulesRepository {
  private readonly insertStmt
  private readonly getStmt
  private readonly listStmt
  private readonly dueStmt
  private readonly earliestStmt
  private readonly markRunStmt
  private readonly setEnabledStmt
  private readonly deleteStmt
  private readonly listPastDueStmt

  constructor(private readonly db: DatabaseHandle) {
    this.insertStmt = db.prepare(`
      INSERT INTO schedules
        (id, cron, timezone, project_id, prompt, reply_chat, enabled, last_run_at, next_run_at,
         misfire, last_request_id, model, created_at)
      VALUES
        (@id, @cron, @timezone, @project_id, @prompt, @reply_chat, @enabled, @last_run_at, @next_run_at,
         @misfire, @last_request_id, @model, @created_at)
    `)
    this.getStmt = db.prepare('SELECT * FROM schedules WHERE id = ?')
    this.listStmt = db.prepare('SELECT * FROM schedules ORDER BY next_run_at')
    this.dueStmt = db.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND next_run_at <= ?
      ORDER BY next_run_at
      LIMIT ?
    `)
    this.earliestStmt = db.prepare(
      'SELECT MIN(next_run_at) AS next FROM schedules WHERE enabled = 1',
    )
    // Records the firing and advances the clock in one statement, so the two
    // cannot disagree after a crash.
    this.markRunStmt = db.prepare(`
      UPDATE schedules SET last_run_at = ?, next_run_at = ?, last_request_id = ?
      WHERE id = ?
    `)
    this.setEnabledStmt = db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?')
    this.deleteStmt = db.prepare('DELETE FROM schedules WHERE id = ?')
    this.listPastDueStmt = db.prepare(
      'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at < ? ORDER BY next_run_at',
    )
  }

  /**
   * Create a schedule.
   * @param input the schedule.
   * @param now the current time, epoch ms.
   * @throws when the id already exists.
   */
  insert(input: ScheduleInput, now: number): void {
    this.insertStmt.run({
      id: input.id,
      cron: input.cron,
      timezone: input.timezone,
      project_id: input.project_id,
      prompt: input.prompt,
      reply_chat: input.reply_chat,
      enabled: (input.enabled ?? true) ? 1 : 0,
      last_run_at: input.last_run_at ?? null,
      next_run_at: input.next_run_at,
      misfire: input.misfire,
      last_request_id: input.last_request_id ?? null,
      model: input.model,
      created_at: input.created_at ?? now,
    })
  }

  /**
   * Read one schedule.
   * @param id the schedule id.
   * @returns the row, or `undefined`.
   */
  get(id: string): ScheduleRow | undefined {
    return decodeSchedule(this.getStmt.get(id) as Record<string, unknown> | undefined)
  }

  /**
   * Every schedule, earliest next run first.
   * @returns the rows.
   */
  list(): ScheduleRow[] {
    return (this.listStmt.all() as Array<Record<string, unknown>>).map(decodeSchedule) as ScheduleRow[]
  }

  /**
   * The enabled schedules that are due.
   * @param now the current time.
   * @param limit the maximum number to return.
   * @returns the rows, earliest first.
   */
  due(now: number, limit = 100): ScheduleRow[] {
    return (this.dueStmt.all(now, limit) as Array<Record<string, unknown>>).map(decodeSchedule) as ScheduleRow[]
  }

  /**
   * The enabled schedules whose next run has already passed.
   *
   * Used once at startup for misfire handling, which is a different question
   * from {@link due}: a schedule missed while the process was down may run once
   * or be skipped, per its policy.
   *
   * @param now the current time.
   * @returns the rows, earliest first.
   */
  pastDue(now: number): ScheduleRow[] {
    return (this.listPastDueStmt.all(now) as Array<Record<string, unknown>>).map(decodeSchedule) as ScheduleRow[]
  }

  /**
   * The earliest enabled `next_run_at`.
   * @returns the epoch ms, or `undefined` when nothing is enabled.
   */
  earliestNextRun(): number | undefined {
    const row = this.earliestStmt.get() as { next: number | null }
    return row.next ?? undefined
  }

  /**
   * Record a firing and advance the schedule.
   * @param id the schedule id.
   * @param lastRunAt when it fired.
   * @param nextRunAt the next firing.
   * @param requestId the governor request id, for overlap detection.
   * @returns whether a row was updated.
   */
  markRun(id: string, lastRunAt: number, nextRunAt: number, requestId: string | null): boolean {
    return this.markRunStmt.run(lastRunAt, nextRunAt, requestId, id).changes > 0
  }

  /**
   * Enable or disable a schedule.
   * @param id the schedule id.
   * @param enabled the new state.
   * @returns whether a row was updated.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    return this.setEnabledStmt.run(enabled ? 1 : 0, id).changes > 0
  }

  /**
   * Delete a schedule.
   * @param id the schedule id.
   * @returns whether a row was deleted.
   */
  delete(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0
  }
}
