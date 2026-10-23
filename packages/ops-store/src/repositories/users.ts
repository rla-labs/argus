// == ARGUS AGENT PROJECT ==
/**
 * The `users` and `identities` repository.
 *
 * A user is a person; an identity is one way that person reaches Argus (a
 * Telegram id, later a web login's, a Slack id). The two tables are always read
 * together, so they share a repository.
 *
 * @module @argus-agent/store/repositories/users
 */
import type { DatabaseHandle } from '../connection.js'
import type { IdentityKind, IdentityRow, UserRole, UserRow } from '../types.js'

/** The `users` and `identities` repository. */
export class UsersRepository {
  private readonly getStmt
  private readonly listStmt
  private readonly adminStmt
  private readonly insertStmt
  private readonly roleStmt
  private readonly nameStmt
  private readonly demoteAdminStmt
  private readonly disableStmt
  private readonly enableStmt
  private readonly identityStmt
  private readonly identitiesStmt
  private readonly linkStmt
  private readonly unlinkStmt

  constructor(private readonly db: DatabaseHandle) {
    this.getStmt = db.prepare('SELECT * FROM users WHERE id = ?')
    this.listStmt = db.prepare('SELECT * FROM users ORDER BY created_at, id')
    this.adminStmt = db.prepare("SELECT * FROM users WHERE role = 'admin' AND disabled_at IS NULL")
    this.insertStmt = db.prepare('INSERT INTO users (id, name, role, created_at) VALUES (?, ?, ?, ?)')
    this.roleStmt = db.prepare('UPDATE users SET role = ? WHERE id = ?')
    this.nameStmt = db.prepare('UPDATE users SET name = ? WHERE id = ?')
    this.demoteAdminStmt = db.prepare("UPDATE users SET role = 'operator' WHERE role = 'admin' AND id != ?")
    this.disableStmt = db.prepare('UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL')
    this.enableStmt = db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL')
    this.identityStmt = db.prepare('SELECT * FROM identities WHERE channel = ? AND external_id = ?')
    this.identitiesStmt = db.prepare('SELECT * FROM identities WHERE user_id = ? ORDER BY created_at, channel')
    this.linkStmt = db.prepare(`
      INSERT INTO identities (channel, external_id, kind, user_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, external_id) DO NOTHING
    `)
    this.unlinkStmt = db.prepare('DELETE FROM identities WHERE channel = ? AND external_id = ?')
  }

  /**
   * Read one user.
   * @param id the user id.
   * @returns the row, or `undefined`.
   */
  get(id: string): UserRow | undefined {
    return this.getStmt.get(id) as UserRow | undefined
  }

  /** Every user, disabled ones included, oldest first. */
  list(): UserRow[] {
    return this.listStmt.all() as UserRow[]
  }

  /** The enabled admin, when there is one. */
  admin(): UserRow | undefined {
    return this.adminStmt.get() as UserRow | undefined
  }

  /**
   * Create a user. Creating an admin demotes the previous one in the same
   * transaction, since there is exactly one.
   * @param user the new user.
   * @param now the current time.
   */
  create(user: { id: string; name?: string | null; role: UserRole }, now: number): void {
    this.db.transaction(() => {
      if (user.role === 'admin') this.demoteAdminStmt.run(user.id)
      this.insertStmt.run(user.id, user.name ?? null, user.role, now)
    })()
  }

  /**
   * Change a user's role. Making a user the admin demotes the previous one.
   * @param id the user id.
   * @param role the new role.
   * @returns whether the user exists.
   */
  setRole(id: string, role: UserRole): boolean {
    return this.db.transaction(() => {
      if (role === 'admin') this.demoteAdminStmt.run(id)
      return this.roleStmt.run(role, id).changes > 0
    })()
  }

  /**
   * Set the language a user reads the web interface in.
   * @param id the user id.
   * @param language a language's code, or `null` to follow the browser.
   * @returns whether the user exists.
   */
  setLanguage(id: string, language: string | null): boolean {
    return this.db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, id).changes > 0
  }

  /**
   * Rename a user.
   * @param id the user id.
   * @param name the new name, or `null`.
   * @returns whether the user exists.
   */
  setName(id: string, name: string | null): boolean {
    return this.nameStmt.run(name, id).changes > 0
  }

  /**
   * Disable a user: refused on every channel from then on. The row stays, for the audit.
   * @param id the user id.
   * @param now the current time.
   * @returns whether an enabled user was disabled.
   */
  disable(id: string, now: number): boolean {
    return this.disableStmt.run(now, id).changes > 0
  }

  /**
   * Enable a disabled user again.
   * @param id the user id.
   * @returns whether a disabled user was enabled.
   */
  enable(id: string): boolean {
    return this.enableStmt.run(id).changes > 0
  }

  /**
   * Read one identity, exactly as stored.
   * @param channel the adapter name, or `*`.
   * @param externalId the platform id.
   * @returns the row, or `undefined`.
   */
  identity(channel: string, externalId: string): IdentityRow | undefined {
    return this.identityStmt.get(channel, externalId) as IdentityRow | undefined
  }

  /**
   * The identity a platform id resolves to on a channel: its own, else a `*` one.
   * @param channel the adapter name.
   * @param externalId the platform id.
   * @returns the row, or `undefined`.
   */
  resolve(channel: string, externalId: string): IdentityRow | undefined {
    return this.identity(channel, externalId) ?? this.identity('*', externalId)
  }

  /**
   * A user's identities.
   * @param userId the user id.
   * @returns the rows.
   */
  identities(userId: string): IdentityRow[] {
    return this.identitiesStmt.all(userId) as IdentityRow[]
  }

  /**
   * Attach an identity to a user.
   * @param identity the identity.
   * @param now the current time.
   * @returns `false` when the identity already belongs to someone (it is not moved).
   */
  link(identity: { channel: string; external_id: string; kind?: IdentityKind; user_id: string }, now: number): boolean {
    return this.linkStmt.run(identity.channel, identity.external_id, identity.kind ?? 'user', identity.user_id, now).changes > 0
  }

  /**
   * Detach an identity.
   * @param channel the adapter name, or `*`.
   * @param externalId the platform id.
   * @returns whether it existed.
   */
  unlink(channel: string, externalId: string): boolean {
    return this.unlinkStmt.run(channel, externalId).changes > 0
  }
}
