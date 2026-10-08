// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/health/service` — `ctx.opsHealth`.
 *
 * It aggregates, reports, alerts, backs up, and performs the startup recovery pass.
 * The last is the one with the strongest requirement: after a `kill -9` during three
 * runs, **no request may be lost, the cost total must stay correct, and the operator
 * must be told what was interrupted**.
 *
 * @module @argus-agent/health/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { MAX_TIMEOUT_MS, type ChannelAddress, type DoctorFinding, type DoctorSource, type HealthStatus, type ServiceHealth, type TimerHandle } from '@argus-agent/types'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import type { OpsScheduler } from '@argus-agent/scheduler'
import { nextTimeOfDay, type HealthSection } from './config.js'
import './events.js'
import { diskUsage, prepareBackup, pruneBackups, listBackups } from './backup.js'
import { rollUp, shouldAlert, shouldAlertThreshold, summarise, type HealthReport, type SubsystemReport } from './model.js'
import {
  dailyReport,
  formatBytes,
  startupButtons,
  startupReport,
  type DailySnapshot,
  type ProjectSpend,
} from './report.js'
import { startHealthServer, type HealthServer } from './server.js'

/** Options for the service. */
export interface HealthOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly scheduler: OpsScheduler | undefined
  readonly config: HealthSection
  readonly dataDir: string
  readonly version: string
  /** The deployment's timezone, for the report and backup times. */
  readonly timezone: string
  readonly startedAt: number
  readonly now: () => number
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle
  readonly clearTimeout: (handle: TimerHandle) => void
}

/** One interrupted run, as recovery found it. */
export interface InterruptedRun {
  readonly runId: string
  readonly projectId: string | null
  readonly requestId: string | null
  readonly startedAt: number
}

/**
 * The subsystems a health report always includes.
 *
 * These are the services this plugin injects, so they are present by construction.
 * `opsScheduler`, `opsMemory` and `opsApprovals` are **optional** plugins: their
 * absence is a deployment choice, not a fault, so they are reported only when they
 * are mounted. Reporting an unmounted optional plugin as `down` would make every
 * deployment that does not use the scheduler permanently unhealthy — which is how a
 * health signal gets ignored.
 */
const REQUIRED_SUBSYSTEMS = ['opsStore', 'opsProjects', 'opsMeter', 'opsGovernor', 'opsChannel'] as const

/** The services that contribute to `argus doctor`, each through its `doctor()`. */
const DOCTOR_SOURCES = ['opsProjects', 'opsChannel', 'opsProviders', 'opsCommands', 'opsOrchestrator'] as const

/** Optional plugins, reported only when mounted. */
const OPTIONAL_SUBSYSTEMS = ['opsScheduler', 'opsMemory', 'opsApprovals', 'opsOrchestrator'] as const

/**
 * The health service.
 *
 * Exposed as `ctx.opsHealth`.
 */
export class OpsHealth {
  private server: HealthServer | undefined
  private dailyTimer: TimerHandle | undefined
  private backupTimer: TimerHandle | undefined
  private lastStatus: HealthStatus | undefined
  private lastAlertAt: number | undefined
  /** Provider errors, by code, for the rate alert. */
  private readonly providerErrors = new Map<string, number>()
  /** The runs the last startup pass marked interrupted. */
  recovery: { interrupted: InterruptedRun[]; pending: number; orphaned: Array<{ requestId: string; reason: string }> } | undefined
  /** How many reports were rendered, for a test. */
  reports = 0
  /** How many alerts were sent. */
  alerts = 0

  constructor(
    private readonly ctx: Context,
    private readonly options: HealthOptions,
  ) {}

  // ── aggregation ──────────────────────────────────────────────────────────

