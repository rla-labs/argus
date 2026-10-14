// == ARGUS AGENT PROJECT ==
/**
 * The `web_logins`, `web_sessions` and `web_totp` repository.
 *
 * Storage only: hashing a password, the lock-out rule, how long a session lasts
 * and checking a TOTP code are `ops-web`'s. The tables are always used together,
 * so they share a repository.
 *
 * @module @argus-agent/store/repositories/web-auth
 */
import type { DatabaseHandle } from '../connection.js'
import type { WebLoginRow, WebSessionRow, WebTotpRow } from '../types.js'

/** The `web_logins`, `web_sessions` and `web_totp` repository. */
export class WebAuthRepository {
  private readonly loginStmt
  private readonly byNameStmt
  private readonly upsertLoginStmt
  private readonly failuresStmt
  private readonly deleteLoginStmt
  private readonly insertSessionStmt
  private readonly sessionStmt
  private readonly touchStmt
  private readonly deleteSessionStmt
  private readonly deleteUserSessionsStmt
  private readonly pruneStmt
  private readonly totpStmt
  private readonly setTotpStmt
  private readonly totpStepStmt
  private readonly recoveryStmt
  private readonly deleteTotpStmt

  constructor(private readonly db: DatabaseHandle) {
    this.loginStmt = db.prepare('SELECT * FROM web_logins WHERE user_id = ?')
    this.byNameStmt = db.prepare('SELECT * FROM web_logins WHERE login = ?')
    this.upsertLoginStmt = db.prepare(`
      INSERT INTO web_logins (user_id, login, password_hash, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, password_hash = excluded.password_hash,
        updated_at = excluded.updated_at, failed_count = 0, locked_until = NULL
    `)
    this.deleteLoginStmt = db.prepare('DELETE FROM web_logins WHERE user_id = ?')
    this.failuresStmt = db.prepare('UPDATE web_logins SET failed_count = ?, locked_until = ? WHERE user_id = ?')
    this.insertSessionStmt = db.prepare(`
      INSERT INTO web_sessions (id_hash, user_id, via, created_at, expires_at, last_seen_at, user_agent)
      VALUES (@id_hash, @user_id, @via, @created_at, @expires_at, @last_seen_at, @user_agent)
    `)
    this.sessionStmt = db.prepare('SELECT * FROM web_sessions WHERE id_hash = ?')
    this.touchStmt = db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?')
    this.deleteSessionStmt = db.prepare('DELETE FROM web_sessions WHERE id_hash = ?')
    this.deleteUserSessionsStmt = db.prepare('DELETE FROM web_sessions WHERE user_id = ? AND id_hash != ?')
    this.pruneStmt = db.prepare('DELETE FROM web_sessions WHERE expires_at < ?')
    this.totpStmt = db.prepare('SELECT * FROM web_totp WHERE user_id = ?')
    this.setTotpStmt = db.prepare(`
      INSERT INTO web_totp (user_id, secret, recovery, last_step, enabled_at) VALUES (@user_id, @secret, @recovery, @last_step, @enabled_at)
      ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, recovery = excluded.recovery,
        last_step = excluded.last_step, enabled_at = excluded.enabled_at
    `)
    this.totpStepStmt = db.prepare('UPDATE web_totp SET last_step = ? WHERE user_id = ? AND last_step < ?')
    this.recoveryStmt = db.prepare('UPDATE web_totp SET recovery = ? WHERE user_id = ? AND recovery = ?')
    this.deleteTotpStmt = db.prepare('DELETE FROM web_totp WHERE user_id = ?')
  }

  /**
   * A user's web login.
   * @param userId the user id.
   * @returns the row, or `undefined` when the user has no password.
   */
  login(userId: string): WebLoginRow | undefined {
    return this.loginStmt.get(userId) as WebLoginRow | undefined
  }

  /**
   * The web login with a name, ignoring case.
   * @param login the name typed at sign-in.
   * @returns the row, or `undefined`.
   */
  loginByName(login: string): WebLoginRow | undefined {
    return this.byNameStmt.get(login) as WebLoginRow | undefined
  }

