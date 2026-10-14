// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/auth` — who may use the web interface.
 *
 * A person is a user of Argus. They sign in with a login name and a password, or
 * with a one-time `/web` link sent on another channel; the link is also how a first
 * password is set and a forgotten one reset. Signing in makes the web one of the
 * user's channels (an identity `web:<user id>`), so `user:<id>` reaches it too.
 *
 * Sessions are rows in `ops-store` (a hash of the cookie, never the cookie), so a
 * restart signs nobody out. Links stay in memory: they live ten minutes.
 *
 * @module @argus-agent/web/auth
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import type { OpsStore, WebSessionVia } from '@argus-agent/store'

/** How long a `/web` link stays valid, and how long after using one a password may be reset with it. */
export const LOGIN_TOKEN_TTL_MS = 10 * 60_000
/** How long an invitation (or an admin's password reset) link stays valid. */
export const INVITE_TTL_MS = 24 * 3_600_000
/** The shortest password accepted. */
export const MIN_PASSWORD_LENGTH = 10
/** Failed sign-ins allowed, per address and per user, before a pause. */
const MAX_FAILS = 5
/** The pause, and the window failures from one address are counted in. */
const LOCK_MS = 15 * 60_000
/** A session's last use is written at most this often. */
const TOUCH_MS = 60_000
/** scrypt's cost: 16 MiB and some 50 ms per hash. */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 }
/** What a login name may be. */
export const LOGIN_NAME = /^[\p{L}\p{N}._@-]{2,64}$/u

/** A signed-in person. */
export interface Session {
  /** The Argus user id. */
  readonly userId: string
  readonly expiresAt: number
  readonly createdAt: number
  readonly via: WebSessionVia
}

/** A sign-in's outcome. */
export type LoginOutcome = { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'limited' | 'invalid' }

/** Why a password was not set. */
export type PasswordRefusal = 'short' | 'login' | 'taken' | 'wrong'

/** Hash a password: `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, SCRYPT)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

/** Whether a password matches a stored hash, in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || salt === undefined || hash === undefined) return false
  const expected = Buffer.from(hash, 'base64url')
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length })
  return timingSafeEqual(actual, expected)
}

function scrypt(password: string, salt: Buffer, params: typeof SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password.normalize('NFC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1_048_576 }, (error, key) =>
      error === null ? resolve(key) : reject(error),
    ),
  )
}

/** A hash checked when the login name is unknown, so both cases take as long. */
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'))

const hashOf = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex')

/** Sign-in, sessions and passwords. */
export class WebAuth {
  private readonly tokens = new Map<string, { userId: string; expiresAt: number }>()
  private readonly fails = new Map<string, number[]>()

