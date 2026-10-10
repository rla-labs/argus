// == ARGUS AGENT PROJECT ==
/**
 * A console channel adapter for tests.
 *
 * Implements {@link ChannelAdapter} against in-memory state: outgoing messages
 * are recorded, incoming messages and button answers are injected by the test.
 * It performs **no** allowlist checking and makes **no** routing decisions —
 * those belong to `ops-channel`, which is exactly what a test using this adapter
 * is verifying.
 *
 * @module @argus-agent/testkit/console-channel
 */
import type {
  AdapterLimits,
  AnswerOrTimeout,
  ButtonAnswer,
  ChannelAdapter,
  ChannelAddress,
  IncomingMessage,
  MessageRef,
  OutgoingMessage,
  Question,
} from '@argus-agent/types'

/** One message the adapter sent, with its destination and content. */
export interface SentMessage {
  readonly ref: MessageRef
  readonly to: ChannelAddress
  readonly message: OutgoingMessage
  /** Monotonic send order, for assertions about sequencing. */
  readonly sequence: number
  /** Whether this was an edit of an earlier message rather than a new send. */
  readonly edited: boolean
}

/** A question the adapter is waiting to answer. */
interface PendingQuestion {
  readonly question: Question
  readonly to: ChannelAddress
  resolve(answer: AnswerOrTimeout): void
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Options for {@link ConsoleChannelAdapter}. */
export interface ConsoleChannelAdapterOptions {
  /** Adapter name. Defaults to `'console'`. */
  readonly name?: string
  /** Declared limits. Defaults mirror Telegram's, so tests exercise the same split logic. */
  readonly limits?: AdapterLimits
  /** Fail every `send` with this error, to test channel-failure handling. */
  readonly failSends?: Error
}

/**
 * An in-memory channel adapter.
 *
 * @example
 * ```ts
 * const channel = new ConsoleChannelAdapter()
 * await channel.start(onMessage, onButton)
 *
 * // A user writes:
 * channel.receive({ text: '/projects', userId: 'u1' })
 *
 * // Assert on what came back:
 * expect(channel.sent[0]?.message.text).toContain('site-firma')
 * ```
 */
export class ConsoleChannelAdapter implements ChannelAdapter {
  readonly name: string
  readonly limits: AdapterLimits

  /** Every message sent, in order. Edits appear as entries with `edited: true`. */
  readonly sent: SentMessage[] = []
  /** Every message deleted, by ref. */
  readonly deleted: MessageRef[] = []

  private onMessage: ((message: IncomingMessage) => void) | undefined
  private onButton: ((answer: ButtonAnswer) => void) | undefined
  private readonly pending = new Map<string, PendingQuestion>()
  private sequence = 0
  private messageCounter = 0
  private started = false
  private stopped = false
  private readonly failSends: Error | undefined

  constructor(options: ConsoleChannelAdapterOptions = {}) {
    this.name = options.name ?? 'console'
    this.limits = options.limits ?? { maxTextLength: 4096, maxFileBytes: 20 * 1024 * 1024 }
    this.failSends = options.failSends
  }

  async start(
    onMessage: (message: IncomingMessage) => void,
    onButton: (answer: ButtonAnswer) => void,
  ): Promise<() => Promise<void>> {
    this.onMessage = onMessage
    this.onButton = onButton
    this.started = true
    return async () => {
      this.stopped = true
      for (const question of this.pending.values()) {
        if (question.timer) clearTimeout(question.timer)
        question.resolve('timeout')
      }
      this.pending.clear()
    }
  }

  async send(to: ChannelAddress, message: OutgoingMessage): Promise<MessageRef> {
    if (this.failSends) throw this.failSends
    if (message.editOf) {
      await this.edit(message.editOf, message)
      return message.editOf
    }
    this.messageCounter += 1
    const ref: MessageRef = {
      channel: this.name,
      chatId: to.chatId,
      messageId: `msg-${this.messageCounter}`,
    }
    this.sent.push({ ref, to, message, sequence: this.sequence++, edited: false })
    return ref
  }

