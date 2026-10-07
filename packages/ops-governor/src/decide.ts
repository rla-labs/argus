// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/governor/decide` — every decision the governor makes, as a pure
 * function.
 *
 * Each takes a snapshot and returns a verdict. No I/O, no clock beyond an
 * explicit `now`, no throwing for an expected outcome. The service is then a thin
 * adapter that reads state into a snapshot and acts on the verdict.
 *
 * **Fail closed.** Every uncertain path denies. An unparsable budget, an unknown
 * scope and a missing price all resolve to *no*, because admitting work by
 * accident spends money and denying it merely delays.
 *
 * @module @argus-agent/governor/decide
 */
import type { MicroUsd, ModelProblem, ModelRef, Scope } from '@argus-agent/types'
import {
  applicableScopes,
  effectiveLimit,
  slotsAllow,
  slotView,
  type BudgetLevel,
  type BudgetState,
  type GovernorSnapshot,
  type PendingRequest,
  type Period,
  type ScopeBudget,
} from './state.js'

/** Why a request was denied admission. */
export type RejectCode =
  | 'PANIC_MODE'
  | 'PROJECT_PAUSED'
  | 'BUDGET_EXCEEDED'
  | 'UNPRICED_MODEL'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_INVALID'
  | 'FREE_MODEL_UNCONFIRMED'
  | ModelProblem['code']

/** A rejection, with everything the caller needs to explain it. */
export interface Rejection {
  readonly code: RejectCode
  /** A human-readable message. */
  readonly message: string
  /** The scope that caused it, when one did. */
  readonly scope?: Scope
  /** The period that caused it, when a budget did. */
  readonly period?: Period
}

/** The verdict on one pending request. */
export type AdmissionVerdict =
  | { readonly kind: 'admit'; readonly attachToRun?: string }
  | { readonly kind: 'reject'; readonly rejection: Rejection }
  | { readonly kind: 'wait'; readonly blockedBy: string }

/** Options for {@link decideAdmission}. */
export interface AdmissionOptions {
  /** The provider/model rate gate, per the meter's windows. */
  readonly providerBlocked?: Readonly<Record<string, boolean>>
  /** A set of project ids that exist; a request for an unknown one is rejected. */
  readonly knownProjects?: ReadonlySet<string>
  /**
   * Projects whose file exists but does not validate, with the message to refuse
   * them with. Checked before `knownProjects`, so the operator is told what is
   * wrong with the file rather than that the project does not exist.
   */
  readonly invalidProjects?: ReadonlyMap<string, string>
  /** How a paused project treats an arriving request. */
  readonly pausedPolicy: 'keep' | 'reject'
}

/**
 * Decide one pending request's fate.
 *
 * The order of the checks is the specification, not an accident: panic is
 * absolute, a paused project is a policy decision about *this* request, a budget
 * is a hard fact, an unpriced model is a configuration gap, and only then does
 * capacity matter. Reversing budget and slots would report `NO_SLOT` for work
 * that could never run anyway.
 *
 * @param snapshot the state.
 * @param request the request.
 * @param options the extra inputs a snapshot does not carry.
 * @returns the verdict.
 */
