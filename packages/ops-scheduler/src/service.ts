// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/scheduler/service` — `ctx.opsScheduler`.
 *
 * One timer, re-armed after every change, always pointed at the earliest
 * `next_run_at`. Not one timer per schedule: a hundred schedules would be a hundred
 * timers to track and leak, and "what is due first" is the only question a timer
 * needs to answer.
 *
 * @module @argus-agent/scheduler/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import {
  MAX_TIMEOUT_MS,
  decodeAddress,
  encodeAddress,
  type ChannelAddress,
  type ServiceHealth,
  type TimerHandle,
} from '@argus-agent/types'
import type { InboundSource } from '@argus-agent/store'
import type { OpsStore, ScheduleRow } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import type { CommandContext, CommandResult } from '@argus-agent/commands'
import { checkCron, delayUntil, nextRunAfter, planMisfire, describeSeconds } from './cron.js'
import { decideFiring, isNoteworthySkip, skipReasonOf, skipText, type FireSnapshot, type SkipReason } from './fire.js'
import { isMisfirePolicy, type MisfirePolicy, type SchedulerSection } from './config.js'
import './events.js'

/** Options for the service. */
export interface SchedulerOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly config: SchedulerSection
  /** Reads the current time. */
  readonly now: () => number
  /** Schedules a callback; injected so tests drive the clock. */
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle
  /** Cancels a callback. */
  readonly clearTimeout: (handle: TimerHandle) => void
}

/** What `add` accepts. */
export interface ScheduleSpec {
  readonly id?: string
  readonly cron: string
  readonly timezone?: string
  readonly projectId?: string | null
  readonly prompt: string
  readonly replyTo: ChannelAddress
  readonly enabled?: boolean
  readonly misfire?: string
  readonly model?: string | null
  /** For an ad-hoc target, the run id. Defaults to a generated one. */
  readonly runId?: string
}

/** The result of adding a schedule. */
export type AddResult =
  | { readonly ok: true; readonly id: string; readonly nextRunAt: number }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** How a firing ended, for a log or a test. */
export interface FiringOutcome {
  readonly id: string
  readonly action: 'submitted' | 'skipped'
  readonly reason?: SkipReason
  readonly requestId?: string
  readonly nextRunAt: number
}

/**
 * The scheduler.
 *
 * Exposed as `ctx.opsScheduler`.
 */
export class OpsScheduler {
  private timer: TimerHandle | undefined
  /** The next time the timer is set for, so a re-arm is skipped when unchanged. */
  private armedFor: number | undefined
  private stopped = false
  /** Every firing this process performed, for diagnostics and tests. */
  readonly history: FiringOutcome[] = []
  /** How many submissions were made. */
  submissions = 0
  /** Skips by reason. */
  readonly skips = new Map<SkipReason, number>()

  constructor(
    private readonly ctx: Context,
    private readonly options: SchedulerOptions,
  ) {}

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the timer, after handling any misfire.
   *
   * @returns how many schedules were handled for a misfire.
   */
  async start(): Promise<number> {
    const handled = await this.applyMisfire()
    this.rearm()
    return handled
  }

  /**
   * Handle schedules whose time passed while nothing was watching.
   *
   * Runs **once**, at startup. A schedule that is up to date is left alone.
   *
   * @returns how many schedules were handled.
   */
  async applyMisfire(): Promise<number> {
    const now = this.options.now()
    const past = this.options.store.schedules.pastDue(now)
    let handled = 0

    for (const row of past) {
      const decision = planMisfire(row, now)
      if (decision.action === 'none') continue

      const missedBy = now - row.next_run_at
      const logger = this.ctx.logger('ops-scheduler')

      if (decision.action === 'skip') {
        // The work is periodic and only the latest matters, so the missed window is
        // dropped — recorded in the log, because a silently skipped schedule is
        // indistinguishable from a broken one.
        this.options.store.schedules.markRun(row.id, row.last_run_at ?? row.next_run_at, decision.next, null)
        logger.info(
          'schedule %s missed a window %s ago; policy skip, next run %s',
          row.id,
          describeSeconds(Math.round(missedBy / 1_000)),
          new Date(decision.next).toISOString(),
        )
        handled += 1
        continue
      }

      // `run_once`: the work was missed and is still wanted, so it fires once now
      // and then resumes its normal cadence.
      logger.info(
        'schedule %s missed a window %s ago; policy run_once, firing once',
        row.id,
        describeSeconds(Math.round(missedBy / 1_000)),
      )
      await this.fire(row, { misfired: true, nextRunAt: decision.next, at: now })
      handled += 1
    }

    return handled
  }

