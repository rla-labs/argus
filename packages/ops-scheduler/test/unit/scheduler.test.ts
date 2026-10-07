// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for `ops-scheduler`'s pure layers.
 *
 * Cron arithmetic, the misfire plan, the delay clamp and the firing decision —
 * everything decidable without a clock, a store or a governor.
 */
import { describe, expect, it } from 'vitest'
import {
  checkCron,
  delayUntil,
  describeSeconds,
  isKnownTimezone,
  nextRunAfter,
  planMisfire,
} from '../../src/cron.js'
import { decideFiring, isNoteworthySkip, skipReasonOf, skipText } from '../../src/fire.js'
import { isMisfirePolicy, schedulerOf, MISFIRE_POLICIES } from '../../src/config.js'
import { parseAdd } from '../../src/service.js'

/** 2026-03-01T00:00:00Z, a convenient round minute. */
const T0 = Date.UTC(2026, 2, 1, 0, 0, 0)

// ── cron validation ────────────────────────────────────────────────────────

describe('checkCron', () => {
  it('accepts a five-minute schedule', () => {
    const result = checkCron('*/5 * * * *', 'UTC', 1, T0)
    expect(result.ok).toBe(true)
    expect(result.intervalSeconds).toBe(300)
    expect(result.next).toBe(T0 + 300_000)
  })

  it('accepts a daily schedule and reports its interval', () => {
    const result = checkCron('0 9 * * *', 'UTC', 1, T0)
    expect(result.ok).toBe(true)
    // 24 hours, the first occurrence being 09:00 UTC on the same day.
    expect(result.intervalSeconds).toBe(86_400)
    expect(result.next).toBe(Date.UTC(2026, 2, 1, 9, 0, 0))
  })

  it('accepts a weekly schedule', () => {
    const result = checkCron('0 9 * * 1', 'UTC', 1, T0)
    expect(result.ok).toBe(true)
    expect(result.intervalSeconds).toBe(7 * 86_400)
  })

  it('MEASURES the interval rather than counting fields', () => {
    // `0 9 * * 1-5` looks like a daily expression and fires five days a week. A
    // field-counting rule would accept `* * * * *` as "one field" and be wrong.
    const weekdays = checkCron('0 9 * * 1-5', 'UTC', 1, T0)
    expect(weekdays.ok).toBe(true)
    // From a Sunday, the next is Monday and the one after is Tuesday: one day.
    expect(weekdays.intervalSeconds).toBe(86_400)
  })

  it('rejects a schedule more frequent than the minimum', () => {
    const result = checkCron('* * * * *', 'UTC', 5, T0)
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('too_frequent')
    expect(result.message).toContain('every 1 minute')
    expect(result.message).toContain('minimum of 5 minute')
  })

  it('accepts one exactly at the minimum', () => {
    expect(checkCron('*/5 * * * *', 'UTC', 5, T0).ok).toBe(true)
  })

  it('rejects a malformed expression', () => {
    const result = checkCron('not a cron', 'UTC', 1, T0)
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('invalid_expression')
  })

  it('rejects an expression with too many fields', () => {
    expect(checkCron('* * * * * * *', 'UTC', 1, T0).ok).toBe(false)
  })

  it('rejects an empty expression', () => {
    const result = checkCron('   ', 'UTC', 1, T0)
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('empty')
  })

  it('rejects an unknown timezone with a clear message', () => {
    const result = checkCron('0 9 * * *', 'Mars/Olympus', 1, T0)
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('unknown_timezone')
    expect(result.message).toContain('IANA')
  })

  it('reports an expression with no future occurrence', () => {
    // A day-of-week value that cannot occur, so croner parses the pattern and then
    // finds no instant that satisfies it. A one-off past date is a different case:
    // croner rejects the year field outright, which is the invalid_expression test.
    const result = checkCron('0 0 30 2 *', 'UTC', 1, T0)
    expect(result.ok).toBe(false)
    // Either croner rejects the pattern, or it parses and has no occurrence. Both
    // are refusals with a message, which is what a caller needs.
    expect(['invalid_expression', 'expired']).toContain(result.problem)
    expect((result.message ?? '').length).toBeGreaterThan(10)
  })

  it('gives a one-line reason for every rejection', () => {
    for (const [expression, timezone, min] of [
      ['nonsense', 'UTC', 1],
      ['', 'UTC', 1],
      ['* * * * *', 'UTC', 5],
      ['0 9 * * *', 'Nope/Nope', 1],
    ] as Array<[string, string, number]>) {
      const result = checkCron(expression, timezone, min, T0)
      expect(result.ok, `${expression} should be rejected`).toBe(false)
      expect((result.message ?? '').length, expression).toBeGreaterThan(10)
    }
  })
})

