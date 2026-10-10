// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/orchestrator/service` — `ctx.opsOrchestrator`.
 *
 * One agent, created through `opsProjects.createEphemeral({ kind: 'orchestrator' })`,
 * with five tools and nothing else. It runs through the governor like everything
 * else, so its spending is metered and its turns are bounded.
 *
 * @module @argus-agent/orchestrator/service
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ChannelAddress, DoctorFinding, ModelRef, ServiceHealth } from '@argus-agent/types'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import { buildTools, type ToolHost } from './tools.js'
import { orchestratorRestriction, orchestratorToolNames } from './preset.js'
import { splitModelRef, type OrchestratorSection } from './config.js'
import { systemPrompt } from './prompt.js'

/** Options for the service. */
export interface OrchestratorOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly config: OrchestratorSection
  /** Where the orchestrator's own scratch folder lives. */
  readonly scratchDir: string
  /** Reads the current time; injected so tests control it. */
  readonly now: () => number
}

/** How many received messages the desk remembers for forwarding. */
const RECEIVED_CAP = 100

/** What an incoming free-text message carries. */
export interface OrchestratorRequest {
  readonly messageRef: string
  readonly address: ChannelAddress
  readonly userId: string
  readonly text: string
  readonly attachments: readonly string[]
}

/**
 * The orchestrator.
 *
 * Exposed as `ctx.opsOrchestrator`.
 */
