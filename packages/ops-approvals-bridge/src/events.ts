// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-approvals-bridge`.
 *
 * @module @argus-agent/approvals-bridge/events
 */
import type { ActionKind } from './argv.js'

/** How an approval ended. */
export type ApprovalEnding =
  /** A human pressed Approve. */
  | 'approved'
  /** A human pressed "approve all of this kind for this run". */
  | 'approved-run'
  /** Refused, by a human or by the policy. */
  | 'denied'
  /** Nobody answered in time. Denied, as the plan requires. */
  | 'timeout'
  /** No channel could be reached. Denied. */
  | 'unavailable'
  /** An internal failure. Denied. */
  | 'error'
  /** Allowed automatically: an allowlist rule or a run grant. */
  | 'auto'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An approval request reached the bridge.
     * @mode emit
     */
    'ops/approval-requested'(payload: {
      readonly id: string
      readonly projectId: string | null
      readonly runId: string
      readonly toolName: string
      readonly kind: ActionKind
      readonly action: string
      readonly decision: 'allow' | 'ask' | 'deny'
    }): void

    /**
     * An approval ended, and how.
     *
     * Emitted for every path, including the automatic ones, so an audit consumer
     * sees a complete ledger rather than only the ones a human touched.
     *
     * @mode emit
     */
    'ops/approval-decided'(payload: {
      readonly id: string
      readonly projectId: string | null
      readonly runId: string
      readonly toolName: string
      readonly kind: ActionKind
      readonly ending: ApprovalEnding
      readonly decidedBy: string | null
      readonly detail: string | undefined
    }): void
  }
}

export {}
