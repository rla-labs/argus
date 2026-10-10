// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-approvals-bridge`.
 *
 * The bridge is driven through its real `handle()` against a real store, a real
 * governor and a real channel — with the console adapter answering the question.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bootOps,
  BASE_ENTRIES,
  OPTIONAL_ENTRIES,
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
import type { ConsoleChannelAdapter } from '@argus-agent/testkit'
import type { OpsApprovalsBridge } from '../../src/service.js'
import { APPROVE, APPROVE_ALL, DENY } from '../../src/question.js'

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly bridge: OpsApprovalsBridge
  readonly dataDir: string
}

const open: Booted[] = []
const dirs: string[] = []

/** A project document. */
function projectDocument(
  dataDir: string,
  id: string,
  project: Record<string, unknown> = {},
): string {
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

/** Boot a tree with the bridge mounted. */
async function bootBridge(options: {
  projects?: Record<string, string>
  opsYaml?: string
  dataDir?: string
  script?: readonly unknown[]
} = {}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-appr-'))
  if (options.dataDir === undefined) dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })

  for (const [id, text] of Object.entries(options.projects ?? {})) {
    writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `${text}\n`)
  }

  const opsYaml =
    options.opsYaml ??
    `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
      `tasks:\n  model: fake/fake-model\n` +
      `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n  deepseek/*: { input: 0.14, cached: 0.014, output: 0.28 }\n` +
      `budgets:\n  default_day_usd: 100\n` +
      `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n    - { channel: console, userId: operator-7 }\n` +
      `channel:\n  default_address: console:dev\n` +
      `approvals:\n  timeout_minutes: 30\n`

  const bootOptions: { -readonly [K in keyof BootOpsOptions]: BootOpsOptions[K] } = {
    files: { 'config/ops.yaml': opsYaml },
    bareModuleBaseUrl: import.meta.url,
    fake: { script: (options.script ?? [{ text: 'ok' }]) as never, repeatLast: true },
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
      // dsh's own approval service: the seam the bridge answers on.
      OPTIONAL_ENTRIES.approval,
      { id: 'ops-approvals-bridge', name: '@argus-agent/approvals-bridge' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
    ],
  }

  const boot = await bootOps(bootOptions)
  const entry: Booted = {
    boot,
    ctx: boot.ctx,
    store: (boot.ctx as unknown as { opsStore: OpsStore }).opsStore,
    projects: (boot.ctx as unknown as { opsProjects: OpsProjects }).opsProjects,
    meter: (boot.ctx as unknown as { opsMeter: OpsMeter }).opsMeter,
    governor: (boot.ctx as unknown as { opsGovernor: OpsGovernor }).opsGovernor,
    channel: (boot.ctx as unknown as { opsChannel: OpsChannel }).opsChannel,
    bridge: (boot.ctx as unknown as { opsApprovals: OpsApprovalsBridge }).opsApprovals,
    dataDir,
  }
  open.push(entry)
  return entry
}

/** A fake agent with just an id, which is all the bridge reads. */
function fakeAgent(id: string): never {
  return { id } as never
}

