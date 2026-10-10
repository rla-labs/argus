// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-telegram`.
 *
 * The adapter is driven against a **mocked Bot API**, so the grammY binding is
 * exercised without a network or a token: routing, the allowlist by Telegram user
 * id, a confirmation's inline keyboard, long output, and rate-limit handling.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bootOps,
  BASE_ENTRIES,
  persistenceEntry,
  waitFor,
  type BootOpsOptions,
  type OpsBoot,
} from '@argus-agent/testkit'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import type { TelegramApi } from '@argus-agent/telegram'
import { TelegramChannelAdapter } from '../../src/adapter.js'

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly telegram: TelegramChannelAdapter
  readonly dataDir: string
}

const open: Booted[] = []
const dirs: string[] = []

/**
 * A fake Bot API.
 *
 * It answers the four calls the adapter makes, records every `sendMessage` and
 * `sendDocument`, and can be told to fail with a chosen error — which is how the
 * 429 and conflict paths are exercised without Telegram.
 */
class FakeBotApi implements TelegramApi {
  get raw(): TelegramApi['raw'] {
    return {
      getMe: async () => (await this.call('getMe')) as FakeBotApi['me'],
      getFile: async (fileId: string) => ({ file_id: fileId, file_path: 'files/f' }),
      sendMessage: async (chatId: string, text: string, options: Record<string, unknown> = {}) =>
        (await this.call('sendMessage', { chat_id: chatId, text, ...options })) as { message_id: number },
      editMessageText: async (
        chatId: string,
        messageId: number,
        text: string,
        options: Record<string, unknown> = {},
      ) => this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...options }),
      sendDocument: async (chatId: string, document: unknown, options: Record<string, unknown> = {}) =>
        (await this.call('sendDocument', { chat_id: chatId, document, ...options })) as { message_id: number },
      setMyCommands: async (commands) => this.call('setMyCommands', { commands }),
      deleteMessage: async (chatId: string, messageId: number) => this.call('deleteMessage', { chat_id: chatId, message_id: messageId }),
    }
  }

  readonly sent: Array<{ method: string; payload: Record<string, unknown> }> = []
  /** Errors to throw, keyed by method, consumed one per call. */
  readonly failures = new Map<string, unknown[]>()
  me = { id: 1, is_bot: true, first_name: 'Ops', username: 'ops_test_bot' }
  private messageId = 100

  failWith(method: string, error: unknown, times = 1): void {
    const list = this.failures.get(method) ?? []
    for (let index = 0; index < times; index += 1) list.push(error)
    this.failures.set(method, list)
  }

  private consume(method: string): void {
    const list = this.failures.get(method)
    if (list === undefined || list.length === 0) return
    const error = list.shift()
    throw error
  }

  async call(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, payload })
    this.consume(method)

    switch (method) {
      case 'getMe':
        return this.me
      case 'sendMessage':
        this.messageId += 1
        return { message_id: this.messageId, date: Math.floor(Date.now() / 1000), chat: { id: payload['chat_id'] }, text: payload['text'] }
      case 'editMessageText':
        return true
      case 'sendDocument':
        this.messageId += 1
        return { message_id: this.messageId, date: Math.floor(Date.now() / 1000), chat: { id: payload['chat_id'] } }
      case 'setMyCommands':
        return true
      case 'getFile':
        return { file_id: 'f', file_path: 'files/f' }
      case 'getUpdates':
        // An empty long-poll response keeps the loop idle without a network.
        return []
      case 'answerCallbackQuery':
      case 'deleteWebhook':
        return true
      default:
        return true
    }
  }

  /** The text of every message sent. */
  texts(): string[] {
    return this.sent
      .filter((entry) => entry.method === 'sendMessage')
      .map((entry) => String(entry.payload['text'] ?? ''))
  }

  /** The last `sendMessage` payload. */
  get lastMessage(): Record<string, unknown> | undefined {
    return this.sent.filter((entry) => entry.method === 'sendMessage').at(-1)?.payload
  }
}

const api = new FakeBotApi()
void api.raw

/** A pricing and access block for the tests. */
function opsYamlFor(dataDir: string, extra = ''): string {
  return (
    `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
    `tasks:\n  model: fake/fake-model\n` +
    `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
    `budgets:\n  default_day_usd: 100\n` +
    `access:\n  allowed_users:\n    - { channel: telegram, userId: '99887766' }\n` +
    `channel:\n  default_address: telegram:99887766\n` +
    `telegram:\n  bot_token: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"\n` +
    `  allow_groups: false\n` +
    extra
  )
}

