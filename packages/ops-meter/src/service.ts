// == ARGUS AGENT PROJECT ==
/**
 * `ctx.opsMeter` — real-time token and cost accounting.
 *
 * It listens to every model request in the process, attributes it to exactly one
 * owner, prices it from `usage.yaml`'s table, and records it durably. The
 * counters it maintains are what the governor checks on every step.
 *
 * @module @argus-agent/meter/service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { RequestMessage, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  OpsError,
  formatModelRef,
  isOwnerScope,
  scopeOfOwner,
  type ContentBlockLike,
  type MicroUsd,
  type ModelRef,
  type Owner,
  type Scope,
} from '@argus-agent/types'
import type { OpsStore, UsageEventInput } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import { Counters, type Period } from './counters.js'
// `priceRequest` is the only runtime helper needed here; the classes are used
// purely as types, so they are imported type-only and the plugin entry owns the
// concrete construction.
import { isFree, priceRequest, type Price, type PriceTable, type ResolvedPrice } from './pricing.js'
import type { RateLimiter, TokenRateWindow } from './rate-window.js'
import type { TimezoneCalendar } from './time.js'

/** What the meter needs to attribute and persist one request. */
/** Where the confirmed free remote models are recorded. */
const FREE_CONFIRMED_KEY = 'pricing.free_confirmed'

export interface RecordInput {
  readonly sessionId: string
  readonly rootSessionId: string
  readonly owner: Owner
  readonly model: ModelRef
  readonly usage: TokenUsage
  readonly runId: string | undefined
  readonly ts: number
}

/** A snapshot of one scope's spending. */
export interface ScopeSpending {
  readonly scope: Scope
  readonly day: string
  readonly month: string
  readonly dayMicros: MicroUsd
  readonly monthMicros: MicroUsd
  readonly dayTotals: ReturnType<Counters['get']>
  readonly monthTotals: ReturnType<Counters['get']>
}

/** Options for the meter service. */
export interface MeterOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly calendar: TimezoneCalendar
  readonly prices: PriceTable
  readonly rateLimiter: RateLimiter
  /** How many events to buffer before flushing. */
  readonly flushThreshold: number
  /** How often to flush, in milliseconds. */
  readonly flushIntervalMs: number
  /** Reads the current time; injected so tests control it. */
  readonly now: () => number
  /** Fetch whatever a model's price still needs (an OpenRouter provider ceiling). */
  readonly ensurePriced?: (model: ModelRef) => Promise<void>
}

/** What a flush did. */
export interface FlushReport {
  readonly events: number
  readonly ok: boolean
}

/**
 * The meter.
 *
 * Exposed as `ctx.opsMeter`.
 */
