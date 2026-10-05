// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/memory` — durable per-project memory.
 *
 * It injects memory when an agent starts, registers two tools on **project** agents
 * only, and indexes each completed turn for `recall`.
 *
 * ## A deviation from the prompt, recorded
 *
 * The prompt says to inject on **`agent/session-start`**. That event does not exist
 * in dsh `0.2.0-rc.2`. The equivalent is **`agent/created`**, whose payload carries
 * `source: SessionStartSource` — `'startup' | 'resume' | 'clear' | 'compact'`.
 *
 * That is a better fit than the name the prompt assumed, because it distinguishes
 * four cases explicitly. In particular **`'compact'`** is why injected memory
 * survives a compaction: dsh recreates the agent when it compacts a session, so this
 * listener runs again and the memory is present in the new context rather than only
 * in the transcript that was summarised away.
 *
 * @module @argus-agent/memory
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { memoryOf, memorySchema } from './config.js'
import { OpsMemory } from './service.js'

export * from './config.js'
export * from './memory-file.js'
export * from './paths.js'
export * from './recall.js'
export * from './service.js'
export * from './truncate.js'

/** Stable Cordis plugin name. */
export const name = 'ops-memory'

/**
 * The services this plugin requires.
 *
 * `opsProjects` is what resolves an agent to its project, which is the isolation
 * boundary; without it there is no way to know whose memory an agent may reach, so
 * the plugin correctly refuses to mount.
 */
export const inject = ['opsRawConfig', 'opsConfigRegistry', 'opsStore', 'opsProjects']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The memory service, once the plugin is mounted. */
    opsMemory: OpsMemory
  }
}

/**
 * Mount the memory plugin.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  const section = ctx.opsConfigRegistry.extend('memory', memorySchema)
  ctx.effect(() => section)

  const config = memoryOf(ctx.opsRawConfig)
  const logger = ctx.logger('ops-memory')

  if (!config.enabled) {
    logger.info('memory is disabled by memory.enabled')
    return
  }

  const dataDir = typeof ctx.opsRawConfig['data_dir'] === 'string' ? ctx.opsRawConfig['data_dir'] : '/data'

  const service = new OpsMemory(ctx, {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    config,
    dataDir,
    now: () => Date.now(),
  })

  ctx.provide('opsMemory', service)

  /** Sessions that already have the tools registered, so a re-compose is a no-op. */
  const registered = new Set<string>()

  /**
   * Inject on session start.
   *
   * # Why this is not on `agent/created`
   *
   * The prompt names `agent/session-start`, which does not exist in dsh
   * `0.2.0-rc.2`; the equivalent payload field is `SessionStartSource` on
   * `agent/created`. But `agent/created` fires **before** `ops-projects` adopts the
   * agent, so `ownerOf(sessionId)` does not resolve yet and the scope would read as
   * an unknown agent — which receives the user profile only, and no project memory.
   *
   * `ops/agent-composed` is emitted from inside the agent's `setup` callback: after
   * the project is known, before the agent is published. That ordering is what makes
   * a project's memory present in its FIRST turn rather than only in later ones.
   *
   * The user profile for ad-hoc and orchestrator agents is injected on
   * `agent/created`, because those agents are never composed and would otherwise
   * receive nothing.
   */
  ctx.on('ops/agent-composed', (payload) => {
    const memory = ctx.get('opsMemory')
    if (memory === undefined) return
    const agent = payload.agent as Agent
    const agentCtx = payload.agentCtx as Context

    // The owner arrives WITH the event, because the ownership map is not populated
    // until `ops-projects` finishes adopting — which is after this callback runs.
    // Recorded FIRST, so the injection below can resolve the project.
    if (payload.owner?.kind === 'project') {
      memory.noteScope(payload.sessionId, {
        kind: 'project',
        projectId: (payload.owner as { projectId: string }).projectId,
      })
    }

    // Registered once per session. `ops/agent-composed` can fire more than once for
    // one agent — a resume re-composes the scope — and registering a name twice in
    // one scope throws.
    if (!registered.has(payload.sessionId) && agentCtx !== undefined && agentCtx.tools !== undefined) {
      registered.add(payload.sessionId)
      for (const tool of memory.projectTools(agent)) {
        agentCtx.effect(() => agentCtx.tools.register(tool))
      }
    }

    try {
      const injection = memory.injectInto(agent, `composed:${String(payload.owner?.kind ?? 'project')}`)
      if (injection.text.trim().length > 0) {
        logger.debug(
          'injected %d estimated token(s) into %s (%s)%s',
          injection.tokens,
          payload.sessionId,
          payload.owner?.kind === 'project' ? (payload.owner as { projectId: string }).projectId : 'user profile only',
          injection.truncated ? ', TRUNCATED' : '',
        )
      }
    } catch (error) {
      // An injection failure must not stop the agent from starting: a project that
      // runs without its memory is degraded, and one that cannot start is broken.
      logger.warn('injection failed for %s: %s', payload.sessionId, error instanceof Error ? error.message : String(error))
    }
  })

  /**
   * The user profile for an agent that no project composes.
   *
   * An ad-hoc task and the orchestrator are created through `createEphemeral`,
   * which never emits `ops/agent-composed`. They receive `USER.md` and nothing else,
   * which is what the plan requires.
   */
  ctx.on('agent/created', ({ agent, source }) => {
    const memory = ctx.get('opsMemory')
    if (memory === undefined) return undefined
    // Deferred by a microtask so `ops-projects` has finished adopting: a project
    // agent already got its injection from `ops/agent-composed`, and this listener
    // only has to cover the agents that are not composed at all.
    queueMicrotask(() => {
      try {
        if (memory.scopeOf(agent as Agent).kind === 'project') return
        memory.injectInto(agent as Agent, source)
      } catch (error) {
        logger.warn('injection failed for %s: %s', agent.id as string, error instanceof Error ? error.message : String(error))
      }
    })
    // A serial event's listener returns undefined or a promise, never a bare void.
    return undefined
  })

  /**
   * Register the tools on a **project** agent's scope.
   *
   * Two things make this the right moment and this the right mechanism:
   *
   * - `ops/agent-composed` is emitted from inside the agent's `setup` callback,
   *   which is the last moment before the agent is published. Registering on
   *   `agent/created` instead would be too early: `ops-projects` adopts the agent
   *   (and so registers its owner) *after* that event, so `ownerOf` would not yet
   *   resolve and the scope would look like an unknown agent.
   * - The payload carries the agent's **context**, which is what a scoped
   *   registration needs. A session id alone cannot reach a scope.
   *
   * Scoped registration is half the isolation argument: an ad-hoc or orchestrator
   * agent is never composed this way, so it never receives these definitions and
   * has no call to make. The other half is that the project is resolved from the
   * agent's identity anyway.
   */
  logger.info(
    'memory ready: budget %d estimated token(s), file limit %d bytes, user profile %s',
    config.max_inject_tokens,
    config.max_file_bytes,
    config.user_profile ? 'on' : 'off',
  )

  ctx.effect(() => () => {
    service.dispose()
  })
}

export { scopeOf } from '@deepseek-ai/dsh-scope'