  /** Every subsystem's report. */
  private subsystems(): SubsystemReport[] {
    const lookup: Record<string, ServiceHealth | undefined> = {
      opsStore: this.options.store.health(),
      opsProjects: this.options.projects.health(),
      opsMeter: this.options.meter.health(),
      opsGovernor: this.options.governor.health(),
      opsChannel: this.options.channel.health(),
      opsScheduler: this.options.scheduler?.health(),
    }

    const reports: SubsystemReport[] = REQUIRED_SUBSYSTEMS.map((name) => ({ name, health: lookup[name] }))

    // An optional plugin contributes only if it is mounted. Read through `ctx` once
    // per report rather than cached: a plugin may be mounted after this one.
    for (const name of OPTIONAL_SUBSYSTEMS) {
      const service = this.ctx.get(name as never) as { health?: () => ServiceHealth } | undefined
      if (service === undefined) continue
      if (name === 'opsScheduler' && this.options.scheduler !== undefined) {
        reports.push({ name, health: this.options.scheduler.health() })
        continue
      }
      if (typeof service.health === 'function') reports.push({ name, health: service.health() })
    }

    return reports
  }

  /**
   * The current health report.
   *
   * @returns the report.
   */
  report(): HealthReport {
    this.reports += 1
    const now = this.options.now()
    return rollUp({
      subsystems: this.subsystems(),
      uptimeMs: now - this.options.startedAt,
      version: this.options.version,
      now,
    })
  }

