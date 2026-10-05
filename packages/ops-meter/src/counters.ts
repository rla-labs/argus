// == ARGUS AGENT PROJECT ==
/**
 * In-memory counters.
 *
 * The governor asks "has this scope crossed its limit?" on **every step**, so the
 * answer must not be a database query. The counters hold the current day's and
 * month's totals per scope, seeded from `usage_daily` at startup and advanced as
 * usage arrives.
 *
 * They are an *optimization over* the durable record, never a replacement for
 * it: `usage_daily` is authoritative, and a restart reseeds from it.
 *
 * @module @argus-agent/meter/counters
 */
import type { MicroUsd, Scope } from '@argus-agent/types'

/** Running totals for one scope. */
export interface ScopeCounters {
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  costMicros: number
  /** How many model requests have been counted, for diagnostics. */
  requests: number
}

/** An empty counter set. */
function empty(): ScopeCounters {
  return { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costMicros: 0, requests: 0 }
}

/** One scope's totals, as a caller reads them. */
export interface ScopeTotals {
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
  readonly costMicros: MicroUsd
  readonly requests: number
}

/** The bucket a counter belongs to. */
export type Period = 'day' | 'month'

/**
 * Counters keyed by period, day-or-month label, and scope.
 *
 * The label is an opaque string (`2026-10-03` or `2026-10`), so the map holds
 * one bucket per current period and the boundary logic lives in `TimezoneCalendar`.
 */
export class Counters {
  private readonly buckets = new Map<string, Map<Scope, ScopeCounters>>()
  /** Per-run totals, so a run's cost is available without a query. */
  private readonly runs = new Map<string, ScopeCounters>()

  private key(period: Period, label: string): string {
    return `${period}\u0000${label}`
  }

  /**
   * Add usage to a bucket.
   *
   * @param period the bucket period.
   * @param label the day (`YYYY-MM-DD`) or month (`YYYY-MM`) label.
   * @param scope the accounting scope.
   * @param delta the usage to add.
   */
  add(
    period: Period,
    label: string,
    scope: Scope,
    delta: {
      inputTokens: number
      cachedTokens: number
      outputTokens: number
      costMicros: number
    },
  ): void {
    const bucket = this.buckets.get(this.key(period, label)) ?? new Map<Scope, ScopeCounters>()
    const counters = bucket.get(scope) ?? empty()
    counters.inputTokens += delta.inputTokens
    counters.cachedTokens += delta.cachedTokens
    counters.outputTokens += delta.outputTokens
    counters.costMicros += delta.costMicros
    counters.requests += 1
    bucket.set(scope, counters)
    this.buckets.set(this.key(period, label), bucket)
  }

  /**
   * Record usage against a run as well as a scope.
   * @param runId the run.
   * @param delta the usage.
   */
  addToRun(
    runId: string,
    delta: { inputTokens: number; cachedTokens: number; outputTokens: number; costMicros: number },
  ): void {
    const counters = this.runs.get(runId) ?? empty()
    counters.inputTokens += delta.inputTokens
    counters.cachedTokens += delta.cachedTokens
    counters.outputTokens += delta.outputTokens
    counters.costMicros += delta.costMicros
    counters.requests += 1
    this.runs.set(runId, counters)
  }

  /**
   * Read a scope's totals for a period label.
   * @param period the period.
   * @param label the label.
   * @param scope the scope.
   * @returns the totals; zeros when nothing was counted.
   */
  get(period: Period, label: string, scope: Scope): ScopeTotals {
    const counters = this.buckets.get(this.key(period, label))?.get(scope)
    return counters === undefined
      ? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costMicros: 0 as MicroUsd, requests: 0 }
      : {
          inputTokens: counters.inputTokens,
          cachedTokens: counters.cachedTokens,
          outputTokens: counters.outputTokens,
          costMicros: counters.costMicros as MicroUsd,
          requests: counters.requests,
        }
  }

  /**
   * Read a run's totals.
   * @param runId the run.
   * @returns the totals; zeros when nothing was counted.
   */
  getRun(runId: string): ScopeTotals {
    const counters = this.runs.get(runId)
    return counters === undefined
      ? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costMicros: 0 as MicroUsd, requests: 0 }
      : {
          inputTokens: counters.inputTokens,
          cachedTokens: counters.cachedTokens,
          outputTokens: counters.outputTokens,
          costMicros: counters.costMicros as MicroUsd,
          requests: counters.requests,
        }
  }

  /**
   * Seed a bucket from the durable record.
   *
   * Called at startup for the current day and month, so a restart does not reset
   * a budget to zero and let a project spend its limit twice.
   *
   * @param period the period.
   * @param label the label.
   * @param scope the scope.
   * @param totals the totals to seed.
   */
  seed(
    period: Period,
    label: string,
    scope: Scope,
    totals: { inputTokens: number; cachedTokens: number; outputTokens: number; costMicros: number },
  ): void {
    const bucket = this.buckets.get(this.key(period, label)) ?? new Map<Scope, ScopeCounters>()
    // Seeding replaces rather than adds: it is the authoritative starting point,
    // not an increment.
    bucket.set(scope, {
      inputTokens: totals.inputTokens,
      cachedTokens: totals.cachedTokens,
      outputTokens: totals.outputTokens,
      costMicros: totals.costMicros,
      requests: 0,
    })
    this.buckets.set(this.key(period, label), bucket)
  }

  /**
   * Drop every bucket except the current period labels.
   *
   * Called at a boundary: yesterday's counters are dead weight, and keeping them
   * would grow the map without bound across a long uptime.
   *
   * @param keep the labels to retain.
   */
  retain(keep: { day: string; month: string }): void {
    // The snapshot is required: deleting from the map during iteration is not
    // defined behavior, so the keys are collected first.
    const keys = Array.from(this.buckets.keys())
    for (const key of keys) {
      const separator = key.indexOf('\u0000')
      const period = key.slice(0, separator) as Period
      const label = key.slice(separator + 1)
      const wanted = period === 'day' ? keep.day : keep.month
      if (label !== wanted) this.buckets.delete(key)
    }
  }

  /**
   * Forget a run's counters.
   *
   * Called when a run finishes. Without it the map would grow by one entry per
   * run for the life of the process.
   *
   * @param runId the run.
   */
  forgetRun(runId: string): void {
    this.runs.delete(runId)
  }

  /** Every scope with a bucket for a period label. For diagnostics. */
  scopesFor(period: Period, label: string): Scope[] {
    const bucket = this.buckets.get(this.key(period, label))
    return bucket === undefined ? [] : Array.from(bucket.keys())
  }

  /** Drop everything. Used on unload and between tests. */
  clear(): void {
    this.buckets.clear()
    this.runs.clear()
  }
}
