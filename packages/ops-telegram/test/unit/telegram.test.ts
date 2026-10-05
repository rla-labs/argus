// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the Telegram conversion layer.
 *
 * Everything decidable without a network lives here, which is why the grammY
 * binding can be thin. These are the rules that decide whether a message arrives
 * intact, whether an escape breaks a send, and how a rate limit is ridden out.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  TELEGRAM_CALLBACK_LIMIT,
  TELEGRAM_DOWNLOAD_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  addressOf,
  attachmentsOf,
  backoffMs,
  convertCallback,
  convertIncoming,
  describeError,
  encodeCallbackData,
  escapeHtml,
  inlineKeyboard,
  isConflict,
  isGroupChat,
  isPermanentError,
  retryAfterMs,
  splitForTelegram,
  stripBotMention,
  tooLargeText,
  tooLargeToDownload,
  type TelegramMessageLike,
} from '../../src/convert.js'
import { OutgoingQueue, reconnectDelayMs } from '../../src/queue.js'
import { looksLikeToken, telegramOf, tokenWarning } from '../../src/config.js'

/** A Telegram message, with defaults. */
function message(overrides: Partial<TelegramMessageLike> = {}): TelegramMessageLike {
  return {
    message_id: 42,
    date: 1_700_000_000,
    chat: { id: 12345, type: 'private' },
    from: { id: 99887766, username: 'operator', first_name: 'Op' },
    text: 'hello',
    ...overrides,
  }
}

describe('escapeHtml', () => {
  const cases: Array<[string, string]> = [
    ['plain text', 'plain text'],
    ['a < b', 'a &lt; b'],
    ['a > b', 'a &gt; b'],
    ['a & b', 'a &amp; b'],
    ['<script>', '&lt;script&gt;'],
    ['a &amp; b', 'a &amp;amp; b'],
    ['&lt;', '&amp;lt;'],
    ['', ''],
  ]

  it.each(cases)('escapes %j', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected)
  })

  it('escapes the ampersand FIRST', () => {
    // Escaping `<` first and then `&` would turn `&lt;` into `&amp;lt;`, which is
    // what the fourth case checks — the order is the whole reason this works.
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('&')).toBe('&amp;')
  })

  it('leaves quotes alone', () => {
    // HTML parse mode has no need to escape them, and doing so shows the entity
    // as literal text to the user.
    expect(escapeHtml(`he said "hi" and 'bye'`)).toBe(`he said "hi" and 'bye'`)
  })

  it('leaves Telegram-safe formatting alone', () => {
    // MarkdownV2 would require escaping every one of these.
    expect(escapeHtml('*bold* _italic_ `code` [link]')).toBe('*bold* _italic_ `code` [link]')
  })
})

