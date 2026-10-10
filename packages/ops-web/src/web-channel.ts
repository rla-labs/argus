// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/web-channel` — the chat in the web interface, as a channel.
 *
 * An adapter like Telegram's: what a person types goes to `ops-channel` through
 * `onMessage`, and everything the system says comes back through `send`, `edit`
 * and `ask`. It holds no business logic. Its users are Telegram's (see
 * `identityChannel`), because in 0.3.0 a web login comes from Telegram.
 *
 * The conversation is kept in memory, the last {@link HISTORY_CAP} entries per
 * person; a restart starts it empty, as a new Telegram chat would not.
 *
 * @module @argus-agent/web/web-channel
 */
import { randomUUID } from 'node:crypto'
import type {
  AdapterLimits,
  AnswerOrTimeout,
  Button,
  ButtonAnswer,
  ChannelAdapter,
  ChannelAddress,
  IncomingMessage,
  MessageRef,
  OutgoingMessage,
  Question,
} from '@argus-agent/types'

/** Entries kept per person. */
export const HISTORY_CAP = 200

/** A file the chat offers for download. */
export interface ChatFile {
  readonly id: string
  readonly name: string
}

/** One entry of a conversation, as the browser shows it. */
export interface ChatEntry {
  readonly id: string
  readonly at: number
  readonly from: 'you' | 'argus'
  text: string
  files?: readonly ChatFile[]
  /** A question's buttons, while it waits. */
  buttons?: readonly Button[]
  questionId?: string
  /** The button chosen, once answered; `timeout` when nobody did. */
  answered?: string
}

/** Where a downloadable file is. */
interface StoredFile {
  readonly chatId: string
  readonly name: string
  readonly path?: string
  readonly bytes?: Uint8Array
  readonly mimeType?: string
}

/** The web chat adapter. */
export class WebChannelAdapter implements ChannelAdapter {
  readonly name = 'web'
  readonly identityChannel: string
  readonly limits: AdapterLimits = { maxTextLength: 200_000, maxFileBytes: 200 * 1_048_576 }

  private onMessage: ((message: IncomingMessage) => void) | undefined
  private onButton: ((answer: ButtonAnswer) => void) | undefined
  private readonly chats = new Map<string, ChatEntry[]>()
  private readonly files = new Map<string, StoredFile>()
  private readonly questions = new Map<string, { chatId: string; resolve: (answer: AnswerOrTimeout) => void; timer?: NodeJS.Timeout }>()

  /**
   * @param changed called with a person's chat id whenever their conversation changes.
   * @param identityChannel the adapter whose user ids this one shares.
   * @param now reads the current time.
   */
  constructor(
    private readonly changed: (chatId: string) => void,
    identityChannel = 'telegram',
    private readonly now: () => number = () => Date.now(),
  ) {
    this.identityChannel = identityChannel
  }

  async start(onMessage: (message: IncomingMessage) => void, onButton: (answer: ButtonAnswer) => void): Promise<() => Promise<void>> {
    this.onMessage = onMessage
    this.onButton = onButton
    return async () => {
      this.onMessage = undefined
      this.onButton = undefined
      for (const [id, question] of this.questions) {
        clearTimeout(question.timer)
        question.resolve('timeout')
        this.questions.delete(id)
      }
    }
  }

