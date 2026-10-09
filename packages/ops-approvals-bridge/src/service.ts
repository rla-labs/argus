// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/approvals-bridge/service` — the bridge.
 *
 * It answers dsh's `approval/request` **waterfall**: returning an outcome claims
 * the request, and calling `next()` delegates to the rest of the chain. With no
 * answerer at all the chain falls through to `'unavailable'`, which is the
 * fail-closed default dsh provides (SPIKES.md spike 5).
 *
 * @module @argus-agent/approvals-bridge/service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { randomUUID } from 'node:crypto'
import { decodeAddress, encodeAddress, type ChannelAddress, type ServiceHealth } from '@argus-agent/types'
import type { ApprovalStatus, OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import { argumentsOf } from '@argus-agent/governor'
import { isInside, parseAction, renderAction, type ActionKind, type ParsedAction } from './argv.js'
import { decideApproval, isGrant, policyOf, type ApprovalDecision } from './policy.js'
import { APPROVE, APPROVE_ALL, DENY, approvalButtons, approvalQuestion, decisionText, refusedText, sanitize } from './question.js'
import type { ApprovalsSection } from './config.js'
import type { ApprovalEnding } from './events.js'

/**
 * dsh tools that only keep the agent's own books (its todo list, goals, background
 * jobs, skills) or show it something. They pass the gate without a question.
 */
export const QUIET_TOOLS: ReadonlySet<string> = new Set([
  'todo_write',
  'present',
  'create_goal',
  'get_goal',
  'update_goal',
  'job_list',
  'job_output',
  'job_kill',
  'skill',
  'list_subagent_models',
])

/** Options for the service. */
export interface BridgeOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly config: ApprovalsSection
  /** Reads the current time. */
  readonly now: () => number
}

/** A run-scoped grant, scoped to one action category. */
interface RunGrant {
  readonly runId: string
  readonly kind: ActionKind
  readonly by: string
  readonly at: number
  readonly reason: string
}

/** Everything the bridge decided, for diagnostics. */
export interface BridgeOutcome {
  readonly id: string
  readonly projectId: string | null
  readonly runId: string
  readonly toolName: string
  readonly kind: ActionKind
  readonly ending: ApprovalEnding
  readonly decidedBy: string | null
  readonly detail?: string
}

/** An approval request, as the bridge needs it. */
export interface BridgeRequest {
  readonly toolName: string
  readonly agent: Agent
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/**
 * The approvals bridge.
 *
 * Exposed as `ctx.opsApprovals`.
 */
export class OpsApprovalsBridge {
  /** Run-scoped grants, keyed `runId|kind`. */
  private readonly grants = new Map<string, RunGrant>()
  /**
   * The action of each call the gate sent to approval, keyed by call id, until
   * dsh's approval request for it arrives.
   * ponytail: an entry whose request never comes (a call cancelled in between)
   * stays; clear by age if a long-lived process ever shows it growing.
   */
  private readonly gated = new Map<string, ParsedAction>()
  /** The decision for each request, for diagnostics. */
  readonly history: BridgeOutcome[] = []
  /** Counts by ending. */
  readonly counts = new Map<string, number>()

  constructor(
    private readonly ctx: Context,
    private readonly options: BridgeOptions,
  ) {}

  // ── the gate ─────────────────────────────────────────────────────────────

