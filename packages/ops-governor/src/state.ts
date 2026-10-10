// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/governor/state` — the snapshot the decisions read, and the pure
 * reducers over it.
 *
 * Nothing here touches dsh, the store or the clock. A snapshot is built by the
 * service and handed to a pure function, which returns a decision. That split is
 * what makes the money-critical logic testable exhaustively.
 *
 * @module @argus-agent/governor/state
 */
import {
  MICROS_PER_USD,
  type MicroUsd,
  type ModelProblem,
  type ModelRef,
  type Owner,
  type Priority,
  type Scope,
} from '@argus-agent/types'
import type { BudgetRow, RunStatus } from '@argus-agent/store'

/** Which budget period is being evaluated. */
export type Period = 'day' | 'month'

/** One scope's budget, resolved from configuration and the store. */
export interface ScopeBudget {
  readonly scope: Scope
  readonly period: Period
  /** The limit, or `undefined` for an unlimited scope. */
  readonly limitMicros: MicroUsd | undefined
  /** What has been spent so far, from the meter. */
  readonly spentMicros: MicroUsd
  /** Extra headroom granted by an override, in micro-USD. */
  readonly overrideMicros: MicroUsd
  /** When the override expires, epoch ms; `undefined` never expires. */
  readonly overrideUntil: number | undefined
}

/** The threshold levels, in escalating order. */
export type BudgetLevel = 'ok' | 'info' | 'soft' | 'hard'

/** One scope's evaluated budget state. */
export interface BudgetState {
  readonly scope: Scope
  readonly period: Period
  readonly level: BudgetLevel
  /** Percentage used, or `undefined` when the scope is unlimited. */
  readonly pct: number | undefined
  readonly limitMicros: MicroUsd | undefined
  readonly spentMicros: MicroUsd
  readonly overrideMicros: MicroUsd
  readonly overrideUntil: number | undefined
  /** Whether the scope has been marked downgraded by its soft action. */
  readonly downgraded: boolean
  /** Whether the hard action is `pause` rather than `reject_new`. */
  readonly paused: boolean
}

/** One request waiting to be admitted. */
export interface PendingRequest {
  readonly id: string
  readonly priority: Priority
  readonly source: 'channel' | 'scheduler' | 'orchestrator' | 'project'
  readonly target:
    | { readonly kind: 'project'; readonly projectId: string }
    | { readonly kind: 'adhoc'; readonly runId: string; readonly model?: ModelRef }
  /** The provider the target will use. */
  readonly provider: string
  /** The model the target will use. */
  readonly model: ModelRef
  /** When it was submitted, epoch ms. */
  readonly submittedAt: number
}

/** One running agent, as the slot accounting sees it. */
export interface RunningAgent {
  readonly sessionId: string
  readonly owner: Owner
  readonly runId: string
  readonly provider: string
  readonly targetKind: 'project' | 'adhoc' | 'orchestrator'
  readonly startedAt: number
}

/** The whole governor state a decision may read. */
export interface GovernorSnapshot {
  /** Whether panic mode is on. A panic stops all dispatch. */
  readonly panic: boolean
  /** Whether the global budget has crossed its interactive-only threshold. */
  readonly globalInteractiveOnly: boolean
  /** The running agents, by session id. */
  readonly running: ReadonlyMap<string, RunningAgent>
  readonly config: {
    readonly globalMaxRunning: number
    readonly perProvider: Readonly<Record<string, number>>
    readonly adhocMaxRunning: number
    readonly reserveInteractive: number
  }
  /** Whether a provider's token rate window is exhausted. */
  readonly providerBlocked: Readonly<Record<string, boolean>>
  /** Project ids that are paused. */
  readonly pausedProjects: ReadonlySet<string>
  /** Owners whose scope is downgraded at the soft threshold. */
  readonly downgradedOwners: ReadonlySet<string>
  /** The budget state per scope, already evaluated. */
  readonly budgets: ReadonlyMap<Scope, BudgetState>
  /** Whether a model has a price, by `provider/model`. */
  readonly priced: (model: ModelRef) => boolean
  /**
   * Whether a model is free, remote and not yet confirmed by the operator.
   * Optional so a snapshot built without a meter treats every model as confirmed.
   */
  readonly freeUnconfirmed?: (model: ModelRef) => boolean
  /**
   * Why a model cannot run (no provider, no API key, no price), from the checks
   * registered on `ops-projects`. Optional so a snapshot without them runs every model.
   */
  readonly modelProblem?: (model: ModelRef) => ModelProblem | undefined
}

/** A request's own target identity, as a scope. */
export function scopeOfTarget(target: PendingRequest['target']): Scope {
  return target.kind === 'project' ? (`project:${target.projectId}` as Scope) : 'adhoc'
}

/**
 * The scopes that apply to a request.
 *
 * A project run is checked against `global` and its own scope; an ad-hoc task
 * against `global` and `adhoc`. The global scope is what stops one runaway
 * project from spending the whole system's money.
 *
 * @param target the request's target.
 * @returns the applicable scopes, most specific first.
 */
export function applicableScopes(target: PendingRequest['target']): Scope[] {
  return target.kind === 'project'
    ? [`project:${target.projectId}` as Scope, 'global']
    : ['adhoc', 'global']
}

