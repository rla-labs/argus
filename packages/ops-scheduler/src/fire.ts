// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/scheduler/fire` — the decision to fire, skip, or do nothing.
 *
 * Pure, because the interesting cases are the ones that are hard to reproduce:
 * an overlapping run, a paused project, a task mid-flight. A function of a
 * snapshot can be tested exhaustively; a function that reads a store and a
 * governor can only be tested by arranging the world.
 *
 * @module @argus-agent/scheduler/fire
 */
/** Why a due schedule did not submit work. */
export type SkipReason = 'overlap' | 'paused' | 'disabled' | 'budget' | 'no_project' | 'invalid_project' | 'error'

/** What the store and the governor say about one schedule, at one instant. */
export interface FireSnapshot {
  /** The schedule's id. */
  readonly id: string
  /** Whether the schedule is enabled. */
  readonly enabled: boolean
  /** The project the schedule targets, when it targets one. */
  readonly projectId: string | null
  /** The last request this schedule submitted, if any. */
  readonly lastRequestId: string | null
  /** The request ids the governor still holds (pending or running). */
  readonly liveRequestIds: ReadonlySet<string>
  /** The projects that are paused. */
  readonly pausedProjects: ReadonlySet<string>
}

/** What to do about one due schedule. */
export type FireDecision =
  | { readonly action: 'submit' }
  | { readonly action: 'skip'; readonly reason: SkipReason; readonly detail?: string }

/**
 * Decide whether a due schedule submits its work.
 *
 * The order matters, and it is the order of cost: the cheapest and most definite
 * refusals come first, so a schedule that cannot run does not touch the governor.
 *
 * 1. **Disabled** — the operator turned it off.
 * 2. **Overlap** — the previous run is still pending or running. Checked through
 *    the **governor's own set** rather than a local flag, because a local flag is
 *    lost on restart and a restart is exactly when a double-run is most likely.
 * 3. **Paused** — the project is paused (usually for budget). Firing would be
 *    refused by the governor anyway, and the skip is recorded here so the operator
 *    sees *why* rather than seeing nothing.
 * 4. Otherwise, submit.
 *
 * @param snapshot what is known about the schedule.
 * @returns the decision.
 */
export function decideFiring(snapshot: FireSnapshot): FireDecision {
  if (!snapshot.enabled) {
    return { action: 'skip', reason: 'disabled' }
  }

  if (snapshot.lastRequestId !== null && snapshot.liveRequestIds.has(snapshot.lastRequestId)) {
    // The previous firing is still in the system. Running again would put two
    // copies of a periodic task in flight at once.
    return {
      action: 'skip',
      reason: 'overlap',
      detail: `the previous run (${snapshot.lastRequestId}) is still pending or running`,
    }
  }

  if (snapshot.projectId !== null && snapshot.pausedProjects.has(snapshot.projectId)) {
    return { action: 'skip', reason: 'paused', detail: `project ${snapshot.projectId} is paused` }
  }

  return { action: 'submit' }
}

/**
 * Classify a submission failure into a skip reason.
 *
 * A refused submission is not a scheduler bug: the governor refusing a paused or
 * over-budget scope is the system working. Classifying it lets the notice say which
 * rather than reporting every refusal as an error.
 *
 * @param error the thrown error.
 * @returns the reason.
 */
export function skipReasonOf(error: unknown): SkipReason {
  // Matched as a string, not through the typed code map: `PROJECT_PAUSED` is a
  // governor *rejection* code and is deliberately not in that map, because a pause
  // is a policy decision about one request rather than a system error.
  const code = (error as { readonly code?: unknown } | undefined)?.code
  switch (code) {
    case 'PROJECT_PAUSED':
      return 'paused'
    case 'BUDGET_EXCEEDED':
      return 'budget'
    case 'PROJECT_NOT_FOUND':
    case 'PROJECT_NOT_ACTIVE':
      return 'no_project'
    case 'PROJECT_INVALID':
      return 'invalid_project'
    default:
      return 'error'
  }
}

/**
 * Whether a skip is worth telling the operator about.
 *
 * **`overlap` is not.** A schedule that fires every five minutes while its work
 * takes ten will overlap every other time, and a notification each time would train
 * the operator to ignore the channel — which makes the notifications that matter
 * useless. It is recorded and logged, not sent.
 *
 * @param reason the skip reason.
 * @returns whether to notify.
 */
export function isNoteworthySkip(reason: SkipReason): boolean {
  return reason !== 'overlap'
}

/** A human sentence for a skip. */
export function skipText(reason: SkipReason, detail?: string): string {
  const because = detail === undefined ? '' : ` (${detail})`
  switch (reason) {
    case 'overlap':
      return `skipped: the previous run is still in progress${because}`
    case 'paused':
      return `skipped: the project is paused${because}`
    case 'disabled':
      return 'skipped: the schedule is disabled'
    case 'budget':
      return `skipped: the budget is exhausted${because}`
    case 'no_project':
      return `skipped: the project no longer exists${because}`
    case 'invalid_project':
      return `skipped: the project's file does not validate${because}`
    case 'error':
      return `skipped: the submission failed${because}`
  }
}