describe('isKnownTimezone', () => {
  it('accepts real zones', () => {
    for (const zone of ['UTC', 'Europe/Bucharest', 'America/New_York', 'Asia/Tokyo']) {
      expect(isKnownTimezone(zone), zone).toBe(true)
    }
  })

  it('rejects invented ones', () => {
    for (const zone of ['Mars/Olympus', '', 'Europe/Nowhere']) {
      expect(isKnownTimezone(zone), zone).toBe(false)
    }
  })
})

describe('nextRunAfter', () => {
  it('computes the next occurrence', () => {
    expect(nextRunAfter('*/5 * * * *', 'UTC', T0)).toBe(T0 + 300_000)
  })

  it('is strictly after the given time', () => {
    // Exactly on a boundary must give the NEXT one, not the same instant: a
    // schedule that returns its own time would fire forever.
    const onBoundary = nextRunAfter('*/5 * * * *', 'UTC', T0 + 300_000)
    expect(onBoundary).toBe(T0 + 600_000)
  })

  it('handles a timezone offset', () => {
    // 09:00 in Bucharest (UTC+2 in March) is 07:00 UTC.
    const next = nextRunAfter('0 9 * * *', 'Europe/Bucharest', T0)
    expect(next).toBe(Date.UTC(2026, 2, 1, 7, 0, 0))
  })

  it('returns undefined for a bad expression', () => {
    expect(nextRunAfter('nonsense', 'UTC', T0)).toBeUndefined()
  })
})

describe('DST handling', () => {
  // Europe/Bucharest springs forward on 2026-03-29 (02:00 → 03:00) and falls back
  // on 2026-10-25 (03:00 → 02:00). A daily 09:00 schedule must still land at 09:00
  // local on both days, which means a different UTC offset — the whole reason a
  // tested cron library is used instead of arithmetic on epoch milliseconds.

  it('keeps 09:00 local on the spring-forward day', () => {
    const dayBefore = Date.UTC(2026, 2, 28, 7, 0, 0) // 09:00 local, UTC+2
    const next = nextRunAfter('0 9 * * *', 'Europe/Bucharest', dayBefore)
    expect(next).toBe(Date.UTC(2026, 2, 29, 6, 0, 0)) // 09:00 local, UTC+3
  })

  it('keeps 09:00 local on the fall-back day', () => {
    const dayBefore = Date.UTC(2026, 9, 24, 6, 0, 0) // 09:00 local, UTC+3
    const next = nextRunAfter('0 9 * * *', 'Europe/Bucharest', dayBefore)
    expect(next).toBe(Date.UTC(2026, 9, 25, 7, 0, 0)) // 09:00 local, UTC+2
  })

  it('produces a 23-hour gap across the spring-forward night', () => {
    // The interval that CONTAINS the transition is short, because an hour of wall
    // clock disappears. 09:00 on the 28th to 09:00 on the 29th is 23 hours.
    const before = Date.UTC(2026, 2, 28, 7, 0, 0) // 09:00 local, UTC+2
    const spring = nextRunAfter('0 9 * * *', 'Europe/Bucharest', before) as number
    expect(spring).toBe(Date.UTC(2026, 2, 29, 6, 0, 0)) // 09:00 local, UTC+3
    expect((spring - before) / 3_600_000).toBe(23)
  })

  it('produces a 25-hour gap across the fall-back night', () => {
    // And the opposite: an hour of wall clock repeats, so the interval is long.
    const before = Date.UTC(2026, 9, 24, 6, 0, 0) // 09:00 local, UTC+3
    const fall = nextRunAfter('0 9 * * *', 'Europe/Bucharest', before) as number
    expect(fall).toBe(Date.UTC(2026, 9, 25, 7, 0, 0)) // 09:00 local, UTC+2
    expect((fall - before) / 3_600_000).toBe(25)
  })

  it('returns to a 24-hour gap the day after each transition', () => {
    // The transition affects one interval, not the cadence: this is what makes a
    // daily schedule stay at 09:00 local all year.
    const spring = Date.UTC(2026, 2, 29, 6, 0, 0)
    const next = nextRunAfter('0 9 * * *', 'Europe/Bucharest', spring) as number
    expect((next - spring) / 3_600_000).toBe(24)

    const fall = Date.UTC(2026, 9, 25, 7, 0, 0)
    const after = nextRunAfter('0 9 * * *', 'Europe/Bucharest', fall) as number
    expect((after - fall) / 3_600_000).toBe(24)
  })

  it('skips a wall-clock time that does not exist that day', () => {
    // 02:30 local does not happen on the spring-forward day. croner moves to the
    // next valid instant rather than producing a time that never occurred.
    const next = nextRunAfter('30 2 * * *', 'Europe/Bucharest', Date.UTC(2026, 2, 28, 12, 0, 0))
    expect(next).toBeDefined()
    const asLocal = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Bucharest',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(next as number))
    // Either it lands at 03:00 (the next valid instant) or on the following day at
    // 02:30 — never at a time that did not exist.
    expect(['03:00', '02:30']).toContain(asLocal)
  })

  it('keeps a five-minute schedule on its cadence across a transition', () => {
    // A frequent schedule is unaffected by a wall-clock jump: it follows absolute
    // time. This is the property the exactly-once test relies on.
    const before = Date.UTC(2026, 2, 29, 0, 55, 0)
    const next = nextRunAfter('*/5 * * * *', 'Europe/Bucharest', before)
    expect(next).toBe(before + 300_000)
  })
})

