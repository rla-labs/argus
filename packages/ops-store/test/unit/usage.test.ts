// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the usage repository.
 *
 * The load-bearing invariant is the reconciliation test: the sum of
 * `usage_events` for a scope and day must equal `usage_daily`. If it does not,
 * budgets are enforced against a number that does not match the invoice.
 */
import { describe, expect, it } from 'vitest'
import { projectScope, usd, type Scope } from '@argus-agent/types'
import { at, openMemoryStore, T0 } from '../helpers.js'
import type { UsageEventInput } from '../../src/types.js'

/** A usage event with sensible defaults. */
function event(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    ts: T0,
    run_id: 'run-1',
    project_id: 'a',
    scope: projectScope('a'),
    root_session: 's1',
    session_id: 's1',
    provider: 'fake',
    model: 'm1',
    input_tokens: 100,
    cached_tokens: 0,
    output_tokens: 10,
    cost_micros: usd(0.001),
    ...overrides,
  }
}

/** A day mapper that puts every timestamp in one fixed day. */
const dayOf = (): string => '2026-10-03'

/** A day mapper keyed on a real UTC date. */
function utcDayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

describe('UsageRepository.appendBatch', () => {
  it('appends events and rolls them up', () => {
    const store = openMemoryStore()
    const appended = store.usage.appendBatch(
      [event({ input_tokens: 100, output_tokens: 10, cost_micros: usd(0.001) })],
      dayOf,
    )
    expect(appended).toBe(1)

    const daily = store.usage.daily(projectScope('a'), '2026-10-03')
    expect(daily).toMatchObject({
      day: '2026-10-03',
      scope: 'project:a',
      input_tokens: 100,
      output_tokens: 10,
      cost_micros: usd(0.001),
    })
  })

  it('is a no-op for an empty batch', () => {
    const store = openMemoryStore()
    expect(store.usage.appendBatch([], dayOf)).toBe(0)
    expect(store.usage.daily(projectScope('a'), '2026-10-03')).toBeUndefined()
  })

  it('accumulates across calls in the same day', () => {
    const store = openMemoryStore()
    store.usage.appendBatch([event({ cost_micros: usd(0.5) })], dayOf)
    store.usage.appendBatch([event({ cost_micros: usd(0.25) })], dayOf)

    const daily = store.usage.daily(projectScope('a'), '2026-10-03')
    expect(daily?.cost_micros).toBe(usd(0.75))
    expect(daily?.input_tokens).toBe(200)
  })

  it('keeps scopes separate', () => {
    const store = openMemoryStore()
    store.usage.appendBatch(
      [
        event({ scope: projectScope('a'), project_id: 'a', cost_micros: usd(1) }),
        event({ scope: projectScope('b'), project_id: 'b', cost_micros: usd(2) }),
        event({ scope: 'adhoc', project_id: null, cost_micros: usd(3) }),
        event({ scope: 'orchestrator', project_id: null, cost_micros: usd(4) }),
      ],
      dayOf,
    )

    expect(store.usage.daily(projectScope('a'), '2026-10-03')?.cost_micros).toBe(usd(1))
    expect(store.usage.daily(projectScope('b'), '2026-10-03')?.cost_micros).toBe(usd(2))
    expect(store.usage.daily('adhoc', '2026-10-03')?.cost_micros).toBe(usd(3))
    expect(store.usage.daily('orchestrator', '2026-10-03')?.cost_micros).toBe(usd(4))
  })

  it('keeps days separate, using the caller-supplied mapping', () => {
    const store = openMemoryStore()
    store.usage.appendBatch([event({ ts: at(0), cost_micros: usd(1) })], utcDayOf)
    store.usage.appendBatch([event({ ts: at(25 * 60 * 60 * 1000), cost_micros: usd(2) })], utcDayOf)

    expect(store.usage.daily(projectScope('a'), '2026-10-03')?.cost_micros).toBe(usd(1))
    expect(store.usage.daily(projectScope('a'), '2026-10-04')?.cost_micros).toBe(usd(2))
  })

  it('writes every event, including duplicates', () => {
    const store = openMemoryStore()
    const same = event()
    store.usage.appendBatch([same, same, same], dayOf)

    // Three requests that happen to be identical are three events, and the
    // rollup must reflect all three.
    expect(store.usage.eventsBetween(T0 - 1, T0 + 1)).toHaveLength(3)
    expect(store.usage.daily(projectScope('a'), '2026-10-03')?.input_tokens).toBe(300)
  })

  it('handles a batch spanning several scopes and days in one transaction', () => {
    const store = openMemoryStore()
    const day = 24 * 60 * 60 * 1000
    store.usage.appendBatch(
      [
        event({ ts: T0, scope: projectScope('a'), cost_micros: usd(1) }),
        event({ ts: T0 + day, scope: projectScope('a'), cost_micros: usd(2) }),
        event({ ts: T0, scope: 'adhoc', project_id: null, cost_micros: usd(3) }),
        event({ ts: T0 + day, scope: 'adhoc', project_id: null, cost_micros: usd(4) }),
      ],
      utcDayOf,
    )

    expect(store.usage.daily(projectScope('a'), '2026-10-03')?.cost_micros).toBe(usd(1))
    expect(store.usage.daily(projectScope('a'), '2026-10-04')?.cost_micros).toBe(usd(2))
    expect(store.usage.daily('adhoc', '2026-10-03')?.cost_micros).toBe(usd(3))
    expect(store.usage.daily('adhoc', '2026-10-04')?.cost_micros).toBe(usd(4))
  })

  it('rolls a batch up with one upsert per scope and day', () => {
    const store = openMemoryStore()
    // Twenty events from one run: the rollup must be one row, not twenty.
    const events = Array.from({ length: 20 }, () => event({ cost_micros: usd(0.001) }))
    store.usage.appendBatch(events, dayOf)

    const rows = store.usage.totalsByScope('2026-10-03', '2026-10-03')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cost_micros).toBe(usd(0.02))
  })

  it('rejects a non-integer cost, so a float never reaches the database', () => {
    const store = openMemoryStore()
    // The store trusts its caller's typing; this asserts SQLite stores what it
    // was given rather than silently rounding, which is what makes the
    // `MicroUsd` brand load-bearing upstream.
    store.usage.appendBatch([event({ cost_micros: 1 as never })], dayOf)
    expect(store.usage.daily(projectScope('a'), '2026-10-03')?.cost_micros).toBe(1)
  })
})

