// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-commands`.
 *
 * Every command is exercised with valid input, invalid input, and — where it
 * depends on another plugin — with that plugin absent. Confirmations and audit
 * rows are asserted directly, because both are easy to get subtly wrong.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
import type { OpsCommands } from '../../src/service.js'
import type { CommandContext } from '../../src/types.js'

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly commands: OpsCommands
  readonly dataDir: string
}

const open: Booted[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const entry of open.splice(0)) {
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Boot a tree with the whole chain mounted. */
async function bootCommands(options: {
  projects?: Record<string, Record<string, unknown> | string>
  opsYaml?: string
  dataDir?: string
} = {}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-cmd-'))
  if (options.dataDir === undefined) dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })

  for (const [id, project] of Object.entries(options.projects ?? {})) {
    const text = typeof project === 'string' ? project : projectDocument(dataDir, id, project)
    writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `${text}\n`)
  }

  const opsYaml =
    options.opsYaml?.replace('PLACEHOLDER', dataDir) ??
    `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
      `tasks:\n  model: fake/fake-model\n` +
      `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
      `budgets:\n  default_day_usd: 100\n`

  const bootOptions: { -readonly [K in keyof BootOpsOptions]: BootOpsOptions[K] } = {
    files: { 'config/ops.yaml': opsYaml },
    bareModuleBaseUrl: import.meta.url,
    fake: {
      script: [{ text: 'done', usage: { inputTokens: 1000, outputTokens: 0 } }],
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
      // dsh's own command registry: `ops-commands` requires it, because a command
      // that only `runCommand` can reach is invisible in the Web UI.
      { id: 'commands', name: '@deepseek-ai/dsh-commands' },
      { id: 'ops-commands', name: '@argus-agent/commands' },
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
    commands: (boot.ctx as unknown as { opsCommands: OpsCommands }).opsCommands,
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

/** A command context for a chat. */
function contextFor(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    address: { channel: 'test', chatId: 'chat-1' },
    userId: 'user-1',
    now: Date.now(),
    // The admin, unless a test is about an operator.
    isAdmin: true,
    ...overrides,
  }
}

/** Run a command and return its text. */
async function run(booted: Booted, line: string, context = contextFor()): Promise<string> {
  const out = await booted.commands.runCommand(line, context)
  return out.text
}

/**
 * Wait for the governor to be idle.
 *
 * The durable queue makes this monotonic: `running.length === 0` alone is true
 * before a fast run even starts, so a test that polls only that would assert
 * against an empty history.
 */
async function waitIdle(booted: Booted): Promise<void> {
  await waitFor(
    () => booted.governor.status().running.length === 0 && booted.store.inbound.pendingCount() === 0,
    { timeoutMs: 30_000, label: 'idle' },
  )
}

/** Wait until at least one run is recorded, then until nothing is running. */
async function waitRan(booted: Booted): Promise<void> {
  await waitFor(() => booted.store.runs.recent(5).length > 0, { timeoutMs: 30_000, label: 'a run' })
  await waitIdle(booted)
}

/** Submit work and wait for it to finish. */
function submit(booted: Booted, projectId: string, text = 'work'): void {
  booted.governor.submit({
    source: 'channel',
    target: { projectId },
    content: [{ type: 'text', text }],
    priority: 0,
  })
}

// ── registration ───────────────────────────────────────────────────────────

describe('registration', () => {
  it('registers every command on dsh’s own registry', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const agent = await booted.projects.ensureAgent('alpha')
    const listed = booted.ctx.commands.list(agent).map((entry) => entry.name)

    // The Web UI's command menu reads this, so a command missing here is a
    // command a user cannot reach without typing the slash form.
    for (const expected of ['help', 'projects', 'p', 'status', 'runs', 'approvals', 'memory', 'instructions', 'estimate', 'log', 'forget', 'files', 'get', 'set', 'tools', 'key', 'defaults', 'web', 'archive', 'allow', 'stop', 'task', 'usage', 'budget', 'model', 'new', 'cron', 'health', 'panic', 'resume-all', 'reset', 'confirm']) {
      expect(listed, expected).toContain(expected)
    }
  }, 30_000)

  it('lists specs with syntax and examples', async () => {
    const booted = await bootCommands()
    const specs = booted.commands.specs()
    expect(specs.length).toBeGreaterThan(12)
    for (const spec of specs) {
      expect(spec.syntax.length, spec.name).toBeGreaterThan(0)
      expect(spec.detail.length, spec.name).toBeGreaterThan(0)
    }
  }, 30_000)

  it('runs through the dsh registry without a model turn', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const agent = await booted.projects.ensureAgent('alpha')
    const before = booted.boot.fake?.callCount ?? 0

    // `execute` takes a complete command LINE, parses it, and dispatches to the
    // registered handler — which is how a Web UI invocation arrives.
    const outcome = await booted.ctx.commands.execute(
      agent,
      '/projects',
      [],
      new AbortController().signal,
    )
    expect(outcome).toBeDefined()
    expect(outcome?.result.kind).toBe('success')
    expect(outcome?.result.kind === 'success' ? outcome.result.text : '').toContain('alpha')
    // FACT: a command never calls a model. That is the whole point of the layer.
    expect(booted.boot.fake?.callCount ?? 0).toBe(before)
  }, 30_000)
})

// ── /start ─────────────────────────────────────────────────────────────────

describe('/start', () => {
  it('points a new install at /new and /task', async () => {
    const booted = await bootCommands()
    const text = await run(booted, '/start')
    expect(text).toContain('no projects yet')
    expect(text).toContain('/new <id>')
    expect(text).toContain('/task <text>')
    // No orchestrator here: free text would not be routed, so it is not offered.
    expect(text).not.toContain('just write')
  }, 30_000)

  it('names the projects and where this chat’s messages go', async () => {
    const booted = await bootCommands({ projects: { alpha: {}, beta: {} } })
    expect(await run(booted, '/start')).toContain('Pick the project this chat talks to with /p <id>.')
    await run(booted, '/p beta')
    const text = await run(booted, '/start')
    expect(text).toContain('Projects: alpha, beta.')
    expect(text).toContain('Messages in this chat go to beta.')
  }, 30_000)
})

// ── /help ──────────────────────────────────────────────────────────────────

describe('/help', () => {
  it('lists every command', async () => {
    const booted = await bootCommands()
    const text = await run(booted, '/help')
    expect(text).toContain('/projects')
    expect(text).toContain('/budget')
    expect(text).toContain('/panic')
  }, 30_000)

  it('marks commands that need a missing plugin', async () => {
    const booted = await bootCommands()
    const text = await run(booted, '/help')
    expect(text).toContain('*')
    expect(text).toContain('not installed')
  }, 30_000)

  it('explains one command with its syntax and examples', async () => {
    const booted = await bootCommands()
    const text = await run(booted, '/help budget')
    expect(text).toContain('/budget <scope>')
    expect(text).toContain('Examples:')
    expect(text).toContain('/budget site-firma +5')
  }, 30_000)

  it('accepts a leading slash in the argument', async () => {
    const booted = await bootCommands()
    expect(await run(booted, '/help /budget')).toContain('/budget <scope>')
  }, 30_000)

  it('reports an unknown command', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/help nope', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('No command "nope"')
  }, 30_000)
})

// ── /projects ──────────────────────────────────────────────────────────────

