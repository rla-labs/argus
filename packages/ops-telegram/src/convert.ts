// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/telegram/convert` — translating between Telegram and the channel
 * contract.
 *
 * Every function here is pure. That is deliberate: this package's job is
 * translation, and translation is exactly the kind of logic that is easy to get
 * subtly wrong and impossible to test through a network. The grammY binding in
 * `bot.ts` is thin because everything decidable was decided here.
 *
 * @module @argus-agent/telegram/convert
 */
import type {
  Button,
  ChannelAddress,
  IncomingAttachment,
  IncomingMessage,
} from '@argus-agent/types'

/** Telegram's hard limit on a text message. */
export const TELEGRAM_MAX_TEXT = 4096

/**
 * The limit this adapter declares.
 *
 * **Below** Telegram's own, because HTML escaping expands the text: `&` becomes
 * `&amp;`, five characters for one. Declaring exactly 4096 would let a message
 * that fits before escaping exceed the limit after it, and Telegram would reject
 * the whole send — losing the answer rather than trimming it.
 */
export const TELEGRAM_TEXT_LIMIT = 4000

/**
 * Telegram's limit on a file a **bot** may download.
 *
 * A user may upload far more, but a bot can only fetch 20 MB through the Bot API.
 * A larger attachment cannot be retrieved at all, which the adapter reports rather
 * than silently dropping.
 */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024

/** Telegram's limit on a file a bot may send. */
export const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024

/** Telegram's limit on `callback_data`. */
export const TELEGRAM_CALLBACK_LIMIT = 64

/** The subset of a Telegram message this adapter reads. */
export interface TelegramMessageLike {
  readonly message_id: number
  readonly date: number
  readonly chat: { readonly id: number; readonly type: string; readonly title?: string }
  readonly from?: {
    readonly id: number
    readonly is_bot?: boolean
    readonly username?: string
    readonly first_name?: string
  }
  readonly text?: string
  readonly caption?: string
  readonly document?: TelegramFileLike
  readonly photo?: readonly TelegramPhotoSizeLike[]
  readonly audio?: TelegramFileLike
  readonly video?: TelegramFileLike
  readonly voice?: TelegramFileLike
}

/** A Telegram file reference. */
export interface TelegramFileLike {
  readonly file_id: string
  readonly file_name?: string
  readonly mime_type?: string
  readonly file_size?: number
}

/** One size of a Telegram photo. */
export interface TelegramPhotoSizeLike extends TelegramFileLike {
  readonly width: number
  readonly height: number
}

/** The subset of a Telegram callback query this adapter reads. */
export interface TelegramCallbackLike {
  readonly id: string
  readonly data?: string
  readonly from: { readonly id: number; readonly username?: string; readonly first_name?: string }
  readonly message?: {
    readonly message_id: number
    readonly chat: { readonly id: number; readonly type: string }
    readonly date: number
  }
}

/**
 * Escape text for Telegram's HTML parse mode.
 *
 * Three characters: `&`, `<` and `>`. The ampersand **first**, or the escapes
 * introduced for the other two would be double-escaped into visible text.
 *
 * @param text the raw text.
 * @returns the escaped text.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Build the address for a Telegram chat.
 *
 * The `threadId` is a forum topic's id, which Telegram delivers as
 * `message_thread_id`. Including it keeps a topic's replies in that topic rather
 * than in the group's general feed.
 *
 * @param chatId the chat id.
 * @param threadId the topic id, when the message is in one.
 * @returns the address.
 */
export function addressOf(chatId: number | string, threadId?: number): ChannelAddress {
  return threadId === undefined
    ? { channel: 'telegram', chatId: String(chatId) }
    : { channel: 'telegram', chatId: String(chatId), threadId: String(threadId) }
}

/**
 * Whether a chat is a group or a channel.
 *
 * `private` is a one-to-one chat; everything else is a group, a supergroup or a
 * channel. The distinction matters because a group can contain people the
 * allowlist has never seen.
 *
 * @param type Telegram's chat type.
 * @returns whether it is a group-like chat.
 */
export function isGroupChat(type: string): boolean {
  return type === 'group' || type === 'supergroup' || type === 'channel'
}

/** What an incoming Telegram message converts to, or why it was refused. */
export type ConversionResult =
  | { readonly kind: 'message'; readonly message: IncomingMessage }
  | { readonly kind: 'ignored'; readonly reason: string }