/** Count running agents of one kind. */
export function countRunning(snapshot: GovernorSnapshot, kind: RunningAgent['targetKind']): number {
  let count = 0
  for (const agent of snapshot.running.values()) {
    if (agent.targetKind === kind) count += 1
  }
  return count
}

/** Count running agents for one provider. */
export function countRunningForProvider(snapshot: GovernorSnapshot, provider: string): number {
  let count = 0
  for (const agent of snapshot.running.values()) {
    if (agent.provider === provider) count += 1
  }
  return count
}

/** The slot situation a decision reasons about. */
export interface SlotView {
  readonly globalUsed: number
  readonly globalLimit: number
  /** The limit actually applicable to this request's priority. */
  readonly globalEffectiveLimit: number
  readonly providerUsed: number
  readonly providerLimit: number | undefined
  readonly adhocUsed: number
  /**
   * The ad-hoc ceiling, or `undefined` when it does not apply.
   *
   * It applies only to an ad-hoc request: the ad-hoc pool is a separate group, so
   * a full one must not block project work. Reporting it as a limit that always
   * applies was a real bug — a project request was refused because an unrelated
   * ad-hoc task was running.
   */
  readonly adhocLimit: number | undefined
  readonly providerBlocked: boolean
}

/**
 * Compute the slot view for a request.
 *
 * **The interactive reservation.** A request of priority 1 or 2 may use at most
 * `global_max_running - reserve_interactive` slots. Priority 0 — a human waiting
 * on a reply — may use all of them. The reservation is expressed as a *limit*
 * rather than a lock, so a scheduled job never takes a slot a person needs.
 *
 * @param snapshot the state.
 * @param request the request being considered.
 * @returns the slots it faces.
 */
export function slotView(snapshot: GovernorSnapshot, request: PendingRequest): SlotView {
  const { config } = snapshot
  const globalUsed = snapshot.running.size
  // Reserved slots are unavailable to scheduled and background work only.
  const globalEffectiveLimit =
    request.priority === 0
      ? config.globalMaxRunning
      : Math.max(0, config.globalMaxRunning - config.reserveInteractive)

  return {
    globalUsed,
    globalLimit: config.globalMaxRunning,
    globalEffectiveLimit,
    providerUsed: countRunningForProvider(snapshot, request.provider),
    providerLimit: config.perProvider[request.provider],
    adhocUsed: countRunning(snapshot, 'adhoc'),
    // Only an ad-hoc request is subject to the ad-hoc pool.
    adhocLimit: request.target.kind === 'adhoc' ? config.adhocMaxRunning : undefined,
    providerBlocked: snapshot.providerBlocked[request.provider] === true,
  }
}

/**
 * Whether a request fits the available slots.
 *
 * Every check is a hard ceiling; the first one that fails is reported. The
 * `blockedBy` field is what the caller turns into a `NO_SLOT` reason, and it
 * names **which** limit applied — a queue that says only "no slot" is
 * undiagnosable.
 *
 * @param view the slot view.
 * @returns whether it fits, and what blocked it.
 */
export function slotsAllow(view: SlotView): { readonly allowed: boolean; readonly blockedBy?: string } {
  if (view.providerBlocked) return { allowed: false, blockedBy: 'provider_rate_limit' }
  if (view.globalUsed >= view.globalEffectiveLimit) {
    return {
      allowed: false,
      blockedBy:
        view.globalEffectiveLimit < view.globalLimit ? 'global_slots_reserved' : 'global_slots_full',
    }
  }
  if (view.providerLimit !== undefined && view.providerUsed >= view.providerLimit) {
    return { allowed: false, blockedBy: `provider_slots_full:${view.providerLimit}` }
  }
  if (view.adhocLimit !== undefined && view.adhocUsed >= view.adhocLimit) {
    return { allowed: false, blockedBy: 'adhoc_slots_full' }
  }
  return { allowed: true }
}

/** Apply an override's extra headroom, when it is still live. */
export function effectiveLimit(budget: ScopeBudget, now: number): MicroUsd | undefined {
  const live =
    budget.overrideMicros > 0 &&
    (budget.overrideUntil === undefined || budget.overrideUntil > now)
  return budget.limitMicros === undefined
    ? undefined
    : ((budget.limitMicros + (live ? budget.overrideMicros : 0)) as MicroUsd)
}

/** Whether an override is still in force. */
export function overrideActive(budget: ScopeBudget, now: number): boolean {
  return (
    budget.overrideMicros > 0 &&
    (budget.overrideUntil === undefined || budget.overrideUntil > now)
  )
}

/**
 * Convert USD to micro-USD, exactly.
 *
 * @param amountUsd a dollar amount, possibly fractional.
 * @returns integer micro-USD.
 */
export function usdToMicros(amountUsd: number): MicroUsd {
  return Math.round(amountUsd * MICROS_PER_USD) as MicroUsd
}

/** A stored budget row's period. */
export type StoredPeriod = BudgetRow['period']

/** A terminal status a run can be moved to. */
export type TerminalRunStatus = Exclude<RunStatus, 'running'>
