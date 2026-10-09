// == ARGUS AGENT PROJECT ==
/**
 * `ctx.opsProjects` — the agent lifecycle and ownership service.
 *
 * It creates, resumes and disposes every dsh agent in the system, answers "who
 * owns this session?", and emits the lifecycle events the governor and the
 * channel consume.
 *
 * @module @argus-agent/projects/service
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { DoctorFinding, ModelCheck, ModelProblem, ModelRef, ServiceHealth } from '@argus-agent/types'
// Type-only: brings in the `ctx.agentPresets` augmentation.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import { RUN_TRAIL_ACTION, runTrail } from './run-trail.js'
import {
  OpsError,
  ownerKey,
  projectOwner,
  adhocOwner,
  orchestratorOwner,
  type ContentBlockLike,
  type Owner,
} from '@argus-agent/types'
import type { OpsStore } from '@argus-agent/store'
import { CapabilityIssuer, type Capability } from './capability.js'
import { OwnershipMap } from './ownership.js'
import type { ProjectConfig } from './project-config.js'
import type { InvalidProject } from './project-loader.js'
import { projectModelRef } from './project-config.js'

/** What a delivery targets. */
export type AgentTarget =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'adhoc'; readonly runId: string }
  | { readonly kind: 'orchestrator' }

/** A live agent plus what it is. */
interface LiveAgent {
  readonly target: AgentTarget
  readonly owner: Owner
  readonly handle: AgentHandle
  /** Set while a run is open. */
  runId: string | undefined
  /** Session events appended since the run opened, for output extraction. */
  runEvents: SessionEvent[]
  /** Whether the run's turn has produced an assistant message. */
  producing: boolean
}

/** Options for creating an ephemeral agent. */
export interface EphemeralOptions {
  readonly kind: 'adhoc' | 'orchestrator'
  readonly runId: string
  readonly model: { readonly provider: string; readonly model: string }
  /** The working directory. Defaults to `<scratch>/<runId>` or `<scratch>/orchestrator`. */
  readonly cwd?: string
  /** A preset to mount. */
  readonly preset?: string | null
  /** Extra setup, run inside the agent's scope before publication. */
  readonly setup?: (agentCtx: Context, agent: Agent) => void | Promise<void>
}

/** The result of a delivery. */
export interface DeliverResult {
  /** Whether the target agent was running already, so the message queued. */
  readonly queued: boolean
  readonly sessionId: string
}

/**
 * The projects service.
 *
 * Exposed as `ctx.opsProjects`.
 */
export class OpsProjects {
  /** The session ownership map. Public so the meter can resolve owners. */
  readonly ownership = new OwnershipMap()

  private readonly issuer = new CapabilityIssuer()
  private readonly live = new Map<string, LiveAgent>()
  /** Single-flight guards, so two concurrent `ensureAgent` calls share one creation. */
  private readonly pending = new Map<string, Promise<AgentHandle>>()
  private readonly configs = new Map<string, ProjectConfig>()
  private readonly invalid = new Map<string, InvalidProject>()
  private readonly modelChecks = new Set<ModelCheck>()
  /** Re-run the load, so a project is re-checked when a check comes or goes. */
  private reloader: (() => void) | undefined
  private readonly store: OpsStore
  private readonly ctx: Context
  private readonly scratchDir: string
  private readonly projectsRoot: string
  private disposed = false

  constructor(ctx: Context, store: OpsStore, options: { scratchDir: string; projectsRoot: string }) {
    this.ctx = ctx
    this.store = store
    this.scratchDir = options.scratchDir
    this.projectsRoot = options.projectsRoot
  }

  // ── configuration ────────────────────────────────────────────────────────

  /**
   * Replace the in-memory project configuration.
   *
   * Called after a load or a reload. A project no longer present keeps its live
   * agent until the agent is disposed; only its configuration disappears.
   *
   * @param configs the validated configurations.
   */
  setConfigs(configs: readonly ProjectConfig[]): void {
    this.configs.clear()
    for (const config of configs) this.configs.set(config.id, config)
  }

  /**
   * One project's configuration.
   * @param projectId the slug.
   * @returns the configuration, or `undefined`.
   */
  configOf(projectId: string): ProjectConfig | undefined {
    return this.configs.get(projectId)
  }

