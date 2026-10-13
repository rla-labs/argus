// == ARGUS AGENT PROJECT ==
/**
 * The `web_logins` and `web_sessions` repository.
 *
 * Storage only: hashing a password, the lock-out rule and how long a session
 * lasts are `ops-web`'s. The two tables are always used together, so they share
 * a repository.
 *
 * @module @argus-agent/store/repositories/web-auth
 */
import type { DatabaseHandle } from '../connection.js'
import type { WebLoginRow, WebSessionRow } from '../types.js'

/** The `web_logins` and `web_sessions` repository. */
export class WebAuthRepository {
  private readonly loginStmt
  private readonly byNameStmt
  private readonly upsertLoginStmt
  private readonly failuresStmt
  private readonly insertSessionStmt
  private readonly sessionStmt
  private readonly touchStmt
  private readonly deleteSessionStmt
  private readonly deleteUserSessionsStmt
  private readonly pruneStmt

  constructor(private readonly db: DatabaseHandle) {
    this.loginStmt = db.prepare('SELECT * FROM web_logins WHERE user_id = ?')
    this.byNameStmt = db.prepare('SELECT * FROM web_logins WHERE login = ?')
    this.upsertLoginStmt = db.prepare(`
      INSERT INTO web_logins (user_id, login, password_hash, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, password_hash = excluded.password_hash,
        updated_at = excluded.updated_at, failed_count = 0, locked_until = NULL
    `)
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
}