// ── misfire ────────────────────────────────────────────────────────────────

describe('planMisfire', () => {
  const row = (overrides: Partial<{ cron: string; timezone: string; next_run_at: number; misfire: string }> = {}) => ({
    cron: '*/5 * * * *',
    timezone: 'UTC',
    next_run_at: T0 - 600_000,
    misfire: 'run_once',
    ...overrides,
  })

  it('does nothing when the schedule is not past due', () => {
    // A schedule that is up to date is left to the timer.
    expect(planMisfire(row({ next_run_at: T0 + 60_000 }), T0).action).toBe('none')
  })

  it('fires once under run_once', () => {
    const decision = planMisfire(row(), T0)
    expect(decision.action).toBe('fire')
    expect(decision.action === 'fire' && decision.next).toBe(T0 + 300_000)
  })

  it('skips under skip', () => {
    const decision = planMisfire(row({ misfire: 'skip' }), T0)
    expect(decision.action).toBe('skip')
    expect(decision.action === 'skip' && decision.next).toBe(T0 + 300_000)
  })

  it('NEVER catches up, whatever the policy', () => {
    // A schedule that was down for a day must produce ONE firing or none — never
    // 288 of them. The next run is computed from now, not from the missed time.
    const longMiss = row({ next_run_at: T0 - 24 * 3_600_000 })
    for (const policy of ['run_once', 'skip']) {
      const decision = planMisfire({ ...longMiss, misfire: policy }, T0)
      const next = decision.action === 'none' ? undefined : decision.next
      expect(next, policy).toBe(T0 + 300_000)
      expect(next as number, policy).toBeGreaterThan(T0)
    }
  })

  it('treats an unknown policy as run_once', () => {
    // The safer of the two: the work was missed and is probably still wanted.
    expect(planMisfire(row({ misfire: 'nonsense' }), T0).action).toBe('fire')
  })

  it('does nothing when there is no future occurrence', () => {
    expect(planMisfire(row({ cron: '0 0 1 1 * 2020' }), T0).action).toBe('none')
  })
})

// ── the delay clamp ────────────────────────────────────────────────────────

describe('delayUntil', () => {
  const MAX = 2_147_483_647

  it('returns the real delay for a nearby run', () => {
    expect(delayUntil(T0 + 5_000, T0, MAX)).toEqual({ delayMs: 5_000, clamped: false })
  })

  it('CLAMPS a run beyond the platform maximum', () => {
    // A schedule a year out would overflow setTimeout and fire immediately.
    const result = delayUntil(T0 + 365 * 86_400_000, T0, MAX)
    expect(result.delayMs).toBe(MAX)
    expect(result.clamped).toBe(true)
  })

  it('does not clamp one exactly at the maximum', () => {
    expect(delayUntil(T0 + MAX, T0, MAX).clamped).toBe(false)
  })

  it('returns zero for a time already past', () => {
    expect(delayUntil(T0 - 1, T0, MAX)).toEqual({ delayMs: 0, clamped: false })
  })

  it('returns zero for exactly now', () => {
    expect(delayUntil(T0, T0, MAX).delayMs).toBe(0)
  })
})

