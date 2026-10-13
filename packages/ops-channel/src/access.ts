// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/channel/access` — who may operate Argus.
 *
 * **Default deny.** Only an enabled user, found by one of their channel
 * identities, is let in. A deployment that has not said who may operate the
 * system has not authorized anyone, and a monitoring system that spends money is
 * not something to leave open by accident.
 *
 * @module @argus-agent/channel/access
 */
import type { ChannelAddress } from '@argus-agent/types'
import type { UserRole, UsersRepository } from '@argus-agent/store'

/** One user listed in `access.allowed_users`: the seed of the `users` table. */
export interface AllowedUser {
  /** The adapter name, or `*` for every channel. */
  readonly channel: string
  /** The platform user id. */
  readonly userId: string
}

/** The access configuration. */
export interface AccessConfig {
  /** Where warnings about rejected messages go. */
  readonly admin: ChannelAddress | undefined
  /** How often an admin warning may fire, in milliseconds. */
  readonly warnIntervalMs: number
}

/** The part of `store.users` access reads. */
export type UserLookup = Pick<UsersRepository, 'resolve' | 'get' | 'list'>

/** Who a message comes from, when they are a user. */
export interface AccessUser {
  readonly id: string
  readonly role: UserRole
}

/** The result of an access check. */
export interface AccessDecision {
  readonly allowed: boolean
  /** Why it was refused, for the log. Never contains message content. */
  readonly reason?: 'no_allowlist' | 'not_listed' | 'disabled'
  /** The user, when allowed. */
  readonly user?: AccessUser
}

/**
 * Access, by user.
 *
 * Every check reads the `users` table, so adding, disabling or changing the role
 * of a user applies to the next message.
 */
export class AccessPolicy {
  private lastWarningAt = Number.NEGATIVE_INFINITY
  private suppressedWarnings = 0

  /**
   * @param config where warnings go and how often.
   * @param users the users and their identities.
   */
  constructor(
    private readonly config: AccessConfig,
    private readonly users: UserLookup,
  ) {}

  /**
   * Whether a message comes from the admin: the admin user, or anyone allowed in a
   * group chat that is the admin's identity.
   */
  isAdmin(address: ChannelAddress, userId: string): boolean {
    const sender = this.check(address.channel, userId)
    if (!sender.allowed) return false
    if (sender.user?.role === 'admin') return true
    const chat = this.users.resolve(address.channel, address.chatId)
    if (chat?.kind !== 'chat') return false
    const owner = this.users.get(chat.user_id)
    return owner?.role === 'admin' && owner.disabled_at === null
  }

  /**
   * Who may operate the system: an enabled user with this identity.
   *
   * The match is exact on the user id — a prefix or substring match would let
   * `1234` authorize `12345`, which is the classic allowlist bug. An identity on
   * channel `*` matches every adapter.
   *
   * @param channel the adapter the message arrived on.
   * @param userId the platform user id.
   * @returns the decision, with the user when allowed.
   */
  check(channel: string, userId: string): AccessDecision {
    const identity = this.users.resolve(channel, userId)
    const user = identity === undefined ? undefined : this.users.get(identity.user_id)
    if (user === undefined) return { allowed: false, reason: this.isEmpty ? 'no_allowlist' : 'not_listed' }
    if (user.disabled_at !== null) return { allowed: false, reason: 'disabled' }
    return { allowed: true, user: { id: user.id, role: user.role } }
  }

  /**
   * Whether a user may answer a question.
   *
   * The same rule as {@link check}: an answer is an operation, and a question's
   * buttons are as capable as a typed command.
   *
   * @param channel the adapter.
   * @param userId the platform user id.
   * @returns whether the answer is accepted.
   */
  isAllowed(channel: string, userId: string): boolean {
    return this.check(channel, userId).allowed
  }

  /** Whether no user is enabled. For diagnostics and startup warnings. */
  get isEmpty(): boolean {
    return this.size === 0
  }

  /** How many users are enabled. */
  get size(): number {
    return this.users.list().filter((user) => user.disabled_at === null).length
  }

  /**
   * Whether an admin warning may fire now.
   *
   * Rate-limited, because an unauthenticated stranger can send messages as fast
   * as their platform allows, and a warning per message would flood the admin's
   * chat — turning a nuisance into an outage.
   *
   * @param now the current time.
   * @returns whether to warn.
   */
  shouldWarn(now: number): boolean {
    if (this.config.admin === undefined) return false
    // The first warning always fires. Tracking "never warned" as `-Infinity`
    // rather than `0` is what keeps a warning sent at clock zero from being
    // suppressed by its own initial state.
    if (this.lastWarningAt !== Number.NEGATIVE_INFINITY && now - this.lastWarningAt < this.config.warnIntervalMs) {
      this.suppressedWarnings += 1
      return false
    }
    this.lastWarningAt = now
    this.suppressedWarnings = 0
    return true
  }

  /** How many warnings were suppressed since the last one. */
  get suppressed(): number {
    return this.suppressedWarnings
  }

  /** Where an admin warning goes, when one is configured. */
  get admin(): ChannelAddress | undefined {
    return this.config.admin
  }
}

/**
 * The text of an admin warning.
 *
 * It names the **user and channel** and never the message content: a stranger's
 * text is untrusted input, and echoing it into an operator's chat would be a
 * delivery vector for whatever they wrote.
 *
 * @param channel the adapter.
 * @param userId the platform user id.
 * @param reason why it was refused.
 * @param suppressed how many warnings were suppressed before this one.
 * @returns the warning text.
 */
export function warningText(
  channel: string,
  userId: string,
  reason: NonNullable<AccessDecision['reason']>,
  suppressed: number,
): string {
  const cause =
    reason === 'no_allowlist'
      ? 'Argus has no users yet, so every message is refused.'
      : reason === 'disabled'
        ? 'That user is disabled.'
        : 'That user is not a user of Argus. /allow adds them.'
  const extra =
    suppressed > 0 ? `\n(${suppressed} further attempt(s) were not reported.)` : ''
  return (
    `A message from an unauthorized user was dropped.\n` +
    `  channel  ${channel}\n  user     ${userId}\n` +
    `  ${cause}${extra}`
  )
}
