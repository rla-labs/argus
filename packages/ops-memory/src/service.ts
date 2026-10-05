// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/memory/service` — `ctx.opsMemory`.
 *
 * # The isolation argument
 *
 * The prompt asks for this explicitly, so here it is in full.
 *
 * There is **exactly one** path from a tool call to a file:
 *
 * ```
 *   memory_update({ section, content, mode })        ← the model's arguments
 *                    │
 *                    │  the project is NOT an argument
 *                    ▼
 *   ownerOf(agent.session.id)                        ← the calling agent's identity
 *                    │
 *                    ▼
 *   projectStateDir(dataDir, projectId)              ← validates the id pattern
 *                    │
 *                    ▼
 *   ${data_dir}/state/<projectId>/MEMORY.md
 * ```
 *
 * Three properties make crossing projects impossible:
 *
 * 1. **The project comes from the agent's identity, never from an argument.** A
 *    tool that accepted a `projectId` would be forgeable by the model, which is
 *    exactly the mistake AGENTS.md rule 6 forbids. Here, the worst a crafted
 *    argument can do is change a section *within the caller's own memory*.
 * 2. **The id is validated before it reaches `join`.** `projectStateDir` refuses an
 *    id that is not `^[a-z0-9][a-z0-9-]{1,40}$`, so a `../` could not be turned into
 *    a path even if resolution were somehow wrong. Defence in depth, because the
 *    cost of the second check is one regex.
 * 3. **The tools are registered only on a project agent's scope.** An ad-hoc or
 *    orchestrator agent has no `memory_update` at all, so there is no call to make.
 *
 * `recall` follows the same three properties against `recall.sqlite`.
 *
 * @module @argus-agent/memory/service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { userMessage } from '@argus-agent/types'
import type { ServiceHealth } from '@argus-agent/types'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsStore } from '@argus-agent/store'
import type { MemorySection } from './config.js'
import {
  applyUpdate,
  diffSummary,
  parseMemory,
  readMemoryFile,
  writeMemoryFileAtomic,
} from './memory-file.js'
import { estimateTokens, memoryFile, projectStateDir, recallFile, userProfileFile } from './paths.js'
import { RecallIndex, snippet, type RecallHit } from './recall.js'
import { composeInjection, hasContent, type Injection } from './truncate.js'
import './events.js'

/** Options for the service. */
export interface MemoryOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly config: MemorySection
  readonly dataDir: string
  /** Reads the current time. */
  readonly now: () => number
}

/** What an agent's identity resolves to. */
export type MemoryScope =
  | { readonly kind: 'project'; readonly projectId: string }
  /** An ad-hoc task or the orchestrator: the user profile only. */
  | { readonly kind: 'user-only'; readonly reason: string }

/**
 * The memory service.
 *
 * Exposed as `ctx.opsMemory`.
 */
export class OpsMemory {
  /** One recall index per project, opened lazily. */
  private readonly indexes = new Map<string, RecallIndex>()
  /** Injection counts by scope, for health. */
  readonly injections = new Map<string, number>()
  /**
   * Scopes established before the projects service could answer.
   *
   * Written by {@link noteScope} from `ops/agent-composed`, which carries the owner
   * because the ownership map is not populated yet at that point in the lifecycle.
   */
  private readonly knownScopes = new Map<string, MemoryScope>()
  /** How many injections were truncated. */
  truncated = 0

  constructor(
    private readonly ctx: Context,
    private readonly options: MemoryOptions,
  ) {}

  // ── scope resolution: the isolation boundary ─────────────────────────────

  /**
   * What an agent may reach.
   *
   * **The only place a project is decided.** It reads the agent's session id and
   * asks the projects service who owns it — never a tool argument, never a session
   * header the model could influence.
   *
   * @param agent the calling agent.
   * @returns the scope.
   */
  scopeOf(agent: Agent): MemoryScope {
    const sessionId = agent.id as string
    // A scope established from the OWNER the caller already resolved. This exists
    // because `ops-projects` adopts an agent only after `ctx.agents.create()`
    // resolves, so during `setup` — the one moment a plugin can register a scoped
    // tool and inject context — `ownerOf` does not answer yet.
    const known = this.knownScopes.get(sessionId)
    if (known !== undefined) return known
    const owner = this.options.projects.ownerOf(sessionId)
    if (owner === undefined) {
      // An agent this service does not know about. It gets the user profile and
      // nothing else: defaulting to a project would be an isolation failure, and
      // defaulting to nothing is the safe reading of "unknown".
      return { kind: 'user-only', reason: 'the agent has no registered owner' }
    }
    if (owner.kind !== 'project') {
      return { kind: 'user-only', reason: `${owner.kind} agents receive the user profile only` }
    }
    return { kind: 'project', projectId: owner.projectId }
  }