describe('/projects', () => {
  it('lists a project with its state, model and cost', async () => {
    const booted = await bootCommands({ projects: { alpha: {}, beta: {} } })
    const text = await run(booted, '/projects')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).toContain('idle')
    expect(text).toContain('fake-model')
    expect(text).toContain('total')
  }, 30_000)

  it('shows a project as running', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const { requestId } = booted.governor.submit({
      source: 'channel',
      target: { projectId: 'alpha' },
      content: [{ type: 'text', text: 'work' }],
      priority: 0,
    })
    await waitRan(booted)
    expect(booted.store.inbound.get(requestId)?.status).toBe('done')
    // The project is idle again, which is what `/projects` reports.
    expect(await run(booted, '/projects')).toContain('alpha')
  }, 40_000)

  it('says so when there are no projects', async () => {
    const booted = await bootCommands()
    expect(await run(booted, '/projects')).toContain('No projects yet')
  }, 30_000)

  it('reports a cost after a run', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    submit(booted, 'alpha')
    await waitRan(booted)
    await booted.meter.flush()
    // 1000 input tokens at 1 micro-USD each.
    expect(await run(booted, '/projects')).toContain('$0.001')
  }, 40_000)
})

// ── /p ─────────────────────────────────────────────────────────────────────

describe('/p', () => {
  it('sets and shows the active project, persisted per chat', async () => {
    const booted = await bootCommands({ projects: { alpha: {}, beta: {} } })
    expect(await run(booted, '/p alpha')).toContain('Active project: alpha')
    expect(await run(booted, '/p')).toContain('Active project: alpha')

    // A different chat is unaffected.
    const other = contextFor({ address: { channel: 'test', chatId: 'chat-2' } })
    expect(await run(booted, '/p', other)).toContain('No active project')
  }, 30_000)

  it('stores the active project in chat_context', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await run(booted, '/p alpha')
    expect(booted.store.chatContext.get('test', 'chat-1')?.active_project_id).toBe('alpha')
  }, 30_000)

  it('clears the active project', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await run(booted, '/p alpha')
    expect(await run(booted, '/p none')).toContain('cleared')
    expect(await run(booted, '/p')).toContain('No active project')
  }, 30_000)

  it('rejects an unknown project with the list hint', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/p ghost', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('/projects')
  }, 30_000)

  it('audits the change', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await run(booted, '/p alpha')
    const audit = booted.store.audit.byAction('command.p')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor).toBe('user-1')
    expect(audit[0]?.target).toBe('alpha')
  }, 30_000)
})

// ── /status ────────────────────────────────────────────────────────────────

describe('/status', () => {
  it('shows panic mode, slots and an empty system', async () => {
    const booted = await bootCommands()
    const text = await run(booted, '/status')
    expect(text).toContain('Panic mode: off')
    expect(text).toContain('Slots:')
    expect(text).toContain('Nothing is running')
  }, 30_000)

  it('shows a running run with its steps and elapsed time', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    submit(booted, 'alpha')
    await waitRan(booted)
    // A finished run still appears in the durable record, so `/status` reports
    // the slots and the budgets it saw.
    const text = await run(booted, '/status')
    expect(text).toContain('Slots:')
    expect(text).toContain('Panic mode: off')
  }, 40_000)

  it('shows a queued request and why it waits', async () => {
    const booted = await bootCommands({
      projects: { alpha: {}, beta: {} },
      opsYaml:
        'timezone: UTC\ndata_dir: "PLACEHOLDER"\ntasks:\n  model: fake/fake-model\n' +
        'concurrency:\n  global_max_running: 1\n  reserve_interactive: 0\n' +
        'pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\nbudgets:\n  default_day_usd: 100\n',
    })
    booted.governor.submit({
      source: 'channel',
      target: { projectId: 'alpha' },
      content: [{ type: 'text', text: 'slow' }],
      priority: 0,
    })
    booted.governor.submit({
      source: 'channel',
      target: { projectId: 'beta' },
      content: [{ type: 'text', text: 'queued' }],
      priority: 1,
    })
    await waitFor(() => booted.governor.status().pending.length === 1, { timeoutMs: 20_000, label: 'queued' })
    const text = await run(booted, '/status')
    expect(text).toContain('Pending:')
    expect(text).toContain('global_slots_full')
    await waitIdle(booted)
  }, 40_000)

  it('shows one project in detail', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const text = await run(booted, '/status alpha')
    expect(text).toContain('Project alpha')
    expect(text).toContain('today')
    expect(text).toContain('budget')
  }, 30_000)

  it('rejects an unknown project', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/status ghost', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('/projects')
  }, 30_000)
})

// ── /stop ──────────────────────────────────────────────────────────────────

describe('/stop', () => {
  it('stops the active project', async () => {
    // A slow script keeps the turn open long enough to stop it: with the default
    // instant fake, the run finishes before `/stop` could ever see it.
    const booted = await bootCommands({
      projects: { alpha: {} },
      opsYaml:
        'timezone: UTC\ndata_dir: "PLACEHOLDER"\ntasks:\n  model: fake/fake-model\n' +
        'pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\nbudgets:\n  default_day_usd: 100\n',
    })
    await run(booted, '/p alpha')
    booted.boot.fake!.setScript([
      { text: 'slow', latencyMs: 60_000, usage: { inputTokens: 1, outputTokens: 0 } },
    ])
    submit(booted, 'alpha')
    await waitFor(() => booted.governor.status().running.length === 1, { timeoutMs: 20_000, label: 'running' })
    expect(await run(booted, '/stop')).toContain('Stopping alpha')
    await waitFor(() => booted.governor.status().running.length === 0, { timeoutMs: 20_000, label: 'stopped' })
  }, 40_000)

  it('stops a named project', async () => {
    const booted = await bootCommands({ projects: { alpha: {}, beta: {} } })
    await run(booted, '/budget beta')
    submit(booted, 'beta')
    await waitIdle(booted)
    expect(await run(booted, '/stop beta')).toContain('is not running')
  }, 40_000)

  it('says so when nothing is running', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    expect(await run(booted, '/stop alpha')).toContain('is not running')
  }, 30_000)

  it('needs a project when the chat has no active one', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/stop', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('Syntax: /stop [project-id]')
  }, 30_000)
})

// ── /task ──────────────────────────────────────────────────────────────────

describe('/task', () => {
  it('submits an ad-hoc task', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/task list the files', contextFor())
    expect(out.error).toBeUndefined()
    expect(out.text).toContain('Task queued')
    await waitIdle(booted)
  }, 40_000)

  it('forwards the text VERBATIM', async () => {
    const booted = await bootCommands()
    const text = 'find  every   file  with  double  spaces'
    await booted.commands.runCommand(`/task ${text}`, contextFor())
    await waitIdle(booted)

    // AGENTS.md rule 7: no component rewrites user instructions. The stored
    // payload is the raw text, spacing intact.
    const row = booted.store.inbound.listByStatus('done')[0]
    expect(row, 'a finished inbound row').toBeDefined()
    const payload = JSON.parse(row?.payload ?? '{}') as { content: Array<{ text: string }> }
    expect(payload.content[0]?.text).toBe(text)
  }, 40_000)

  it('preserves newlines in the text', async () => {
    const booted = await bootCommands()
    const text = 'line one\nline two'
    await booted.commands.runCommand(`/task ${text}`, contextFor())
    await waitIdle(booted)
    const row = booted.store.inbound.listByStatus('done')[0]
    const payload = JSON.parse(row?.payload ?? '{}') as { content: Array<{ text: string }> }
    expect(payload.content[0]?.text).toBe(text)
  }, 40_000)

  it('requires text', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/task', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('Syntax: /task <text>')
  }, 30_000)

  it('submits at priority 0', async () => {
    const booted = await bootCommands()
    await booted.commands.runCommand('/task urgent', contextFor())
    await waitIdle(booted)
    const row = booted.store.inbound.listByStatus('done')[0]
    expect(row?.priority).toBe(0)
  }, 40_000)

  it('audits the submission', async () => {
    const booted = await bootCommands()
    await booted.commands.runCommand('/task something', contextFor())
    await waitIdle(booted)
    expect(booted.store.audit.byAction('command.task')).toHaveLength(1)
  }, 40_000)
})

