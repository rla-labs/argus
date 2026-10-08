// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/telegram/adapter` — the `ChannelAdapter` implementation.
 *
 * It translates and nothing more: no routing, no allowlist, no command parsing.
 * `ops-channel` decides all of that; this file's only job is to move bytes
 * between Telegram and the contract's types.
 *
 * @module @argus-agent/telegram/adapter
 */
import { Bot, InputFile } from 'grammy'
import type {
  AdapterLimits,
  AnswerOrTimeout,
  ButtonAnswer,
  ChannelAddress,
  ChannelAdapter,
  IncomingMessage,
  MessageRef,
  OutgoingMessage,
  Question,
} from '@argus-agent/types'
import { readFile } from 'node:fs/promises'
import {
  TELEGRAM_TEXT_LIMIT,
  TELEGRAM_UPLOAD_LIMIT,
  addressOf,
  escapeHtml,
  convertCallback,
  convertIncoming,
  describeError,
  inlineKeyboard,
  isConflict,
  isPermanentError,
  retryAfterMs,
  splitForTelegram,
  tooLargeText,
  tooLargeToDownload,
  toMenuCommand,
  type TelegramCallbackLike,
  type TelegramMessageLike,
} from './convert.js'
import { OutgoingQueue } from './queue.js'

/** Options for the adapter. */
export interface TelegramAdapterOptions {
  readonly token: string
  readonly allowGroups: boolean
  readonly maxTextLength?: number
  readonly maxFileBytes?: number
  readonly sendIntervalMs?: number
  readonly maxAttempts?: number
  readonly registerCommands?: boolean
  /** The command menu to register, from the command layer's metadata. */
  readonly commands?: ReadonlyArray<{ readonly name: string; readonly description: string }>
  /** Called for every state transition, so a log records them. */
  readonly onState?: (state: TelegramState, detail?: string) => void
  /** Called when a send is retried or abandoned. */
  readonly onRetry?: (info: { chatId: string; attempt: number; waitMs: number; error: unknown }) => void
  readonly onGiveUp?: (info: { chatId: string; attempts: number; error: unknown }) => void
  /** Reads the current time; injected so tests control it. */
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** The Bot API root, for a test that runs a local server. */
  readonly apiRoot?: string
  /**
   * The Bot API surface, for a test that mocks it.
   *
   * A seam rather than an `apiRoot`: pointing grammY at a local server would mean
   * a server, a port and a network call in every test, and the behavior worth
   * testing — the queue, the escaping, the split, the retry — is above the HTTP
   * layer. A production deployment leaves this unset and grammY talks to Telegram.
   */
  readonly api?: TelegramApi
}

/** The Bot API calls this adapter makes. */
export interface TelegramApi {
  readonly raw: {
    getMe(): Promise<{ id: number; is_bot: boolean; first_name: string; username?: string }>
    getFile(fileId: string): Promise<{ file_id: string; file_path?: string }>
    sendMessage(
      chatId: string,
      text: string,
      options?: Record<string, unknown>,
    ): Promise<{ message_id: number }>
    editMessageText(
      chatId: string,
      messageId: number,
      text: string,
      options?: Record<string, unknown>,
    ): Promise<unknown>
    sendDocument(chatId: string, document: unknown, options?: Record<string, unknown>): Promise<{ message_id: number }>
    setMyCommands(commands: Array<{ command: string; description: string }>): Promise<unknown>
  }
}

/** The adapter's connection state, for `ops-health`. */
export type TelegramState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'failed'

/**
 * One adapter instance per bot token.
 *
 * The bot must not be reached by the channel directly: every outgoing call goes
 * through the queue, so a chat that has been rate-limited delays only itself.
 */
export class TelegramChannelAdapter implements ChannelAdapter {
  readonly name = 'telegram'
  readonly limits: AdapterLimits

  private readonly bot: Bot
  /** The API surface every outgoing call goes through. */
  private readonly api: TelegramApi['raw']
  private readonly queue: OutgoingQueue
  private readonly answeredQuestions = new Map<string, (answer: AnswerOrTimeout) => void>()
  private onMessage: ((message: IncomingMessage) => void) | undefined
  private onButton: ((answer: ButtonAnswer) => void) | undefined
  private stopped = false
  private pollAbort: AbortController | undefined