export function decideAdmission(
  snapshot: GovernorSnapshot,
  request: PendingRequest,
  options: AdmissionOptions,
): AdmissionVerdict {
  // 1. Panic. Nothing runs, and the reason is not the request's fault.
  if (snapshot.panic) {
    return {
      kind: 'reject',
      rejection: {
        code: 'PANIC_MODE',
        message: 'panic mode is active; the system is not accepting work',
      },
    }
  }

  // 2. A project that does not exist. Rejecting beats leaving it pending
  //    forever, which is what an unresolvable target would otherwise do.
  if (request.target.kind === 'project') {
    const { projectId } = request.target
    const invalid = options.invalidProjects?.get(projectId)
    if (invalid !== undefined) {
      return { kind: 'reject', rejection: { code: 'PROJECT_INVALID', message: invalid } }
    }
    if (options.knownProjects !== undefined && !options.knownProjects.has(projectId)) {
      return {
        kind: 'reject',
        rejection: {
          code: 'PROJECT_NOT_FOUND',
          message: `no project "${projectId}" is configured`,
        },
      }
    }

    // 3. A paused project. A human's message is KEPT pending — a budget pause
    //    must not silently discard what someone typed, and an override lets it
    //    through. Unattended work is rejected, because its purpose is to run now
    //    and a rejection is the honest signal that it did not.
    if (snapshot.pausedProjects.has(projectId)) {
      if (options.pausedPolicy === 'reject' || request.priority !== 0) {
        return {
          kind: 'reject',
          rejection: {
            code: 'PROJECT_PAUSED',
            message:
              `project "${projectId}" is paused (budget); ` +
              'run /budget to raise the limit or /resume to continue',
            scope: `project:${projectId}` as Scope,
          },
        }
      }
      return { kind: 'wait', blockedBy: 'project_paused' }
    }
  }

  // 4. Budget. Any applicable scope at its hard limit denies the request, and
  //    the scope and period are reported so the operator knows WHICH budget.
  const budgetDenial = checkBudgets(snapshot, request)
  if (budgetDenial !== undefined) return { kind: 'reject', rejection: budgetDenial }

  // 5. The global interactive-only threshold. Above it, only a human's request
  //    runs; scheduled and background work waits rather than being rejected,
  //    because the condition is temporary.
  if (snapshot.globalInteractiveOnly && request.priority !== 0) {
    return { kind: 'wait', blockedBy: 'global_interactive_only' }
  }

  // 6a. A model that cannot run: no route for its provider, no API key, no price.
  //     The same checks make a project invalid at load; this catches the models
  //     that are not a project's (an ad-hoc task, the orchestrator) and a key
  //     removed since.
  const problem = snapshot.modelProblem?.(request.model)
  if (problem !== undefined) {
    return { kind: 'reject', rejection: { code: problem.code, message: problem.message } }
  }

  // 6. An unpriced model under the block policy.
  if (!snapshot.priced(request.model)) {
    return {
      kind: 'reject',
      rejection: {
        code: 'UNPRICED_MODEL',
        message:
          `no price for ${request.model.provider}/${request.model.model}; ` +
          'add it to the pricing table in ops.yaml',
      },
    }
  }

  // 6b. A free remote model the operator has not confirmed. Free remote models
  //     are usually rate-limited and may log what they are sent, and a zero
  //     price that is a typo would disable every budget — so it runs only once
  //     the operator has said yes.
  if (snapshot.freeUnconfirmed?.(request.model) === true) {
    const name = `${request.model.provider}/${request.model.model}`
    return {
      kind: 'reject',
      rejection: {
        code: 'FREE_MODEL_UNCONFIRMED',
        message:
          `${name} is priced at $0. Free remote models are often rate-limited and may log or ` +
          `train on what they are sent. To allow it, send /allow-free ${name}`,
      },
    }
  }

  // 7. Already running. Delivering into a live agent queues in its inbox and
  //    consumes no additional slot, so this is always allowed — and it must be
  //    checked before the slots, or a full queue would reject work that fits.
  const running = findRunningFor(snapshot, request)
  if (running !== undefined) return { kind: 'admit', attachToRun: running.runId }

  // 8. Capacity.
  const view = slotView(
    options.providerBlocked === undefined
      ? snapshot
      : { ...snapshot, providerBlocked: options.providerBlocked },
    request,
  )
  const slots = slotsAllow(view)
  if (!slots.allowed) return { kind: 'wait', blockedBy: slots.blockedBy ?? 'no_slot' }

  return { kind: 'admit' }
}

/** Find a running agent that a request would attach to. */
function findRunningFor(
  snapshot: GovernorSnapshot,
  request: PendingRequest,
): { readonly runId: string } | undefined {
  for (const agent of snapshot.running.values()) {
    if (request.target.kind === 'project') {
      if (agent.owner.kind === 'project' && agent.owner.projectId === request.target.projectId) {
        return { runId: agent.runId }
      }
    } else if (agent.owner.kind === 'adhoc' && agent.owner.runId === request.target.runId) {
      return { runId: agent.runId }
    }
  }
  return undefined
}

/**
 * The budget denial for a request, if any applicable scope is at its hard limit.
 *
 * @param snapshot the state.
 * @param request the request.
 * @returns the rejection, or `undefined` when every applicable budget passes.
 */
export function checkBudgets(
  snapshot: GovernorSnapshot,
  request: PendingRequest,
): Rejection | undefined {
  for (const scope of applicableScopes(request.target)) {
    const state = snapshot.budgets.get(scope)
    if (state === undefined) continue
    if (state.level === 'hard') {
      return {
        code: 'BUDGET_EXCEEDED',
        message:
          `the ${state.period} budget for ${scope} is exhausted ` +
          `(${state.spentMicros} of ${state.limitMicros} micro-USD); ` +
          'raise it with /budget or wait for the period to roll over',
        scope,
        period: state.period,
      }
    }
  }
  return undefined
}