/** Answer whatever the bridge is currently asking. */
async function answerNext(booted: Booted, value: string, userId = 'dev'): Promise<void> {
  await waitFor(() => consoleOf(booted).pendingCount > 0, { timeoutMs: 10_000, label: 'a question' })
  consoleOf(booted).answer(value, userId)
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.channel.dispose()
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Register a console adapter, and return it.
 *
 * The adapter owns the question promise — that is the channel's contract — so a test
 * answers through the adapter, exactly as a button press would.
 */
async function withConsole(booted: Booted): Promise<ConsoleChannelAdapter> {
  const { ConsoleChannelAdapter } = await import('@argus-agent/testkit')
  const adapter = new ConsoleChannelAdapter({ name: 'console' })
  booted.channel.register(adapter)
  // `register` starts the adapter asynchronously, so its button callback is not
  // wired until the start settles. Answering before that resolves the question but
  // records nothing — which is what made `decided_by` null.
  await booted.channel.adapterStarted('console')
  return adapter
}

/** The console adapter a test registered. */
function consoleOf(booted: Booted): ConsoleChannelAdapter {
  return booted.channel.adapters().find((entry) => entry.name === 'console') as ConsoleChannelAdapter
}

// ── the gate: dsh's real tool pipeline ─────────────────────────────────────

describe('the gate', () => {
  it('makes dsh ask before a command runs, and lets a read through', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-gate-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      script: [
        {
          text: 'working',
          toolCalls: [
            { name: 'read', arguments: '{"path":"notes.md"}', id: 'c1' },
            { name: 'bash', arguments: '{"command":"rm -rf build"}', id: 'c2' },
          ],
        },
        { text: 'done' },
      ],
    })
    await withConsole(booted)

    // Stand-ins under the real names, so the gate classifies them as dsh's own.
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    const ran: string[] = []
    for (const name of ['read', 'bash']) {
      agent.ctx.tools.register(
        defineTool({
          name,
          description: name,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          execute: async () => {
            ran.push(name)
            return 'ok'
          },
        }),
      )
    }

    booted.governor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })
    await answerNext(booted, APPROVE)
    await waitFor(() => booted.governor.status().running.length === 0, { timeoutMs: 30_000, label: 'run ended' })

    // One question, about the command, with the call's own arguments.
    const rows = booted.store.approvals.recent(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.request_json).toContain('rm -rf build')
    expect(rows[0]?.status).toBe('granted')
    expect(ran.sort()).toEqual(['bash', 'read'])
  }, 60_000)

  it('runs an allow-listed command under the default mode without asking', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-gate-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: `${projectDocument(dataDir, 'alpha')}\napprovals:\n  auto_allow: ["npm test"]` },
      script: [
        { text: 'testing', toolCalls: [{ name: 'bash', arguments: '{"command":"npm test"}', id: 'c1' }] },
        { text: 'done' },
      ],
    })
    await withConsole(booted)

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    let ran = false
    agent.ctx.tools.register(
      defineTool({
        name: 'bash',
        description: 'bash',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => {
          ran = true
          return 'ok'
        },
      }),
    )

    booted.governor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })
    await waitFor(() => ran, { timeoutMs: 30_000, label: 'the command ran' })
    expect(consoleOf(booted).pendingCount).toBe(0)
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('granted')
  }, 60_000)

  it('follows the project\'s tools block: allow runs, deny refuses unasked, web_hosts pass, outside the folder still asks', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-gate-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: `${projectDocument(dataDir, 'alpha')}\ntools:\n  shell: allow\n  write: allow\n  web: ask\n  web_hosts: [ycombinator.com]\n  other: deny`,
      },
      script: [
        {
          text: 'working',
          toolCalls: [
            { name: 'bash', arguments: '{"command":"rm -rf build"}', id: 'c1' },
            { name: 'write', arguments: '{"file_path":"out.md","content":"x"}', id: 'c2' },
            { name: 'write', arguments: '{"file_path":"/etc/out.md","content":"x"}', id: 'c3' },
            { name: 'web_fetch', arguments: '{"url":"https://news.ycombinator.com/item?id=1"}', id: 'c4' },
            { name: 'web_fetch', arguments: '{"url":"https://example.com"}', id: 'c5' },
            { name: 'mystery_tool', arguments: '{}', id: 'c6' },
          ],
        },
        { text: 'done' },
      ],
    })
    await withConsole(booted)

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    const ran: string[] = []
    for (const name of ['bash', 'write', 'web_fetch', 'mystery_tool']) {
      agent.ctx.tools.register(
        defineTool({
          name,
          description: name,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          execute: async (args) => {
            ran.push(`${name} ${JSON.stringify(args)}`)
            return 'ok'
          },
        }),
      )
    }

    booted.governor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })
    await waitFor(
      () => {
        consoleOf(booted).answer(DENY, 'dev')
        return booted.store.approvals.recent(10).length === 2 && booted.governor.status().running.length === 0
      },
      { timeoutMs: 30_000, label: 'two questions, run ended' },
    )

    const asked = booted.store.approvals.recent(10).map((row) => row.request_json).join('\n')
    expect(asked).toContain('/etc/out.md')
    expect(asked).toContain('example.com')
    const done = ran.join('\n')
    expect(done).toContain('rm -rf build')
    expect(done).toContain('out.md')
    expect(done).not.toContain('/etc/out.md')
    expect(done).toContain('news.ycombinator.com')
    expect(done).not.toContain('example.com')
    expect(done).not.toContain('mystery_tool')
  }, 60_000)

  it('asks for the web, for a read outside the folder and for an unknown tool; bookkeeping passes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-gate-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      script: [
        {
          text: 'working',
          toolCalls: [
            { name: 'read', arguments: '{"file_path":"notes.md"}', id: 'c1' },
            { name: 'read', arguments: '{"file_path":"../../ops.sqlite"}', id: 'c2' },
            { name: 'web_fetch', arguments: '{"url":"https://news.ycombinator.com"}', id: 'c3' },
            { name: 'todo_write', arguments: '{}', id: 'c4' },
            { name: 'mystery_tool', arguments: '{}', id: 'c5' },
            { name: 'ralph', arguments: '{}', id: 'c6' },
          ],
        },
        { text: 'done' },
      ],
    })
    await withConsole(booted)

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    const ran: string[] = []
    for (const name of ['read', 'web_fetch', 'todo_write', 'mystery_tool', 'ralph']) {
      agent.ctx.tools.register(
        defineTool({
          name,
          description: name,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          execute: async () => {
            ran.push(name)
            return 'ok'
          },
        }),
      )
    }

    booted.governor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })
    // Refuse every question until the run ends.
    await waitFor(
      () => {
        consoleOf(booted).answer(DENY, 'dev')
        return booted.store.approvals.recent(10).length === 3 && booted.governor.status().running.length === 0
      },
      { timeoutMs: 30_000, label: 'three questions, run ended' },
    )

    const asked = booted.store.approvals.recent(10).map((row) => row.request_json).join('\n')
    expect(asked).toContain('ops.sqlite')
    expect(asked).toContain('news.ycombinator.com')
    expect(asked).toContain('mystery_tool')
    // `agents` is off by default: refused without a question.
    expect(asked).not.toContain('ralph')
    expect(ran.sort()).toEqual(['read', 'todo_write'])
  }, 60_000)

  it('follows an MCP server\'s access, and shows the call\'s arguments when it asks', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-gate-'))
    dirs.push(dataDir)
    const echo = JSON.stringify(fileURLToPath(new URL('../../../ops-projects/test/fixtures/echo-mcp.mjs', import.meta.url)))
    const server = (access: string): string => `\n  ${access}-srv:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${echo}]\n    access: ${access}`
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: `${projectDocument(dataDir, 'alpha')}\nmcp:${server('allow')}${server('ask')}${server('deny')}` },
      script: [
        {
          text: 'working',
          toolCalls: [
            { name: 'mcp__allow-srv__go', arguments: '{}', id: 'c1' },
            { name: 'mcp__ask-srv__go', arguments: '{"issue":"#42"}', id: 'c2' },
            { name: 'mcp__deny-srv__go', arguments: '{}', id: 'c3' },
          ],
        },
        { text: 'done' },
      ],
    })
    await withConsole(booted)

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    const ran: string[] = []
    for (const name of ['mcp__allow-srv__go', 'mcp__ask-srv__go', 'mcp__deny-srv__go']) {
      agent.ctx.tools.register(
        defineTool({
          name,
          description: name,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          execute: async () => {
            ran.push(name)
            return 'ok'
          },
        }),
      )
    }

    booted.governor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })
    await waitFor(
      () => {
        consoleOf(booted).answer(DENY, 'dev')
        return booted.store.approvals.recent(10).length === 1 && booted.governor.status().running.length === 0
      },
      { timeoutMs: 30_000, label: 'one question, run ended' },
    )

    const asked = booted.store.approvals.recent(10).map((row) => row.request_json).join('\n')
    expect(asked).toContain('mcp__ask-srv__go')
    expect(asked).toContain('#42')
    expect(ran).toEqual(['mcp__allow-srv__go'])
  }, 60_000)
})

