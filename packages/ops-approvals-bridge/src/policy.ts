// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/approvals-bridge/policy` — the decision, as a pure function.
 *
 * The project's three-valued `mode` maps onto dsh's two policies (SPIKES.md
 * deviation 1), and this is where that mapping lives:
 *
 * | Project mode | dsh session policy | This function |
 * |---|---|---|
 * | `ask`  | `ask`   | always `ask` |
 * | `deny` | `never` | never reached: dsh auto-rejects before the chain runs |
 * | `auto` | `ask`   | `allow` for an allow-listed argv, else `ask` |
 *
 * @module @argus-agent/approvals-bridge/policy
 */
import { matchAllowList, type ParsedAction } from './argv.js'

/** The bridge's decision for one approval request. */
export type ApprovalDecision =
  | { readonly kind: 'allow'; readonly rule: string }
  | { readonly kind: 'allow-run'; readonly because: string }
  | { readonly kind: 'ask' }
  | { readonly kind: 'deny'; readonly reason: string }

/** What the policy needs to know. */
export interface PolicySnapshot {
  /** The project's mode. */
  readonly mode: 'auto' | 'ask' | 'deny'
  /** The project's allow rules, each a command line. */
  readonly autoAllow: readonly string[]
  /** The ad-hoc policy, used when there is no project. */
  readonly adhocMode: 'auto' | 'ask' | 'deny'
  /** The action being asked about, when it could be parsed. */
  readonly action: ParsedAction | undefined
  /**
   * A run-scoped grant already given, when one covers this action.
   *
   * Held by the bridge because dsh grants are one-shot: "approve all for this run"
   * cannot be a dsh setting, so it is remembered here and re-answered.
   */
  readonly runGrant:
    | { readonly kind: 'command' | 'file-write' | 'file-read' | 'network' | 'other'; readonly reason: string }
    | undefined
}

/**
 * Decide what to do about an approval request.
 *
 * The order matters:
 *
 * 1. **A run-scoped grant** covers the action's *category*, so approving a batch of
 *    `git status` calls does not authorize the `git push` that follows.
 * 2. **`deny`** refuses. It is unreachable in practice — dsh's `never` policy
 *    rejects before the chain runs — but it is handled here so the function is
 *    total and a future caller cannot accidentally fall through to asking.
 * 3. **`auto`** allows an allow-listed argv.
 * 4. Otherwise, **ask**.
 *
 * A request whose action could not be parsed is never allowed automatically: an
 * unparseable command is one whose contents are not known, and an allowlist cannot
 * authorize what it cannot read.
 *
 * @param snapshot the state.
 * @returns the decision.
 */
export function decideApproval(snapshot: PolicySnapshot): ApprovalDecision {
  const mode = snapshot.mode

  // 1. A run-scoped grant, scoped to the action's category.
  if (snapshot.runGrant !== undefined && snapshot.action !== undefined) {
    if (snapshot.runGrant.kind === snapshot.action.kind) {
      return { kind: 'allow-run', because: snapshot.runGrant.reason }
    }
  }

  // 2. A hard deny.
  if (mode === 'deny') {
    return { kind: 'deny', reason: 'the project policy is deny' }
  }

  // 3. The allowlist, under `auto` and `ask` alike: listing a command is the
  // operator's own decision not to be asked about it. An unparseable action is
  // never allowed.
  if (snapshot.action !== undefined) {
    const match = matchAllowList(snapshot.action.argv, snapshot.autoAllow)
    if (match.allowed) return { kind: 'allow', rule: match.rule }
  }

  // 4. Ask.
  return { kind: 'ask' }
}

/**
 * The policy for a project, when one could be resolved.
 *
 * An ad-hoc task has no project YAML, so it uses `approvals_adhoc` — `deny` by
 * default, because an unattended one-off with no allowlist has no business running
 * commands a human never saw.
 *
 * @param config the project's approvals block, when there is a project.
 * @param adhocMode the ad-hoc mode.
 * @returns the mode and rules.
 */
export function policyOf(
  config: { readonly mode: 'auto' | 'ask' | 'deny'; readonly auto_allow: readonly string[] } | undefined,
  adhocMode: 'auto' | 'ask' | 'deny',
): { readonly mode: 'auto' | 'ask' | 'deny'; readonly autoAllow: readonly string[] } {
  if (config === undefined) {
    // An ad-hoc task gets NO allowlist, whatever the mode: it has no YAML to
    // declare one in, and an empty list allows nothing.
    return { mode: adhocMode, autoAllow: [] }
  }
  return { mode: config.mode, autoAllow: config.auto_allow }
}

/**
 * Whether a request's outcome is a grant.
 *
 * Only `'allowed-once'` grants, per dsh's `ApprovalOutcome`. Written as a function
 * so there is one place that knows this, rather than a `===` at each call site.
 *
 * @param outcome the outcome.
 * @returns whether it grants.
 */
export function isGrant(outcome: string): boolean {
  return outcome === 'allowed-once'
}
