// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/setup` — the first admin, and the way back in for a lost one.
 *
 * While there is no admin, the web offers `/setup`: a one-time link, valid an hour,
 * creates the admin with a login name and a password. The link is written to a file
 * in the state directory (mode 600), never to the log, and `argus setup-link` shows
 * it. With an admin, `argus setup-link --admin` leaves a request file and restarts
 * the service; at start the request becomes a one-time sign-in link for the admin,
 * with leave to set a new password, in the same file.
 *
 * @module @argus-agent/web/setup
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OpsStore } from '@argus-agent/store'
import { hashPassword, LOGIN_NAME, MIN_PASSWORD_LENGTH, type LoginOutcome, type WebAuth } from './auth.js'

/** How long a setup or recovery link stays valid. */
export const SETUP_TTL_MS = 3_600_000
/** The file the link is written to, in the state directory. */
export const SETUP_LINK_FILE = 'setup-link'
/** The file `argus setup-link --admin` leaves, in the state directory. */
export const ADMIN_LINK_REQUEST = 'admin-link.request'

/** Why the admin was not created. */
export type SetupRefusal = 'invalid' | 'short' | 'login'

const digest = (token: string): Buffer => createHash('sha256').update(token).digest()

/** The setup link while there is no admin, and the admin's recovery link. */
export class SetupGate {
  private current: { hash: Buffer; expiresAt: number } | undefined

  /**
   * @param store where users and logins are.
   * @param auth opens the admin's session.
   * @param stateDir where the link file goes.
   * @param publicUrl the address the browser uses.
   * @param now reads the current time.
   */
  constructor(
    private readonly store: Pick<OpsStore, 'users' | 'webAuth'>,
    private readonly auth: WebAuth,
    private readonly stateDir: string,
    private readonly publicUrl: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether setup is open: there is no admin yet. */
  get open(): boolean {
    return this.store.users.admin() === undefined
  }

  /**
   * At start, and every hour while setup is open: a fresh setup link while there is
   * no admin; the admin's sign-in link when one was asked for; else no link file.
   *
   * @returns what was written: `setup`, `admin`, or `undefined` for nothing.
   */
  refresh(): 'setup' | 'admin' | undefined {
    const request = join(this.stateDir, ADMIN_LINK_REQUEST)
    const asked = existsSync(request)
    rmSync(request, { force: true })
    if (this.open) {
      const token = randomBytes(32).toString('base64url')
      this.current = { hash: digest(token), expiresAt: this.now() + SETUP_TTL_MS }
      this.write(`${this.publicUrl}/setup?token=${token}`)
      return 'setup'
    }
    this.current = undefined
    const admin = this.store.users.admin()
    if (asked && admin !== undefined) {
      this.write(`${this.publicUrl}/login?token=${this.auth.issueToken(admin.id, SETUP_TTL_MS, true)}`)
      return 'admin'
    }
    rmSync(this.file, { force: true })
    return undefined
  }

  /** Whether a token is the live setup token. */
  valid(token: string): boolean {
    const current = this.current
    return current !== undefined && current.expiresAt >= this.now() && this.open && timingSafeEqual(digest(token), current.hash)
  }

  /**
   * Create the admin, with a login name and a password, and sign them in. The token
   * is spent before anything else, so two requests cannot both create one.
   *
   * @param token the token from the link.
   * @param admin the name shown, the login name and the password.
   * @param userAgent the browser.
   * @returns the session, or why not.
   */
  async complete(
    token: string,
    admin: { name: string; login: string; password: string },
    userAgent?: string,
  ): Promise<LoginOutcome | { ok: false; reason: SetupRefusal }> {
    const login = admin.login.trim()
    if (!LOGIN_NAME.test(login)) return { ok: false, reason: 'login' }
    if ([...admin.password].length < MIN_PASSWORD_LENGTH || admin.password.length > 1_024) return { ok: false, reason: 'short' }
    if (!this.valid(token)) return { ok: false, reason: 'invalid' }
    this.current = undefined
    rmSync(this.file, { force: true })
    const passwordHash = await hashPassword(admin.password)
    const now = this.now()
    const id = randomUUID()
    const name = admin.name.trim()
    this.store.users.create({ id, role: 'admin', ...(name.length === 0 ? {} : { name: name.slice(0, 80) }) }, now)
    this.store.webAuth.setLogin({ userId: id, login, passwordHash }, now)
    return this.auth.open(id, 'password', userAgent)
  }

  private get file(): string {
    return join(this.stateDir, SETUP_LINK_FILE)
  }

  private write(link: string): void {
    // Removed first: `mode` applies only to a file being created.
    mkdirSync(this.stateDir, { recursive: true })
    rmSync(this.file, { force: true })
    writeFileSync(this.file, `${link}\n`, { mode: 0o600 })
  }
}