// ── mounting ───────────────────────────────────────────────────────────────

describe('mounting', () => {
  it('provides the service', async () => {
    const booted = await bootBridge()
    expect(booted.bridge).toBeDefined()
    expect(booted.ctx.approval).toBeDefined()
  }, 40_000)

  it('mounts nothing when disabled, and dsh then refuses by itself', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-off-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n    - { channel: console, userId: operator-7 }\n` +
        `channel:\n  default_address: console:dev\n` +
        `approvals:\n  enabled: false\n`,
    })
    // With no answerer the chain falls through to `unavailable` — fail closed.
    expect((booted.ctx as unknown as { opsApprovals?: unknown }).opsApprovals).toBeUndefined()
  }, 40_000)
})

// ── the decision paths ─────────────────────────────────────────────────────

describe('decisions', () => {
  it('asks, and grants on Approve', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-ok-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const promise = booted.bridge.handle(
      { toolName: 'bash', agent, reason: 'clean the build' },
      async () => 'unavailable',
    )
    // Wait for the question BEFORE answering: a blind press can land before the
    // adapter has registered it, and the question then times out instead.
    await answerNext(booted, APPROVE)

    expect(await promise).toBe('allowed-once')
    const row = booted.store.approvals.recent(1)[0]
    expect(row?.status).toBe('granted')
    expect(row?.decided_by).toBe('dev')
  }, 60_000)

  it('refuses on Deny', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-deny-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const promise = booted.bridge.handle(
      { toolName: 'bash', agent, reason: 'push' },
      async () => 'unavailable',
    )
    await answerNext(booted, DENY)

    expect(await promise).toBe('rejected')
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('denied')
  }, 60_000)

  it('treats an unknown answer as a refusal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-unk-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const promise = booted.bridge.handle(
      { toolName: 'bash', agent },
      async () => 'unavailable',
    )
    await answerNext(booted, 'maybe')

    // Not an approval. A wiring mistake must not become a grant.
    expect(await promise).toBe('rejected')
  }, 60_000)

  it('returns unavailable when there is no channel to ask', async () => {
    // No adapter registered at all: the plan says absence means no. The request is
    // refused, and the ROW records `unavailable` so an operator can tell "nobody
    // could be asked" from "somebody said no".
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-nochan-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
    })
    const agent = await booted.projects.ensureAgent('alpha')
    const outcome = await booted.bridge.handle(
      { toolName: 'bash', agent },
      async () => 'unavailable',
    )
    expect(outcome).toBe('unavailable')
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('unavailable')
  }, 60_000)

  it('DENIES a tool with no run grant under an ad-hoc default of deny', async () => {
    const booted = await bootBridge()
    await withConsole(booted)

    // An ad-hoc session (no project) with `approvals_adhoc: deny` by default.
    const outcome = await booted.bridge.handle(
      { toolName: 'bash', agent: fakeAgent('adhoc-1') },
      async () => 'unavailable',
    )
    expect(outcome).toBe('rejected')
  }, 60_000)
})

// ── the allowlist through the real path ────────────────────────────────────

describe('the allowlist', () => {
  it('allows an allow-listed command without asking', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-auto-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', {
          approvals: { mode: 'auto', auto_allow: ['git status'], timeout_minutes: 30 },
        }),
      },
    })
    await withConsole(booted)

    // The project must be observed first, so the bridge can resolve the owner.
    const agent = await booted.projects.ensureAgent('alpha')
    const sessionId = agent.id as string
    booted.governor.noteToolCall(sessionId, 'bash', { command: 'git status --short' })

    const outcome = await booted.bridge.handle(
      { toolName: 'bash', agent, reason: 'inspect' },
      async () => 'unavailable',
    )
    // No question was asked: the answer came back immediately.
    expect(outcome).toBe('allowed-once')
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('granted')
  }, 60_000)

  it('ASKS for a non-listed command under auto', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-ask-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', {
          approvals: { mode: 'auto', auto_allow: ['git status'], timeout_minutes: 30 },
        }),
      },
    })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const sessionId = agent.id as string
    booted.governor.noteToolCall(sessionId, 'bash', { command: 'rm -rf /tmp/x' })

    const promise = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    await answerNext(booted, DENY)
    expect(await promise).toBe('rejected')
  }, 60_000)

  it('REFUSES the `git status; rm -rf /` bypass even under auto', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-bypass-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', {
          approvals: { mode: 'auto', auto_allow: ['git status'], timeout_minutes: 30 },
        }),
      },
    })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const sessionId = agent.id as string
    booted.governor.noteToolCall(sessionId, 'bash', { command: 'git status; rm -rf /' })

    // It must ASK, not allow. Answering Deny proves a question was asked.
    const promise = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    await answerNext(booted, DENY)
    expect(await promise).toBe('rejected')
  }, 60_000)

  it('ASKS when the argv could not be recovered', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-norec-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', {
          approvals: { mode: 'auto', auto_allow: ['git status'], timeout_minutes: 30 },
        }),
      },
    })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    // No `noteToolCall`, so there is nothing to match against. An allowlist cannot
    // authorize what it cannot read, so it asks.
    const promise = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    await answerNext(booted, DENY)
    expect(await promise).toBe('rejected')
  }, 60_000)

  it('denies without asking under mode deny', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-hard-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', {
          approvals: { mode: 'deny', auto_allow: ['git status'], timeout_minutes: 30 },
        }),
      },
    })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const outcome = await booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    // A hard deny: no question, and no grant even for an allow-listed command.
    expect(outcome).toBe('rejected')
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('denied')
  }, 60_000)
})

// ── approve all ────────────────────────────────────────────────────────────

describe('approve all for this run', () => {
  it('grants the same category for the rest of the run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-all-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const sessionId = agent.id as string
    booted.governor.noteToolCall(sessionId, 'bash', { command: 'rm -rf /tmp/a' })

    const first = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    await answerNext(booted, APPROVE_ALL)
    expect(await first).toBe('allowed-once')

    // A second request in the SAME run and category is now automatic.
    booted.governor.noteToolCall(sessionId, 'bash', { command: 'rm -rf /tmp/b' })
    const second = await booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    expect(second).toBe('allowed-once')
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('granted')
  }, 60_000)

  it('does NOT cover a DIFFERENT category in the same run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-cat-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const sessionId = agent.id as string
    booted.governor.noteToolCall(sessionId, 'bash', { command: 'rm -rf /tmp/a' })

    const first = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    await answerNext(booted, APPROVE_ALL)
    await first

    // A file write is a different kind of action, so it still asks: approving a
    // batch of commands must not authorize writing a file.
    booted.governor.noteToolCall(sessionId, 'write', { path: '/tmp/x' })
    const promise = booted.bridge.handle({ toolName: 'write', agent }, async () => 'unavailable')
    await answerNext(booted, DENY)
    expect(await promise).toBe('rejected')
  }, 60_000)

  it('does not cover a different RUN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-run-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha'), beta: projectDocument(dataDir, 'beta') },
    })
    await withConsole(booted)

    const alpha = await booted.projects.ensureAgent('alpha')
    const alphaSession = alpha.id as string
    booted.governor.noteToolCall(alphaSession, 'bash', { command: 'rm -rf /tmp/a' })
    const first = booted.bridge.handle({ toolName: 'bash', agent: alpha }, async () => 'unavailable')
    await answerNext(booted, APPROVE_ALL)
    await first

    const beta = await booted.projects.ensureAgent('beta')
    const betaSession = beta.id as string
    booted.governor.noteToolCall(betaSession, 'bash', { command: 'rm -rf /tmp/b' })

    // Another project's run is a different scope, so it asks.
    const promise = booted.bridge.handle({ toolName: 'bash', agent: beta }, async () => 'unavailable')
    await answerNext(booted, DENY)
    expect(await promise).toBe('rejected')
  }, 60_000)

  it('forgets a run’s grants when the run goes idle', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-forget-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    booted.bridge.grant('run-x', 'command', 'dev', 'test')
    expect(booted.bridge.listGrants()).toHaveLength(1)
    booted.bridge.forgetRun('run-x')
    expect(booted.bridge.listGrants()).toHaveLength(0)
  }, 40_000)
})

// ── timeout ────────────────────────────────────────────────────────────────

describe('timeout', () => {
  it('denies when nobody answers', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-to-'))
    dirs.push(dataDir)
    // A one-minute timeout, but the ask timeout is what the adapter sees. Drive the
    // timeout directly by never answering and letting the adapter's own deadline
    // fire.
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', {
          approvals: { mode: 'ask', auto_allow: [], timeout_minutes: 30 },
        }),
      },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n    - { channel: console, userId: operator-7 }\n` +
        `channel:\n  default_address: console:dev\n` +
        `approvals:\n  timeout_minutes: 30\n`,
    })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    // Resolve the question with a timeout straight away, which is what the adapter
    // does when its deadline passes.
    const promise = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    void (async () => {
      await waitFor(() => booted.channel.pendingQuestions > 0, { timeoutMs: 10_000, label: 'a question' })
      consoleOf(booted).timeout()
    })()

    expect(await promise).toBe('rejected')
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('timeout')
  }, 60_000)
})