  async send(to: ChannelAddress, message: OutgoingMessage): Promise<MessageRef> {
    if (message.editOf !== undefined) {
      await this.edit(message.editOf, message)
      return message.editOf
    }
    const entry = this.push(to.chatId, { from: 'argus', text: message.text })
    if (message.files !== undefined && message.files.length > 0) {
      entry.files = message.files.map((file) => {
        const id = randomUUID()
        this.files.set(id, { chatId: to.chatId, name: file.name, ...(file.path === undefined ? {} : { path: file.path }), ...(file.bytes === undefined ? {} : { bytes: file.bytes }), ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }) })
        return { id, name: file.name }
      })
    }
    if (message.buttons !== undefined && message.buttons.length > 0) entry.buttons = message.buttons
    this.changed(to.chatId)
    return { channel: this.name, chatId: to.chatId, messageId: entry.id }
  }

  async edit(ref: MessageRef, message: OutgoingMessage): Promise<void> {
    const entry = this.chats.get(ref.chatId)?.find((candidate) => candidate.id === ref.messageId)
    if (entry === undefined) return
    entry.text = message.text
    this.changed(ref.chatId)
  }

  async delete(ref: MessageRef): Promise<void> {
    const chat = this.chats.get(ref.chatId)
    if (chat === undefined) return
    const at = chat.findIndex((entry) => entry.id === ref.messageId)
    if (at >= 0) chat.splice(at, 1)
    this.changed(ref.chatId)
  }

  async ask(to: ChannelAddress, question: Question): Promise<AnswerOrTimeout> {
    const entry = this.push(to.chatId, { from: 'argus', text: question.text })
    entry.buttons = question.buttons
    entry.questionId = question.id
    this.changed(to.chatId)
    return new Promise<AnswerOrTimeout>((resolve) => {
      const settle = (answer: AnswerOrTimeout): void => {
        const pending = this.questions.get(question.id)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.questions.delete(question.id)
        entry.answered = answer === 'timeout' ? 'timeout' : answer.value
        this.changed(to.chatId)
        resolve(answer)
      }
      const timer = question.timeoutMs === undefined ? undefined : setTimeout(() => settle('timeout'), question.timeoutMs)
      this.questions.set(question.id, { chatId: to.chatId, resolve: settle, ...(timer === undefined ? {} : { timer }) })
    })
  }

  // ── from the browser ─────────────────────────────────────────────────────

  /**
   * A person typed a message.
   *
   * @param userId who, as the identity channel knows them.
   * @param text what they wrote, verbatim.
   */
  receive(userId: string, text: string): void {
    const entry = this.push(userId, { from: 'you', text })
    this.changed(userId)
    this.onMessage?.({ id: entry.id, address: { channel: this.name, chatId: userId }, userId, text, timestamp: entry.at })
  }

  /**
   * A person pressed a button in their chat.
   *
   * A question this adapter asked is resolved here, as Telegram resolves its own;
   * the answer then goes to `ops-channel` like any button, which is where the
   * allowlist is checked and a command button runs.
   *
   * @param userId who.
   * @param entryId the message the button was on.
   * @param value the button's value.
   * @returns whether the message had that button.
   */
  press(userId: string, entryId: string, value: string): boolean {
    const entry = this.chats.get(userId)?.find((candidate) => candidate.id === entryId)
    if (entry?.buttons?.some((button) => button.value === value) !== true || entry.answered !== undefined) return false
    const questionId = entry.questionId ?? entry.id
    this.onButton?.({ questionId, value, address: { channel: this.name, chatId: userId }, userId, timestamp: this.now() })
    const pending = this.questions.get(questionId)
    if (pending !== undefined) pending.resolve({ kind: 'button', value })
    else {
      entry.answered = value
      this.changed(userId)
    }
    return true
  }

  /** A person's conversation, oldest first. */
  history(userId: string): readonly ChatEntry[] {
    return this.chats.get(userId) ?? []
  }

  /**
   * A file the chat offered to a person.
   *
   * @param userId who asks; a file is only theirs.
   * @param fileId the id in the chat entry.
   * @returns the file, or `undefined`.
   */
  file(userId: string, fileId: string): Omit<StoredFile, 'chatId'> | undefined {
    const file = this.files.get(fileId)
    return file === undefined || file.chatId !== userId ? undefined : file
  }

  /** Append an entry, dropping the oldest past the cap. */
  private push(chatId: string, entry: Pick<ChatEntry, 'from' | 'text'>): ChatEntry {
    const chat = this.chats.get(chatId) ?? []
    const full: ChatEntry = { id: randomUUID(), at: this.now(), ...entry }
    chat.push(full)
    while (chat.length > HISTORY_CAP) {
      const dropped = chat.shift()
      for (const file of dropped?.files ?? []) this.files.delete(file.id)
    }
    this.chats.set(chatId, chat)
    return full
  }
}
