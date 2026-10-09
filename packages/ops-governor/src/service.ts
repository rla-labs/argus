// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/governor/service` — `ctx.opsGovernor`.
 *
 * The service reads state into a snapshot, hands it to a pure decision, and acts
 * on the verdict. It owns the serialized dispatcher, the budget bookkeeping, the
 * step-level enforcement and the kill switch.
 *
 * @module @argus-agent/governor/service
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  formatModelRef,
  projectOwner,
  scopeOfOwner,
  type ContentBlockLike,
  type MicroUsd,
  type ModelRef,
  type Owner,
  type Priority,
  type Scope,
  type ServiceHealth,
} from '@argus-agent/types'
import type { InboundRow, OpsStore, RunRow } from '@argus-agent/store'
import { invalidMessage, type AgentTarget, type OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '@argus-agent/meter'
import {
  checkBudgets,
  decideAdmission,
  evaluateBudget,
  decideStep,
  planStalled,
  planThresholds,
  toolCallKey,
  type RejectCode,
  type StopReason,
} from './decide.js'
import {
  applicableScopes,
  countRunning,
  effectiveLimit,
  overrideActive,
  usdToMicros,
  type BudgetLevel,
  type BudgetState,
  type GovernorSnapshot,
  type PendingRequest,
  type Period,
  type RunningAgent,
  type ScopeBudget,
} from './state.js'
import type { GovernorConfig } from './config.js'

/** What `submit` accepts. */
export interface SubmitRequest {
  readonly source: 'channel' | 'scheduler' | 'orchestrator'
  readonly target:
    | { readonly projectId: string }
    | { readonly adhoc: { readonly runId: string; readonly model?: ModelRef } }
  readonly content: readonly ContentBlockLike[]
  readonly priority: Priority
  readonly replyTo?: unknown
  /** The model an ad-hoc task should use; projects use their configuration. */
  readonly model?: ModelRef
}

/** One pending request, as `status()` reports it. */
export interface PendingInfo {
  readonly requestId: string
  readonly projectId: string | null
  readonly priority: Priority
  readonly submittedAt: number
  readonly blockedBy: string | undefined
}

/** One running agent, as `status()` reports it. */
export interface RunInfo {
  readonly runId: string
  readonly owner: Owner
  readonly sessionId: string
  readonly provider: string
  readonly steps: number
  readonly startedAt: number
}

/** The slot summary. */
export interface SlotInfo {
  readonly globalUsed: number
  readonly globalLimit: number
  readonly reserved: number
  readonly adhocUsed: number
  readonly adhocLimit: number
  readonly pending: number
}

/** The whole status. */
export interface GovernorStatus {
  readonly panic: boolean
  readonly running: readonly RunInfo[]
  readonly pending: readonly PendingInfo[]
  readonly slots: SlotInfo
  readonly budgets: readonly BudgetState[]
}

/** Options for the service. */
export interface GovernorOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly config: GovernorConfig
  /** The delivery capability, claimed by the plugin entry. */
  readonly capability: unknown
  /** Reads the current time; injected so tests control it. */
  readonly now: () => number
}

/** Per-run bookkeeping the governor keeps in memory. */
interface RunTrack {
  readonly runId: string
  readonly owner: Owner
  readonly sessionId: string
  readonly provider: string
  readonly model: ModelRef
  readonly startedAt: number
  steps: number
  /** Recent tool calls, oldest first, keyed `name\u0000arguments`. */
  recentToolCalls: string[]
  /**
   * The most recent tool call's name and raw arguments.
   *
   * Kept separately from {@link recentToolCalls}, which stores a *key* for loop
   * detection and is therefore useless to anything that needs to inspect what was
   * actually requested. `ops-approvals-bridge` needs exactly that: dsh's approval
   * event carries the tool name but not its arguments, so the allowlist can only be
   * matched against what this observed.
   */
  lastToolCall: { name: string; args: unknown } | undefined
  /** Set when a step was rejected, so the terminal status is known at idle. */
  pendingStop: { reason: StopReason; detail: string } | undefined
  /** Whether the downgrade was already audited for this run. */
  downgradeAudited: boolean
  /** The request this run serves, when it came from the queue. */
  requestId: string | undefined
}

/**
 * The governor.
 *
 * Exposed as `ctx.opsGovernor`.
 */
