// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-approvals-bridge`.
 *
 * The bridge is driven through its real `handle()` against a real store, a real
 * governor and a real channel — with the console adapter answering the question.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import ArgusSandbox from '@argus-agent/argus-agent/sandbox-row'
import { Extensions } from '@argus-agent/projects'
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
import { ALWAYS, APPROVE, APPROVE_ALL, CONTINUE, DENY, STOP } from '../../src/question.js'

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
  /** More entries, mounted before the bridge: the command sandbox. */
  entries?: readonly { id: string; name: string }[]
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
      ...(options.entries ?? []),
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
/** The Argus user a console id belongs to: `decided_by` and the audit's actor are by user. */
function userOf(booted: Booted, consoleId: string): string | undefined {
  return booted.store.users.resolve('console', consoleId)?.user_id
}

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

  it('counts a read-only command as a read, and asks for its forms that write', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-gate-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const agent = await booted.projects.ensureAgent('alpha')
    const gate = (command: string) => booted.bridge.gate({ name: 'bash', arguments: { command }, callId: command, agent: agent as never })?.kind ?? 'run'
    // tools.read is allow by default, tools.shell ask.
    for (const command of ['cat notes.md', 'ls -la src', 'grep -rn TODO .', 'find . -name "*.md"', 'wc -l a b', 'tail -n 20 log.txt', 'du -sh .']) {
      expect(gate(command), command).toBe('run')
    }
    for (const command of ['find . -delete', 'find . -exec rm {} +', 'cat a > b', 'cat a;rm b', 'cat a\nrm b', 'git status', 'rm -rf build', 'date -s 2020-01-01']) {
      expect(gate(command), command).toBe('ask')
    }
  }, 60_000)

  it('asks about a git_push by default, and refuses one that cannot be pushed without asking', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-git-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { alpha: `${projectDocument(dataDir, 'alpha')}\ngit:\n  remotes:\n    origin:\n      url: https://github.com/acme/site.git` } })
    const agent = await booted.projects.ensureAgent('alpha')
    const exec = (name: string, args: Record<string, unknown>) => ({ name, arguments: args, callId: `${name}-1`, agent: agent as never })
    for (const name of ['git_clone', 'git_pull', 'git_push']) expect(booted.bridge.gate(exec(name, {}))?.kind, name).toBe('ask')
    const verdict = booted.bridge.gate(exec('git_push', { branch: 'main' }))
    expect(await booted.bridge.describePush(exec('git_push', { branch: 'main' }), verdict as never)).toEqual({ kind: 'deny', reason: expect.stringContaining('main is protected on origin') })
    expect(await booted.bridge.describePush(exec('git_push', { branch: 'feature' }), verdict as never)).toEqual({ kind: 'deny', reason: expect.stringContaining('origin has no token') })
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

  it('saves "Always allow" for the admin: the same command then runs unasked', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-gate-'))
    dirs.push(dataDir)
    const command = { name: 'bash', arguments: '{"command":"git push origin main --quiet"}' }
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  admin: console:dev\n` +
        `channel:\n  default_address: console:dev\n`,
      script: [
        { text: 'working', toolCalls: [{ ...command, id: 'c1' }] },
        { text: 'done' },
        { text: 'again', toolCalls: [{ ...command, id: 'c2' }] },
        { text: 'done' },
      ],
    })
    await withConsole(booted)
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    let ran = 0
    agent.ctx.tools.register(
      defineTool({
        name: 'bash',
        description: 'bash',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => {
          ran += 1
          return 'ok'
        },
      }),
    )
    const go = (): void => void booted.governor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })
    go()
    await waitFor(() => consoleOf(booted).answer(ALWAYS, 'dev'), { timeoutMs: 30_000, label: 'the question' })
    await waitFor(() => ran === 1 && booted.governor.status().running.length === 0, { timeoutMs: 30_000, label: 'first run' })
    // A whole command, its trailing option aside, never a prefix.
    expect(booted.projects.configOf('alpha')?.approvals.auto_allow).toEqual(['git push origin main'])
    expect(booted.store.approvals.recent(1)[0]).toMatchObject({ status: 'granted', decided_by: userOf(booted, 'dev') })
    // Saved through /set, so audited like any change.
    expect(booted.store.audit.recent(20).some((row) => row.action === 'command.set')).toBe(true)

    go()
    await waitFor(() => ran === 2 && booted.governor.status().running.length === 0, { timeoutMs: 30_000, label: 'second run, unasked' })
    expect(booted.store.approvals.recent(5).filter((row) => row.status === 'pending')).toHaveLength(0)
  }, 60_000)

  it('refuses a scheduled run at once, tells the chat with the rule as a button, and the rule then lets it run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-sched-'))
    dirs.push(dataDir)
    const command = { name: 'bash', arguments: '{"command":"docker logs app"}' }
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  admin: console:dev\n` +
        `channel:\n  default_address: console:dev\n`,
      script: [
        { text: 'working', toolCalls: [{ ...command, id: 'c1' }] },
        { text: 'done' },
        { text: 'again', toolCalls: [{ ...command, id: 'c2' }] },
        { text: 'done' },
      ],
    })
    const adapter = await withConsole(booted)
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    let ran = 0
    agent.ctx.tools.register(
      defineTool({
        name: 'bash',
        description: 'bash',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => {
          ran += 1
          return 'ok'
        },
      }),
    )
    const go = (): void => void booted.governor.submit({ source: 'scheduler', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 1 })
    go()
    await waitFor(() => booted.governor.status().running.length === 0 && booted.store.approvals.recent(1)[0]?.status === 'denied', { timeoutMs: 30_000, label: 'the refused run' })
    expect(ran).toBe(0)
    expect(adapter.pendingCount).toBe(0)
    const report = adapter.sent.find((sent) => sent.message.text?.includes('was blocked'))
    expect(report?.message.text).toContain('A scheduled run of alpha was blocked: docker logs app')
    expect(report?.message.buttons?.[0]?.value).toBe('/rule alpha docker logs app')

    await booted.channel.handleButton({ questionId: 'report', value: '/rule alpha docker logs app', address: { channel: 'console', chatId: 'dev' }, userId: 'dev', timestamp: Date.now() })
    expect(booted.projects.configOf('alpha')?.approvals.auto_allow).toEqual(['docker logs app'])
    go()
    await waitFor(() => ran === 1 && booted.governor.status().running.length === 0, { timeoutMs: 30_000, label: 'the run, allowed' })
  }, 60_000)

  it('asks a scheduled run only for unattended_timeout_s, and suggests a rule for an action approved again and again', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-sched2-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  admin: console:dev\n` +
        `channel:\n  default_address: console:dev\n` +
        `approvals:\n  unattended_timeout_s: 5\n`,
      script: [{ text: 'working', toolCalls: [{ name: 'bash', arguments: '{"command":"docker ps -a"}', id: 'c1' }] }, { text: 'done' }],
    })
    const adapter = await withConsole(booted)
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    agent.ctx.tools.register(defineTool({ name: 'bash', description: 'bash', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: async () => 'ok' }))
    // Two earlier approvals of the same action by a person.
    for (const n of [1, 2]) {
      booted.store.approvals.insert({ id: `old-${n}`, run_id: null, project_id: 'alpha', request_json: JSON.stringify({ action: 'docker ps -a' }), status: 'pending' }, Date.now() - n * 3_600_000)
      booted.store.approvals.decide(`old-${n}`, 'granted', 'someone', Date.now() - n * 3_600_000)
    }
    void booted.governor.submit({ source: 'scheduler', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 1 })
    await waitFor(() => adapter.pendingCount > 0, { timeoutMs: 30_000, label: 'the question' })
    expect(adapter.pendingQuestion?.text).toContain('A scheduled run: no answer in 5 second(s) means NO.')
    expect(adapter.pendingQuestion?.text).toContain('Approved 2 times in the last 7 days')
    adapter.timeout()
    await waitFor(() => booted.governor.status().running.length === 0, { timeoutMs: 30_000, label: 'the run' })
    expect(booted.store.approvals.recent(1)[0]?.status).toBe('timeout')
    expect(adapter.texts().some((text) => text.includes('A scheduled run of alpha was blocked: docker ps -a'))).toBe(true)
  }, 60_000)

  it('follows a tool\'s exception over its group, the always-allowed ones included', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-gate-'))
    dirs.push(dataDir)
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: `${projectDocument(dataDir, 'alpha')}\ntools:\n  write: allow\n  other: deny\n  exceptions:\n    edit: deny\n    mystery_tool: allow\n    todo_write: deny` },
      script: [
        {
          text: 'working',
          toolCalls: [
            { name: 'write', arguments: '{"file_path":"a.md","content":"x"}', id: 'c1' },
            { name: 'edit', arguments: '{"file_path":"a.md"}', id: 'c2' },
            { name: 'mystery_tool', arguments: '{}', id: 'c3' },
            { name: 'todo_write', arguments: '{}', id: 'c4' },
          ],
        },
        { text: 'done' },
      ],
    })
    await withConsole(booted)
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    const ran: string[] = []
    for (const name of ['write', 'edit', 'mystery_tool', 'todo_write']) {
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
    await waitFor(() => booted.governor.status().running.length === 0 && booted.store.runs.recent(1).length === 1, { timeoutMs: 30_000, label: 'run ended' })
    expect(ran.sort()).toEqual(['mystery_tool', 'write'])
    // Nothing asked: every decision was the file's.
    expect(booted.store.approvals.recent(10)).toHaveLength(0)
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

  it('follows the most specific of a server\'s tool rules before its access', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-tools-'))
    dirs.push(dataDir)
    const echo = JSON.stringify(fileURLToPath(new URL('../../../ops-projects/test/fixtures/echo-mcp.mjs', import.meta.url)))
    const docs = `\n  docs:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${echo}]\n    access: ask\n    tools:\n      read_*: allow\n      delete_*: deny\n      read_secret: deny`
    const calls = ['read_doc', 'read_secret', 'delete_doc', 'update_doc']
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: `${projectDocument(dataDir, 'alpha')}\nmcp:${docs}` },
      script: [{ text: 'working', toolCalls: calls.map((tool, index) => ({ name: `mcp__docs__${tool}`, arguments: '{}', id: `c${index}` })) }, { text: 'done' }],
    })
    await withConsole(booted)

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    const ran: string[] = []
    for (const tool of calls) {
      agent.ctx.tools.register(
        defineTool({
          name: `mcp__docs__${tool}`,
          description: tool,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          execute: async () => {
            ran.push(tool)
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

    // read_doc by read_*, read_secret refused by its own name, delete_doc by delete_*, update_doc asked by the server's access.
    expect(ran).toEqual(['read_doc'])
    expect(booted.store.approvals.recent(10).map((row) => row.request_json).join('\n')).toContain('mcp__docs__update_doc')
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
    expect(row?.decided_by).toBe(userOf(booted, 'dev'))
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
    expect(rows[0]?.actor).toBe(userOf(booted, 'dev'))
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
    expect(row?.decided_by).toBe(userOf(booted, 'operator-7'))
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

describe('the loop checker', () => {
  const LOOP = '{"verdict":"loop","reason":"the same tick again and again."}'

  /**
   * A project whose run ticks `steps` times, then answers; every 2 steps the loop checker
   * (fake/judge-model) reads it and answers `verdict`.
   */
  async function checked(onLoop: 'stop' | 'notify' | 'ask', verdict = LOOP, steps = 40): Promise<{ booted: Booted; adapter: ConsoleChannelAdapter; stops: string[] }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-loop-'))
    dirs.push(dataDir)
    let calls = 0
    const booted = await bootBridge({
      dataDir,
      projects: { alpha: `${projectDocument(dataDir, 'alpha')}\nlimits:\n  loop_check_steps: 2\n  on_loop: ${onLoop}\n  loop_repeat_threshold: 99\n  stall_steps: 0\ntools:\n  other: allow` },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  admin: console:dev\n` +
        `channel:\n  default_address: console:dev\n` +
        `judge:\n  model: fake/judge-model\n`,
      script: ((request: { model: string }) =>
        request.model === 'judge-model'
          ? { text: verdict }
          : calls < steps
            ? { text: 'x', toolCalls: [{ name: 'tick', arguments: JSON.stringify({ n: ++calls }), id: `c${calls}` }] }
            : { text: 'done' }) as never,
    })
    const adapter = await withConsole(booted)
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    ;(await booted.projects.ensureAgent('alpha')).ctx.tools.register(
      defineTool({ name: 'tick', description: 'tick', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: async () => 'tick' }),
    )
    const stops: string[] = []
    booted.ctx.on('ops/run-stopped', ({ detail }) => stops.push(detail))
    return { booted, adapter, stops }
  }

  const go = (booted: Booted, source: 'channel' | 'scheduler' = 'channel') =>
    booted.governor.submit({ source, target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: source === 'channel' ? 0 : 1 })
  const idle = (booted: Booted) => waitFor(() => booted.governor.status().running.length === 0 && booted.governor.status().pending.length === 0, { timeoutMs: 20_000, label: 'the run' })

  it('on_loop ask: asks with the checker\'s reason and what the run did, goes on on Continue, stops on Stop', async () => {
    const { booted, adapter, stops } = await checked('ask')
    go(booted)
    await waitFor(() => adapter.pendingCount > 0, { timeoutMs: 20_000, label: 'the first question' })
    const first = adapter.pendingQuestion
    expect(first?.text).toContain('Possible loop: project alpha')
    expect(first?.text).toContain('The loop checker: the same tick again and again.')
    expect(first?.text).toContain('steps   2')
    expect(first?.buttons.map((button) => button.value)).toEqual([CONTINUE, STOP])
    // It waits: the run holds its slot.
    expect(booted.governor.status().running).toHaveLength(1)
    adapter.answer(CONTINUE, 'dev')
    await waitFor(() => adapter.pendingQuestion?.text.includes('steps   4') === true, { timeoutMs: 20_000, label: 'the second question' })
    adapter.answer(STOP, 'dev')
    await idle(booted)
    expect(stops).toEqual(['the loop checker found a loop (the same tick again and again.): stopped by a person'])
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'limit_stopped', steps: 4 })
  }, 60_000)

  it('on_loop ask: stops a run nobody answers', async () => {
    const { booted, adapter, stops } = await checked('ask')
    go(booted)
    await waitFor(() => adapter.pendingCount > 0, { timeoutMs: 20_000, label: 'the question' })
    adapter.timeout()
    await idle(booted)
    expect(stops).toEqual(['the loop checker found a loop (the same tick again and again.): no answer in 30 minute(s)'])
  }, 60_000)

  it('on_loop ask: a scheduled run is not asked; it is told about and goes on', async () => {
    const { booted, adapter, stops } = await checked('ask', LOOP, 4)
    go(booted, 'scheduler')
    await idle(booted)
    expect(adapter.pendingCount).toBe(0)
    expect(stops).toEqual([])
    expect(adapter.texts().filter((text) => text.includes('[alpha] the loop checker thinks it is going in circles'))).toHaveLength(2)
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'completed' })
  }, 60_000)

  it('on_loop notify: tells the chat and the run goes on to its end', async () => {
    const { booted, adapter, stops } = await checked('notify', LOOP, 5)
    go(booted)
    await idle(booted)
    expect(stops).toEqual([])
    expect(adapter.pendingCount).toBe(0)
    const told = adapter.texts().filter((text) => text.includes('the loop checker thinks it is going in circles: the same tick again and again.'))
    expect(told).toHaveLength(2)
    expect(told[0]).toContain('It goes on (limits.on_loop: notify); /stop ends it.')
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'completed', steps: 6 })
  }, 60_000)

  it('on_loop stop: stops the run and says why', async () => {
    const { booted, adapter, stops } = await checked('stop')
    go(booted)
    await idle(booted)
    expect(stops).toEqual(['the loop checker found a loop: the same tick again and again.'])
    expect(adapter.pendingCount).toBe(0)
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'limit_stopped', steps: 2 })
    const audited = booted.store.audit.recent(20).find((row) => row.action === 'judge.verdict')
    expect(JSON.parse(audited?.details_json ?? '{}')).toMatchObject({ verdict: 'loop', onLoop: 'stop', model: 'fake/judge-model' })
  }, 60_000)

  it('a checker that fails lets the run go on; failing three times in a row is told once', async () => {
    const { booted, adapter, stops } = await checked('stop', 'not json', 9)
    go(booted)
    await idle(booted)
    expect(stops).toEqual([])
    const failed = adapter.texts().filter((text) => text.includes('the loop checker failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('failed 3 times in a row (an answer that is not a verdict: not json). The run goes on without it.')
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'completed', steps: 10 })
  }, 60_000)

  it('progress lets the run go on, and the chat hears nothing of it', async () => {
    const { booted, adapter, stops } = await checked('stop', '{"verdict":"progress","reason":"new results."}', 5)
    go(booted)
    await idle(booted)
    expect(stops).toEqual([])
    expect(adapter.texts().some((text) => text.includes('loop checker'))).toBe(false)
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'completed', steps: 6 })
  }, 60_000)
})