  /**
   * Replace the set of project files that fail to validate.
   *
   * Those projects are ignored until a load validates them again: no agent is
   * created for them, and a request for one is refused with the reason.
   *
   * @param invalid the invalid projects from the latest load.
   */
  setInvalid(invalid: readonly InvalidProject[]): void {
    this.invalid.clear()
    for (const project of invalid) this.invalid.set(project.id, project)
  }

  /** Every project whose file does not validate, sorted by id. */
  invalidProjects(): InvalidProject[] {
    return [...this.invalid.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Why a project is invalid.
   * @param projectId the slug.
   * @returns the invalid project, or `undefined` when its file is valid or absent.
   */
  invalidOf(projectId: string): InvalidProject | undefined {
    return this.invalid.get(projectId)
  }

  // ── model checks ─────────────────────────────────────────────────────────

  /**
   * Add a configuration-time check every project model must pass: an API key
   * (the providers row), a price (`ops-meter`). A project whose model fails is
   * invalid, with the check's message; the governor refuses any request whose
   * model fails. The projects are re-checked at once and when the check goes.
   *
   * @param check the check.
   * @returns a disposer, for `ctx.effect`.
   */
  addModelCheck(check: ModelCheck): () => void {
    this.modelChecks.add(check)
    this.reload()
    return () => {
      this.modelChecks.delete(check)
      this.reload()
    }
  }

  /**
   * Why a model cannot run, from every registered check, or `undefined`.
   * @param model the model.
   * @returns the first problem.
   */
  checkModel(model: ModelRef): ModelProblem | undefined {
    for (const check of this.modelChecks) {
      const problem = check(model)
      if (problem !== undefined) return problem
    }
    return undefined
  }

  /**
   * `argus doctor`: every project file that does not validate, including a model that
   * cannot run (no key, no price), with the file to fix.
   *
   * @returns the findings.
   */
  doctor(): DoctorFinding[] {
    const invalid = this.invalidProjects()
    if (invalid.length === 0) {
      return [{ ok: true, check: 'the project files', detail: `${this.configuredIds().length} valid` }]
    }
    return invalid.map((project) => ({
      ok: false,
      check: `project ${project.id}`,
      detail: project.reason,
      fix: `edit ${project.path}, then send /reload`,
    }))
  }

  /** Re-check every project's model: something a check reads changed (a price arrived). */
  recheckModels(): void {
    this.reload()
  }

  /** @internal Set by the plugin: how to reload the project files. */
  setReloader(reloader: () => void): void {
    this.reloader = reloader
  }

  private reload(): void {
    if (this.disposed) return
    try {
      this.reloader?.()
    } catch {
      // A reload failure is reported by the load itself; a check change must not throw.
    }
  }

  /** Every configured project id, sorted. */
  configuredIds(): string[] {
    return [...this.configs.keys()].sort()
  }

  // ── capability ───────────────────────────────────────────────────────────

  /**
   * Claim the delivery capability.
   *
   * `ops-governor` calls this at load. Only one holder may exist per process.
   *
   * @param holder the plugin name.
   * @returns the token to pass to {@link deliver}.
   */
  claimDelivery(holder: string): Capability {
    return this.issuer.issue(holder)
  }

  // ── agent lifecycle ──────────────────────────────────────────────────────

  /**
   * Return the live agent for a project, creating or resuming it as needed.
   *
   * Single-flight: concurrent calls for one project share a creation, so two
   * dispatcher passes cannot produce two agents for one project.
   *
   * @param projectId the slug.
   * @returns the agent.
   * @throws {OpsError} `PROJECT_INVALID` when the project's file does not validate.
   * @throws {OpsError} `PROJECT_NOT_FOUND` when the project is not configured.
   */
  async ensureAgent(projectId: string): Promise<Agent> {
    const invalid = this.invalid.get(projectId)
    if (invalid !== undefined) {
      throw new OpsError('PROJECT_INVALID', invalidMessage(invalid), { projectId, path: invalid.path })
    }
    const config = this.configs.get(projectId)
    if (config === undefined) {
      throw new OpsError('PROJECT_NOT_FOUND', `no project ${JSON.stringify(projectId)} is configured`, {
        projectId,
      })
    }

    const existing = this.live.get(projectId)
    if (existing !== undefined) return existing.handle.agent

    const inFlight = this.pending.get(projectId)
    if (inFlight !== undefined) return (await inFlight).agent

    const creation = this.createProjectAgent(config)
    this.pending.set(projectId, creation)
    try {
      const handle = await creation
      return handle.agent
    } finally {
      this.pending.delete(projectId)
    }
  }

  /** Create or resume one project's agent. */
  private async createProjectAgent(config: ProjectConfig): Promise<AgentHandle> {
    const row = this.store.projects.get(config.id)
    const owner = projectOwner(config.id)
    const setup = this.projectSetup(config)

    // Resume when a session is recorded, create otherwise. A resume that fails
    // because the log is gone is not fatal: the project starts a fresh session
    // and the old id is archived in the audit log, so the loss is recorded.
    if (row?.session_id !== null && row?.session_id !== undefined) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: row.session_id as SessionId,
          agentOptions: this.agentOptions(config),
          setup,
        })
        this.adopt(config.id, { kind: 'project', projectId: config.id }, owner, handle)
        return handle
      } catch (error) {
        this.ctx.logger('ops-projects').warn(
          'could not resume session %s for project %s, starting fresh: %s',
          row.session_id,
          config.id,
          (error as Error).message,
        )
        this.store.audit.record(
          {
            actor: 'system',
            action: 'session.resume-failed',
            target: config.id,
            details: { sessionId: row.session_id, error: (error as Error).message },
          },
          Date.now(),
        )
        this.store.projects.setSession(config.id, null, Date.now())
      }
    }

    mkdirSync(config.cwd, { recursive: true })
    const handle = await this.ctx.agents.create({
      sessionId: randomUUID() as SessionId,
      meta: { cwd: config.cwd, ...(config.preset !== null ? { agentPreset: config.preset } : {}) },
      agentOptions: this.agentOptions(config),
      setup,
    })
    this.store.projects.setSession(config.id, handle.agent.id as string, Date.now())
    this.adopt(config.id, { kind: 'project', projectId: config.id }, owner, handle)
    return handle
  }

  /** The `setup` callback a project agent is composed with. */
  private projectSetup(config: ProjectConfig) {
    return async (agentCtx: Context, agent: Agent): Promise<void> => {
      if (config.preset !== null) {
        // The preset decides the tool set; it must be mounted before the agent
        // is published, or its first turn would run without its tools.
        await this.ctx.agentPresets.mount(agentCtx, config.preset)
      }
      // The agent's context goes with the event: a listener that must register a
      // scoped tool needs it, and the session id alone is not enough to reach the
      // scope. Emitted here because this callback is the last moment before the
      // agent is published.
      this.ctx.emit('ops/agent-composed', {
        owner: projectOwner(config.id),
        sessionId: agent.id as string,
        agentCtx,
        agent,
      })
    }
  }

  /** The agent options a project runs with. */
  private agentOptions(config: ProjectConfig): { provider: string; model: string; maxTokens?: number } {
    const ref = projectModelRef(config)
    return {
      provider: ref.provider,
      model: ref.model,
      maxTokens: config.limits.max_tokens_per_request,
    }
  }

  /**
   * A health report.
   *
   * `degraded` when an agent is live but its project has no session recorded, which
   * means the store and the live map have diverged — a state that would make a
   * restart lose track of a running project.
   *
   * @returns the report.
   */
  health(): ServiceHealth {
    // Only a project's session is recorded; the front desk and tasks have none.
    const all = this.listLive()
    const live = all.filter((entry) => entry.target.kind === 'project')
    const recorded = new Set(this.store.projects.list().map((row) => row.session_id).filter((id): id is string => id !== null))
    const unrecorded = live.filter((entry) => !recorded.has(entry.sessionId)).map((entry) => entry.sessionId)
    const details: Record<string, unknown> = {
      liveAgents: all.length,
      running: all.filter((entry) => entry.status === 'running').length,
      projects: this.configuredIds().length,
    }
    if (unrecorded.length > 0) {
      return { status: 'degraded', details: { ...details, reason: 'a live agent has no recorded session', unrecorded } }
    }
    const invalid = this.invalidProjects()
    if (invalid.length > 0) {
      // Degraded, not down: every other project still runs.
      return {
        status: 'degraded',
        details: {
          ...details,
          reason: `${invalid.length} project file(s) invalid and ignored: ${invalid.map((p) => p.id).join(', ')}`,
          invalid,
        },
      }
    }
    return { status: 'ok', details }
  }

  /**
   * Create an ephemeral agent for a one-off task or the orchestrator.
   *
   * @param options what to create.
   * @returns the agent.
   */
  /**
   * The working directory of a one-off task: `<scratch>/<runId>`. Known before the task
   * runs, so a file sent with it can be put where the task will find it.
   *
   * @param runId the task's run id (`adhoc.runId`).
   * @returns the directory.
   */
  taskDirOf(runId: string): string {
    return join(this.scratchDir, runId)
  }

  async createEphemeral(options: EphemeralOptions): Promise<Agent> {
    const owner = options.kind === 'adhoc' ? adhocOwner(options.runId) : orchestratorOwner()
    const key = ownerKey(owner)
    const existing = this.live.get(key)
    if (existing !== undefined) return existing.handle.agent

    const cwd = options.cwd ?? (options.kind === 'adhoc' ? this.taskDirOf(options.runId) : join(this.scratchDir, 'orchestrator'))
    mkdirSync(cwd, { recursive: true })

    const handle = await this.ctx.agents.create({
      sessionId: randomUUID() as SessionId,
      meta: { cwd, ...(options.preset !== null && options.preset !== undefined ? { agentPreset: options.preset } : {}) },
      agentOptions: { provider: options.model.provider, model: options.model.model },
      setup: async (agentCtx, agent) => {
        if (options.preset !== null && options.preset !== undefined) {
          await this.ctx.agentPresets.mount(agentCtx, options.preset)
        }
        await options.setup?.(agentCtx, agent)
      },
    })

    this.adopt(key, this.targetOf(owner), owner, handle)
    return handle.agent
  }

  /** The target descriptor for an owner. */
  private targetOf(owner: Owner): AgentTarget {
    switch (owner.kind) {
      case 'project':
        return { kind: 'project', projectId: owner.projectId }
      case 'adhoc':
        return { kind: 'adhoc', runId: owner.runId }
      case 'orchestrator':
        return { kind: 'orchestrator' }
    }
  }

  /** Register a live agent and wire its events. */
  private adopt(key: string, _target: AgentTarget, owner: Owner, handle: AgentHandle): void {
    const sessionId = handle.agent.id as string
    const entry: LiveAgent = {
      target: this.targetOf(owner),
      owner,
      handle,
      runId: undefined,
      runEvents: [],
      producing: false,
    }
    this.live.set(key, entry)
    this.entryBySession.set(sessionId, entry)
    this.ownership.register(sessionId, owner)
    // A session registered with a run that arrived before it (a meter that saw
    // usage first) picks it up now.
    const pendingRun = this.ownership.get(sessionId)?.runId
    if (pendingRun !== undefined) entry.runId = pendingRun

    const dispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
      this.live.delete(key)
      this.entryBySession.delete(sessionId)
      this.ownership.unregister(sessionId)
      await dispose()
    }
  }

  // ── delivery (governor only) ─────────────────────────────────────────────

  /**
   * Deliver content to an agent and open a run.
   *
   * **Governor only.** Requires the capability token from
   * {@link claimDelivery}; any other caller gets `GOVERNOR_REQUIRED`.
   *
   * @param capability the governor's token.
   * @param target what to deliver to.
   * @param content the content blocks, forwarded verbatim.
   * @param options the run id and the message source.
   * @returns whether the message queued behind a running turn.
   * @throws {OpsError} `GOVERNOR_REQUIRED` without the token.
   */
  async deliver(
    capability: Capability,
    target: AgentTarget,
    content: readonly ContentBlockLike[],
    options: { runId: string; source?: 'channel' | 'scheduler' | 'orchestrator' },
  ): Promise<DeliverResult> {
    this.issuer.assertCapability(capability, 'ops-projects.deliver')

    const key = this.keyOf(target)
    const entry = this.live.get(key)
    if (entry === undefined) {
      throw new OpsError('PROJECT_NOT_FOUND', `no live agent for ${key}`, { target: key })
    }

    const agent = entry.handle.agent
    const wasRunning = agent.status === 'running'

    // Open the run before the message lands, so a status transition that races
    // the delivery still finds a run to close.
    if (entry.runId === undefined) {
      entry.runId = options.runId
      entry.runEvents = []
      entry.producing = false
      this.ownership.setRun(agent.id as string, options.runId)
    }

    agent.followup({
      id: randomUUID() as never,
      role: 'user',
      content: content as never,
      source: { kind: options.source ?? 'channel' } as never,
    })

    return { queued: wasRunning, sessionId: agent.id as string }
  }

  /**
   * Cancel a session's current turn, by session id.
   *
   * The governor holds session ids, not targets, so this is the entry point its
   * kill switch and its `stop()` use. A subagent's id resolves to its root, so
   * cancelling a child cancels the project turn it belongs to.
   *
   * @param sessionId the session.
   * @returns whether a live agent was found and cancelled.
   */
  cancelSession(sessionId: string): boolean {
    const root = this.ownership.rootOf(sessionId, (id) => this.parentSessionOf(id)) ?? sessionId
    const entry = this.entryBySession.get(root)
    if (entry === undefined) return false
    entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    return true
  }

  /**
   * Cancel an agent's current turn.
   *
   * `keepInbox: true` preserves queued work, so a cancel stops the turn without
   * discarding messages that have not started.
   *
   * @param target what to cancel.
   * @returns whether a live agent was cancelled.
   */
  cancel(target: AgentTarget): boolean {
    const entry = this.live.get(this.keyOf(target))
    if (entry === undefined) return false
    entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    return true
  }

  /**
   * Dispose a project's agent and start a fresh session next time.
   *
   * The old session id is archived in the audit log, so a reset is visible
   * rather than a silent loss.
   *
   * @param projectId the slug.
   * @param actor who asked.
   */
  async reset(projectId: string, actor = 'system'): Promise<void> {
    const entry = this.live.get(projectId)
    const previous = this.store.projects.get(projectId)?.session_id ?? null
    if (entry !== undefined) {
      this.live.delete(projectId)
      this.entryBySession.delete(entry.handle.agent.id as string)
      await entry.handle.dispose()
    }
    this.store.projects.setSession(projectId, null, Date.now())
    this.store.audit.record(
      { actor, action: 'project.reset', target: projectId, details: { previousSession: previous } },
      Date.now(),
    )
  }

  /**
   * Change a project's model at runtime.
   *
   * The override lives in the database, so a configuration reload reverts it.
   * A **live** agent does not pick it up: dsh fixes the model at creation
   * (SPIKES.md spike 3), so the change applies to the next agent — a `reset`
   * makes it immediate.
   *
   * @param projectId the slug.
   * @param model the new model id.
   * @param actor who asked.
   * @returns whether the project exists.
   */
  setModel(projectId: string, model: string, actor = 'system'): boolean {
    if (this.store.projects.get(projectId) === undefined) return false
    const now = Date.now()
    this.store.projects.setModel(projectId, model, now)
    this.store.audit.record(
      { actor, action: 'project.model-changed', target: projectId, details: { model } },
      now,
    )
    return true
  }

  // ── run tracking ─────────────────────────────────────────────────────────

  /**
   * Whether a target's agent is running.
   * @param target the target.
   * @returns whether it is live and running.
   */
  isRunning(target: AgentTarget): boolean {
    const entry = this.live.get(this.keyOf(target))
    return entry !== undefined && entry.handle.agent.status === 'running'
  }

  /**
   * The owner of a session, walking parents for a subagent.
   *
   * @param sessionId the session.
   * @returns the owner, or `undefined` when the session is unknown.
   */
  ownerOf(sessionId: string): Owner | undefined {
    return this.ownership.resolve(sessionId, (id) => this.parentSessionOf(id))?.owner
  }

  /**
   * The root session a session resolves to.
   *
   * The meter records usage under the ROOT session, so a subagent's requests are
   * attributed to the project rather than appearing to come from nowhere. The
   * fallback to the session's own id means a session with no registered root —
   * one from another plugin — is still metered, under itself.
   *
   * @param sessionId the session.
   * @returns the root session id.
   */
  rootSessionOf(sessionId: string): string {
    return this.ownership.rootOf(sessionId, (id) => this.parentSessionOf(id)) ?? sessionId
  }

  /**
   * The run a session's usage belongs to.
   * @param sessionId the session.
   * @returns the run id, or `undefined`.
   */
  runOf(sessionId: string): string | undefined {
    return this.ownership.resolve(sessionId, (id) => this.parentSessionOf(id))?.runId
  }

  /** Read a session's durable parent header, when the session is live. */
  private parentSessionOf(sessionId: string): string | undefined {
    const session = this.ctx.sessions.get(sessionId as SessionId)
    return session?.header.parentSession as string | undefined
  }

  /**
   * Record a parent link for an in-process subagent.
   *
   * Called from the `agent/created` listener when a child appears with an owner.
   *
   * @param childSessionId the child session.
   * @param parentSessionId the parent session.
   */
  linkSubagent(childSessionId: string, parentSessionId: string): void {
    this.ownership.linkChild(childSessionId, parentSessionId)
  }

  /**
   * The live agent for a target.
   * @param target the target.
   * @returns the agent, or `undefined`.
   */
  agentFor(target: AgentTarget): Agent | undefined {
    return this.live.get(this.keyOf(target))?.handle.agent
  }

  /** Every live agent's target and status, for diagnostics. */
  listLive(): Array<{ target: AgentTarget; sessionId: string; status: string; runId: string | undefined }> {
    return [...this.live.values()].map((entry) => ({
      target: entry.target,
      sessionId: entry.handle.agent.id as string,
      status: entry.handle.agent.status,
      runId: entry.runId,
    }))
  }

  // ── run output ───────────────────────────────────────────────────────────

  /**
   * Observe one session event, for run-output extraction.
   *
   * Called by the plugin's `session/event` listener. It accumulates the events a
   * run produced so that, when the run ends, the final assistant content can be
   * extracted without re-reading the whole log.
   *
   * @param sessionId the session the event came from.
   * @param event the event.
   */
  observe(sessionId: string, event: SessionEvent): void {
    const entry = this.entryForSession(sessionId)
    if (entry === undefined || entry.runId === undefined) return
    entry.runEvents.push(event)
    if (event.type === 'assistant/message') entry.producing = true
  }

  /**
   * Find the live entry a session belongs to.
   *
   * `live` is keyed by the TARGET (a project id, an owner key), not by session
   * id, so the lookup goes through the ownership map: resolve the session to its
   * root, then map that root session back to its entry. The index is what makes
   * this O(1) rather than a scan of every live agent.
   */
  private entryForSession(sessionId: string): LiveAgent | undefined {
    const bySession = this.entryBySession.get(sessionId)
    if (bySession !== undefined) return bySession

    // A subagent is not in the index; walk to the root session, which is.
    const root = this.ownership.rootOf(sessionId, (id) => this.parentSessionOf(id))
    return root === undefined ? undefined : this.entryBySession.get(root)
  }

  /** Live entries indexed by their root session id. */
  private readonly entryBySession = new Map<string, LiveAgent>()

  /**
   * Close a run and emit its output.
   *
   * @param sessionId the session that went idle. The live map is keyed by the
   *   target, so the entry is found by walking to the session's root — the same
   *   path `ownerOf` takes.
   * @returns whether a run was closed.
   */
  finishRun(sessionId: string): boolean {
    const entry = this.entryForSession(sessionId)
    if (entry === undefined || entry.runId === undefined) return false

    const runId = entry.runId
    const events = entry.runEvents
    const content = finalAssistantOutput(events) ?? []
    const owner = entry.owner
    const rootSession = entry.handle.agent.id as string
    entry.runId = undefined
    entry.runEvents = []
    entry.producing = false
    this.ownership.clearRun(rootSession)

    // What the run did, for /log. A trail is a convenience: failing to write it must
    // not lose the run's output.
    try {
      const reply = (content as ReadonlyArray<{ type?: string; text?: string }>)
        .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
        .join('\n')
      this.store.audit.record({ actor: 'agent', action: RUN_TRAIL_ACTION, target: `run:${runId}`, details: { ...runTrail(events, reply) } }, Date.now())
    } catch (error) {
      this.ctx.logger('ops-projects').warn('could not record the trail of run %s: %s', runId, error instanceof Error ? error.message : String(error))
    }

    this.ctx.emit('ops/run-output', {
      owner,
      sessionId: rootSession,
      runId,
      content: content as unknown as readonly ContentBlockLike[],
    })
    return true
  }

  // ── teardown ─────────────────────────────────────────────────────────────

  /** Dispose every live agent. */
  async disposeAll(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.issuer.revokeAll()
    const handles = [...this.live.values()].map((entry) => entry.handle)
    this.live.clear()
    this.entryBySession.clear()
    this.ownership.clear()
    await Promise.allSettled(handles.map((handle) => handle.dispose()))
  }

  private keyOf(target: AgentTarget): string {
    switch (target.kind) {
      case 'project':
        return target.projectId
      case 'adhoc':
        return ownerKey(adhocOwner(target.runId))
      case 'orchestrator':
        return 'orchestrator'
    }
  }
}

/**
 * The message a request for an invalid project is refused with.
 *
 * @param project the invalid project.
 * @returns the message: which file, what is wrong, how to bring it back.
 */
export function invalidMessage(project: InvalidProject): string {
  return (
    `project "${project.id}" is ignored: ${project.path} does not validate.\n` +
    `${project.reason}\n` +
    'Fix the file, then send /reload.'
  )
}
