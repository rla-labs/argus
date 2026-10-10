// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/auth` — who may use the web interface.
 *
 * 0.3.0: a person proves who they are in Telegram. `/web` (admin) asks for a
 * one-time link; opening it trades the token for a session cookie. Everything that
 * knows how a login happens is in this module, so 0.4.0 can replace it with the
 * web's own accounts without touching the rest.
 *
 * Tokens and sessions live in memory: a restart logs everyone out, which for one
 * admin on a private network costs one `/web`.
 *
 * @module @argus-agent/web/auth
 */
import { randomBytes } from 'node:crypto'

/** How long a `/web` link stays valid. */
export const LOGIN_TOKEN_TTL_MS = 10 * 60_000
/** Failed logins allowed per address within {@link FAIL_WINDOW_MS}. */
const MAX_FAILS = 5
const FAIL_WINDOW_MS = 15 * 60_000

/** A logged-in person. */
export interface Session {
  readonly userId: string
  readonly expiresAt: number
}

/** Logins, sessions and the failed-login limit. */
export class WebAuth {
  private readonly tokens = new Map<string, { userId: string; expiresAt: number }>()
  private readonly sessions = new Map<string, Session>()
  private readonly fails = new Map<string, number[]>()

  constructor(
    private readonly sessionMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * A one-time login token for a person, valid {@link LOGIN_TOKEN_TTL_MS}.
   *
   * @param userId the person, as the channel knows them.
   * @returns the token.
   */
  issueToken(userId: string): string {
    this.sweep()
    const token = randomBytes(24).toString('base64url')
    this.tokens.set(token, { userId, expiresAt: this.now() + LOGIN_TOKEN_TTL_MS })
    return token
  }

  /**
   * Trade a login token for a session. A token works once.
   *
   * @param token the token from the link.
   * @param address who is asking, for the failed-login limit.
   * @returns the session id, or why not.
   */
  login(token: string, address: string): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'limited' | 'invalid' } {
    if (this.limited(address)) return { ok: false, reason: 'limited' }
    const entry = this.tokens.get(token)
    this.tokens.delete(token)
    if (entry === undefined || entry.expiresAt < this.now()) {
      this.fails.set(address, [...(this.fails.get(address) ?? []), this.now()])
      return { ok: false, reason: 'invalid' }
    }
    const sessionId = randomBytes(32).toString('base64url')
    const session = { userId: entry.userId, expiresAt: this.now() + this.sessionMs }
    this.sessions.set(sessionId, session)
    return { ok: true, sessionId, session }
  }

  /**
   * The session a cookie names, while it is valid.
   *
   * @param sessionId the cookie's value.
   * @returns the session, or `undefined`.
   */
  session(sessionId: string | undefined): Session | undefined {
    if (sessionId === undefined) return undefined
    const session = this.sessions.get(sessionId)
    if (session === undefined) return undefined
    if (session.expiresAt < this.now()) {
      this.sessions.delete(sessionId)
      return undefined
    }
    return session
  }

  /** End a session. */
  logout(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.sessions.delete(sessionId)
  }

  /** Whether an address has failed too often lately. */
  private limited(address: string): boolean {
    const recent = (this.fails.get(address) ?? []).filter((at) => at > this.now() - FAIL_WINDOW_MS)
    this.fails.set(address, recent)
    return recent.length >= MAX_FAILS
  }

  /** Drop expired tokens and sessions. */
  private sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.tokens) if (entry.expiresAt < now) this.tokens.delete(key)
    for (const [key, entry] of this.sessions) if (entry.expiresAt < now) this.sessions.delete(key)
  }
}