  private currentState: TelegramState = 'idle'
  private lastError: string | undefined
  private reconnectAttempt = 0

  /** How many updates were processed. */
  updates = 0
  /** How many updates were ignored, by reason. */
  readonly ignored = new Map<string, number>()

  constructor(private readonly options: TelegramAdapterOptions) {
    this.limits = {
      // Below Telegram's own 4096, because escaping expands the text.
      maxTextLength: options.maxTextLength ?? TELEGRAM_TEXT_LIMIT,
      maxFileBytes: options.maxFileBytes ?? TELEGRAM_UPLOAD_LIMIT,
    }
    this.bot = new Bot(options.token, options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } })
    // The injected API wins when a test provides one; otherwise grammY's own.
    this.api = options.api?.raw ?? (this.bot.api as unknown as TelegramApi['raw'])
    this.queue = new OutgoingQueue({
      intervalMs: options.sendIntervalMs ?? 1_000,
      maxAttempts: options.maxAttempts ?? 5,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.onRetry === undefined
        ? {}
        : { onRetry: (info) => options.onRetry?.({ chatId: info.chatId, attempt: info.attempt, waitMs: info.waitMs, error: info.error }) }),
      ...(options.onGiveUp === undefined
        ? {}
        : { onGiveUp: (info) => options.onGiveUp?.({ chatId: info.chatId, attempts: info.attempts, error: info.error }) }),
    })
    this.installHandlers()
  }

  /** The adapter's state. */
  get state(): TelegramState {
    return this.currentState
  }

  /** Whether polling is running. */
  get connected(): boolean {
    return this.currentState === 'connected'
  }

  /** The last error, for a health report. Never contains the token. */
  get error(): string | undefined {
    return this.lastError
  }

  /** How many reconnect attempts have been made. */
  get reconnects(): number {
    return this.reconnectAttempt
  }

  private setState(state: TelegramState, detail?: string): void {
    this.currentState = state
    if (state === 'failed') this.lastError = detail
    if (state === 'connected') this.lastError = undefined
    this.options.onState?.(state, detail)
  }

  /** The bot's own username, learned at `init`, for mention stripping. */
  private botUsername: string | undefined

  /** Wire grammY's handlers to the channel callbacks. */
  private installHandlers(): void {
    this.bot.on('message', (ctx) => {
      this.updates += 1
      const raw = ctx.message as unknown as TelegramMessageLike
      const result = convertIncoming(raw, {
        allowGroups: this.options.allowGroups,
        ...(ctx.message.message_thread_id === undefined ? {} : { threadId: ctx.message.message_thread_id }),
        ...(this.botUsername === undefined ? {} : { botUsername: this.botUsername }),
      })
      if (result.kind === 'ignored') {
        this.ignored.set(result.reason, (this.ignored.get(result.reason) ?? 0) + 1)
        return
      }

      // An attachment too large for a bot to fetch is reported rather than
      // silently dropped: the user would otherwise wait for an answer that can
      // never come.
      const oversized = result.message.attachments?.filter((attachment) => tooLargeToDownload(attachment.sizeBytes))
      if (oversized !== undefined && oversized.length > 0) {
        for (const attachment of oversized) {
          void this.send(result.message.address, {
            text: escapeHtml(tooLargeText(attachment.name, attachment.sizeBytes)),
            parseMode: 'HTML',
          } as never)
        }
        void this.downloadAttachments(result.message)
        return
      }

      this.onMessage?.(result.message)
      void this.downloadAttachments(result.message)
    })

    this.bot.on('callback_query:data', (ctx) => {
      this.updates += 1
      const raw = ctx.callbackQuery as unknown as TelegramCallbackLike
      const converted = convertCallback(raw, ctx.callbackQuery.message?.message_thread_id ?? undefined)
      if (converted === undefined) return

      // Answer the callback so Telegram stops showing a spinner on the button.
      void ctx.answerCallbackQuery().catch(() => {
        /* A failed acknowledgement is cosmetic; the answer still counts. */
      })

      const pending = this.answeredQuestions.get(converted.questionId)
      if (pending !== undefined) {
        this.answeredQuestions.delete(converted.questionId)
        pending({ kind: 'button', value: converted.value })
      }
      this.onButton?.(converted)
    })

    this.bot.catch((error) => {
      const cause = error.error
      this.lastError = describeError(cause)
      this.options.onState?.('failed', this.lastError)
    })
  }

  /**
   * Download each attachment, filling in its bytes.
   *
   * Telegram gives a `file_id` and requires a second call to get the bytes, so the
   * conversion cannot do it. A download failure leaves the attachment without
   * bytes, which the channel handles by forwarding the file id rather than a path.
   */
  private async downloadAttachments(message: IncomingMessage): Promise<void> {
    for (const attachment of message.attachments ?? []) {
      if (attachment.bytes !== undefined || attachment.fileId === undefined) continue
      try {
        const file = await this.api.getFile(attachment.fileId)
        if (file.file_path === undefined) continue
        const url = `https://api.telegram.org/file/bot${this.options.token}/${file.file_path}`
        const response = await fetch(url)
        if (!response.ok) continue
        const bytes = new Uint8Array(await response.arrayBuffer())
        Object.assign(attachment, { bytes })
      } catch (error) {
        this.options.onState?.('connected', `could not download ${attachment.name}: ${describeError(error)}`)
      }
    }
  }

  /**
   * Start long polling.
   *
   * Webhooks are not used: they need a public domain and a TLS certificate, and
   * long polling needs neither — which is the whole point of a self-hosted bot.
   */
  async start(
    onMessage: (message: IncomingMessage) => void,
    onButton: (answer: ButtonAnswer) => void,
  ): Promise<() => Promise<void>> {
    this.onMessage = onMessage
    this.onButton = onButton
    this.setState('connecting')

    // The bot's own identity is fetched directly rather than through
    // `bot.init()`, so an injected API can supply it without grammY's machinery.
    // It is the first call to Telegram, so it gets the same treatment as polling:
    // a permanent error (a bad token) fails the adapter visibly, and a transient
    // one (no network yet at boot) is retried rather than leaving the bot dead.
    const me = await this.identify()
    this.botUsername = me.username
    // grammY still needs its own init for the polling loop's bookkeeping, but a
    // failure there must not stop the adapter when the identity already resolved.
    await this.bot.init().catch(() => undefined)
    this.setState('connected')

    if (this.options.registerCommands !== false) {
      await this.registerCommands().catch((error: unknown) => {
        // A failed menu registration is cosmetic: the commands still work when
        // typed. Reporting it beats failing the start.
        this.options.onState?.('connected', `could not register the command menu: ${describeError(error)}`)
      })
    }

    this.pollAbort = new AbortController()
    void this.pollLoop()

    return async () => {
      await this.stop()
    }
  }

  /** `getMe`, retried with a backoff until it succeeds, fails permanently, or the adapter stops. */
  private async identify(): Promise<{ username?: string }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.api.getMe()
      } catch (error) {
        if (this.stopped || isPermanentError(error)) {
          this.setState('failed', describeError(error))
          throw error
        }
        const waitMs = retryAfterMs(error, attempt)
        this.setState('reconnecting', `${describeError(error)}; retrying in ${Math.round(waitMs / 1_000)}s`)
        await this.sleep(waitMs)
        this.setState('connecting')
      }
    }
  }

  /** Poll until stopped, reconnecting with a backoff. */
  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.bot.start({
          drop_pending_updates: false,
          // The signal is what lets a graceful shutdown stop the loop promptly
          // instead of after the current long poll times out.
          ...(this.pollAbort === undefined ? {} : { signal: this.pollAbort.signal }),
        })
        // `start` resolves when the loop is stopped.
        break
      } catch (error) {
        if (this.stopped) break

        if (isPermanentError(error)) {
          this.setState('failed', describeError(error))
          if (isConflict(error)) {
            this.options.onState?.(
              'failed',
              'another process is polling this bot token; stop it, or use a different token',
            )
          }
          // A permanent error is not retried: retrying a 409 spins forever while
          // the other poller keeps working, and a 401 never fixes itself.
          break
        }

        this.reconnectAttempt += 1
        const waitMs = retryAfterMs(error, this.reconnectAttempt)
        this.setState('reconnecting', `${describeError(error)}; retrying in ${Math.round(waitMs / 1_000)}s`)
        await this.sleep(waitMs)
        this.setState('connecting')
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep === undefined
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : this.options.sleep(ms)
  }

  /**
   * Register the command menu from the command layer's metadata.
   *
   * Telegram shows at most 100 commands and truncates a description at 256
   * characters, so both are trimmed rather than rejected by the API.
   */
  private async registerCommands(): Promise<void> {
    const commands = this.options.commands
    if (commands === undefined || commands.length === 0) return
    const menu = commands.flatMap((command) => {
      const name = toMenuCommand(command.name)
      return name === undefined ? [] : [{ command: name, description: command.description.slice(0, 256) }]
    })
    await this.api.setMyCommands(menu.slice(0, 100))
  }

  /** Send a message, through the per-chat queue. */
  async send(to: ChannelAddress, message: OutgoingMessage): Promise<MessageRef> {
    const chatId = to.chatId
    // `splitForTelegram` escapes each chunk, so a chunk boundary never falls
    // inside an escape sequence — which would send `&am` and `p;` as visible text.
    const chunks = splitForTelegram(message.text, this.limits.maxTextLength)

    const keyboard = message.buttons === undefined ? undefined : inlineKeyboard(message.buttons)
    let lastRef: MessageRef | undefined

    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1
      const sent = await this.queue.enqueue(chatId, async () =>
        this.api.sendMessage(chatId, chunk, {
          parse_mode: 'HTML',
          ...(to.threadId === undefined ? {} : { message_thread_id: Number(to.threadId) }),
          ...(isLast && keyboard !== undefined ? { reply_markup: keyboard } : {}),
        }),
      )
      lastRef = {
        channel: 'telegram',
        chatId,
        messageId: String(sent.message_id),
      }
    }

    // Files go after the text, so a caption can explain them.
    for (const file of message.files ?? []) {
      const sent = await this.queue.enqueue(chatId, async () => {
        const input =
          file.path === undefined
            ? new InputFile(file.bytes as Uint8Array, file.name)
            : new InputFile(await readFile(file.path), file.name)
        return this.api.sendDocument(
          chatId,
          input,
          to.threadId === undefined ? {} : { message_thread_id: Number(to.threadId) },
        )
      })
      lastRef = { channel: 'telegram', chatId, messageId: String(sent.message_id) }
    }

    if (lastRef === undefined) {
      throw new Error('nothing to send: no text chunks and no files')
    }
    return lastRef
  }

  /** Edit a message. */
  async edit(ref: MessageRef, message: OutgoingMessage): Promise<void> {
    await this.queue.enqueue(ref.chatId, async () =>
      this.api.editMessageText(ref.chatId, Number(ref.messageId), escapeHtml(message.text), {
        parse_mode: 'HTML',
      }),
    )
  }

  /**
   * Ask a question with an inline keyboard.
   *
   * The question is correlated by the MESSAGE id, which is what a callback query
   * carries — so a press is tied to the message the user saw, even if two
   * questions look identical.
   */
  async ask(to: ChannelAddress, question: Question): Promise<AnswerOrTimeout> {
    const message = await this.send(to, {
      text: question.text,
      buttons: question.buttons,
    })

    // The question is keyed by the MESSAGE, because that is what a callback query
    // carries — so a press is tied to the message the user actually saw.
    const questionId = `tg:${to.chatId}:${message.messageId}`
    const pending = new Promise<AnswerOrTimeout>((resolve) => {
      this.answeredQuestions.set(questionId, resolve)
    })

    // Telegram has no server-side timeout for a keyboard, so the deadline is
    // enforced here. `unref` keeps a pending question from holding the process
    // open past its usefulness.
    if (question.timeoutMs !== undefined) {
      setTimeout(() => {
        const resolve = this.answeredQuestions.get(questionId)
        if (resolve === undefined) return
        this.answeredQuestions.delete(questionId)
        resolve('timeout')
      }, question.timeoutMs).unref?.()
    }
    return pending
  }

  /** Whether polling is running, for `ops-health`. */
  isConnected(): boolean {
    return this.connected
  }

  /** Stop polling, then flush the queue with a timeout. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.pollAbort?.abort()
    try {
      await this.bot.stop()
    } catch {
      // Stopping a bot that never started is not a failure.
    }
    // Five seconds is the budget: a shutdown must not hang on a rate-limited chat.
    await this.queue.drain(5_000)
    this.queue.stop()
    for (const resolve of this.answeredQuestions.values()) resolve('timeout')
    this.answeredQuestions.clear()
    this.setState('stopped')
  }
}

export { addressOf }
