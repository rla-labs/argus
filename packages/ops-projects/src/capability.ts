// == ARGUS AGENT PROJECT ==
/**
 * The delivery capability.
 *
 * ADR 0002 says `ops-projects.deliver()` may be called only by `ops-governor`.
 * A comment cannot enforce that, so the enforcement is a token: `ops-projects`
 * mints one at load and hands it to whichever plugin asks as the governor. A
 * caller without the token gets a thrown `GOVERNOR_REQUIRED`.
 *
 * The token is deliberately not a secret — everything in the process can read
 * it. It is a *declaration*: a caller must ask for the governor capability by
 * name, which makes the intent visible in the code and in a review, and makes an
 * accidental call from another plugin a loud failure rather than a silent
 * policy violation.
 *
 * @module @argus-agent/projects/capability
 */
import { OpsError } from '@argus-agent/types'

/** A capability token issued to exactly one holder. */
export interface Capability {
  /** What the token authorizes. */
  readonly scope: 'deliver'
  /** A per-process unique identity, so a forged object is not accepted. */
  readonly id: symbol
}

/** The plugin name that may claim the delivery capability. */
export const GOVERNOR_PLUGIN = 'ops-governor'

/**
 * Mints capability tokens and validates them.
 *
 * One instance per `ops-projects` load, so a token from a previous load is
 * rejected — which is what makes an HMR reload safe: a stale holder cannot
 * deliver through a new service instance.
 */
export class CapabilityIssuer {
  private readonly issued = new Map<string, Capability>()

  /**
   * Issue the delivery capability to a named plugin.
   *
   * @param holder the plugin name claiming it.
   * @returns the token.
   * @throws {OpsError} `INVALID_CAPABILITY` when another holder already claimed it.
   */
  issue(holder: string): Capability {
    const existing = this.issued.get('deliver')
    if (existing !== undefined) {
      throw new OpsError(
        'INVALID_CAPABILITY',
        `the delivery capability is already held; only one governor may exist per process`,
        { attemptedBy: holder },
      )
    }
    const capability: Capability = { scope: 'deliver', id: Symbol(holder) }
    this.issued.set('deliver', capability)
    return capability
  }

  /**
   * Claim the delivery capability for the governor.
   *
   * A convenience over {@link issue} with the governor's name, so the call site
   * reads as what it is.
   *
   * @param holder the plugin name claiming it; defaults to the governor.
   * @returns the token.
   * @throws {OpsError} `INVALID_CAPABILITY` when another holder already claimed it.
   */
  claim(holder: string = GOVERNOR_PLUGIN): Capability {
    return this.issue(holder)
  }

  /**
   * Verify a token, throwing when it is not the one this issuer minted.
   *
   * A plain method rather than an assertion function: an assertion signature on
   * a method read through a property is not callable in TypeScript, and a
   * boolean return is easier to reason about at the call site anyway.
   *
   * @param candidate the token to check.
   * @param caller the plugin name, for the error message.
   * @throws {OpsError} `GOVERNOR_REQUIRED` when the token is missing or not one
   *   this issuer minted.
   */
  assertCapability(candidate: unknown, caller: string): void {
    const current = this.issued.get('deliver')
    if (current === undefined) {
      throw new OpsError(
        'GOVERNOR_REQUIRED',
        'no delivery capability has been issued; ops-governor must claim it at load',
        { caller },
      )
    }
    if (candidate !== current) {
      throw new OpsError(
        'GOVERNOR_REQUIRED',
        `${caller} called deliver() without the governor capability. ` +
          'Only ops-governor may start execution; use ctx.opsGovernor.submit() instead.',
        { caller },
      )
    }
  }

  /** Revoke every token, so a disposed service accepts nothing. */
  revokeAll(): void {
    this.issued.clear()
  }
}
