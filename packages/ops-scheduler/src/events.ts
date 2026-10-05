// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-scheduler`.
 *
 * @module @argus-agent/scheduler/events
 */
import type { SkipReason } from './fire.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A due schedule did not submit its work.
     *
     * Emitted for every reason **except `overlap`**, which is a normal consequence
     * of a schedule whose work takes longer than its interval: a notification each
     * time would train the operator to ignore the channel, which makes the
     * notifications that matter useless. An overlap is recorded and logged.
     *
     * @param payload.reason why it was skipped.
     * @param payload.detail the specific cause, when there is one.
     * @param payload.nextRunAt when it will be tried again.
     * @param payload.misfired whether this was the startup misfire pass.
     * @mode emit
     */
    'ops/schedule-skipped'(payload: {
      readonly id: string
      readonly reason: SkipReason
      readonly detail: string | undefined
      readonly nextRunAt: number
      readonly misfired: boolean
    }): void

    /**
     * A schedule submitted work.
     * @param payload.requestId the governor request, for overlap detection.
     * @param payload.misfired whether this was a `run_once` misfire firing.
     * @mode emit
     */
    'ops/schedule-fired'(payload: {
      readonly id: string
      readonly requestId: string
      readonly projectId: string | null
      readonly nextRunAt: number
      readonly misfired: boolean
    }): void
  }
}

export {}