/**
 * Convert a Telegram message into an `IncomingMessage`.
 *
 * Refusals are outcomes, not exceptions: a message with no sender (a channel
 * post), one from a bot, or one with neither text nor an attachment is skipped
 * with a reason the caller logs.
 *
 * @param raw the Telegram message.
 * @param options the adapter's group policy and thread id.
 * @returns the converted message, or a reason it was ignored.
 */
export function convertIncoming(
  raw: TelegramMessageLike,
  options: { readonly allowGroups: boolean; readonly threadId?: number; readonly botUsername?: string },
): ConversionResult {
  if (raw.from === undefined) {
    return { kind: 'ignored', reason: 'no sender (a channel post has none)' }
  }
  if (raw.from.is_bot === true) {
    return { kind: 'ignored', reason: 'from a bot' }
  }
  if (isGroupChat(raw.chat.type) && !options.allowGroups) {
    return { kind: 'ignored', reason: 'from a group and telegram.allow_groups is false' }
  }

  const text = fromMenuCommand(stripBotMention(raw.text ?? raw.caption ?? '', options.botUsername))
  const attachments = attachmentsOf(raw)

  if (text.trim().length === 0 && attachments.length === 0) {
    return { kind: 'ignored', reason: 'no text and no usable attachment' }
  }

  return {
    kind: 'message',
    message: {
      // Telegram message ids are unique per chat, so the pair is the identity.
      id: `${raw.chat.id}:${raw.message_id}`,
      address: addressOf(raw.chat.id, options.threadId),
      userId: String(raw.from.id),
      ...(displayNameOf(raw.from) === undefined ? {} : { userName: displayNameOf(raw.from) as string }),
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(isGroupChat(raw.chat.type) ? { isGroup: true } : {}),
      timestamp: raw.date * 1_000,
    },
  }
}

/**
 * Remove a leading `@botname` mention.
 *
 * In a group, Telegram sends `/status@my_bot` so a bot can tell which of several
 * bots the command was meant for. The mention is Telegram's addressing mechanism,
 * not part of the instruction, so it is removed before the text reaches the
 * command layer — which would otherwise see an unknown command name.
 *
 * @param text the raw text.
 * @param botUsername the bot's username, without the `@`.
 * @returns the text with a leading mention removed.
 */
export function stripBotMention(text: string, botUsername?: string): string {
  if (botUsername === undefined || botUsername.length === 0) return text
  const mention = `@${botUsername}`
  if (!text.startsWith('/')) return text
  // Only the first token carries the mention; a later `@name` is message content.
  const space = text.search(/\s/)
  const head = space === -1 ? text : text.slice(0, space)
  const tail = space === -1 ? '' : text.slice(space)
  return head.endsWith(mention) ? `${head.slice(0, -mention.length)}${tail}` : text
}

/**
 * A command name as Telegram's menu can carry it: `[a-z0-9_]`, at most 32 characters.
 * Argus names use `-` (`resume-all`), which `setMyCommands` refuses, so the menu
 * lists `resume_all` and {@link fromMenuCommand} maps it back.
 *
 * @param name the command name, without the slash.
 * @returns the menu form, or `undefined` when the name cannot be a menu entry.
 */
export function toMenuCommand(name: string): string | undefined {
  const menu = name.replaceAll('-', '_')
  return /^[a-z0-9_]{1,32}$/.test(menu) ? menu : undefined
}

/**
 * Map a command typed or tapped from the menu (`/resume_all`) back to its name
 * (`/resume-all`). Only the command word changes; the arguments are the user's.
 *
 * @param text the message text.
 * @returns the text with the command word in its Argus form.
 */
export function fromMenuCommand(text: string): string {
  const match = /^\/[a-z0-9_]+/.exec(text)
  return match === null ? text : `${match[0].replaceAll('_', '-')}${text.slice(match[0].length)}`
}

/** The display name of a sender, for logs. Never trusted for authorization. */
function displayNameOf(from: { username?: string; first_name?: string }): string | undefined {
  if (from.username !== undefined && from.username.length > 0) return `@${from.username}`
  if (from.first_name !== undefined && from.first_name.length > 0) return from.first_name
  return undefined
}

/**
 * The attachments a Telegram message carries.
 *
 * A photo arrives as several sizes of the same image; the **largest** is taken,
 * because the smaller ones are thumbnails and there is no reason to send an agent
 * a preview when the original is available.
 *
 * @param raw the Telegram message.
 * @returns the attachments.
 */
