// == ARGUS AGENT PROJECT ==
/**
 * Message construction.
 *
 * This module exists because of a trap recorded in `docs/developer-docs.md#verified-dsh-facts`
 * (deviation 6): `UserMessage` **requires** `role: 'user'`, and dsh-session's
 * `assertMessageEventShape` enforces it when a stored log is replayed. A
 * `followup` whose message omits `role` writes a perfectly valid-looking log that
 * `ctx.agents.resume()` later rejects as corrupt — the failure surfaces long after
 * the write, in an unrelated part of the system.
 *
 * Every user message in Argus Agent must therefore be built through these constructors
 * rather than as an inline object literal.
 *
 * It lives in `ops-types` rather than in `ops-testkit` because a **production**
 * plugin needs it: `ops-memory` injects context with `agent.inject()`, and a plugin
 * cannot depend on a test package. `ops-testkit` re-exports it, so a test and a
 * plugin build the message the same way — which is the point of having one
 * constructor.
 *
 * @module @argus-agent/types/messages
 */
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'

/** A source describing who supplied a message. */
export type MessageSource =
  | { readonly kind: 'user' }
  | { readonly kind: 'scheduler'; readonly scheduleId: string }
  | { readonly kind: 'orchestrator'; readonly requestId: string }
  /** Context a plugin injected, rather than something a person typed. */
  | { readonly kind: 'injected'; readonly by: string }

/**
 * Build a well-formed user message.
 *
 * @param id a stable message id.
 * @param text the message text.
 * @param source who supplied it; defaults to a human user.
 * @returns a complete `UserMessage`, including the required `role`.
 */
export function userMessage(id: string, text: string, source: MessageSource = { kind: 'user' }): UserMessage {
  return {
    id: id as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: source as UserMessage['source'],
  }
}

/**
 * Build a user message from several text blocks.
 *
 * @param id a stable message id.
 * @param texts one text block per entry.
 * @param source who supplied it.
 * @returns a complete `UserMessage`.
 */
export function userMessageBlocks(id: string, texts: readonly string[], source: MessageSource = { kind: 'user' }): UserMessage {
  return {
    id: id as MessageId,
    role: 'user',
    content: texts.map((text) => ({ type: 'text', text })) as UserMessage['content'],
    source: source as UserMessage['source'],
  }
}