// ── persistence and audit ──────────────────────────────────────────────────

describe('persistence and audit', () => {
  it('writes an audit row for every decision', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-audit-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const promise = booted.bridge.handle({ toolName: 'bash', agent, reason: 'test' }, async () => 'unavailable')
    await answerNext(booted, APPROVE)
    await promise

    const rows = booted.store.audit.byAction('approval.decided')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor).toBe('dev')
    // `details_json` is stored as JSON, so a reader parses it.
    const details = JSON.parse(rows[0]?.details_json ?? '{}') as Record<string, unknown>
    expect(details['ending']).toBe('approved')
    // No argv was observed in this test, so the category is `other` rather than
    // `command` — the tool name alone does not prove it runs a process.
    expect(details['kind']).toBe('other')
  }, 60_000)

  it('records who decided, and when', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-who-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const before = Date.now()
    const promise = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    await answerNext(booted, APPROVE, 'operator-7')
    await promise

    const row = booted.store.approvals.recent(1)[0]
    expect(row?.decided_by).toBe('operator-7')
    expect(row?.decided_at).toBeGreaterThanOrEqual(before)
  }, 60_000)

  it('records an automatic allow as a decision, not as pending', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-auto-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', {
          approvals: { mode: 'auto', auto_allow: ['git status'], timeout_minutes: 30 },
        }),
      },
    })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    booted.governor.noteToolCall(agent.id as string, 'bash', { command: 'git status' })
    await booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')

    // `pending` would leave it looking like something nobody answered.
    expect(booted.store.approvals.listPending()).toHaveLength(0)
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('granted')
  }, 60_000)

  it('does NOT overwrite a decided row', async () => {
    // The repository guards `decide` with `status = 'pending'`, so a late press
    // cannot reverse a timeout.
    const booted = await bootBridge()
    booted.store.approvals.insert(
      { id: 'a1', run_id: 'r1', project_id: null, request_json: '{}', status: 'pending' },
      Date.now(),
    )
    expect(booted.store.approvals.decide('a1', 'timeout', null, Date.now())).toBe(true)
    expect(booted.store.approvals.decide('a1', 'granted', 'attacker', Date.now())).toBe(false)
    expect(booted.store.approvals.get('a1')?.status).toBe('timeout')
  }, 40_000)
})

