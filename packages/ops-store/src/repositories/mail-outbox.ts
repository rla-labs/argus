// == ARGUS AGENT PROJECT ==
/**
 * The `mail_outbox` repository: mails waiting for a person's approval, and what became
 * of them.
 *
 * @module @argus-agent/store/repositories/mail-outbox
 */
import type { DatabaseHandle } from '../connection.js'
import type { MailOutboxRow, MailOutboxStatus } from '../types.js'

/** The `mail_outbox` repository. */
export class MailOutboxRepository {
  private readonly insertStmt
  private readonly getStmt
  private readonly decideStmt
  private readonly waitingStmt
  private readonly byProjectStmt

  constructor(db: DatabaseHandle) {
    this.insertStmt = db.prepare(`
      INSERT INTO mail_outbox (project_id, run_id, created_at, recipients, digest, why)
      VALUES (@project_id, @run_id, @created_at, @recipients, @digest, @why)
    `)
    this.getStmt = db.prepare('SELECT * FROM mail_outbox WHERE id = ?')
    // Guarded by `status = 'waiting'`: a mail is decided once, whoever comes first.
    this.decideStmt = db.prepare(`
      UPDATE mail_outbox SET status = ?, decided_by = ?, decided_at = ?, note = ?
      WHERE id = ? AND status = 'waiting'
    `)
    this.waitingStmt = db.prepare("SELECT * FROM mail_outbox WHERE status = 'waiting' ORDER BY created_at")
    this.byProjectStmt = db.prepare('SELECT * FROM mail_outbox WHERE project_id = ? ORDER BY id DESC LIMIT ?')
  }

  /**
   * Put a mail in the outbox.
   * @returns its id.
   */
  insert(input: { project_id: string; run_id: string | null; recipients: number; digest: string; why: string | null }, now: number): number {
    return Number(this.insertStmt.run({ ...input, created_at: now }).lastInsertRowid)
  }

  /** One mail's row. */
  get(id: number): MailOutboxRow | undefined {
    return this.getStmt.get(id) as MailOutboxRow | undefined
  }

  /**
   * Decide a waiting mail.
   * @returns whether it was still waiting.
   */
  decide(id: number, status: Exclude<MailOutboxStatus, 'waiting'>, decidedBy: string | null, note: string | null, now: number): boolean {
    return this.decideStmt.run(status, decidedBy, now, note, id).changes > 0
  }

  /** Every waiting mail, oldest first. */
  waiting(): MailOutboxRow[] {
    return this.waitingStmt.all() as MailOutboxRow[]
  }

  /** A project's mails, newest first. */
  byProject(projectId: string, limit = 20): MailOutboxRow[] {
    return this.byProjectStmt.all(projectId, limit) as MailOutboxRow[]
  }
}