  /**
   * Decide whether a tool call needs approval, before it runs (`tools/pre-execute`).
   *
   * dsh asks only when a pre-execute listener answers `ask`; nothing else in the
   * pinned version does, so without this gate every command and write ran
   * unasked. A project or task agent passes without a question only for reads
   * and searches inside its own folder and for the bookkeeping tools in
   * {@link QUIET_TOOLS}; everything else asks: commands, writes, the web, reads
   * elsewhere, and any tool a later dsh adds. The front desk's own tools pass.
   * The call's own arguments are kept for {@link handle}, because dsh's approval
   * request carries only the tool name and call id.
   *
   * @param exec the pending call.
   * @returns `ask`, or `undefined` to let the call through.
   */
  gate(exec: {
    readonly name: string
    readonly arguments: unknown
    readonly callId: string
    readonly agent?: Agent
  }): { kind: 'ask'; reason: string } | undefined {
    if (exec.agent === undefined) return undefined
    const owner = this.options.projects.ownerOf(exec.agent.id as string)
    if (owner === undefined || owner.kind === 'orchestrator') return undefined
    if (QUIET_TOOLS.has(exec.name)) return undefined
    const { argv, path } = argumentsOf(exec.arguments)
    const record = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
    // What the question shows for a call with no path: a fetch's URL, a search's query.
    const target = path ?? [record['url'], record['query']].find((value): value is string => typeof value === 'string')
    const action = parseAction(exec.name, argv, target)
    // A one-off task cannot be asked (`approvals_adhoc` is `deny`), and "what is X?"
    // needs the web. It reads nothing outside its own folder, so it has little to leak.
    if (action.kind === 'network' && owner.kind === 'adhoc') return undefined
    if (action.kind === 'file-read') {
      const root = owner.kind === 'project' ? this.options.projects.configOf(owner.projectId)?.cwd : this.options.projects.taskDirOf(owner.runId)
      // A glob's pattern is a path too: `../../**` or `/data/**` searches outside.
      const named = [path, exec.name === 'glob' ? record['pattern'] : undefined].filter((value): value is string => typeof value === 'string')
      if (root !== undefined && named.every((value) => isInside(root, value))) return undefined
    }
    this.gated.set(exec.callId, action)
    return { kind: 'ask', reason: renderAction(action, this.options.config.max_action_length) }
  }

  // ── the waterfall ────────────────────────────────────────────────────────

  /**
   * Answer one approval request.
   *
   * **Every path returns an outcome or calls `next()`.** A throw here would be
   * worse than a refusal: dsh's chain would see an exception rather than a
   * decision, and the safe reading of an exception is unavailable — so a refusal is
   * returned explicitly.
   *
   * @param request the request.
   * @param next the rest of the chain.
   * @returns the outcome.
   */
  async handle(
    request: BridgeRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    try {
      return await this.decide(request, next)
    } catch (error) {
      // Fail closed. An internal error must never become a grant, and it must not
      // become a thrown exception inside dsh's waterfall either.
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger('ops-approvals').warn('approval handling failed, refusing: %s', detail)
      return 'rejected'
    }
  }

  /** The real decision path. */
  private async decide(request: BridgeRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const agent = request.agent
    const sessionId = agent.id as string
    const projectId = this.options.projects.ownerOf(sessionId)?.kind === 'project'
      ? (this.options.projects.ownerOf(sessionId) as { projectId: string }).projectId
      : null
    /**
     * The run's identity, for scoping a run-wide grant.
     *
     * Falls back to the **session id** when the governor has not admitted a run yet.
     * Using a constant like `'unknown'` was a real bug: every not-yet-admitted
     * session shared that key, so "approve all for this run" in one project
     * authorized the same category of action in *every* other project — the exact
     * scope leak the category was meant to prevent.
     */
    const runId = this.options.projects.runOf(sessionId) ?? sessionId
    const id = randomUUID()

    // The argv is not on the event, so it is recovered from the project's last
    // observed tool call for this run. When it cannot be recovered the action is
    // `undefined`, which never matches an allowlist.
    const parsed = this.actionFor(request, sessionId, runId)

    const projectConfig = projectId === null ? undefined : this.options.projects.configOf(projectId)
    const policy = policyOf(projectConfig?.approvals, this.options.config.approvals_adhoc)
    const grant = this.grantFor(runId, parsed?.kind)

    const decision: ApprovalDecision = decideApproval({
      mode: policy.mode,
      autoAllow: policy.autoAllow,
      adhocMode: this.options.config.approvals_adhoc,
      action: parsed,
      runGrant: grant === undefined ? undefined : { kind: grant.kind, reason: grant.reason },
    })

    const base = {
      id,
      projectId,
      runId,
      toolName: request.toolName,
      kind: parsed?.kind ?? 'other',
      action: parsed === undefined ? request.toolName : renderAction(parsed, this.options.config.max_action_length),
    }

    this.options.store.approvals.insert(
      {
        id,
        run_id: runId,
        project_id: projectId,
        request_json: JSON.stringify({
          toolName: request.toolName,
          callId: request.callId ?? null,
          reason: request.reason ?? null,
          action: base.action,
          kind: base.kind,
          decision: decision.kind,
        }),
        status: 'pending',
      },
      this.options.now(),
    )

    this.ctx.emit('ops/approval-requested', {
      ...base,
      // `allow-run` is an automatic allow, so it is reported as one: the event's
      // vocabulary is the three policy outcomes, not the four internal branches.
      decision: decision.kind === 'allow-run' ? 'allow' : decision.kind,
    })

    switch (decision.kind) {
      case 'allow':
        return toOutcome(this.finish(id, base, 'auto', 'granted', `allow-listed by rule "${decision.rule}"`))
      case 'allow-run':
        // Resolved automatically, so the row records a grant rather than staying
        // pending: `pending` would leave it looking like something nobody answered.
        return toOutcome(this.finish(id, base, 'auto', 'granted', `covered by a run grant (${decision.because})`))
      case 'deny':
        return toOutcome(this.finish(id, base, 'denied', 'denied', refusedText(decision.reason)))
      case 'ask':
        return this.ask(request, next, id, base, parsed, projectId)
    }
  }