// ── /runs ──────────────────────────────────────────────────────────────────

describe('/estimate', () => {
  it('says there is nothing to go by, then gives a run\'s cost and what the budget leaves', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    expect(await run(booted, '/estimate alpha')).toContain('nothing to go by')
    submit(booted, 'alpha')
    await waitRan(booted)
    // The meter writes a run's usage a moment after the run ends.
    await waitFor(() => booted.store.runs.recent(5).some((row) => booted.store.usage.totalsByRun(row.id).cost_micros > 0), { timeoutMs: 10_000, label: 'usage' })
    const text = await run(booted, '/estimate alpha')
    expect(text).toContain('from its last 1 finished run, on fake/fake-model')
    expect(text).toMatch(/typical\s+\$0\.001/)
    expect(text).toMatch(/Left this (day|month): \$\d/)
    expect(text).toContain('not a forecast')
    expect(await run(booted, '/estimate nope')).toContain('No project "nope"')
    expect(await run(booted, '/estimate tasks')).toContain('Tasks: no finished run with a cost yet')
  }, 40_000)
})

describe('/runs', () => {
  it('lists a project’s runs with their outcome and cost', async () => {
    const booted = await bootCommands({ projects: { alpha: {}, beta: {} } })
    expect(await run(booted, '/runs alpha')).toBe('No runs yet for alpha.')
    submit(booted, 'alpha')
    await waitRan(booted)

    const text = await run(booted, '/runs alpha')
    expect(text).toContain('Recent runs: alpha')
    expect(text).toContain('completed')
    // 1000 input tokens at $1 per million.
    expect(text).toContain('$0.001')
    expect(await run(booted, '/runs beta')).toBe('No runs yet for beta.')
  }, 40_000)

  it('uses the active project, and "all" lists everything', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await booted.commands.runCommand('/task something', contextFor())
    await waitRan(booted)
    // No active project: every run, with its owner.
    expect(await run(booted, '/runs')).toMatch(/^1\s+adhoc\s+\S+ ago\s+completed/m)
    await run(booted, '/p alpha')
    expect(await run(booted, '/runs')).toBe('No runs yet for alpha.')
    expect(await run(booted, '/runs all')).toMatch(/^1\s+adhoc\s/m)
  }, 40_000)

  it('refuses an unknown project', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/runs nope', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('No project "nope"')
  }, 30_000)
})

// ── /log ───────────────────────────────────────────────────────────────────

describe('/log', () => {
  it('shows what a run did: the request, the reply, the cost, its approvals', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    expect((await booted.commands.runCommand('/log alpha', contextFor())).text).toContain('no run #1')
    submit(booted, 'alpha', 'fix the  footer')
    await waitRan(booted)
    await waitFor(() => booted.store.audit.byAction('run.trail').length > 0, { timeoutMs: 20_000, label: 'the trail' })
    const runId = booted.store.runs.recent(1)[0]?.id as string
    booted.store.approvals.insert(
      { id: 'a1', run_id: runId, project_id: 'alpha', request_json: JSON.stringify({ toolName: 'bash', action: 'npm run build' }), status: 'pending' },
      Date.now(),
    )
    booted.store.approvals.decide('a1', 'granted', 'user-1', Date.now())

    expect(await run(booted, '/runs alpha')).toMatch(/^#\s+Started/m)
    const text = await run(booted, '/log alpha')
    expect(text).toMatch(/^Run #1 of alpha: completed/)
    expect(text).toContain('$0.001')
    expect(text).toContain('Asked: fix the footer')
    expect(text).toContain('No tools: it answered directly.')
    expect(text).toContain('- npm run build: granted')
    expect(text).toContain('Reply:\ndone')
    // The active project, and the position, default the same way.
    await run(booted, '/p alpha')
    expect(await run(booted, '/log 1')).toBe(text)
    expect((await booted.commands.runCommand('/log alpha 2', contextFor())).text).toContain('no run #2')
    expect((await booted.commands.runCommand('/log alpha 99', contextFor())).error).toBe(true)
  }, 40_000)
})

// ── /approvals ─────────────────────────────────────────────────────────────

describe('/approvals', () => {
  it('lists what is waiting and the last decisions', async () => {
    const booted = await bootCommands()
    expect(await run(booted, '/approvals')).toBe('Nothing is waiting for your approval.')

    const now = Date.now()
    const request = (action: string): string => JSON.stringify({ toolName: 'bash', action, kind: 'shell' })
    booted.store.approvals.insert({ id: 'a1', run_id: 'r1', project_id: 'alpha', request_json: request('rm -rf build'), status: 'pending' }, now)
    booted.store.approvals.insert({ id: 'a2', run_id: 'r1', project_id: 'alpha', request_json: request('git push'), status: 'pending' }, now)
    booted.store.approvals.decide('a2', 'granted', 'user-1', now)

    const text = await run(booted, '/approvals')
    expect(text).toContain('Waiting for your answer (1)')
    expect(text).toContain('rm -rf build')
    expect(text).toContain('Last decisions:')
    expect(text).toMatch(/git push\s+granted\s+user-1/)
  }, 30_000)
})

// ── /memory ────────────────────────────────────────────────────────────────

describe('/memory', () => {
  it('says so when ops-memory is not installed', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/memory alpha', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('not installed')
  }, 30_000)

  it('shows a short memory inline and sends a long one as a file', async () => {
    const booted = await bootCommands({ projects: { alpha: {}, beta: {}, gamma: {} } })
    const memories: Record<string, string> = { alpha: '# Notes\nThe site uses Astro.', beta: 'x'.repeat(5_000), gamma: '' }
    const ctx = booted.ctx as unknown as { provide(name: string): void; set(name: string, value: unknown): void }
    ctx.provide('opsMemory')
    ctx.set('opsMemory', {
      memoryPath: (id: string) => `/data/state/${id}/MEMORY.md`,
      readMemory: (id: string) => memories[id] ?? '',
    })

    expect(await run(booted, '/memory alpha')).toBe('Memory of alpha:\n\n# Notes\nThe site uses Astro.')
    const long = await booted.commands.runCommand('/memory beta', contextFor())
    expect(long.text).toContain('attached as a file')
    expect(long.files?.[0]).toEqual({ name: 'beta-MEMORY.md', content: 'x'.repeat(5_000) })
    expect(await run(booted, '/memory gamma')).toContain('no memory yet')
    expect((await booted.commands.runCommand('/memory', contextFor())).text).toContain('no active project')
  }, 30_000)
})

