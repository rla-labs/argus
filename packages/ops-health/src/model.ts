// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/health/model` — the aggregate, and when it is worth telling someone.
 *
 * The interesting decision is what a **degraded** aggregate means for the endpoint's
 * status code. It returns 200, not 503. A container whose healthcheck fails is
 * restarted, and restarting a system that is merely degraded turns a small,
 * diagnosable problem into a loop of restarts that loses in-flight work — which is
 * the opposite of observability.
 *
 * @module @argus-agent/health/model
 */
import { worstOf, type HealthStatus, type ServiceHealth } from '@argus-agent/types'

/** One subsystem's contribution to the aggregate. */
export interface SubsystemReport {
  /** The service name, as `ctx.<name>` names it. */
  readonly name: string
  /** What it reported, or `undefined` when the service is absent. */
  readonly health: ServiceHealth | undefined
}

/** The whole system's health. */
export interface HealthReport {
  readonly status: HealthStatus
  /** The process's uptime, in milliseconds. */
  readonly uptimeMs: number
  /** The package version, for a report that has to be quotable. */
  readonly version: string
  /** The current time. */
  readonly now: number
  /** Each subsystem, including the absent ones. */
  readonly subsystems: Record<string, { readonly status: HealthStatus; readonly details: Record<string, unknown> }>
  /** The names of the subsystems that are not `ok`. */
  readonly problems: readonly string[]
}

/** Options for {@link rollUp}. */
export interface RollUpOptions {
  readonly subsystems: readonly SubsystemReport[]
  readonly uptimeMs: number
  readonly version: string
  readonly now: number
}

/**
 * Aggregate every subsystem into one report.
 *
 * A **missing** service counts as `down`, because a plugin that should be mounted
 * and is not cannot do its job — and the alternative, treating absence as healthy,
 * would make a half-mounted system look fine. The exception is `ops-health` itself,
 * which is obviously present if this code is running.
 *
 * @param options what to aggregate.
 * @returns the report.
 */
export function rollUp(options: RollUpOptions): HealthReport {
  const subsystems: Record<string, { status: HealthStatus; details: Record<string, unknown> }> = {}
  const problems: string[] = []
  const statuses: HealthStatus[] = []

  for (const entry of options.subsystems) {
    if (entry.health === undefined) {
      subsystems[entry.name] = { status: 'down', details: { reason: 'the service is not provided' } }
      problems.push(entry.name)
      statuses.push('down')
      continue
    }
    subsystems[entry.name] = { status: entry.health.status, details: entry.health.details }
    statuses.push(entry.health.status)
    if (entry.health.status !== 'ok') problems.push(entry.name)
  }

  return {
    status: worstOf(statuses),
    uptimeMs: options.uptimeMs,
    version: options.version,
    now: options.now,
    subsystems,
    problems,
  }
}

/**
 * The HTTP status for a report.
 *
 * **200 for `ok` and `degraded`; 503 only for `down`.** A Docker healthcheck that
 * fails restarts the container, and restarting a merely-degraded system loses
 * in-flight work while fixing nothing.
 *
 * @param status the aggregate status.
 * @returns the status code.
 */
export function httpStatusFor(status: HealthStatus): number {
  return status === 'down' ? 503 : 200
}

/**
 * A one-line summary, for a log or a notification.
 *
 * @param report the report.
 * @param formatUptime how to render the uptime.
 * @returns the summary.
 */
export function summarise(
  report: HealthReport,
  formatUptime: (ms: number) => string = (ms) => `${Math.round(ms / 1000)}s`,
): string {
  const head = `${report.status.toUpperCase()} · up ${formatUptime(report.uptimeMs)} · ${report.version}`
  if (report.problems.length === 0) return head
  return `${head} · ${report.problems.length} problem(s): ${report.problems.join(', ')}`
}

/**
 * A multi-line report, as `/health` shows it.
 *
 * @param report the report.
 * @returns the text.
 */
export function renderReport(report: HealthReport): string {
  const lines: string[] = [
    `status    ${report.status}`,
    `uptime    ${formatDuration(report.uptimeMs)}`,
    `version   ${report.version}`,
    '',
  ]

  const names = Object.keys(report.subsystems).sort()
  const width = names.reduce((max, name) => Math.max(max, name.length), 8)
  for (const name of names) {
    const entry = report.subsystems[name] as { status: HealthStatus; details: Record<string, unknown> }
    const reason = typeof entry.details['reason'] === 'string' ? ` — ${entry.details['reason']}` : ''
    lines.push(`${name.padEnd(width)}  ${entry.status}${reason}`)
  }
  return lines.join('\n')
}

/** A human duration. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * Whether a status transition is worth alerting about.
 *
 * Alerted on: anything **becoming** worse than `ok`. Not alerted on: a recovery
 * (good news is not an alert) or a status staying where it was (that is a
 * notification per healthcheck, which is how a channel gets muted).
 *
 * @param previous the previous status, or `undefined` on the first evaluation.
 * @param current the current status.
 * @returns whether to alert.
 */
export function shouldAlert(previous: HealthStatus | undefined, current: HealthStatus): boolean {
  if (current === 'ok') return false
  if (previous === undefined) return true
  // A change within the unhealthy range is worth saying: degraded → down is worse.
  return previous !== current
}

/**
 * Whether a metric crossing a threshold is worth alerting about.
 *
 * Rate-limited by construction: the caller passes the last alert time, so a disk
 * sitting at 95% produces one alert per interval rather than one per check.
 *
 * @param value the current value.
 * @param threshold the threshold.
 * @param lastAlertAt the last alert, or `undefined`.
 * @param now the current time.
 * @param intervalMs the minimum gap between alerts.
 * @returns whether to alert.
 */
export function shouldAlertThreshold(
  value: number,
  threshold: number,
  lastAlertAt: number | undefined,
  now: number,
  intervalMs: number,
): boolean {
  if (value < threshold) return false
  if (lastAlertAt === undefined) return true
  return now - lastAlertAt >= intervalMs
}