  async edit(ref: MessageRef, message: OutgoingMessage): Promise<void> {
    if (this.failSends) throw this.failSends
    this.sent.push({
      ref,
      to: { channel: ref.channel, chatId: ref.chatId },
      message,
      sequence: this.sequence++,
      edited: true,
    })
  }

  async delete(ref: MessageRef): Promise<void> {
    this.deleted.push(ref)
  }

  async ask(to: ChannelAddress, question: Question): Promise<AnswerOrTimeout> {
    const promise = new Promise<AnswerOrTimeout>((resolve) => {
      const entry: PendingQuestion = { question, to, resolve, timer: undefined }
      if (question.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(question.id)
          resolve('timeout')
        }, question.timeoutMs)
      }
      this.pending.set(question.id, entry)
    })
    await this.send(to, { text: question.text, buttons: question.buttons })
    return promise
  }

  // ── test controls ────────────────────────────────────────────────────────

  /**
   * Inject an incoming message, as a user typing.
   *
   * @param partial the message fields; `id` and `timestamp` are filled in when
   *   omitted.
   */
  receive(partial: {
    text: string
    userId: string
    chatId?: string
    userName?: string
    id?: string
    timestamp?: number
    isGroup?: boolean
  }): void {
    this.requireStarted()
    const address: ChannelAddress = { channel: this.name, chatId: partial.chatId ?? 'chat-1' }
    this.onMessage?.({
      id: partial.id ?? `in-${this.sequence++}`,
      address,
      userId: partial.userId,
      userName: partial.userName ?? partial.userId,
      text: partial.text,
      isGroup: partial.isGroup ?? false,
      timestamp: partial.timestamp ?? Date.now(),
    })
  }

  /**
   * Answer the most recent pending question.
   *
   * @param value the button value to press.
   * @param userId the answering user.
   * @returns whether a pending question received the answer.
   */
  answer(value: string, userId = 'user-1'): boolean {
    const entry = [...this.pending.values()].at(-1)
    if (!entry) return false
    this.pending.delete(entry.question.id)
    if (entry.timer) clearTimeout(entry.timer)
    const answer: ButtonAnswer = {
      questionId: entry.question.id,
      value,
      address: entry.to,
      userId,
      timestamp: Date.now(),
    }
    // The press is surfaced BEFORE the promise resolves. Resolving first would
    // resume an awaiting caller before the channel has recorded who answered, so
    // the caller would read a stale (or absent) attribution — which is how the
    // approval audit row ended up with no `decided_by`.
    this.onButton?.(answer)
    entry.resolve({ kind: 'button', value })
    return true
  }

  /**
   * Resolve the most recent pending question as a timeout.
   *
   * A real adapter resolves `'timeout'` when its deadline passes. Tests cannot wait
   * for that deadline, so this is how the timeout path is exercised — and it goes
   * through the same resolution a real deadline would.
   *
   * @returns whether a pending question timed out.
   */
  timeout(): boolean {
    const entry = [...this.pending.values()].at(-1)
    if (!entry) return false
    this.pending.delete(entry.question.id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve('timeout')
    return true
  }

  /** The most recent pending question, or `undefined`. */
  get pendingQuestion(): Question | undefined {
    return [...this.pending.values()].at(-1)?.question
  }

  /** How many questions are awaiting an answer. */
  get pendingCount(): number {
    return this.pending.size
  }

  /** The last message sent, or `undefined` when none was. */
  get lastSent(): SentMessage | undefined {
    return this.sent.at(-1)
  }

  /** Every message sent, as plain text. */
  texts(): string[] {
    return this.sent.map((entry) => entry.message.text)
  }

  /** Whether {@link start} has been called and the disposer not yet run. */
  get isStarted(): boolean {
    return this.started && !this.stopped
  }

  /** Clear recorded messages and pending questions between assertions. */
  clear(): void {
    this.sent.length = 0
    this.pending.clear()
    this.sequence = 0
    this.messageCounter = 0
  }

  private requireStarted(): void {
    if (!this.started) throw new Error('ConsoleChannelAdapter: start() has not been called')
    if (this.stopped) throw new Error('ConsoleChannelAdapter: the adapter has been stopped')
  }
}
