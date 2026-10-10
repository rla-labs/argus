// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-channel`.
 *
 * The console adapter from `ops-testkit` drives every case, because the point of
 * the package is that a real adapter is thin enough to be exercised this way.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ButtonAnswer, IncomingMessage } from '@argus-agent/types'
import {
  bootOps,
  BASE_ENTRIES,
  persistenceEntry,
  waitFor,
  type BootOpsOptions,
  type OpsBoot,
} from '@argus-agent/testkit'
import { ConsoleChannelAdapter } from '@argus-agent/testkit'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsCommands } from '@argus-agent/commands'
import type { OpsChannel } from '../../src/service.js'

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly commands: OpsCommands
  readonly channel: OpsChannel
  readonly adapter: ConsoleChannelAdapter
  readonly dataDir: string
}

const open: Booted[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.channel.dispose()
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A pricing and access block for the tests. */
function opsYamlFor(dataDir: string, extra = ''): string {
  // `extra` is inserted at the TOP level, before the `channel:` block, so a
  // caller can add a top-level section (`concurrency:`) or an extra channel key
  // by indenting it itself.
  return (
    `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
    `tasks:\n  model: fake/fake-model\n` +
    `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n  deepseek/*: { input: 0.14, cached: 0.014, output: 0.28 }\n` +
    `budgets:\n  default_day_usd: 100\n` +
    `access:\n  allowed_users:\n    - { channel: console, userId: user-1 }\n` +
    `  admin: console:admin-chat\n` +
    `  warn_interval_minutes: 15\n` +
    extra +
    `channel:\n  default_address: console:default-chat\n` +
    `  progress_interval_s: 20\n`
  )
}

/** Boot a tree with the whole chain plus a console adapter. */
async function bootChannel(options: {
  projects?: Record<string, Record<string, unknown> | string>
  opsYaml?: string
  dataDir?: string
  script?: Array<Record<string, unknown>>
  limits?: { maxTextLength: number; maxFileBytes: number }
} = {}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-chan-'))
  if (options.dataDir === undefined) dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })

  for (const [id, project] of Object.entries(options.projects ?? {})) {
    const text = typeof project === 'string' ? project : projectDocument(dataDir, id, project)
    writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `${text}\n`)
  }

  const bootOptions: { -readonly [K in keyof BootOpsOptions]: BootOpsOptions[K] } = {
    files: { 'config/ops.yaml': options.opsYaml ?? opsYamlFor(dataDir) },
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
  const channel = (boot.ctx as unknown as { opsChannel: OpsChannel }).opsChannel
  const adapter = new ConsoleChannelAdapter(options.limits === undefined ? {} : { limits: options.limits })
  channel.register(adapter)

  const entry: Booted = {
    boot,
    ctx: boot.ctx,
    store: (boot.ctx as unknown as { opsStore: OpsStore }).opsStore,
    projects: (boot.ctx as unknown as { opsProjects: OpsProjects }).opsProjects,
    meter: (boot.ctx as unknown as { opsMeter: OpsMeter }).opsMeter,
    governor: (boot.ctx as unknown as { opsGovernor: OpsGovernor }).opsGovernor,
    commands: (boot.ctx as unknown as { opsCommands: OpsCommands }).opsCommands,
    channel,
    adapter,
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

let messageCounter = 0

/** An incoming message from an allowed user. */
function message(text: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  messageCounter += 1
  return {
    id: `msg-${messageCounter}`,
    address: { channel: 'console', chatId: 'chat-1' },
    userId: 'user-1',
    text,
    timestamp: Date.now(),
    ...overrides,
  }
}

/** Wait for the governor to be idle. */
async function waitIdle(booted: Booted): Promise<void> {
  await waitFor(
    () => booted.governor.status().running.length === 0 && booted.store.inbound.pendingCount() === 0,
    { timeoutMs: 30_000, label: 'idle' },
  )
}

/** Give the adapter's asynchronous deliveries a moment to land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150))
}

// ── the Definition of Done ─────────────────────────────────────────────────

describe('end to end with the console adapter', () => {
  it('creates a project, sends free text, receives the result and checks usage', async () => {
    const booted = await bootChannel()

    // 1. Create a project through a command.
    await booted.channel.handleIncoming(message('/new reports fake/fake-model'))
    await settle()
    expect(booted.projects.configOf('reports')).toBeDefined()

    // 2. Make it active.
    await booted.channel.handleIncoming(message('/p reports'))
    await settle()

    // 3. Send free text. It goes to the project, verbatim.
    await booted.channel.handleIncoming(message('summarise the numbers'))
    await waitIdle(booted)
    await booted.meter.flush()
    await settle()

    // 4. The result arrived, prefixed with the project.
    const texts = booted.adapter.sent.map((entry) => entry.message.text)
    expect(texts.some((text) => text.includes('[reports]') && text.includes('the answer'))).toBe(true)

    // 5. Usage reports the cost.
    await booted.channel.handleIncoming(message('/usage reports'))
    await settle()
    const usage = booted.adapter.sent.at(-1)?.message.text ?? ''
    expect(usage).toContain('project:reports')
    expect(usage).toContain('$0.001')

    // And the submission was recorded against that project.
    const runs = booted.store.runs.recent(5)
    expect(runs.some((run) => run.project_id === 'reports')).toBe(true)
  }, 60_000)
})

// ── routing ────────────────────────────────────────────────────────────────

describe('routing', () => {
  it('routes a command to the command layer', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const route = await booted.channel.handleIncoming(message('/projects'))
    await settle()
    expect(route.kind).toBe('command')
    expect(booted.adapter.sent.at(-1)?.message.text).toContain('alpha')
  }, 30_000)

  it('routes free text to the active project', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('/p alpha'))
    const route = await booted.channel.handleIncoming(message('do the thing'))
    await waitIdle(booted)
    expect(route.kind).toBe('project')
    expect(route.projectId).toBe('alpha')
  }, 40_000)

  it('forwards the text VERBATIM', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('/p alpha'))
    const text = 'keep  the   double  spaces'
    await booted.channel.handleIncoming(message(text))
    await waitIdle(booted)

    const row = booted.store.inbound.listByStatus('done')[0]
    const payload = JSON.parse(row?.payload ?? '{}') as { content: Array<{ text: string }> }
    expect(payload.content[0]?.text).toBe(text)
  }, 40_000)

  it('offers help when there is no active project and no orchestrator', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const route = await booted.channel.handleIncoming(message('hello'))
    await settle()
    expect(route.kind).toBe('help')
    const text = booted.adapter.sent.at(-1)?.message.text ?? ''
    expect(text).toContain('/p')
    expect(text).toContain('/task')
  }, 30_000)

  it('hands free text to the orchestrator through the event, never by calling the service', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    // The event's handler sends the reply and catches a failed turn; a direct call
    // dropped both, and a failed turn stopped the process.
    let called = 0
    booted.ctx.provide('opsOrchestrator', { submit: () => { called++ } } as never)
    const seen: string[] = []
    booted.ctx.on('ops/orchestrator-input', (payload) => seen.push(payload.text))

    await booted.channel.handleIncoming(message('what is the status of everything'))
    await settle()
    expect(seen).toEqual(['what is the status of everything'])
    expect(called).toBe(0)
  }, 30_000)

  it('acknowledges only when the work did not start immediately', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-chan-ack-'))
    dirs.push(dataDir)
    const booted = await bootChannel({
      dataDir,
      projects: { alpha: {}, beta: {} },
      // One slot, nothing reserved, so the second message genuinely queues.
      opsYaml: opsYamlFor(dataDir, 'concurrency:\n  global_max_running: 1\n  reserve_interactive: 0\n'),
    })
    // The first message occupies the only slot; the second must be acknowledged.
    booted.boot.fake!.setScript([
      { text: 'slow', latencyMs: 3_000, usage: { inputTokens: 1, outputTokens: 0 } },
    ])
    await booted.channel.handleIncoming(message('/p beta'))
    await settle()
    await booted.channel.handleIncoming(message('first'))
    await waitFor(() => booted.governor.status().running.length === 1, { timeoutMs: 20_000, label: 'running' })
    await booted.channel.handleIncoming(message('second'))
    await settle()

    const texts = booted.adapter.sent.map((entry) => entry.message.text)
    expect(texts.some((text) => text.includes('queued for beta'))).toBe(true)
    await waitIdle(booted)
  }, 60_000)

  it('ignores a redelivered message', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('/p alpha'))
    const repeated = message('work')
    await booted.channel.handleIncoming(repeated)
    await waitIdle(booted)
    const runsAfterFirst = booted.store.runs.recent(10).length

    // The same message id again is a redelivery, not a second request.
    const route = await booted.channel.handleIncoming(repeated)
    expect(route.kind).toBe('rejected')
    expect(booted.store.runs.recent(10).length).toBe(runsAfterFirst)
  }, 40_000)

  it('treats a command as a command whatever the active project is', async () => {
    const booted = await bootChannel({ projects: { alpha: {}, beta: {} } })
    await booted.channel.handleIncoming(message('/p alpha'))
    const route = await booted.channel.handleIncoming(message('/status beta'))
    await settle()
    expect(route.kind).toBe('command')
    expect(booted.adapter.sent.at(-1)?.message.text).toContain('Project beta')
  }, 30_000)
})

// ── access control ─────────────────────────────────────────────────────────

describe('access control', () => {
  it('lets `access.admin: <id>` alone operate, and sends unaddressed output there', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-chan-'))
    dirs.push(dataDir)
    // The whole access configuration of a single-operator install.
    const opsYaml =
      `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
      `tasks:\n  model: fake/fake-model\n` +
      `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
      `access:\n  admin: 4242\n`
    const booted = await bootChannel({ dataDir, opsYaml, projects: { alpha: {} } })
    const telegram = { channel: 'telegram', chatId: '4242' }

    expect(booted.channel.defaultAddress()).toEqual(telegram)
    expect(booted.channel.access.isAllowed('telegram', '4242')).toBe(true)
    expect(booted.channel.access.isAllowed('telegram', '4243')).toBe(false)
  }, 30_000)

  it('drops a message from a user who is not allowlisted', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const route = await booted.channel.handleIncoming(message('/projects', { userId: 'stranger' }))
    await settle()

    expect(route.kind).toBe('rejected')
    // FACT: nothing from that user reached the command layer.
    const texts = booted.adapter.sent.map((entry) => entry.message.text)
    expect(texts.some((text) => text.includes('Project'))).toBe(false)
  }, 30_000)

  it('never logs the message content of a refused user', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('SECRET-CONTENT', { userId: 'stranger' }))
    await settle()

    const rows = booted.store.audit.byAction('channel.refused')
    expect(rows).toHaveLength(1)
    // The refusal names the identity and nothing else: a stranger's text is
    // untrusted, and an operator's log is not the place for it.
    expect(JSON.stringify(rows[0])).not.toContain('SECRET-CONTENT')
    expect(rows[0]?.actor).toBe('stranger')
  }, 30_000)

  it('warns the admin, rate-limited', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    for (let index = 0; index < 5; index += 1) {
      await booted.channel.handleIncoming(message('spam', { userId: 'stranger' }))
    }
    await settle()

    const warnings = booted.adapter.sent.filter(
      (entry) => entry.to.chatId === 'admin-chat' && entry.message.text.includes('unauthorized'),
    )
    // One warning, not five: a warning per message would flood the admin's chat
    // and turn a nuisance into an outage.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message.text).toContain('stranger')
  }, 30_000)

  it('denies everything with no allowlist at all', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-chan-none-'))
    dirs.push(dataDir)
    const booted = await bootChannel({
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n  deepseek/*: { input: 0.14, cached: 0.014, output: 0.28 }\n` +
        `budgets:\n  default_day_usd: 100\n`,
    })
    const route = await booted.channel.handleIncoming(message('/projects'))
    expect(route.kind).toBe('rejected')
    expect(route.reason).toBe('no_allowlist')
  }, 30_000)

  it('drops a BUTTON answer from a user who is not allowlisted', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const answer: ButtonAnswer = {
      questionId: 'q-1',
      value: 'yes',
      address: { channel: 'console', chatId: 'chat-1' },
      userId: 'stranger',
      timestamp: Date.now(),
    }
    await booted.channel.handleButton(answer)
    await settle()

    // The adapter contract says `ask` must not enforce the allowlist, so this is
    // the only place it can happen — and it must.
    const rows = booted.store.audit.byAction('channel.refused')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor).toBe('stranger')
  }, 30_000)

  it('accepts a button answer from an allowlisted user', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const asked = booted.channel.ask(
      { channel: 'console', chatId: 'chat-1' },
      'Continue?',
      [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
      5_000,
    )
    await settle()
    expect(booted.adapter.answer('yes', 'user-1')).toBe(true)
    expect(await asked).toEqual({ kind: 'button', value: 'yes' })
  }, 30_000)

  it('runs a confirmation button through the command path', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('/panic'))
    await settle()
    const buttons = booted.adapter.sent.at(-1)?.message.buttons ?? []
    const yes = buttons.find((button) => button.label === 'Yes')
    expect(yes).toBeDefined()

    booted.ctx.on('ops/channel-refused', (p) => console.error('DIAGREF', JSON.stringify(p)))
    // A confirmation button's value IS the command line, so pressing it goes
    // through the same dispatch as anything else.
    await booted.channel.handleButton({
      questionId: 'confirm-1',
      value: yes?.value as string,
      address: { channel: 'console', chatId: 'chat-1' },
      userId: 'user-1',
      timestamp: Date.now(),
    })
    await settle()
    console.error('DIAGAFTER sent:', JSON.stringify(booted.adapter.texts()))
    await waitFor(() => booted.governor.isPanic, { timeoutMs: 20_000, label: 'panicking' })
    expect(booted.governor.isPanic).toBe(true)
  }, 40_000)
})

// ── attachments ────────────────────────────────────────────────────────────

describe('attachments', () => {
  it('saves an attachment into the active project’s inbox and references it', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('/p alpha'))
    await booted.channel.handleIncoming(
      message('summarise this', {
        attachments: [
          { kind: 'file', name: 'data.csv', mimeType: 'text/csv', bytes: new TextEncoder().encode('a,b\n1,2') },
        ],
      }),
    )
    await waitIdle(booted)

    const inbox = join(booted.dataDir, 'projects', 'alpha', 'inbox')
    expect(existsSync(inbox)).toBe(true)
    expect(readdirSync(inbox)).toContain('data.csv')

    // The submitted content names the saved path, so the agent can read it.
    const row = booted.store.inbound.listByStatus('done').at(-1)
    expect(row?.payload).toContain('data.csv')
    expect(row?.payload).toContain(inbox)
  }, 40_000)

  it('keeps the original text alongside the attachment', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('/p alpha'))
    await booted.channel.handleIncoming(
      message('what does this say', {
        attachments: [{ kind: 'file', name: 'x.txt', bytes: new TextEncoder().encode('hi') }],
      }),
    )
    await waitIdle(booted)
    const row = booted.store.inbound.listByStatus('done').at(-1)
    expect(row?.payload).toContain('what does this say')
  }, 40_000)

  it('cannot escape the inbox with a crafted name', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('/p alpha'))
    await booted.channel.handleIncoming(
      message('evil', {
        attachments: [{ kind: 'file', name: '../../../../etc/passwd', bytes: new TextEncoder().encode('x') }],
      }),
    )
    await waitIdle(booted)

    const inbox = join(booted.dataDir, 'projects', 'alpha', 'inbox')
    const saved = readdirSync(inbox)
    expect(saved).toHaveLength(1)
    // The directory name is kept but the traversal is stripped.
    expect(saved[0]).toBe('passwd')
    expect(existsSync('/etc/passwd')).toBe(true)
  }, 40_000)

  it('saves an attachment with no active project into the scratch inbox', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-chan-scratch-'))
    dirs.push(dataDir)
    const scratch = join(dataDir, 'attach-scratch')
    const booted = await bootChannel({
      dataDir,
      opsYaml: opsYamlFor(dataDir).replace(
        'channel:\n  default_address:',
        `channel:\n  attachment_scratch: ${JSON.stringify(scratch)}\n  default_address:`,
      ),
    })
    // The routing rule sends free text with no active project to the orchestrator
    // ONLY when one is mounted, so this test mounts one. It records what it
    // receives instead of doing any work.
    const forwarded: Array<{ text: string; attachments: readonly string[] }> = []
    booted.ctx.provide('opsOrchestrator', { submit: () => undefined } as never)
    booted.ctx.on('ops/orchestrator-input', (input) => forwarded.push({ text: input.text, attachments: input.attachments ?? [] }))

    const route = await booted.channel.handleIncoming(
      message('look at this', {
        attachments: [{ kind: 'file', name: 'notes.txt', bytes: new TextEncoder().encode('hi') }],
      }),
    )
    void route
    await settle()

    expect(existsSync(join(scratch, 'inbox'))).toBe(true)
    expect(readdirSync(join(scratch, 'inbox'))).toContain('notes.txt')
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]?.text).toBe('look at this')
    expect(forwarded[0]?.attachments[0]).toContain('notes.txt')
  }, 30_000)
})

// ── delivery ───────────────────────────────────────────────────────────────

describe('delivery', () => {
  it('prefixes output with the project', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.handleIncoming(message('/p alpha'))
    await booted.channel.handleIncoming(message('work'))
    await waitIdle(booted)
    await settle()
    expect(booted.adapter.sent.map((entry) => entry.message.text).some((text) => text.startsWith('[alpha] '))).toBe(true)
  }, 40_000)

  it('sends a file a project agent names with send_file, to the chat its work came from', async () => {
    const booted = await bootChannel({
      projects: { alpha: {} },
      script: [
        { toolCalls: [{ id: 'c1', name: 'send_file', arguments: JSON.stringify({ paths: ['out/site.zip'], caption: 'the site' }) }] },
        { text: 'Sent.' },
      ],
    })
    const cwd = booted.projects.configOf('alpha')!.cwd
    mkdirSync(join(cwd, 'out'), { recursive: true })
    writeFileSync(join(cwd, 'out', 'site.zip'), 'zip bytes')
    await booted.channel.handleIncoming(message('/p alpha'))
    await booted.channel.handleIncoming(message('send me the site'))
    await waitIdle(booted)
    await settle()
    const sent = booted.adapter.sent.find((entry) => (entry.message.files?.length ?? 0) > 0)
    expect(sent?.message.text).toBe('[alpha] the site')
    expect(sent?.message.files?.[0]).toMatchObject({ name: 'site.zip', path: join(cwd, 'out', 'site.zip') })
  }, 40_000)

  it('send_file zips several files or a folder into one archive, then removes it', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const cwd = booted.projects.configOf('alpha')!.cwd
    mkdirSync(join(cwd, 'site', 'css'), { recursive: true })
    writeFileSync(join(cwd, 'site', 'index.html'), '<html>')
    writeFileSync(join(cwd, 'site', 'css', 'style.css'), 'body{}')
    writeFileSync(join(cwd, 'notes.md'), '# notes')
    const listed: string[] = []
    const send = booted.adapter.send.bind(booted.adapter)
    booted.adapter.send = async (to, message) => {
      for (const file of message.files ?? []) listed.push(execFileSync('unzip', ['-Z1', file.path], { encoding: 'utf8' }))
      return send(to, message)
    }
    const alpha = { kind: 'project', projectId: 'alpha' } as const
    expect(await booted.channel.sendFile(alpha, ['site', 'notes.md'])).toMatch(/^Sent alpha\.zip/)
    expect(listed[0]?.trim().split('\n').sort()).toEqual(['notes.md', 'site/', 'site/css/', 'site/css/style.css', 'site/index.html'])
    expect(await booted.channel.sendFile(alpha, ['site'])).toMatch(/^Sent site\.zip/)
    expect(existsSync(booted.adapter.sent.at(-1)!.message.files![0]!.path)).toBe(false)
  }, 40_000)

  it('send_file refuses what is outside the folder, missing, too large, or from the front desk', async () => {
    const booted = await bootChannel({ projects: { alpha: {} }, limits: { maxTextLength: 4000, maxFileBytes: 10 } })
    const cwd = booted.projects.configOf('alpha')!.cwd
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'big.txt'), 'more than ten bytes')
    const alpha = { kind: 'project', projectId: 'alpha' } as const
    expect(await booted.channel.sendFile(alpha, '../../ops.sqlite')).toContain('outside your folder')
    expect(await booted.channel.sendFile(alpha, [])).toContain('paths is required')
    expect(await booted.channel.sendFile(alpha, 'missing.txt')).toContain('does not exist')
    expect(await booted.channel.sendFile(alpha, 'big.txt')).toContain('at most')
    expect(await booted.channel.sendFile({ kind: 'orchestrator' }, 'x')).toContain('front desk')
    expect(booted.adapter.sent.filter((entry) => (entry.message.files?.length ?? 0) > 0)).toHaveLength(0)
  }, 40_000)

  it('send_file sends from a task\'s own folder', async () => {
    const booted = await bootChannel()
    const dir = booted.projects.taskDirOf('task-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'report.md'), '# report')
    expect(await booted.channel.sendFile({ kind: 'adhoc', runId: 'task-1' }, 'report.md')).toMatch(/^Sent report\.md/)
    expect(booted.adapter.sent.at(-1)?.message).toMatchObject({ text: '[task] report.md', files: [{ name: 'report.md' }] })
  }, 40_000)

  it('prefixes ad-hoc output with [task]', async () => {
    const booted = await bootChannel()
    await booted.channel.handleIncoming(message('/task do something'))
    await waitIdle(booted)
    await settle()
    expect(booted.adapter.sent.map((entry) => entry.message.text).some((text) => text.startsWith('[task] '))).toBe(true)
  }, 40_000)

  it('converts long output to a markdown attachment', async () => {
    const booted = await bootChannel({
      projects: { alpha: {} },
      script: [{ text: 'L'.repeat(500), usage: { inputTokens: 10, outputTokens: 0 } }],
      limits: { maxTextLength: 200, maxFileBytes: 100_000 },
    })
    await booted.channel.handleIncoming(message('/p alpha'))
    await booted.channel.handleIncoming(message('write a lot'))
    await waitIdle(booted)
    await settle()

    const withFile = booted.adapter.sent.find((entry) => (entry.message.files?.length ?? 0) > 0)
    expect(withFile).toBeDefined()
    expect(withFile?.message.files?.[0]?.name).toBe('alpha-output.md')
    expect(withFile?.message.text).toContain('sent as alpha-output.md')
    // The summary is short, because the whole reason for converting was length.
    expect((withFile?.message.text.length ?? 0)).toBeLessThan(200)
  }, 40_000)

  it('attaches a file /get names, and names one too large to send', async () => {
    const booted = await bootChannel({ projects: { alpha: {} }, limits: { maxTextLength: 4000, maxFileBytes: 10 } })
    const cwd = join(booted.dataDir, 'projects', 'alpha')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'small.txt'), 'tiny')
    writeFileSync(join(cwd, 'big.txt'), 'x'.repeat(50))

    await booted.channel.handleIncoming(message('/get alpha small.txt'))
    expect(booted.adapter.sent.at(-1)?.message.files).toEqual([{ name: 'small.txt', path: join(cwd, 'small.txt') }])

    await booted.channel.handleIncoming(message('/get alpha big.txt'))
    const big = booted.adapter.sent.at(-1)?.message
    expect(big?.files).toBeUndefined()
    expect(big?.text).toContain(`Too large to send here: ${join(cwd, 'big.txt')}`)
  }, 30_000)

  it('/allow is the admin’s, and lets a user in or out on the next message', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const admin = (text: string): IncomingMessage =>
      message(text, { address: { channel: 'console', chatId: 'admin-chat' }, userId: 'admin-chat' })
    const stranger = (text: string): IncomingMessage =>
      message(text, { address: { channel: 'console', chatId: 'chat-2' }, userId: 'user-2' })

    await booted.channel.handleIncoming(message('/allow user-2'))
    expect(booted.adapter.sent.at(-1)?.message.text).toContain('Only the admin')
    expect((await booted.channel.handleIncoming(stranger('/projects'))).kind).toBe('rejected')

    await booted.channel.handleIncoming(admin('/allow user-2'))
    const yes = booted.adapter.sent.at(-1)?.message.buttons?.find((button) => button.label === 'Yes')?.value ?? ''
    const token = /^__confirm:([^:]+):yes$/.exec(yes)?.[1]
    expect(token, 'a confirmation').toBeDefined()
    await booted.channel.handleIncoming(admin(`/confirm ${token} yes`))
    expect(booted.adapter.sent.at(-1)?.message.text).toContain('user-2 can now use the bot on console')
    expect((await booted.channel.handleIncoming(stranger('/projects'))).kind).toBe('command')

    await booted.channel.handleIncoming(admin('/allow remove user-2'))
    expect((await booted.channel.handleIncoming(stranger('/projects'))).kind).toBe('rejected')
  }, 30_000)

  it('delivers a stop notice', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.ctx.emit('ops/run-stopped', {
      runId: 'run-x',
      owner: { kind: 'project', projectId: 'alpha' },
      reason: 'loop_detected',
      detail: 'the tool repeated',
    })
    await settle()
    const text = booted.adapter.sent.at(-1)?.message.text ?? ''
    expect(text).toContain('stopped')
    expect(text).toContain('loop_detected')
  }, 30_000)

  it('tells the sender why the governor refused a request', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.governor.submit({
      source: 'channel',
      target: { projectId: 'ghost' },
      content: [{ type: 'text', text: 'hello' }],
      priority: 0,
      replyTo: { channel: 'console', chatId: 'chat-7' },
    })
    await waitFor(() => booted.adapter.sent.some((entry) => entry.message.text.startsWith('Not run')))
    const notice = booted.adapter.sent.find((entry) => entry.message.text.startsWith('Not run'))
    expect(notice?.to.chatId).toBe('chat-7')
    expect(notice?.message.text).toContain('PROJECT_NOT_FOUND')
  }, 30_000)

  it('tells the operator which project files are invalid, and when they are fixed', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.ctx.emit('ops/projects-invalid', {
      invalid: [{ id: 'beta', path: '/x/beta.yaml', reason: 'cwd: /etc is not inside /x/projects' }],
      fixed: [],
    })
    await settle()
    const broken = booted.adapter.sent.at(-1)?.message.text ?? ''
    expect(broken).toContain('beta — /x/beta.yaml')
    expect(broken).toContain('cwd: /etc')
    expect(broken).toContain('everything else keeps running')
    expect(broken).toContain('/reload')

    booted.ctx.emit('ops/projects-invalid', { invalid: [], fixed: ['beta'] })
    await settle()
    expect(booted.adapter.sent.at(-1)?.message.text).toContain('Valid again: beta')
  }, 30_000)

  it('delivers an interruption notice', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.ctx.emit('ops/run-interrupted', {
      runId: 'run-y',
      owner: { kind: 'project', projectId: 'alpha' },
    })
    await settle()
    expect(booted.adapter.sent.at(-1)?.message.text).toContain('interrupted')
  }, 30_000)

  it('delivers a budget threshold to the default address', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.ctx.emit('ops/budget-threshold', {
      scope: 'project:alpha' as never,
      period: 'day' as never,
      level: 'hard' as never,
      pct: 120,
      spentMicros: 12_000_000 as never,
      limitMicros: 10_000_000 as never,
    })
    await settle()
    const last = booted.adapter.sent.at(-1)
    expect(last?.to.chatId).toBe('default-chat')
    expect(last?.message.text).toContain('project:alpha')
    expect(last?.message.text).toContain('hard')
  }, 30_000)

  it('delivers a stalled-queue notice', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.ctx.emit('ops/queue-stalled', {
      requestId: 'req-1',
      owner: { kind: 'project', projectId: 'alpha' },
      priority: 1 as never,
      waitedMs: 900_000,
      reason: 'global_slots_full',
    })
    await settle()
    const text = booted.adapter.sent.at(-1)?.message.text ?? ''
    expect(text).toContain('15 minute(s)')
    expect(text).toContain('global_slots_full')
  }, 30_000)

  it('delivers a panic notice', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.ctx.emit('ops/panic', { cancelled: 2, tookMs: 90 })
    await settle()
    const text = booted.adapter.sent.at(-1)?.message.text ?? ''
    expect(text).toContain('PANIC')
    expect(text).toContain('2 agent(s)')
  }, 30_000)

  it('logs a notice the channel refuses, instead of crashing on an unhandled rejection', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.adapter.send = async () => {
      throw new Error("Call to 'sendMessage' failed! (401: Unauthorized)")
    }
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      booted.ctx.emit('ops/panic', { cancelled: 0, tookMs: 1 })
      await settle()
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  }, 30_000)

  it('emits ops/channel-output when it delivers a run’s output', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const seen: string[] = []
    booted.ctx.on('ops/channel-output', ({ runId }) => seen.push(runId))

    await booted.channel.handleIncoming(message('/p alpha'))
    await booted.channel.handleIncoming(message('work'))
    await waitIdle(booted)
    await settle()
    expect(seen).toHaveLength(1)
  }, 40_000)

  it('delivers a scheduled run’s output to the default address', async () => {
    // Nobody asked for a scheduled run, so it has no reply address of its own.
    const booted = await bootChannel({ projects: { alpha: {} } })
    const { requestId } = booted.governor.submit({
      source: 'scheduler',
      target: { projectId: 'alpha' },
      content: [{ type: 'text', text: 'scheduled work' }],
      priority: 1,
    })
    await waitIdle(booted)
    await settle()

    const delivered = booted.adapter.sent.filter((entry) => entry.message.text.includes('the answer'))
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered.at(-1)?.to.chatId).toBe('default-chat')
    void requestId
  }, 40_000)
})

// ── progress ───────────────────────────────────────────────────────────────

describe('progress', () => {
  it('sends once and then edits', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const address = { channel: 'console', chatId: 'chat-1' }
    booted.channel.rememberReplyTo('run-p', address)

    await booted.channel.reportProgress('run-p', { kind: 'project', projectId: 'alpha' }, 'working… 1')
    await settle()
    expect(booted.channel.progressCount).toBe(1)
    expect(booted.adapter.sent).toHaveLength(1)
    expect(booted.adapter.sent[0]?.edited).toBeFalsy()
  }, 30_000)

  it('throttles a second update inside the interval', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.channel.rememberReplyTo('run-q', { channel: 'console', chatId: 'chat-1' })

    await booted.channel.reportProgress('run-q', { kind: 'project', projectId: 'alpha' }, 'first')
    await settle()
    const afterFirst = booted.adapter.sent.length

    await booted.channel.reportProgress('run-q', { kind: 'project', projectId: 'alpha' }, 'second')
    await settle()
    // Within the interval nothing is sent at all — not even an edit.
    expect(booted.adapter.sent.length).toBe(afterFirst)
  }, 30_000)

  it('sends nothing when progress is disabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-chan-noprog-'))
    dirs.push(dataDir)
    const booted = await bootChannel({
      projects: { alpha: {} },
      opsYaml: opsYamlFor(dataDir).replace(
        '  progress_interval_s: 20\n',
        '  progress_interval_s: 20\n  progress_enabled: false\n',
      ),
    })
    booted.channel.rememberReplyTo('run-r', { channel: 'console', chatId: 'chat-1' })
    await booted.channel.reportProgress('run-r', { kind: 'project', projectId: 'alpha' }, 'working')
    await settle()
    expect(booted.adapter.sent).toHaveLength(0)
  }, 30_000)

  it('forgets a run’s progress when its output is delivered', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    booted.channel.rememberReplyTo('run-s', { channel: 'console', chatId: 'chat-1' })
    await booted.channel.deliverRunOutput('run-s', { kind: 'project', projectId: 'alpha' }, [
      { type: 'text', text: 'done' },
    ])
    expect(booted.channel.progressCount).toBe(0)
  }, 30_000)
})

// ── ask ────────────────────────────────────────────────────────────────────

describe('ask', () => {
  it('resolves with the answer', async () => {
    const booted = await bootChannel()
    const asked = booted.channel.ask(
      { channel: 'console', chatId: 'chat-1' },
      'Which one?',
      [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      5_000,
    )
    await settle()
    const question = booted.adapter.pendingQuestion
    expect(question?.text).toBe('Which one?')

    // Pressing through the adapter is what a platform does; the adapter then
    // notifies the channel, which is where the allowlist check runs.
    expect(booted.adapter.answer('b', 'user-1')).toBe(true)
    await settle()
    expect(await asked).toEqual({ kind: 'button', value: 'b' })
    expect(booted.channel.pendingQuestions).toBe(0)
    expect(booted.channel.lastAnswer?.value).toBe('b')
  }, 30_000)

  it('times out', async () => {
    const booted = await bootChannel()
    const answer = await booted.channel.ask(
      { channel: 'console', chatId: 'chat-1' },
      'Anybody?',
      [{ value: 'x', label: 'X' }],
      50,
    )
    expect(answer).toBe('timeout')
  }, 30_000)

  it('ignores an answer to an unknown question', async () => {
    const booted = await bootChannel()
    // A late press after a timeout must not resolve anything.
    await booted.channel.handleButton({
      questionId: 'never-asked',
      value: 'x',
      address: { channel: 'console', chatId: 'chat-1' },
      userId: 'user-1',
      timestamp: Date.now(),
    })
    expect(booted.channel.pendingQuestions).toBe(0)
  }, 30_000)

  it('fails when no adapter can reach the address', async () => {
    const booted = await bootChannel()
    await expect(
      booted.channel.ask({ channel: 'nope', chatId: 'x' }, 'hi', [], 100),
    ).rejects.toThrow(/no channel adapter named "nope"/)
  }, 30_000)
})

// ── the registry ───────────────────────────────────────────────────────────

describe('the registry', () => {
  it('reports its adapters', async () => {
    const booted = await bootChannel()
    expect(booted.channel.adapters().map((adapter) => adapter.name)).toEqual(['console'])
  }, 30_000)

  it('supports several adapters at once', async () => {
    const booted = await bootChannel()
    const second = new ConsoleChannelAdapter({ name: 'console2' })
    const dispose = booted.channel.register(second)
    expect(booted.channel.adapters().map((adapter) => adapter.name)).toEqual(['console', 'console2'])
    await dispose()
    expect(booted.channel.adapters().map((adapter) => adapter.name)).toEqual(['console'])
  }, 30_000)

  it('reports degraded health when an adapter fails to start', async () => {
    const booted = await bootChannel()
    expect(booted.channel.health().status).toBe('ok')
    // A registered adapter that never started is deaf; health must not say `ok`.
    const broken = new ConsoleChannelAdapter({ name: 'broken' })
    broken.start = async () => {
      throw new Error('401 Unauthorized')
    }
    booted.channel.register(broken)
    await booted.channel.adapterStarted('broken')
    const report = booted.channel.health()
    expect(report.status).toBe('degraded')
    expect(String(report.details?.['reason'])).toContain('401 Unauthorized')
  }, 30_000)

  it('refuses two adapters with the same name', async () => {
    const booted = await bootChannel()
    // Two adapters answering to one name would make every address ambiguous.
    expect(() => booted.channel.register(new ConsoleChannelAdapter({ name: 'console' }))).toThrow(/already registered/)
  }, 30_000)

  it('routes a message from a second adapter', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    const second = new ConsoleChannelAdapter({ name: 'console2' })
    booted.channel.register(second)
    // The allowlist names the `console` channel, so this is refused — which is
    // exactly the per-channel rule.
    const route = await booted.channel.handleIncoming(
      message('/projects', { address: { channel: 'console2', chatId: 'c' } }),
    )
    expect(route.kind).toBe('rejected')
  }, 30_000)
})

// ── delivery with no adapter ───────────────────────────────────────────────

describe('with no adapter', () => {
  it('sends nothing and does not throw', async () => {
    const booted = await bootChannel({ projects: { alpha: {} } })
    await booted.channel.dispose()
    // A deployment with no channel still runs: the deliveries are no-ops.
    await booted.channel.reply({ channel: 'console', chatId: 'chat-1' }, 'hello')
    await booted.channel.deliverRunOutput('r', { kind: 'adhoc' }, [{ type: 'text', text: 'x' }])
  }, 30_000)
})