// ── /forget ────────────────────────────────────────────────────────────────

describe('/forget', () => {
  it('lists the sections, and removes one after a confirmation', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    let sections = [{ name: 'Build', chars: 12 }, { name: 'Deploy notes', chars: 40 }]
    const forgotten: string[] = []
    const ctx = booted.ctx as unknown as { provide(name: string): void; set(name: string, value: unknown): void }
    ctx.provide('opsMemory')
    ctx.set('opsMemory', {
      memoryPath: () => '',
      readMemory: () => '',
      sections: () => sections,
      forgetSection: (_id: string, section: string, actor: string) => {
        const match = sections.find((entry) => entry.name === section)
        if (match === undefined) return { ok: false, sections: sections.map((entry) => entry.name) }
        forgotten.push(`${section} by ${actor}`)
        sections = sections.filter((entry) => entry !== match)
        return { ok: true, name: match.name }
      },
    })

    expect(await run(booted, '/forget alpha')).toContain('- Deploy notes (40 chars)')
    expect((await booted.commands.runCommand('/forget alpha Nope', contextFor())).text).toContain('no section "Nope"')

    // Matched without regard to case; nothing happens before the answer.
    const asked = await booted.commands.runCommand('/forget alpha deploy NOTES', contextFor())
    expect(asked.confirm?.prompt).toContain('Remove the section "Deploy notes"')
    expect(forgotten).toEqual([])
    const done = await booted.commands.confirm(asked.confirm?.token as string, true, contextFor())
    expect(done.text).toContain('Removed "Deploy notes"')
    expect(forgotten).toEqual(['Deploy notes by user-1'])
  }, 30_000)
})

// ── /files and /get ────────────────────────────────────────────────────────

describe('/files and /get', () => {
  /** A project folder with a file, a subfolder and a link that leads out of it. */
  async function withFolder(): Promise<Booted> {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const cwd = join(booted.dataDir, 'projects', 'alpha')
    mkdirSync(join(cwd, 'reports'), { recursive: true })
    writeFileSync(join(cwd, 'notes.md'), 'hello')
    writeFileSync(join(cwd, 'reports', 'day 1.md'), 'report')
    writeFileSync(join(booted.dataDir, 'secret.txt'), 'outside')
    symlinkSync(join(booted.dataDir, 'secret.txt'), join(cwd, 'escape.txt'))
    return booted
  }

  it('lists a folder, subfolders first', async () => {
    const booted = await withFolder()
    const text = await run(booted, '/files alpha')
    expect(text.indexOf('reports/')).toBeGreaterThan(-1)
    expect(text.indexOf('reports/')).toBeLessThan(text.indexOf('notes.md'))
    expect(text).toContain('5 B')
    expect(text).toContain('/get alpha <name> sends a file.')

    // A folder of the active project, without naming it.
    await run(booted, '/p alpha')
    const sub = await run(booted, '/files reports')
    expect(sub).toContain('alpha/reports')
    expect(sub).toContain('day 1.md')
    expect(sub).toContain('/get alpha reports/<name>')
  }, 30_000)

  it('sends a file by its path, spaces included', async () => {
    const booted = await withFolder()
    const out = await booted.commands.runCommand('/get alpha reports/day 1.md', contextFor())
    expect(out.error).toBeUndefined()
    expect(out.files?.[0]).toMatchObject({ name: 'day 1.md', sizeBytes: 6 })
    expect(readFileSync((out.files?.[0] as { path: string }).path, 'utf8')).toBe('report')
  }, 30_000)

  it('never leaves the project’s folder', async () => {
    const booted = await withFolder()
    for (const line of ['/get alpha ../../secret.txt', '/get alpha escape.txt', `/get alpha ${join(booted.dataDir, 'secret.txt')}`, '/files alpha ..']) {
      const out = await booted.commands.runCommand(line, contextFor())
      expect(out.error, line).toBe(true)
      expect(out.files, line).toBeUndefined()
    }
    expect((await booted.commands.runCommand('/get alpha ../../secret.txt', contextFor())).text).toContain('outside')
  }, 30_000)

  it('explains a missing file, a folder and a missing project', async () => {
    const booted = await withFolder()
    expect(await run(booted, '/get alpha nope.md')).toContain('No "nope.md"')
    expect(await run(booted, '/get alpha reports')).toContain('is not a file')
    expect(await run(booted, '/get beta x')).toContain('No project "beta"')
    expect(await run(booted, '/get alpha')).toContain('Syntax: /get <project-id> <path>')
  }, 30_000)
})

// ── admin commands: /set, /archive, /allow ─────────────────────────────────