describe('splitForTelegram', () => {
  it('leaves a short message alone', () => {
    expect(splitForTelegram('short', 100)).toEqual(['short'])
  })

  it('escapes each chunk', () => {
    expect(splitForTelegram('<b>', 100)).toEqual(['&lt;b&gt;'])
  })

  it('splits at a paragraph break', () => {
    const text = `${'a'.repeat(80)}\n\n${'b'.repeat(80)}`
    const chunks = splitForTelegram(text, 100)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('a'.repeat(80))
  })

  it('splits at a line break when there is no paragraph break', () => {
    const text = `${'a'.repeat(80)}\n${'b'.repeat(80)}`
    expect(splitForTelegram(text, 100)).toHaveLength(2)
  })

  it('splits at a space as a last resort', () => {
    const text = `${'a'.repeat(80)} ${'b'.repeat(80)}`
    const chunks = splitForTelegram(text, 100)
    expect(chunks).toHaveLength(2)
    expect(chunks.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''))
  })

  it('cuts hard with no boundary at all', () => {
    const chunks = splitForTelegram('x'.repeat(250), 100)
    expect(chunks).toHaveLength(3)
    expect(chunks.join('')).toBe('x'.repeat(250))
  })

  it('never exceeds the limit', () => {
    for (const limit of [50, 100, 200]) {
      for (const chunk of splitForTelegram('word '.repeat(500), limit)) {
        expect(chunk.length).toBeLessThanOrEqual(limit)
      }
    }
  })

  it('NEVER cuts inside an escape sequence', () => {
    // The whole reason for splitting before escaping: a boundary inside `&amp;`
    // would send `&am` and `p;` as visible text.
    const text = `${'a'.repeat(90)}&${'b'.repeat(90)}`
    const chunks = splitForTelegram(text, 100)
    for (const chunk of chunks) {
      // Every `&` in the output must begin a complete entity.
      for (const match of chunk.matchAll(/&/g)) {
        const rest = chunk.slice(match.index)
        expect(/^&(amp|lt|gt);/.test(rest), `chunk fragment: ${rest.slice(0, 10)}`).toBe(true)
      }
    }
  })

  it('preserves the text when the escapes are undone', () => {
    const text = `${'a<b>c&d'.repeat(30)}`
    const joined = splitForTelegram(text, 100)
      .join('')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    expect(joined).toBe(text)
  })

  it('handles an empty string', () => {
    expect(splitForTelegram('', 100)).toEqual([''])
  })
})

describe('addressOf', () => {
  it('builds a private chat address', () => {
    expect(addressOf(12345)).toEqual({ channel: 'telegram', chatId: '12345' })
  })

  it('includes a topic id', () => {
    expect(addressOf(12345, 99)).toEqual({ channel: 'telegram', chatId: '12345', threadId: '99' })
  })
})

describe('isGroupChat', () => {
  it('distinguishes a private chat', () => {
    expect(isGroupChat('private')).toBe(false)
  })

  it('recognizes every group-like type', () => {
    for (const type of ['group', 'supergroup', 'channel']) {
      expect(isGroupChat(type), type).toBe(true)
    }
  })
})