// ── concurrency ────────────────────────────────────────────────────────────

describe('concurrency', () => {
  it('keeps two projects’ approvals independent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-two-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha'), beta: projectDocument(dataDir, 'beta') },
    })
    await withConsole(booted)

    const alpha = await booted.projects.ensureAgent('alpha')
    const beta = await booted.projects.ensureAgent('beta')

    const first = booted.bridge.handle({ toolName: 'bash', agent: alpha }, async () => 'unavailable')
    const second = booted.bridge.handle({ toolName: 'write', agent: beta }, async () => 'unavailable')

    // Two questions, answered independently: one approved, one denied.
    const console = consoleOf(booted)
    await waitFor(() => console.pendingCount >= 1, { timeoutMs: 10_000, label: 'questions' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    console.answer(APPROVE)
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (console.pendingCount > 0) console.answer(DENY)

    const outcomes = await Promise.all([first, second])
    // Each got its own answer; neither was left waiting for the other.
    expect(outcomes).toHaveLength(2)
    for (const outcome of outcomes) expect(['allowed-once', 'rejected']).toContain(outcome)
    expect(booted.store.approvals.recent(2)).toHaveLength(2)
  }, 90_000)
})

// ── failure handling ───────────────────────────────────────────────────────

describe('failure handling', () => {
  it('refuses rather than throwing when something goes wrong', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-err-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    // An agent whose id getter throws: the bridge must refuse, not propagate.
    const hostile = {
      get id(): string {
        throw new Error('boom')
      },
    } as never

    const outcome = await booted.bridge.handle({ toolName: 'bash', agent: hostile }, async () => 'unavailable')
    // A throw inside dsh's waterfall would be read as unavailable; an explicit
    // refusal is the same decision, made deliberately.
    expect(outcome).toBe('rejected')
  }, 60_000)

  it('never grants on an internal error', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-never-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const hostile = {
      get id(): string {
        throw new Error('boom')
      },
    } as never

    const outcome = await booted.bridge.handle({ toolName: 'bash', agent: hostile }, async () => 'unavailable')
    expect(outcome).not.toBe('allowed-once')
  }, 60_000)
})