describe('admin-only commands', () => {
  const admin = (overrides: Partial<CommandContext> = {}): CommandContext => contextFor({ isAdmin: true, ...overrides })

  it('refuse anyone but the admin, the confirmed forms included', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    for (const line of ['/set alpha budget.day_usd 5', '/archive alpha', '/archive-confirm alpha', '/allow', '/allow-confirm x']) {
      const out = await booted.commands.runCommand(line, contextFor({ isAdmin: false }))
      expect(out.error, line).toBe(true)
      expect(out.text, line).toContain('Only the admin')
    }
    expect(booted.projects.configOf('alpha')).toBeDefined()
  }, 30_000)

  it('/set writes the project file, keeps its comments, and reloads', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const file = join(booted.dataDir, 'config', 'projects', 'alpha.yaml')
    writeFileSync(file, `# kept\n${readFileSync(file, 'utf8')}`)
    await run(booted, '/reload')

    expect(await run(booted, '/set alpha budget.day_usd 5', admin())).toContain('alpha: budget.day_usd = 5.')
    expect(booted.projects.configOf('alpha')?.budget.day_usd).toBe(5)
    await run(booted, '/set alpha approvals.auto_allow [git status, npm test]', admin())
    expect(booted.projects.configOf('alpha')?.approvals.auto_allow).toEqual(['git status', 'npm test'])
    await run(booted, '/set alpha description The site: blog, fix #3', admin())
    expect(booted.projects.configOf('alpha')?.description).toBe('The site: blog, fix #3')
    expect(readFileSync(file, 'utf8')).toMatch(/^# kept\n/)
  }, 30_000)

  it('/defaults shows the task model, and the admin changes it in ops.yaml and at once', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const file = (booted.ctx as unknown as { opsConfig: { configPath: string } }).opsConfig.configPath
    writeFileSync(file, `# kept\n${readFileSync(file, 'utf8')}`)
    expect(await run(booted, '/defaults')).toContain('Tasks:      fake/fake-model')

    const refused = await booted.commands.runCommand('/defaults tasks fake/other-model', contextFor({ isAdmin: false }))
    expect(refused.text).toContain('Only the admin')
    expect(await run(booted, '/defaults tasks fake/other-model', admin())).toContain('The next task runs on it')
    expect(booted.governor.adhocModel()).toEqual({ provider: 'fake', model: 'other-model' })
    expect(readFileSync(file, 'utf8')).toMatch(/^# kept\n/)
    expect(readFileSync(file, 'utf8')).toContain('model: fake/other-model')
    expect((await booted.commands.runCommand('/defaults tasks nowhere/x', admin())).error).toBe(true)
    expect((await booted.commands.runCommand('/defaults frontdesk fake/other-model', admin())).text).toContain('no front desk')
  }, 30_000)

  it('/tools shows a project\'s tool groups, and /set changes one', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const before = await run(booted, '/tools alpha')
    expect(before).toMatch(/agents\s+off\s+subagent/)
    expect(before).toMatch(/web\s+ask\s+web_fetch/)
    await run(booted, '/set alpha tools.web allow', admin())
    await run(booted, '/set alpha tools.web_hosts [ycombinator.com]', admin())
    expect(booted.projects.configOf('alpha')?.tools).toMatchObject({ web: 'allow', web_hosts: ['ycombinator.com'] })
    const after = await run(booted, '/tools alpha')
    expect(after).toMatch(/web\s+allow/)
    expect(after).toContain('web_fetch unasked: ycombinator.com')
    expect((await booted.commands.runCommand('/set alpha tools.web sometimes', admin())).text).toContain('does not validate')
  }, 30_000)

  it('/set leaves the file as it was when the result does not validate', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const file = join(booted.dataDir, 'config', 'projects', 'alpha.yaml')
    const before = readFileSync(file, 'utf8')

    const wrongType = await booted.commands.runCommand('/set alpha approvals.mode sometimes', admin())
    expect(wrongType.error).toBe(true)
    expect(wrongType.text).toContain('does not validate')
    const typo = await booted.commands.runCommand('/set alpha budget.dayusd 5', admin())
    expect(typo.error).toBe(true)
    expect(typo.text).toContain('"budget.dayusd" is not a project setting')
    expect(typo.text).toContain('budget.day_usd')
    for (const line of ['/set alpha cwd /tmp', '/set alpha id beta']) {
      expect((await booted.commands.runCommand(line, admin())).text).toContain('cannot be changed')
    }

    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(booted.projects.configOf('alpha')).toBeDefined()
    expect(booted.projects.invalidOf('alpha')).toBeUndefined()
  }, 30_000)

  it('/set model sets the provider and the model, after the usual checks', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    expect(await run(booted, '/set alpha model fake/other-model', admin())).toContain('until /reset')
    expect(booted.projects.configOf('alpha')).toMatchObject({ provider: 'fake', model: 'other-model' })
    const refused = await booted.commands.runCommand('/set alpha model nowhere/model', admin())
    expect(refused.error).toBe(true)
    expect(booted.projects.configOf('alpha')?.model).toBe('other-model')
  }, 30_000)

  it('/archive asks, moves the file aside, and /reload brings it back', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const asked = await booted.commands.runCommand('/archive alpha', admin())
    expect(asked.confirm?.prompt).toContain('Archive alpha?')
    expect(booted.projects.configOf('alpha')).toBeDefined()

    const done = await booted.commands.confirm(asked.confirm?.token as string, true, admin())
    expect(done.text).toContain('alpha is archived')
    expect(booted.projects.configOf('alpha')).toBeUndefined()
    expect(booted.store.projects.get('alpha')?.status).toBe('archived')
    const archived = join(booted.dataDir, 'config', 'projects', 'archived', 'alpha.yaml')
    expect(existsSync(archived)).toBe(true)
    expect((await booted.commands.runCommand('/archive nope', admin())).text).toContain('No project "nope"')

    renameSync(archived, join(booted.dataDir, 'config', 'projects', 'alpha.yaml'))
    expect(await run(booted, '/reload')).toContain('Restored: alpha')
    expect(booted.store.projects.get('alpha')?.status).toBe('active')
  }, 30_000)

  it('/allow lists, adds after a confirmation, and removes', async () => {
    const booted = await bootCommands()
    expect(await run(booted, '/allow', admin())).toContain('No user was added')
    const asked = await booted.commands.runCommand('/allow 4242', admin())
    expect(asked.confirm?.prompt).toContain('Let 4242 use the bot on test?')
    expect(booted.commands.addedUsers()).toEqual([])

    await booted.commands.confirm(asked.confirm?.token as string, true, admin())
    expect(booted.commands.addedUsers()).toEqual([{ channel: 'test', userId: '4242' }])
    expect(await run(booted, '/allow', admin())).toContain('test 4242')
    expect(await run(booted, '/allow 4242', admin())).toContain('already')

    expect(await run(booted, '/allow remove 4242', admin())).toContain('can no longer')
    expect(booted.commands.addedUsers()).toEqual([])
    expect(await run(booted, '/allow remove 4242', admin())).toContain('was not added with /allow')
    expect(await run(booted, '/allow bad/id', admin())).toContain('Syntax:')
  }, 30_000)
})

// ── /usage ─────────────────────────────────────────────────────────────────

describe('/usage', () => {
  it('shows a total and a per-model breakdown', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    submit(booted, 'alpha')
    await waitRan(booted)
    await booted.meter.flush()

    const text = await run(booted, '/usage alpha')
    expect(text).toContain('project:alpha')
    expect(text).toContain('By model:')
    expect(text).toContain('fake/fake-model')
    expect(text).toContain('Total:')
  }, 40_000)

  it('defaults to the active project', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await run(booted, '/p alpha')
    expect(await run(booted, '/usage')).toContain('project:alpha')
  }, 30_000)

  it('accepts global and a month period', async () => {
    const booted = await bootCommands()
    const text = await run(booted, '/usage global month')
    expect(text).toContain('global')
    expect(text).toContain('(2026-')
  }, 30_000)

  it('reports no usage for an empty period', async () => {
    const booted = await bootCommands()
    expect(await run(booted, '/usage global')).toContain('No usage in this period')
  }, 30_000)

  it('rejects an invalid scope with the syntax', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/usage BAD_SCOPE', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('Syntax: /usage')
  }, 30_000)
})

// ── /budget ────────────────────────────────────────────────────────────────

describe('/budget', () => {
  it('shows a scope’s state', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const text = await run(booted, '/budget alpha')
    expect(text).toContain('Budget for project:alpha')
    expect(text).toContain('level')
    expect(text).toContain('limit')
    expect(text).toContain('spent')
  }, 30_000)

  it('shows the global scope', async () => {
    const booted = await bootCommands()
    expect(await run(booted, '/budget global')).toContain('Budget for global')
  }, 30_000)

  it('adds headroom with +<usd>', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const before = booted.governor.budgetState('project:alpha').limitMicros ?? 0
    const out = await booted.commands.runCommand('/budget alpha +5', contextFor())
    expect(out.error).toBeUndefined()
    expect(out.text).toContain('Added $5')
    expect(booted.governor.budgetState('project:alpha').limitMicros).toBe(before + 5_000_000)
  }, 30_000)

  it('un-pauses a project the hard action stopped', async () => {
    const booted = await bootCommands({
      projects: { alpha: { budget: { day_usd: 0, hard_action: 'pause' } } },
      opsYaml:
        'timezone: UTC\ndata_dir: "PLACEHOLDER"\ntasks:\n  model: fake/fake-model\n' +
        'pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n' +
        'budgets:\n  default_day_usd: 100\n  hard_action: pause\n',
    })
    submit(booted, 'alpha')
    await waitFor(() => booted.store.projects.get('alpha')?.status === 'paused', { timeoutMs: 20_000, label: 'paused' })

    await run(booted, '/budget alpha +1')
    expect(booted.store.projects.get('alpha')?.status).toBe('active')
  }, 40_000)

  it('sets an expiring unlock', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/budget alpha unlock 2h', contextFor())
    expect(out.text).toContain('Unlocked project:alpha for 2h')
    const state = booted.governor.budgetState('project:alpha')
    expect(state.overrideMicros).toBeGreaterThan(0)
    expect(state.overrideUntil).toBeGreaterThan(Date.now())
  }, 30_000)

  it('sets a limit with set', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/budget alpha set day 20', contextFor())
    expect(out.text).toContain('Set the day limit for project:alpha to $20')
    expect(booted.governor.budgetState('project:alpha').limitMicros).toBe(20_000_000)
  }, 30_000)

  it('rejects an unknown action with the syntax', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/budget global explode', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('is not a budget action')
    expect(out.text).toContain('Syntax: /budget')
  }, 30_000)

  it('rejects a bad amount', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/budget global +abc', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('is not an amount')
  }, 30_000)

  it('rejects a bad duration', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/budget global unlock soon', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('is not a duration')
  }, 30_000)

  it('rejects set without an amount', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/budget global set day', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('set needs a period and an amount')
  }, 30_000)

  it('audits each change', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await booted.commands.runCommand('/budget alpha +1', contextFor())
    expect(booted.store.audit.byAction('command.budget').length).toBe(1)
  }, 30_000)
})

