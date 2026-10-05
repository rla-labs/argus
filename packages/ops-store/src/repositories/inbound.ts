// == ARGUS AGENT PROJECT ==
/**
 * The `inbound` repository.
 *
 * Every request is written here **before** anything runs, which is what makes a
 * crash between receipt and admission recoverable rather than a lost message.
 * The dispatcher reads pending rows ordered by priority then age, so the table
 * is also the queue.
 *
 * @module @argus-agent/store/repositories/inbound
 */
import type { Priority } from '@argus-agent/types'
import type { DatabaseHandle } from '../connection.js'
import type { InboundRow, InboundSource, InboundStatus } from '../types.js'

/** The fields a caller supplies when submitting a request. */
export interface InboundInput {
  readonly id: string
  readonly source: InboundSource
  readonly project_id: string | null
  /** JSON-encoded content blocks. */
  readonly payload: string
  readonly priority: Priority
  /** JSON-encoded address, or null. */
  readonly reply_chat?: string | null
}

/** The `inbound` repository. */
export class InboundRepository {
  private readonly insertStmt
  private readonly getStmt
  private readonly nextPendingStmt
  private readonly nextPendingProjectStmt
  private readonly markAdmittedStmt
  private readonly markRejectedStmt
  private readonly markDoneStmt
  private readonly listByStatusStmt
  private readonly oldestPendingStmt
  private readonly countPendingStmt
  private readonly pruneStmt

  constructor(private readonly db: DatabaseHandle) {
    this.insertStmt = db.prepare(`
      INSERT INTO inbound (id, source, project_id, payload, priority, status, created_at, reply_chat)
      VALUES (@id, @source, @project_id, @payload, @priority, 'pending', @created_at, @reply_chat)
    `)
    this.getStmt = db.prepare('SELECT * FROM inbound WHERE id = ?')
    // Priority first, then age: a human waiting now outranks a scheduled job
    // that has been queued longer.
    this.nextPendingStmt = db.prepare(`
      SELECT * FROM inbound
      WHERE status = 'pending'
      ORDER BY priority ASC, created_at ASC
      LIMIT ?
    `)
    this.nextPendingProjectStmt = db.prepare(`
      SELECT * FROM inbound
      WHERE status = 'pending' AND project_id = ?
      ORDER BY priority ASC, created_at ASC
      LIMIT ?
    `)
    this.markAdmittedStmt = db.prepare(`
      UPDATE inbound SET status = 'admitted', admitted_at = ?, run_id = ?
      WHERE id = ? AND status = 'pending'
    `)
    this.markRejectedStmt = db.prepare(`
      UPDATE inbound SET status = 'rejected', reject_reason = ?
      WHERE id = ? AND status = 'pending'
    `)
    this.markDoneStmt = db.prepare("UPDATE inbound SET status = 'done' WHERE id = ?")
    this.listByStatusStmt = db.prepare('SELECT * FROM inbound WHERE status = ? ORDER BY created_at ASC')
    this.oldestPendingStmt = db.prepare(
      "SELECT MIN(created_at) AS oldest FROM inbound WHERE status = 'pending'",
    )
    this.countPendingStmt = db.prepare("SELECT COUNT(*) AS count FROM inbound WHERE status = 'pending'")
    // Only terminal rows are prunable; a pending request is never discarded.
    this.pruneStmt = db.prepare(`
      DELETE FROM inbound
      WHERE status IN ('done', 'rejected') AND created_at < ?
    `)
  }

  /**
   * Write a request.
   * @param input the request.
   * @param now the current time, epoch ms.
   * @throws when the id already exists.
   */
  insert(input: InboundInput, now: number): void {
    this.insertStmt.run({
      id: input.id,
      source: input.source,
      project_id: input.project_id,
      payload: input.payload,
      priority: input.priority,
      created_at: now,
      reply_chat: input.reply_chat ?? null,
    })
  }

  /**
   * Read one request.
   * @param id the request id.
   * @returns the row, or `undefined`.
   */
  get(id: string): InboundRow | undefined {
    return this.getStmt.get(id) as InboundRow | undefined
  }

  /**
   * Read the pending requests the dispatcher should consider.
   * @param limit the maximum number to return.
   * @param projectId optional: only this project's requests.
   * @returns the rows, ordered by priority then age.
   */
  nextPending(limit: number, projectId?: string): InboundRow[] {
    return (projectId === undefined
      ? this.nextPendingStmt.all(limit)
      : this.nextPendingProjectStmt.all(projectId, limit)) as InboundRow[]
  }

  /**
   * Mark a request admitted and attach its run.
   *
   * Guarded by `status = 'pending'`, so a concurrent pass cannot admit the same
   * request twice.
   *
   * @param id the request id.
   * @param runId the run created for it.
   * @param now the current time.
   * @returns whether the row was still pending and is now admitted.
   */
  markAdmitted(id: string, runId: string, now: number): boolean {
    return this.markAdmittedStmt.run(now, runId, id).changes > 0
  }

  /**
   * Mark a request rejected.
   * @param id the request id.
   * @param reason a stable reason string, for the notification.
   * @returns whether the row was still pending.
   */
  markRejected(id: string, reason: string): boolean {
    return this.markRejectedStmt.run(reason, id).changes > 0
  }

  /**
   * Mark a request finished.
   * @param id the request id.
   * @returns whether a row was updated.
   */
  markDone(id: string): boolean {
    return this.markDoneStmt.run(id).changes > 0
  }

  /**
   * List requests in one state.
   * @param status the state.
   * @returns the rows, oldest first.
   */
  listByStatus(status: InboundStatus): InboundRow[] {
    return this.listByStatusStmt.all(status) as InboundRow[]
  }

  /** How many requests are pending. */
  pendingCount(): number {
    const row = this.countPendingStmt.get() as { count: number }
    return row.count
  }

  /**
   * The creation time of the oldest pending request.
   * @returns the epoch ms, or `undefined` when nothing is pending.
   */
  oldestPendingAt(): number | undefined {
    const row = this.oldestPendingStmt.get() as { oldest: number | null }
    return row.oldest ?? undefined
  }

  /**
   * Delete terminal requests older than a cutoff.
   *
   * Pending and admitted rows are never pruned: one is a promise not yet kept,
   * the other is a run still in flight.
   *
   * @param olderThan the cutoff, epoch ms.
   * @returns the number of rows deleted.
   */
  prune(olderThan: number): number {
    return this.pruneStmt.run(olderThan).changes
  }
}