describe('convertIncoming', () => {
  it('converts a private text message', () => {
    const result = convertIncoming(message(), { allowGroups: false })
    expect(result.kind).toBe('message')
    if (result.kind !== 'message') return
    expect(result.message).toMatchObject({
      id: '12345:42',
      userId: '99887766',
      userName: '@operator',
      text: 'hello',
      timestamp: 1_700_000_000_000,
    })
    expect(result.message.address).toEqual({ channel: 'telegram', chatId: '12345' })
  })

  it('uses the chat id AND message id as the identity', () => {
    // Telegram message ids are unique per chat, so the pair is the identity — and
    // it must be stable, because ops-channel deduplicates on it.
    const first = convertIncoming(message({ chat: { id: 1, type: 'private' } }), { allowGroups: false })
    const second = convertIncoming(message({ chat: { id: 2, type: 'private' } }), { allowGroups: false })
    expect(first.kind === 'message' && first.message.id).toBe('1:42')
    expect(second.kind === 'message' && second.message.id).toBe('2:42')
  })

  it('carries a topic id into the address', () => {
    const result = convertIncoming(message(), { allowGroups: true, threadId: 7 })
    expect(result.kind === 'message' && result.message.address.threadId).toBe('7')
  })

  it('uses the caption when there is no text', () => {
    const result = convertIncoming(message({ text: undefined, caption: 'look at this' }), { allowGroups: false })
    expect(result.kind === 'message' && result.message.text).toBe('look at this')
  })

  it('ignores a message from a bot', () => {
    const result = convertIncoming(message({ from: { id: 1, is_bot: true } }), { allowGroups: false })
    expect(result.kind).toBe('ignored')
    expect(result.kind === 'ignored' && result.reason).toContain('bot')
  })

  it('ignores a channel post with no sender', () => {
    const result = convertIncoming(message({ from: undefined }), { allowGroups: true })
    expect(result.kind).toBe('ignored')
    expect(result.kind === 'ignored' && result.reason).toContain('no sender')
  })

  it('ignores a group message when groups are disabled', () => {
    const result = convertIncoming(message({ chat: { id: -100, type: 'supergroup' } }), { allowGroups: false })
    expect(result.kind).toBe('ignored')
    expect(result.kind === 'ignored' && result.reason).toContain('allow_groups')
  })

  it('accepts a group message when groups are enabled, and marks it', () => {
    const result = convertIncoming(message({ chat: { id: -100, type: 'supergroup' } }), { allowGroups: true })
    expect(result.kind).toBe('message')
    expect(result.kind === 'message' && result.message.isGroup).toBe(true)
  })

  it('ignores a message with neither text nor an attachment', () => {
    const result = convertIncoming(message({ text: undefined, caption: undefined }), { allowGroups: false })
    expect(result.kind).toBe('ignored')
    expect(result.kind === 'ignored' && result.reason).toContain('no text')
  })

  it('accepts a message with only an attachment', () => {
    const result = convertIncoming(
      message({
        text: undefined,
        document: { file_id: 'f1', file_name: 'report.pdf', file_size: 100 },
      }),
      { allowGroups: false },
    )
    expect(result.kind).toBe('message')
    expect(result.kind === 'message' && result.message.attachments).toHaveLength(1)
  })

  it('falls back to a first name when there is no username', () => {
    const result = convertIncoming(message({ from: { id: 5, first_name: 'Ana' } }), { allowGroups: false })
    expect(result.kind === 'message' && result.message.userName).toBe('Ana')
  })

  it('omits the display name when there is none', () => {
    const result = convertIncoming(message({ from: { id: 5 } }), { allowGroups: false })
    expect(result.kind === 'message' && result.message.userName).toBeUndefined()
  })

  it('strips a bot mention from a command', () => {
    const result = convertIncoming(message({ text: '/status@my_bot alpha' }), {
      allowGroups: true,
      botUsername: 'my_bot',
    })
    // Telegram's addressing mechanism, not part of the instruction.
    expect(result.kind === 'message' && result.message.text).toBe('/status alpha')
  })
})

describe('stripBotMention', () => {
  const cases: Array<[string, string | undefined, string]> = [
    ['/status@my_bot', 'my_bot', '/status'],
    ['/status@my_bot alpha', 'my_bot', '/status alpha'],
    ['/status', 'my_bot', '/status'],
    ['/status@other_bot', 'my_bot', '/status@other_bot'],
    ['plain text @my_bot', 'my_bot', 'plain text @my_bot'],
    ['/status@my_bot', undefined, '/status@my_bot'],
    ['/status@my_bot', '', '/status@my_bot'],
  ]

  it.each(cases)('strips %j with bot %j', (text, bot, expected) => {
    expect(stripBotMention(text, bot)).toBe(expected)
  })

  it('leaves a mention that is message content', () => {
    // Only the first token is Telegram's addressing; a later one is what the user
    // typed, and rewriting it would alter their instruction.
    expect(stripBotMention('/task tell @my_bot hello', 'my_bot')).toBe('/task tell @my_bot hello')
  })
})