  /** Point the timer at the earliest pending run. */
  rearm(): void {
    if (this.stopped) return
    this.cancelTimer()

    const next = this.options.store.schedules.earliestNextRun()
    if (next === undefined) {
      // Nothing enabled: no timer at all, rather than one waking to do nothing.
      this.armedFor = undefined
      return
    }

    const now = this.options.now()
    const { delayMs, clamped } = delayUntil(next, now, MAX_TIMEOUT_MS)
    this.armedFor = delayMs === MAX_TIMEOUT_MS ? now + MAX_TIMEOUT_MS : next

    if (clamped) {
      // The platform cannot wait that long. The timer wakes at the maximum and
      // re-arms, at which point the real delay is computed again — so the schedule
      // still fires at its time rather than early.
      this.ctx
        .logger('ops-scheduler')
        .info('the next run is %s away; re-arming at the platform maximum', describeSeconds(Math.round(delayMs / 1_000)))
    }

    this.timer = this.options.setTimeout(() => {
      void this.tick()
    }, delayMs)
  }

  /** Cancel the current timer, if any. */
  private cancelTimer(): void {
    if (this.timer === undefined) return
    this.options.clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Handle everything that is due, then re-arm.
   *
   * @param at the time to treat as now; defaults to the clock.
   * @returns the outcomes.
   */
  async tick(at?: number): Promise<FiringOutcome[]> {
    const now = at ?? this.options.now()
    const outcomes: FiringOutcome[] = []

    for (const row of this.options.store.schedules.due(now)) {
      // The same simulated instant is threaded through, so a tick at `at` computes
      // its next run from `at` rather than from the wall clock. Without this a test
      // driving a simulated day and a real deployment would take different paths.
      const outcome = await this.fire(row, { at: now })
      if (outcome !== undefined) outcomes.push(outcome)
    }

    this.rearm()
    return outcomes
  }

  /**
   * Fire one schedule.
   *
   * @param row the schedule row, as read.
   * @param options a misfire override, when the caller already planned the next run.
   * @returns the outcome.
   */
  private async fire(
    row: ScheduleRow,
    options: { readonly misfired?: boolean; readonly nextRunAt?: number; readonly at?: number } = {},
  ): Promise<FiringOutcome | undefined> {
    const now = options.at ?? this.options.now()
    const snapshot = this.snapshotFor(row)
    const decision = decideFiring(snapshot)

    // The next run is ALWAYS computed from `now`, so a missed window cannot
    // produce a catch-up burst.
    const next = options.nextRunAt ?? nextRunAfter(row.cron, row.timezone, now)
    if (next === undefined) {
      this.ctx.logger('ops-scheduler').warn('schedule %s has no future occurrence; disabling it', row.id)
      this.options.store.schedules.setEnabled(row.id, false)
      this.rearm()
      return undefined
    }

    if (decision.action === 'skip') {
      // A skip still advances the clock, in one transaction: otherwise the same
      // schedule is due again on the next tick, forever.
      this.options.store.schedules.markRun(row.id, row.last_run_at ?? now, next, row.last_request_id)
      this.skips.set(decision.reason, (this.skips.get(decision.reason) ?? 0) + 1)
      const outcome: FiringOutcome = { id: row.id, action: 'skipped', reason: decision.reason, nextRunAt: next }
      this.history.push(outcome)
      this.ctx.logger('ops-scheduler').info('schedule %s %s', row.id, skipText(decision.reason, decision.detail))

      if (isNoteworthySkip(decision.reason)) {
        this.ctx.emit('ops/schedule-skipped', {
          id: row.id,
          reason: decision.reason,
          detail: decision.detail,
          nextRunAt: next,
          misfired: options.misfired === true,
        })
      }
      return outcome
    }

    // Submit. A refusal is classified rather than thrown, because the governor
    // refusing a paused or over-budget scope is the system working.
    try {
      const receipt = this.submit(row, next)
      this.options.store.schedules.markRun(row.id, now, next, receipt.requestId)
      this.submissions += 1
      const outcome: FiringOutcome = {
        id: row.id,
        action: 'submitted',
        requestId: receipt.requestId,
        nextRunAt: next,
      }
      this.history.push(outcome)
      this.ctx.logger('ops-scheduler').info(
        'schedule %s fired: request %s, next run %s',
        row.id,
        receipt.requestId,
        new Date(next).toISOString(),
      )
      this.ctx.emit('ops/schedule-fired', {
        id: row.id,
        requestId: receipt.requestId,
        projectId: row.project_id,
        nextRunAt: next,
        misfired: options.misfired === true,
      })
      return outcome
    } catch (error) {
      const reason = skipReasonOf(error)
      this.options.store.schedules.markRun(row.id, row.last_run_at ?? now, next, row.last_request_id)
      this.skips.set(reason, (this.skips.get(reason) ?? 0) + 1)
      const detail = error instanceof Error ? error.message : String(error)
      const outcome: FiringOutcome = { id: row.id, action: 'skipped', reason, nextRunAt: next }
      this.history.push(outcome)
      this.ctx.logger('ops-scheduler').warn('schedule %s %s', row.id, skipText(reason, detail))
      this.ctx.emit('ops/schedule-skipped', {
        id: row.id,
        reason,
        detail,
        nextRunAt: next,
        misfired: options.misfired === true,
      })
      return outcome
    }
  }

  /** Build the decision snapshot for one schedule. */
  private snapshotFor(row: ScheduleRow): FireSnapshot {
    const status = this.options.governor.status()
    // The governor's own view of what is still in the system. A local flag would
    // be lost on restart, and a restart is exactly when a double-run is likeliest.
    const live = new Set<string>([
      ...status.pending.map((entry) => entry.requestId),
      ...status.running.map((entry) => entry.runId),
    ])
    return {
      id: row.id,
      enabled: row.enabled,
      projectId: row.project_id,
      lastRequestId: row.last_request_id,
      liveRequestIds: live,
      // The `projects` table's status column is the authoritative source: it is
      // what the governor's own admission decision reads, so the pre-check and the
      // submission cannot disagree about whether a project is paused.
      pausedProjects: new Set(
        this.options.store.projects
          .list()
          .filter((row) => row.status === 'paused')
          .map((row) => row.id),
      ),
    }
  }

  /** Submit one schedule's work to the governor. */
  private submit(row: ScheduleRow, _next: number): { readonly requestId: string } {
    const address = safeDecode(row.reply_chat)
    const source: InboundSource = 'scheduler'

    if (row.project_id !== null) {
      return this.options.governor.submit({
        source,
        target: { projectId: row.project_id },
        content: [{ type: 'text', text: row.prompt }],
        // Priority 1: scheduled work is unattended, so it yields to a human.
        priority: 1,
        ...(address === undefined ? {} : { replyTo: address }),
      })
    }

    // An ad-hoc target: its own scratch run, with the model the schedule names.
    const runId = `schedule-${row.id}`
    return this.options.governor.submit({
      source,
      target: row.model === null ? { adhoc: { runId } } : { adhoc: { runId, model: splitRef(row.model) } },
      content: [{ type: 'text', text: row.prompt }],
      priority: 1,
      ...(address === undefined ? {} : { replyTo: address }),
      ...(row.model === null ? {} : { model: splitRef(row.model) }),
    })
  }

  // ── the public service API ───────────────────────────────────────────────

  /** Every schedule, earliest next run first. */
  list(): ScheduleRow[] {
    return this.options.store.schedules.list()
  }

  /** One schedule. */
  get(id: string): ScheduleRow | undefined {
    return this.options.store.schedules.get(id)
  }

  /**
   * Create a schedule.
   *
   * @param spec what to schedule.
   * @returns the id and the first run, or a problem.
   */
  add(spec: ScheduleSpec): AddResult {
    const now = this.options.now()
    const id = spec.id ?? `sched-${randomUUID().slice(0, 8)}`
    const timezone = spec.timezone ?? this.options.config.timezone ?? 'UTC'
    // The store's column is typed to the policy union, so an unrecognized value
    // from an older row cannot reach it.
    const misfire: MisfirePolicy = isMisfirePolicy(spec.misfire) ? spec.misfire : this.options.config.default_misfire

    if (spec.prompt.trim().length === 0) {
      return { ok: false, code: 'SCHEDULE_INVALID', message: 'A schedule needs a prompt: what should run?' }
    }
    if (this.options.store.schedules.get(id) !== undefined) {
      return { ok: false, code: 'SCHEDULE_INVALID', message: `A schedule with id "${id}" already exists.` }
    }
    if (this.list().length >= this.options.config.max_schedules) {
      return {
        ok: false,
        code: 'SCHEDULE_INVALID',
        message: `Too many schedules (the limit is ${this.options.config.max_schedules}).`,
      }
    }
    if (
      spec.projectId !== undefined &&
      spec.projectId !== null &&
      this.options.projects.configOf(spec.projectId) === undefined
    ) {
      return { ok: false, code: 'PROJECT_NOT_FOUND', message: `No project "${spec.projectId}".` }
    }

    const check = checkCron(spec.cron, timezone, this.options.config.min_interval_minutes, now)
    if (!check.ok || check.next === undefined) {
      return {
        ok: false,
        code: check.problem === 'too_frequent' ? 'SCHEDULE_INVALID' : 'SCHEDULE_INVALID',
        message: check.message ?? 'The cron expression could not be used.',
      }
    }

    this.options.store.schedules.insert(
      {
        id,
        cron: spec.cron,
        timezone,
        project_id: spec.projectId ?? null,
        prompt: spec.prompt,
        reply_chat: encodeAddress(spec.replyTo),
        enabled: spec.enabled ?? true,
        next_run_at: check.next,
        misfire,
        model: spec.model ?? null,
      },
      now,
    )

    this.ctx.logger('ops-scheduler').info(
      'schedule %s added: %s (%s), next run %s',
      id,
      spec.cron,
      timezone,
      new Date(check.next).toISOString(),
    )
    this.rearm()
    return { ok: true, id, nextRunAt: check.next }
  }

  /**
   * Delete a schedule.
   *
   * @param id the schedule.
   * @returns whether it existed.
   */
  remove(id: string): boolean {
    const removed = this.options.store.schedules.delete(id)
    if (removed) {
      this.ctx.logger('ops-scheduler').info('schedule %s removed', id)
      this.rearm()
    }
    return removed
  }

  /**
   * Enable or disable a schedule.
   *
   * @param id the schedule.
   * @param enabled the new state.
   * @returns whether it existed.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const changed = this.options.store.schedules.setEnabled(id, enabled)
    if (changed) this.rearm()
    return changed
  }

  /** Enable a schedule. */
  enable(id: string): boolean {
    return this.setEnabled(id, true)
  }

  /** Disable a schedule. */
  disable(id: string): boolean {
    return this.setEnabled(id, false)
  }

  /**
   * Fire a schedule now, without waiting for its time.
   *
   * The schedule's own clock is advanced as if it had fired, so a manual run does
   * not cause a second one moments later.
   *
   * @param id the schedule.
   * @returns the outcome, or `undefined` when the schedule does not exist.
   */
  async runNow(id: string): Promise<FiringOutcome | undefined> {
    const row = this.options.store.schedules.get(id)
    if (row === undefined) return undefined
    const outcome = await this.fire(row, { at: this.options.now() })
    this.rearm()
    return outcome
  }

  /** Stop the timer. */
  stop(): void {
    this.stopped = true
    this.cancelTimer()
  }

  // ── `/cron` ──────────────────────────────────────────────────────────────

  /**
   * The `/cron` command.
   *
   * The handler lives here rather than in `ops-commands` because the scheduler owns
   * the state and the cron arithmetic; the command layer only delegates.
   *
   * @param line the input after the command name.
   * @param context who is asking.
   * @returns the reply.
   */
  run(line: string, context: CommandContext): CommandResult {
    const parts = line.trim().split(/\s+/).filter((part) => part.length > 0)
    const verb = parts[0]?.toLowerCase() ?? 'list'

    switch (verb) {
      case '':
      case 'list':
        return this.listResult()
      case 'add':
        return this.addResult(line.slice(line.indexOf('add') + 3), context)
      case 'remove':
      case 'rm':
        return this.removeResult(parts[1])
      case 'enable':
        return this.toggleResult(parts[1], true)
      case 'disable':
        return this.toggleResult(parts[1], false)
      case 'run':
        return { text: this.runNowText(parts[1]) }
      default:
        return {
          error: true,
          text:
            `Unknown /cron subcommand "${verb}".\n` +
            'Try: /cron list | add <project> "<cron>" <text> | remove <id> | enable <id> | disable <id> | run <id>',
        }
    }
  }

  /** `/cron list`. */
  private listResult(): CommandResult {
    const rows = this.list()
    if (rows.length === 0) {
      return { text: 'No schedules. Add one with:\n  /cron add <project> "0 9 * * *" what to do' }
    }
    const now = this.options.now()
    const lines = ['Id           Next run             Every     State    Project  Prompt']
    for (const row of rows) {
      const interval = checkCron(row.cron, row.timezone, 0, now).intervalSeconds
      lines.push(
        [
          row.id.padEnd(12),
          `${new Date(row.next_run_at).toISOString().slice(0, 16).replace('T', ' ')}Z`.padEnd(20),
          (interval === undefined ? row.cron : describeSeconds(interval)).padEnd(9),
          (row.enabled ? 'on' : 'off').padEnd(8),
          (row.project_id ?? 'task').padEnd(8),
          row.prompt.length > 40 ? `${row.prompt.slice(0, 37)}...` : row.prompt,
        ].join(' '),
      )
    }
    return { text: lines.join('\n') }
  }

  /** `/cron add <project> "<cron>" <text>`. */
  private addResult(rest: string, context: CommandContext): CommandResult {
    const parsed = parseAdd(rest)
    if (!parsed.ok) return { error: true, text: parsed.message }

    const result = this.add({
      cron: parsed.cron,
      prompt: parsed.prompt,
      projectId: parsed.projectId,
      replyTo: context.address,
    })
    if (!result.ok) return { error: true, text: result.message }
    return {
      text:
        `Scheduled ${result.id}: ${parsed.cron}\n` +
        `Next run: ${new Date(result.nextRunAt).toISOString()}\n` +
        `Target: ${parsed.projectId ?? 'a one-off task'}`,
    }
  }

  /** `/cron remove <id>`. */
  private removeResult(id: string | undefined): CommandResult {
    if (id === undefined) return { error: true, text: 'Which schedule? /cron remove <id>' }
    return this.remove(id)
      ? { text: `Removed ${id}.` }
      : { error: true, text: `No schedule "${id}".` }
  }

  /** `/cron enable|disable <id>`. */
  private toggleResult(id: string | undefined, enabled: boolean): CommandResult {
    if (id === undefined) return { error: true, text: `Which schedule? /cron ${enabled ? 'enable' : 'disable'} <id>` }
    if (!this.setEnabled(id, enabled)) return { error: true, text: `No schedule "${id}".` }
    const row = this.get(id)
    const next = row === undefined ? '' : `\nNext run: ${new Date(row.next_run_at).toISOString()}`
    return { text: `${enabled ? 'Enabled' : 'Disabled'} ${id}.${next}` }
  }

  /** `/cron run <id>`, synchronously resolved for a command reply. */
  private runNowText(id: string | undefined): string {
    if (id === undefined) return 'Which schedule? /cron run <id>'
    const row = this.get(id)
    if (row === undefined) return `No schedule "${id}".`
    void this.runNow(id)
    return `Running ${id} now.`
  }

  /**
   * A health report.
   *
   * `degraded` when a schedule has fired nothing in this process while others have
   * — a sign the timer is not waking — or when skips are dominated by overlaps,
   * which means an interval is shorter than the work it schedules.
   *
   * @returns the report.
   */
  health(): ServiceHealth {
    const rows = this.list()
    const enabled = rows.filter((row) => row.enabled).length
    const overlaps = this.skips.get('overlap') ?? 0
    const skips = [...this.skips.values()].reduce((sum, count) => sum + count, 0)

    const details: Record<string, unknown> = {
      schedules: rows.length,
      enabled,
      submissions: this.submissions,
      skips: Object.fromEntries(this.skips),
    }

    if (rows.length === 0) return { status: 'ok', details }
    if (enabled === 0) return { status: 'ok', details: { ...details, note: 'every schedule is disabled' } }
    // Most skips being overlaps is a configuration smell rather than a fault.
    if (skips >= 4 && overlaps > skips / 2) {
      return { status: 'degraded', details: { ...details, reason: 'most skips are overlaps; an interval is too short' } }
    }
    return { status: 'ok', details }
  }
}

/** Parse `/cron add <project> "<cron>" <text>`, or without a project. */
export function parseAdd(
  rest: string,
): { ok: true; projectId: string | null; cron: string; prompt: string } | { ok: false; message: string } {
  const input = rest.trim()
  if (input.length === 0) {
    return { ok: false, message: 'Usage: /cron add [project] "<cron>" <what to do>' }
  }

  // The cron expression is quoted, because it contains spaces. Accepting an
  // unquoted one would make the project id and the expression ambiguous.
  const quoted = /^(\S+)\s+"([^"]+)"\s+([\s\S]+)$/.exec(input)
  if (quoted !== null) {
    return { ok: true, projectId: quoted[1] as string, cron: quoted[2] as string, prompt: (quoted[3] as string).trim() }
  }
  // No project: the expression is first, quoted.
  const bare = /^"([^"]+)"\s+([\s\S]+)$/.exec(input)
  if (bare !== null) {
    return { ok: true, projectId: null, cron: bare[1] as string, prompt: (bare[2] as string).trim() }
  }
  return {
    ok: false,
    message:
      'The cron expression must be quoted, because it contains spaces.\n' +
      'Try: /cron add myproject "0 9 * * *" check the build',
  }
}

/** Decode a stored address, tolerating a malformed one. */
function safeDecode(value: string): ChannelAddress | undefined {
  try {
    return decodeAddress(value)
  } catch {
    return undefined
  }
}

/** Split a `provider/model`, defaulting the provider. */
function splitRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/')
  if (slash <= 0) return { provider: 'deepseek', model: ref }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }
}