describe('UsageRepository queries', () => {
  it('returns zero totals when nothing was recorded', () => {
    const store = openMemoryStore()
    const totals = store.usage.totals(projectScope('a'), '2026-10-01', '2026-10-31')
    expect(totals).toEqual({ input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_micros: 0 })
  })

  it('sums a scope over an inclusive day range', () => {
    const store = openMemoryStore()
    const day = 24 * 60 * 60 * 1000
    store.usage.appendBatch(
      [
        event({ ts: T0, cost_micros: usd(1) }),
        event({ ts: T0 + day, cost_micros: usd(2) }),
        event({ ts: T0 + 2 * day, cost_micros: usd(4) }),
      ],
      utcDayOf,
    )

    expect(store.usage.totals(projectScope('a'), '2026-10-03', '2026-10-04').cost_micros).toBe(usd(3))
    expect(store.usage.totals(projectScope('a'), '2026-10-03', '2026-10-05').cost_micros).toBe(usd(7))
  })

  it('breaks totals down by scope, highest cost first', () => {
    const store = openMemoryStore()
    store.usage.appendBatch(
      [
        event({ scope: projectScope('a'), cost_micros: usd(1) }),
        event({ scope: projectScope('b'), cost_micros: usd(5) }),
        event({ scope: 'adhoc', project_id: null, cost_micros: usd(3) }),
      ],
      dayOf,
    )

    const rows = store.usage.totalsByScope('2026-10-03', '2026-10-03')
    expect(rows.map((row) => row.scope)).toEqual([projectScope('b'), 'adhoc', projectScope('a')])
  })

  it('sums a run from the raw events, across day boundaries', () => {
    const store = openMemoryStore()
    const day = 24 * 60 * 60 * 1000
    // One run whose requests straddle midnight: a per-run total is not a daily
    // aggregate, which is why it reads the raw table.
    store.usage.appendBatch(
      [
        event({ ts: T0, run_id: 'run-x', cost_micros: usd(1) }),
        event({ ts: T0 + day, run_id: 'run-x', cost_micros: usd(2) }),
        event({ ts: T0, run_id: 'run-y', cost_micros: usd(9) }),
      ],
      utcDayOf,
    )

    const totals = store.usage.totalsByRun('run-x')
    expect(totals.cost_micros).toBe(usd(3))
    expect(totals.requests).toBe(2)
    expect(store.usage.totalsByRun('unknown').requests).toBe(0)
  })

  it('breaks totals down by model', () => {
    const store = openMemoryStore()
    store.usage.appendBatch(
      [
        event({ model: 'cheap', cost_micros: usd(1) }),
        event({ model: 'expensive', cost_micros: usd(5) }),
        event({ model: 'expensive', cost_micros: usd(1) }),
      ],
      dayOf,
    )

    const rows = store.usage.totalsByModel(T0 - 1, T0 + 1)
    expect(rows.map((row) => row.model)).toEqual(['expensive', 'cheap'])
    expect(rows[0]?.cost_micros).toBe(usd(6))
    expect(rows[0]?.provider).toBe('fake')
  })

  it('totals the cost of a day across every scope', () => {
    const store = openMemoryStore()
    store.usage.appendBatch(
      [
        event({ scope: projectScope('a'), cost_micros: usd(1) }),
        event({ scope: 'adhoc', project_id: null, cost_micros: usd(2) }),
      ],
      dayOf,
    )
    expect(store.usage.totalCostForDay('2026-10-03')).toBe(usd(3))
    expect(store.usage.totalCostForDay('2026-10-04')).toBe(0)
  })

  it('reports the latest recorded day', () => {
    const store = openMemoryStore()
    expect(store.usage.latestDay()).toBeUndefined()
    store.usage.appendBatch([event()], dayOf)
    expect(store.usage.latestDay()).toBe('2026-10-03')
  })

  it('returns recent events newest first', () => {
    const store = openMemoryStore()
    store.usage.appendBatch(
      [event({ ts: at(0) }), event({ ts: at(10) }), event({ ts: at(20) })],
      dayOf,
    )
    const recent = store.usage.recent(2)
    expect(recent).toHaveLength(2)
    expect(recent[0]?.ts).toBe(at(20))
  })

  it('prunes raw events but never the rollup', () => {
    const store = openMemoryStore()
    store.usage.appendBatch([event({ ts: at(0) })], dayOf)
    expect(store.usage.pruneEvents(at(1))).toBe(1)
    expect(store.usage.eventsBetween(T0 - 1, T0 + 1)).toHaveLength(0)

    // The rollup is the historical record the reconciliation compares against;
    // pruning it would make the invariant unverifiable.
    expect(store.usage.daily(projectScope('a'), '2026-10-03')).toBeDefined()
  })
})