describe('attachmentsOf', () => {
  it('takes a document', () => {
    const attachments = attachmentsOf(
      message({ document: { file_id: 'd1', file_name: 'a.pdf', mime_type: 'application/pdf', file_size: 10 } }),
    )
    expect(attachments).toEqual([
      { kind: 'file', name: 'a.pdf', mimeType: 'application/pdf', fileId: 'd1', sizeBytes: 10 },
    ])
  })

  it('takes the LARGEST photo size', () => {
    // The smaller ones are thumbnails; there is no reason to send an agent a
    // preview when the original is available.
    const attachments = attachmentsOf(
      message({
        text: undefined,
        photo: [
          { file_id: 'small', width: 90, height: 90, file_size: 1 },
          { file_id: 'large', width: 800, height: 800, file_size: 50 },
          { file_id: 'medium', width: 320, height: 320, file_size: 10 },
        ],
      }),
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.fileId).toBe('large')
    expect(attachments[0]?.kind).toBe('image')
    expect(attachments[0]?.name).toBe('photo.jpg')
  })

  it('takes several different media types', () => {
    const attachments = attachmentsOf(
      message({
        document: { file_id: 'd', file_name: 'a.txt' },
        audio: { file_id: 'a', file_name: 'b.mp3' },
      }),
    )
    expect(attachments.map((entry) => entry.fileId)).toEqual(['d', 'a'])
  })

  it('synthesizes a name when Telegram gives none', () => {
    const attachments = attachmentsOf(message({ text: undefined, voice: { file_id: 'abcdefgh12' } }))
    expect(attachments[0]?.name).toMatch(/^file-abcdefgh/)
  })

  it('returns nothing for a plain message', () => {
    expect(attachmentsOf(message())).toEqual([])
  })
})

describe('tooLargeToDownload', () => {
  it('accepts a file at the limit', () => {
    expect(tooLargeToDownload(TELEGRAM_DOWNLOAD_LIMIT)).toBe(false)
  })

  it('refuses one over it', () => {
    expect(tooLargeToDownload(TELEGRAM_DOWNLOAD_LIMIT + 1)).toBe(true)
  })

  it('accepts an unknown size', () => {
    // Not a reason to refuse: the download either works or reports its own error.
    expect(tooLargeToDownload(undefined)).toBe(false)
  })
})

describe('tooLargeText', () => {
  it('names the file, the size and the limit', () => {
    const text = tooLargeText('big.zip', 30 * 1024 * 1024)
    expect(text).toContain('big.zip')
    expect(text).toContain('30.0 MB')
    expect(text).toContain('20 MB')
  })

  it('tells the user what to do instead', () => {
    expect(tooLargeText('x', 1)).toContain('tell me the path')
  })

  it('handles an unknown size', () => {
    expect(tooLargeText('x', undefined)).toContain('unknown MB')
  })
})

describe('encodeCallbackData', () => {
  it('leaves a short value alone', () => {
    expect(encodeCallbackData('yes')).toBe('yes')
  })

  it('fits Telegram’s 64-byte limit', () => {
    const long = 'x'.repeat(200)
    const encoded = encodeCallbackData(long)
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT)
  })

  it('keeps a confirmation token intact', () => {
    // A truncated token would make the confirmation unusable, so the real shape
    // must fit.
    const value = `__confirm:${'01234567-89ab-cdef-0123-456789abcdef'}:yes`
    expect(encodeCallbackData(value)).toBe(value)
  })

  it('never splits a multi-byte character', () => {
    const value = 'é'.repeat(100)
    const encoded = encodeCallbackData(value)
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT)
    // Decoding must not produce a replacement character.
    expect(encoded).not.toContain('\uFFFD')
  })
})

describe('inlineKeyboard', () => {
  it('builds one button per row', () => {
    // Stacked reads better than side by side, and Telegram truncates two long
    // labels in one row on a narrow screen.
    const keyboard = inlineKeyboard([
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ])
    expect(keyboard?.inline_keyboard).toEqual([
      [{ text: 'Yes', callback_data: 'yes' }],
      [{ text: 'No', callback_data: 'no' }],
    ])
  })

  it('returns undefined for no buttons', () => {
    expect(inlineKeyboard([])).toBeUndefined()
  })
})

