// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/channel/routing` — the pure routing decision.
 *
 * One function decides where an incoming message goes. It takes a snapshot and
 * returns a verdict, so the whole routing table is testable without a channel, an
 * adapter or a governor.
 *
 * @module @argus-agent/channel/routing
 */
import type { AccessDecision } from './access.js'

/** Where a message goes. */
export type RouteKind =
  | 'command'
  | 'project'
  | 'orchestrator'
  | 'help'
  | 'rejected'

/** What a router needs to know. */
export interface RoutingState {
  /** The access decision, already made. */
  readonly access: AccessDecision
  /** The chat's active project, when one is set. */
  readonly activeProject: string | undefined
  /** Whether an orchestrator is mounted. */
  readonly hasOrchestrator: boolean
  /** Whether the chat has attachments. */
  readonly hasAttachments: boolean
}

/** The verdict. */
export interface Route {
  readonly kind: RouteKind
  /** The command line, for `command`. */
  readonly line?: string
  /** The project, for `project`. */
  readonly projectId?: string
  /** Why it was rejected, for the log. */
  readonly reason?: string
}

/**
 * Decide where a message goes.
 *
 * The order is the specification:
 *
 * 1. **Access first.** A stranger's message is never parsed, never routed, and
 *    never stored — the check happens before anything reads its content.
 * 2. **A command is a command**, whatever the chat's active project is, because
 *    `/p` and `/task` exist precisely to be independent of it.
 * 3. **A command-shaped message with no allowlist** still lands in `command`,
 *    because `/help` must be reachable to explain the situation. That case is
 *    handled where the refusal is logged, not by rerouting.
 * 4. **Free text with an active project** goes to that project, verbatim.
 * 5. **Free text with no active project** goes to the orchestrator, which may
 *    route it itself.
 * 6. **With neither**, a help reply: the system cannot guess where the message
 *    was meant to go, and dropping it silently is the one unacceptable outcome.
 *
 * @param text the message text.
 * @param state what the router knows.
 * @returns the verdict.
 */
export function decideRoute(text: string, state: RoutingState): Route {
  if (!state.access.allowed) {
    return { kind: 'rejected', reason: state.access.reason ?? 'not_listed' }
  }

  const trimmed = text.trim()
  if (trimmed.startsWith('/')) return { kind: 'command', line: trimmed }

  if (state.activeProject !== undefined && state.activeProject.length > 0) {
    return { kind: 'project', projectId: state.activeProject }
  }

  if (state.hasOrchestrator) return { kind: 'orchestrator' }

  // An attachment with nowhere to go is still addressed to someone: the help
  // reply tells the user how to give it a destination.
  void state.hasAttachments
  return { kind: 'help' }
}

/**
 * The reply for a message that could not be routed.
 *
 * It names both escapes, because the user's next action is one of two things and
 * making them guess would be the failure.
 *
 * @returns the help text.
 */
export function unroutableText(): string {
  return (
    'I do not know which project that was for.\n\n' +
    'Set one for this chat with /p <project-id>, then send the message again.\n' +
    'Or run it as a one-off task with /task <text>.\n\n' +
    'Send /projects to see the projects, or /help for every command.'
  )
}