describe('describeSeconds', () => {
  it.each([
    [30, '30 second(s)'],
    [60, '1 minute(s)'],
    [300, '5 minute(s)'],
    [3_600, '1 hour(s)'],
    [86_400, '1 day(s)'],
    [7 * 86_400, '7 day(s)'],
  ])('describes %i seconds as %s', (seconds, expected) => {
    expect(describeSeconds(seconds)).toBe(expected)
  })
})

// ── the firing decision ────────────────────────────────────────────────────

describe('decideFiring', () => {
  const base = {
    id: 's1',
    enabled: true,
    projectId: 'alpha',
    lastRequestId: null,
    liveRequestIds: new Set<string>(),
    pausedProjects: new Set<string>(),
  }

  it('submits when nothing is in the way', () => {
    expect(decideFiring(base)).toEqual({ action: 'submit' })
  })

  it('skips a disabled schedule', () => {
    expect(decideFiring({ ...base, enabled: false })).toEqual({ action: 'skip', reason: 'disabled' })
  })

  it('skips an OVERLAP when the previous request is pending', () => {
    const decision = decideFiring({
      ...base,
      lastRequestId: 'req-1',
      liveRequestIds: new Set(['req-1']),
    })
    expect(decision.action).toBe('skip')
    expect(decision.action === 'skip' && decision.reason).toBe('overlap')
    expect(decision.action === 'skip' && decision.detail).toContain('req-1')
  })

  it('submits when the previous request is gone', () => {
    // The set is the governor's live view, so a finished request is simply absent.
    expect(decideFiring({ ...base, lastRequestId: 'req-1', liveRequestIds: new Set() }).action).toBe('submit')
  })

  it('skips a PAUSED project', () => {
    const decision = decideFiring({ ...base, pausedProjects: new Set(['alpha']) })
    expect(decision.action).toBe('skip')
    expect(decision.action === 'skip' && decision.reason).toBe('paused')
  })

  it('does not confuse a paused project with a running one', () => {
    expect(decideFiring({ ...base, pausedProjects: new Set(['beta']) }).action).toBe('submit')
  })

  it('does not check paused for an ad-hoc target', () => {
    const decision = decideFiring({
      ...base,
      projectId: null,
      pausedProjects: new Set(['alpha']),
    })
    expect(decision.action).toBe('submit')
  })

  it('checks DISABLED before overlap', () => {
    // The order is the order of cost: the cheapest refusal wins, so a disabled
    // schedule does not even look at the governor's set.
    const decision = decideFiring({
      ...base,
      enabled: false,
      lastRequestId: 'req-1',
      liveRequestIds: new Set(['req-1']),
    })
    expect(decision.action === 'skip' && decision.reason).toBe('disabled')
  })

  it('checks OVERLAP before paused', () => {
    const decision = decideFiring({
      ...base,
      lastRequestId: 'req-1',
      liveRequestIds: new Set(['req-1']),
      pausedProjects: new Set(['alpha']),
    })
    expect(decision.action === 'skip' && decision.reason).toBe('overlap')
  })

  it('ignores an empty lastRequestId rather than treating it as live', () => {
    // A row with no previous run must not be read as "the previous run is ''".
    expect(decideFiring({ ...base, lastRequestId: null, liveRequestIds: new Set(['']) }).action).toBe('submit')
  })
})

describe('skipReasonOf', () => {
  it.each([
    ['PROJECT_PAUSED', 'paused'],
    ['BUDGET_EXCEEDED', 'budget'],
    ['PROJECT_NOT_FOUND', 'no_project'],
    ['PROJECT_NOT_ACTIVE', 'no_project'],
    ['PANIC_MODE', 'error'],
    ['SOMETHING_ELSE', 'error'],
  ])('maps %s to %s', (code, expected) => {
    expect(skipReasonOf({ code })).toBe(expected)
  })

  it('maps a plain error to error', () => {
    expect(skipReasonOf(new Error('boom'))).toBe('error')
    expect(skipReasonOf(undefined)).toBe('error')
  })

  it('matches PROJECT_PAUSED although it is not a typed code', () => {
    // It is a governor REJECTION code, deliberately outside the error-code map:
    // a pause is a policy decision about one request, not a system error.
    expect(skipReasonOf({ code: 'PROJECT_PAUSED' })).toBe('paused')
  })
})