describe('convertCallback', () => {
  it('converts a button press', () => {
    const answer = convertCallback({
      id: 'cb1',
      data: 'yes',
      from: { id: 99887766 },
      message: { message_id: 42, chat: { id: 12345, type: 'private' }, date: 1_700_000_000 },
    })
    expect(answer).toMatchObject({
      questionId: 'tg:12345:42',
      value: 'yes',
      userId: '99887766',
      timestamp: 1_700_000_000_000,
    })
  })

  it('keys the question by the message id', () => {
    // That is what a callback carries, so a press is tied to the message the user
    // actually saw even if two questions look identical.
    const answer = convertCallback({
      id: 'cb1',
      data: 'a',
      from: { id: 1 },
      message: { message_id: 7, chat: { id: 9, type: 'private' }, date: 1 },
    })
    expect(answer?.questionId).toBe('tg:9:7')
  })

  it('carries a topic id', () => {
    const answer = convertCallback(
      {
        id: 'cb1',
        data: 'a',
        from: { id: 1 },
        message: { message_id: 7, chat: { id: 9, type: 'supergroup' }, date: 1 },
      },
      3,
    )
    expect(answer?.address.threadId).toBe('3')
  })

  it('returns undefined with no data', () => {
    expect(
      convertCallback({ id: 'c', from: { id: 1 }, message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 1 } }),
    ).toBeUndefined()
  })

  it('returns undefined with no message', () => {
    expect(convertCallback({ id: 'c', data: 'x', from: { id: 1 } })).toBeUndefined()
  })
})

describe('backoffMs', () => {
  const cases: Array<[number, number]> = [
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [4, 8_000],
    [5, 16_000],
    [6, 32_000],
    [7, 60_000],
    [8, 60_000],
    [50, 60_000],
  ]

  it.each(cases)('doubles from %i to %i ms', (attempt, expected) => {
    expect(backoffMs(attempt)).toBe(expected)
  })

  it('treats a zero or negative attempt as the first', () => {
    expect(backoffMs(0)).toBe(1_000)
    expect(backoffMs(-5)).toBe(1_000)
  })

  it('caps without overflowing', () => {
    // `2 ** 1000` is Infinity, and `Math.min` would return the cap — but only by
    // accident. The attempt is clamped so the arithmetic stays finite.
    expect(Number.isFinite(backoffMs(1_000))).toBe(true)
    expect(backoffMs(1_000)).toBe(60_000)
  })

  it('honours custom bounds', () => {
    expect(backoffMs(1, { baseMs: 100, maxMs: 500 })).toBe(100)
    expect(backoffMs(9, { baseMs: 100, maxMs: 500 })).toBe(500)
  })
})

describe('retryAfterMs', () => {
  it('uses Telegram’s retry_after', () => {
    // Plus a second: retrying exactly on the boundary can hit the same limiter.
    expect(retryAfterMs({ parameters: { retry_after: 30 } }, 1)).toBe(31_000)
  })

  it('accepts the field at the top level too', () => {
    expect(retryAfterMs({ retry_after: 5 }, 1)).toBe(6_000)
  })

  it('falls back to the backoff when it is absent', () => {
    // Retrying immediately is what extends a ban.
    expect(retryAfterMs({ error_code: 500 }, 3)).toBe(4_000)
  })

  it('falls back for a nonsensical value', () => {
    expect(retryAfterMs({ parameters: { retry_after: 0 } }, 2)).toBe(2_000)
    expect(retryAfterMs({ parameters: { retry_after: -1 } }, 2)).toBe(2_000)
    expect(retryAfterMs({ parameters: { retry_after: Number.NaN } }, 2)).toBe(2_000)
  })
})

describe('isPermanentError', () => {
  it('recognizes the codes no retry fixes', () => {
    for (const code of [409, 401, 403, 404]) {
      expect(isPermanentError({ error_code: code }), String(code)).toBe(true)
    }
  })

  it('treats a rate limit and a server error as retryable', () => {
    for (const code of [429, 500, 502, 503]) {
      expect(isPermanentError({ error_code: code }), String(code)).toBe(false)
    }
  })

  it('treats a transport error with no code as retryable', () => {
    expect(isPermanentError(new Error('ECONNRESET'))).toBe(false)
    expect(isPermanentError(undefined)).toBe(false)
  })
})

