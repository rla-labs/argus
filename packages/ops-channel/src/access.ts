// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/channel/access` — the allowlist.
 *
 * **Default deny.** With no `access.allowed_users`, every message is dropped. A
 * deployment that has not said who may operate the system has not authorized
 * anyone, and a monitoring system that spends money is not something to leave
 * open by accident.
 *
 * @module @argus-agent/channel/access
 */
import type { ChannelAddress } from '@argus-agent/types'

/** One authorized user. */
export interface AllowedUser {
  /** The adapter name, or `*` for every channel. */
  readonly channel: string
  /** The platform user id. */
  readonly userId: string
}

/** The access configuration. */
export interface AccessConfig {
  readonly allowed_users: readonly AllowedUser[]
  /** Where warnings about rejected messages go. */
  readonly admin: ChannelAddress | undefined
  /** How often an admin warning may fire, in milliseconds. */
  readonly warnIntervalMs: number
}

/** The result of an access check. */
export interface AccessDecision {
  readonly allowed: boolean
  /** Why it was refused, for the log. Never contains message content. */
  readonly reason?: 'no_allowlist' | 'not_listed'
}

/**
 * The allowlist.
 *
 * Immutable after construction: it is built once from configuration, and a
 * reload constructs a new one. That makes a check a pure lookup with no
 * invalidation to get wrong.
 */
export class AccessPolicy {
  private readonly entries: readonly AllowedUser[]
  private lastWarningAt = Number.NEGATIVE_INFINITY
  private suppressedWarnings = 0

  constructor(private readonly config: AccessConfig) {
    this.entries = config.allowed_users
  }

  /**
   * Whether a user may operate the system.
   *
   * A `channel: '*'` entry authorizes the user on every adapter. The match is
   * exact on the user id — a prefix or substring match would let `1234` authorize
   * `12345`, which is the classic allowlist bug.
   *
   * @param channel the adapter the message arrived on.
   * @param userId the platform user id.
   * @returns the decision.
   */
  check(channel: string, userId: string): AccessDecision {
    if (this.entries.length === 0) return { allowed: false, reason: 'no_allowlist' }
    for (const entry of this.entries) {
      if (entry.userId !== userId) continue
      if (entry.channel === channel || entry.channel === '*') return { allowed: true }
    }
    return { allowed: false, reason: 'not_listed' }
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

  /** Whether any user is authorized at all. For diagnostics and startup warnings. */
  get isEmpty(): boolean {
    return this.entries.length === 0
  }

  /** How many entries are configured. */
  get size(): number {
    return this.entries.length
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
      ? 'No access.allowed_users is configured, so every message is refused.'
      : 'That user is not in access.allowed_users.'
  const extra =
    suppressed > 0 ? `\n(${suppressed} further attempt(s) were not reported.)` : ''
  return (
    `A message from an unauthorized user was dropped.\n` +
    `  channel  ${channel}\n  user     ${userId}\n` +
    `  ${cause}${extra}`
  )
}