describe('a delegated agent’s calls (Claude Code, through the host channel)', () => {
  /** A project with this policy, and a bridge with a console to ask on. */
  async function delegated(project: Record<string, unknown>) {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-del-'))
    dirs.push(dataDir)
    const booted = await bootBridge({ dataDir, projects: { site: projectDocument(dataDir, 'site', project) } })
    const adapter = await withConsole(booted)
    const cwd = join(dataDir, 'projects', 'site')
    const ask = (message: Record<string, unknown>, runId = 'run-d1') => booted.bridge.decideDelegated({ projectId: 'site', server: 'cc', runId, message })
    return { booted, adapter, cwd, ask }
  }

  it('lets run what the project’s policy lets its own agent run, and refuses what it refuses', async () => {
    const { cwd, ask } = await delegated({ tools: { write: 'allow', web: 'ask', web_hosts: ['docs.example.com'], shell: 'deny' }, approvals: { mode: 'ask', auto_allow: [] } })
    expect(await ask({ tool: 'Read', as: 'read', arguments: { file_path: join(cwd, 'a.txt') } })).toMatchObject({ decision: 'allow' })
    expect(await ask({ tool: 'Write', as: 'write', arguments: { file_path: join(cwd, 'b.txt') } })).toMatchObject({ decision: 'allow' })
    expect(await ask({ tool: 'WebFetch', as: 'web_fetch', arguments: { url: 'https://docs.example.com/x' } })).toMatchObject({ decision: 'allow' })
    const shell = await ask({ tool: 'Bash', as: 'bash', arguments: { command: 'npm install' } })
    expect(shell.decision).toBe('deny')
    expect(shell.reason).toContain('tools.shell: deny')
    // The arguments outrank the label: a command called a read is still a command.
    expect(await ask({ tool: 'Bash', as: 'read', arguments: { command: 'rm -rf src', file_path: join(cwd, 'a.txt') } })).toMatchObject({ decision: 'deny' })
    // A read-only command is a read, as for the project's own agent: the confinement bounds what it reads.
    expect(await ask({ tool: 'Bash', as: 'bash', arguments: { command: 'ls -la' } })).toMatchObject({ decision: 'allow' })
  }, 30_000)

  it('runs an allow-listed command unasked, and asks about another, saying who wants it; the answer is respected and recorded', async () => {
    const { booted, adapter, ask } = await delegated({ approvals: { mode: 'ask', auto_allow: ['npm test'] } })
    expect(await ask({ tool: 'Bash', as: 'bash', arguments: { command: 'npm test' } })).toMatchObject({ decision: 'allow' })

    const denied = ask({ tool: 'Bash', as: 'bash', arguments: { command: 'rm -rf build' } })
    await answerNext(booted, DENY)
    expect(await denied).toMatchObject({ decision: 'deny', reason: expect.stringContaining('Not approved') })
    const question = adapter.sent.map((sent) => sent.message.text).find((text) => text.includes('rm -rf build'))
    expect(question).toContain('through   cc: Bash')
    expect(question).toContain('project site')

    const approved = ask({ tool: 'Bash', as: 'bash', arguments: { command: 'rm -rf build' } })
    await answerNext(booted, APPROVE)
    expect(await approved).toMatchObject({ decision: 'allow' })
    const rows = booted.store.approvals.byRun('run-d1')
    // The allow-listed one is recorded too, as for the project's own agent.
    expect(rows.map((row) => row.status).sort()).toEqual(['denied', 'granted', 'granted'])
  }, 30_000)

  it('takes “approve all for this run” for the rest of that run only', async () => {
    const { booted, ask } = await delegated({ approvals: { mode: 'ask', auto_allow: [] } })
    const first = ask({ tool: 'Bash', as: 'bash', arguments: { command: 'make one' } })
    await answerNext(booted, APPROVE_ALL)
    expect(await first).toMatchObject({ decision: 'allow' })
    expect(await ask({ tool: 'Bash', as: 'bash', arguments: { command: 'make two' } })).toMatchObject({ decision: 'allow' })
    // Another run is asked again.
    const other = ask({ tool: 'Bash', as: 'bash', arguments: { command: 'make two' } }, 'run-d2')
    await answerNext(booted, DENY)
    expect(await other).toMatchObject({ decision: 'deny' })
  }, 30_000)

  it('asks about a read outside the folder and an unknown tool, and refuses a request it cannot read', async () => {
    const { booted, ask } = await delegated({})
    const outside = ask({ tool: 'Read', as: 'read', arguments: { file_path: '/etc/shadow' } })
    await answerNext(booted, DENY)
    expect(await outside).toMatchObject({ decision: 'deny' })
    const unknown = ask({ tool: 'Teleport', as: 'teleport', arguments: {} })
    await answerNext(booted, DENY)
    expect(await unknown).toMatchObject({ decision: 'deny' })
    expect(await ask({ as: 'bash', arguments: { command: 'ls' } })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('could not read') })
    expect(await ask({ tool: 'Bash', as: 'bash', arguments: 'ls' })).toMatchObject({ decision: 'deny' })
  }, 30_000)

  it('withdraws its open question when the run ends, and refuses the call as nobody answered in time for it', async () => {
    const { booted, adapter, ask } = await delegated({})
    const pending = ask({ tool: 'Bash', as: 'bash', arguments: { command: 'make deploy' } }, 'run-gone')
    await waitFor(() => consoleOf(booted).pendingCount > 0, { timeoutMs: 10_000, label: 'a question' })
    booted.ctx.emit('ops/agent-idle', { owner: { kind: 'project', projectId: 'site' }, sessionId: 's', runId: 'run-gone' })
    expect(await pending).toMatchObject({ decision: 'deny', reason: expect.stringContaining('the run ended before an answer') })
    expect(adapter.closed.map((entry) => entry.note)).toContain('The run ended before an answer; nothing was done.')
    expect(booted.store.approvals.byRun('run-gone').map((row) => row.status)).toEqual(['unavailable'])
  }, 30_000)

  it('answers ask on the host channel through ops-projects', async () => {
    const { booted } = await delegated({})
    // The handler the bridge registered: a second registration is refused.
    expect(() => booted.projects.hostHandle('ask', () => ({}))).toThrow(/already answered/)
  }, 30_000)

  const landlock = new ArgusSandbox(new Context()).doctor()[0]?.ok === true

  it.skipIf(!landlock)('decides an ask sent by a confined extension server on its socket, in a run, and records it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-appr-host-'))
    dirs.push(dataDir)
    const repo = mkdtempSync(join(tmpdir(), 'ext-cc-'))
    dirs.push(repo)
    writeFileSync(join(repo, 'extension.yaml'), 'name: cc\nversion: 1.0.0\nsummary: A delegate\nmcp:\n  cc: {command: node, args: ["${EXTENSION_DIR}/host-probe-mcp.mjs"], access: allow, host: [approvals]}\n')
    copyFileSync(fileURLToPath(new URL('../../../ops-projects/test/fixtures/host-probe-mcp.mjs', import.meta.url)), join(repo, 'host-probe-mcp.mjs'))
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'x']]) execFileSync('git', args, { cwd: repo, env })
    const extensions = new Extensions(join(dataDir, 'extensions'), async (argv) => argv)
    await extensions.install((await extensions.fetch(repo, null)).id, 'admin')

    const booted = await bootBridge({
      dataDir,
      projects: { site: projectDocument(dataDir, 'site', { extensions: ['cc'], approvals: { mode: 'ask', auto_allow: ['npm test'] } }) },
      entries: [{ id: 'sandbox', name: '@argus-agent/argus-agent/sandbox-row' }],
    })
    const agent = await booted.projects.ensureAgent('site')
    const ctx = (agent as unknown as { ctx: { tools: { get(name: string, scope: unknown): { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined } } }).ctx
    ;(booted.projects as unknown as { live: Map<string, { runId?: string }> }).live.get('site')!.runId = 'run-host'
    const out = JSON.stringify(await ctx.tools.get('mcp__cc__talk', scopeOf(ctx as never))?.execute({ ask: { tool: 'Bash', as: 'bash', arguments: { command: 'npm test' } } }, { signal: new AbortController().signal }))
    ;(booted.projects as unknown as { live: Map<string, { runId?: string }> }).live.get('site')!.runId = undefined
    expect(out).toContain('\\"decision\\":\\"allow\\"')
    expect(booted.store.approvals.byRun('run-host').map((row) => row.status)).toEqual(['granted'])
    await extensions.remove('cc')
  }, 60_000)
})
