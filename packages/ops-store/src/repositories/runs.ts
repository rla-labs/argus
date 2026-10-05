// == ARGUS AGENT PROJECT ==
/**
 * The `runs` repository.
 *
 * A run is one admitted request, from delivery to the agent returning to idle.
 * The row is created in the **same transaction** as the `inbound` update, so an
 * admitted request always has a run and a run always has its request.
 *
 * @module @argus-agent/store/repositories/runs
 */
import type { DatabaseHandle } from '../connection.js'
import type { RunRow, RunStatus } from '../types.js'

/** The fields a caller supplies when a run starts. */
export interface RunInput {
  readonly id: string
  readonly inbound_id: string | null
  readonly project_id: string | null
  readonly owner_key: string
  readonly session_id: string
  readonly provider: string
  readonly model: string
  readonly reply_chat?: string | null
}

/** The `runs` repository. */
export class RunsRepository {
  private readonly startStmt
  private readonly getStmt
  private readonly finishStmt
  private readonly setStepsStmt
  private readonly activeStmt
  private readonly listStmt
  private readonly listByOwnerStmt
  private readonly markRunningInterruptedStmt
  private readonly countByStatusStmt

  constructor(private readonly db: DatabaseHandle) {
    this.startStmt = db.prepare(`
      INSERT INTO runs (id, inbound_id, project_id, owner_key, session_id, provider, model, status, steps, started_at, reply_chat)
      VALUES (@id, @inbound_id, @project_id, @owner_key, @session_id, @provider, @model, 'running', 0, @started_at, @reply_chat)
    `)
    this.getStmt = db.prepare('SELECT * FROM runs WHERE id = ?')
    this.finishStmt = db.prepare(`
      UPDATE runs SET status = ?, ended_at = ?, stop_reason = ?
      WHERE id = ? AND status = 'running'
    `)
    this.setStepsStmt = db.prepare('UPDATE runs SET steps = ? WHERE id = ?')
    this.activeStmt = db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at")
    this.listStmt = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
    this.listByOwnerStmt = db.prepare(
      'SELECT * FROM runs WHERE owner_key = ? ORDER BY started_at DESC LIMIT ?',
    )
    // Startup recovery: a run left `running` by a crash is marked interrupted
    // rather than resumed, because nobody knows how far it got.
    this.markRunningInterruptedStmt = db.prepare(`
      UPDATE runs SET status = 'interrupted', ended_at = ?, stop_reason = 'crash'
      WHERE status = 'running'
    `)
    this.countByStatusStmt = db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?')
  }

  /**
   * Create a run.
   * @param input the run's identity.
   * @param now the start time, epoch ms.
   */
  start(input: RunInput, now: number): void {
    this.startStmt.run({
      id: input.id,
      inbound_id: input.inbound_id,
      project_id: input.project_id,
      owner_key: input.owner_key,
      session_id: input.session_id,
      provider: input.provider,
      model: input.model,
      started_at: now,
      reply_chat: input.reply_chat ?? null,
    })
  }

  /**
   * Read one run.
   * @param id the run id.
   * @returns the row, or `undefined`.
   */
  get(id: string): RunRow | undefined {
    return this.getStmt.get(id) as RunRow | undefined
  }

  /**
   * Finish a run.
   *
   * Guarded by `status = 'running'`, so a late signal cannot rewrite a terminal
   * state — an interrupted run must not become `completed` because a teardown
   * handler ran afterwards.
   *
   * @param id the run id.
   * @param status the terminal status.
   * @param now the end time.
   * @param stopReason an optional machine-readable reason.
   * @returns whether the run was still running.
   */
  finish(id: string, status: Exclude<RunStatus, 'running'>, now: number, stopReason?: string): boolean {
    return this.finishStmt.run(status, now, stopReason ?? null, id).changes > 0
  }

  /**
   * Record the step count.
   * @param id the run id.
   * @param steps the current step count.
   * @returns whether a row was updated.
   */
  setSteps(id: string, steps: number): boolean {
    return this.setStepsStmt.run(steps, id).changes > 0
  }

  /**
   * Every run currently marked running.
   * @returns the rows, oldest first.
   */
  active(): RunRow[] {
    return this.activeStmt.all() as RunRow[]
  }

  /**
   * Recent runs.
   * @param limit the maximum number to return.
   * @returns the rows, newest first.
   */
  recent(limit = 50): RunRow[] {
    return this.listStmt.all(limit) as RunRow[]
  }

  /**
   * Recent runs of one owner.
   * @param ownerKey the owner key from `@argus-agent/types`.
   * @param limit the maximum number to return.
   * @returns the rows, newest first.
   */
  byOwner(ownerKey: string, limit = 50): RunRow[] {
    return this.listByOwnerStmt.all(ownerKey, limit) as RunRow[]
  }

  /**
   * Mark every running run interrupted.
   *
   * Called once at startup. Returns the rows it changed, so the caller can
   * report exactly what was lost rather than a bare count.
   *
   * @param now the current time.
   * @returns the runs that were marked, as they were before the update.
   */
  markRunningInterrupted(now: number): RunRow[] {
    const affected = this.active()
    this.markRunningInterruptedStmt.run(now)
    return affected
  }

  /**
   * Count runs in one state.
   * @param status the state.
   * @returns the count.
   */
  countByStatus(status: RunStatus): number {
    const row = this.countByStatusStmt.get(status) as { count: number }
    return row.count
  }
}