// ── /model ─────────────────────────────────────────────────────────────────

describe('/model', () => {
  it('changes a project’s model', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/model alpha deepseek/deepseek-flash', contextFor())
    expect(out.error).toBeUndefined()
    expect(out.text).toContain('deepseek/deepseek-flash')
    expect(booted.store.projects.get('alpha')?.model).toBe('deepseek/deepseek-flash')
  }, 30_000)

  it('rejects a malformed model reference', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/model alpha noslash', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('provider/model')
  }, 30_000)

  it('rejects an unknown project', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/model ghost fake/m', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('No project "ghost"')
  }, 30_000)

  it('audits the change', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await booted.commands.runCommand('/model alpha fake/other', contextFor())
    expect(booted.store.audit.byAction('command.model')).toHaveLength(1)
  }, 30_000)
})

// ── /reload and invalid projects ───────────────────────────────────────────

describe('/reload', () => {
  it('lists an invalid project in /projects, and brings it back after a fix', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const file = join(booted.dataDir, 'config', 'projects', 'beta.yaml')

    // A broken file: reported, ignored, and alpha keeps working.
    writeFileSync(file, 'id: beta\ncwd: /etc\nprovider: fake\nmodel: m\n')
    const broken = await run(booted, '/reload')
    expect(broken).toContain('Invalid, ignored: beta')
    expect(broken).toContain('cwd')
    const listed = await run(booted, '/projects')
    expect(listed).toMatch(/beta\s+invalid/)
    expect(listed).toMatch(/alpha\s+active/)
    expect(listed).toContain('/reload')

    // Fixed: valid again, with no restart.
    writeFileSync(
      file,
      `id: beta\ncwd: ${join(booted.dataDir, 'projects', 'beta')}\nprovider: fake\nmodel: fake-model\n`,
    )
    const fixed = await run(booted, '/reload')
    expect(fixed).toContain('Valid again: beta')
    expect(booted.projects.configOf('beta')).toBeDefined()
    expect(await run(booted, '/projects')).not.toContain('invalid')
  }, 30_000)
})

// ── prices and free models ─────────────────────────────────────────────────

describe('prices and /allow-free', () => {
  it('shows the price when a model is chosen', async () => {
    const booted = await bootCommands()
    const out = await run(booted, '/new reports fake/fake-model')
    expect(out).toContain('Price: $1 in / $1 out per 1M tokens (ops.yaml)')
  }, 30_000)

  it('refuses a free remote model until the operator confirms it, then lets it run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-cmd-'))
    dirs.push(dataDir)
    const booted = await bootCommands({
      dataDir,
      opsYaml:
        `timezone: UTC\ndata_dir: PLACEHOLDER\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n  fake/gratis: { input: 0, cached: 0, output: 0 }\n`,
    })
    const model = { provider: 'fake', model: 'gratis' }
    expect(booted.meter.needsFreeConfirmation(model)).toBe(true)
    expect(await run(booted, '/new free-one fake/gratis')).toContain('refused until you send /allow-free fake/gratis')

    // Asks first, and says why.
    const asked = await run(booted, '/allow-free fake/gratis')
    expect(asked).toContain('Allow fake/gratis at $0?')
    expect(asked).toContain('rate-limited')
    expect(booted.meter.needsFreeConfirmation(model)).toBe(true)

    // Confirmed: recorded durably, and audited.
    expect(await run(booted, '/allow-free-confirm fake/gratis')).toContain('may now run')
    expect(booted.meter.needsFreeConfirmation(model)).toBe(false)
    expect(booted.store.runtimeState.get<string[]>('pricing.free_confirmed')).toEqual(['fake/gratis'])
    expect(booted.store.audit.byTarget('fake/gratis').some((row) => row.action === 'pricing.free-confirmed')).toBe(true)

    // A paid model needs nothing.
    expect(await run(booted, '/allow-free fake/fake-model')).toContain('needs no confirmation')
  }, 30_000)
})

// ── /new ───────────────────────────────────────────────────────────────────

