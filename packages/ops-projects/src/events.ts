// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-projects`.
 *
 * @module @argus-agent/projects/events
 */
import type { Owner } from '@argus-agent/types'
import type { ContentBlockLike } from '@argus-agent/types'
import type { InvalidProject } from './project-loader.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An agent finished being composed, before it was published.
     *
     * Emitted from the `setup` callback, so a listener runs while the agent's
     * scope is still open and can register into it. `ops-memory` uses this to
     * install its per-project tools and its injected memory.
     *
     * @param payload.owner what the agent belongs to.
     * @param payload.sessionId the agent's session.
     * @mode emit
     */
    /**
     * A project agent's scope is built, and is about to be published.
     *
     * Emitted from inside the agent's `setup` callback, which is the only moment a
     * plugin can register something **into that agent's scope** — a tool that must
     * exist before the first turn, for instance. The agent's own context is in the
     * payload, because a listener that only had the session id could not register
     * anything scoped.
     *
     * A serial-worthy moment: a listener that registers a tool must finish before
     * the agent runs.
     *
     * @param payload.agentCtx the agent's scope, for scoped registration.
     * @mode emit
     */
    'ops/agent-composed'(payload: {
      readonly owner: Owner
      readonly sessionId: string
      readonly agentCtx: unknown
      readonly agent: unknown
    }): void

    /**
     * An agent entered the running state.
     *
     * Emitted from the `agent/status` listener. The governor counts these to
     * know which concurrency slots are occupied.
     *
     * @param payload.owner what the agent belongs to.
     * @param payload.sessionId the agent's session.
     * @mode emit
     */
    'ops/agent-running'(payload: { readonly owner: Owner; readonly sessionId: string }): void

    /**
     * An agent returned to idle.
     *
     * Emitted after the run has been closed, so a listener that reads the run
     * sees it already finished.
     *
     * @param payload.owner what the agent belongs to.
     * @param payload.sessionId the agent's session.
     * @param payload.runId the run that just ended, when one was open.
     * @mode emit
     */
    'ops/agent-idle'(payload: {
      readonly owner: Owner
      readonly sessionId: string
      readonly runId: string | undefined
    }): void

    /**
     * A run finished, carrying its final assistant output.
     *
     * The channel delivers this; the governor closes the run's bookkeeping. The
     * content is the last non-empty assistant message of the run, extracted with
     * dsh's own `finalAssistantOutput` (SPIKES.md spike 1).
     *
     * @param payload.owner what the run belonged to.
     * @param payload.sessionId the session that ran.
     * @param payload.runId the run.
     * @param payload.content the final assistant content blocks.
     * @mode emit
     */
    'ops/run-output'(payload: {
      readonly owner: Owner
      readonly sessionId: string
      readonly runId: string
      readonly content: readonly ContentBlockLike[]
    }): void

    /**
     * The set of project files that fail to validate changed — one became
     * invalid, or a fixed one became valid again.
     *
     * An invalid project is ignored, not archived: the rest of the system keeps
     * running, and the project comes back on the next load that validates it.
     * The channel tells the operator.
     *
     * @param payload.invalid every invalid project now, with its file and reason.
     * @param payload.fixed projects that were invalid before this load and are valid now.
     * @mode emit
     */
    'ops/projects-invalid'(payload: {
      readonly invalid: readonly InvalidProject[]
      readonly fixed: readonly string[]
    }): void
  }
}

export {}
