// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/web-channel` — the chat in the web interface, as a channel.
 *
 * An adapter like Telegram's: what a person types goes to `ops-channel` through
 * `onMessage`, and everything the system says comes back through `send`, `edit`
 * and `ask`. It holds no business logic. A chat is a signed-in user's: its id is
 * the Argus user id, which is also the user's `web` identity.
 *
 * The conversation is kept in `ops-store` (`web_chat`), the last
 * {@link HISTORY_CAP} entries per person, with the files it offered; it survives a
 * restart. Only the questions waiting for an answer are in memory: they are this
 * process's promises, so at start the ones a previous process left open are closed.
 *
 * @module @argus-agent/web/web-channel
 */
import { randomUUID } from 'node:crypto'
import type { WebChatRepository, WebChatRow } from '@argus-agent/store'
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
export const HISTORY_CAP = 500

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
  /** Who answered on another channel, and what, when it was not here. */
  note?: string
}

/** A downloadable file: on disk, or its bytes. */
export interface StoredFile {
  readonly name: string
  readonly path?: string
  readonly bytes?: Uint8Array
  readonly mimeType?: string
}

/** The web chat adapter. */
export class WebChannelAdapter implements ChannelAdapter {
  readonly name = 'web'
  readonly limits: AdapterLimits = { maxTextLength: 200_000, maxFileBytes: 200 * 1_048_576 }

  private onMessage: ((message: IncomingMessage) => void) | undefined
  private onButton: ((answer: ButtonAnswer) => void) | undefined
  private readonly questions = new Map<string, { chatId: string; resolve: (answer: AnswerOrTimeout) => void; close: (note: string) => void; timer?: NodeJS.Timeout }>()