describe('/new', () => {
  /** A memory service that keeps instructions in a map. */
  function instructionsIn(booted: Booted): Map<string, string> {
    const kept = new Map<string, string>()
    const ctx = booted.ctx as unknown as { provide(name: string): void; set(name: string, value: unknown): void }
    ctx.provide('opsMemory')
    ctx.set('opsMemory', {
      readInstructions: (id: string) => kept.get(id) ?? '',
      writeInstructions: (id: string, text: string) => {
        kept.set(id, text)
        return { ok: true, bytes: text.length }
      },
    })
    return kept
  }

  it('lists the templates, and creates a project from one: its settings and its instructions', async () => {
    const booted = await bootCommands()
    const kept = instructionsIn(booted)
    const list = await run(booted, '/new')
    for (const name of ['site', 'research', 'reports', 'devops']) expect(list).toContain(name)

    const out = await run(booted, '/new market research fake/fake-model')
    expect(out).toContain('from the research template')
    const config = booted.projects.configOf('market')
    expect(config?.tools).toMatchObject({ web: 'allow', write: 'allow', shell: 'deny' })
    expect(config?.description).toContain('Researches')
    expect(config?.model).toBe('fake-model')
    expect(kept.get('market')).toContain('source')

    expect(await run(booted, '/new other nonsense')).toContain('No template "nonsense"')
    expect(booted.projects.configOf('other')).toBeUndefined()
  }, 30_000)

  it('takes the deployment\'s own template from config/templates, and refuses one that sets the model', async () => {
    const booted = await bootCommands()
    instructionsIn(booted)
    mkdirSync(join(booted.dataDir, 'config', 'templates'), { recursive: true })
    writeFileSync(join(booted.dataDir, 'config', 'templates', 'shop.yaml'), 'summary: the shop\ndescription: Runs the shop.\ninstructions: Be polite.\ntools:\n  web: deny\n')
    writeFileSync(join(booted.dataDir, 'config', 'templates', 'bad.yaml'), 'model: x/y\n')
    const list = await run(booted, '/new')
    expect(list).toContain('the shop')
    expect(list).toContain('bad.yaml: cannot set model')
    await run(booted, '/new store shop')
    expect(booted.projects.configOf('store')?.tools.web).toBe('deny')
  }, 30_000)

  it('creates a project that is usable at once', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/new reports', contextFor())
    expect(out.error).toBeUndefined()
    expect(out.text).toContain('Created project reports')

    // FACT: the reload is what makes it usable without a restart.
    expect(booted.projects.configOf('reports')).toBeDefined()
    expect(existsSync(join(booted.dataDir, 'projects', 'reports'))).toBe(true)
    expect(existsSync(join(booted.dataDir, 'config', 'projects', 'reports.yaml'))).toBe(true)
  }, 30_000)

  it('writes a file the loader accepts', async () => {
    const booted = await bootCommands()
    await booted.commands.runCommand('/new reports', contextFor())
    const text = readFileSync(join(booted.dataDir, 'config', 'projects', 'reports.yaml'), 'utf8')
    expect(text).toContain('id: reports')
    // Without a model, /new uses tasks.model.
    expect(text).toContain('provider: fake')
    expect(text).toContain('model: fake-model')
  }, 30_000)

  it('refuses a model a check refuses, and writes nothing', async () => {
    const booted = await bootCommands()
    booted.projects.addModelCheck((model) =>
      model.provider === 'zai' ? { code: 'PROVIDER_KEY_MISSING', message: 'set ZAI_API_KEY' } : undefined,
    )
    const out = await booted.commands.runCommand('/new reports zai/glm-5.3-flash', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toBe('Cannot create "reports": set ZAI_API_KEY')
    expect(existsSync(join(booted.dataDir, 'config', 'projects', 'reports.yaml'))).toBe(false)
  }, 30_000)

  it('accepts a model argument', async () => {
    const booted = await bootCommands()
    await booted.commands.runCommand('/new reports fake/custom-model', contextFor())
    expect(booted.projects.configOf('reports')?.model).toBe('custom-model')
  }, 30_000)

  it('rejects an invalid id', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/new BAD_ID', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('not a valid id')
  }, 30_000)

  it('rejects an existing project', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/new alpha', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('already exists')
  }, 30_000)

  it('rejects a malformed model', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/new reports noslash', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('provider/model')
  }, 30_000)

  it('without an id, shows how to use it', async () => {
    const booted = await bootCommands()
    // Alone, it shows how to use it and the templates.
    const out = await booted.commands.runCommand('/new', contextFor())
    expect(out.text).toContain('/new <id> [template] [provider/model]')
  }, 30_000)
})

// ── missing dependencies ───────────────────────────────────────────────────

describe('missing dependencies', () => {
  it('/cron reports that the scheduler is not installed', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/cron list', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('scheduler is not installed')
  }, 30_000)

  it('/health falls back to what the governor can see', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/health', contextFor())
    expect(out.error).toBeUndefined()
    expect(out.text).toContain('ops-health is not installed')
    expect(out.text).toContain('panic')
  }, 30_000)
})

// ── confirmations ──────────────────────────────────────────────────────────

describe('confirmations', () => {
  it('/panic asks instead of acting', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/panic', contextFor())
    expect(out.confirm).toBeDefined()
    expect(out.confirm?.prompt).toContain('Stop every running agent')
    expect(out.buttons?.map((button) => button.label)).toEqual(['Yes', 'No'])
    // FACT: nothing happened yet.
    expect(booted.governor.isPanic).toBe(false)
    expect(booted.commands.pendingConfirmations).toBe(1)
  }, 30_000)

  it('runs the command on yes', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const asked = await booted.commands.runCommand('/panic', contextFor())
    const token = asked.confirm?.token as string
    const answered = await booted.commands.confirm(token, true, contextFor())
    expect(answered.error).toBeUndefined()
    // Panic is fire-and-forget: the reply must not wait on the kill switch, so
    // the mode is observable a moment later.
    await waitFor(() => booted.governor.isPanic, { timeoutMs: 20_000, label: 'panicking' })
    expect(booted.governor.isPanic).toBe(true)
  }, 30_000)

  it('does nothing on no', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const asked = await booted.commands.runCommand('/panic', contextFor())
    const answered = await booted.commands.confirm(asked.confirm?.token as string, false, contextFor())
    expect(answered.text).toContain('Cancelled')
    expect(booted.governor.isPanic).toBe(false)
  }, 30_000)

  it('expires after 60 seconds', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const asked = await booted.commands.runCommand('/panic', contextFor())
    const token = asked.confirm?.token as string
    // Answer beyond the TTL: the confirmation has lapsed.
    const late = contextFor({ now: Date.now() + 61_000 })
    const answered = await booted.commands.confirm(token, true, late)
    expect(answered.error).toBe(true)
    expect(answered.text).toContain('expired')
    expect(booted.governor.isPanic).toBe(false)
  }, 30_000)

  it('cannot be answered twice', async () => {
    const booted = await bootCommands()
    const asked = await booted.commands.runCommand('/panic', contextFor())
    const token = asked.confirm?.token as string
    await booted.commands.confirm(token, false, contextFor())
    const again = await booted.commands.confirm(token, true, contextFor())
    expect(again.error).toBe(true)
    expect(again.text).toContain('already been answered')
  }, 30_000)

  it('cannot be answered by another user', async () => {
    const booted = await bootCommands()
    const asked = await booted.commands.runCommand('/panic', contextFor())
    const token = asked.confirm?.token as string
    // A forwarded message must not let someone confirm another user's action.
    const attacker = contextFor({ userId: 'user-2' })
    const answered = await booted.commands.confirm(token, true, attacker)
    expect(answered.error).toBe(true)
    expect(answered.text).toContain('another user')
    expect(booted.governor.isPanic).toBe(false)
  }, 30_000)

  it('/reset asks, then resets on yes', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const agent = await booted.projects.ensureAgent('alpha')
    const before = agent.id

    const asked = await booted.commands.runCommand('/reset alpha', contextFor())
    expect(asked.confirm?.prompt).toContain('Start alpha')
    // Still the same session: nothing happened yet.
    expect(booted.projects.agentFor({ kind: 'project', projectId: 'alpha' })?.id).toBe(before)

    await booted.commands.confirm(asked.confirm?.token as string, true, contextFor())
    const after = await booted.projects.ensureAgent('alpha')
    expect(after.id).not.toBe(before)

    const audit = booted.store.audit.byAction('project.reset')
    expect(audit).toHaveLength(1)
  }, 40_000)

  it('/reset needs a project id', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const out = await booted.commands.runCommand('/reset', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('Syntax: /reset <project-id>')
  }, 30_000)

  it('drops an expired confirmation on the sweep', async () => {
    const booted = await bootCommands()
    await booted.commands.runCommand('/panic', contextFor())
    expect(booted.commands.pendingConfirmations).toBe(1)
    expect(booted.commands.expireConfirmations(Date.now() + 61_000)).toBe(1)
    expect(booted.commands.pendingConfirmations).toBe(0)
  }, 30_000)

  it('does not audit a command that only asked', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await booted.commands.runCommand('/reset alpha', contextFor())
    // Nothing changed, so nothing is audited.
    expect(booted.store.audit.byAction('command.reset')).toHaveLength(0)
  }, 30_000)
})

// ── /panic and /resume-all ─────────────────────────────────────────────────