describe('isConflict', () => {
  it('recognizes a 409', () => {
    expect(isConflict({ error_code: 409 })).toBe(true)
  })

  it('does not confuse another permanent error with it', () => {
    expect(isConflict({ error_code: 401 })).toBe(false)
  })
})

describe('describeError', () => {
  it('renders a Telegram error', () => {
    expect(describeError({ error_code: 429, description: 'Too Many Requests' })).toBe('429: Too Many Requests')
  })

  it('renders a plain error', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('handles an unknown value', () => {
    expect(describeError('x')).toBe('x')
    expect(describeError(undefined)).toBe('undefined')
  })
})

describe('OutgoingQueue', () => {
  it('runs a single send', async () => {
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {} })
    const result = await queue.enqueue('chat', async () => 'sent')
    expect(result).toBe('sent')
  })

  it('serializes sends to one chat', async () => {
    const order: number[] = []
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {} })
    await Promise.all([
      queue.enqueue('chat', async () => {
        order.push(1)
      }),
      queue.enqueue('chat', async () => {
        order.push(2)
      }),
      queue.enqueue('chat', async () => {
        order.push(3)
      }),
    ])
    // In order, not interleaved: the interval is per chat and a send must finish
    // before the next begins.
    expect(order).toEqual([1, 2, 3])
  })

  it('does not let one chat delay another', async () => {
    const order: string[] = []
    const queue = new OutgoingQueue({ intervalMs: 100, sleep: async () => {} })
    await Promise.all([
      queue.enqueue('slow', async () => {
        order.push('slow')
      }),
      queue.enqueue('fast', async () => {
        order.push('fast')
      }),
    ])
    // Two chats, two pumps: the limit is per chat, so a busy one must not hold a
    // quiet one behind it.
    expect(order).toContain('slow')
    expect(order).toContain('fast')
  })

  it('retries after a 429 and succeeds', async () => {
    const attempts: number[] = []
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {}, maxAttempts: 3 })
    const result = await queue.enqueue('chat', async () => {
      attempts.push(1)
      if (attempts.length === 1) throw { error_code: 429, parameters: { retry_after: 1 } }
      return 'sent'
    })
    expect(result).toBe('sent')
    expect(attempts).toHaveLength(2)
    expect(queue.retries).toBe(1)
  })

  it('gives up after the attempt limit', async () => {
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {}, maxAttempts: 3 })
    await expect(
      queue.enqueue('chat', async () => {
        throw { error_code: 500, description: 'boom' }
      }),
    ).rejects.toBeDefined()
    expect(queue.givenUp).toBe(1)
  })

  it('does NOT retry a permanent error', async () => {
    let calls = 0
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {}, maxAttempts: 5 })
    await expect(
      queue.enqueue('chat', async () => {
        calls += 1
        throw { error_code: 401, description: 'Unauthorized' }
      }),
    ).rejects.toBeDefined()
    // One call: retrying a bad token spins forever.
    expect(calls).toBe(1)
    expect(queue.givenUp).toBe(1)
  })

  it('waits the retry_after before trying again', async () => {
    const waits: number[] = []
    const queue = new OutgoingQueue({
      intervalMs: 0,
      maxAttempts: 3,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    let first = true
    await queue.enqueue('chat', async () => {
      if (first) {
        first = false
        throw { error_code: 429, parameters: { retry_after: 30 } }
      }
      return 'ok'
    })
    expect(waits).toContain(31_000)
  })

  it('calls the retry hook with the failure', async () => {
    const onRetry = vi.fn()
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {}, maxAttempts: 3, onRetry })
    let first = true
    await queue.enqueue('chat', async () => {
      if (first) {
        first = false
        throw { error_code: 500, description: 'boom' }
      }
      return 'ok'
    })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ chatId: 'chat', attempt: 1 })
  })

  it('calls the give-up hook', async () => {
    const onGiveUp = vi.fn()
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {}, maxAttempts: 1, onGiveUp })
    await expect(
      queue.enqueue('chat', async () => {
        throw { error_code: 500 }
      }),
    ).rejects.toBeDefined()
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  it('reports what is queued', async () => {
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {} })
    const done = queue.enqueue('chat', async () => 'x')
    await done
    expect(queue.pending).toBe(0)
    expect(queue.pendingChats).toBe(0)
  })

  it('rejects queued items when stopped', async () => {
    const queue = new OutgoingQueue({
      intervalMs: 1_000,
      sleep: async () => {
        /* never resolves promptly, so the second item stays queued */
      },
    })
    const first = queue.enqueue('chat', async () => 'a')
    const second = queue.enqueue('chat', async () => 'b')
    await first
    queue.stop()
    await expect(second).rejects.toThrow(/stopped/)
  })

  it('drains inside the timeout', async () => {
    const queue = new OutgoingQueue({ intervalMs: 0, sleep: async () => {} })
    void queue.enqueue('chat', async () => 'x')
    expect(await queue.drain(1_000)).toBe(true)
  })
})