  /**
   * Set a user's login name and password hash; clears the failed sign-ins.
   * @param login the user, the name and the hash.
   * @param now the current time.
   * @returns `false` when another user has that name.
   */
  setLogin(login: { userId: string; login: string; passwordHash: string }, now: number): boolean {
    return this.db.transaction(() => {
      const owner = this.loginByName(login.login)
      if (owner !== undefined && owner.user_id !== login.userId) return false
      this.upsertLoginStmt.run(login.userId, login.login, login.passwordHash, now)
      return true
    })()
  }

  /**
   * Remove a user's login name and password (an admin's reset).
   * @param userId the user id.
   * @returns whether there was one.
   */
  deleteLogin(userId: string): boolean {
    return this.deleteLoginStmt.run(userId).changes > 0
  }

  /**
   * Record the failed sign-ins of a user.
   * @param userId the user id.
   * @param count failures since the last success or lock.
   * @param lockedUntil until when sign-in is refused, or `null`.
   */
  setFailures(userId: string, count: number, lockedUntil: number | null): void {
    this.failuresStmt.run(count, lockedUntil, userId)
  }

  /**
   * Store a new session.
   * @param session the row.
   */
  createSession(session: WebSessionRow): void {
    this.insertSessionStmt.run(session)
  }

  /**
   * A session by its hash.
   * @param idHash sha-256 of the cookie, hex.
   * @returns the row, expired or not, or `undefined`.
   */
  session(idHash: string): WebSessionRow | undefined {
    return this.sessionStmt.get(idHash) as WebSessionRow | undefined
  }

  /**
   * Note that a session was used.
   * @param idHash the session.
   * @param now the current time.
   */
  touchSession(idHash: string, now: number): void {
    this.touchStmt.run(now, idHash)
  }

  /**
   * End a session.
   * @param idHash the session.
   */
  deleteSession(idHash: string): void {
    this.deleteSessionStmt.run(idHash)
  }

  /**
   * End every session of a user but one.
   * @param userId the user id.
   * @param exceptIdHash the session to keep (the one asking), or `''` for none.
   * @returns how many ended.
   */
  deleteUserSessions(userId: string, exceptIdHash = ''): number {
    return this.deleteUserSessionsStmt.run(userId, exceptIdHash).changes
  }

  /**
   * Drop expired sessions.
   * @param now the current time.
   * @returns how many were dropped.
   */
  pruneSessions(now: number): number {
    return this.pruneStmt.run(now).changes
  }

  /**
   * A user's second factor.
   * @param userId the user id.
   * @returns the row, or `undefined` when they have none.
   */
  totp(userId: string): WebTotpRow | undefined {
    return this.totpStmt.get(userId) as WebTotpRow | undefined
  }

  /**
   * Set a user's second factor, replacing any.
   * @param row the secret, the recovery codes' hashes and when.
   */
  setTotp(row: WebTotpRow): void {
    this.setTotpStmt.run(row)
  }

  /**
   * Spend a 30-second step: a code is accepted only for a step later than the last one.
   * @param userId the user id.
   * @param step the step the code was for.
   * @returns whether it was later, and is now the last.
   */
  useTotpStep(userId: string, step: number): boolean {
    return this.totpStepStmt.run(step, userId, step).changes > 0
  }

  /**
   * Replace the unused recovery codes, if they are still what was read.
   * @param userId the user id.
   * @param before the JSON that was read.
   * @param after the JSON without the code just used.
   * @returns whether nobody changed them in between.
   */
  replaceRecovery(userId: string, before: string, after: string): boolean {
    return this.recoveryStmt.run(after, userId, before).changes > 0
  }

  /**
   * Remove a user's second factor.
   * @param userId the user id.
   * @returns whether there was one.
   */
  deleteTotp(userId: string): boolean {
    return this.deleteTotpStmt.run(userId).changes > 0
  }
}
