// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-meter`.
 *
 * @module @argus-agent/meter/events
 */
import type { MicroUsd, Owner, Scope } from '@argus-agent/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One model request was priced and counted.
     *
     * Emitted after the counters are advanced, so the governor's listener sees
     * the new totals. The event carries both the scope's and the global totals,
     * so a budget check needs no further call.
     *
     * @param payload.owner what the request belonged to.
     * @param payload.scope the accounting scope the request was recorded under.
     * @param payload.scopeMicros the scope's current-day total, after this request.
     * @param payload.globalMicros the global current-day total, after this request.
     * @param payload.runId the run, when one is open.
     * @param payload.deltaMicros what this request cost.
     * @param payload.deltaTokens what this request used, in tokens.
     * @mode emit
     */
    'ops/usage'(payload: {
      readonly owner: Owner
      readonly scope: Scope
      readonly scopeMicros: MicroUsd
      readonly globalMicros: MicroUsd
      readonly runId: string | undefined
      readonly deltaMicros: MicroUsd
      readonly deltaTokens: number
    }): void

    /**
     * A model with no price entry was used.
     *
     * Under `unknown_model_policy: block` this fires immediately before the
     * governor refuses the request; under `warn` it fires and the request is
     * accounted at zero. It fires at most once per request, so a listener can
     * use it to notify without a deduplication layer of its own.
     *
     * @param payload.model the `provider/model` that had no price.
     * @mode emit
     */
    'ops/unpriced-model'(payload: { readonly model: string }): void

    /**
     * The durable write failed and events are buffered.
     *
     * The meter never drops an event: it keeps them and retries, because losing
     * a batch would break the reconciliation invariant permanently. A listener
     * should surface this, not act on it.
     *
     * @param payload.pending how many events are buffered.
     * @param payload.error the failure.
     * @mode emit
     */
    'ops/meter-degraded'(payload: { readonly pending: number; readonly error: string }): void

    /**
     * A previously failed write succeeded.
     *
     * @mode emit
     */
    'ops/meter-recovered'(): void

    /**
     * A day or month boundary passed.
     *
     * Emitted from `rollIfNeeded`, which runs on the metering path rather than
     * on a timer — so a process that was asleep across midnight rolls on its
     * next request rather than hours later.
     *
     * @param payload.previousDay the day that ended.
     * @param payload.day the day that began.
     * @param payload.previousMonth the month that ended, when a month boundary passed.
     * @param payload.month the month that began.
     * @mode emit
     */
    'ops/day-rollover'(payload: {
      readonly previousDay: string
      readonly day: string
      readonly previousMonth?: string
      readonly month?: string
    }): void
  }
}

export {}