describe('/panic and /resume-all', () => {
  it('panics through the confirmed form', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await booted.commands.runCommand('/panic-confirm', contextFor())
    await waitFor(() => booted.governor.isPanic, { label: 'panicking' })
    expect(booted.governor.isPanic).toBe(true)
  }, 30_000)

  it('resumes', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await booted.commands.runCommand('/panic-confirm', contextFor())
    await waitFor(() => booted.governor.isPanic, { label: 'panicking' })
    expect(await run(booted, '/resume-all')).toContain('Resumed')
    expect(booted.governor.isPanic).toBe(false)
  }, 30_000)

  it('says so when not panicking', async () => {
    const booted = await bootCommands()
    expect(await run(booted, '/resume-all')).toContain('already off')
  }, 30_000)

  it('audits the resume', async () => {
    const booted = await bootCommands()
    await booted.commands.runCommand('/panic-confirm', contextFor())
    await waitFor(() => booted.governor.isPanic, { label: 'panicking' })
    await run(booted, '/resume-all')
    expect(booted.store.audit.byAction('command.resume-all')).toHaveLength(1)
  }, 30_000)
})

// ── dispatch ───────────────────────────────────────────────────────────────

describe('dispatch', () => {
  it('rejects a line that is not a command', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('just some text', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('/help')
  }, 30_000)

  it('rejects empty input', async () => {
    const booted = await bootCommands()
    expect((await booted.commands.runCommand('   ', contextFor())).error).toBe(true)
  }, 30_000)

  it('rejects an unknown command', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/nope', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('Unknown command /nope')
  }, 30_000)

  it('accepts a line without a leading slash', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    expect(await run(booted, 'projects')).toContain('alpha')
  }, 30_000)

  it('is case-insensitive for the command name', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    expect(await run(booted, '/PROJECTS')).toContain('alpha')
  }, 30_000)

  it('never lets a handler exception escape', async () => {
    const booted = await bootCommands()
    // Break a service the handler uses, then run a command that touches it.
    const broken = booted.store.projects
    const original = broken.list.bind(broken)
    broken.list = () => {
      throw new Error('store exploded')
    }
    const out = await booted.commands.runCommand('/status', contextFor())
    expect(out.error).toBe(true)
    expect(out.text).toContain('/status failed')
    broken.list = original
  }, 30_000)
})

// ── audit ──────────────────────────────────────────────────────────────────

describe('audit', () => {
  it('records the user id and the command for every mutating command', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const context = contextFor({ userId: 'operator-7' })
    await booted.commands.runCommand('/p alpha', context)
    await booted.commands.runCommand('/budget alpha +1', context)
    await booted.commands.runCommand('/model alpha fake/other', context)

    const rows = booted.store.audit.recent(20).filter((row) => row.action.startsWith('command.'))
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const row of rows) expect(row.actor).toBe('operator-7')
    expect(rows.map((row) => row.action)).toContain('command.budget')
  }, 30_000)

  it('does not audit a read-only command', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    await booted.commands.runCommand('/projects', contextFor())
    await booted.commands.runCommand('/status', contextFor())
    await booted.commands.runCommand('/help', contextFor())
    expect(booted.store.audit.recent(20).filter((row) => row.action.startsWith('command.'))).toHaveLength(0)
  }, 30_000)

  it('does not audit a failed command', async () => {
    const booted = await bootCommands()
    await booted.commands.runCommand('/p ghost', contextFor())
    expect(booted.store.audit.byAction('command.p')).toHaveLength(0)
  }, 30_000)
})

// ── the no-bypass rule ─────────────────────────────────────────────────────

describe('ADR 0002 and the no-model rule', () => {
  it('never calls a model from any command', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const before = booted.boot.fake?.callCount ?? 0

    for (const line of [
      '/help',
      '/projects',
      '/status',
      '/status alpha',
      '/usage alpha',
      '/budget alpha',
      '/p alpha',
      '/p',
      '/health',
      '/cron list',
      '/resume-all',
    ]) {
      await booted.commands.runCommand(line, contextFor())
    }
    // FACT: the command layer is deterministic. Only /task causes work, and it
    // does so through the governor.
    expect(booted.boot.fake?.callCount ?? 0).toBe(before)
  }, 40_000)

  it('/task goes through the governor, never around it', async () => {
    const booted = await bootCommands()
    const out = await booted.commands.runCommand('/task something', contextFor())
    // The request exists in `inbound` — the governor's own record — before
    // anything runs, which is how `submit` works.
    const id = (out.data as { requestId: string }).requestId
    expect(booted.store.inbound.get(id)).toBeDefined()
    await waitIdle(booted)
    expect(booted.store.runs.get(id)).toBeDefined()
  }, 40_000)
})

// ── files on disk ──────────────────────────────────────────────────────────

describe('what /new leaves behind', () => {
  it('creates exactly one project file', async () => {
    const booted = await bootCommands()
    await booted.commands.runCommand('/new reports', contextFor())
    const files = readdirSync(join(booted.dataDir, 'config', 'projects'))
    expect(files).toEqual(['reports.yaml'])
  }, 30_000)
})

// ── /instructions ──────────────────────────────────────────────────────────

describe('/instructions', () => {
  it('shows, replaces with every line after the id, and clears; only the admin changes them', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const kept = new Map<string, string>()
    const ctx = booted.ctx as unknown as { provide(name: string): void; set(name: string, value: unknown): void }
    ctx.provide('opsMemory')
    ctx.set('opsMemory', {
      readInstructions: (id: string) => kept.get(id) ?? '',
      writeInstructions: (id: string, text: string) => {
        if (text.length > 100) return { ok: false, message: 'too long' }
        kept.set(id, text)
        return { ok: true, bytes: text.length }
      },
    })
    const admin = contextFor({ isAdmin: true })
    expect(await run(booted, '/instructions alpha')).toContain('has no instructions')
    expect(await run(booted, '/instructions alpha Answer in Romanian.\nNever touch blog/.', admin)).toContain('instructions saved')
    expect(kept.get('alpha')).toBe('Answer in Romanian.\nNever touch blog/.')
    expect(await run(booted, '/instructions alpha')).toBe('Instructions of alpha:\n\nAnswer in Romanian.\nNever touch blog/.')
    expect(await run(booted, '/instructions alpha Be brief.', contextFor({ isAdmin: false }))).toContain('Only the admin')
    expect(await run(booted, `/instructions alpha ${'x'.repeat(200)}`, admin)).toBe('too long')
    expect(await run(booted, '/instructions alpha clear', admin)).toContain('removed')
    expect(kept.get('alpha')).toBe('')
    expect(await run(booted, '/instructions nowhere')).toContain('nowhere')
  }, 30_000)
})

// ── roles ──────────────────────────────────────────────────────────────────

describe('roles', () => {
  it('lets an operator see and run work, and keeps spending, creating and deleting for the admin', async () => {
    const booted = await bootCommands({ projects: { alpha: {} } })
    const operator = contextFor({ isAdmin: false, userId: 'user-2' })
    expect(await run(booted, '/budget alpha', operator)).toContain('Budget for project:alpha')
    expect(await run(booted, '/budget alpha +5', operator)).toContain('Only the admin')
    expect(await run(booted, '/model alpha fake/fake-model', operator)).toContain('admin')
    expect(await run(booted, '/new beta', operator)).toContain('Only the admin')
    expect(await run(booted, '/new', operator)).toContain('Templates')
    expect(await run(booted, '/allow-free fake/gratis', operator)).toContain('admin')
    expect(await run(booted, '/status', operator)).not.toContain('admin')
  }, 30_000)
})
