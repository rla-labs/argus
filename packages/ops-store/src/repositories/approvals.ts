// == ARGUS AGENT PROJECT ==
/**
 * The `approvals` repository.
 *
 * One row per approval request and its decision. The table exists because dsh's
 * own audit trail lives in the session log, which is per session — answering
 * "what did this project approve last month?" would otherwise mean reading every
 * session file.
 *
 * @module @argus-agent/store/repositories/approvals
 */
import type { DatabaseHandle } from '../connection.js'
import type { ApprovalInput, ApprovalRow, ApprovalStatus } from '../types.js'

/** The `approvals` repository. */
export class ApprovalsRepository {
  private readonly insertStmt
  private readonly getStmt
  private readonly decideStmt
  private readonly listPendingStmt
  private readonly byRunStmt
  private readonly byProjectStmt
  private readonly expireStmt
  private readonly recentStmt

  constructor(private readonly db: DatabaseHandle) {
    this.insertStmt = db.prepare(`
      INSERT INTO approvals (id, run_id, project_id, request_json, status, created_at)
      VALUES (@id, @run_id, @project_id, @request_json, @status, @created_at)
    `)
    this.getStmt = db.prepare('SELECT * FROM approvals WHERE id = ?')
    // Guarded by `status = 'pending'`, so a late button press cannot overwrite a
    // decision that a timeout already made.
    this.decideStmt = db.prepare(`
      UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?
      WHERE id = ? AND status = 'pending'
    `)
    this.listPendingStmt = db.prepare(
      "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at",
    )
    this.byRunStmt = db.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at')
    this.byProjectStmt = db.prepare(
      'SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    this.expireStmt = db.prepare(`
      UPDATE approvals SET status = 'timeout', decided_at = ?
      WHERE status = 'pending' AND created_at < ?
    `)
    this.recentStmt = db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?')
  }

  /**
   * Record a pending request.
   * @param input the request.
   * @param now the current time.
   */
  insert(input: ApprovalInput, now: number): void {
    this.insertStmt.run({
      id: input.id,
      run_id: input.run_id,
      project_id: input.project_id,
      request_json: input.request_json,
      status: input.status ?? 'pending',
      created_at: input.created_at ?? now,
    })
  }

  /**
   * Read one approval.
   * @param id the approval id.
   * @returns the row, or `undefined`.
   */
  get(id: string): ApprovalRow | undefined {
    return this.getStmt.get(id) as ApprovalRow | undefined
  }

  /**
   * Record a decision.
   * @param id the approval id.
   * @param status the outcome.
   * @param decidedBy the actor, or null when nobody answered.
   * @param now the decision time.
   * @returns whether the approval was still pending.
   */
  decide(id: string, status: Exclude<ApprovalStatus, 'pending'>, decidedBy: string | null, now: number): boolean {
    return this.decideStmt.run(status, decidedBy, now, id).changes > 0
  }

  /**
   * Every pending approval.
   * @returns the rows, oldest first.
   */
  listPending(): ApprovalRow[] {
    return this.listPendingStmt.all() as ApprovalRow[]
  }

  /**
   * One run's approvals.
   * @param runId the run id.
   * @returns the rows.
   */
  byRun(runId: string): ApprovalRow[] {
    return this.byRunStmt.all(runId) as ApprovalRow[]
  }

  /**
   * One project's recent approvals.
   * @param projectId the project slug.
   * @param limit the maximum number to return.
   * @returns the rows, newest first.
   */
  byProject(projectId: string, limit = 50): ApprovalRow[] {
    return this.byProjectStmt.all(projectId, limit) as ApprovalRow[]
  }

  /**
   * Mark stale pending approvals timed out.
   *
   * A startup sweep, so a crash during a pending approval does not leave a row
   * that a later answer could still resolve.
   *
   * @param olderThan the cutoff, epoch ms.
   * @param now the current time.
   * @returns the number of rows expired.
   */
  expirePending(olderThan: number, now: number): number {
    return this.expireStmt.run(now, olderThan).changes
  }

  /**
   * Recent approvals.
   * @param limit the maximum number to return.
   * @returns the rows, newest first.
   */
  recent(limit = 100): ApprovalRow[] {
    return this.recentStmt.all(limit) as ApprovalRow[]
  }
}