  /**
   * @param changed called with a person's chat id whenever their conversation changes.
   * @param store where the conversations are.
   * @param now reads the current time.
   */
  constructor(
    private readonly changed: (chatId: string) => void,
    private readonly store: WebChatRepository,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async start(onMessage: (message: IncomingMessage) => void, onButton: (answer: ButtonAnswer) => void): Promise<() => Promise<void>> {
    this.onMessage = onMessage
    this.onButton = onButton
    // Whoever asked them is gone: their buttons must not look alive.
    this.store.expireOpenQuestions()
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
    const files = (message.files ?? []).map((file) => ({
      id: randomUUID(),
      name: file.name,
      mime_type: file.mimeType ?? null,
      path: file.path ?? null,
      bytes: file.bytes ?? null,
    }))
    const buttons = message.buttons !== undefined && message.buttons.length > 0 ? message.buttons : undefined
    const id = this.push(to.chatId, 'argus', message.text, { buttons }, files)
    return { channel: this.name, chatId: to.chatId, messageId: id }
  }

  async edit(ref: MessageRef, message: OutgoingMessage): Promise<void> {
    if (this.store.entry(ref.messageId)?.chat_id !== ref.chatId) return
    this.store.update(ref.messageId, { text: message.text })
    this.changed(ref.chatId)
  }

  async delete(ref: MessageRef): Promise<void> {
    if (this.store.entry(ref.messageId)?.chat_id !== ref.chatId) return
    this.store.delete(ref.messageId)
    this.changed(ref.chatId)
  }

  async ask(to: ChannelAddress, question: Question): Promise<AnswerOrTimeout> {
    const entryId = this.push(to.chatId, 'argus', question.text, { buttons: question.buttons, questionId: question.id })
    return new Promise<AnswerOrTimeout>((resolve) => {
      const settle = (answer: AnswerOrTimeout): void => {
        const pending = this.questions.get(question.id)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.questions.delete(question.id)
        this.store.update(entryId, { answered: answer === 'timeout' ? 'timeout' : answer.value })
        this.changed(to.chatId)
        resolve(answer)
      }
      // Answered on another channel: the buttons go, the note says by whom.
      const close = (note: string): void => {
        this.store.update(entryId, { note })
        settle('timeout')
      }
      const timer = question.timeoutMs === undefined ? undefined : setTimeout(() => settle('timeout'), question.timeoutMs)
      this.questions.set(question.id, { chatId: to.chatId, resolve: settle, close, ...(timer === undefined ? {} : { timer }) })
    })
  }

  /**
   * Close a question answered on another channel.
   * @param question the question.
   * @param note who answered, and what.
   */
  async closeQuestion(question: Question, note: string): Promise<void> {
    this.questions.get(question.id)?.close(note)
  }

  // ── from the browser ─────────────────────────────────────────────────────

  /**
   * A person typed a message.
   *
   * @param userId who: the Argus user id.
   * @param text what they wrote, verbatim.
   */
  receive(userId: string, text: string): void {
    const id = this.push(userId, 'you', text)
    this.onMessage?.({ id, address: { channel: this.name, chatId: userId }, userId, text, timestamp: this.now() })
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
    const row = this.store.entry(entryId)
    if (row === undefined || row.chat_id !== userId || row.answered !== null) return false
    const entry = toEntry(row, [])
    if (entry.buttons?.some((button) => button.value === value) !== true) return false
    const questionId = entry.questionId ?? entry.id
    this.onButton?.({ questionId, value, address: { channel: this.name, chatId: userId }, userId, timestamp: this.now() })
    const pending = this.questions.get(questionId)
    if (pending !== undefined) pending.resolve({ kind: 'button', value })
    else {
      this.store.update(entryId, { answered: value })
      this.changed(userId)
    }
    return true
  }

  /** A person's conversation, oldest first. */
  history(userId: string): readonly ChatEntry[] {
    return this.store.history(userId).map(({ row, files }) => toEntry(row, files))
  }

  /** How many entries from Argus a person has not seen. */
  unread(userId: string): number {
    return this.store.unread(userId)
  }

  /** A person saw their conversation. */
  markRead(userId: string): void {
    if (this.store.markRead(userId, this.now()) > 0) this.changed(userId)
  }

  /**
   * A file the chat offered to a person.
   *
   * @param userId who asks; a file is only theirs.
   * @param fileId the id in the chat entry.
   * @returns the file, or `undefined`.
   */
  file(userId: string, fileId: string): StoredFile | undefined {
    const row = this.store.file(userId, fileId)
    if (row === undefined) return undefined
    return {
      name: row.name,
      ...(row.path === null ? {} : { path: row.path }),
      ...(row.bytes === null ? {} : { bytes: row.bytes }),
      ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    }
  }

  /** Append an entry, dropping the oldest past the cap; returns its id. */
  private push(
    chatId: string,
    from: ChatEntry['from'],
    text: string,
    extra: { buttons?: readonly Button[] | undefined; questionId?: string } = {},
    files: Parameters<WebChatRepository['append']>[1] = [],
  ): string {
    const id = randomUUID()
    this.store.append(
      {
        id,
        chat_id: chatId,
        at: this.now(),
        sender: from,
        text,
        buttons_json: extra.buttons === undefined ? null : JSON.stringify(extra.buttons),
        question_id: extra.questionId ?? null,
      },
      files,
      HISTORY_CAP,
    )
    this.changed(chatId)
    return id
  }
}

/** A stored row as the browser gets it. */
function toEntry(row: WebChatRow, files: ChatFile[]): ChatEntry {
  return {
    id: row.id,
    at: row.at,
    from: row.sender,
    text: row.text,
    ...(files.length === 0 ? {} : { files }),
    ...(row.buttons_json === null ? {} : { buttons: JSON.parse(row.buttons_json) as Button[] }),
    ...(row.question_id === null ? {} : { questionId: row.question_id }),
    ...(row.answered === null ? {} : { answered: row.answered }),
    ...(row.note === null ? {} : { note: row.note }),
  }
}