export class OpsGovernor {
  /** The running agents, by session id. */
  private readonly running = new Map<string, RunTrack>()
  /** The last blocked reason per pending request, for `ops/queue-stalled`. */
  private readonly blockedBy = new Map<string, string>()
  /** Threshold levels already announced, keyed `scope|period|level`. */
  private readonly announced = new Set<string>()
  /** Requests already reported as stalled. */
  private stalledReported = new Set<string>()
  /** Owners whose soft action downgraded them. */
  private readonly downgraded = new Set<Scope>()
  /** Projects whose downgrade was already audited while no run was open. */
  private readonly downgradeAudited = new Set<string>()
  /** Whether panic mode is on. Persisted in `runtime_state`. */
  private panicMode = false
  /** The dispatch loop's serialization chain. */
  private dispatching: Promise<void> = Promise.resolve()
  /** Whether a dispatch pass is queued but not yet run. */
  private dispatchQueued = false
  private ticker: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly options: GovernorOptions,
  ) {}

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Restore panic mode, mark interrupted runs, and dispatch what is pending. */
  recover(): { readonly interrupted: number } {
    this.panicMode = this.options.store.runtimeState.get<boolean>('governor.panic') ?? false

    const interrupted = this.options.store.runs.markRunningInterrupted(this.options.now())
    for (const run of interrupted) {
      this.ctx.emit('ops/run-interrupted', { runId: run.id, owner: ownerOfRun(run) })
    }

    this.ticker = setInterval(() => {
      void this.tick()
    }, this.options.config.queues.tick_seconds * 1_000)
    this.ticker.unref?.()

    return { interrupted: interrupted.length }
  }

  /** A safety tick: re-evaluate thresholds and dispatch, in case an event was missed. */
  private async tick(): Promise<void> {
    if (this.disposed) return
    this.recomputeThresholds()
    this.requestDispatch()
  }

  // ── submission ───────────────────────────────────────────────────────────

  /**
   * The only way to ask for execution.
   *
   * Writes the request to `inbound` as `pending` **before** anything may run, so
   * a crash between submission and admission leaves the request recoverable
   * rather than lost. Returns immediately; the outcome arrives through events.
   *
   * @param request what to run.
   * @returns the request id.
   * @throws {OpsError} `PROJECT_PAUSED` when the target project is not usable.
   */
  submit(request: SubmitRequest): { requestId: string } {
    const now = this.options.now()
    const id = randomUUID()
    const isAdhoc = 'adhoc' in request.target
    const target = isAdhoc ? request.target.adhoc : undefined

    this.options.store.inbound.insert(
      {
        id,
        source: request.source,
        project_id: isAdhoc ? null : request.target.projectId,
        // The ad-hoc run id and model ride in the payload envelope, because the
        // `inbound` table has no column for them and ADR 0003 forbids a schema
        // change outside `ops-store`. The envelope is versioned so a later
        // migration can lift them into columns without guessing.
        payload: JSON.stringify({
          v: 1,
          content: request.content,
          ...(isAdhoc ? { adhoc: { runId: target?.runId, model: target?.model } } : {}),
        }),
        priority: request.priority,
        reply_chat: request.replyTo === undefined ? null : JSON.stringify(request.replyTo),
      },
      now,
    )

    this.requestDispatch()
    return { requestId: id }
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  /**
   * Queue a dispatch pass.
   *
   * Passes are **serialized**: a second call while one is in flight sets a flag
   * rather than starting a parallel pass. Two concurrent passes could each read
   * the same free slot and both admit into it, which is how a concurrency limit
   * silently becomes double.
   */
  requestDispatch(): void {
    if (this.disposed) return
    // A pass already queued is enough: it will observe the queue as it is when it
    // runs, and the queue is read fresh at the top of the pass. Dropping the
    // request here instead of relying on that would lose a trigger that arrives
    // while a pass is MID-flight — which is exactly what a follow-up submitted
    // just after `ops/agent-idle` does, and it left the request pending forever.
    this.dispatchQueued = true
    this.dispatching = this.dispatching.then(async () => {
      this.dispatchQueued = false
      try {
        await this.dispatch()
      } catch (error) {
        this.ctx.logger('ops-governor').error('dispatch pass failed: %s', (error as Error).message)
      }
      // A trigger that arrived during the pass (or during this continuation) sets
      // the flag again, so one more pass runs. Loop until the flag is clear.
      if (this.dispatchQueued && !this.disposed) this.requestDispatch()
    })
  }

  /**
   * One dispatch pass, over the pending queue ordered by priority then age.
   *
   * @returns how many requests were admitted.
   */
  async dispatch(): Promise<number> {
    const pending = this.pendingRequests()

    // In panic mode nothing is admitted — but the queue is still DRAINED, with
    // every request rejected. Returning early instead left them pending forever,
    // which reads as "the system is thinking about it" when the system has in
    // fact stopped.
    if (this.panicMode) {
      for (const request of pending) {
        this.reject(request.id, {
          code: 'PANIC_MODE',
          message: 'panic mode is active; the system is not accepting work',
        })
      }
      return 0
    }

    this.reportStalled(pending)
    let admitted = 0
    // Read once per pass: the project set only changes on a (re)load.
    const knownProjects = new Set(this.options.projects.configuredIds())
    const invalidProjects = new Map(
      this.options.projects.invalidProjects().map((project) => [project.id, invalidMessage(project)]),
    )

    for (const request of pending) {
      // Re-read the snapshot per request: admitting one changes the slot picture
      // for the next, and a stale snapshot would over-admit.
      const verdict = decideAdmission(this.snapshot(), request, {
        pausedPolicy: this.options.config.paused_policy,
        knownProjects,
        invalidProjects,
      })

      if (verdict.kind === 'wait') {
        this.blockedBy.set(request.id, verdict.blockedBy)
        continue
      }
      if (verdict.kind === 'reject') {
        this.reject(request.id, verdict.rejection)
        // A hard budget with the `pause` action stops the project even when the
        // rejection happens at ADMISSION rather than mid-turn. Otherwise a
        // project whose budget is already exhausted would be refused request by
        // request and never actually paused, so `/resume` would have nothing to
        // un-pause and the operator would see a queue that never drains.
        if (verdict.rejection.code === 'BUDGET_EXCEEDED' && verdict.rejection.scope !== undefined) {
          if (this.hardActionOf(verdict.rejection.scope) === 'pause') {
            this.pauseScope(verdict.rejection.scope)
          }
        }
        continue
      }

      try {
        const started = await this.admit(request, verdict.attachToRun)
        if (started) admitted += 1
      } catch (error) {
        // An admission failure is this system's fault, not the request's. Leaving
        // it pending means the next pass retries rather than losing the work.
        this.ctx
          .logger('ops-governor')
          .error('could not admit %s: %s', request.id, (error as Error).message)
        this.blockedBy.set(request.id, `admission_failed:${(error as Error).message}`)
      }
    }

    return admitted
  }

  /** Admit one request, in one transaction before any execution starts. */
  private async admit(request: PendingRequest, attachToRun: string | undefined): Promise<boolean> {
    const now = this.options.now()

    // Already running: attach to the existing run and deliver into the inbox.
    if (attachToRun !== undefined) {
      const track = [...this.running.values()].find((entry) => entry.runId === attachToRun)
      if (track !== undefined) {
        this.options.store.inbound.markAdmitted(request.id, attachToRun, now)
        this.options.store.inbound.markDone(request.id)
        this.blockedBy.delete(request.id)
        await this.deliverTo(track, request)
        return false
      }
    }

    const owner = ownerOfRequest(request)
    const projectId = request.target.kind === 'project' ? request.target.projectId : undefined
    const model = this.modelFor(request)

    // The agent is created BEFORE the run row, because its session id is the
    // row's key. A crash in between leaves an agent with no run, which startup
    // recovery ignores: no run existed, so nothing claims to be running.
    const agent = await this.ensureAgentFor(request, model)
    const sessionId = agent.id as string

    const runId = this.options.store.transaction(() => {
      this.options.store.runs.start(
        {
          id: request.id,
          inbound_id: request.id,
          project_id: projectId ?? null,
          owner_key: ownerKeyOf(owner),
          session_id: sessionId,
          provider: model.provider,
          model: model.model,
          reply_chat: this.replyChatOf(request.id),
        },
        now,
      )
      this.options.store.inbound.markAdmitted(request.id, request.id, now)
      return request.id
    })()

    // An agent the governor OBSERVED before this request arrived already has a
    // track — a caller that called `ensureAgent` itself, or a previous turn.
    // Reusing it is what keeps the loop-detection history and the step count
    // continuous: replacing it would reset both, and a fresh `[]` means a loop in
    // progress is invisible until it repeats the threshold again.
    const existing = this.running.get(sessionId)
    const track: RunTrack =
      existing === undefined
        ? {
            runId,
            owner,
            sessionId,
            provider: model.provider,
            model,
            startedAt: now,
            steps: 0,
            recentToolCalls: [],
            lastToolCall: undefined,
            pendingStop: undefined,
            downgradeAudited: false,
            requestId: request.id,
          }
        : Object.assign(existing, {
            runId,
            provider: model.provider,
            model,
            startedAt: now,
            pendingStop: undefined,
            requestId: request.id,
          })
    this.running.set(sessionId, track)
    this.blockedBy.delete(request.id)

    this.ctx.emit('ops/run-started', { runId, owner, sessionId, requestId: request.id })
    await this.deliverTo(track, request)
    return true
  }

  /** Reject a request and record why. */
  private reject(requestId: string, rejection: { code: RejectCode; message: string; scope?: Scope }): void {
    this.options.store.inbound.markRejected(requestId, rejection.code)
    this.blockedBy.delete(requestId)
    this.ctx.emit('ops/request-rejected', {
      requestId,
      code: rejection.code,
      message: rejection.message,
      ...(rejection.scope === undefined ? {} : { scope: rejection.scope }),
    })
  }

  /** Deliver a request's content into an agent, verbatim. */
  private async deliverTo(track: RunTrack, request: PendingRequest): Promise<void> {
    const row = this.options.store.inbound.get(request.id)
    const envelope = row === undefined ? undefined : parseEnvelope(row)
    // The stored payload is authoritative: it is what was durably recorded
    // before anything ran, so a retry after a crash delivers the same bytes.
    const content = envelope?.content ?? []
    // The target is derived from the OWNER, not from the session id: `deliver`
    // takes an `AgentTarget`, whose variants are project, adhoc and orchestrator.
    // A made-up `session` variant resolves to no live agent, so the delivery
    // silently did nothing.
    await this.options.projects.deliver(
      this.options.capability as never,
      targetOfOwner(track.owner),
      content,
      { runId: track.runId, source: request.source },
    )
  }

  /** The reply address stored on an inbound row, if any. */
  private replyChatOf(id: string): string | null {
    return this.options.store.inbound.get(id)?.reply_chat ?? null
  }

  /** Report requests that have waited too long. */
  private reportStalled(pending: readonly PendingRequest[]): void {
    const now = this.options.now()
    const stallMs = this.options.config.queues.queue_stall_minutes * 60_000
    const newlyStalled = planStalled(pending, now, stallMs, this.stalledReported)
    for (const request of newlyStalled) {
      this.ctx.emit('ops/queue-stalled', {
        requestId: request.id,
        owner: ownerOfRequest(request),
        priority: request.priority,
        waitedMs: now - request.submittedAt,
        reason: this.blockedBy.get(request.id),
      })
    }
  }

  // ── snapshots ────────────────────────────────────────────────────────────

  /** Read the pending queue, ordered by priority then age. */
  private pendingRequests(): PendingRequest[] {
    const rows = this.options.store.inbound.listByStatus('pending')
    const requests = rows.map((row) => this.toRequest(row))
    // Priority ascending (0 is most urgent), then oldest first. The sort is
    // stable in V8, so two requests of equal priority keep their insert order.
    requests.sort((a, b) => a.priority - b.priority || a.submittedAt - b.submittedAt)
    return requests
  }

  /** Convert an `inbound` row into a request. */
  private toRequest(row: InboundRow): PendingRequest {
    const isAdhoc = row.project_id === null
    const envelope = parseEnvelope(row)

    if (isAdhoc) {
      const runId = envelope?.adhoc?.runId ?? row.id
      const requested = envelope?.adhoc?.model
      const model = requested ?? this.defaultAdhocModel(runId)
      return {
        id: row.id,
        priority: row.priority as Priority,
        source: row.source as PendingRequest['source'],
        target: {
          kind: 'adhoc',
          runId,
          ...(requested === undefined ? {} : { model: requested }),
        },
        provider: model.provider,
        model,
        submittedAt: row.created_at,
      }
    }

    const projectId = row.project_id as string
    const model = this.projectModel(projectId) ?? { provider: 'unknown', model: 'unknown' }
    return {
      id: row.id,
      priority: row.priority as Priority,
      source: row.source as PendingRequest['source'],
      target: { kind: 'project', projectId },
      provider: model.provider,
      model: { provider: model.provider, model: model.model },
      submittedAt: row.created_at,
    }
  }

  /** The model an ad-hoc run with no explicit choice should use. */
  private defaultAdhocModel(runId: string): ModelRef {
    void runId
    const configured = this.options.store.runtimeState.get<ModelRef>('adhoc.default_model')
    return configured ?? { provider: 'unknown', model: 'unknown' }
  }

  /** The model a project will use. */
  private projectModel(projectId: string): { provider: string; model: string } | undefined {
    const config = this.options.projects.configOf(projectId)
    if (config === undefined) return undefined
    return { provider: config.provider, model: config.model }
  }

  /** The model a request will use. */
  private modelFor(request: PendingRequest): ModelRef {
    if (request.target.kind === 'adhoc' && request.target.model !== undefined) {
      return request.target.model
    }
    return request.model
  }

  /** Ensure the agent a request needs. */
  private async ensureAgentFor(request: PendingRequest, model: ModelRef): Promise<{ id: unknown }> {
    if (request.target.kind === 'project') {
      return (await this.options.projects.ensureAgent(request.target.projectId)) as unknown as { id: unknown }
    }
    return (await this.options.projects.createEphemeral({
      kind: 'adhoc',
      runId: request.target.runId,
      model,
    })) as unknown as { id: unknown }
  }

  /** Build the snapshot the pure decisions read. */
  snapshot(): GovernorSnapshot {
    const now = this.options.now()
    const budgets = new Map<Scope, BudgetState>()
    for (const scope of this.budgetScopes()) {
      budgets.set(scope, this.budgetState(scope, now))
    }

    return {
      panic: this.panicMode,
      globalInteractiveOnly: this.globalInteractiveOnly(now),
      running: new Map([...this.running].map(([sessionId, track]) => [sessionId, toRunning(track)])),
      config: {
        globalMaxRunning: this.options.config.concurrency.global_max_running,
        perProvider: this.options.config.concurrency.per_provider,
        adhocMaxRunning: this.options.config.concurrency.adhoc_max_running,
        reserveInteractive: this.options.config.concurrency.reserve_interactive,
      },
      providerBlocked: this.providerBlocked(),
      pausedProjects: this.pausedProjects(),
      downgradedOwners: this.downgraded as ReadonlySet<string>,
      budgets,
      // Under `unknown_model_policy: warn` an unpriced model runs and is accounted
      // at zero, so only `block` refuses it here.
      priced: (model) => this.options.meter.isPriced(model) || this.options.meter.unknownPolicy === 'warn',
      freeUnconfirmed: (model) => this.options.meter.needsFreeConfirmation(model),
      modelProblem: (model) => this.options.projects.checkModel(model),
    }
  }

  /** Every scope with a budget row or a configured project. */
  private budgetScopes(): Scope[] {
    const scopes = new Set<Scope>(['global', 'adhoc'])
    for (const projectId of this.options.projects.configuredIds()) {
      scopes.add(`project:${projectId}` as Scope)
    }
    for (const row of this.options.store.budgets.list()) scopes.add(row.scope as Scope)
    return [...scopes]
  }

  /** Whether a provider's token rate window is exhausted. */
  private providerBlocked(): Record<string, boolean> {
    const blocked: Record<string, boolean> = {}
    for (const provider of Object.keys(this.options.config.concurrency.per_provider)) {
      const window = this.options.meter.rateWindow(provider)
      if (window.limitTokens !== undefined) blocked[provider] = !window.allows(0, this.options.now())
    }
    return blocked
  }

  /** The projects currently paused. */
  private pausedProjects(): ReadonlySet<string> {
    const paused = new Set<string>()
    for (const row of this.options.store.projects.list()) {
      if (row.status === 'paused') paused.add(row.id)
    }
    return paused
  }

  /** Whether the global budget has crossed its interactive-only threshold. */
  private globalInteractiveOnly(now: number): boolean {
    const state = this.budgetState('global', now)
    return state.pct !== undefined && state.pct >= this.options.config.budgets.global_interactive_only_pct
  }

  // ── budgets ──────────────────────────────────────────────────────────────

  /**
   * One scope's budget state.
   * @param scope the scope.
   * @param now the current time.
   * @returns the evaluated state.
   */
  budgetState(scope: Scope, now = this.options.now()): BudgetState {
    const period = this.periodFor(scope)
    const budget = this.scopeBudget(scope, period)
    // The THRESHOLDS are per scope too: a project may set its own `soft_pct`, and
    // reading only the global default made a project's 50% behave like the
    // default 80% — the threshold was crossed but reported as `info`.
    return evaluateBudget(budget, now, this.thresholdsOf(scope), {
      downgraded: this.downgraded.has(scope),
      hardAction: this.hardActionOf(scope),
    })
  }

  /** The period a scope's live budget is expressed in. */
  private periodFor(scope: Scope): Period {
    const day = this.options.store.budgets.get(scope, 'day')
    const month = this.options.store.budgets.get(scope, 'month')
    if (day !== undefined) return 'day'
    if (month !== undefined) return 'month'
    return 'day'
  }

  /** Build the raw budget inputs for a scope. */
  private scopeBudget(scope: Scope, period: Period): ScopeBudget {
    const row = this.options.store.budgets.get(scope, period)
    const configured =
      row?.limit_micros ??
      (scope === 'global'
        ? usdToMicros(this.options.config.budgets.default_day_usd)
        : this.projectLimit(scope, period))

    return {
      scope,
      period,
      limitMicros: configured === null ? undefined : (configured as MicroUsd),
      // The METER's counter is authoritative for "spent", because it is advanced
      // before the durable write. Reading the rollup here would let a burst of
      // requests inside one flush window each pass a stale check.
      spentMicros: this.options.meter.spending(scope).dayMicros,
      overrideMicros:
        row?.override_micros === null || row?.override_micros === undefined
          ? (0 as MicroUsd)
          : (row.override_micros as MicroUsd),
      overrideUntil: row?.override_until ?? undefined,
    }
  }

  /** A project's configured budget limit. */
  private projectLimit(scope: Scope, period: Period): number | undefined {
    if (!scope.startsWith('project:')) return undefined
    const config = this.options.projects.configOf(scope.slice('project:'.length))
    if (config === undefined) return undefined
    const usd = period === 'day' ? config.budget.day_usd : config.budget.month_usd
    return usdToMicros(usd)
  }

  /**
   * The thresholds that apply to a scope.
   *
   * Precedence: the scope's budget row, then the project's YAML section, then the
   * global default.
   *
   * @param scope the scope.
   * @returns the info and soft percentages.
   */
  private thresholdsOf(scope: Scope): { infoPct: number; softPct: number } {
    const row = this.options.store.budgets.get(scope, this.periodFor(scope))
    if (row !== undefined) return { infoPct: row.info_pct, softPct: row.soft_pct }
    if (scope.startsWith('project:')) {
      const config = this.options.projects.configOf(scope.slice('project:'.length))
      if (config !== undefined) {
        return { infoPct: config.budget.info_pct, softPct: config.budget.soft_pct }
      }
    }
    return {
      infoPct: this.options.config.budgets.info_pct,
      softPct: this.options.config.budgets.soft_pct,
    }
  }

  /**
   * Re-evaluate every budget and act on what changed.
   *
   * Called after every `ops/usage` event and before every admission. The actions
   * are applied **before** the announcements, so a listener that reacts to a hard
   * threshold already sees the project paused.
   *
   * @returns the announcements emitted.
   */
  recomputeThresholds(): number {
    const now = this.options.now()
    const states = this.budgetScopes().map((scope) => this.budgetState(scope, now))

    // Apply the soft action before announcing, so the downgrade is in force by
    // the time a listener reacts. The action is resolved PER SCOPE: a project may
    // choose `downgrade` while the global default stays `warn`, and reading only
    // the global default silently ignored the project's own choice.
    for (const state of states) {
      if (state.level !== 'soft' && state.level !== 'hard') continue
      if (this.softActionOf(state.scope) === 'downgrade') this.downgraded.add(state.scope)
    }

    // Apply the hard action.
    for (const state of states) {
      if (state.level !== 'hard') continue
      if (this.hardActionOf(state.scope) === 'pause') this.pauseScope(state.scope)
    }

    const announcements = planThresholds(states, this.announced)
    for (const announcement of announcements) {
      this.ctx.emit('ops/budget-threshold', announcement)
    }
    return announcements.length
  }

  /**
   * The soft action that applies to a scope.
   *
   * Precedence: the scope's own budget row, then the project's YAML section for
   * a project scope, then the global default.
   *
   * @param scope the scope.
   * @returns the action.
   */
  private softActionOf(scope: Scope): 'warn' | 'downgrade' {
    const row = this.options.store.budgets.get(scope, this.periodFor(scope))
    if (row !== undefined) return row.action_soft
    if (scope.startsWith('project:')) {
      const config = this.options.projects.configOf(scope.slice('project:'.length))
      if (config !== undefined) return config.budget.soft_action
    }
    return this.options.config.budgets.soft_action
  }

  /**
   * The hard action that applies to a scope.
   *
   * @param scope the scope.
   * @returns the action.
   */
  private hardActionOf(scope: Scope): 'pause' | 'reject_new' {
    const row = this.options.store.budgets.get(scope, this.periodFor(scope))
    if (row !== undefined) return row.action_hard
    if (scope.startsWith('project:')) {
      const config = this.options.projects.configOf(scope.slice('project:'.length))
      if (config !== undefined) return config.budget.hard_action
    }
    return this.options.config.budgets.hard_action
  }

  /** Pause the project a scope belongs to. */
  private pauseScope(scope: Scope): void {
    if (!scope.startsWith('project:')) return
    const projectId = scope.slice('project:'.length)
    const row = this.options.store.projects.get(projectId)
    if (row === undefined || row.status === 'paused') return
    this.options.store.projects.setStatus(projectId, 'paused', this.options.now())
    this.ctx.logger('ops-governor').warn('project %s paused: its budget is exhausted', projectId)
  }

  /**
   * Look at a settled usage event and act.
   *
   * @param scope the scope the usage was recorded under.
   */
  onUsage(scope: Scope): void {
    this.recomputeThresholds()
    // A threshold may have freed or blocked capacity, so re-dispatch.
    void scope
    this.requestDispatch()
  }

  // ── step enforcement ─────────────────────────────────────────────────────

  /**
   * Decide whether a step may proceed. Called from the `agent/pre-step` listener.
   *
   * @param sessionId the session whose step is starting.
   * @returns whether to allow it.
   */
  preStep(sessionId: string): { kind: 'allow' } | { kind: 'reject' } {
    const track = this.running.get(sessionId)
    if (track === undefined) return { kind: 'allow' }

    // The budget is re-read here rather than cached, because a turn can outlive
    // the check that admitted it.
    const budgetLevel = this.worstBudgetLevel(track.owner)
    const verdict = decideStep(
      {
        runId: track.runId,
        steps: track.steps,
        startedAt: track.startedAt,
        recentToolCalls: track.recentToolCalls,
        budgetLevel,
        ...(this.worstBudgetScope(track.owner) === undefined
          ? {}
          : { budgetScope: this.worstBudgetScope(track.owner) }),
      },
      {
        maxSteps: this.options.config.limits.max_steps_per_run,
        maxWallclockMs: this.options.config.limits.max_wallclock_min * 60_000,
        loopRepeatThreshold: this.options.config.limits.loop_repeat_threshold,
      },
      this.options.now(),
    )

    if (verdict.kind === 'allow') {
      track.steps += 1
      this.options.store.runs.setSteps(track.runId, track.steps)
      return { kind: 'allow' }
    }

    track.pendingStop = { reason: verdict.reason, detail: verdict.detail }
    this.ctx.emit('ops/run-stopped', {
      runId: track.runId,
      owner: track.owner,
      reason: verdict.reason,
      detail: verdict.detail,
    })
    return { kind: 'reject' }
  }

  /** The worst budget level across a run's applicable scopes. */
  private worstBudgetLevel(owner: Owner): BudgetLevel {
    const order: BudgetLevel[] = ['ok', 'info', 'soft', 'hard']
    let worst: BudgetLevel = 'ok'
    for (const scope of applicableScopes(
      owner.kind === 'project'
        ? { kind: 'project', projectId: owner.projectId }
        : { kind: 'adhoc', runId: owner.kind === 'adhoc' ? owner.runId : 'orchestrator' },
    )) {
      const state = this.budgetState(scope)
      if (order.indexOf(state.level) > order.indexOf(worst)) worst = state.level
    }
    return worst
  }

  /** The scope whose budget is worst, for the stop message. */
  private worstBudgetScope(owner: Owner): Scope | undefined {
    for (const scope of applicableScopes(
      owner.kind === 'project'
        ? { kind: 'project', projectId: owner.projectId }
        : { kind: 'adhoc', runId: owner.kind === 'adhoc' ? owner.runId : 'orchestrator' },
    )) {
      if (this.budgetState(scope).level === 'hard') return scope
    }
    return undefined
  }

  /**
   * Note a tool call for loop detection.
   *
   * @param sessionId the session.
   * @param name the tool name.
   * @param args the tool arguments.
   */
  /**
   * A health report.
   *
   * `down` under panic, because the system is refusing all new work — a healthcheck
   * should restart the container only for that, and this is the one state an
   * operator must be told about rather than left to discover.
   *
   * `degraded` when requests have been waiting longer than the stall threshold, or
   * when no slot is free while work is queued.
   *
   * @returns the report.
   */
  health(): ServiceHealth {
    const status = this.status()
    const now = this.options.now()
    const oldest = status.pending.reduce<number | undefined>(
      (worst, entry) => (worst === undefined || entry.submittedAt < worst ? entry.submittedAt : worst),
      undefined,
    )
    const oldestWaitMs = oldest === undefined ? 0 : now - oldest

    const details: Record<string, unknown> = {
      panic: status.panic,
      running: status.running.length,
      pending: status.pending.length,
      slots: status.slots,
      oldestWaitMs,
    }

    if (status.panic) {
      return { status: 'down', details: { ...details, reason: 'panic mode is engaged; new work is refused' } }
    }
    if (oldestWaitMs > this.options.config.queues.queue_stall_minutes * 60_000) {
      return { status: 'degraded', details: { ...details, reason: 'a request has been queued past the stall threshold' } }
    }
    return { status: 'ok', details }
  }

  /**
   * The most recent tool call for a run, as the governor observed it.
   *
   * A caller that only has a run id — such as `ops-approvals-bridge`, whose
   * approval event does not carry arguments — reads what the tool was actually
   * asked to do here. The arguments are parsed into `argv`/`path` best-effort;
   * an unrecognized shape yields an empty argv, which matches no allowlist.
   *
   * @param runId the run.
   * @returns the call, or `undefined` when nothing was observed.
   */
  lastToolCall(key: string): { readonly name: string; readonly argv: readonly string[]; readonly path: string | undefined } | undefined {
    // Matched by run id OR by session id. A caller that has only a session — which
    // is the case before a run has started — must still be able to see the last
    // observed call; a run id is assigned when the governor admits work, so a
    // session-scoped lookup is the only one that works for an idle agent.
    for (const [session, track] of this.running) {
      if (track.runId !== key && session !== key && track.sessionId !== key) continue
      const observed = track.lastToolCall
      if (observed === undefined) return undefined
      return { name: observed.name, ...argumentsOf(observed.args) }
    }
    return undefined
  }

  noteToolCall(sessionId: string, name: string, args: unknown): void {
    const root = this.options.projects.rootSessionOf(sessionId)
    // An observed track is created on demand. A tool call can arrive before any
    // admission — the agent exists, the turn has not been admitted through the
    // queue yet — and without a track the call would be dropped, leaving
    // `lastToolCall` empty and an allowlist silently unable to match.
    let track = this.running.get(root)
    if (track === undefined) {
      const owner = this.options.projects.ownerOf(root)
      if (owner === undefined) return
      const config = owner.kind === 'project' ? this.options.projects.configOf(owner.projectId) : undefined
      const model: ModelRef = { provider: config?.provider ?? 'unknown', model: config?.model ?? 'unknown' }
      track = {
        runId: `observed-${root}`,
        owner,
        sessionId: root,
        provider: model.provider,
        model,
        startedAt: this.options.now(),
        steps: 0,
        recentToolCalls: [],
        lastToolCall: undefined,
        pendingStop: undefined,
        downgradeAudited: false,
        requestId: undefined,
      }
      this.running.set(root, track)
    }
    const key = toolCallKey(name, args)
    track.recentToolCalls.push(key)
    // Retained for `ops-approvals-bridge`, which has no other way to see what a
    // tool was asked to do: dsh's approval event carries only the tool name.
    track.lastToolCall = { name, args }
    // Keep only what the threshold needs: the history is a loop detector, not a
    // log, and an unbounded array would grow with the run.
    const keep = this.options.config.limits.loop_repeat_threshold
    if (track.recentToolCalls.length > keep) {
      track.recentToolCalls.splice(0, track.recentToolCalls.length - keep)
    }
  }

  // ── model downgrade ──────────────────────────────────────────────────────

  /**
   * The model a request must use, downgrading a scope past its soft threshold.
   *
   * @param sessionId the session making the request.
   * @param requested the model it asked for.
   * @returns the model to use, or `undefined` to keep the requested one.
   */
  requestModel(sessionId: string, requested: ModelRef): ModelRef | undefined {
    const root = this.options.projects.rootSessionOf(sessionId)
    // The owner is resolved from the PROJECTS registry rather than from a run
    // track. A track exists only while a turn is in flight, and a queued follow-up
    // on an idle agent makes its first request after the previous track was
    // deleted — so looking the owner up here would silently skip every downgrade
    // on the second and later turns.
    const owner = this.running.get(root)?.owner ?? this.options.projects.ownerOf(root)
    if (owner === undefined || owner.kind !== 'project') return undefined

    const projectId = owner.projectId
    if (!this.downgraded.has(`project:${projectId}` as Scope)) return undefined

    const fallback = this.options.projects.configOf(projectId)?.fallback_model
    if (fallback === undefined || fallback === null) return undefined

    const [provider, ...rest] = String(fallback).split('/')
    const model = rest.join('/')
    if (provider === undefined || model.length === 0) return undefined
    if (provider === requested.provider && model === requested.model) return undefined

    // Audited once per RUN when one is open, and once per downgrade otherwise.
    // One row per model request would bury the decision.
    const track = this.running.get(root)
    if (track === undefined ? !this.downgradeAudited.has(projectId) : !track.downgradeAudited) {
      if (track === undefined) this.downgradeAudited.add(projectId)
      else track.downgradeAudited = true
      this.options.store.audit.record(
        {
          actor: 'ops-governor',
          action: 'budget.downgrade',
          target: projectId,
          details: { from: formatModelRef(requested), to: String(fallback) },
        },
        this.options.now(),
      )
    }

    this.ctx.emit('ops/model-downgraded', {
      projectId,
      from: formatModelRef(requested),
      to: String(fallback),
    })
    return { provider, model }
  }

  // ── agent lifecycle ──────────────────────────────────────────────────────

  /**
   * Note that an agent started running.
   *
   * A run the governor did not admit — an agent a test created directly — is
   * tracked anyway, so its steps are bounded and its slot is visible. Creating
   * the track here rather than only in `admit` is what makes a directly-created
   * agent governable.
   *
   * @param sessionId the session.
   * @param owner the owner, when the caller knows it.
   */
  onAgentRunning(sessionId: string, owner?: Owner): void {
    const root = this.options.projects.rootSessionOf(sessionId)
    if (this.running.has(root)) return

    const resolved = owner ?? this.options.projects.ownerOf(sessionId)
    if (resolved === undefined) return

    const config =
      resolved.kind === 'project' ? this.options.projects.configOf(resolved.projectId) : undefined
    const model: ModelRef = {
      provider: config?.provider ?? 'unknown',
      model: config?.model ?? 'unknown',
    }

    this.running.set(root, {
      runId: `observed-${root}`,
      owner: resolved,
      sessionId: root,
      provider: model.provider,
      model,
      lastToolCall: undefined,
      startedAt: this.options.now(),
      steps: 0,
      recentToolCalls: [],
      pendingStop: undefined,
      downgradeAudited: false,
      requestId: undefined,
    })
  }

  /**
   * Whether a session belongs to a run the governor tracks.
   *
   * The step hook asks this before enforcing anything, so a budget stop can only
   * ever apply to work this governor admitted or observed.
   *
   * @param sessionId the session.
   * @returns whether it is governed.
   */
  isGoverned(sessionId: string): boolean {
    const root = this.options.projects.rootSessionOf(sessionId)
    return this.running.has(root) || this.running.has(sessionId)
  }

  /**
   * Release a run when its agent goes idle.
   *
   * @param sessionId the session.
   */
  onAgentIdle(sessionId: string): void {
    const root = this.options.projects.rootSessionOf(sessionId)
    const track = this.running.get(root)
    if (track === undefined) return

    const now = this.options.now()
    const status = track.pendingStop === undefined ? 'completed' : stopStatusOf(track.pendingStop.reason)
    this.options.store.runs.finish(track.runId, status, now, track.pendingStop?.reason)
    if (track.requestId !== undefined) this.options.store.inbound.markDone(track.requestId)
    this.running.delete(root)

    // A new slot may be free, so a queued request can run.
    this.requestDispatch()
  }

  // ── query ────────────────────────────────────────────────────────────────

  /** The whole status. */
  status(): GovernorStatus {
    const now = this.options.now()
    const pending = this.pendingRequests()
    return {
      panic: this.panicMode,
      running: [...this.running.values()].map((track) => ({
        runId: track.runId,
        owner: track.owner,
        sessionId: track.sessionId,
        provider: track.provider,
        steps: track.steps,
        startedAt: track.startedAt,
      })),
      pending: pending.map((request) => ({
        requestId: request.id,
        projectId: request.target.kind === 'project' ? request.target.projectId : null,
        priority: request.priority,
        submittedAt: request.submittedAt,
        blockedBy: this.blockedBy.get(request.id),
      })),
      slots: {
        globalUsed: this.running.size,
        globalLimit: this.options.config.concurrency.global_max_running,
        reserved: this.options.config.concurrency.reserve_interactive,
        adhocUsed: countRunning(this.snapshot(), 'adhoc'),
        adhocLimit: this.options.config.concurrency.adhoc_max_running,
        pending: pending.length,
      },
      budgets: [...this.budgetScopes()].map((scope) => this.budgetState(scope, now)),
    }
  }

  /** Whether panic mode is on. */
  get isPanic(): boolean {
    return this.panicMode
  }

  /** Whether a scope is currently downgraded. */
  isDowngraded(scope: Scope): boolean {
    return this.downgraded.has(scope)
  }

  // ── overrides ────────────────────────────────────────────────────────────

  /**
   * Grant a scope extra budget, and resume a project the hard action paused.
   *
   * @param scope the scope.
   * @param options how much, and for how long.
   */
  override(scope: Scope, options: { addUsd?: number; addMicros?: number; untilMs?: number } = {}): void {
    const now = this.options.now()
    const added =
      options.addMicros ?? usdToMicros(options.addUsd ?? this.options.config.budgets.default_day_usd)

    // Both periods get the headroom: an override that raised only the daily
    // limit would still be stopped by the monthly one an hour later.
    for (const period of ['day', 'month'] as Period[]) {
      const existing = this.options.store.budgets.get(scope, period)
      if (existing === undefined) {
        // No row yet, so create one from the configured default before adding
        // to it — `setOverride` refuses a scope it does not know.
        this.options.store.budgets.upsert({
          scope,
          period,
          limit_micros: this.configuredLimitOf(scope, period),
          action_soft: this.options.config.budgets.soft_action,
          action_hard: this.options.config.budgets.hard_action,
        })
      }
      this.options.store.budgets.setOverride(scope, period, {
        addMicros: added,
        untilMs: options.untilMs ?? null,
      })
    }

    this.options.store.audit.record(
      {
        actor: 'user',
        action: 'budget.override',
        target: scope,
        details: { addedMicros: added, untilMs: options.untilMs ?? null },
      },
      now,
    )

    // An override is what un-pauses a project the hard action stopped.
    if (scope.startsWith('project:')) {
      const projectId = scope.slice('project:'.length)
      const row = this.options.store.projects.get(projectId)
      if (row?.status === 'paused') {
        this.options.store.projects.setStatus(projectId, 'active', now)
      }
    }
    this.downgraded.delete(scope)

    this.ctx.emit('ops/budget-overridden', {
      scope,
      addedMicros: added as MicroUsd,
      untilMs: options.untilMs,
    })
    this.recomputeThresholds()
    this.requestDispatch()
  }

  /** The configured limit for a scope, used when creating its first budget row. */
  private configuredLimitOf(scope: Scope, period: Period): number {
    const projectLimit = this.projectLimit(scope, period)
    if (projectLimit !== undefined) return projectLimit
    if (scope === 'global') {
      return usdToMicros(
        period === 'day'
          ? this.options.config.budgets.default_day_usd
          : this.options.config.budgets.default_month_usd,
      )
    }
    return usdToMicros(
      period === 'day'
        ? this.options.config.budgets.default_day_usd
        : this.options.config.budgets.default_month_usd,
    )
  }

  // ── kill switch ──────────────────────────────────────────────────────────

  /**
   * Stop everything.
   *
   * Cancels every governed agent and refuses new work. Must complete in under
   * five seconds, so the cancellations run in parallel and are not awaited
   * beyond a bounded window: a hung agent must not make the kill switch hang.
   *
   * @returns how many agents were cancelled and how long it took.
   */
  async panic(): Promise<{ cancelled: number; tookMs: number }> {
    const started = this.options.now()
    this.panicMode = true
    this.options.store.runtimeState.set('governor.panic', true, this.options.now())

    const sessions = [...this.running.keys()]
    await Promise.all(
      sessions.map(async (sessionId) => {
        try {
          this.options.projects.cancelSession(sessionId)
        } catch (error) {
          this.ctx.logger('ops-governor').warn('could not cancel %s: %s', sessionId, (error as Error).message)
        }
      }),
    )

    const tookMs = this.options.now() - started
    this.ctx.emit('ops/panic', { cancelled: sessions.length, tookMs })
    this.ctx.logger('ops-governor').warn('PANIC: cancelled %d agent(s) in %d ms', sessions.length, tookMs)
    return { cancelled: sessions.length, tookMs }
  }

  /** Clear panic mode and resume dispatching. */
  resumeAll(): void {
    this.panicMode = false
    this.options.store.runtimeState.set('governor.panic', false, this.options.now())
    this.ctx.emit('ops/resumed')
    this.requestDispatch()
  }

  /**
   * Stop one target's current turn.
   * @param target the target to stop.
   * @returns whether a run was stopped.
   */
  stop(target: { projectId: string } | { runId: string }): boolean {
    for (const track of this.running.values()) {
      const matches =
        'projectId' in target
          ? track.owner.kind === 'project' && track.owner.projectId === target.projectId
          : track.owner.kind === 'adhoc' && track.owner.runId === target.runId
      if (matches) return this.options.projects.cancelSession(track.sessionId)
    }
    return false
  }

  /** Stop the timer. */
  dispose(): void {
    this.disposed = true
    if (this.ticker !== undefined) clearInterval(this.ticker)
    this.ticker = undefined
  }
}