export function attachmentsOf(raw: TelegramMessageLike): IncomingAttachment[] {
  const attachments: IncomingAttachment[] = []

  if (raw.document !== undefined) {
    attachments.push(fileAttachment(raw.document, 'file'))
  }
  if (raw.photo !== undefined && raw.photo.length > 0) {
    const largest = [...raw.photo].sort(
      (a, b) => a.width * a.height - b.width * b.height,
    ).at(-1) as TelegramPhotoSizeLike
    attachments.push({ ...fileAttachment(largest, 'image'), name: 'photo.jpg' })
  }
  for (const candidate of [raw.audio, raw.video, raw.voice]) {
    if (candidate !== undefined) attachments.push(fileAttachment(candidate, 'file'))
  }
  return attachments
}

/** Build an attachment from a Telegram file reference. */
function fileAttachment(file: TelegramFileLike, kind: 'file' | 'image'): IncomingAttachment {
  return {
    kind,
    name: file.file_name ?? `${kind}-${file.file_id.slice(0, 8)}`,
    ...(file.mime_type === undefined ? {} : { mimeType: file.mime_type }),
    fileId: file.file_id,
    ...(file.file_size === undefined ? {} : { sizeBytes: file.file_size }),
  }
}

/**
 * Whether a file is too large for a bot to download.
 *
 * @param sizeBytes the file's size, when Telegram reported one.
 * @returns whether it exceeds the bot download limit.
 */
export function tooLargeToDownload(sizeBytes: number | undefined): boolean {
  return sizeBytes !== undefined && sizeBytes > TELEGRAM_DOWNLOAD_LIMIT
}

/**
 * The reply for an attachment too large to fetch.
 *
 * @param name the file's name.
 * @param sizeBytes its size.
 * @returns the message text.
 */
export function tooLargeText(name: string, sizeBytes: number | undefined): string {
  const mb = sizeBytes === undefined ? 'unknown' : (sizeBytes / (1024 * 1024)).toFixed(1)
  return (
    `I cannot fetch "${name}" (${mb} MB).\n` +
    `Telegram lets a bot download at most ${TELEGRAM_DOWNLOAD_LIMIT / (1024 * 1024)} MB.\n` +
    'Send a smaller file, or put it somewhere the agent can read and tell me the path.'
  )
}

/**
 * Encode a button value for `callback_data`.
 *
 * Telegram caps `callback_data` at 64 **bytes**, so an over-long value is
 * truncated rather than rejected — a rejected button would leave a question
 * unanswerable. A confirmation token is a UUID plus the prefix and suffix, which
 * fits; a command line that does not is truncated to keep the button working.
 *
 * @param value the button's value.
 * @returns data that fits Telegram's limit.
 */
export function encodeCallbackData(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= TELEGRAM_CALLBACK_LIMIT) return value
  // Truncating bytes could split a multi-byte character, so the cut is made on
  // characters until the encoded form fits.
  let text = value
  while (new TextEncoder().encode(text).length > TELEGRAM_CALLBACK_LIMIT) {
    text = text.slice(0, -1)
  }
  return text
}

/** A Telegram inline keyboard row. */
export interface InlineKeyboardButton {
  readonly text: string
  readonly callback_data: string
}

/**
 * Build an inline keyboard from buttons.
 *
 * One button per row: a destructive confirmation's Yes/No reads better stacked
 * than side by side, and two long labels in one row are truncated by Telegram on
 * a narrow screen.
 *
 * @param buttons the buttons.
 * @returns the keyboard, or `undefined` when there are none.
 */
export function inlineKeyboard(
  buttons: readonly Button[],
): { readonly inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (buttons.length === 0) return undefined
  return {
    inline_keyboard: buttons.map((button) => [
      { text: button.label, callback_data: encodeCallbackData(button.value) },
    ]),
  }
}

/**
 * Convert a callback query into a button answer.
 *
 * @param raw the callback query.
 * @param threadId the topic id, when the question was asked in one.
 * @returns the answer, or `undefined` when it carries no data or no message.
 */