  /**
   * Record what an agent's scope is, before the projects service can answer.
   *
   * @param sessionId the agent's session.
   * @param scope the scope.
   */
  noteScope(sessionId: string, scope: MemoryScope): void {
    this.knownScopes.set(sessionId, scope)
  }

  // ── files ────────────────────────────────────────────────────────────────

  /** A project's `MEMORY.md` path. */
  memoryPath(projectId: string): string {
    return memoryFile(this.options.dataDir, projectId)
  }

  /** A project's `recall.sqlite` path. */
  recallPath(projectId: string): string {
    return recallFile(this.options.dataDir, projectId)
  }

  /** The global user profile's path. */
  userProfilePath(): string {
    return userProfileFile(this.options.dataDir)
  }

  /** Read a project's memory text. */
  readMemory(projectId: string): string {
    return readMemoryFile(this.memoryPath(projectId))
  }

  /** Read the global user profile. */
  readUserProfile(): string {
    return readMemoryFile(this.userProfilePath())
  }

  /**
   * Write the global user profile.
   *
   * Exposed for a future `/memory` command; there is no tool for it, so a project's
   * agent cannot change the operator's preferences.
   *
   * @param text the new profile.
   * @returns the bytes written.
   */
  writeUserProfile(text: string): number {
    writeMemoryFileAtomic(this.userProfilePath(), text.endsWith('\n') ? text : `${text}\n`)
    const bytes = Buffer.byteLength(text, 'utf8')
    this.ctx.logger('ops-memory').info('user profile written (%d bytes)', bytes)
    return bytes
  }

  // ── injection ────────────────────────────────────────────────────────────

  /**
   * Build what an agent should receive.
   *
   * @param scope what the agent may reach.
   * @returns the injection.
   */
  compose(scope: MemoryScope): Injection {
    const profileEnabled = this.options.config.user_profile
    const profile = profileEnabled ? this.readUserProfile() : ''

    if (scope.kind === 'user-only') {
      // The profile alone. No project sections, and the budget still applies to it
      // — an enormous `USER.md` is truncated by the same rule.
      return composeInjection({
        userProfile: profile,
        sections: [],
        maxTokens: this.options.config.max_inject_tokens,
        estimate: estimateTokens,
      })
    }

    const config = this.options.projects.configOf(scope.projectId)
    // A project may opt out of the profile; it may not opt into another's memory.
    const profileForProject = profileEnabled && (config?.memory.user_profile ?? true) ? profile : ''

    return composeInjection({
      userProfile: profileForProject,
      sections: parseMemory(this.readMemory(scope.projectId)).sections,
      maxTokens: this.options.config.max_inject_tokens,
      projectId: scope.projectId,
      estimate: estimateTokens,
    })
  }

  /**
   * Inject memory into an agent.
   *
   * Called from `agent/created`, which carries dsh's `SessionStartSource`:
   * `'startup'`, `'resume'`, `'clear'` or **`'compact'`**. That last one is why
   * memory survives a compaction: when dsh replaces the session, the agent is
   * recreated and this runs again, so the injected block is present in the new
   * context rather than only in the one that was summarised away.
   *
   * @param agent the agent.
   * @param source why the session started.
   * @returns what was injected.
   */
  injectInto(agent: Agent, source: string): Injection {
    const scope = this.scopeOf(agent)
    const injection = this.compose(scope)

    if (hasContent(injection)) {
      // `inject()` queues model-facing context for the next pre-step. It does not
      // wake the driver, which is right here: the agent is about to run anyway.
      agent.inject(userMessage(crypto.randomUUID(), injection.text))
    }

    const key = scope.kind === 'project' ? 'project' : 'user-only'
    this.injections.set(key, (this.injections.get(key) ?? 0) + 1)
    if (injection.truncated) this.truncated += 1

    this.ctx.emit('ops/memory-injected', {
      sessionId: agent.id as string,
      projectId: scope.kind === 'project' ? scope.projectId : null,
      scope: scope.kind === 'project' ? 'project' : hasContent(injection) ? 'user-only' : 'none',
      source,
      tokens: injection.tokens,
      included: injection.included,
      omitted: injection.omitted,
      truncated: injection.truncated,
    })

    if (injection.truncated) {
      this.ctx
        .logger('ops-memory')
        .warn('memory for %s was truncated: omitted %s', agent.id as string, injection.omitted.join(', '))
    }

    return injection
  }