// ── events ─────────────────────────────────────────────────────────────────

describe('events', () => {
  it('emits requested and decided for every path', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-ev-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', {
          approvals: { mode: 'auto', auto_allow: ['git status'], timeout_minutes: 30 },
        }),
      },
    })
    await withConsole(booted)

    const events: string[] = []
    booted.ctx.on('ops/approval-requested', () => events.push('requested'))
    booted.ctx.on('ops/approval-decided', (payload) => events.push(`decided:${payload.ending}`))

    const agent = await booted.projects.ensureAgent('alpha')
    booted.governor.noteToolCall(agent.id as string, 'bash', { command: 'git status' })
    await booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')

    expect(events).toEqual(['requested', 'decided:auto'])
  }, 60_000)

  it('reports the ask decision before a question is sent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-ev2-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    let decision: string | undefined
    booted.ctx.on('ops/approval-requested', (payload) => {
      decision = payload.decision
    })

    const agent = await booted.projects.ensureAgent('alpha')
    const promise = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    await answerNext(booted, DENY)
    await promise
    expect(decision).toBe('ask')
  }, 60_000)
})

// ── health ─────────────────────────────────────────────────────────────────

describe('health', () => {
  it('reports grants, pending and counts', async () => {
    const booted = await bootBridge()
    // The normalized `ServiceHealth` shape: the ad-hoc one was folded into it so
    // the health aggregator does not need special cases per plugin.
    const health = booted.bridge.health()
    expect(health.status).toBe('ok')
    expect(health.details['grants']).toBe(0)
    expect(health.details['pending']).toBe(0)
    expect(health.details['counts']).toEqual({})
  }, 40_000)

  it('counts by ending', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-count-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await withConsole(booted)

    const agent = await booted.projects.ensureAgent('alpha')
    const promise = booted.bridge.handle({ toolName: 'bash', agent }, async () => 'unavailable')
    await answerNext(booted, APPROVE)
    await promise

    expect((booted.bridge.health().details['counts'] as Record<string, number>)['approved']).toBe(1)
  }, 60_000)

  it('maps the project mode onto the dsh policy', async () => {
    const booted = await bootBridge()
    // `deny` is dsh's `never`, which auto-rejects without prompting.
    expect(booted.bridge.dshPolicyFor('deny')).toBe('never')
    expect(booted.bridge.dshPolicyFor('ask')).toBe('ask')
    expect(booted.bridge.dshPolicyFor('auto')).toBe('ask')
  }, 40_000)
})