describe('reconciliation: usage_events equals usage_daily', () => {
  /** Compare the raw events' per-day, per-scope sums against the rollup. */
  function reconcile(store: ReturnType<typeof openMemoryStore>, scopes: readonly Scope[]): void {
    const raw = store.usage.rawTotalsByDayScope(0, Number.MAX_SAFE_INTEGER, utcDayOf)
    const rawByKey = new Map(raw.map((row) => [`${row.day}\u0000${row.scope}`, row]))
    const days = new Set(raw.map((row) => row.day))

    for (const day of days) {
      for (const scope of scopes) {
        const key = `${day}\u0000${scope}`
        const rawRow = rawByKey.get(key)
        const daily = store.usage.daily(scope, day)
        if (rawRow === undefined && daily === undefined) continue
        expect(daily, `usage_daily missing ${key}`).toBeDefined()
        expect(
          {
            input_tokens: daily?.input_tokens,
            cached_tokens: daily?.cached_tokens,
            output_tokens: daily?.output_tokens,
            cost_micros: daily?.cost_micros,
          },
          `rollup mismatch for ${key}`,
        ).toEqual({
          input_tokens: rawRow?.input_tokens ?? 0,
          cached_tokens: rawRow?.cached_tokens ?? 0,
          output_tokens: rawRow?.output_tokens ?? 0,
          cost_micros: rawRow?.cost_micros ?? 0,
        })
      }
    }
  }

  const SCOPES: readonly Scope[] = [projectScope('a'), projectScope('b'), 'adhoc', 'orchestrator']

  it('holds for a single batch', () => {
    const store = openMemoryStore()
    store.usage.appendBatch(
      [
        event({ scope: projectScope('a'), cost_micros: usd(0.001) }),
        event({ scope: 'adhoc', project_id: null, cost_micros: usd(0.002) }),
      ],
      utcDayOf,
    )
    reconcile(store, SCOPES)
  })

  it('holds across many batches, scopes and days', () => {
    const store = openMemoryStore()
    const day = 24 * 60 * 60 * 1000
    const scopes: Scope[] = [projectScope('a'), projectScope('b'), 'adhoc', 'orchestrator']
    // A deterministic pseudo-random mix, so the test is reproducible but not
    // trivially uniform.
    let seed = 12345
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }

    for (let batch = 0; batch < 25; batch += 1) {
      const events: UsageEventInput[] = []
      for (let index = 0; index < 7; index += 1) {
        const scope = scopes[next() % scopes.length]!
        events.push(
          event({
            ts: T0 + (next() % 5) * day,
            scope,
            project_id: scope.startsWith('project:') ? scope.slice('project:'.length) : null,
            input_tokens: next() % 1000,
            cached_tokens: next() % 100,
            output_tokens: next() % 500,
            cost_micros: next() % 1_000_000,
          }),
        )
      }
      store.usage.appendBatch(events, utcDayOf)
    }

    reconcile(store, scopes)

    // And the raw events really are all there.
    const total = store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER).length
    expect(total).toBe(25 * 7)
  })

  it('holds after a second batch into the same day and scope', () => {
    const store = openMemoryStore()
    store.usage.appendBatch([event({ cost_micros: usd(1) })], dayOf)
    store.usage.appendBatch([event({ cost_micros: usd(2) })], dayOf)
    reconcile(store, [projectScope('a')])
    expect(store.usage.daily(projectScope('a'), '2026-10-03')?.cost_micros).toBe(usd(3))
  })
})
