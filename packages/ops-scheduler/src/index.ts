// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/scheduler` — reliable scheduled execution.
 *
 * One timer, pointed at the earliest `next_run_at`, re-armed after every change.
 * Schedules fire on time, exactly once, survive a restart, and respect budgets.
 *
 * @module @argus-agent/scheduler
 */
import type { Context } from '@deepseek-ai/cordis'
import { systemClock } from '@argus-agent/types'
import { schedulerOf, schedulerSchema } from './config.js'
import { OpsScheduler } from './service.js'

export * from './config.js'
export * from './cron.js'
export * from './fire.js'
export * from './service.js'

/** Stable Cordis plugin name. */
export const name = 'ops-scheduler'

/**
 * The services this plugin requires.
 *
 * `opsChannel` is required because a firing's result has to reach the chat the
 * schedule was created from, and a schedule with nowhere to report is a schedule
 * nobody will notice failing.
 */
export const inject = [
  'opsRawConfig',
  'opsConfigRegistry',
  'opsStore',
  'opsProjects',
  'opsGovernor',
  'opsChannel',
]

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The scheduler, once the plugin is mounted. */
    opsScheduler: OpsScheduler
  }
}

/**
 * Mount the scheduler.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  const section = ctx.opsConfigRegistry.extend('scheduler', schedulerSchema)
  ctx.effect(() => section)

  const config = schedulerOf(ctx.opsRawConfig)
  const logger = ctx.logger('ops-scheduler')

  if (!config.enabled) {
    logger.info('the scheduler is disabled by scheduler.enabled')
    return
  }

  const service = new OpsScheduler(ctx, {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    governor: ctx.opsGovernor,
    channel: ctx.opsChannel,
    config,
    now: () => Date.now(),
    // The system clock, which is the tested abstraction every other plugin uses.
    // The timer is also cancelled by the effect below, so a missed `stop()` cannot
    // leave it running after an unload.
    setTimeout: (callback, delayMs) => systemClock.setTimeout(callback, delayMs),
    clearTimeout: (handle) => systemClock.clearTimeout(handle),
  })

  ctx.provide('opsScheduler', service)

  // The misfire pass runs at mount: it is the only moment a missed window can be
  // told apart from a schedule that simply has not come due yet.
  void service
    .start()
    .then((handled) => {
      if (handled > 0) logger.info('%d schedule(s) were past due at startup', handled)
      const health = service.health()
      logger.info(
        'scheduler ready: %s schedule(s), %s enabled',
        String(health.details['schedules'] ?? 0),
        String(health.details['enabled'] ?? 0),
      )
    })
    .catch((error: unknown) => {
      logger.warn('the misfire pass failed: %s', error instanceof Error ? error.message : String(error))
    })

  ctx.effect(() => () => {
    service.stop()
  })
}