  /** Ask the operator, and act on the answer. */
  private async ask(
    request: BridgeRequest,
    next: () => Promise<ApprovalOutcome>,
    id: string,
    base: { id: string; projectId: string | null; runId: string; toolName: string; kind: ActionKind; action: string },
    parsed: ParsedAction | undefined,
    projectId: string | null,
  ): Promise<ApprovalOutcome> {
    const address = this.addressFor(projectId, base.runId)
    if (address === undefined) {
      // No channel at all: deny. The plan is explicit that absence means no.
      this.ctx.logger('ops-approvals').warn('no reply address for run %s; refusing %s', base.runId, base.toolName)
      return toOutcome(this.finish(id, base, 'unavailable', 'unavailable', 'no channel is available to ask'))
    }
    if (!this.options.channel.adapters().some((adapter) => adapter.name === address.channel)) {
      this.ctx.logger('ops-approvals').warn('no adapter "%s"; refusing %s', address.channel, base.toolName)
      return toOutcome(this.finish(id, base, 'unavailable', 'unavailable', `no channel adapter named ${address.channel}`))
    }

    const timeoutMinutes = this.timeoutMinutesFor(projectId)
    const question = approvalQuestion({
      projectId: base.projectId,
      runId: base.runId,
      action: parsed,
      toolName: base.toolName,
      reason: request.reason,
      timeoutMinutes,
      alsoPending: Math.max(0, this.options.store.approvals.listPending().length - 1),
    })

    // The question id is OURS, so the answer can be attributed to the person who
    // pressed the button: the channel correlates by id, and two pending questions
    // can offer the same button value.
    const questionId = `approval:${id}`
    let answer
    try {
      answer = await this.options.channel.ask(
        address,
        question,
        this.options.config.allow_run_grant ? approvalButtons() : approvalButtons().slice(0, 2),
        timeoutMinutes * 60_000,
        questionId,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger('ops-approvals').warn('asking failed for %s: %s', base.toolName, detail)
      return toOutcome(this.finish(id, base, 'error', 'denied', `the question could not be sent: ${detail}`))
    }

    if (answer === 'timeout') {
      // The default the plan requires. `expirePending` is not used here: the row is
      // decided directly, so the decision and the outcome cannot disagree.
      this.ctx.logger('ops-approvals').info('approval %s timed out; refusing %s', id, base.toolName)
      return toOutcome(this.finish(id, base, 'timeout', 'timeout', `no answer within ${timeoutMinutes} minute(s)`))
    }

    // `Answer` carries only the value; the user id lives on the channel's
    // `ButtonAnswer`. Correlating by the question id we supplied is what makes
    // "who approved this" a fact rather than a guess.
    const by = this.options.channel.answeredBy(questionId) ?? null

    const value = answer.value
    if (value === APPROVE_ALL && this.options.config.allow_run_grant) {
      this.grant(base.runId, parsed?.kind ?? 'other', by ?? 'unknown', base.action)
      return toOutcome(this.finish(id, base, 'approved-run', 'granted', decisionText(value, parsed), by))
    }
    if (value === APPROVE) {
      return toOutcome(this.finish(id, base, 'approved', 'granted', undefined, by))
    }
    if (value === DENY) {
      return toOutcome(this.finish(id, base, 'denied', 'denied', decisionText(value, parsed), by))
    }

    // An unrecognized answer is not an approval. It is denied, and logged with the
    // value so a wiring mistake is visible rather than silent.
    this.ctx.logger('ops-approvals').warn('unknown approval answer %j; refusing', value)
    return toOutcome(this.finish(id, base, 'denied', 'denied', `unrecognized answer ${sanitize(value, 40)}`, by))
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * The action a request is about.
   *
   * `ApprovalRequestEvent` carries the tool name but **not** the arguments, so the
   * argv is recovered from the project's most recent observed tool call for this
   * run — which the governor records (`ops-governor` listens to `tool/call`). When
   * it cannot be recovered, the result is `undefined`, and an undefined action
   * never matches an allowlist: the request is asked about rather than allowed.
   *
   * @param request the request.
   * @param runId the run.
   * @returns the action, or `undefined`.
   */
  private actionFor(request: BridgeRequest, sessionId: string, runId: string): ParsedAction | undefined {
    // The gate saw the call's own arguments: exact, where the observation below
    // may be a previous call of the same tool.
    const gated = request.callId === undefined ? undefined : this.gated.get(request.callId)
    if (gated !== undefined) {
      this.gated.delete(request.callId as string)
      return gated
    }
    // Looked up by SESSION first: a run id is only assigned when the governor admits
    // work, so an idle agent that has observed a tool call has no run id yet — and
    // the allowlist would silently fail to match.
    const observed =
      this.options.governor.lastToolCall(sessionId) ??
      (runId === sessionId ? undefined : this.options.governor.lastToolCall(runId))
    if (observed !== undefined && observed.name === request.toolName) {
      return parseAction(request.toolName, observed.argv, observed.path)
    }
    // No matching observation. A non-process tool still has a usable action (its
    // tool name and, if the reason names one, a path) — but no argv, so it cannot
    // match an allowlist.
    const path = pathFromReason(request.reason)
    if (path !== undefined) return parseAction(request.toolName, [], path)
    return undefined
  }

  /** The reply address for a run. */
  private addressFor(projectId: string | null, runId: string): ChannelAddress | undefined {
    // Only a real run has a stored reply address; a session-id fallback has none,
    // so this is skipped rather than looked up as if it were a run.
    const row = this.options.store.runs.get(runId)
    const stored = row?.reply_chat
    if (typeof stored === 'string' && stored.length > 0) {
      const decoded = safeDecode(stored)
      if (decoded !== undefined) return decoded
    }
    // Fall back to the channel's default, so a project whose address is unknown
    // still reaches the operator rather than being refused for want of a chat.
    return this.options.channel.defaultAddress()
  }

  /** The timeout for a project. */
  private timeoutMinutesFor(projectId: string | null): number {
    if (projectId === null) return this.options.config.timeout_minutes
    const config = this.options.projects.configOf(projectId)
    return config?.approvals.timeout_minutes ?? this.options.config.timeout_minutes
  }

  /** Record a decision, in the store, the audit log and the history. */
  private finish(
    id: string,
    base: { id: string; projectId: string | null; runId: string; toolName: string; kind: ActionKind; action: string },
    ending: ApprovalEnding,
    status: Exclude<ApprovalStatus, 'pending'>,
    detail: string | undefined,
    decidedBy: string | null = null,
  ): Exclude<ApprovalStatus, 'pending'> {
    const now = this.options.now()
    // Guarded by `status = 'pending'` in the repository, so a late button press
    // cannot overwrite a decision a timeout already made.
    this.options.store.approvals.decide(id, status, decidedBy, now)

    this.options.store.audit.record(
      {
        actor: decidedBy ?? 'system',
        action: 'approval.decided',
        // The target names what was decided about, so a reader sees the subject
        // without parsing `details`.
        target: `${base.projectId ?? 'adhoc'}:${base.toolName}`,
        details: {
          ending,
          run_id: base.runId,
          project_id: base.projectId,
          kind: base.kind,
          action: base.action,
          detail: detail ?? null,
        },
      },
      now,
    )

    const outcome: BridgeOutcome = {
      id,
      projectId: base.projectId,
      runId: base.runId,
      toolName: base.toolName,
      kind: base.kind,
      ending,
      decidedBy,
      ...(detail === undefined ? {} : { detail }),
    }
    this.history.push(outcome)
    this.counts.set(ending, (this.counts.get(ending) ?? 0) + 1)

    this.ctx.emit('ops/approval-decided', {
      id,
      projectId: base.projectId,
      runId: base.runId,
      toolName: base.toolName,
      kind: base.kind,
      ending: outcome.ending,
      decidedBy,
      detail,
    })

    this.ctx.logger('ops-approvals').info(
      '%s %s (%s) in run %s%s',
      base.toolName,
      ending,
      base.kind,
      base.runId,
      detail === undefined ? '' : `: ${detail}`,
    )

    return status
  }

  // ── run-scoped grants ────────────────────────────────────────────────────

  /** Remember a run-wide approval for one action category. */
  grant(runId: string, kind: ActionKind, by: string, because: string): void {
    this.grants.set(`${runId}|${kind}`, {
      runId,
      kind,
      by,
      at: this.options.now(),
      reason: because,
    })
    this.ctx.logger('ops-approvals').info('run %s: all %s actions approved by %s', runId, kind, by)
  }

  /** The grant covering a category in a run, if any. */
  grantFor(runId: string, kind: ActionKind | undefined): RunGrant | undefined {
    if (kind === undefined) return undefined
    return this.grants.get(`${runId}|${kind}`)
  }

  /** Every grant, for diagnostics. */
  listGrants(): RunGrant[] {
    return [...this.grants.values()]
  }

  /** Forget the grants of a finished run. */
  forgetRun(runId: string): void {
    for (const key of this.grants.keys()) {
      if (key.startsWith(`${runId}|`)) this.grants.delete(key)
    }
  }

  // ── the dsh session policy ───────────────────────────────────────────────

  /**
   * The dsh policy a project's mode maps to.
   *
   * `deny` maps to dsh's `never`, which auto-rejects **without prompting** — so a
   * `deny` project never reaches the waterfall at all. That is the deterministic
   * refusal the plan asks for, and it is cheaper than asking and refusing.
   *
   * @param mode the project mode.
   * @returns the dsh policy.
   */
  dshPolicyFor(mode: 'auto' | 'ask' | 'deny'): 'ask' | 'never' {
    return mode === 'deny' ? 'never' : 'ask'
  }

  /**
   * A health report.
   *
   * `degraded` when requests are timing out or the channel is unreachable — both
   * mean risky actions are being refused for a reason nobody intended, which an
   * operator needs to see.
   *
   * @returns the report.
   */
  health(): ServiceHealth {
    const pending = this.options.store.approvals.listPending().length
    const timeouts = this.counts.get('timeout') ?? 0
    const unavailable = this.counts.get('unavailable') ?? 0
    const errors = this.counts.get('error') ?? 0

    const details: Record<string, unknown> = {
      grants: this.grants.size,
      pending,
      counts: Object.fromEntries(this.counts),
    }

    if (unavailable > 0) {
      return { status: 'degraded', details: { ...details, reason: 'a request could not reach a channel' } }
    }
    if (timeouts + errors >= 3) {
      return { status: 'degraded', details: { ...details, reason: 'repeated timeouts or errors' } }
    }
    return { status: 'ok', details }
  }
}

/**
 * Map our stored status onto dsh's outcome vocabulary.
 *
 * They are deliberately different: the store's `granted`/`denied`/`timeout`/
 * `unavailable` records *what happened*, while dsh's `'allowed-once'`/`'rejected'`/
 * `'unavailable'` is *what the tool may do*. `'allowed-once'` is the only grant dsh
 * has (SPIKES.md spike 5), so every grant maps to it.
 *
 * @param status the stored status.
 * @returns the dsh outcome.
 */
export function toOutcome(status: Exclude<ApprovalStatus, 'pending'>): ApprovalOutcome {
  switch (status) {
    case 'granted':
      return 'allowed-once'
    case 'unavailable':
      return 'unavailable'
    default:
      return 'rejected'
  }
}

/** Decode a stored address, tolerating a malformed one. */
function safeDecode(value: string): ChannelAddress | undefined {
  try {
    return decodeAddress(value)
  } catch {
    return undefined
  }
}

/** A file path mentioned in a reason, when there is one. */
function pathFromReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const match = /(?:^|\s)(\/[\w./-]+)/.exec(reason)
  return match?.[1]
}

export { encodeAddress, isGrant }
