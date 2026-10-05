// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-health`.
 *
 * @module @argus-agent/health/events
 */
import type {} from '@argus-agent/types'
import type { HealthStatus } from '@argus-agent/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The aggregate health changed to something worth telling an operator about.
     *
     * Emitted on a **transition**, not on every check: a degraded subsystem stays
     * degraded, and an event per evaluation is how a listener gets muted.
     *
     * @param payload.summary a one-line rendering, for a log.
     * @mode emit
     */
    'ops/health-changed'(payload: {
      readonly status: HealthStatus
      readonly problems: readonly string[]
      readonly summary: string
    }): void

    /**
     * The startup recovery pass finished.
     *
     * Emitted **after** the marking and the report, so a listener that reads the
     * store sees the recovered state rather than the pre-recovery one.
     *
     * @param payload.interrupted how many runs were marked interrupted.
     * @param payload.orphaned how many requests cannot run at all.
     * @mode emit
     */
    'ops/recovery-complete'(payload: {
      readonly interrupted: number
      readonly pending: number
      readonly orphaned: number
    }): void

    /**
     * A database backup finished.
     * @mode emit
     */
    'ops/backup-complete'(payload: { readonly path: string; readonly pruned: number }): void

    /**
     * A provider request failed.
     *
     * Emitted by `ops-health` when it observes dsh's `agent/request-error`, so the
     * rate is visible to an alert listener without each plugin growing its own
     * counter.
     *
     * @mode emit
     */
    'ops/provider-error'(payload: { readonly code: string; readonly total: number }): void
  }
}

export {}