/** The owner a request targets. */
function ownerOfRequest(request: PendingRequest): Owner {
  return request.target.kind === 'project'
    ? projectOwner(request.target.projectId)
    : ({ kind: 'adhoc', runId: request.target.runId } as Owner)
}

/** The delivery target for an owner. */
function targetOfOwner(owner: Owner): AgentTarget {
  switch (owner.kind) {
    case 'project':
      return { kind: 'project', projectId: owner.projectId }
    case 'adhoc':
      return { kind: 'adhoc', runId: owner.runId }
    case 'orchestrator':
      return { kind: 'orchestrator' }
  }
}

/** The owner key for a run row. */
function ownerKeyOf(owner: Owner): string {
  return scopeOfOwner(owner)
}

/** The owner recorded on a run row. */
function ownerOfRun(run: RunRow): Owner {
  return run.project_id === null
    ? ({ kind: 'adhoc', runId: run.owner_key.replace(/^adhoc:/, '') } as Owner)
    : projectOwner(run.project_id)
}

/** Convert a track into the running view a snapshot holds. */
function toRunning(track: RunTrack): RunningAgent {
  return {
    sessionId: track.sessionId,
    owner: track.owner,
    runId: track.runId,
    provider: track.provider,
    targetKind: track.owner.kind === 'adhoc' ? 'adhoc' : track.owner.kind === 'orchestrator' ? 'orchestrator' : 'project',
    startedAt: track.startedAt,
  }
}