// ── budget evaluation ──────────────────────────────────────────────────────

/** The threshold a budget has reached. */
export function levelOf(
  budget: ScopeBudget,
  now: number,
  thresholds: { readonly infoPct: number; readonly softPct: number },
): BudgetLevel {
  const limit = effectiveLimit(budget, now)
  if (limit === undefined) return 'ok'
  // A zero limit is exhausted at once: a scope limited to nothing must not admit
  // anything, and reporting `ok` for it would make a deliberate lockdown a no-op.
  if (limit <= 0) return 'hard'
  const pct = (budget.spentMicros / limit) * 100
  if (pct >= 100) return 'hard'
  if (pct >= thresholds.softPct) return 'soft'
  if (pct >= thresholds.infoPct) return 'info'
  return 'ok'
}

/** Evaluate one scope's budget into a state. */
export function evaluateBudget(
  budget: ScopeBudget,
  now: number,
  thresholds: { infoPct: number; softPct: number },
  options: { downgraded: boolean; hardAction: 'pause' | 'reject_new' },
): BudgetState {
  const limit = effectiveLimit(budget, now)
  const level = levelOf(budget, now, thresholds)
  return {
    scope: budget.scope,
    period: budget.period,
    level,
    pct: limit === undefined || limit === 0 ? undefined : (budget.spentMicros / limit) * 100,
    limitMicros: limit,
    spentMicros: budget.spentMicros,
    overrideMicros: budget.overrideMicros,
    overrideUntil: budget.overrideUntil,
    downgraded: options.downgraded && level !== 'ok',
    paused: level === 'hard' && options.hardAction === 'pause',
  }
}

/** A threshold crossing the service must announce, once per scope per period. */
export interface ThresholdAnnouncement {
  readonly scope: Scope
  readonly period: Period
  readonly level: Exclude<BudgetLevel, 'ok'>
  readonly pct: number
  readonly spentMicros: MicroUsd
  readonly limitMicros: MicroUsd
}

/**
 * The thresholds to announce, given what has already been announced.
 *
 * The `announced` set is keyed `scope|period|level`, so each level fires **once**
 * per scope per period. Without it, a budget sitting at 85% would emit a soft
 * event on every single model request.
 *
 * @param states the evaluated budgets.
 * @param announced the levels already announced, mutated in place.
 * @returns the announcements to emit.
 */
export function planThresholds(
  states: readonly BudgetState[],
  announced: Set<string>,
): ThresholdAnnouncement[] {
  const announcements: ThresholdAnnouncement[] = []
  for (const state of states) {
    if (state.level === 'ok') continue
    if (state.limitMicros === undefined) continue
    if (state.pct === undefined) continue

    // Every level at or below the reached one is announced, so a jump straight
    // from 40% to 95% still reports info, soft and hard in order — a listener
    // that only ever sees `hard` cannot tell whether the lower warnings fired.
    const reached: Exclude<BudgetLevel, 'ok'>[] =
      state.level === 'hard' ? ['info', 'soft', 'hard'] : state.level === 'soft' ? ['info', 'soft'] : ['info']

    for (const level of reached) {
      const key = `${state.scope}|${state.period}|${level}`
      if (announced.has(key)) continue
      announced.add(key)
      announcements.push({
        scope: state.scope,
        period: state.period,
        level,
        pct: state.pct,
        spentMicros: state.spentMicros,
        limitMicros: state.limitMicros,
      })
    }
  }
  return announcements
}

// ── step-level enforcement ─────────────────────────────────────────────────

/** Why a run was stopped at a step boundary. */
export type StopReason =
  | 'budget_stopped'
  | 'max_steps'
  | 'max_wallclock'
  | 'loop_detected'

/** What to do with a step. */
export type StepVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'reject'; readonly reason: StopReason; readonly detail: string }

/** The per-run facts a step decision reads. */
export interface RunView {
  readonly runId: string
  readonly steps: number
  readonly startedAt: number
  /** The most recent tool calls, oldest first, as `name\u0000arguments`. */
  readonly recentToolCalls: readonly string[]
  readonly budgetLevel: BudgetLevel
  /** The scope whose budget applies, for the detail message. */
  readonly budgetScope?: Scope
}

/** The limits a step decision enforces. */
export interface StepLimits {
  readonly maxSteps: number
  readonly maxWallclockMs: number
  readonly loopRepeatThreshold: number
}

/**
 * Decide whether a step may proceed.
 *
 * Read in this order so the *most specific* cause is reported: a run that both
 * ran out of budget and hit its step limit should say `budget_stopped`, because
 * that is what the operator can act on.
 *
 * @param run the run's facts.
 * @param limits the configured limits.
 * @param now the current time.
 * @returns the verdict.
 */