export class OpsOrchestrator {
  private agent: Agent | undefined
  private creating: Promise<Agent> | undefined
  /** The turn currently in flight, so a tool knows which message it is routing. */
  private current: OrchestratorRequest | undefined
  /**
   * The text of the messages this desk received, by `messageRef`. Nothing writes a
   * free-text message to the store, so this is where a forwarding tool finds the
   * person's exact words.
   *
   * ponytail: in memory and capped at {@link RECEIVED_CAP}; a restart forgets them,
   * so a message from before it cannot be forwarded (the person sends it again).
   */
  private readonly received = new Map<string, string>()
  /** The reply a turn produced. */
  private reply: string | undefined
  /** `/defaults frontdesk`, until a restart reads it from `ops.yaml`. */
  private modelOverride: string | undefined
  /** Whether the agent was created on a model `setModel` has since replaced. */
  private modelChanged = false
  /** The day the session was last reset, for `reset_daily`. */
  private sessionDay: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly options: OrchestratorOptions,
  ) {}

  // ── the agent ────────────────────────────────────────────────────────────

  /**
   * The orchestrator agent, created on first use.
   *
   * Single-flight, like `opsProjects.ensureAgent`: two messages arriving together
   * must not create two orchestrators, which would double its cost and split its
   * conversation.
   *
   * @returns the agent.
   */
  async ensureAgent(): Promise<Agent> {
    await this.resetIfNewDay()
    if (this.modelChanged && this.creating === undefined) {
      this.modelChanged = false
      await this.reset()
    }
    if (this.agent !== undefined) return this.agent
    if (this.creating !== undefined) return this.creating

    this.creating = this.options.projects
      .createEphemeral({
        kind: 'orchestrator',
        runId: 'orchestrator',
        model: this.modelRef(),
        preset: this.options.config.preset,
        setup: (agentCtx) => this.install(agentCtx),
      })
      .then((agent) => {
        this.agent = agent
        this.creating = undefined
        return agent
      })
      .catch((error: unknown) => {
        this.creating = undefined
        throw error
      })

    return this.creating
  }

  /**
   * Install the tools and the restriction into the agent's scope.
   *
   * Both happen here, in the same callback, because a scope's own registrations
   * are exempt from its restriction (SPIKES.md spike 6). Registering elsewhere and
   * restricting here would leave the tools removable by the restriction.
   *
   * @param agentCtx the agent's context.
   */
  private install(agentCtx: Context): void {
    // The restriction is applied FIRST so it narrows the inherited surface before
    // anything of ours is added — and so a failure (an unknown name in `allow`)
    // happens before the tools exist, rather than after a half-working scope.
    const lift = agentCtx.tools.restrict(orchestratorRestriction())
    agentCtx.effect(() => lift)

    for (const tool of buildTools(this.host())) {
      agentCtx.effect(() => agentCtx.tools.register(tool))
    }
  }

  /**
   * The tool host.
   *
   * `messageRef` and `address` are **getters**, not values: the tools are built
   * once when the agent is created, but a tool call happens during a specific
   * turn. A captured value would route every message with the first turn's
   * reference — which is the one bug that would make verbatim forwarding silently
   * wrong rather than loudly broken.
   */
  private host(): ToolHost {
    const options = this.options
    const service = {
      current: (): OrchestratorRequest | undefined => this.current,
    }
    return {
      get messageRef(): string | undefined {
        return service.current()?.messageRef
      },
      get address(): { readonly channel: string; readonly chatId: string } | undefined {
        return service.current()?.address
      },
      config: options.config,
      listProjects: () =>
        options.projects.configuredIds().map((id) => {
          const config = options.projects.configOf(id)
          return {
            id,
            description: config?.description ?? null,
            status: options.store.projects.get(id)?.status ?? 'active',
            model: options.store.projects.get(id)?.model ?? config?.model ?? '?',
          }
        }),
      resolveRef: (ref) => this.resolveRef(ref),
      sendToProject: ({ projectId, text, messageRef }) => {
        const address = this.current?.address
        const cwd = options.projects.configOf(projectId)?.cwd
        return options.governor.submit({
          source: 'channel',
          target: { projectId },
          content: [{ type: 'text', text }, ...(cwd === undefined ? [] : this.attachInto(cwd))],
          priority: 0,
          ...(address === undefined ? {} : { replyTo: address }),
          ...(messageRef.length === 0 ? {} : {}),
        })
      },
      runTask: ({ text, model, messageRef }) => {
        const address = this.current?.address
        const chosen = model === undefined ? undefined : splitModelRef(model)
        const runId = `task-${this.options.now().toString(36)}`
        return options.governor.submit({
          source: 'channel',
          target: {
            adhoc: {
              runId,
              ...(chosen === undefined ? {} : { model: chosen }),
            },
          },
          content: [{ type: 'text', text }, ...this.attachInto(options.projects.taskDirOf(runId))],
          priority: 0,
          ...(address === undefined ? {} : { replyTo: address }),
          ...(chosen === undefined ? {} : { model: chosen }),
          ...(messageRef.length === 0 ? {} : {}),
        })
      },
      setActiveProject: (projectId) => {
        const address = this.current?.address
        if (address === undefined) return
        options.store.chatContext.setActive(address.channel, address.chatId, projectId, options.now())
      },
      projectStatus: (projectId) => {
        const config = options.projects.configOf(projectId)
        const row = options.store.projects.get(projectId)
        if (config === undefined && row === undefined) return { found: false }
        const running = options.governor.status().running.find(
          (run) => run.owner.kind === 'project' && run.owner.projectId === projectId,
        )
        const spending = options.meter.spending(`project:${projectId}` as never)
        const budget = options.governor.budgetState(`project:${projectId}` as never)
        return {
          found: true,
          status: row?.status ?? 'active',
          model: row?.model ?? config?.model ?? '?',
          running: running !== undefined,
          steps: running?.steps ?? 0,
          dayMicros: spending.dayMicros,
          monthMicros: spending.monthMicros,
          budgetLevel: budget.level,
        }
      },
      usageSummary: (period) => {
        const labels = options.meter.currentLabels()
        const from = period === 'day' ? labels.day : `${labels.month}-01`
        return options.meter
          .report({ fromDay: from, toDay: labels.day })
          .byScope.map((row) => ({
            scope: row.scope,
            costMicros: row.cost_micros,
            requests: 0,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
          }))
      },
      answer: (text) => {
        this.reply = text
      },
    }
  }

  /** Resolve a message reference to its stored text. */
  private resolveRef(ref: string): { readonly text: string; readonly projectId: string | null } | undefined {
    const text = this.received.get(ref)
    if (text !== undefined) return { text, projectId: null }
    const row = this.options.store.inbound.get(ref)
    if (row === undefined) return undefined
    const payload = parsePayload(row.payload)
    return {
      text: payload?.text ?? '',
      projectId: row.project_id,
    }
  }

  // ── turns ────────────────────────────────────────────────────────────────

  /**
   * Handle one incoming free-text message.
   *
   * @param request the message.
   * @returns the reply, or `undefined` when the orchestrator produced none.
   */
  async submit(request: OrchestratorRequest): Promise<string | undefined> {
    await this.resetIfNewDay()
    const agent = await this.ensureAgent()

    this.current = request
    this.received.set(request.messageRef, request.text)
    if (this.received.size > RECEIVED_CAP) this.received.delete(this.received.keys().next().value as string)
    this.reply = undefined

    // The turn is awaited through `ops/agent-idle`, which `ops-projects` emits
    // when the agent's session goes idle — the same signal the governor uses to
    // release a slot. Waiting on the agent object directly would need its runtime
    // handle, which the projects service owns.
    const sessionId = agent.id as string
    /**
     * Resolve when this session goes idle.
     *
     * The listener is registered with `ctx.on` but **not** removed with `ctx.off`:
     * `off` requires its own `inject` declaration and throws without it, and the
     * throw happens inside Cordis's emitter — so the failure is invisible and the
     * promise simply never settles. Instead the listener is made inert by a flag,
     * and the plugin's `ctx.effect` removes the whole listener set on unload.
     */
    let settled = false
    const idle = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('the orchestrator turn did not go idle within 60s'))
      }, 60_000)
      timer.unref?.()
      this.ctx.on('ops/agent-idle', (payload: { readonly sessionId: string }) => {
        if (settled || payload.sessionId !== sessionId) return
        settled = true
        clearTimeout(timer)
        resolve()
      })
    })

    try {
      agent.followup({
        id: crypto.randomUUID() as never,
        role: 'user',
        content: [{ type: 'text', text: promptFor(request) } as never],
        source: { kind: 'channel' } as never,
      })
      await idle
    } finally {
      this.current = undefined
    }

    const reply = this.reply
    this.reply = undefined
    return reply
  }

  /** The reply the last turn produced, for diagnostics. */
  get lastReply(): string | undefined {
    return this.reply
  }

  /** Whether an agent exists. */
  get isLive(): boolean {
    return this.agent !== undefined
  }

  /** The agent, when one exists. */
  get currentAgent(): Agent | undefined {
    return this.agent
  }

  // ── context hygiene ──────────────────────────────────────────────────────

  /**
   * Reset the session when the day changes.
   *
   * Compaction alone leaves a long-lived session holding yesterday's project
   * output, which is both stale and a growing distraction. A daily reset is a hard
   * bound: the orchestrator forgets the conversation, and the things it is asked
   * to do are one-shot anyway.
   *
   * @returns whether a reset happened.
   */
  async resetIfNewDay(): Promise<boolean> {
    if (!this.options.config.reset_daily) return false
    const today = dayOf(this.options.now())
    if (this.sessionDay === undefined) {
      this.sessionDay = today
      return false
    }
    if (this.sessionDay === today) return false

    this.sessionDay = today
    await this.reset()
    this.ctx.logger('ops-orchestrator').info('orchestrator session reset for %s', today)
    return true
  }

  /** The front desk's model, as `provider/model`: `/defaults frontdesk`, else `orchestrator.model`. */
  currentModel(): string {
    return this.modelOverride ?? this.options.config.model
  }

  /**
   * Change the front desk's model. dsh fixes a model when an agent is created, so
   * the next message drops the current agent and starts a fresh one on the new
   * model; a turn already running finishes on the old one. `/defaults` writes the
   * same value to `ops.yaml`, so a restart keeps it.
   *
   * @param model the model, as `provider/model`.
   */
  setModel(model: string): void {
    this.modelOverride = model
    this.modelChanged = true
  }

  /** Dispose the agent, so the next turn starts a fresh conversation. */
  async reset(): Promise<void> {
    const agent = this.agent
    this.agent = undefined
    if (agent === undefined) return
    await this.options.projects.reset('orchestrator').catch(() => undefined)
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** The orchestrator's model. */
  private modelRef(): ModelRef {
    return splitModelRef(this.currentModel()) ?? { provider: 'deepseek', model: 'deepseek-flash' }
  }

  /**
   * A health report.
   *
   * `degraded` when an agent is live but exposes more than the six allowed tools,
   * which is the one property here that depends on another component's behaviour —
   * a preset change or a dsh upgrade could add one.
   *
   * @returns the report.
   */
  /**
   * Copy the current message's attachments into `<dir>/inbox/`, where the agent that
   * gets the work can read them, and say where each one is: the same block the channel
   * adds when a file is sent straight to a project.
   *
   * @param dir the working directory of the project or task.
   * @returns one text block per attachment.
   */
  private attachInto(dir: string): Array<{ type: 'text'; text: string }> {
    const attachments = this.current?.attachments ?? []
    if (attachments.length === 0) return []
    const inbox = join(dir, 'inbox')
    mkdirSync(inbox, { recursive: true })
    return attachments.map((path) => {
      const target = join(inbox, basename(path))
      copyFileSync(path, target)
      return { type: 'text' as const, text: `Attached file saved at ${target}` }
    })
  }

  /**
   * `argus doctor`: can the orchestrator answer free text. Its model is checked like
   * a project's (a provider route, a key, a price).
   *
   * @returns the finding.
   */
  async doctor(): Promise<DoctorFinding[]> {
    const model = this.modelRef()
    await this.options.meter.ensurePriced(model)
    const problem = this.options.projects.checkModel(model)
    return [
      problem === undefined
        ? { ok: true, check: 'the orchestrator model', detail: this.currentModel() }
        : { ok: false, check: 'the orchestrator model', detail: problem.message, fix: `set orchestrator.model in ops.yaml to a model you have a key for (now ${this.currentModel()}), or send /defaults frontdesk <provider/model>` },
    ]
  }

  health(): ServiceHealth {
    const live = this.agent !== undefined
    const details: Record<string, unknown> = {
      agent: live,
      allowedTools: this.allowedTools().length,
      model: this.currentModel(),
    }
    if (live) {
      const visible = this.visibleTools()
      details['visibleTools'] = visible
      if (visible.length > this.allowedTools().length) {
        return {
          status: 'degraded',
          details: { ...details, reason: 'the orchestrator agent exposes tools it should not' },
        }
      }
    }
    return { status: 'ok', details }
  }

  /** The system prompt, exposed so a test can assert its rules. */
  get prompt(): string {
    return systemPrompt()
  }

  /**
   * The tool names this package registers for the orchestrator.
   *
   * Not the restriction's `allow` list: that narrows the **inherited** surface and
   * is deliberately empty. The orchestrator's own six tools are exempt from it.
   *
   * @returns the names.
   */
  allowedTools(): readonly string[] {
    return orchestratorToolNames()
  }

  /**
   * The tools visible to the orchestrator agent, by name.
   *
   * Uses the **scope-aware** lookup (`ctx.tools.get(name, scopeOf(agentCtx))`),
   * which is what the model is actually offered — the global registry would list
   * every tool in the process, including ones this agent cannot see (SPIKES.md
   * spike 6).
   *
   * The registry has no public "list the visible names" call, so each candidate is
   * probed: the orchestrator's own six, plus any name a caller passes to check for
   * leakage. A tool that reads as present when it should have been restricted away
   * is exactly the failure this exists to catch.
   *
   * @param candidates extra names to probe, for a leakage check.
   * @returns the visible tool names, sorted.
   */
  visibleTools(candidates: readonly string[] = []): string[] {
    const agent = this.agent
    if (agent === undefined) return []
    const agentCtx = (agent as unknown as { ctx?: Context }).ctx
    if (agentCtx === undefined) return []
    const scope = scopeOf(agentCtx)
    if (scope === undefined) return []

    const probes = new Set<string>([...this.allowedTools(), ...candidates])
    const visible: string[] = []
    for (const name of probes) {
      if (agentCtx.tools.get(name, scope) !== undefined) visible.push(name)
    }
    return visible.sort()
  }
}

/** The prompt an incoming message becomes. */
export function promptFor(request: OrchestratorRequest): string {
  const lines = [
    `messageRef: ${request.messageRef}`,
    `from: ${request.userId} on ${request.address.channel}`,
    '',
    'The person wrote:',
    request.text,
  ]
  if (request.attachments.length > 0) {
    lines.push('', 'They also attached:', ...request.attachments.map((path) => `  ${path}`))
  }
  return lines.join('\n')
}

/** Parse an inbound payload envelope for its text. */
function parsePayload(payload: string): { readonly text: string } | undefined {
  try {
    const parsed = JSON.parse(payload) as { content?: Array<{ type: string; text?: string }> }
    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
    return { text }
  } catch {
    return undefined
  }
}

/** The calendar day of a timestamp, in UTC. */
function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

export { scopeOf }