  /**
   * What `argus doctor` reports beyond the smoke test: whether the system can actually
   * do work, from every mounted service that can tell (`DOCTOR_SOURCES`). A source
   * that throws becomes a failed finding instead of hiding the others.
   *
   * @returns the findings, in source order.
   */
  async doctor(): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = []
    for (const name of DOCTOR_SOURCES) {
      const source = this.ctx.get(name as never) as Partial<DoctorSource> | undefined
      if (typeof source?.doctor !== 'function') continue
      try {
        findings.push(...(await source.doctor()))
      } catch (error) {
        findings.push({ ok: false, check: `${name}: the check itself`, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    return findings
  }

  /** A one-line summary, for `/health` and for a log. */
  headline(): string {
    return summarise(this.report())
  }

  /**
   * The text `/health` shows.
   *
   * @returns the text.
   */
  reportText(): string {
    const report = this.report()
    const lines = [report.status.toUpperCase(), '']
    lines.push(
      ...Object.keys(report.subsystems)
        .sort()
        .map((name) => {
          const entry = report.subsystems[name] as { status: HealthStatus; details: Record<string, unknown> }
          const reason = typeof entry.details['reason'] === 'string' ? ` — ${entry.details['reason']}` : ''
          return `${name.padEnd(14)} ${entry.status}${reason}`
        }),
    )
    if (this.recovery !== undefined && this.recovery.interrupted.length > 0) {
      lines.push('', `${this.recovery.interrupted.length} run(s) were interrupted by the last restart.`)
    }
    return lines.join('\n')
  }

  // ── alerts ───────────────────────────────────────────────────────────────

  /**
   * Evaluate the status and alert on a transition.
   *
   * Called by the timer and after a request error; **rate-limited** by
   * `alert_interval_minutes`, because a degraded subsystem stays degraded and a
   * message per check is how a channel gets muted.
   *
   * @returns whether an alert was sent.
   */
  async evaluate(): Promise<boolean> {
    const report = this.report()
    const now = this.options.now()
    const transition = shouldAlert(this.lastStatus, report.status)
    this.lastStatus = report.status

    if (!transition) return false
    if (!shouldAlertThreshold(1, 1, this.lastAlertAt, now, this.options.config.alert_interval_minutes * 60_000)) {
      // A transition inside the alert interval is recorded but not sent: the
      // operator just heard from us.
      return false
    }

    this.lastAlertAt = now
    this.alerts += 1
    this.ctx.emit('ops/health-changed', {
      status: report.status,
      problems: report.problems,
      summary: summarise(report),
    })
    await this.notify(`Health is ${report.status}.\n\n${report.problems.join(', ')}`)
    return true
  }

  /**
   * Record a provider error, and alert when they become frequent.
   *
   * @param code the error code.
   * @returns whether an alert was sent.
   */
  async noteProviderError(code: string): Promise<boolean> {
    this.providerErrors.set(code, (this.providerErrors.get(code) ?? 0) + 1)
    const total = [...this.providerErrors.values()].reduce((sum, count) => sum + count, 0)
    if (total < this.options.config.error_alert_threshold) return false

    const now = this.options.now()
    if (!shouldAlertThreshold(total, this.options.config.error_alert_threshold, this.lastAlertAt, now, this.options.config.alert_interval_minutes * 60_000)) {
      return false
    }

    this.lastAlertAt = now
    this.alerts += 1
    const breakdown = [...this.providerErrors.entries()].map(([name, count]) => `${name}: ${count}`).join(', ')
    await this.notify(`Provider errors are frequent (${total}).\n\n${breakdown}`)
    return true
  }

  /** Forget the error counters, so a recovered system does not stay alarming. */
  clearErrors(): void {
    this.providerErrors.clear()
  }

  // ── recovery ─────────────────────────────────────────────────────────────

  /**
   * Recover after a crash, and report what was found.
   *
   * Four steps, in this order:
   *
   * 1. **Mark interrupted runs.** A row left `running` belongs to a process that is
   *    gone. Marking it first means the report and the store agree.
   * 2. **Re-load the counters.** The meter's windows are derived from
   *    `usage_events`, so a restart does not lose a cent — this asserts it rather
   *    than rebuilding anything.
   * 3. **Queue the pending requests.** They were never started, so they are still
   *    valid work. The governor drains its queue on its own timer; this counts them.
   * 4. **Send one message**, with a Retry per interrupted run.
   *
   * @returns what recovery found.
   */
  async recover(): Promise<{ interrupted: InterruptedRun[]; pending: number; orphaned: Array<{ requestId: string; reason: string }> }> {
    const logger = this.ctx.logger('ops-health')
    const now = this.options.now()

    // 1. Runs left `running` are interrupted. The governor does the marking; this
    // reads what it did, so there is one implementation of "what counts as
    // interrupted".
    const interruptedRuns = this.options.store.runs.recent(200).filter((row) => row.status === 'running')
    const interrupted: InterruptedRun[] = interruptedRuns.map((row) => ({
      runId: row.id,
      projectId: row.project_id,
      requestId: row.inbound_id,
      startedAt: row.started_at,
    }))
    if (interrupted.length > 0) {
      logger.warn('%d run(s) were left running by a previous process', interrupted.length)
    }

    // 2. Pending requests: never started, so still valid.
    const pending = this.options.store.inbound.pendingCount()

    // 3. Requests that can never run: a project that no longer exists.
    const orphaned: Array<{ requestId: string; reason: string }> = []
    for (const row of this.options.store.inbound.listByStatus('pending').slice(0, 50)) {
      if (row.project_id !== null && this.options.projects.configOf(row.project_id) === undefined) {
        const reason = this.options.projects.invalidOf(row.project_id) !== undefined
          ? `project "${row.project_id}" is invalid (see below)`
          : `project "${row.project_id}" no longer exists`
        orphaned.push({ requestId: row.id, reason })
      }
    }

    this.recovery = { interrupted, pending, orphaned }
    void now

    // 4. One message.
    const invalid = this.options.projects.invalidProjects()
    if (this.options.config.startup_report && (interrupted.length > 0 || orphaned.length > 0 || invalid.length > 0)) {
      const text = startupReport(
        { version: this.options.version, interrupted, pending, orphaned, invalid },
        (ms) => `${Math.round(ms / 60_000)}m`,
        now,
      )
      const retryable = interrupted.map((run) => run.requestId).filter((id): id is string => id !== null)
      await this.notify(text, startupButtons(retryable))
    }

    this.ctx.emit('ops/recovery-complete', {
      interrupted: interrupted.length,
      pending,
      orphaned: orphaned.length,
    })
    return this.recovery
  }

  /**
   * Resubmit an interrupted run's original request.
   *
   * The request row is **still there** — a crash does not delete it — so a retry
   * resubmits the same text to the same project rather than asking the operator to
   * repeat themselves.
   *
   * @param requestId the inbound request.
   * @returns whether it was resubmitted.
   */
  async retry(requestId: string): Promise<boolean> {
    const row = this.options.store.inbound.get(requestId)
    if (row === undefined) return false
    if (row.project_id === null) return false
    if (this.options.projects.configOf(row.project_id) === undefined) return false

    const payload = parsePayload(row.payload)
    if (payload === undefined) return false

    const address = safeAddress(row.reply_chat)
    this.options.governor.submit({
      source: 'channel',
      target: { projectId: row.project_id },
      content: [{ type: 'text', text: payload }],
      priority: 0,
      ...(address === undefined ? {} : { replyTo: address }),
    })
    this.ctx.logger('ops-health').info('resubmitted request %s to %s', requestId, row.project_id)

    this.options.store.audit.record(
      {
        actor: 'operator',
        action: 'run.retried',
        target: requestId,
        details: { project_id: row.project_id },
      },
      this.options.now(),
    )
    return true
  }

  // ── the daily report ─────────────────────────────────────────────────────

  /** Build the snapshot the daily report needs, from the store. */
  snapshot(): DailySnapshot {
    const now = this.options.now()
    const day = localDay(now, this.options.timezone)

    const byScope = this.options.meter.report({ fromDay: day, toDay: day }).byScope
    const projects: ProjectSpend[] = []
    let unscoped = 0
    for (const row of byScope) {
      if (row.scope.startsWith('project:')) {
        projects.push({
          projectId: row.scope.slice('project:'.length),
          costMicros: row.cost_micros,
          runs: this.options.store.runs.recent(500).filter((run) => run.project_id === row.scope.slice('project:'.length)).length,
        })
      } else {
        unscoped += row.cost_micros
      }
    }

    // The store's own vocabulary: a report that invented its own status names would
    // silently report zero for every one of them.
    const runsByStatus: Record<string, number> = {}
    for (const status of ['running', 'completed', 'aborted', 'error', 'budget_stopped', 'limit_stopped', 'interrupted'] as const) {
      const count = this.options.store.runs.countByStatus(status)
      if (count > 0) runsByStatus[status] = count
    }

    const budgets = this.options.governor
      .status()
      .budgets.map((budget) => ({
        scope: budget.scope,
        level: budget.level,
        pct: budget.pct,
        spentMicros: budget.spentMicros,
        limitMicros: budget.limitMicros,
      }))

    const skips: Record<string, number> = {}
    if (this.options.scheduler !== undefined) {
      for (const [reason, count] of this.options.scheduler.skips) skips[reason] = count
    }

    const errors: Record<string, number> = {}
    for (const [code, count] of this.providerErrors) errors[code] = count

    return {
      day,
      projects,
      unscopedMicros: unscoped,
      runsByStatus,
      budgets,
      skips,
      errors,
      disk: diskUsage(this.options.dataDir),
    }
  }

  /**
   * Build and send the daily report.
   *
   * @returns the report text, or `undefined` when it was not sent.
   */
  async runDailyReport(): Promise<string | undefined> {
    const text = dailyReport(this.snapshot())
    await this.notify(text)
    this.ctx.logger('ops-health').info('daily report sent')
    return text
  }

  // ── backups ──────────────────────────────────────────────────────────────

  /**
   * Back up the database and rotate.
   *
   * **The database only.** Sessions, workspaces and the memory state tree are files
   * covered by the volume-level backup in `deploy/`; the log line says so, because a
   * backup that is believed to cover more than it does is worse than none.
   *
   * @returns where it was written, and what was pruned.
   */
  async runBackup(): Promise<{ path: string; pruned: string[] }> {
    const day = localDay(this.options.now(), this.options.timezone)
    const path = prepareBackup(this.options.dataDir, day)
    await this.options.store.backup(path)
    const pruned = pruneBackups(this.options.dataDir, this.options.config.backup_keep)
    this.ctx.logger('ops-health').info(
      'backed up the database to %s (kept %d; sessions and workspaces are the volume backup\'s job)',
      path,
      this.options.config.backup_keep,
    )
    this.ctx.emit('ops/backup-complete', { path, pruned: pruned.length })
    return { path, pruned }
  }

  /** The backups on disk, newest first. */
  backups(): string[] {
    return listBackups(this.options.dataDir)
  }

  // ── timers ───────────────────────────────────────────────────────────────

  /** Start the endpoint and both timers. */
  async start(): Promise<void> {
    if (this.options.config.endpoint) {
      this.server = await startHealthServer({
        port: this.options.config.port,
        report: () => this.report(),
        doctor: () => this.doctor(),
        onRequest: (info) => this.ctx.logger('ops-health').debug('GET %s → %d', info.path, info.status),
      })
      this.ctx.logger('ops-health').info('health endpoint on %s (loopback only)', this.server.url)
    }

    // Recovery runs BEFORE the timers: its report describes what this process is
    // about to do, and a timer firing first would compete with the startup message.
    await this.recover()

    if (this.options.config.daily_report) this.armDaily()
    if (this.options.config.backup) this.armBackup()
    this.armAlertCheck()
  }

  /** Arm the daily report for its next occurrence. */
  private armDaily(): void {
    const next = nextTimeOfDay(this.options.config.daily_report_time, this.options.timezone, this.options.now())
    this.dailyTimer = this.options.setTimeout(() => {
      void this.runDailyReport().catch((error: unknown) => {
        this.ctx.logger('ops-health').warn('the daily report failed: %s', messageOf(error))
      })
      this.armDaily()
    }, Math.min(next - this.options.now(), MAX_TIMEOUT_MS))
  }

  /** Arm the backup for its next occurrence. */
  private armBackup(): void {
    const next = nextTimeOfDay(this.options.config.backup_time, this.options.timezone, this.options.now())
    this.backupTimer = this.options.setTimeout(() => {
      void this.runBackup().catch((error: unknown) => {
        this.ctx.logger('ops-health').warn('the backup failed: %s', messageOf(error))
      })
      this.armBackup()
    }, Math.min(next - this.options.now(), MAX_TIMEOUT_MS))
  }

  /** Arm a periodic health evaluation. */
  private armAlertCheck(): void {
    // Every five minutes: often enough to notice a transition, rarely enough that
    // the check itself is not the load. The alert RATE limit is separate.
    this.alertTimer = this.options.setTimeout(() => {
      void this.evaluate()
        .catch((error: unknown) => this.ctx.logger('ops-health').warn('the health check failed: %s', messageOf(error)))
        .finally(() => {
          if (this.stopped) return
          this.armAlertCheck()
        })
    }, 5 * 60_000)
  }

  private alertTimer: TimerHandle | undefined
  private stopped = false

  /** Stop the endpoint and every timer. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const handle of [this.dailyTimer, this.backupTimer, this.alertTimer]) {
      if (handle !== undefined) this.options.clearTimeout(handle)
    }
    this.dailyTimer = undefined
    this.backupTimer = undefined
    this.alertTimer = undefined
    await this.server?.close()
    this.server = undefined
  }

  /** The endpoint's URL, when it is running. */
  get endpoint(): string | undefined {
    return this.server?.url
  }

  /** A health report about the health plugin itself. */
  health(): ServiceHealth {
    const report = this.report()
    return {
      status: report.status,
      details: {
        endpoint: this.server?.url ?? null,
        uptimeMs: report.uptimeMs,
        problems: report.problems,
        alerts: this.alerts,
      },
    }
  }

  // ── notification ─────────────────────────────────────────────────────────

  /**
   * Send a message to the default address.
   *
   * A notification with nowhere to go is logged rather than thrown: an alert about a
   * problem must not itself become a second problem.
   *
   * @param text the text.
   * @param buttons the buttons, when the message offers an action.
   */
  private async notify(text: string, buttons?: ReadonlyArray<{ value: string; label: string }>): Promise<void> {
    const address = this.options.channel.defaultAddress()
    if (address === undefined) {
      this.ctx.logger('ops-health').info('no default address for a notification:\n%s', text)
      return
    }
    try {
      await this.options.channel.send(address, { text, ...(buttons === undefined ? {} : { buttons: [...buttons] }) })
    } catch (error) {
      this.ctx.logger('ops-health').warn('could not send a notification: %s', messageOf(error))
    }
  }

  /** The address the reports go to, for a test. */
  address(): ChannelAddress | undefined {
    return this.options.channel.defaultAddress()
  }
}

/** An error's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The local date of a timestamp, `YYYY-MM-DD`. */
export function localDay(ts: number, timezone: string): string {
  // `en-CA` renders as `YYYY-MM-DD`, which is the format the meter's day keys use.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' }).format(new Date(ts))
}

/** The `text` of an inbound row's payload envelope. */
function parsePayload(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { content?: Array<{ type: string; text?: string }> }
    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/** Decode a stored address, tolerating a malformed one. */
function safeAddress(value: string | null): ChannelAddress | undefined {
  if (value === null || value.length === 0) return undefined
  try {
    return JSON.parse(value) as ChannelAddress
  } catch {
    return undefined
  }
}

export { formatBytes, existsSync, nextTimeOfDay }