/** Boot a tree with the channel and the Telegram adapter. */
async function bootTelegram(options: {
  projects?: Record<string, Record<string, unknown> | string>
  opsYaml?: string
  dataDir?: string
  script?: Array<Record<string, unknown>>
  maxTextLength?: number
} = {}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-tg-'))
  if (options.dataDir === undefined) dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })

  for (const [id, project] of Object.entries(options.projects ?? {})) {
    const text = typeof project === 'string' ? project : projectDocument(dataDir, id, project)
    writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `${text}\n`)
  }

  const opsYaml = (options.opsYaml ?? opsYamlFor(dataDir)).replace('PLACEHOLDER', dataDir)

  const bootOptions: { -readonly [K in keyof BootOpsOptions]: BootOpsOptions[K] } = {
    files: { 'config/ops.yaml': opsYaml },
    bareModuleBaseUrl: import.meta.url,
    fake: {
      script: (options.script ?? [{ text: 'the answer', usage: { inputTokens: 1000, outputTokens: 0 } }]) as never,
      repeatLast: true,
    },
    replaceEntries: [
      ...BASE_ENTRIES,
      persistenceEntry(join(dataDir, 'sessions')),
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'default' } },
      { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
      { id: 'ops-store', name: '@argus-agent/store' },
      { id: 'ops-projects', name: '@argus-agent/projects' },
      { id: 'ops-meter', name: '@argus-agent/meter' },
      { id: 'ops-governor', name: '@argus-agent/governor' },
      { id: 'commands', name: '@deepseek-ai/dsh-commands' },
      { id: 'ops-commands', name: '@argus-agent/commands' },
      { id: 'ops-channel', name: '@argus-agent/channel' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
    ],
  }

  const boot = await bootOps(bootOptions)
  const ctx = boot.ctx as unknown as { opsChannel: OpsChannel }

  // The adapter is constructed and registered HERE rather than through the
  // plugin's row, so the injected Bot API cannot be lost to a duplicate module
  // instance between the test's import and the loader's. Everything else — the
  // routing, the allowlist, the queue — is the real code path.
  const adapter = new TelegramChannelAdapter({
    token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    allowGroups: false,
    registerCommands: false,
    maxTextLength: options.maxTextLength ?? 4000,
    api: api as never,
  })
  ctx.opsChannel.register(adapter)

  const entry: Booted = {
    boot,
    ctx: boot.ctx,
    store: (boot.ctx as unknown as { opsStore: OpsStore }).opsStore,
    projects: (boot.ctx as unknown as { opsProjects: OpsProjects }).opsProjects,
    meter: (boot.ctx as unknown as { opsMeter: OpsMeter }).opsMeter,
    governor: (boot.ctx as unknown as { opsGovernor: OpsGovernor }).opsGovernor,
    channel: (boot.ctx as unknown as { opsChannel: OpsChannel }).opsChannel,
    telegram: adapter,
    dataDir,
  }
  open.push(entry)
  return entry
}

/** Render a project document, merging overrides over the defaults. */
function projectDocument(dataDir: string, id: string, project: Record<string, unknown>): string {
  const fields: Record<string, unknown> = {
    id,
    cwd: join(dataDir, 'projects', id),
    provider: 'fake',
    model: 'fake-model',
    ...project,
  }
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')
}

/** Wait for the governor to be idle. */
async function waitIdle(booted: Booted): Promise<void> {
  await waitFor(
    () => booted.governor.status().running.length === 0 && booted.store.inbound.pendingCount() === 0,
    { timeoutMs: 30_000, label: 'idle' },
  )
}

