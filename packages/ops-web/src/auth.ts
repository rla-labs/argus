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
 * A user with a second factor (TOTP) gives a code after the password or the link:
 * the first step returns a ticket, valid five minutes, that the code trades for the
 * session. In public mode the server requires one; elsewhere it is a choice.
 *
 * @module @argus-agent/web/auth
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import type { OpsStore, WebSessionVia } from '@argus-agent/store'
import { matchStep, newRecoveryCodes, newSecret, otpauthUri, recoveryHash } from './totp.js'

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
/** How long the code may follow the password or the link. */
const TICKET_MS = 5 * 60_000
/** Wrong codes allowed per ticket. */
const TICKET_TRIES = 5
/** How long a secret being set up waits for its first code. */
const ENROL_MS = 10 * 60_000
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
export type LoginOutcome =
  | { ok: true; sessionId: string; session: Session }
  | { ok: false; reason: 'limited' | 'invalid' }
  /** The password or the link was right; the code is next, with this ticket. */
  | { ok: false; reason: 'totp'; ticket: string }

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
  private readonly tokens = new Map<string, { userId: string; expiresAt: number; recovery: boolean }>()
  private readonly tickets = new Map<string, { userId: string; via: WebSessionVia; expiresAt: number; tries: number }>()
  private readonly enrolling = new Map<string, { secret: string; expiresAt: number }>()
  private readonly fails = new Map<string, number[]>()

  /**
   * @param store where users, logins and sessions are.
   * @param sessionMs how long a session lasts.
   * @param now reads the current time.
   * @param idleMs how long an unused session lasts; 0 for no limit.
   */
  constructor(
    private readonly store: Pick<OpsStore, 'users' | 'webAuth'>,
    private readonly sessionMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly idleMs = 0,
  ) {}

  /**
   * A one-time sign-in token for a user.
   *
   * @param userId the Argus user id.
   * @param ttlMs how long it is valid: {@link LOGIN_TOKEN_TTL_MS} for `/web`,
   *   {@link INVITE_TTL_MS} for an invitation.
   * @param recovery whether it is the admin's way back in (`argus setup-link
   *   --admin`): it asks for no code and removes the second factor, to set again.
   * @returns the token.
   */
  issueToken(userId: string, ttlMs = LOGIN_TOKEN_TTL_MS, recovery = false): string {
    const now = this.now()
    for (const [key, entry] of this.tokens) if (entry.expiresAt < now) this.tokens.delete(key)
    const token = randomBytes(24).toString('base64url')
    this.tokens.set(token, { userId, expiresAt: now + ttlMs, recovery })
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
    // Whoever can read the server's files owns it already; a second factor adds nothing.
    if (entry.recovery) this.store.webAuth.deleteTotp(entry.userId)
    return this.next(entry.userId, 'link', userAgent)
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
    return this.next(row.user_id, 'password', userAgent)
  }

  /**
   * Trade a ticket and a code (or a recovery code) for the session.
   *
   * @param ticket from the first step.
   * @param code six digits, or a recovery code.
   * @param address who is asking, for the failed sign-in limit.
   * @param userAgent the browser.
   * @returns the session, or why not; `invalid` once the ticket is gone.
   */
  verifyTicket(ticket: string, code: string, address: string, userAgent?: string): LoginOutcome {
    if (this.limited(address)) return { ok: false, reason: 'limited' }
    const entry = this.tickets.get(ticket)
    if (entry === undefined || entry.expiresAt < this.now() || !this.enabled(entry.userId)) {
      this.tickets.delete(ticket)
      this.failed(address)
      return { ok: false, reason: 'invalid' }
    }
    if (!this.checkCode(entry.userId, code)) {
      this.failed(address)
      entry.tries += 1
      if (entry.tries >= TICKET_TRIES) this.tickets.delete(ticket)
      return { ok: false, reason: 'invalid' }
    }
    this.tickets.delete(ticket)
    return this.open(entry.userId, entry.via, userAgent)
  }

  /** Whether a user has a second factor. */
  hasTotp(userId: string): boolean {
    return this.store.webAuth.totp(userId) !== undefined
  }

  /**
   * Start setting up a second factor: a new secret, for the authenticator app. It
   * counts once {@link confirmTotp} gets a code from it.
   *
   * @param userId the signed-in user.
   * @returns the secret and the `otpauth://` link.
   */
  startTotp(userId: string): { secret: string; uri: string } {
    const secret = newSecret()
    this.enrolling.set(userId, { secret, expiresAt: this.now() + ENROL_MS })
    const user = this.store.users.get(userId)
    return { secret, uri: otpauthUri(secret, this.loginOf(userId) ?? user?.name ?? userId) }
  }

  /**
   * Finish setting up a second factor with a code from the app.
   *
   * @param userId the signed-in user.
   * @param code six digits.
   * @returns the recovery codes, shown once, or `undefined` when the code is wrong.
   */
  confirmTotp(userId: string, code: string): string[] | undefined {
    const pending = this.enrolling.get(userId)
    if (pending === undefined || pending.expiresAt < this.now()) return undefined
    const step = matchStep(pending.secret, code, this.now())
    if (step === undefined) return undefined
    this.enrolling.delete(userId)
    const codes = newRecoveryCodes()
    this.store.webAuth.setTotp({ user_id: userId, secret: pending.secret, recovery: JSON.stringify(codes.map(recoveryHash)), last_step: step, enabled_at: this.now() })
    return codes
  }

  /**
   * Remove a user's second factor, with a code from it.
   *
   * @param userId the signed-in user.
   * @param code six digits, or a recovery code.
   * @returns whether it was removed.
   */
  disableTotp(userId: string, code: string): boolean {
    if (!this.checkCode(userId, code)) return false
    return this.store.webAuth.deleteTotp(userId)
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
    const idle = this.idleMs > 0 && now - row.last_seen_at > this.idleMs
    if (row.expires_at < now || idle || !this.enabled(row.user_id)) {
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

  /** The session, or the ticket for the code when the user has a second factor. */
  private next(userId: string, via: WebSessionVia, userAgent: string | undefined): LoginOutcome {
    if (!this.hasTotp(userId)) return this.open(userId, via, userAgent)
    const now = this.now()
    for (const [key, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(key)
    const ticket = randomBytes(24).toString('base64url')
    this.tickets.set(ticket, { userId, via, expiresAt: now + TICKET_MS, tries: 0 })
    return { ok: false, reason: 'totp', ticket }
  }

  /** Whether a code is the user's: a TOTP code not used before, or an unused recovery code. */
  private checkCode(userId: string, code: string): boolean {
    const row = this.store.webAuth.totp(userId)
    if (row === undefined) return false
    const step = matchStep(row.secret, code, this.now())
    if (step !== undefined) return this.store.webAuth.useTotpStep(userId, step)
    const hashes = JSON.parse(row.recovery) as string[]
    const hash = recoveryHash(code)
    if (code.trim().length === 0 || !hashes.includes(hash)) return false
    return this.store.webAuth.replaceRecovery(userId, row.recovery, JSON.stringify(hashes.filter((each) => each !== hash)))
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