export function decideStep(run: RunView, limits: StepLimits, now: number): StepVerdict {
  if (run.budgetLevel === 'hard') {
    return {
      kind: 'reject',
      reason: 'budget_stopped',
      detail: `the ${run.budgetScope ?? 'applicable'} budget is exhausted`,
    }
  }

  if (run.steps >= limits.maxSteps) {
    return {
      kind: 'reject',
      reason: 'max_steps',
      detail: `the run reached its ${limits.maxSteps}-step limit`,
    }
  }

  const elapsed = now - run.startedAt
  if (elapsed >= limits.maxWallclockMs) {
    const minutes = Math.round(limits.maxWallclockMs / 60_000)
    return {
      kind: 'reject',
      reason: 'max_wallclock',
      detail: `the run exceeded its ${minutes}-minute wall-clock limit`,
    }
  }

  if (detectLoop(run.recentToolCalls, limits.loopRepeatThreshold)) {
    const last = run.recentToolCalls.at(-1)?.split('\u0000')[0] ?? 'a tool'
    return {
      kind: 'reject',
      reason: 'loop_detected',
      detail: `"${last}" repeated ${limits.loopRepeatThreshold} times with identical arguments`,
    }
  }

  return { kind: 'allow' }
}

/**
 * Whether the tail of a tool-call history is a loop.
 *
 * A loop is the **same tool name with byte-identical arguments** repeated
 * `threshold` times *consecutively*. Consecutive is the operative word: an agent
 * that reads a file, edits it, and reads it again is working, not looping — so a
 * non-consecutive repeat must not trip the detector.
 *
 * The key includes the arguments, so a tool called repeatedly with *different*
 * input (paging through results) never trips it.
 *
 * @param calls the recent calls, oldest first, keyed `name\u0000arguments`.
 * @param threshold how many consecutive identical calls count as a loop.
 * @returns whether a loop was detected.
 */
export function detectLoop(calls: readonly string[], threshold: number): boolean {
  if (threshold < 2 || calls.length < threshold) return false
  const tail = calls.at(-1)
  if (tail === undefined) return false
  for (let index = calls.length - 1; index >= calls.length - threshold; index -= 1) {
    if (calls[index] !== tail) return false
  }
  return true
}

/** Build the loop-detection key for a tool call. */
export function toolCallKey(name: string, args: unknown): string {
  return `${name}\u0000${stableStringify(args)}`
}

/**
 * Serialize a value with sorted keys, so two logically identical argument
 * objects produce the same key regardless of property order.
 *
 * @param value the value.
 * @returns a stable string.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

// ── downgrade ──────────────────────────────────────────────────────────────

/**
 * The model a request must use instead of its own, when its scope is downgraded.
 *
 * The downgrade is keyed by **project**, so a subagent inside a downgraded
 * project is downgraded too — its requests are the project's spending. An ad-hoc
 * task has no fallback configured, so it is never downgraded.
 *
 * @param downgradedOwners the owners marked downgraded.
 * @param projectId the project the request belongs to.
 * @param fallback the project's configured fallback, if any.
 * @returns the model to use, or `undefined` to keep the request's own.
 */
export function decideDowngrade(
  downgradedOwners: ReadonlySet<string>,
  projectId: string | undefined,
  fallback: ModelRef | undefined,
): ModelRef | undefined {
  if (fallback === undefined || projectId === undefined) return undefined
  return downgradedOwners.has(`project:${projectId}`) ? fallback : undefined
}

/** Whether a project is marked downgraded. */
export function isDowngraded(
  downgradedOwners: ReadonlySet<string>,
  projectId: string,
): boolean {
  return downgradedOwners.has(`project:${projectId}`)
}

// ── queue stalling ─────────────────────────────────────────────────────────

/**
 * The pending requests that have waited too long.
 *
 * @param pending the pending requests.
 * @param now the current time.
 * @param stallMs how long is too long.
 * @param alreadyReported ids already reported, mutated in place.
 * @returns the requests to report.
 */
export function planStalled(
  pending: readonly PendingRequest[],
  now: number,
  stallMs: number,
  alreadyReported: Set<string>,
): PendingRequest[] {
  const stalled: PendingRequest[] = []
  for (const request of pending) {
    if (alreadyReported.has(request.id)) continue
    if (now - request.submittedAt < stallMs) continue
    alreadyReported.add(request.id)
    stalled.push(request)
  }
  return stalled
}