export class OpsMeter {
  private readonly counters = new Counters()
  private readonly pending: UsageEventInput[] = []
  private currentDay: string
  private currentMonth: string
  private flushTimer: ReturnType<typeof setInterval> | undefined
  private degraded = false
  private droppedEvents = 0
  /**
   * The model each session's most recent request used, from its `request/header`
   * events.
   *
   * The header is tracked as it is logged rather than read back with
   * `session.requestHeader()` at assistant-message time, because the fold can be
   * empty when no header event has been appended — an adapter that does not
   * report a header leaves the model unknown. Tracking the event is the
   * authoritative path.
   */
  private readonly sessionModels = new Map<string, ModelRef>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly options: MeterOptions,
  ) {
    const now = this.options.now()
    this.currentDay = this.options.calendar.dayOf(now)
    this.currentMonth = this.options.calendar.monthOf(now)
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Seed the counters from the durable record and start the flush timer.
   *
   * Seeding is what makes a restart safe: without it, a project that had spent
   * its daily budget would get the whole limit again on every restart.
   *
   * @param scopes the scopes to seed; defaults to every scope the store knows.
   */
  start(scopes?: readonly Scope[]): void {
    const now = this.options.now()
    this.seedScope('global', now)
    for (const scope of scopes ?? []) this.seedScope(scope, now)

    const handledScopes = new Set<Scope>(['global', ...(scopes ?? [])])
    for (const row of this.options.store.usage.totalsByScope(
      this.currentDay,
      this.currentDay,
    )) {
      if (!handledScopes.has(row.scope)) this.seedScope(row.scope, now)
    }

    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.options.flushIntervalMs)
    // Do not hold the process open for a flush timer.
    this.flushTimer.unref?.()
  }

  /**
   * Seed one scope's day and month counters from the store.
   *
   * The `global` scope is special: it is an aggregate the meter computes, and no
   * `usage_daily` row exists for it. Seeding it from a per-scope query would
   * return zeros and silently reset the global budget on every restart, so it is
   * summed across every recorded scope instead.
   */
  private seedScope(scope: Scope, now: number): void {
    const day = this.options.calendar.dayOf(now)
    const month = this.options.calendar.monthOf(now)
    const monthStart = this.options.calendar.monthStart(now)

    const dayTotals =
      scope === 'global' ? this.aggregate(monthStart, day) : this.options.store.usage.totals(scope, day, day)
    this.counters.seed('day', day, scope, {
      inputTokens: dayTotals.input_tokens,
      cachedTokens: dayTotals.cached_tokens,
      outputTokens: dayTotals.output_tokens,
      costMicros: dayTotals.cost_micros,
    })

    const monthTotals =
      scope === 'global'
        ? this.aggregate(monthStart, day)
        : this.options.store.usage.totals(scope, monthStart, day)
    this.counters.seed('month', month, scope, {
      inputTokens: monthTotals.input_tokens,
      cachedTokens: monthTotals.cached_tokens,
      outputTokens: monthTotals.output_tokens,
      costMicros: monthTotals.cost_micros,
    })
  }

  /**
   * Sum every recorded scope over a day range.
   *
   * @param fromDay the first day, inclusive.
   * @param toDay the last day, inclusive.
   * @returns the summed totals.
   */
  private aggregate(
    fromDay: string,
    toDay: string,
  ): { input_tokens: number; cached_tokens: number; output_tokens: number; cost_micros: MicroUsd } {
    let input = 0
    let cached = 0
    let output = 0
    let cost = 0
    for (const row of this.options.store.usage.totalsByScope(fromDay, toDay)) {
      // `global` never has a row of its own, but skipping it is defensive: if a
      // future migration ever wrote one, counting it would double the total.
      if (row.scope === ('global' as Scope)) continue
      input += row.input_tokens
      cached += row.cached_tokens
      output += row.output_tokens
      cost += row.cost_micros
    }
    return {
      input_tokens: input,
      cached_tokens: cached,
      output_tokens: output,
      cost_micros: cost as MicroUsd,
    }
  }

  /**
   * Roll the counters when a day or month boundary passes.
   *
   * Called on every recorded request rather than by a timer, so a process that
   * was asleep across midnight rolls on its next request instead of on the next
   * tick — which may be hours later.
   *
   * @param now the current time.
   * @returns whether a boundary was crossed.
   */
  rollIfNeeded(now: number): boolean {
    const day = this.options.calendar.dayOf(now)
    const month = this.options.calendar.monthOf(now)
    if (day === this.currentDay && month === this.currentMonth) return false

    const previousDay = this.currentDay
    const previousMonth = this.currentMonth
    this.currentDay = day
    this.currentMonth = month
    this.counters.retain({ day, month })

    this.ctx.emit('ops/day-rollover', {
      previousDay,
      day,
      ...(previousMonth !== month ? { previousMonth, month } : {}),
    })
    return true
  }

  // ── accounting ───────────────────────────────────────────────────────────

  /**
   * Price and record one model request.
   *
   * @param input what to attribute and how much it used.
   * @returns the cost, or `undefined` when the model is unpriced under the
   *   `warn` policy (in which case the request is still recorded, at zero).
   * @throws {OpsError} `UNPRICED_MODEL` when the model has no price and the
   *   policy is `block`. The caller — the governor — refuses the request.
   */
  record(input: RecordInput): MicroUsd | undefined {
    this.rollIfNeeded(input.ts)

    const price = this.options.prices.resolve(input.model)
    if (price === undefined) {
      this.ctx.emit('ops/unpriced-model', { model: formatModelRef(input.model) })
      if (this.options.prices.unknownPolicy === 'block') {
        throw new OpsError(
          'UNPRICED_MODEL',
          `no price for ${formatModelRef(input.model)}; add it to the pricing table in ops.yaml ` +
            'or set unknown_model_policy: warn to account it at zero',
          { provider: input.model.provider, model: input.model.model },
        )
      }
    }

    const counts = {
      inputTokens: input.usage.inputTokens,
      cachedTokens: input.usage.cacheReadTokens ?? 0,
      outputTokens: input.usage.outputTokens,
    }
    const costMicros =
      price === undefined
        ? (0 as MicroUsd)
        : priceRequest(price, { ...counts, cacheWriteTokens: input.usage.cacheWriteTokens ?? 0 })

    // Counters first: they are what a budget check reads, and a budget must not
    // be able to spend past its limit because a durable write is buffered.
    const scope = scopeOfOwner(input.owner)
    const day = this.options.calendar.dayOf(input.ts)
    const month = this.options.calendar.monthOf(input.ts)
    const delta = { ...counts, costMicros }

    this.counters.add('day', day, scope, delta)
    this.counters.add('month', month, scope, delta)
    // The global scope is checked but never a run's own scope, so it is counted
    // separately: every request contributes to it.
    if (scope !== 'global') {
      this.counters.add('day', day, 'global', delta)
      this.counters.add('month', month, 'global', delta)
    }
    if (input.runId !== undefined) {
      this.counters.addToRun(input.runId, delta)
      this.options.rateLimiter.for(input.model.provider).record(
        counts.inputTokens + counts.outputTokens,
        input.ts,
      )
    }

    this.buffer({
      ts: input.ts,
      run_id: input.runId ?? null,
      project_id: input.owner.kind === 'project' ? input.owner.projectId : null,
      scope,
      root_session: input.rootSessionId,
      session_id: input.sessionId,
      provider: input.model.provider,
      model: input.model.model,
      input_tokens: counts.inputTokens,
      cached_tokens: counts.cachedTokens,
      output_tokens: counts.outputTokens,
      cost_micros: costMicros,
    })

    this.ctx.emit('ops/usage', {
      owner: input.owner,
      scope,
      scopeMicros: this.counters.get('day', day, scope).costMicros,
      globalMicros: this.counters.get('day', day, 'global').costMicros,
      runId: input.runId,
      deltaMicros: costMicros,
      deltaTokens: counts.inputTokens + counts.outputTokens,
    })

    return costMicros
  }

  /** Add an event to the buffer, flushing when the threshold is reached. */
  private buffer(event: UsageEventInput): void {
    this.pending.push(event)
    if (this.pending.length >= this.options.flushThreshold) void this.flush()
  }

  /**
   * Write the buffered events to the store.
   *
   * A failure does **not** drop them: they stay buffered and the meter reports
   * itself degraded. Losing a batch would break the reconciliation invariant
   * permanently, so retrying is the only correct response.
   *
   * @returns what the flush did.
   */
  async flush(): Promise<FlushReport> {
    if (this.pending.length === 0) return { events: 0, ok: true }
    const batch = this.pending.slice()
    try {
      const written = this.options.store.usage.appendBatch(batch, (ts) =>
        this.options.calendar.dayOf(ts),
      )
      // Only remove what was written; an event appended during the write must
      // survive.
      this.pending.splice(0, batch.length)
      if (this.degraded) {
        this.degraded = false
        this.ctx.emit('ops/meter-recovered')
      }
      return { events: written, ok: true }
    } catch (error) {
      this.degraded = true
      this.droppedEvents = 0
      this.ctx.logger('ops-meter').error(
        'could not write %d usage event(s), keeping them buffered: %s',
        batch.length,
        (error as Error).message,
      )
      this.ctx.emit('ops/meter-degraded', {
        pending: this.pending.length,
        error: (error as Error).message,
      })
      return { events: 0, ok: false }
    }
  }

  // ── query ────────────────────────────────────────────────────────────────

  /**
   * A scope's current spending, from the counters.
   *
   * This is the call the governor makes on every step, so it must not touch the
   * database.
   *
   * @param scope the scope.
   * @returns the day and month totals.
   */
  spending(scope: Scope): ScopeSpending {
    const now = this.options.now()
    const day = this.options.calendar.dayOf(now)
    const month = this.options.calendar.monthOf(now)
    const dayTotals = this.counters.get('day', day, scope)
    const monthTotals = this.counters.get('month', month, scope)
    return {
      scope,
      day,
      month,
      dayMicros: dayTotals.costMicros,
      monthMicros: monthTotals.costMicros,
      dayTotals,
      monthTotals,
    }
  }

  /**
   * The current spending for a period and scope, in micro-USD.
   * @param period `day` or `month`.
   * @param scope the scope.
   * @returns the cost.
   */
  spent(period: Period, scope: Scope): MicroUsd {
    const { day, month } = this.currentLabels()
    return this.counters.get(period, period === 'day' ? day : month, scope).costMicros
  }

  /**
   * A run's cost so far.
   * @param runId the run.
   * @returns the totals, or zeros for an unknown run.
   */
  runTotals(runId: string): ReturnType<Counters['getRun']> {
    return this.counters.getRun(runId)
  }

  /**
   * Forget a finished run's counters.
   * @param runId the run.
   */
  forgetRun(runId: string): void {
    this.counters.forgetRun(runId)
  }

  /**
   * Note the model a session's next request will use.
   *
   * @param sessionId the session.
   * @param model the resolved model.
   */
  noteModel(sessionId: string, model: ModelRef): void {
    this.sessionModels.set(sessionId, model)
  }

  /**
   * The last noted model for a session.
   * @param sessionId the session.
   * @returns the model, or `undefined` when no header was seen.
   */
  modelOf(sessionId: string): ModelRef | undefined {
    return this.sessionModels.get(sessionId)
  }

  /**
   * Forget a session's model.
   * @param sessionId the session.
   */
  forgetSession(sessionId: string): void {
    this.sessionModels.delete(sessionId)
  }

  /**
   * The rate window for a provider.
   * @param provider the provider route.
   * @returns the window.
   */
  rateWindow(provider: string): TokenRateWindow {
    return this.options.rateLimiter.for(provider)
  }

  /**
   * A usage report over a day range, from the durable record.
   *
   * Reads the store rather than the counters: a report is about history, and the
   * counters only hold the current period.
   *
   * @param options the range and grouping.
   * @returns the report.
   */
  report(options: {
    fromDay: string
    toDay: string
    scope?: Scope
  }): {
    readonly fromDay: string
    readonly toDay: string
    readonly byScope: ReturnType<OpsStore['usage']['totalsByScope']>
    readonly totalMicros: MicroUsd
    readonly days: number
  } {
    const byScope = this.options.store.usage.totalsByScope(options.fromDay, options.toDay)
    const filtered =
      options.scope === undefined ? byScope : byScope.filter((row) => row.scope === options.scope)
    const totalMicros = filtered.reduce((sum, row) => sum + row.cost_micros, 0) as MicroUsd
    return {
      fromDay: options.fromDay,
      toDay: options.toDay,
      byScope: filtered,
      totalMicros,
      days: 0,
    }
  }

  /**
   * Fetch what a model's price still needs before its first request: for an
   * OpenRouter model, the highest price among its providers. `/new` and `/model`
   * await it, so a new model is never charged at the lower listed price. Never throws.
   *
   * @param model the model.
   */
  ensurePriced(model: ModelRef): Promise<void> {
    return this.options.ensurePriced?.(model) ?? Promise.resolve()
  }

  /**
   * Whether a model has a price in the configured table.
   *
   * The governor asks this before admitting a request, so an unpriced model is
   * refused **before** a provider is called — not after, which is when the meter
   * would otherwise notice.
   *
   * @param model the model.
   * @returns whether an entry applies.
   */
  isPriced(model: ModelRef): boolean {
    return this.options.prices.isPriced(model)
  }

  /** Where the price catalog came from and when it was retrieved. */
  get catalogInfo(): { title: string; license: string; retrievedAt: string } | undefined {
    return this.options.prices.catalogInfo
  }

  /** How an unpriced model is treated: `block` refuses it, `warn` runs it at zero. */
  get unknownPolicy(): 'block' | 'warn' {
    return this.options.prices.unknownPolicy
  }

  /**
   * A model's price and where it came from, for `/new`, `/model` and diagnostics.
   * @param model the model.
   * @returns the resolved price, or `undefined` when nothing prices it.
   */
  priceOf(model: ModelRef): ResolvedPrice | undefined {
    return this.options.prices.resolve(model)
  }

  // ── free models ──────────────────────────────────────────────────────────
  //
  // A remote model priced at zero — an OpenRouter `:free` variant, or a 0 typed
  // into ops.yaml — runs only once the operator has said so. Free remote models
  // are usually rate-limited and may log or train on what they are sent, and a 0
  // that is a typo would silently disable every budget. A LOCAL provider's zero
  // is expected and needs nothing.

  /**
   * Whether a model is free, remote, and not yet confirmed by the operator.
   * @param model the model.
   * @returns whether the governor must refuse it until confirmed.
   */
  needsFreeConfirmation(model: ModelRef): boolean {
    const price = this.options.prices.resolve(model)
    if (price === undefined || price.source === 'local' || !isFree(price)) return false
    return !this.confirmedFree().includes(formatModelRef(model))
  }

  /**
   * Record the operator's confirmation that a free remote model may run.
   * @param model the model.
   * @param actor who confirmed, for the audit log.
   */
  confirmFree(model: ModelRef, actor: string): void {
    const key = formatModelRef(model)
    const confirmed = this.confirmedFree()
    if (confirmed.includes(key)) return
    const now = this.options.now()
    this.options.store.runtimeState.set(FREE_CONFIRMED_KEY, [...confirmed, key].sort(), now)
    this.options.store.audit.record({ actor, action: 'pricing.free-confirmed', target: key }, now)
  }

  /** Every free remote model the operator has confirmed, as `provider/model`. */
  confirmedFree(): string[] {
    return this.options.store.runtimeState.get<string[]>(FREE_CONFIRMED_KEY) ?? []
  }

  /**
   * A per-model breakdown over a day range, from the durable record.
   *
   * Read from the raw events rather than the rollup, because the rollup is keyed
   * by scope and day and has no model dimension — and because a per-model REQUEST
   * COUNT is what an operator actually asks about ("what is making these calls?"),
   * which no `SUM` over a rollup can produce.
   *
   * @param options the range and the scope to filter to.
   * @returns one row per model, most expensive first.
   */
  reportByModel(options: {
    fromDay: string
    toDay: string
    scope?: Scope
  }): Array<{
    readonly provider: string
    readonly model: string
    readonly cost_micros: MicroUsd
    readonly requests: number
    readonly input_tokens: number
    readonly output_tokens: number
  }> {
    // The range is a pair of day labels; the events are keyed by epoch ms. A day
    // boundary is inclusive at both ends, so the end is the day AFTER the last
    // one, exclusive.
    const fromTs = Date.parse(`${options.fromDay}T00:00:00Z`)
    const toTs = Date.parse(`${options.toDay}T00:00:00Z`) + 24 * 60 * 60 * 1000
    const rows = new Map<
      string,
      { provider: string; model: string; cost_micros: number; requests: number; input_tokens: number; output_tokens: number }
    >()
    for (const event of this.options.store.usage.eventsBetween(fromTs, toTs)) {
      if (options.scope !== undefined && event.scope !== options.scope) continue
      const key = `${event.provider}/${event.model}`
      const row = rows.get(key) ?? {
        provider: event.provider,
        model: event.model,
        cost_micros: 0,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
      }
      row.cost_micros += event.cost_micros
      row.requests += 1
      row.input_tokens += event.input_tokens + event.cached_tokens
      row.output_tokens += event.output_tokens
      rows.set(key, row)
    }
    return [...rows.values()]
      .map((row) => ({ ...row, cost_micros: row.cost_micros as MicroUsd }))
      .sort((a, b) => b.cost_micros - a.cost_micros)
  }

  /**
   * Whether the meter has unwritten events.
   * @returns whether a flush is needed.
   */
  get isDegraded(): boolean {
    return this.degraded
  }

  /** Whether the meter has been stopped, so a listener should ignore events. */
  get isStopped(): boolean {
    return this.disposed
  }

  /** How many events are buffered. */
  get pendingCount(): number {
    return this.pending.length
  }

  /** How many events have been dropped. Always 0: the meter retries rather than dropping. */
  get dropped(): number {
    return this.droppedEvents
  }

  /** A health summary. */
  health(): { status: 'ok' | 'degraded' | 'down'; details: Record<string, unknown> } {
    if (this.disposed) return { status: 'down', details: { reason: 'disposed' } }
    const pending = this.pending.length
    return {
      status: this.degraded ? 'degraded' : 'ok',
      details: { pending, day: this.currentDay, month: this.currentMonth },
    }
  }

  /** The current period labels. */
  currentLabels(): { day: string; month: string } {
    return { day: this.currentDay, month: this.currentMonth }
  }

  /** Stop the flush timer and write what is buffered. */
  async stop(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.sessionModels.clear()
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer)
    this.flushTimer = undefined
    await this.flush()
  }

  // ── attribution helpers ──────────────────────────────────────────────────

  /**
   * Whether a session's own scope is one the meter records.
   *
   * A session that resolves to `global` is not one the meter files: `global` is
   * the synthetic aggregate scope, and no owner maps to it.
   *
   * @param scope the scope.
   * @returns whether it is an owner scope.
   */
  static isRecordable(scope: Scope): boolean {
    return isOwnerScope(scope)
  }

  /**
   * The total tokens a request's messages are expected to cost.
   *
   * Used for the rate-limit pre-check, before the response exists. The estimate
   * is a character count over four, which is the conventional approximation and
   * deliberately conservative: over-estimating delays a request, under-estimating
   * trips the provider's limit.
   *
   * @param messages the request's messages.
   * @param maxTokens the output cap, when one is set.
   * @returns the estimated token count.
   */
  static estimateTokens(messages: readonly RequestMessage[], maxTokens?: number): number {
    let characters = 0
    for (const message of messages) {
      characters += estimateMessageCharacters(message.content)
    }
    return Math.ceil(characters / 4) + (maxTokens ?? 0)
  }
}

/** Count the characters of a message's content, including structured blocks. */
function estimateMessageCharacters(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((sum: number, block: unknown) => {
    if (block === null || typeof block !== 'object') return sum
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      return sum + record['text'].length
    }
    if (record['type'] === 'tool-result') return sum + JSON.stringify(record).length
    // Any other block is counted by its serialized size, which is an upper bound.
    return sum + JSON.stringify(record).length
  }, 0)
}

/** The content-block type, re-exported so a listener can name it. */
export type { ContentBlockLike, Session, Price }
