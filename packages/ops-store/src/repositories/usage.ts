// == ARGUS AGENT PROJECT ==
/**
 * The `usage_events` / `usage_daily` repository.
 *
 * Usage is the money trail, so this repository owns the store's most important
 * invariant: **the sum of `usage_events` for a scope and day equals
 * `usage_daily`**. Both writes happen in one transaction, which is what makes
 * the reconciliation test pass rather than nearly pass.
 *
 * @module @argus-agent/store/repositories/usage
 */
import type { MicroUsd, Scope } from '@argus-agent/types'
import type { DatabaseHandle } from '../connection.js'
import type { UsageDailyRow, UsageEventInput, UsageEventRow, UsageTotals } from '../types.js'

/** One scope's day rollup, as it is added. */
export interface DailyDelta {
  readonly scope: Scope
  readonly input_tokens: number
  readonly cached_tokens: number
  readonly output_tokens: number
  readonly cost_micros: number
}

/** A per-scope breakdown, for reporting. */
export interface ScopeTotals extends UsageTotals {
  readonly scope: Scope
}

/** A per-model breakdown, for reporting. */
export interface ModelTotals extends UsageTotals {
  readonly model: string
  readonly provider: string
}

/** The `usage` repository. */
export class UsageRepository {
  private readonly insertEventStmt
  private readonly upsertDailyStmt
  private readonly dailyStmt
  private readonly rangeStmt
  private readonly byScopeRangeStmt
  private readonly byRunStmt
  private readonly byModelRangeStmt
  private readonly eventsForDayStmt
  private readonly recentEventsStmt
  private readonly pruneStmt
  private readonly pruneDailyStmt

