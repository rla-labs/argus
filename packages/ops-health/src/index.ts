// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/health` — observability and recovery.
 *
 * It aggregates every plugin's health, serves a loopback endpoint, sends a daily
 * report and a startup report, backs up the database on a timer, and alerts on a
 * transition.
 *
 * @module @argus-agent/health
 */
import type { Context } from '@deepseek-ai/cordis'
import { systemClock } from '@argus-agent/types'
import { readFileSync } from 'node:fs'
import { healthOf, healthSchema } from './config.js'
import { parseRetry } from './report.js'
import { OpsHealth } from './service.js'

export * from './backup.js'
export * from './config.js'
export * from './model.js'
export * from './report.js'
export * from './server.js'
export * from './service.js'

/** Stable Cordis plugin name. */
export const name = 'ops-health'

/**
 * The services this plugin requires.
 *
 * `opsScheduler` is **optional**: the daily report includes skipped schedules when
 * there is a scheduler, and reports zero otherwise. Everything else is required,
 * because a health report that silently omitted a subsystem would be worse than one
 * that said the subsystem was missing.
 */
export const inject = [
  'opsRawConfig',
  'opsConfigRegistry',
  'opsStore',
  'opsProjects',
  'opsMeter',
  'opsGovernor',
  'opsChannel',
]

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The health service, once the plugin is mounted. */
    opsHealth: OpsHealth
  }
}

/**
 * Mount the health plugin.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  const section = ctx.opsConfigRegistry.extend('health', healthSchema)
  ctx.effect(() => section)

  const config = healthOf(ctx.opsRawConfig)
  const logger = ctx.logger('ops-health')

  if (!config.enabled) {
    logger.info('health is disabled by health.enabled')
    return
  }

  const dataDir = typeof ctx.opsRawConfig['data_dir'] === 'string' ? ctx.opsRawConfig['data_dir'] : '/data'
  const timezone = typeof ctx.opsRawConfig['timezone'] === 'string' ? ctx.opsRawConfig['timezone'] : 'UTC'
  const version = readVersion()

  const service = new OpsHealth(ctx, {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    meter: ctx.opsMeter,
    governor: ctx.opsGovernor,
    channel: ctx.opsChannel,
    scheduler: ctx.get('opsScheduler' as never) as never,
    config,
    dataDir,
    version,
    timezone,
    startedAt: Date.now(),
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => systemClock.setTimeout(callback, delayMs),
    clearTimeout: (handle) => systemClock.clearTimeout(handle),
  })

  ctx.provide('opsHealth', service)

  /**
   * Provider errors, counted for the rate alert.
   *
   * dsh emits `agent/request-error` for every failed model request; counting here
   * means no plugin grows its own counter and the threshold is one setting.
   */
  ctx.on('agent/request-error', async (payload) => {
    const code = (payload.failure as { code?: string } | undefined)?.code ?? 'unknown'
    void service
      .noteProviderError(code)
      .then((alerted) => {
        if (alerted) ctx.emit('ops/provider-error', { code, total: service.alerts })
      })
      .catch(() => {
        /* a counter must not become a second failure */
      })
    // Returning `undefined` DELEGATES: dsh's own retry policy still runs. Returning
    // `{ kind: 'retry' }` would claim the recovery and change the system's behaviour,
    // which an observability plugin must not do.
    return undefined
  })

  /**
   * A Retry button from the startup report.
   *
   * The channel turns an unknown button value into a question answer, so the health
   * plugin watches for the value's shape. The request row is still in the store — a
   * crash does not delete it — so a retry resubmits the same text to the same
   * project rather than asking the operator to repeat themselves.
   */
  ctx.on('ops/channel-button', (payload) => {
    const requestId = parseRetry(payload.value)
    if (requestId === undefined) return
    void service
      .retry(requestId)
      .then((ok) => {
        if (!ok) logger.warn('could not retry request %s', requestId)
      })
      .catch((error: unknown) => logger.warn('retry failed: %s', error instanceof Error ? error.message : String(error)))
  })

  void service
    .start()
    .then(() => {
      logger.info(
        'health ready: endpoint=%s, daily report at %s, backup at %s (keep %d)',
        service.endpoint ?? 'off',
        config.daily_report ? config.daily_report_time : 'off',
        config.backup ? config.backup_time : 'off',
        config.backup_keep,
      )
    })
    .catch((error: unknown) => {
      // A failed endpoint bind is worth reporting and NOT worth stopping the system
      // for: the reports, the recovery pass and the backup all still work.
      logger.warn('the health endpoint did not start: %s', error instanceof Error ? error.message : String(error))
    })

  ctx.effect(() => () => {
    void service.stop()
  })
}

/** The Argus Agent version, from the bundle's package, falling back to `unknown`. */
function readVersion(): string {
  try {
    const url = new URL('../../argus-agent/package.json', import.meta.url)
    const json = readFileSync(url, 'utf8')
    return (JSON.parse(json) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export { parseRetry }