export function convertCallback(
  raw: TelegramCallbackLike,
  threadId?: number,
): { readonly questionId: string; readonly value: string; readonly address: ChannelAddress; readonly userId: string; readonly timestamp: number } | undefined {
  if (raw.data === undefined || raw.message === undefined) return undefined
  // The question id is the message the keyboard was attached to, so a press is
  // correlated to the message a user saw even if two questions look alike.
  const questionId = `tg:${raw.message.chat.id}:${raw.message.message_id}`
  return {
    questionId,
    value: raw.data,
    address: addressOf(raw.message.chat.id, threadId),
    userId: String(raw.from.id),
    timestamp: raw.message.date * 1_000,
  }
}

/**
 * Split text into Telegram-sized chunks.
 *
 * The split happens **before** escaping, because a chunk boundary must not fall
 * inside an escape sequence: cutting `&amp;` in half would send `&am` and `p;` as
 * visible text. Each chunk is escaped independently.
 *
 * @param text the raw text.
 * @param limit the character limit.
 * @returns the chunks, escaped and ready to send.
 */
export function splitForTelegram(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length === 0) return ['']
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1)
    // A paragraph break, then a line break, then a space: the widest boundary
    // that keeps both halves readable.
    const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')]
    const breakAt = candidates.find((index) => index >= limit * 0.5) ?? limit
    chunks.push(remaining.slice(0, breakAt))
    remaining = remaining.slice(breakAt)
    if (remaining.startsWith('\n')) remaining = remaining.slice(1)
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks.map(escapeHtml)
}

/**
 * How long to wait before retrying after a failure.
 *
 * Exponential with a cap, so a transient outage is ridden out without hammering
 * Telegram — whose rate limiter would then make the outage longer. The cap stops
 * the wait from growing past the point where an operator would rather see it give
 * up and say so.
 *
 * @param attempt the attempt number, starting at 1.
 * @param options the base delay and the cap.
 * @returns the delay in milliseconds.
 */
export function backoffMs(
  attempt: number,
  options: { readonly baseMs?: number; readonly maxMs?: number } = {},
): number {
  const base = options.baseMs ?? 1_000
  const max = options.maxMs ?? 60_000
  const safeAttempt = Math.max(1, Math.min(attempt, 20))
  return Math.min(max, base * 2 ** (safeAttempt - 1))
}

/**
 * The `retry_after` a Telegram 429 carries, in milliseconds.
 *
 * Telegram reports the wait in **seconds** in `parameters.retry_after`. A missing
 * value falls back to the backoff for the current attempt, so a 429 that does not
 * say how long is still handled rather than retried immediately — which is what
 * would extend the ban.
 *
 * @param error the caught error.
 * @param attempt the current attempt number.
 * @returns the wait in milliseconds.
 */
export function retryAfterMs(error: unknown, attempt: number): number {
  const candidate = error as {
    error_code?: number
    parameters?: { retry_after?: number }
    retry_after?: number
  }
  const seconds = candidate?.parameters?.retry_after ?? candidate?.retry_after
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    // One extra second: Telegram's retry_after is a whole number of seconds, and
    // retrying exactly on the boundary can hit the same limiter.
    return (seconds + 1) * 1_000
  }
  return backoffMs(attempt)
}

/**
 * Whether a Telegram error is one no retry can fix.
 *
 * 409 is a second poller on the same token, 401 a bad token, 403 a blocked bot,
 * 404 a chat that does not exist. Retrying any of them spins forever while the
 * real cause stays in place, so they are reported rather than retried.
 *
 * @param error the caught error.
 * @returns whether the error is permanent.
 */
export function isPermanentError(error: unknown): boolean {
  const code = (error as { error_code?: number })?.error_code
  return code === 409 || code === 401 || code === 403 || code === 404
}

/**
 * Whether an error is a Telegram conflict from a second poller.
 *
 * Reported separately from other permanent errors because the cause is a
 * deployment problem — usually a leftover process, or a second replica — and the
 * operator's next step is specific.
 *
 * @param error the caught error.
 * @returns whether it is a 409 conflict.
 */
export function isConflict(error: unknown): boolean {
  return (error as { error_code?: number })?.error_code === 409
}

/** A Telegram error's description, for a log. */
export function describeError(error: unknown): string {
  const candidate = error as { error_code?: number; description?: string; message?: string }
  if (candidate?.error_code !== undefined) {
    return `${candidate.error_code}: ${candidate.description ?? candidate.message ?? 'unknown'}`
  }
  return candidate?.description ?? candidate?.message ?? String(error)
}