  /**
   * @param store where users, logins and sessions are.
   * @param sessionMs how long a session lasts.
   * @param now reads the current time.
   */
  constructor(
    private readonly store: Pick<OpsStore, 'users' | 'webAuth'>,
    private readonly sessionMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * A one-time sign-in token for a user.
   *
   * @param userId the Argus user id.
   * @param ttlMs how long it is valid: {@link LOGIN_TOKEN_TTL_MS} for `/web`,
   *   {@link INVITE_TTL_MS} for an invitation.
   * @returns the token.
   */
  issueToken(userId: string, ttlMs = LOGIN_TOKEN_TTL_MS): string {
    const now = this.now()
    for (const [key, entry] of this.tokens) if (entry.expiresAt < now) this.tokens.delete(key)
    const token = randomBytes(24).toString('base64url')
    this.tokens.set(token, { userId, expiresAt: now + ttlMs })
    return token
  }

  /**
   * Trade a `/web` token for a session. A token works once.
   *
   * @param token the token from the link.
   * @param address who is asking, for the failed sign-in limit.
   * @param userAgent the browser, shown with the session.
   * @returns the session, or why not.
   */
  login(token: string, address: string, userAgent?: string): LoginOutcome {
    if (this.limited(address)) return { ok: false, reason: 'limited' }
    const entry = this.tokens.get(token)
    this.tokens.delete(token)
    if (entry === undefined || entry.expiresAt < this.now() || !this.enabled(entry.userId)) {
      this.failed(address)
      return { ok: false, reason: 'invalid' }
    }
    return this.open(entry.userId, 'link', userAgent)
  }

  /**
   * Sign in with a login name and a password. An unknown name and a wrong password
   * get the same answer, after the same time.
   *
   * @param login the login name, any case.
   * @param password the password.
   * @param address who is asking, for the failed sign-in limit.
   * @param userAgent the browser.
   * @returns the session, or why not.
   */
  async loginWithPassword(login: string, password: string, address: string, userAgent?: string): Promise<LoginOutcome> {
    if (this.limited(address)) return { ok: false, reason: 'limited' }
    const row = this.store.webAuth.loginByName(login.trim())
    if (row === undefined) {
      await verifyPassword(password, await DUMMY_HASH)
      this.failed(address)
      return { ok: false, reason: 'invalid' }
    }
    if (row.locked_until !== null && row.locked_until > this.now()) return { ok: false, reason: 'limited' }
    const ok = (await verifyPassword(password, row.password_hash)) && this.enabled(row.user_id)
    if (!ok) {
      this.failed(address)
      const count = row.failed_count + 1
      if (count >= MAX_FAILS) this.store.webAuth.setFailures(row.user_id, 0, this.now() + LOCK_MS)
      else this.store.webAuth.setFailures(row.user_id, count, null)
      return { ok: false, reason: 'invalid' }
    }
    if (row.failed_count > 0 || row.locked_until !== null) this.store.webAuth.setFailures(row.user_id, 0, null)
    return this.open(row.user_id, 'password', userAgent)
  }

  /**
   * The session a cookie names, while it is valid and its user enabled.
   *
   * @param sessionId the cookie's value.
   * @returns the session, or `undefined`.
   */
  session(sessionId: string | undefined): Session | undefined {
    if (sessionId === undefined || sessionId.length === 0) return undefined
    const idHash = hashOf(sessionId)
    const row = this.store.webAuth.session(idHash)
    if (row === undefined) return undefined
    const now = this.now()
    if (row.expires_at < now || !this.enabled(row.user_id)) {
      this.store.webAuth.deleteSession(idHash)
      return undefined
    }
    if (now - row.last_seen_at >= TOUCH_MS) this.store.webAuth.touchSession(idHash, now)
    return { userId: row.user_id, expiresAt: row.expires_at, createdAt: row.created_at, via: row.via }
  }

  /** End a session. */
  logout(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.store.webAuth.deleteSession(hashOf(sessionId))
  }

  /**
   * A user's login name.
   *
   * @param userId the Argus user id.
   * @returns the name, or `undefined` when they have no password yet.
   */
  loginOf(userId: string): string | undefined {
    return this.store.webAuth.login(userId)?.login
  }

  /**
   * Whether a session may set a password without the current one: there is none
   * yet, or the session came from a `/web` link within the last ten minutes (the
   * way to reset a forgotten password).
   */
  mayResetPassword(session: Session): boolean {
    return this.loginOf(session.userId) === undefined || (session.via === 'link' && this.now() - session.createdAt <= LOGIN_TOKEN_TTL_MS)
  }

  /**
   * Set the signed-in user's login name and password. Every other session of the
   * user ends.
   *
   * @param sessionId the cookie of the session asking.
   * @param change the login name (kept when omitted), the new password and, unless
   *   {@link mayResetPassword}, the current one.
   * @returns whether it was set, or why not.
   */
  async setPassword(
    sessionId: string,
    change: { login?: string; password: string; current?: string },
  ): Promise<{ ok: true } | { ok: false; reason: PasswordRefusal }> {
    const session = this.session(sessionId)
    if (session === undefined) return { ok: false, reason: 'wrong' }
    const existing = this.store.webAuth.login(session.userId)
    const login = change.login?.trim() || existing?.login || ''
    if (!LOGIN_NAME.test(login)) return { ok: false, reason: 'login' }
    if ([...change.password].length < MIN_PASSWORD_LENGTH || change.password.length > 1_024) return { ok: false, reason: 'short' }
    if (!this.mayResetPassword(session)) {
      if (existing === undefined || change.current === undefined || !(await verifyPassword(change.current, existing.password_hash))) {
        return { ok: false, reason: 'wrong' }
      }
    }
    const passwordHash = await hashPassword(change.password)
    if (!this.store.webAuth.setLogin({ userId: session.userId, login, passwordHash }, this.now())) return { ok: false, reason: 'taken' }
    this.store.webAuth.deleteUserSessions(session.userId, hashOf(sessionId))
    return { ok: true }
  }

  /** Open a session, and make the web one of the user's channels. */
  open(userId: string, via: WebSessionVia, userAgent: string | undefined): LoginOutcome {
    const now = this.now()
    this.store.webAuth.pruneSessions(now)
    this.store.users.link({ channel: 'web', external_id: userId, user_id: userId }, now)
    const sessionId = randomBytes(32).toString('base64url')
    const session: Session = { userId, expiresAt: now + this.sessionMs, createdAt: now, via }
    this.store.webAuth.createSession({
      id_hash: hashOf(sessionId),
      user_id: userId,
      via,
      created_at: now,
      expires_at: session.expiresAt,
      last_seen_at: now,
      user_agent: userAgent?.slice(0, 200) ?? null,
    })
    return { ok: true, sessionId, session }
  }

  /** Whether a user exists and is enabled. */
  private enabled(userId: string): boolean {
    const user = this.store.users.get(userId)
    return user !== undefined && user.disabled_at === null
  }

  /** Count a failure from an address. */
  private failed(address: string): void {
    this.fails.set(address, [...(this.fails.get(address) ?? []), this.now()])
  }

  /** Whether an address has failed too often lately. */
  private limited(address: string): boolean {
    const recent = (this.fails.get(address) ?? []).filter((at) => at > this.now() - LOCK_MS)
    if (recent.length === 0) this.fails.delete(address)
    else this.fails.set(address, recent)
    return recent.length >= MAX_FAILS
  }
}
