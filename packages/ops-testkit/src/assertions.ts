// == ARGUS AGENT PROJECT ==
/**
 * Assertion helpers and small utilities shared by integration tests.
 *
 * @module @argus-agent/testkit/assertions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Wait until a predicate holds, polling on the event loop.
 *
 * @param predicate the condition.
 * @param options timeout, poll interval and a label for the failure message.
 * @returns after the predicate first returns true.
 * @throws {Error} when the timeout elapses, naming the label.
 */
export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 5
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${options.label ?? 'condition'}`)
}

/** One recorded session event. */
export interface RecordedEvent {
  readonly sessionId: string
  readonly type: string
  readonly data: unknown
  /** The full event, for assertions that need `seq` or surface metadata. */
  readonly event: SessionEvent
}

/** A live recorder of session events. */
export interface EventRecorder {
  /** Every event observed, in arrival order. */
  readonly events: RecordedEvent[]
  /** Events of one type, optionally limited to one session. */
  ofType(type: string, sessionId?: string): RecordedEvent[]
  /** Events belonging to one session. */
  ofSession(sessionId: SessionId | string): RecordedEvent[]
  /** Stop recording. */
  stop(): void
}

/**
 * Record every `session/event` on a booted tree.
 *
 * @param ctx the root context.
 * @returns the recorder.
 */
export function recordSessionEvents(ctx: Context): EventRecorder {
  const events: RecordedEvent[] = []
  const dispose = ctx.on('session/event', (session, event) => {
    events.push({ sessionId: session.id as string, type: event.type, data: event.data, event })
  })
  return {
    events,
    ofType: (type, sessionId) =>
      events.filter((entry) => entry.type === type && (sessionId === undefined || entry.sessionId === sessionId)),
    ofSession: (sessionId) => events.filter((entry) => entry.sessionId === sessionId),
    stop: () => dispose(),
  }
}

/**
 * The concatenated text of an assistant message event's content.
 * @param event a recorded `assistant/message` event.
 * @returns the text.
 */
export function assistantText(event: RecordedEvent): string {
  const data = event.data as { message?: { content?: readonly unknown[] } }
  return textOfBlocks(data.message?.content)
}

/**
 * Concatenate the text blocks of a content-block list.
 * @param blocks the blocks.
 * @returns the text.
 */
export function textOfBlocks(blocks: readonly unknown[] | undefined): string {
  if (!blocks) return ''
  return blocks
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      return record['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : ''
    })
    .join('')
}

/**
 * The token usage reported on an `assistant/message` event.
 * @param event a recorded event.
 * @returns the usage, or `undefined` when the adapter reported none.
 */
export function usageOf(event: RecordedEvent): { inputTokens: number; outputTokens: number } | undefined {
  const data = event.data as { usage?: { inputTokens: number; outputTokens: number } }
  return data.usage
}

/**
 * Count how many booted trees are still live.
 *
 * Liveness is read from the tree itself rather than from `ctx.fiber.state`:
 * Cordis keeps the root fiber's state at `ACTIVE` through teardown and does not
 * null its `uid`, so the fiber is not a reliable disposal signal. What IS
 * reliable is that disposal removes every service — so a disposed context has no
 * `loader` and no `llm`. `bootOps().dispose()` is idempotent, so calling it
 * twice is safe.
 *
 * @param boots the boots to check.
 * @returns the number that were still live.
 */
export function liveBootCount(boots: readonly { ctx: Context }[]): number {
  return boots.filter((boot) => isLive(boot.ctx)).length
}

/**
 * Whether a booted context is still mounted.
 * @param ctx the context to inspect.
 * @returns whether its services are still present.
 */
export function isLive(ctx: Context): boolean {
  try {
    return (ctx as unknown as { loader?: unknown }).loader !== undefined
  } catch {
    // Reading a disposed context's services throws; that is itself proof of
    // disposal.
    return false
  }
}
