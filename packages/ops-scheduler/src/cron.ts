// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/scheduler/cron` — cron arithmetic, and the misfire plan.
 *
 * One rule shapes everything here:
 *
 * > **`next_run_at` is always strictly in the future, computed from `now`.**
 *
 * A schedule is never advanced to a time that has already passed. That is what
 * makes a missed window a *missed window* rather than a burst: a schedule that was
 * down for a day fires once (or not at all, per its policy) and resumes on its
 * normal cadence, instead of racing through 288 catch-up runs.
 *
 * @module @argus-agent/scheduler/cron
 */
import { Cron } from 'croner'

/** Why a cron expression or a schedule specification was refused. */
export type CronProblem =
  | 'empty'
  | 'invalid_expression'
  | 'too_frequent'
  | 'unknown_timezone'
  | 'expired'

/** A validated cron expression. */
export interface CronCheck {
  readonly ok: boolean
  readonly problem?: CronProblem
  readonly message?: string
  /** The next occurrence strictly after `from`. */
  readonly next?: number
  /** The seconds between two consecutive occurrences, when it could be measured. */
  readonly intervalSeconds?: number
}

/**
 * Check that a timezone is one this platform knows.
 *
 * `Intl` is the authority: if it cannot format a date in the zone, the zone does
 * not exist. Catching it here gives a clear message rather than a croner throw at
 * the first firing, which would be hours later.
 *
 * @param timezone the IANA name.
 * @returns whether the platform recognizes it.
 */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * Validate a cron expression, in a timezone, against a minimum interval.
 *
 * The interval is measured by asking croner for the **next two** occurrences and
 * subtracting. That is more honest than counting fields: `0 9 * * *` and
 * `0 9 * * 1-5` look similar and have very different cadences, and a rule that
 * counted asterisks would accept a schedule that fires every minute.
 *
 * @param expression the cron expression.
 * @param timezone the IANA timezone.
 * @param minIntervalMinutes the minimum gap, in minutes.
 * @param from the time to compute from.
 * @returns the check result.
 */
export function checkCron(
  expression: string,
  timezone: string,
  minIntervalMinutes: number,
  from: number,
): CronCheck {
  if (expression.trim().length === 0) {
    return { ok: false, problem: 'empty', message: 'A cron expression is required.' }
  }
  if (!isKnownTimezone(timezone)) {
    return {
      ok: false,
      problem: 'unknown_timezone',
      message: `Unknown timezone "${timezone}". Use an IANA name, such as Europe/Bucharest.`,
    }
  }

  let cron: Cron
  try {
    cron = new Cron(expression, { timezone, paused: true })
  } catch (error) {
    return {
      ok: false,
      problem: 'invalid_expression',
      message: `Invalid cron expression "${expression}": ${messageOf(error)}`,
    }
  }

  const first = cron.nextRun(new Date(from))
  if (first === null) {
    // A valid expression that will never fire again, such as a specific past date.
    return {
      ok: false,
      problem: 'expired',
      message: `The expression "${expression}" has no future occurrence.`,
    }
  }
  const second = cron.nextRun(first)
  const intervalSeconds = second === null ? undefined : Math.round((second.getTime() - first.getTime()) / 1_000)

  if (intervalSeconds !== undefined && intervalSeconds < minIntervalMinutes * 60) {
    return {
      ok: false,
      problem: 'too_frequent',
      message:
        `The expression "${expression}" fires every ${describeSeconds(intervalSeconds)}, ` +
        `which is more often than the minimum of ${minIntervalMinutes} minute(s).`,
    }
  }

  return { ok: true, next: first.getTime(), ...(intervalSeconds === undefined ? {} : { intervalSeconds }) }
}

/**
 * The next occurrence strictly after `from`.
 *
 * @param expression the cron expression.
 * @param timezone the IANA timezone.
 * @param from the time to compute from.
 * @returns the epoch ms, or `undefined` when there is no future occurrence.
 */
export function nextRunAfter(expression: string, timezone: string, from: number): number | undefined {
  try {
    const cron = new Cron(expression, { timezone, paused: true })
    return cron.nextRun(new Date(from))?.getTime()
  } catch {
    return undefined
  }
}

/** What to do about a schedule whose time passed while nothing was watching. */
export type MisfireDecision =
  | { readonly action: 'fire'; readonly next: number }
  | { readonly action: 'skip'; readonly next: number }
  | { readonly action: 'none' }

/**
 * Plan the misfire handling for a schedule that is past due.
 *
 * Called **once at startup**, for schedules whose `next_run_at` is already behind
 * `now`. A schedule that is up to date is `'none'` and is left for the timer.
 *
 * | Policy | Action | Why |
 * |---|---|---|
 * | `run_once` | fire once, then jump to the next future time | the work was missed and is still wanted |
 * | `skip` | jump to the next future time | the work is periodic and only the latest matters |
 *
 * **Neither policy catches up.** A schedule that was down for a day fires once or
 * not at all, and the next run is the next *scheduled* time. That is the property
 * that makes the exactly-once test meaningful: no burst is possible.
 *
 * @param row the schedule's stored state.
 * @param now the current time.
 * @returns the decision.
 */
export function planMisfire(
  row: {
    readonly cron: string
    readonly timezone: string
    readonly next_run_at: number
    readonly misfire: string
  },
  now: number,
): MisfireDecision {
  if (row.next_run_at > now) return { action: 'none' }

  const next = nextRunAfter(row.cron, row.timezone, now)
  if (next === undefined) return { action: 'none' }

  return row.misfire === 'skip' ? { action: 'skip', next } : { action: 'fire', next }
}

/**
 * How long until a schedule should fire, clamped for `setTimeout`.
 *
 * The platform's maximum is about 24.8 days. A schedule further out than that is
 * **not** truncated to the maximum and left to fire early — the timer is set to the
 * maximum and re-armed on wake, at which point the real delay is computed again.
 * The `clamped` flag tells the caller that happened.
 *
 * @param nextRunAt the target time.
 * @param now the current time.
 * @param maxMs the platform's maximum delay.
 * @returns the delay and whether it was clamped.
 */
export function delayUntil(
  nextRunAt: number,
  now: number,
  maxMs: number,
): { readonly delayMs: number; readonly clamped: boolean } {
  const raw = nextRunAt - now
  if (raw <= 0) return { delayMs: 0, clamped: false }
  if (raw > maxMs) return { delayMs: maxMs, clamped: true }
  return { delayMs: raw, clamped: false }
}

/** A one-line description of an interval, for a message. */
export function describeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} second(s)`
  if (seconds < 3_600) return `${Math.round(seconds / 60)} minute(s)`
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} hour(s)`
  return `${Math.round(seconds / 86_400)} day(s)`
}

/** An error's message, for a returned problem. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}