/** The terminal run status a stop reason maps to. */
function stopStatusOf(reason: StopReason): 'budget_stopped' | 'limit_stopped' {
  return reason === 'budget_stopped' ? 'budget_stopped' : 'limit_stopped'
}

/** The versioned envelope an inbound payload holds. */
interface InboundEnvelope {
  readonly v: number
  readonly content: readonly ContentBlockLike[]
  readonly adhoc?: { readonly runId: string; readonly model?: ModelRef }
}

/**
 * Parse an inbound row's payload envelope.
 *
 * A parse failure returns `undefined` rather than throwing: a corrupt payload is
 * a rejected request, not a crash in the dispatcher.
 */
function parseEnvelope(row: InboundRow): InboundEnvelope | undefined {
  if (typeof row.payload !== 'string') return undefined
  try {
    const parsed = JSON.parse(row.payload) as InboundEnvelope
    return Array.isArray(parsed.content) ? parsed : undefined
  } catch {
    return undefined
  }
}

export { effectiveLimit, overrideActive, checkBudgets }

/**
 * Best-effort extraction of a process argv and a file path from tool arguments.
 *
 * Tool arguments are a provider-defined JSON object and their shape is not ours to
 * dictate, so this reads the conventional keys and gives up otherwise. **An
 * unrecognized shape yields an empty argv**, which matches no allowlist and
 * therefore asks — the fail-closed direction.
 *
 * @param args the raw arguments.
 * @returns the argv and a path, each possibly empty.
 */
export function argumentsOf(args: unknown): { readonly argv: readonly string[]; readonly path: string | undefined } {
  if (args === null || typeof args !== 'object') return { argv: [], path: undefined }
  const record = args as Record<string, unknown>

  // A `command` may be a string a shell would split, or an already-split array.
  const command = record['command'] ?? record['cmd'] ?? record['script']
  // dsh's file tools name it `file_path`; its search tools, `path`.
  const path = [record['file_path'], record['path'], record['file']].find((value): value is string => typeof value === 'string')

  if (Array.isArray(command)) {
    return { argv: command.filter((token): token is string => typeof token === 'string'), path }
  }
  if (typeof command === 'string') {
    return { argv: splitCommand(command), path }
  }
  return { argv: [], path }
}

/** Split a command line on whitespace, respecting simple quoting. */
function splitCommand(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | undefined

  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}