  // ── the tools ────────────────────────────────────────────────────────────

  /**
   * The tools registered on a **project** agent's scope.
   *
   * Two tools, and both resolve the project from the calling agent. An ad-hoc or
   * orchestrator agent never receives these definitions, so it has nothing to call.
   *
   * @param agent the agent they are registered for.
   * @returns the definitions.
   */
  projectTools(agent: Agent): ToolDefinition[] {
    return [this.updateTool(agent), this.recallTool(agent)]
  }

  /** `memory_update`. */
  private updateTool(agent: Agent): ToolDefinition {
    return defineTool({
      name: 'memory_update',
      description:
        'Update this project\'s memory: a markdown file of `##` sections that persists across sessions. Use it to record decisions, conventions and things learned. There is no project argument — you can only change your own project\'s memory.',
      parameters: {
        section: {
          type: 'string',
          description: 'The `##` section to write, e.g. "Build" or "Conventions".',
          required: true,
        },
        content: {
          type: 'string',
          description: 'The content, in markdown. Keep the decisions and the reasoning.',
          required: true,
        },
        mode: {
          type: 'string',
          description: '"replace" sets the section; "append" adds to it. Defaults to "replace".',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (args) => {
        const input = args as { section?: unknown; content?: unknown; mode?: unknown }
        const section = typeof input.section === 'string' ? input.section : ''
        const content = typeof input.content === 'string' ? input.content : ''
        const mode = input.mode === 'append' ? 'append' : 'replace'

        // The project comes from the caller's identity. This line is the isolation
        // boundary, and there is no other one.
        const scope = this.scopeOf(agent)
        if (scope.kind !== 'project') {
          return `This agent has no project memory (${scope.reason}).`
        }

        const path = this.memoryPath(scope.projectId)
        const before = readMemoryFile(path)
        const result = applyUpdate(before, section, content, mode, this.options.config.max_file_bytes)
        if (!result.ok) return result.message

        writeMemoryFileAtomic(path, result.text)
        const summary = diffSummary(before, result.text)
        const now = this.options.now()

        this.options.store.audit.record(
          {
            actor: 'agent',
            action: 'memory.updated',
            target: `${scope.projectId}:${section}`,
            // The summary, not the content: an audit log records what changed, and
            // storing the agent's prose in it would make a reader wonder whether it
            // came from the system.
            details: { mode, bytes: result.bytes, summary, session_id: agent.id },
          },
          now,
        )

        this.ctx.emit('ops/memory-updated', {
          projectId: scope.projectId,
          section,
          mode,
          bytes: result.bytes,
          summary,
          sessionId: agent.id as string,
        })

        return `Memory updated: ${summary}.`
      },
    })
  }

  /** `recall`. */
  private recallTool(agent: Agent): ToolDefinition {
    return defineTool({
      name: 'recall',
      description:
        'Search this project\'s past turns for something it discussed before. Returns ranked snippets with dates. There is no project argument — you can only search your own project.',
      parameters: {
        query: { type: 'string', description: 'What to look for.', required: true },
        limit: { type: 'string', description: 'How many results, up to 20. Defaults to 5.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (args) => {
        const input = args as { query?: unknown; limit?: unknown }
        const query = typeof input.query === 'string' ? input.query : ''
        if (query.trim().length === 0) return 'A query is required.'

        const scope = this.scopeOf(agent)
        if (scope.kind !== 'project') {
          return `This agent has no project memory to search (${scope.reason}).`
        }

        const limit = clampLimit(input.limit, this.options.config.recall_limit)
        const hits = this.indexFor(scope.projectId).search(query, limit)
        if (hits.length === 0) {
          return `Nothing in this project's history matches "${snippet(query, 80)}". It may not have been discussed, or the index may be empty.`
        }

        return [
          `${hits.length} result(s) for "${snippet(query, 80)}", most relevant first.`,
          '',
          ...hits.map((hit, index) => formatHit(hit, index + 1)),
        ].join('\n')
      },
    })
  }

  // ── recall indexing ──────────────────────────────────────────────────────

  /** The recall index for a project, opened lazily. */
  indexFor(projectId: string): RecallIndex {
    const existing = this.indexes.get(projectId)
    if (existing !== undefined) return existing
    const index = new RecallIndex(this.recallPath(projectId))
    this.indexes.set(projectId, index)
    return index
  }

  /**
   * Index a completed turn.
   *
   * Both the user's text and the assistant's final text are stored as separate
   * rows, so a query can tell what was *asked* from what was *answered* — which is
   * what makes a recall result interpretable rather than a wall of prose.
   *
   * @param agent the agent that ran.
   * @param sessionId the session.
   * @param turn the turn number.
   * @param userText the user's message.
   * @param assistantText the assistant's final message.
   */
  indexTurn(input: {
    readonly agent: Agent
    readonly sessionId: string
    readonly turn: number
    readonly userText: string
    readonly assistantText: string
  }): void {
    if (!this.options.config.index_turns) return
    const scope = this.scopeOf(input.agent)
    if (scope.kind !== 'project') return

    const index = this.indexFor(scope.projectId)
    const ts = this.options.now()
    const roles: string[] = []

    if (input.userText.trim().length > 0) {
      index.insert({ sessionId: input.sessionId, turn: input.turn, ts, role: 'user', text: input.userText })
      roles.push('user')
    }
    if (input.assistantText.trim().length > 0) {
      index.insert({ sessionId: input.sessionId, turn: input.turn, ts, role: 'assistant', text: input.assistantText })
      roles.push('assistant')
    }
    if (roles.length === 0) return

    this.ctx.emit('ops/memory-indexed', {
      projectId: scope.projectId,
      sessionId: input.sessionId,
      turn: input.turn,
      roles,
    })
  }

  /** Search a project's index directly, for a test or a command. */
  recall(projectId: string, query: string, limit?: number): RecallHit[] {
    return this.indexFor(projectId).search(query, limit ?? this.options.config.recall_limit)
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Create the state directories for a project, on first use.
   *
   * @param projectId the project.
   * @returns whether anything was created.
   */
  ensureDirectories(projectId: string): boolean {
    const dir = projectStateDir(this.options.dataDir, projectId)
    const existed = existsSync(dir)
    mkdirSync(dir, { recursive: true })
    mkdirSync(dirname(this.userProfilePath()), { recursive: true })
    return !existed
  }

  /**
   * Delete a project's memory.
   *
   * Destructive and not exposed as a tool: an agent must never be able to erase its
   * own memory as a side effect of a bad turn.
   *
   * @param projectId the project.
   * @param options whether to keep the directory.
   */
  reset(projectId: string, options: { readonly keepDirectory?: boolean } = {}): void {
    const dir = projectStateDir(this.options.dataDir, projectId)
    this.indexes.get(projectId)?.close()
    this.indexes.delete(projectId)
    rmSync(dir, { recursive: true, force: true })
    if (options.keepDirectory === true) mkdirSync(dir, { recursive: true })
    this.ctx.logger('ops-memory').info('memory reset for %s', projectId)
  }

  /** Close every open index. */
  dispose(): void {
    for (const index of this.indexes.values()) index.close()
    this.indexes.clear()
    this.knownScopes.clear()
  }

  /**
   * A health report.
   *
   * `degraded` when injections were truncated: a project's memory has outgrown its
   * budget, so its agents are working from an incomplete picture — which is exactly
   * the failure an operator would not otherwise notice.
   *
   * @returns the report.
   */
  health(): ServiceHealth {
    const details: Record<string, unknown> = {
      projects: this.indexes.size,
      injections: Object.fromEntries(this.injections),
      truncated: this.truncated,
    }
    if (this.truncated > 0) {
      return {
        status: 'degraded',
        details: { ...details, reason: 'memory was truncated; a project has outgrown its token budget' },
      }
    }
    return { status: 'ok', details }
  }
}

/** Clamp a recall limit from a tool argument. */
function clampLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(20, Math.trunc(parsed)))
}

/** Render one hit. */
function formatHit(hit: RecallHit, index: number): string {
  const when = new Date(hit.ts).toISOString().slice(0, 10)
  const who = hit.role === 'user' ? 'you were asked' : 'you answered'
  return `${index}. [${when}] (${who}, turn ${hit.turn})\n   ${snippet(hit.text)}`
}

export { scopeOf }
