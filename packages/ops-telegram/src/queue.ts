// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/telegram/queue` — the outgoing queue.
 *
 * Telegram rate-limits per chat: roughly one message a second, with a burst
 * allowance. Sending faster earns a 429 whose `retry_after` applies to that chat.
 * A queue per chat is what turns that from a stream of failures into a delay.
 *
 * The queue is **per chat** rather than global, because the limit is: a busy chat
 * must not delay a quiet one, and a 429 for one chat says nothing about another.
 *
 * @module @argus-agent/telegram/queue
 */
import { backoffMs, isPermanentError, retryAfterMs } from './convert.js'

/** A queued send. */
interface QueueItem<T> {
  readonly run: () => Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
  /** Attempts made so far, for the backoff. */
  attempts: number
}

/** Options for the queue. */
export interface QueueOptions {
  /** The base delay between sends to one chat, in milliseconds. */
  readonly intervalMs?: number
  /** The base backoff after a transient failure. */
  readonly backoffBaseMs?: number
  /** The backoff cap. */
  readonly backoffMaxMs?: number
  /** How many attempts before giving up. */
  readonly maxAttempts?: number
  /** Reads the current time; injected so tests control it. */
  readonly now?: () => number
  /** Sleeps; injected so tests do not wait in real time. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Called on a retry, for a log. */
  readonly onRetry?: (info: { readonly chatId: string; readonly attempt: number; readonly waitMs: number; readonly error: unknown }) => void
  /** Called when an item is dropped after too many attempts. */
  readonly onGiveUp?: (info: { readonly chatId: string; readonly attempts: number; readonly error: unknown }) => void
}

/** One chat's queue state. */
interface ChatQueue {
  readonly items: QueueItem<unknown>[]
  /** When this chat may next be sent to. */
  nextAllowedAt: number
  /** Whether the pump is running, so a second one is not started. */
  running: boolean
}

/**
 * A per-chat outgoing queue.
 *
 * Every send goes through {@link enqueue}, which returns a promise that settles
 * when the send finally happened or was abandoned. The caller therefore sees the
 * same interface whether or not the queue had to wait.
 */
export class OutgoingQueue {
  private readonly chats = new Map<string, ChatQueue>()
  private readonly intervalMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly maxAttempts: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private stopped = false

  /** How many sends were retried after a failure. */
  retries = 0
  /** How many sends were abandoned. */
  givenUp = 0

  constructor(private readonly options: QueueOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1_000
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000
    this.maxAttempts = options.maxAttempts ?? 5
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Queue a send for a chat.
   *
   * @param chatId the chat the send belongs to.
   * @param run the send itself.
   * @returns the send's result.
   */
  enqueue<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const chat = this.chats.get(chatId) ?? { items: [], nextAllowedAt: 0, running: false }
      this.chats.set(chatId, chat)
      chat.items.push({
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        attempts: 0,
      })
      if (!chat.running) void this.pump(chatId, chat)
    })
  }

  /** Drain one chat's queue, respecting the interval and the rate limiter. */
  private async pump(chatId: string, chat: ChatQueue): Promise<void> {
    chat.running = true
    try {
      while (chat.items.length > 0 && !this.stopped) {
        const item = chat.items[0] as QueueItem<unknown>

        // Hold until this chat's next allowed moment.
        const now = this.now()
        if (chat.nextAllowedAt > now) await this.sleep(chat.nextAllowedAt - now)

        item.attempts += 1
        try {
          const value = await item.run()
          chat.items.shift()
          chat.nextAllowedAt = this.now() + this.intervalMs
          item.resolve(value)
        } catch (error) {
          const waitMs = retryAfterMs(error, item.attempts)

          if (isPermanentError(error) || item.attempts >= this.maxAttempts) {
            chat.items.shift()
            this.givenUp += 1
            this.options.onGiveUp?.({ chatId, attempts: item.attempts, error })
            item.reject(error)
            continue
          }

          this.retries += 1
          this.options.onRetry?.({ chatId, attempt: item.attempts, waitMs, error })
          // The chat's next allowed moment is pushed out by the same wait, so a
          // retry does not immediately earn another 429.
          chat.nextAllowedAt = this.now() + waitMs
          await this.sleep(waitMs)
        }
      }
    } finally {
      chat.running = false
      if (chat.items.length === 0) this.chats.delete(chatId)
    }
  }

  /**
   * Wait until every queued send has been attempted.
   *
   * @param timeoutMs how long to wait before returning anyway.
   * @returns whether the queues drained inside the timeout.
   */
  async drain(timeoutMs = 5_000): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (this.chats.size > 0) {
      if (this.now() >= deadline) return false
      await this.sleep(20)
    }
    return true
  }

  /** Stop pumping; queued items are rejected. */
  stop(): void {
    this.stopped = true
    for (const chat of this.chats.values()) {
      for (const item of chat.items) item.reject(new Error('the outgoing queue was stopped'))
      chat.items.length = 0
    }
    this.chats.clear()
  }

  /** How many chats have something queued. */
  get pendingChats(): number {
    return this.chats.size
  }

  /** How many sends are queued across every chat. */
  get pending(): number {
    let total = 0
    for (const chat of this.chats.values()) total += chat.items.length
    return total
  }
}

/**
 * The delay before reconnect attempt `attempt`.
 *
 * Exposed as its own function so the reconnect policy has one implementation,
 * shared with the queue's backoff.
 *
 * @param attempt the attempt number, starting at 1.
 * @returns the delay in milliseconds.
 */
export function reconnectDelayMs(attempt: number): number {
  return backoffMs(attempt, { baseMs: 1_000, maxMs: 60_000 })
}
