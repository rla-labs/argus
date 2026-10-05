// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-governor`.
 *
 * @module @argus-agent/governor/events
 */
import type { MicroUsd, Owner, Priority, Scope } from '@argus-agent/types'
import type { BudgetLevel, Period } from './state.js'
import type { StopReason } from './decide.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A run was admitted and its agent started.
     * @mode emit
     */
    'ops/run-started'(payload: {
      readonly runId: string
      readonly owner: Owner
      readonly sessionId: string
      readonly requestId: string
    }): void

    /**
     * A run ended at a step boundary rather than by finishing normally.
     *
     * The reason is the governor's own bookkeeping: dsh's log records only
     * `blocked` for a rejected step, so it cannot distinguish a budget stop from
     * a loop.
     *
     * @param payload.reason why it stopped.
     * @param payload.detail a human-readable explanation.
     * @mode emit
     */
    'ops/run-stopped'(payload: {
      readonly runId: string
      readonly owner: Owner
      readonly reason: StopReason
      readonly detail: string
    }): void

    /**
     * A run left `running` by a crash was marked interrupted at startup.
     * @mode emit
     */
    'ops/run-interrupted'(payload: { readonly runId: string; readonly owner: Owner }): void

    /**
     * A budget crossed a threshold.
     *
     * Fires **once per scope, per period, per level**, so a scope sitting at 85%
     * does not emit on every model request.
     *
     * @param payload.pct the percentage used.
     * @mode emit
     */
    'ops/budget-threshold'(payload: {
      readonly scope: Scope
      readonly period: Period
      readonly level: Exclude<BudgetLevel, 'ok'>
      readonly pct: number
      readonly spentMicros: MicroUsd
      readonly limitMicros: MicroUsd
    }): void

    /**
     * A request has waited longer than `queue_stall_minutes`.
     * @param payload.reason what blocked it, when known.
     * @mode emit
     */
    'ops/queue-stalled'(payload: {
      readonly requestId: string
      readonly owner: Owner | undefined
      readonly priority: Priority
      readonly waitedMs: number
      readonly reason: string | undefined
    }): void

    /**
     * A request was refused admission.
     * @param payload.code the stable rejection code.
     * @mode emit
     */
    'ops/request-rejected'(payload: {
      readonly requestId: string
      readonly code: string
      readonly message: string
      readonly scope?: Scope
    }): void

    /**
     * Panic mode engaged. No further work is admitted until `resumeAll`.
     * @mode emit
     */
    'ops/panic'(payload: { readonly cancelled: number; readonly tookMs: number }): void

    /**
     * Panic mode cleared.
     * @mode emit
     */
    'ops/resumed'(): void

    /**
     * A project's model was switched to its fallback at the soft threshold.
     * @mode emit
     */
    'ops/model-downgraded'(payload: {
      readonly projectId: string
      readonly from: string
      readonly to: string
    }): void

    /**
     * A budget override was recorded.
     * @mode emit
     */
    'ops/budget-overridden'(payload: {
      readonly scope: Scope
      readonly addedMicros: MicroUsd
      readonly untilMs: number | undefined
    }): void
  }
}

export {}