describe('reconnectDelayMs', () => {
  it('doubles and caps', () => {
    expect(reconnectDelayMs(1)).toBe(1_000)
    expect(reconnectDelayMs(3)).toBe(4_000)
    expect(reconnectDelayMs(20)).toBe(60_000)
  })
})

describe('config', () => {
  it('applies every default', () => {
    const config = telegramOf({})
    expect(config).toEqual({
      bot_token: null,
      max_text_length: 4000,
      max_file_bytes: 50 * 1024 * 1024,
      allow_groups: false,
      register_commands: true,
      send_interval_ms: 1_000,
      max_attempts: 5,
      polling: true,
    })
  })

  it('honours explicit values', () => {
    const config = telegramOf({
      telegram: { bot_token: '123:abc', allow_groups: true, max_text_length: 3000, polling: false },
    })
    expect(config.bot_token).toBe('123:abc')
    expect(config.allow_groups).toBe(true)
    expect(config.max_text_length).toBe(3000)
    expect(config.polling).toBe(false)
  })

  it('declares a text limit below Telegram’s own', () => {
    // Escaping expands the text, so a message that fits before it may not after.
    expect(TELEGRAM_TEXT_LIMIT).toBeLessThan(4096)
    expect(telegramOf({}).max_text_length).toBeLessThan(4096)
  })

  it('rejects a text limit above Telegram’s own', () => {
    expect(() => telegramOf({ telegram: { max_text_length: 5000 } })).toThrow()
  })
})

describe('token validation', () => {
  it('accepts a BotFather-shaped token', () => {
    expect(looksLikeToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe(true)
  })

  it('rejects an unexpanded variable', () => {
    // The plausible mistake, and the one worth catching here rather than as a
    // confusing 401 from Telegram.
    expect(looksLikeToken('${TELEGRAM_BOT_TOKEN}')).toBe(false)
    expect(looksLikeToken('')).toBe(false)
    expect(looksLikeToken(null)).toBe(false)
    expect(looksLikeToken('abc')).toBe(false)
  })

  it('warns about a missing token', () => {
    expect(tokenWarning(null)).toContain('TELEGRAM_BOT_TOKEN')
  })

  it('warns about an unexpanded token, naming the variable', () => {
    expect(tokenWarning('${TELEGRAM_BOT_TOKEN}')).toContain('unexpanded')
  })

  it('never echoes the token value', () => {
    // A token in a log is a leaked token, so the warning carries no part of it.
    const unexpanded = tokenWarning('${TELEGRAM_BOT_TOKEN}')
    expect(unexpanded).toBeDefined()
    expect(unexpanded ?? '').not.toContain('AAHdq')
  })

  it('says nothing about a good token', () => {
    expect(tokenWarning('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBeUndefined()
  })
})