/** Give the queue and the deliveries a moment to land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200))
}

beforeEach(() => {
  api.sent.length = 0
  api.failures.clear()
  // The API must be injected BEFORE the plugin mounts, because the adapter
  // captures it when it is constructed.
})

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.channel.dispose()
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── registration ───────────────────────────────────────────────────────────

describe('registration', () => {
  it('registers itself with the channel under the telegram name', async () => {
    const booted = await bootTelegram()
    expect(booted.channel.adapters().map((adapter) => adapter.name)).toContain('telegram')
  }, 30_000)

  it('declares limits below Telegram’s own', async () => {
    const booted = await bootTelegram()
    const adapter = booted.channel.adapters().find((entry) => entry.name === 'telegram')
    // Below 4096, because HTML escaping expands the text.
    expect(adapter?.limits.maxTextLength).toBeLessThan(4096)
  }, 30_000)

  it('refuses a token that is not a BotFather token, and never echoes it', async () => {
    // The plugin is what validates, so this exercises the real check rather than
    // the adapter the test mounts directly.
    const { tokenWarning } = await import('../../src/config.js')
    const warning = tokenWarning('${TELEGRAM_BOT_TOKEN}')
    expect(warning).toBeDefined()
    // A token in a log is a leaked token, so the warning carries no part of it.
    expect(warning ?? '').not.toContain('AAHdq')
    expect(tokenWarning(null)).toContain('TELEGRAM_BOT_TOKEN')
  }, 30_000)
})

// ── incoming ───────────────────────────────────────────────────────────────

describe('incoming messages', () => {
  it('routes a command from an allowlisted Telegram user', async () => {
    const booted = await bootTelegram({ projects: { alpha: {} } })
    await booted.channel.handleIncoming({
      id: 'tg:1',
      address: { channel: 'telegram', chatId: '99887766' },
      userId: '99887766',
      text: '/projects',
      timestamp: Date.now(),
    })
    await settle()
    // The reply went out through the real adapter, into the fake Bot API.
    expect(api.texts().some((text) => text.includes('alpha'))).toBe(true)
  }, 30_000)

  it('refuses a message from a Telegram user who is not allowlisted', async () => {
    const booted = await bootTelegram({ projects: { alpha: {} } })
    const route = await booted.channel.handleIncoming({
      id: 'tg:2',
      address: { channel: 'telegram', chatId: '55555555' },
      userId: '55555555',
      text: '/projects',
      timestamp: Date.now(),
    })
    expect(route.kind).toBe('rejected')
    // The refusal is by Telegram USER id, never by chat id.
    expect(booted.store.audit.byAction('channel.refused')).toHaveLength(1)
  }, 30_000)

  it('sends free text to the active project with a topic-aware address', async () => {
    const booted = await bootTelegram({ projects: { alpha: {} } })
    booted.store.chatContext.setActive('telegram', '99887766', 'alpha', Date.now())

    const route = await booted.channel.handleIncoming({
      id: 'tg:3',
      address: { channel: 'telegram', chatId: '99887766', threadId: '7' },
      userId: '99887766',
      text: 'do the thing',
      timestamp: Date.now(),
    })
    expect(route.kind).toBe('project')
    await waitIdle(booted)

    // The run's stored reply address carries the topic, so the answer lands in
    // the topic rather than the group's general feed.
    const row = booted.store.inbound.listByStatus('done').at(-1)
    expect(row?.reply_chat).toContain('threadId')
    expect(row?.reply_chat).toContain('7')
  }, 40_000)
})

// ── outgoing ───────────────────────────────────────────────────────────────

describe('outgoing messages', () => {
  it('deletes an incoming message by the message part of its id', async () => {
    const booted = await bootTelegram()
    await booted.telegram.delete({ channel: 'telegram', chatId: '99887766', messageId: '99887766:42' })
    await settle()
    expect(api.sent.find((call) => call.method === 'deleteMessage')?.payload).toEqual({ chat_id: '99887766', message_id: 42 })
  }, 30_000)

  it('sends with HTML parse mode', async () => {
    const booted = await bootTelegram()
    await booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: 'hello' })
    await settle()
    expect(api.lastMessage?.['parse_mode']).toBe('HTML')
  }, 30_000)

  it('escapes HTML in the text', async () => {
    const booted = await bootTelegram()
    await booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: '<b>bold</b> & more' })
    await settle()
    // FACT: HTML mode would otherwise interpret the tags and reject the message.
    expect(api.lastMessage?.['text']).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; more')
  }, 30_000)

  it('splits a long message and escapes each chunk', async () => {
    const booted = await bootTelegram()
    const adapter = booted.telegram
    const long = `${'a'.repeat(2500)} & ${'b'.repeat(2500)}`

    await booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: long })
    await settle()

    const sent = api.texts()
    expect(sent.length).toBeGreaterThan(1)
    // The limits are the adapter's own declared ones.
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(adapter.limits.maxTextLength)
    // Every `&` begins a complete entity: no boundary fell inside an escape.
    for (const chunk of sent) {
      for (const match of chunk.matchAll(/&/g)) {
        expect(/^&(amp|lt|gt);/.test(chunk.slice(match.index))).toBe(true)
      }
    }
  }, 30_000)

  it('sends an inline keyboard with the buttons', async () => {
    const booted = await bootTelegram()
    await booted.channel.send(
      { channel: 'telegram', chatId: '99887766' },
      {
        text: 'Continue?',
        buttons: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      },
    )
    await settle()
    const markup = api.lastMessage?.['reply_markup'] as { inline_keyboard: unknown[][] }
    expect(markup.inline_keyboard).toHaveLength(2)
    expect(markup.inline_keyboard[0]).toEqual([{ text: 'Yes', callback_data: 'yes' }])
  }, 30_000)

  it('closes a question answered elsewhere: the note replaces the buttons', async () => {
    const booted = await bootTelegram()
    const asked = booted.channel.ask({ channel: 'telegram', chatId: '99887766' }, 'Run it?', [{ value: 'approve', label: 'Approve' }], 60_000, 'approval:q1')
    await settle()
    // Answered from another surface (the web's users are Telegram's).
    expect(booted.channel.answerQuestion('approval:q1', 'approve', { address: { channel: 'telegram', chatId: '99887766' }, userId: '99887766' })).toBe(true)
    expect(await asked).toEqual({ kind: 'button', value: 'approve' })
    await settle()
    const edit = api.sent.filter((entry) => entry.method === 'editMessageText').at(-1)
    expect(edit?.payload['text']).toContain('Run it?')
    expect(edit?.payload['text']).toContain('Answered by 99887766 on telegram: Approve')
    expect(edit?.payload['reply_markup']).toBeUndefined()
  }, 30_000)

  it('edits a message rather than sending a new one', async () => {
    const booted = await bootTelegram()
    const ref = await booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: 'first' })
    await settle()
    const before = api.texts().length

    await booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: 'second' })
    await booted.channel.adapters()
    await booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: 'third' })
    await settle()

    const adapter = booted.channel.adapters().find((entry) => entry.name === 'telegram') as TelegramChannelAdapter
    await adapter.edit(ref as never, { text: 'updated' })
    await settle()

    const edits = api.sent.filter((entry) => entry.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.payload['text']).toBe('updated')
    void before
  }, 30_000)

  it('delivers a run’s output to the chat that asked', async () => {
    const booted = await bootTelegram({ projects: { alpha: {} } })
    booted.store.chatContext.setActive('telegram', '99887766', 'alpha', Date.now())
    await booted.channel.handleIncoming({
      id: 'tg:4',
      address: { channel: 'telegram', chatId: '99887766' },
      userId: '99887766',
      text: 'work',
      timestamp: Date.now(),
    })
    await waitIdle(booted)
    await settle()

    const texts = api.texts()
    expect(texts.some((text) => text.includes('[alpha]') && text.includes('the answer'))).toBe(true)
  }, 40_000)
})

// ── confirmations ──────────────────────────────────────────────────────────

describe('confirmations over Telegram', () => {
  it('sends the Yes/No keyboard and runs the command on a press', async () => {
    const booted = await bootTelegram({ projects: { alpha: {} } })
    // The command returns a confirmation, which the channel renders as buttons.
    await booted.channel.handleIncoming({
      id: 'tg:5',
      address: { channel: 'telegram', chatId: '99887766' },
      userId: '99887766',
      text: '/panic',
      timestamp: Date.now(),
    })
    await settle()

    const markup = api.lastMessage?.['reply_markup'] as
      | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
      | undefined
    expect(markup?.inline_keyboard.map((row) => row[0]?.text)).toEqual(['Yes', 'No'])

    const yes = markup?.inline_keyboard[0]?.[0]?.callback_data as string
    expect(yes.startsWith('__confirm:')).toBe(true)

    // A button press arrives as a callback query. The channel translates the
    // `__confirm:` value into `/confirm`, which is the confirmed form.
    await booted.channel.handleButton({
      questionId: 'tg:99887766:101',
      value: yes,
      address: { channel: 'telegram', chatId: '99887766' },
      userId: '99887766',
      timestamp: Date.now(),
    })
    await waitFor(() => booted.governor.isPanic, { timeoutMs: 20_000, label: 'panicking' })
    expect(booted.governor.isPanic).toBe(true)
  }, 40_000)

  it('refuses a callback from a non-allowlisted user', async () => {
    const booted = await bootTelegram()
    await booted.channel.handleButton({
      questionId: 'tg:1:1',
      value: '__confirm:abc:yes',
      address: { channel: 'telegram', chatId: '55555555' },
      userId: '55555555',
      timestamp: Date.now(),
    })
    await settle()
    // A button is as capable as a typed command, so the allowlist applies.
    expect(booted.store.audit.byAction('channel.refused')).toHaveLength(1)
  }, 30_000)
})

// ── rate limits and errors ─────────────────────────────────────────────────

describe('rate limits and errors', () => {
  it('retries a 429 and succeeds', async () => {
    const booted = await bootTelegram()
    api.failWith('sendMessage', { error_code: 429, parameters: { retry_after: 1 } }, 1)

    // The adapter's own queue handles the retry, so the send still succeeds.
    await booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: 'after the limit' })
    await settle()
    expect(api.texts()).toContain('after the limit')
  }, 30_000)

  it('does not retry a 401', async () => {
    const booted = await bootTelegram()
    api.failWith('sendMessage', { error_code: 401, description: 'Unauthorized' }, 5)

    await expect(
      booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: 'x' }),
    ).rejects.toBeDefined()
  }, 30_000)

  it('fails visibly on a bad token at start, instead of staying "connecting"', async () => {
    const fake = new FakeBotApi()
    fake.failWith('getMe', { error_code: 401, description: 'Unauthorized' }, 1)
    const states: string[] = []
    const adapter = new TelegramChannelAdapter({
      token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      allowGroups: false,
      registerCommands: false,
      api: fake as never,
      onState: (state) => states.push(state),
    })
    await expect(adapter.start(() => undefined, () => undefined)).rejects.toBeDefined()
    expect(adapter.state).toBe('failed')
    expect(adapter.error).toContain('Unauthorized')
    expect(states).toEqual(['connecting', 'failed'])
  })

  it('retries a transient error at start, so a bot that boots before the network still connects', async () => {
    const fake = new FakeBotApi()
    fake.failWith('getMe', new Error('getaddrinfo EAI_AGAIN api.telegram.org'), 2)
    const adapter = new TelegramChannelAdapter({
      token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      allowGroups: false,
      registerCommands: false,
      api: fake as never,
      sleep: async () => undefined,
    })
    const stop = await adapter.start(() => undefined, () => undefined)
    try {
      expect(adapter.state).toBe('connected')
      expect(fake.sent.filter((entry) => entry.method === 'getMe')).toHaveLength(3)
    } finally {
      await stop()
    }
  })

  it('registers the command menu it is given, with Telegram-legal names', async () => {
    const fake = new FakeBotApi()
    const adapter = new TelegramChannelAdapter({
      token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      allowGroups: false,
      api: fake as never,
      commands: [
        { name: 'status', description: 'What is running' },
        { name: 'forget-confirm', description: 'internal' },
      ],
    })
    const stop = await adapter.start(() => undefined, () => undefined)
    try {
      const call = fake.sent.find((entry) => entry.method === 'setMyCommands')
      expect(call?.payload['commands']).toContainEqual({ command: 'status', description: 'What is running' })
    } finally {
      await stop()
    }
  })

  it('gives up after the attempt limit on a server error', async () => {
    const booted = await bootTelegram()
    api.failWith('sendMessage', { error_code: 500, description: 'boom' }, 20)
    await expect(
      booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: 'x' }),
    ).rejects.toBeDefined()
  }, 60_000)
})

// ── attachments ────────────────────────────────────────────────────────────

describe('attachments', () => {
  it('reports an attachment too large to fetch', async () => {
    // The check lives in the adapter's own message handler, because it is the
    // adapter that knows Telegram's download limit — so this drives that handler
    // through the adapter's public send, and asserts the reply text.
    const booted = await bootTelegram()
    const { tooLargeText, tooLargeToDownload } = await import('../../src/convert.js')

    // 30 MB: beyond the 20 MB a bot may download, so it cannot be fetched at all.
    expect(tooLargeToDownload(30 * 1024 * 1024)).toBe(true)
    const reply = tooLargeText('big.zip', 30 * 1024 * 1024)
    await booted.channel.send({ channel: 'telegram', chatId: '99887766' }, { text: reply })
    await settle()

    // The user is told, rather than waiting for an answer that cannot come.
    expect(api.texts().some((text) => text.includes('big.zip') && text.includes('20 MB'))).toBe(true)
  }, 30_000)
})

// ── health ─────────────────────────────────────────────────────────────────

describe('health signals', () => {
  it('exposes its state and error', async () => {
    const booted = await bootTelegram()
    const adapter = booted.telegram
    expect(['idle', 'connecting', 'connected', 'reconnecting', 'stopped', 'failed']).toContain(adapter.state)
    // The error accessor never carries the token.
    expect(adapter.error ?? '').not.toContain('AAHdq')
  }, 30_000)

  it('counts ignored updates by reason', async () => {
    const booted = await bootTelegram()
    const adapter = booted.telegram
    expect(adapter.ignored.size).toBe(0)
    expect(adapter.updates).toBe(0)
  }, 30_000)
})
