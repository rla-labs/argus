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
import {
  NEVER_UNASKED,
  PROJECT_TOOL_DEFAULTS,
  decodeAddress,
  encodeAddress,
  hostAllowed,
  isInside,
  taskToolPolicy,
  mcpServerOf,
  mcpToolAccess,
  mcpToolOf,
  toolGroupOf,
  type ChannelAddress,
  type ServiceHealth,
} from '@argus-agent/types'
import type { ApprovalStatus, OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { CheckpointAnswer, CheckpointQuestion, OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import { argumentsOf, checkpointQuestionId } from '@argus-agent/governor'
import { isReadOnlyCommand, parseAction, renderAction, type ActionKind, type ParsedAction } from './argv.js'
import { decideApproval, isGrant, policyOf, type ApprovalDecision } from './policy.js'
import { ALWAYS, APPROVE, APPROVE_ALL, CONTINUE, DENY, alwaysButton, checkpointButtons, checkpointQuestion, alwaysRuleOf, approvalButtons, approvalQuestion, decisionText, refusedText, ruleCommand, sanitize, type AlwaysRule } from './question.js'
import type { ApprovalsSection } from './config.js'
import type { ApprovalEnding } from './events.js'

/** The tools a delegated agent's call may be labelled as (`as`); any other label is `other`. */
const DELEGATED_TOOLS: ReadonlySet<string> = new Set(['bash', 'read', 'write', 'edit', 'web_fetch', 'web_search', 'todo_write'])

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
  /** What a question shows whole, by call: a mail as it will be sent. */
  private readonly details = new Map<string, string>()
  /** `runId|action` already reported as blocked in a scheduled run; dropped with the run. */
  private readonly blocked = new Set<string>()
  /** Tool names in no group, each warned about once. */
  private readonly unclassified = new Set<string>()
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
   * Decide what a tool call may do, before it runs (`tools/pre-execute`).
   *
   * dsh asks only when a pre-execute listener answers `ask`; nothing else in the
   * pinned version does. The answer comes from the owner's tool policy: a
   * project's `tools:` block, or the fixed policy of a one-off task. A group set to
   * `deny` (or `off`, whose tools the model should not even see) is refused here,
   * without a question; `allow` runs unasked, except a read or write outside the
   * agent's own folder, which always asks; `ask` asks, except a `web_fetch` to a
   * host in `web_hosts`. The bookkeeping tools always pass, and so do the front
   * desk's own. The call's own arguments are kept for {@link handle}, because
   * dsh's approval request carries only the tool name and call id.
   *
   * @param exec the pending call.
   * @returns `ask` or `deny`, or `undefined` to let the call through.
   */
  gate(exec: {
    readonly name: string
    readonly arguments: unknown
    readonly callId: string
    readonly agent?: Agent
  }): { kind: 'ask'; reason: string } | { kind: 'deny'; reason: string } | undefined {
    if (exec.agent === undefined) return undefined
    const owner = this.options.projects.ownerOf(exec.agent.id as string)
    if (owner === undefined || owner.kind === 'orchestrator') return undefined
    const verdict = this.verdict(owner, exec.name, exec.arguments)
    if (verdict?.kind === 'ask') this.gated.set(exec.callId, verdict.action)
    return verdict === undefined ? undefined : { kind: verdict.kind, reason: verdict.reason }
  }

  /**
   * The gate's decision for one call of an owner, shared by dsh's calls ({@link gate})
   * and an extension's delegated agent's ({@link decideDelegated}).
   *
   * @param owner the project or one-off task the call is for.
   * @param name the tool, as dsh names it.
   * @param args its arguments, in dsh's shapes.
   * @returns ask (with the action asked about) or deny, or undefined to let it run.
   */
  private verdict(
    owner: Exclude<ReturnType<OpsProjects['ownerOf']>, undefined>,
    name: string,
    args: unknown,
  ): { kind: 'ask'; reason: string; action: ParsedAction } | { kind: 'deny'; reason: string } | undefined {
    if (owner.kind === 'orchestrator') return undefined
    const exec = { name, arguments: args }
    const { argv, path } = argumentsOf(exec.arguments)
    // A command on the fixed read-only list is a read: under the sandbox it reads only
    // the project's folder and the system.
    const named = toolGroupOf(exec.name)
    const group = named === 'shell' && isReadOnlyCommand(argv) ? 'read' : named
    const project = owner.kind === 'project' ? this.options.projects.configOf(owner.projectId) : undefined
    const exception = project?.tools.exceptions[exec.name]
    if (group === 'quiet' && exception === undefined) return undefined
    // A tool of one of the project's MCP servers follows that server's `access`...
    const serverName = mcpServerOf(exec.name)
    const server = serverName === undefined ? undefined : project?.mcp[serverName]
    if (group === 'other' && server === undefined && !this.unclassified.has(exec.name)) {
      this.unclassified.add(exec.name)
      this.ctx.logger('ops-approvals').warn('tool %s is in no group; it follows tools.other', exec.name)
    }
    const policy = owner.kind === 'project' ? (project?.tools ?? PROJECT_TOOL_DEFAULTS) : taskToolPolicy(this.options.config.approvals_adhoc)
    // ...or the most specific of its `tools` keys that matches.
    const decided = server === undefined ? undefined : mcpToolAccess(server, mcpToolOf(exec.name) ?? '')
    const access = exception ?? decided?.access ?? (group === 'quiet' ? 'allow' : policy[group])
    if (access === 'deny' || access === 'off') {
      const where = owner.kind === 'project' ? `in project ${owner.projectId}` : 'in a one-off task'
      const rule = exception !== undefined ? `tools.exceptions.${exec.name}` : decided === undefined ? `tools.${group}` : decided.pattern === null ? `mcp.${serverName}.access` : `mcp.${serverName}.tools.${decided.pattern}`
      return { kind: 'deny', reason: `${exec.name} is not allowed ${where} (${rule}: ${access}). Do not look for another way to do the same thing.` }
    }

    const record = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
    if (group === 'read' || group === 'write') {
      const root = owner.kind === 'project' ? this.options.projects.configOf(owner.projectId)?.cwd : this.options.projects.taskDirOf(owner.runId)
      // A glob's pattern is a path too: `../../**` or `/data/**` searches outside.
      const named = [path, exec.name === 'glob' ? record['pattern'] : undefined].filter((value): value is string => typeof value === 'string')
      const inside = root !== undefined && named.every((value) => isInside(root, value))
      if (inside && access === 'allow') return undefined
    } else if (access === 'allow') {
      return undefined
    } else if (exec.name === 'web_fetch' && typeof record['url'] === 'string' && hostAllowed(record['url'], policy.web_hosts)) {
      return undefined
    }

    // What the question shows for a call with no path: a fetch's URL, a search's query.
    // An MCP call has no fixed shape: the person sees its arguments.
    const target =
      path ??
      [record['url'], record['query']].find((value): value is string => typeof value === 'string') ??
      (server === undefined ? undefined : JSON.stringify(exec.arguments ?? {}))
    const action = parseAction(exec.name, argv, target)
    return { kind: 'ask', reason: renderAction(action, this.options.config.max_action_length), action }
  }

  /**
   * A `git_push` the gate would ask about, shown as what it sends: its commits and
   * changes, prepared by the projects service, which then pushes that commit or
   * nothing. One that cannot be pushed (protected, no token, not a fast-forward) is
   * refused here, without a question nobody could usefully answer.
   *
   * @param exec the pending call.
   * @param verdict the gate's.
   * @returns the verdict, with the push described.
   */
  async describePush(
    exec: { readonly name: string; readonly arguments: unknown; readonly callId: string; readonly agent?: Agent },
    verdict: { kind: 'ask'; reason: string },
  ): Promise<{ kind: 'ask'; reason: string } | { kind: 'deny'; reason: string }> {
    const owner = exec.agent === undefined ? undefined : this.options.projects.ownerOf(exec.agent.id as string)
    if (owner?.kind !== 'project') return verdict
    const record = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
    const text = (key: string): string | undefined => (typeof record[key] === 'string' && (record[key] as string).length > 0 ? (record[key] as string) : undefined)
    const preview = await this.options.projects.gitPushPreview(owner.projectId, {
      ...(text('remote') === undefined ? {} : { remote: text('remote') as string }),
      ...(text('branch') === undefined ? {} : { branch: text('branch') as string }),
      ...(text('path') === undefined ? {} : { path: text('path') as string }),
    })
    if (!preview.ok) return { kind: 'deny', reason: preview.text }
    const action = parseAction(exec.name, [], preview.text)
    this.gated.set(exec.callId, action)
    return { kind: 'ask', reason: renderAction(action, this.options.config.max_action_length) }
  }

  /**
   * A `send_mail` the gate asks about, shown as the mail it sends: from, to, subject,
   * attachments and text, prepared by the projects service, which then sends that mail
   * or nothing. One that cannot be sent (a recipient not allowed, no account, the daily
   * limit, an attachment outside the folder) is refused here, before any question. Any
   * other may run (`undefined`): one to trusted recipients within their counts is sent,
   * and one a person must approve goes to the outbox, which {@link askOutbox} asks about
   * without holding the run.
   *
   * @param exec the pending call.
   * @returns the question, with the mail described, the refusal, or `undefined`.
   */
  async describeMail(
    exec: { readonly name: string; readonly arguments: unknown; readonly callId: string; readonly agent?: Agent },
  ): Promise<{ kind: 'ask'; reason: string } | { kind: 'deny'; reason: string } | undefined> {
    const owner = exec.agent === undefined ? undefined : this.options.projects.ownerOf(exec.agent.id as string)
    if (owner?.kind !== 'project') return { kind: 'deny', reason: 'send_mail works only in a project.' }
    const preview = await this.options.projects.mailPreview(owner.projectId, String(exec.callId), exec.arguments)
    if (!preview.ok) return { kind: 'deny', reason: preview.text }
    if (preview.unasked === true || preview.queued === true) return undefined
    const subject = /^subject: (.*)$/m.exec(preview.text)?.[1] ?? ''
    const to = /^to: (.*)$/m.exec(preview.text)?.[1] ?? ''
    const action = parseAction(exec.name, [], `to ${to}: ${subject}`)
    this.gated.set(exec.callId, action)
    this.details.set(exec.callId, preview.text)
    return { kind: 'ask', reason: renderAction(action, this.options.config.max_action_length) }
  }

  /**
   * Ask about a mail waiting in a project's outbox. Nothing waits on the answer: the run
   * that sent it has gone on. Approve sends the mail as it was shown; Deny or no answer
   * within the approvals timeout drops it; the person asked is told which.
   *
   * @param mail the outbox's event for the waiting mail.
   */
  async askOutbox(mail: { projectId: string; id: number; runId: string | null; text: string }): Promise<void> {
    const id = randomUUID()
    const runId = mail.runId ?? `outbox:${mail.id}`
    const subject = /^subject: (.*)$/m.exec(mail.text)?.[1] ?? ''
    const to = /^to: (.*)$/m.exec(mail.text)?.[1] ?? ''
    const action = parseAction('send_mail', [], `to ${to}: ${subject}`)
    const base = { id, projectId: mail.projectId, runId, toolName: 'send_mail', kind: action.kind, action: renderAction(action, this.options.config.max_action_length) }
    this.options.store.approvals.insert(
      { id, run_id: runId, project_id: mail.projectId, request_json: JSON.stringify({ toolName: 'send_mail', callId: null, reason: null, action: base.action, kind: base.kind, decision: 'ask', always: null, detail: mail.text, outbox: mail.id }), status: 'pending' },
      this.options.now(),
    )
    this.ctx.emit('ops/approval-requested', { ...base, decision: 'ask' })
    const decide = (decision: 'approve' | 'deny' | 'expire', by: string | null, note: string | null = null) => this.options.projects.decideOutbox(mail.id, decision, by, note)

    const address = this.addressFor(mail.projectId, runId)
    if (address === undefined || !this.options.channel.canReach(address)) {
      this.finish(id, base, 'unavailable', 'unavailable', 'no channel is available to ask')
      await decide('expire', null, 'nobody could be asked')
      return
    }
    const timeoutMinutes = this.timeoutMinutesFor(mail.projectId)
    const question = approvalQuestion({
      projectId: mail.projectId,
      runId,
      action,
      toolName: 'send_mail',
      reason: `waits in the outbox as #${mail.id}; the run went on`,
      timeoutMinutes,
      alsoPending: Math.max(0, this.options.store.approvals.listPending().length - 1),
      detail: mail.text,
    })
    const questionId = `approval:${id}`
    let said: string
    try {
      const answer = await this.options.channel.ask(address, question, approvalButtons().slice(0, 2), timeoutMinutes * 60_000, questionId)
      const by = answer === 'timeout' ? null : (this.options.channel.answeredBy(questionId) ?? null)
      if (answer !== 'timeout' && answer.value === APPROVE) {
        this.finish(id, base, 'approved', 'granted', undefined, by)
        said = await decide('approve', by)
      } else if (answer === 'timeout') {
        this.finish(id, base, 'timeout', 'timeout', `no answer within ${timeoutMinutes} minute(s)`)
        said = await decide('expire', null, `no answer within ${timeoutMinutes} minute(s)`)
      } else {
        this.finish(id, base, 'denied', 'denied', decisionText(answer.value, action), by)
        said = await decide('deny', by)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger('ops-approvals').warn('asking about outbox mail #%d failed: %s', mail.id, detail)
      this.finish(id, base, 'error', 'denied', `the question could not be sent: ${detail}`)
      said = await decide('expire', null, 'the question could not be sent')
    }
    await this.options.channel.send(address, { text: said }).catch((error: Error) => this.ctx.logger('ops-approvals').warn('could not report outbox mail #%d: %s', mail.id, error.message))
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

    // The argv is not on the event, so it is recovered from the project's last
    // observed tool call for this run. When it cannot be recovered the action is
    // `undefined`, which never matches an allowlist.
    const parsed = this.actionFor(request, sessionId, runId)
    return (await this.decideFor({ projectId, runId, toolName: request.toolName, callId: request.callId, reason: request.reason }, parsed, next)).outcome
  }

  /**
   * Everything after the request's project, run and action are known: the rules, a run
   * grant, the question, the record. Shared by dsh's requests and delegated ones.
   */
  private async decideFor(
    request: { readonly projectId: string | null; readonly runId: string; readonly toolName: string; readonly callId?: string | undefined; readonly reason?: string | undefined; readonly via?: string },
    parsed: ParsedAction | undefined,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<{ outcome: ApprovalOutcome; id: string }> {
    const id = randomUUID()
    return { outcome: await this.decided(request, parsed, next, id), id }
  }

  private async decided(
    request: { readonly projectId: string | null; readonly runId: string; readonly toolName: string; readonly callId?: string | undefined; readonly reason?: string | undefined; readonly via?: string },
    parsed: ParsedAction | undefined,
    next: () => Promise<ApprovalOutcome>,
    id: string,
  ): Promise<ApprovalOutcome> {
    const { projectId, runId } = request

    const projectConfig = projectId === null ? undefined : this.options.projects.configOf(projectId)
    const policy = policyOf(projectConfig?.approvals, this.options.config.approvals_adhoc)
    const grant = this.grantFor(runId, parsed?.kind)
    // A mail is asked about every time: no rule, mode or run grant answers for a person.
    const strict = NEVER_UNASKED.has(request.toolName)

    const decided: ApprovalDecision = decideApproval({
      mode: policy.mode,
      autoAllow: policy.autoAllow,
      adhocMode: this.options.config.approvals_adhoc,
      action: parsed,
      runGrant: grant === undefined ? undefined : { kind: grant.kind, reason: grant.reason },
    })
    const decision: ApprovalDecision = strict && decided.kind !== 'deny' ? { kind: 'ask' } : decided
    const detail = request.callId === undefined ? undefined : this.details.get(request.callId)
    if (request.callId !== undefined) this.details.delete(request.callId)

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
          // What "Always allow" would write, so the web can offer it too.
          always: projectId === null || strict ? null : (alwaysRuleOf(request.toolName, parsed) ?? null),
          // What the question shows whole (a mail), so the web shows it too.
          ...(detail === undefined ? {} : { detail }),
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
        return this.ask(request, next, id, base, parsed, projectId, strict, detail)
    }
  }

  /** Ask the operator, and act on the answer. */
  private async ask(
    request: { readonly reason?: string | undefined; readonly via?: string | undefined },
    next: () => Promise<ApprovalOutcome>,
    id: string,
    base: { id: string; projectId: string | null; runId: string; toolName: string; kind: ActionKind; action: string },
    parsed: ParsedAction | undefined,
    projectId: string | null,
    strict = false,
    detail?: string,
  ): Promise<ApprovalOutcome> {
    // Offered only where the rule can be named exactly, and only in a project: a task has no file.
    const always = projectId === null || strict ? undefined : alwaysRuleOf(base.toolName, parsed)
    const unattended = this.isUnattended(base.runId)
    if (unattended && this.options.config.unattended_timeout_s === 0) {
      await this.reportBlocked(base, always)
      return toOutcome(this.finish(id, base, 'unattended', 'denied', 'a scheduled run: nobody is asked'))
    }
    const address = this.addressFor(projectId, base.runId)
    if (address === undefined) {
      // No channel at all: deny. The plan is explicit that absence means no.
      this.ctx.logger('ops-approvals').warn('no reply address for run %s; refusing %s', base.runId, base.toolName)
      return toOutcome(this.finish(id, base, 'unavailable', 'unavailable', 'no channel is available to ask'))
    }
    if (!this.options.channel.canReach(address)) {
      this.ctx.logger('ops-approvals').warn('nothing reaches "%s:%s"; refusing %s', address.channel, address.chatId, base.toolName)
      return toOutcome(this.finish(id, base, 'unavailable', 'unavailable', `no connected channel reaches ${address.channel}:${address.chatId}`))
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
      ...(always === undefined || projectId === null ? {} : { repeated: this.timesApproved(projectId, id, base.action) }),
      ...(unattended ? { unattendedSeconds: this.options.config.unattended_timeout_s } : {}),
      ...(detail === undefined ? {} : { detail }),
      ...(request.via === undefined ? {} : { via: request.via }),
    })

    // The question id is OURS, so the answer can be attributed to the person who
    // pressed the button: the channel correlates by id, and two pending questions
    // can offer the same button value.
    const questionId = `approval:${id}`
    const buttons = this.options.config.allow_run_grant && !strict ? approvalButtons() : approvalButtons().slice(0, 2)
    let answer
    try {
      answer = await this.options.channel.ask(
        address,
        question,
        always === undefined ? buttons : [...buttons, alwaysButton(always, projectId as string)],
        unattended ? this.options.config.unattended_timeout_s * 1000 : timeoutMinutes * 60_000,
        questionId,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger('ops-approvals').warn('asking failed for %s: %s', base.toolName, detail)
      return toOutcome(this.finish(id, base, 'error', 'denied', `the question could not be sent: ${detail}`))
    }

    if (answer === 'timeout' && unattended) {
      await this.reportBlocked(base, always)
      return toOutcome(this.finish(id, base, 'unattended', 'timeout', `a scheduled run: no answer within ${this.options.config.unattended_timeout_s} second(s)`))
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
    if (value === APPROVE_ALL && this.options.config.allow_run_grant && !strict) {
      this.grant(base.runId, parsed?.kind ?? 'other', by ?? 'unknown', base.action)
      return toOutcome(this.finish(id, base, 'approved-run', 'granted', decisionText(value, parsed), by))
    }
    if (value === APPROVE) {
      return toOutcome(this.finish(id, base, 'approved', 'granted', undefined, by))
    }
    if (value === ALWAYS && always !== undefined) {
      // Changing the project file is the admin's; anyone else's press approves this once.
      const note = this.options.channel.answeredByAdmin(questionId)
        ? await this.remember(projectId as string, always, by ?? 'unknown', address)
        : 'only the admin can always-allow; approved this once'
      return toOutcome(this.finish(id, base, 'approved', 'granted', note, by))
    }
    if (value === DENY) {
      return toOutcome(this.finish(id, base, 'denied', 'denied', decisionText(value, parsed), by))
    }

    // An unrecognized answer is not an approval. It is denied, and logged with the
    // value so a wiring mistake is visible rather than silent.
    this.ctx.logger('ops-approvals').warn('unknown approval answer %j; refusing', value)
    return toOutcome(this.finish(id, base, 'denied', 'denied', `unrecognized answer ${sanitize(value, 40)}`, by))
  }

  // ── delegated actions ────────────────────────────────────────────────────

  /**
   * Decide a tool call of an agent an extension's server runs for a project (Claude
   * Code), sent as `ask` on the server's host channel. The call is judged as if the
   * project's own agent made it, by the same gate and the same rules, questions, run
   * grants and records: `as` names the equivalent tool (`bash`, `read`, `write`, `edit`,
   * `web_fetch`, `web_search`, `todo_write`) and `arguments` are in its shape. What the
   * arguments hold outranks the label: a `command` is a shell command, a `url` a fetch,
   * whatever `as` says. Anything malformed, and any failure, is a refusal.
   *
   * @param call the message, with the project and run from the socket.
   * @returns allow or deny, with the reason the delegated agent is told.
   */
  async decideDelegated(call: { readonly projectId: string; readonly server: string; readonly runId: string; readonly message: Readonly<Record<string, unknown>> }): Promise<{ decision: 'allow' | 'deny'; reason: string }> {
    try {
      const { message } = call
      const tool = typeof message['tool'] === 'string' ? sanitize(message['tool'], 64) : undefined
      const args = message['arguments'] ?? {}
      if (tool === undefined || typeof args !== 'object' || args === null || Array.isArray(args)) return { decision: 'deny', reason: 'Argus could not read this request (tool and arguments are required); not allowed.' }
      const record = args as Record<string, unknown>
      const label = typeof message['as'] === 'string' && DELEGATED_TOOLS.has(message['as']) ? message['as'] : 'other'
      const name = record['command'] !== undefined ? 'bash' : record['url'] !== undefined ? 'web_fetch' : label
      const owner = { kind: 'project', projectId: call.projectId } as const
      const verdict = this.verdict(owner, name, record)
      if (verdict === undefined) return { decision: 'allow', reason: `allowed by project ${call.projectId}'s policy` }
      if (verdict.kind === 'deny') return { decision: 'deny', reason: verdict.reason }
      const via = `${call.server}: ${tool}`
      const { outcome, id } = await this.decideFor({ projectId: call.projectId, runId: call.runId, toolName: name, via }, verdict.action, async () => 'unavailable')
      if (outcome === 'allowed-once') return { decision: 'allow', reason: 'approved' }
      const detail = this.history.findLast((entry) => entry.id === id)?.detail
      return { decision: 'deny', reason: `Not approved${detail === undefined ? '' : `: ${detail}`}. Do not look for another way to do the same thing.` }
    } catch (error) {
      this.ctx.logger('ops-approvals').warn('a delegated request failed, refusing: %s', error instanceof Error ? error.message : String(error))
      return { decision: 'deny', reason: 'Argus could not decide this request; not allowed.' }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Add an "Always allow" rule to a project's file, through `/set` like any change,
   * so it is validated, reloaded and audited the same way.
   *
   * @returns what happened, for the decision's note.
   */
  private async remember(projectId: string, rule: { key: string; entry: string }, userId: string, address: ChannelAddress): Promise<string> {
    const commands = this.ctx.get('opsCommands' as never) as unknown as { runCommand(line: string, context: unknown): Promise<{ text: string; error?: boolean }> } | undefined
    const config = this.options.projects.configOf(projectId)
    if (commands === undefined || config === undefined) return 'approved once; the rule could not be saved here'
    const current = rule.key === 'approvals.auto_allow' ? config.approvals.auto_allow : config.tools.web_hosts
    if (current.includes(rule.entry)) return `already always allowed: ${rule.entry}`
    const out = await commands.runCommand(`/set ${projectId} ${rule.key} ${JSON.stringify([...current, rule.entry])}`, { address, userId, isAdmin: true, now: this.options.now() })
    return out.error === true ? `approved once; the rule was not saved: ${out.text}` : `always allowed from now on in ${projectId}: ${rule.entry}`
  }

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
      // The person who asked, on every channel they use; a group stays the group.
      if (decoded !== undefined) return this.options.channel.personOf(decoded)
    }
    // Fall back to the channel's default, so a project whose address is unknown
    // still reaches the operator rather than being refused for want of a chat.
    return this.options.channel.defaultAddress()
  }

  /**
   * Ask whether a run the loop checker found in a loop goes on: a scheduled run is not
   * asked (nobody watches it), an interactive one asks the person it works for.
   * Registered with the governor as its loop asker.
   *
   * @param question what the checker said and the run did.
   * @param signal aborts when the run is stopped while it waits.
   * @returns continue, unattended for a scheduled run, or stop with what the stop notice says.
   */
  async checkpoint(question: CheckpointQuestion, signal: AbortSignal): Promise<CheckpointAnswer> {
    const projectId = question.owner.kind === 'project' ? question.owner.projectId : null
    if (this.isUnattended(question.runId)) return { kind: 'unattended' }
    const address = this.addressFor(projectId, question.runId)
    if (address === undefined || !this.options.channel.canReach(address)) return { kind: 'stop', detail: 'nobody can be reached to ask' }
    const timeoutMinutes = this.timeoutMinutesFor(projectId)
    const text = checkpointQuestion({
      projectId,
      runId: question.runId,
      reason: question.reason,
      steps: question.steps,
      elapsedMs: this.options.now() - question.startedAt,
      changes: projectId === null ? undefined : await this.options.projects.folderChanges(projectId, question.runId),
      costMicros: question.costMicros,
      timeoutMinutes,
    })
    const questionId = checkpointQuestionId(question.runId, question.steps)
    const answer = await this.options.channel.ask(address, text, checkpointButtons(), timeoutMinutes * 60_000, questionId)
    // ponytail: a run stopped while it waited leaves the buttons up until they time out; pressing them then changes nothing.
    if (signal.aborted) return { kind: 'stop', detail: 'it was stopped while it waited' }
    if (answer === 'timeout') return { kind: 'stop', detail: `no answer in ${timeoutMinutes} minute(s)` }
    const continued = answer.value === CONTINUE
    this.ctx.logger('ops-approvals').info('run %s %s after a loop check by %s', question.runId, continued ? 'continued' : 'stopped', this.options.channel.answeredBy(questionId) ?? 'unknown')
    return continued ? { kind: 'continue' } : { kind: 'stop', detail: 'stopped by a person' }
  }

  /** Whether a run was started by a schedule: nobody is watching it. */
  private isUnattended(runId: string): boolean {
    const inbound = this.options.store.runs.get(runId)?.inbound_id
    return inbound !== null && inbound !== undefined && this.options.store.inbound.get(inbound)?.source === 'scheduler'
  }

  /**
   * How many times a person approved the same action in a project in the last 7 days.
   *
   * @param projectId the project.
   * @param id this request, left out.
   * @param action the rendered action.
   * @returns the count.
   */
  private timesApproved(projectId: string, id: string, action: string): number {
    const since = this.options.now() - 7 * 86_400_000
    return this.options.store.approvals.byProject(projectId, 200).filter((row) => {
      if (row.id === id || row.status !== 'granted' || row.decided_by === null || (row.decided_at ?? 0) < since) return false
      try {
        return (JSON.parse(row.request_json) as { action?: string }).action === action
      } catch {
        return false
      }
    }).length
  }

  /**
   * Tell the chat a scheduled run went on without an action, once per run and action,
   * with the command that would allow it (a button when it fits one).
   *
   * @param base the request.
   * @param always the rule that would allow it, when it can be named.
   */
  private async reportBlocked(base: { projectId: string | null; runId: string; action: string }, always: AlwaysRule | undefined): Promise<void> {
    const key = `${base.runId}|${base.action}`
    if (this.blocked.has(key)) return
    this.blocked.add(key)
    const address = this.addressFor(base.projectId, base.runId)
    if (address === undefined || !this.options.channel.canReach(address)) return
    const where = base.projectId === null ? 'A scheduled task' : `A scheduled run of ${base.projectId}`
    const command = always === undefined || base.projectId === null ? undefined : ruleCommand(always, base.projectId)
    // A button's value is cut at 64 bytes on Telegram: a cut rule would allow something else.
    const button = command !== undefined && Buffer.byteLength(command) <= 64 ? [{ ...alwaysButton(always as AlwaysRule, base.projectId as string), value: command }] : []
    try {
      await this.options.channel.send(address, {
        text: `${where} was blocked: ${base.action}\nNobody is asked during a scheduled run, so it went on without it.${command === undefined ? '' : `\nTo allow it from now on (admin): ${command}`}`,
        ...(button.length > 0 ? { buttons: button } : {}),
      })
    } catch (error) {
      this.ctx.logger('ops-approvals').warn('could not report a blocked scheduled action: %s', (error as Error).message)
    }
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
    for (const key of this.blocked) {
      if (key.startsWith(`${runId}|`)) this.blocked.delete(key)
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