describe('isNoteworthySkip', () => {
  it('does NOT notify for an overlap', () => {
    // A five-minute schedule whose work takes ten overlaps every other time. A
    // notification each time would train the operator to ignore the channel.
    expect(isNoteworthySkip('overlap')).toBe(false)
  })

  it('notifies for every other reason', () => {
    for (const reason of ['paused', 'disabled', 'budget', 'no_project', 'error'] as const) {
      expect(isNoteworthySkip(reason), reason).toBe(true)
    }
  })
})

describe('skipText', () => {
  it('produces a sentence for every reason', () => {
    for (const reason of ['overlap', 'paused', 'disabled', 'budget', 'no_project', 'error'] as const) {
      expect(skipText(reason), reason).toMatch(/^skipped: /)
    }
  })

  it('includes the detail when there is one', () => {
    expect(skipText('paused', 'project alpha is paused')).toContain('project alpha is paused')
  })

  it('omits the parentheses when there is none', () => {
    expect(skipText('disabled')).not.toContain('(')
  })
})

// ── config ─────────────────────────────────────────────────────────────────

describe('schedulerOf', () => {
  it('applies every default', () => {
    const config = schedulerOf({})
    expect(config.enabled).toBe(true)
    expect(config.min_interval_minutes).toBe(5)
    expect(config.default_misfire).toBe('run_once')
    expect(config.grace_ms).toBe(1_000)
  })

  it('defaults the timezone from the deployment', () => {
    // So a schedule does not have to repeat it.
    expect(schedulerOf({ timezone: 'Europe/Bucharest' }).timezone).toBe('Europe/Bucharest')
  })

  it("lets the scheduler's own timezone win", () => {
    expect(schedulerOf({ timezone: 'UTC', scheduler: { timezone: 'Asia/Tokyo' } }).timezone).toBe('Asia/Tokyo')
  })

  it('honours explicit values', () => {
    const config = schedulerOf({
      scheduler: { enabled: false, min_interval_minutes: 10, default_misfire: 'skip' },
    })
    expect(config.enabled).toBe(false)
    expect(config.min_interval_minutes).toBe(10)
    expect(config.default_misfire).toBe('skip')
  })

  it('rejects an unknown misfire policy', () => {
    expect(() => schedulerOf({ scheduler: { default_misfire: 'maybe' } })).toThrow()
  })

  it('rejects a minimum interval below one minute', () => {
    // A schedule that can fire every second is a denial of service against the
    // governor and the budget.
    expect(() => schedulerOf({ scheduler: { min_interval_minutes: 0 } })).toThrow()
  })
})

describe('isMisfirePolicy', () => {
  it('accepts the two policies', () => {
    for (const policy of MISFIRE_POLICIES) expect(isMisfirePolicy(policy), policy).toBe(true)
  })

  it('rejects anything else', () => {
    for (const value of ['maybe', '', undefined, 1, null]) {
      expect(isMisfirePolicy(value), String(value)).toBe(false)
    }
  })
})

// ── the /cron parser ───────────────────────────────────────────────────────

describe('parseAdd', () => {
  it('parses a project, a quoted cron and a prompt', () => {
    expect(parseAdd('alpha "0 9 * * *" check the build')).toEqual({
      ok: true,
      projectId: 'alpha',
      cron: '0 9 * * *',
      prompt: 'check the build',
    })
  })

  it('parses without a project', () => {
    expect(parseAdd('"*/5 * * * *" ping')).toEqual({
      ok: true,
      projectId: null,
      cron: '*/5 * * * *',
      prompt: 'ping',
    })
  })

  it('keeps a multi-word prompt intact', () => {
    const result = parseAdd('alpha "0 9 * * *"   summarise the   readme  ')
    expect(result.ok && result.prompt).toBe('summarise the   readme')
  })

  it('keeps a prompt containing quotes', () => {
    const result = parseAdd('alpha "0 9 * * *" say "hello"')
    expect(result.ok && result.prompt).toBe('say "hello"')
  })

  it('refuses an unquoted expression', () => {
    // The expression contains spaces, so an unquoted one is ambiguous with the
    // project id — refusing is clearer than guessing.
    const result = parseAdd('alpha 0 9 * * * check')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('quoted')
  })

  it('refuses an empty input', () => {
    expect(parseAdd('   ').ok).toBe(false)
  })
})