  constructor(private readonly db: DatabaseHandle) {
    this.insertEventStmt = db.prepare(`
      INSERT INTO usage_events
        (ts, run_id, project_id, scope, root_session, session_id, provider, model,
         input_tokens, cached_tokens, output_tokens, cost_micros)
      VALUES
        (@ts, @run_id, @project_id, @scope, @root_session, @session_id, @provider, @model,
         @input_tokens, @cached_tokens, @output_tokens, @cost_micros)
    `)
    // Incremental rollup. Adding in SQL keeps the arithmetic integral, so no
    // float ever touches a stored total.
    this.upsertDailyStmt = db.prepare(`
      INSERT INTO usage_daily (day, scope, input_tokens, cached_tokens, output_tokens, cost_micros)
      VALUES (@day, @scope, @input_tokens, @cached_tokens, @output_tokens, @cost_micros)
      ON CONFLICT(day, scope) DO UPDATE SET
        input_tokens  = usage_daily.input_tokens  + excluded.input_tokens,
        cached_tokens = usage_daily.cached_tokens + excluded.cached_tokens,
        output_tokens = usage_daily.output_tokens + excluded.output_tokens,
        cost_micros   = usage_daily.cost_micros   + excluded.cost_micros
    `)
    this.dailyStmt = db.prepare('SELECT * FROM usage_daily WHERE scope = ? AND day = ?')
    this.rangeStmt = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0)  AS input_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_micros), 0)   AS cost_micros
      FROM usage_daily
      WHERE scope = ? AND day >= ? AND day <= ?
    `)
    this.byScopeRangeStmt = db.prepare(`
      SELECT
        scope,
        COALESCE(SUM(input_tokens), 0)  AS input_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_micros), 0)   AS cost_micros
      FROM usage_daily
      WHERE day >= ? AND day <= ?
      GROUP BY scope
      ORDER BY cost_micros DESC
    `)
    this.byRunStmt = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0)  AS input_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_micros), 0)   AS cost_micros,
        COUNT(*)                        AS requests
      FROM usage_events
      WHERE run_id = ?
    `)
    this.byModelRangeStmt = db.prepare(`
      SELECT
        provider, model,
        COALESCE(SUM(input_tokens), 0)  AS input_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_micros), 0)   AS cost_micros
      FROM usage_events
      WHERE ts >= ? AND ts < ?
      GROUP BY provider, model
      ORDER BY cost_micros DESC
    `)
    this.eventsForDayStmt = db.prepare(
      'SELECT * FROM usage_events WHERE ts >= ? AND ts < ? ORDER BY ts',
    )
    this.recentEventsStmt = db.prepare('SELECT * FROM usage_events ORDER BY id DESC LIMIT ?')
    this.pruneStmt = db.prepare('DELETE FROM usage_events WHERE ts < ?')
    this.pruneDailyStmt = db.prepare('DELETE FROM usage_daily WHERE day < ?')
  }

  /**
   * Append a batch of usage events and roll them up, in one transaction.
   *
   * Either every event and every rollup lands, or none does. A partial batch
   * would break the reconciliation invariant permanently, because the raw event
   * would exist without its total — or worse, the total without its event.
   *
   * @param events the events to append.
   * @param dayOf maps an event's timestamp to its `YYYY-MM-DD` in the configured
   *   timezone. The store never interprets a date itself: the timezone is a
   *   meter concern, and passing the mapping in keeps it out of SQL.
   * @returns the number of events appended.
   */
  appendBatch(events: readonly UsageEventInput[], dayOf: (ts: number) => string): number {
    if (events.length === 0) return 0

    // Accumulate per (day, scope) in memory first, so one batch with 20 events
    // from the same run performs one upsert rather than twenty.
    const deltas = new Map<string, { day: string; delta: DailyDelta }>()
    for (const event of events) {
      const day = dayOf(event.ts)
      const key = `${day}\u0000${event.scope}`
      const existing = deltas.get(key)
      if (existing) {
        deltas.set(key, {
          day,
          delta: {
            scope: event.scope,
            input_tokens: existing.delta.input_tokens + event.input_tokens,
            cached_tokens: existing.delta.cached_tokens + event.cached_tokens,
            output_tokens: existing.delta.output_tokens + event.output_tokens,
            cost_micros: existing.delta.cost_micros + event.cost_micros,
          },
        })
      } else {
        deltas.set(key, {
          day,
          delta: {
            scope: event.scope,
            input_tokens: event.input_tokens,
            cached_tokens: event.cached_tokens,
            output_tokens: event.output_tokens,
            cost_micros: event.cost_micros,
          },
        })
      }
    }

    const run = this.db.transaction(() => {
      for (const event of events) {
        this.insertEventStmt.run({
          ts: event.ts,
          run_id: event.run_id,
          project_id: event.project_id,
          scope: event.scope,
          root_session: event.root_session,
          session_id: event.session_id,
          provider: event.provider,
          model: event.model,
          input_tokens: event.input_tokens,
          cached_tokens: event.cached_tokens,
          output_tokens: event.output_tokens,
          cost_micros: event.cost_micros,
        })
      }
      for (const { day, delta } of deltas.values()) {
        this.upsertDailyStmt.run({
          day,
          scope: delta.scope,
          input_tokens: delta.input_tokens,
          cached_tokens: delta.cached_tokens,
          output_tokens: delta.output_tokens,
          cost_micros: delta.cost_micros,
        })
      }
    })
    run()
    return events.length
  }

  /**
   * One scope's totals for one day.
   * @param scope the scope.
   * @param day `YYYY-MM-DD`.
   * @returns the row, or `undefined` when nothing was recorded.
   */
  daily(scope: Scope, day: string): UsageDailyRow | undefined {
    return this.dailyStmt.get(scope, day) as UsageDailyRow | undefined
  }

  /**
   * One scope's totals over a day range, inclusive.
   * @param scope the scope.
   * @param fromDay the first day.
   * @param toDay the last day.
   * @returns the totals; zeros when nothing was recorded.
   */
  totals(scope: Scope, fromDay: string, toDay: string): UsageTotals {
    return this.rangeStmt.get(scope, fromDay, toDay) as UsageTotals
  }

  /**
   * Every scope's totals over a day range, highest cost first.
   * @param fromDay the first day.
   * @param toDay the last day.
   * @returns the per-scope rows.
   */
  totalsByScope(fromDay: string, toDay: string): ScopeTotals[] {
    return this.byScopeRangeStmt.all(fromDay, toDay) as ScopeTotals[]
  }

  /**
   * One run's totals, from the raw events.
   *
   * Read from `usage_events` rather than a rollup because a run can span a day
   * boundary, and a per-run total is not a daily aggregate.
   *
   * @param runId the run id.
   * @returns the totals and the request count.
   */
  totalsByRun(runId: string): UsageTotals & { requests: number } {
    return this.byRunStmt.get(runId) as UsageTotals & { requests: number }
  }

  /**
   * Totals per model over a time range.
   * @param fromTs inclusive start, epoch ms.
   * @param toTsExclusive exclusive end, epoch ms.
   * @returns the per-model rows, highest cost first.
   */
  totalsByModel(fromTs: number, toTsExclusive: number): ModelTotals[] {
    return this.byModelRangeStmt.all(fromTs, toTsExclusive) as ModelTotals[]
  }

  /**
   * The raw events in a time range.
   * @param fromTs inclusive start, epoch ms.
   * @param toTsExclusive exclusive end, epoch ms.
   * @returns the rows, oldest first.
   */
  eventsBetween(fromTs: number, toTsExclusive: number): UsageEventRow[] {
    return this.eventsForDayStmt.all(fromTs, toTsExclusive) as UsageEventRow[]
  }

  /**
   * The most recent events.
   * @param limit the maximum number to return.
   * @returns the rows, newest first.
   */
  recent(limit = 100): UsageEventRow[] {
    return this.recentEventsStmt.all(limit) as UsageEventRow[]
  }

  /**
   * Sum the raw events per scope over a day range.
   *
   * This is the reconciliation counterpart to {@link totalsByScope}: it reads
   * the raw table, so comparing the two detects a rollup that drifted.
   *
   * @param fromTs inclusive start, epoch ms.
   * @param toTsExclusive exclusive end, epoch ms.
   * @returns the per-scope raw sums.
   */
  rawTotalsByScope(fromTs: number, toTsExclusive: number): ScopeTotals[] {
    const rows = this.db
      .prepare(
        `SELECT scope,
                COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_micros), 0)   AS cost_micros
         FROM usage_events
         WHERE ts >= ? AND ts < ?
         GROUP BY scope
         ORDER BY scope`,
      )
      .all(fromTs, toTsExclusive) as ScopeTotals[]
    return rows
  }

  /**
   * Sum the raw events per (day, scope) over a time range.
   *
   * The exact reconciliation query: it groups the raw table the way
   * `usage_daily` groups it, so the two are directly comparable.
   *
   * @param fromTs inclusive start, epoch ms.
   * @param toTsExclusive exclusive end, epoch ms.
   * @param dayOf maps a timestamp to its day string.
   * @returns the per-day, per-scope raw sums.
   */
  rawTotalsByDayScope(
    fromTs: number,
    toTsExclusive: number,
    dayOf: (ts: number) => string,
  ): Array<DailyDelta & { day: string }> {
    // The accumulator is mutable on purpose: it is built up event by event and
    // then returned as the immutable `DailyDelta` shape.
    type MutableDelta = { -readonly [K in keyof DailyDelta]: DailyDelta[K] } & { day: string }
    const accumulated = new Map<string, MutableDelta>()
    for (const event of this.eventsBetween(fromTs, toTsExclusive)) {
      const day = dayOf(event.ts)
      const key = `${day}\u0000${event.scope}`
      const existing = accumulated.get(key)
      if (existing) {
        existing.input_tokens += event.input_tokens
        existing.cached_tokens += event.cached_tokens
        existing.output_tokens += event.output_tokens
        existing.cost_micros += event.cost_micros
      } else {
        accumulated.set(key, {
          day,
          scope: event.scope,
          input_tokens: event.input_tokens,
          cached_tokens: event.cached_tokens,
          output_tokens: event.output_tokens,
          cost_micros: event.cost_micros,
        })
      }
    }
    return [...accumulated.values()].sort((a, b) =>
      a.day === b.day ? a.scope.localeCompare(b.scope) : a.day.localeCompare(b.day),
    )
  }

  /**
   * Delete raw events older than a cutoff.
   *
   * **Never** call this on `usage_daily`: the rollup is the historical record
   * the reconciliation test compares against.
   *
   * @param olderThanTs the cutoff, epoch ms.
   * @returns the number of rows deleted.
   */
  pruneEvents(olderThanTs: number): number {
    return this.pruneStmt.run(olderThanTs).changes
  }

  /**
   * The most recent day recorded, for a diagnostic.
   * @returns `YYYY-MM-DD`, or `undefined` when nothing is recorded.
   */
  latestDay(): string | undefined {
    const row = this.db.prepare('SELECT MAX(day) AS day FROM usage_daily').get() as { day: string | null }
    return row.day ?? undefined
  }

  /**
   * Total cost across every scope for a day.
   * @param day `YYYY-MM-DD`.
   * @returns the cost in micro-USD.
   */
  totalCostForDay(day: string): MicroUsd {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_micros), 0) AS cost FROM usage_daily WHERE day = ?')
      .get(day) as { cost: number }
    return row.cost as MicroUsd
  }
}
