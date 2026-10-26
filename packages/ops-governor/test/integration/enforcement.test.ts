// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-governor`.
 *
 * PLAN.md Faza 3's four acceptance scenarios, plus the edge cases the prompt
 * enumerates. Each boots a real dsh tree with a scripted fake adapter.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import type { OpsGovernor } from '../../src/service.js'

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly dataDir: string
}

const open: Booted[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const entry of open.splice(0)) {
    // Stop the governor first: its dispatch chain holds promises that reference
    // the tree, and disposing underneath an in-flight pass leaves effects that
    // leak into the NEXT boot in this process (a shared config registry, a live
    // timer). Draining before teardown is what makes one test's failure not
    // become the next test's mystery.
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A pricing table covering the fake adapter's models. */
const PRICING = `
pricing:
  fake/*: { input: 1, cached: 1, output: 1 }
  anthropic/claude-sonnet-x: { input: 3, cached: 0.3, output: 15 }
`

/** Boot a tree with the whole chain mounted. */
async function bootGovernor(options: {
  projects?: Record<string, Record<string, unknown> | string>
  opsYaml?: string
  dataDir?: string
  script?: Array<Record<string, unknown>>
  repeatLast?: boolean
} = {}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-gov-'))
  if (options.dataDir === undefined) dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })

  for (const [id, project] of Object.entries(options.projects ?? {})) {
    const text = typeof project === 'string' ? project : projectDocument(dataDir, id, project)
    writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `${text}\n`)
  }

  const opsYaml = (options.opsYaml ?? `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n${PRICING}`).replace(
    'PLACEHOLDER',
    dataDir,
  )

  const bootOptions: { -readonly [K in keyof BootOpsOptions]: BootOpsOptions[K] } = {
    files: { 'config/ops.yaml': opsYaml },
    bareModuleBaseUrl: import.meta.url,
    replaceEntries: [
      ...BASE_ENTRIES,
      persistenceEntry(join(dataDir, 'sessions')),
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'default' } },
      { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
      { id: 'ops-store', name: '@argus-agent/store' },
      { id: 'ops-projects', name: '@argus-agent/projects' },
      { id: 'ops-meter', name: '@argus-agent/meter' },
      { id: 'ops-governor', name: '@argus-agent/governor' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
    ],
  }
  bootOptions.fake = {
    script: (options.script ?? [{ text: 'done', usage: { inputTokens: 1000, outputTokens: 0 } }]) as never,
    repeatLast: options.repeatLast ?? true,
  }

  const boot = await bootOps(bootOptions)
  const entry: Booted = {
    boot,
    ctx: boot.ctx,
    store: (boot.ctx as unknown as { opsStore: OpsStore }).opsStore,
    projects: (boot.ctx as unknown as { opsProjects: OpsProjects }).opsProjects,
    meter: (boot.ctx as unknown as { opsMeter: OpsMeter }).opsMeter,
    governor: (boot.ctx as unknown as { opsGovernor: OpsGovernor }).opsGovernor,
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
    .map(([key, value]) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? `${key}:\n${renderYaml(value, 1)}`
        : `${key}: ${JSON.stringify(value)}`,
    )
    .join('\n')
}

/** Render a nested object as indented YAML. */
function renderYaml(value: unknown, depth: number): string {
  const pad = '  '.repeat(depth)
  if (value === null || typeof value !== 'object') return `${pad}${JSON.stringify(value)}`
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? `${pad}${key}:\n${renderYaml(item, depth + 1)}`
        : `${pad}${key}: ${JSON.stringify(item)}`,
    )
    .join('\n')
}

/**
 * Wait until nothing is running and nothing is queued.
 *
 * Polling the transient `running.length` alone races a fast fake adapter: a run
 * can start and finish between two polls, so a check for `=== 0` passes before
 * the run ever began. Waiting on the durable queue as well makes the condition
 * monotonic — it cannot be true before the work was admitted.
 *
 * @param booted the booted tree.
 * @param label a label for a timeout message.
 */
async function waitIdle(booted: Booted, label = 'drained'): Promise<void> {
  await waitFor(
    () => booted.governor.status().running.length === 0 && booted.store.inbound.pendingCount() === 0,
    { timeoutMs: 30_000, label },
  )
}

/** Submit one message to a project. */
function submit(booted: Booted, projectId: string, text = 'work', priority: 0 | 1 | 2 = 0): string {
  return booted.governor.submit({
    source: 'channel',
    target: { projectId },
    content: [{ type: 'text', text }],
    priority,
  }).requestId
}

// ── scenario 1: limited concurrency with a queue ───────────────────────────

describe('scenario 1: limited concurrency with a queue', () => {
  it('admits up to the global limit and queues the rest', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {}, beta: {}, gamma: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nconcurrency:\n  global_max_running: 1\n  reserve_interactive: 0\n${PRICING}`,
      script: [{ text: 'slow', latencyMs: 400, usage: { inputTokens: 100, outputTokens: 0 } }],
      repeatLast: true,
    })

    const first = submit(booted, 'alpha', 'first')
    const second = submit(booted, 'beta', 'second')
    const third = submit(booted, 'gamma', 'third')

    await waitFor(() => booted.governor.status().running.length === 1, { label: 'one running' })
    // The limit is respected: the other two wait.
    expect(booted.governor.status().pending).toHaveLength(2)

    // As each finishes, the next is admitted. The queue is what must empty:
    // `running` dips to zero for an instant between one run ending and the next
    // being admitted, so waiting on it alone would assert too early.
    await waitFor(() => booted.governor.status().pending.length === 0, { timeoutMs: 30_000, label: 'drained' })
    await waitFor(() => booted.governor.status().running.length === 0, { timeoutMs: 20_000, label: 'idle' })

    for (const id of [first, second, third]) {
      expect(booted.store.inbound.get(id)?.status).toBe('done')
    }
    expect(booted.store.runs.recent(10).filter((run) => run.status === 'completed')).toHaveLength(3)
  }, 40_000)

  it('reports why a request is waiting', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {}, beta: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nconcurrency:\n  global_max_running: 1\n  reserve_interactive: 0\n${PRICING}`,
      script: [{ text: 'slow', latencyMs: 400, usage: { inputTokens: 100, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha')
    submit(booted, 'beta')
    await waitFor(() => booted.governor.status().pending.length === 1, { label: 'queued' })
    // A queue that says only "waiting" is undiagnosable, so the reason is named.
    expect(booted.governor.status().pending[0]?.blockedBy).toBe('global_slots_full')
  }, 30_000)

  it("takes the project's undo point before the run starts", async () => {
    const booted = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\n${PRICING}`,
      script: [{ text: 'done', usage: { inputTokens: 100, outputTokens: 0 } }],
    })
    mkdirSync(join(booted.dataDir, 'projects', 'alpha'), { recursive: true })
    writeFileSync(join(booted.dataDir, 'projects', 'alpha', 'notes.md'), 'before\n')
    const runId = submit(booted, 'alpha')
    await waitFor(() => booted.governor.status().running.length === 1 || booted.store.inbound.get(runId)?.status === 'done', { label: 'admitted' })
    expect((await booted.projects.undoList('alpha')).map((entry) => entry.id)).toEqual([runId])
  }, 30_000)

  it('delivers into a running agent instead of taking a second slot', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nconcurrency:\n  global_max_running: 1\n  reserve_interactive: 0\n${PRICING}`,
      script: [{ text: 'slow', latencyMs: 400, usage: { inputTokens: 100, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha', 'first')
    await waitFor(() => booted.governor.status().running.length === 1, { label: 'running' })
    const second = submit(booted, 'alpha', 'second')

    // The second message queues in the agent's inbox and adds no concurrency, so
    // it is admitted rather than left pending.
    await waitFor(() => booted.store.inbound.get(second)?.status === 'done', { label: 'second admitted' })
    expect(booted.governor.status().running.length).toBe(1)
  }, 30_000)
})

// ── scenario 2: stop mid-turn at the budget ────────────────────────────────

describe('scenario 2: stopping mid-turn at the budget', () => {
  it('rejects the next step and closes the run as budget_stopped', async () => {
    const booted = await bootGovernor({
      // The project's own budget wins over the global default, so the scope that
      // trips is `project:alpha`. One 1000-token step costs 1000 micro-USD and
      // the budget is 800, so the FIRST step's usage crosses the hard limit and
      // the SECOND step is what gets refused.
      projects: { alpha: { budget: { day_usd: 0.0008, soft_pct: 60, hard_action: 'pause' } } },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\n` +
        `budgets:\n  default_day_usd: 100\n  hard_action: pause\n${PRICING}`,
      // Two steps: the first spends the budget, the second must be refused.
      script: [
        { text: 'step one', usage: { inputTokens: 1000, outputTokens: 0 }, toolCalls: [{ name: 'probe', arguments: '{}', id: 'c1' }] },
        { text: 'step two', usage: { inputTokens: 1000, outputTokens: 0 } },
      ],
      repeatLast: false,
    })

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    agent.ctx.tools.register(
      defineTool({
        name: 'probe',
        description: 'probe',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => 'probed',
      }),
    )

    const stopped: Array<{ reason: string }> = []
    booted.ctx.on('ops/run-stopped', ({ reason }) => stopped.push({ reason }))

    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'run ended')

    // The second step was refused, so the model was called once.
    expect(booted.boot.fake?.callCount).toBe(1)
    expect(stopped.map((entry) => entry.reason)).toContain('budget_stopped')

    const run = booted.store.runs.recent(1)[0]
    expect(run?.status).toBe('budget_stopped')
    expect(run?.stop_reason).toBe('budget_stopped')
  }, 40_000)

  it('rejects a NEW request once the budget is exhausted', async () => {
    const booted = await bootGovernor({
      projects: { alpha: { budget: { day_usd: 0.001, hard_action: 'reject_new' } } },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n  hard_action: reject_new\n${PRICING}`,
      script: [{ text: 'done', usage: { inputTokens: 5000, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha', 'first')
    await waitIdle(booted, 'first done')

    const rejected: Array<{ code: string; scope?: string }> = []
    booted.ctx.on('ops/request-rejected', ({ code, scope }) => rejected.push({ code, ...(scope === undefined ? {} : { scope }) }))

    submit(booted, 'alpha', 'second')
    await waitFor(() => rejected.length > 0, { label: 'rejection' })

    expect(rejected[0]?.code).toBe('BUDGET_EXCEEDED')
    // The scope is named, so the operator knows WHICH budget stopped it.
    expect(rejected[0]?.scope === 'global' || rejected[0]?.scope === 'project:alpha').toBe(true)
  }, 40_000)

  it('pauses the project when the hard action is pause', async () => {
    const booted = await bootGovernor({
      projects: { alpha: { budget: { day_usd: 0.001, hard_action: 'pause' } } },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n  hard_action: pause\n${PRICING}`,
      script: [{ text: 'done', usage: { inputTokens: 5000, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha')
    await waitFor(() => booted.store.projects.get('alpha')?.status === 'paused', { label: 'paused' })
  }, 40_000)


  it('rejects a request when the budget is exhausted before it starts', async () => {
    const booted = await bootGovernor({
      projects: { alpha: { budget: { day_usd: 0, hard_action: 'reject_new' } } },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n  hard_action: reject_new\n${PRICING}`,
    })
    const rejected: Array<{ code: string; message: string; scope?: string }> = []
    booted.ctx.on('ops/request-rejected', (payload) => rejected.push(payload))

    // A zero budget is exhausted before the first request, so it is refused at
    // ADMISSION — no run is created and no provider is called.
    submit(booted, 'alpha')
    await waitFor(() => rejected.length > 0, { label: 'rejected' })
    expect(rejected[0]?.code).toBe('BUDGET_EXCEEDED')
    expect(rejected[0]?.message).toContain('budget')
    expect(rejected[0]?.scope).toBe('project:alpha')
    expect(booted.store.runs.recent(1)).toHaveLength(0)
    expect(booted.boot.fake?.callCount ?? 0).toBe(0)
  }, 30_000)

  it('emits ops/run-stopped with a detail naming the scope', async () => {
    const booted = await bootGovernor({
      // A budget that admits the first step and refuses the second: the run
      // STARTS, so the stop is what the test observes.
      projects: { alpha: { budget: { day_usd: 0.001, hard_action: 'reject_new' } } },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n  hard_action: reject_new\n${PRICING}`,
      script: [
        {
          text: 'step one',
          usage: { inputTokens: 2000, outputTokens: 0 },
          toolCalls: [{ name: 'probe', arguments: '{}', id: 'c1' }],
        },
        { text: 'step two', usage: { inputTokens: 10, outputTokens: 0 } },
      ],
      repeatLast: false,
    })

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    agent.ctx.tools.register(
      defineTool({
        name: 'probe',
        description: 'probe',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => 'probed',
      }),
    )

    const details: string[] = []
    booted.ctx.on('ops/run-stopped', ({ detail }) => details.push(detail))
    submit(booted, 'alpha')
    await waitFor(() => details.length > 0, { label: 'stopped' })
    expect(details[0]).toContain('budget')
  }, 30_000)
})

// ── scenario 3: downgrade at the soft threshold ────────────────────────────

describe('scenario 3: downgrade at the soft threshold', () => {
  it('switches to the fallback model and audits it once', async () => {
    const booted = await bootGovernor({
      projects: {
        alpha: { fallback_model: 'fake/cheap-model', budget: { day_usd: 0.01, soft_pct: 50, soft_action: 'downgrade' } },
      },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n${PRICING}`,
      script: [
        // 6000 micro-USD of a 10000 budget: past soft (50%), short of hard (100%).
        { text: 'first', usage: { inputTokens: 6000, outputTokens: 0 } },
        { text: 'second', usage: { inputTokens: 10, outputTokens: 0 } },
      ],
      repeatLast: true,
    })

    // First turn spends past the soft threshold (60% of the 10 000 budget).
    submit(booted, 'alpha', 'first')
    await waitIdle(booted, 'first done')
    // The threshold is evaluated on the metering path, which runs at the end of
    // the turn, so the downgrade lands as the run closes.
    console.error('DIAG state:', JSON.stringify(booted.governor.budgetState('project:alpha')))
    console.error('DIAG spend:', booted.meter.spending('project:alpha').dayMicros)
    await waitFor(() => booted.governor.isDowngraded('project:alpha'), {
      timeoutMs: 20_000,
      label: 'downgraded',
    })

    // Second turn must use the fallback.
    submit(booted, 'alpha', 'second')
    await waitIdle(booted, 'second done')

    const models = (booted.boot.fake?.requests ?? []).map((request) => request.model)
    expect(models).toContain('cheap-model')

    // Audited once, not once per request.
    const audit = booted.store.audit.byAction('budget.downgrade')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.target).toBe('alpha')
  }, 40_000)

  it('records the downgraded model on the usage event', async () => {
    const booted = await bootGovernor({
      projects: {
        alpha: { fallback_model: 'fake/cheap-model', budget: { day_usd: 0.01, soft_pct: 50, soft_action: 'downgrade' } },
      },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n${PRICING}`,
      script: [{ text: 'x', usage: { inputTokens: 6000, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha', 'one')
    await waitIdle(booted, 'one')
    submit(booted, 'alpha', 'two')
    await waitIdle(booted, 'two')
    await booted.meter.flush()

    // `request/header` records the model actually used, so the downgrade is
    // visible in the metered record rather than only in the governor's memory.
    const events = booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)
    expect(events.map((event) => event.model)).toContain('cheap-model')
  }, 40_000)

  it('does not downgrade below the soft threshold', async () => {
    const booted = await bootGovernor({
      projects: {
        alpha: { fallback_model: 'fake/cheap-model', budget: { day_usd: 10, soft_pct: 80, soft_action: 'downgrade' } },
      },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n${PRICING}`,
    })
    submit(booted, 'alpha')
    await waitIdle(booted, 'done')
    expect(booted.governor.isDowngraded('project:alpha')).toBe(false)
    expect((booted.boot.fake?.requests ?? []).map((r) => r.model)).not.toContain('cheap-model')
  }, 30_000)
})

// ── scenario 4: panic in under five seconds ────────────────────────────────

describe('scenario 4: panic', () => {
  it('cancels every agent and refuses new work, in under five seconds', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {}, beta: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nconcurrency:\n  global_max_running: 3\n${PRICING}`,
      script: [{ text: 'never', latencyMs: 60_000, usage: { inputTokens: 1, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha')
    submit(booted, 'beta')
    await waitFor(() => booted.governor.status().running.length === 2, { label: 'both running' })

    const events: Array<{ cancelled: number; tookMs: number }> = []
    booted.ctx.on('ops/panic', (payload) => events.push(payload))

    const started = Date.now()
    const result = await booted.governor.panic()
    const elapsed = Date.now() - started

    // The acceptance criterion is a hard five seconds.
    expect(elapsed).toBeLessThan(5_000)
    expect(result.cancelled).toBe(2)
    expect(events).toHaveLength(1)

    await waitFor(() => booted.governor.status().running.length === 0, { timeoutMs: 15_000, label: 'all idle' })
  }, 40_000)

  it('refuses a submission while panicking', async () => {
    const booted = await bootGovernor({ projects: { alpha: {} } })
    const rejected: string[] = []
    booted.ctx.on('ops/request-rejected', ({ code }) => rejected.push(code))
    await booted.governor.panic()
    submit(booted, 'alpha')
    await waitFor(() => rejected.length > 0, { label: 'rejected' })
    expect(rejected[0]).toBe('PANIC_MODE')
    expect(booted.governor.status().running).toHaveLength(0)
  }, 30_000)

  it('resumes after resumeAll', async () => {
    const booted = await bootGovernor({ projects: { alpha: {} } })
    await booted.governor.panic()
    expect(booted.governor.isPanic).toBe(true)

    booted.governor.resumeAll()
    expect(booted.governor.isPanic).toBe(false)

    submit(booted, 'alpha')
    await waitIdle(booted, 'ran after resume')
    await waitFor(() => booted.store.runs.recent(1).length > 0, { timeoutMs: 20_000, label: 'run row' })
    expect(booted.store.runs.recent(1)[0]?.status).toBe('completed')
  }, 30_000)

  it('persists panic mode across a restart', async () => {
    const first = await bootGovernor({ projects: { alpha: {} } })
    const dataDir = first.dataDir
    await first.governor.panic()
    await first.meter.stop()
    await first.boot.dispose()

    const second = await bootGovernor({ dataDir, projects: { alpha: {} } })
    // A restart must not silently clear a deliberate stop.
    expect(second.governor.isPanic).toBe(true)
  }, 40_000)
})

// ── interactive reservation ────────────────────────────────────────────────

describe('interactive reservation', () => {
  it('keeps a slot free for a human under scheduled load', async () => {
    const booted = await bootGovernor({
      projects: { sched1: {}, sched2: {}, human: {} },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\n` +
        `concurrency:\n  global_max_running: 2\n  reserve_interactive: 1\n${PRICING}`,
      script: [{ text: 'slow', latencyMs: 500, usage: { inputTokens: 100, outputTokens: 0 } }],
      repeatLast: true,
    })

    // Two scheduled jobs: only one may run, because one slot is reserved.
    submit(booted, 'sched1', 'job one', 1)
    submit(booted, 'sched2', 'job two', 1)
    await waitFor(() => booted.governor.status().running.length === 1, { label: 'one scheduled running' })
    expect(booted.governor.status().pending).toHaveLength(1)
    expect(booted.governor.status().pending[0]?.blockedBy).toBe('global_slots_reserved')

    // The human's message takes the reserved slot immediately.
    submit(booted, 'human', 'help me', 0)
    await waitFor(() => booted.governor.status().running.length === 2, { label: 'human admitted' })
    expect(booted.governor.status().running.some((run) => run.owner.kind === 'project' && run.owner.projectId === 'human')).toBe(true)
  }, 40_000)
})

// ── per-run limits ─────────────────────────────────────────────────────────

describe('per-run limits', () => {
  it('stops an infinite tool loop', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nlimits:\n  loop_repeat_threshold: 3\n  max_steps_total: 50\n${PRICING}`,
      // The model asks for the same tool with identical arguments, forever.
      script: [
        { text: 'again', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'spin', arguments: '{"x":1}', id: 'c1' }] },
      ],
      repeatLast: true,
    })

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    let calls = 0
    agent.ctx.tools.register(
      defineTool({
        name: 'spin',
        description: 'spin',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => {
          calls += 1
          return 'spun'
        },
      }),
    )

    const reasons: string[] = []
    booted.ctx.on('ops/run-stopped', ({ reason }) => reasons.push(reason))

    submit(booted, 'alpha', 'go')
    // Wait for the run to actually START before waiting for it to finish: with a
    // synchronous `running.length === 0` check, a request still in the admission
    // queue looks identical to a finished run, and the assertion fires against an
    // empty history.
    // A fast fake adapter can finish the whole run before the first poll, so the
    // signal is the STOP EVENT rather than a transient `running` count.
    await waitFor(() => reasons.length > 0, { timeoutMs: 25_000, label: 'loop stopped' })

    // FACT: without detection this would run until its ceiling.
    expect(reasons).toContain('loop_detected')
    expect(calls).toBeLessThan(10)
    expect(booted.store.runs.recent(1)[0]?.status).toBe('limit_stopped')
  }, 45_000)

  it('does not stop a loop of DIFFERENT tool calls', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nlimits:\n  loop_repeat_threshold: 3\n  max_steps_total: 50\n${PRICING}`,
      // The arguments change each time, so this is paging, not looping.
      script: [
        { text: 'one', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'page', arguments: '{"n":1}', id: 'c1' }] },
        { text: 'two', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'page', arguments: '{"n":2}', id: 'c2' }] },
        { text: 'three', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'page', arguments: '{"n":3}', id: 'c3' }] },
        { text: 'done', usage: { inputTokens: 10, outputTokens: 0 } },
      ],
      repeatLast: false,
    })

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    agent.ctx.tools.register(
      defineTool({
        name: 'page',
        description: 'page',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => 'page',
      }),
    )

    const reasons: string[] = []
    booted.ctx.on('ops/run-stopped', ({ reason }) => reasons.push(reason))

    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'finished')

    expect(reasons).not.toContain('loop_detected')
    expect(booted.store.runs.recent(1)[0]?.status).toBe('completed')
  }, 45_000)

  it('lets the same call run again while its result changes', async () => {
    const tool = (name: string, run: () => string) => ({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text' as const, text: v }] }, execute: async () => run() })
    const { defineTool } = await import('@deepseek-ai/dsh-tools')

    // A test run again after each fix: same call, a different result each time.
    const progress = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nlimits:\n  loop_repeat_threshold: 3\n  max_steps_total: 50\n${PRICING}`,
      script: [
        ...Array.from({ length: 6 }, (_, n) => ({ text: 'again', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'test', arguments: '{}', id: `t${n}` }] })),
        { text: 'done', usage: { inputTokens: 10, outputTokens: 0 } },
      ],
      repeatLast: false,
    })
    let failing = 6
    ;(await progress.projects.ensureAgent('alpha')).ctx.tools.register(defineTool(tool('test', () => `${failing--} failing`) as never))
    const reasons: string[] = []
    progress.ctx.on('ops/run-stopped', ({ reason }) => reasons.push(reason))
    submit(progress, 'alpha', 'go')
    await waitFor(() => failing === 0 && progress.governor.status().running.length === 0, { timeoutMs: 25_000, label: 'the run' })
    expect(reasons).toEqual([])
  }, 60_000)

  it('stops a cycle of two calls that changes nothing', async () => {
    const tool = (name: string, run: () => string) => ({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text' as const, text: v }] }, execute: async () => run() })
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    // Read, edit, read, edit… with the same results: a cycle.
    const cycle = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nlimits:\n  loop_repeat_threshold: 3\n  max_steps_total: 50\n${PRICING}`,
      script: Array.from({ length: 40 }, (_, n) => ({ text: 'x', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: n % 2 === 0 ? 'look' : 'change', arguments: '{"path":"a.ts"}', id: `c${n}` }] })),
      repeatLast: true,
    })
    const agent = await cycle.projects.ensureAgent('alpha')
    agent.ctx.tools.register(defineTool(tool('look', () => 'const a = 1') as never))
    agent.ctx.tools.register(defineTool(tool('change', () => 'edited') as never))
    const details: string[] = []
    cycle.ctx.on('ops/run-stopped', ({ detail }) => details.push(detail))
    submit(cycle, 'alpha', 'go')
    await waitFor(() => details.length > 0, { timeoutMs: 25_000, label: 'the cycle stopped' })
    expect(details[0]).toBe('a cycle of 2 calls (look, change) repeated 3 times with the same results')
  }, 60_000)

  it('stops a run that gets nothing new and changes no file', async () => {
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    // Four different calls in turn: no repetition and no cycle of 2 or 3, so only the
    // no-progress check can see that nothing happens.
    const script = Array.from({ length: 40 }, (_, n) => ({ text: 'x', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'probe', arguments: JSON.stringify({ n: n % 4 }), id: `c${n}` }] }))
    const boot = () =>
      bootGovernor({
        projects: { alpha: {} },
        opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nlimits:\n  loop_repeat_threshold: 99\n  stall_steps: 6\n  max_steps_total: 20\n${PRICING}`,
        script,
        repeatLast: true,
      }).then(async (booted) => {
        ;(await booted.projects.ensureAgent('alpha')).ctx.tools.register(
          defineTool({ name: 'probe', description: 'probe', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: async () => 'nothing new' }),
        )
        const stops: Array<{ reason: string; detail: string }> = []
        booted.ctx.on('ops/run-stopped', ({ reason, detail }) => stops.push({ reason, detail }))
        submit(booted, 'alpha', 'go')
        await waitFor(() => stops.length > 0, { timeoutMs: 25_000, label: 'the run stopped' })
        return stops[0]
      })
    expect(await boot()).toEqual({ reason: 'stalled', detail: '6 steps in a row with no new result and no file changed' })
  }, 60_000)

  it('does not stall a run whose tools answer the same while it writes files', async () => {
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const booted = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nlimits:\n  loop_repeat_threshold: 99\n  stall_steps: 6\n  max_steps_total: 20\n${PRICING}`,
      script: Array.from({ length: 40 }, (_, n) => ({ text: 'x', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'probe', arguments: JSON.stringify({ n: n % 4 }), id: `c${n}` }] })),
      repeatLast: true,
    })
    const cwd = booted.projects.configOf('alpha')!.cwd
    let n = 0
    ;(await booted.projects.ensureAgent('alpha')).ctx.tools.register(
      defineTool({ name: 'probe', description: 'probe', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: async () => {
        writeFileSync(join(cwd, `out-${n++}.txt`), 'x')
        return 'nothing new'
      } }),
    )
    const stops: string[] = []
    booted.ctx.on('ops/run-stopped', ({ reason }) => stops.push(reason))
    submit(booted, 'alpha', 'go')
    await waitFor(() => stops.length > 0, { timeoutMs: 25_000, label: 'the run stopped' })
    // FACT: the ceiling stops it, not the no-progress check: files kept changing.
    expect(stops).toEqual(['max_steps_total'])
  }, 60_000)

  it('stops a run that reaches its ceiling', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nlimits:\n  max_steps_total: 3\n  loop_repeat_threshold: 99\n${PRICING}`,
      script: [
        { text: 'x', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'tick', arguments: '{"n":1}', id: 'c1' }] },
      ],
      repeatLast: true,
    })

    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    agent.ctx.tools.register(
      defineTool({
        name: 'tick',
        description: 'tick',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => 'tick',
      }),
    )

    // A distinct argument each call defeats loop detection, so the step limit is
    // what stops it.
    let counter = 0
    booted.boot.fake!.setScript(
      Array.from({ length: 40 }, () => ({
        text: 'x',
        usage: { inputTokens: 10, outputTokens: 0 },
        toolCalls: [{ name: 'tick', arguments: JSON.stringify({ n: ++counter }), id: `c${counter}` }],
      })),
    )

    const reasons: string[] = []
    booted.ctx.on('ops/run-stopped', ({ reason }) => reasons.push(reason))

    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'step limit')

    expect(reasons).toContain('max_steps_total')
    expect(booted.store.runs.recent(1)[0]?.status).toBe('limit_stopped')
  }, 45_000)

  it('applies the project\'s own step limit over ops.yaml\'s', async () => {
    const booted = await bootGovernor({
      projects: { alpha: { limits: { max_steps_total: 3 } } },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nlimits:\n  max_steps_total: 50\n  loop_repeat_threshold: 99\n${PRICING}`,
      script: [{ text: 'x', usage: { inputTokens: 10, outputTokens: 0 } }],
      repeatLast: true,
    })
    expect(booted.projects.configOf('alpha')?.limits).toMatchObject({ max_steps_total: 3, loop_repeat_threshold: 99 })
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await booted.projects.ensureAgent('alpha')
    agent.ctx.tools.register(defineTool({ name: 'tick', description: 'tick', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: async () => 'tick' }))
    let counter = 0
    booted.boot.fake!.setScript(
      Array.from({ length: 40 }, () => ({ text: 'x', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'tick', arguments: JSON.stringify({ n: ++counter }), id: `c${counter}` }] })),
    )
    const details: string[] = []
    booted.ctx.on('ops/run-stopped', ({ detail }) => details.push(detail))
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'step limit')
    // FACT: before 0.6 the project's 3 was ignored and ops.yaml's 50 applied.
    expect(details).toContain('the run reached its ceiling of 3 steps')
  }, 45_000)
})

// ── overrides ──────────────────────────────────────────────────────────────

describe('overrides', () => {
  it('un-pauses a project and lets its queued request through', async () => {
    const booted = await bootGovernor({
      // The PROJECT scope is what trips: the global default stays generous, so
      // both the pause and its override are about `project:alpha`.
      projects: { alpha: { budget: { day_usd: 0, hard_action: 'pause' } } },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n  hard_action: pause\n${PRICING}`,
    })

    submit(booted, 'alpha')
    await waitFor(() => booted.store.projects.get('alpha')?.status === 'paused', {
      timeoutMs: 20_000,
      label: 'paused',
    })

    // The override is what makes `/budget` able to resume the project.
    booted.governor.override('project:alpha', { addUsd: 1 })
    await waitFor(() => booted.store.projects.get('alpha')?.status === 'active', { label: 'unpaused' })

    submit(booted, 'alpha', 'after override')
    await waitIdle(booted, 'ran after override')
    await waitFor(() => booted.store.runs.recent(1)[0]?.status === 'completed', {
      timeoutMs: 20_000,
      label: 'completed after override',
    })
  }, 45_000)

  it('records the override in the audit log', async () => {
    const booted = await bootGovernor({ projects: { alpha: {} } })
    booted.governor.override('project:alpha', { addUsd: 5, untilMs: Date.now() + 60_000 })
    const audit = booted.store.audit.byAction('budget.override')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.target).toBe('project:alpha')
  }, 30_000)

  it('raises the effective limit', async () => {
    const booted = await bootGovernor({
      // The project's OWN budget is the one the override raises. Relying on the
      // global default here would have asserted on a scope the override never
      // touched.
      projects: { alpha: { budget: { day_usd: 0.001, hard_action: 'reject_new' } } },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nbudgets:\n  default_day_usd: 100\n  hard_action: reject_new\n${PRICING}`,
      script: [{ text: 'x', usage: { inputTokens: 5000, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha')
    await waitIdle(booted, 'first')
    const before = booted.governor.budgetState('project:alpha')
    expect(before.level).toBe('hard')

    booted.governor.override('project:alpha', { addUsd: 1 })
    const after = booted.governor.budgetState('project:alpha')
    // Still soft (the spend is unchanged) but no longer hard.
    expect(after.level).not.toBe('hard')
    expect(after.limitMicros).toBeGreaterThan(before.limitMicros ?? 0)
  }, 40_000)
})

// ── budget thresholds ──────────────────────────────────────────────────────

describe('budget thresholds', () => {
  it('emits each level once per scope per period', async () => {
    const booted = await bootGovernor({
      // The thresholds are asserted on `project:alpha`, so the project carries
      // them; the global default stays out of the way.
      projects: { alpha: { budget: { day_usd: 0.01, info_pct: 10, soft_pct: 20, hard_action: 'reject_new' } } },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\n` +
        `budgets:\n  default_day_usd: 100\n  hard_action: reject_new\n${PRICING}`,
      // 12 000 micro-USD of a 10 000 budget: past every threshold, including the
      // hard limit, so all three levels are announced in one evaluation.
      script: [{ text: 'x', usage: { inputTokens: 12_000, outputTokens: 0 } }],
      repeatLast: true,
    })

    const levels: Array<{ scope: string; period: string; level: string }> = []
    booted.ctx.on('ops/budget-threshold', ({ scope, period, level }) => levels.push({ scope, period, level }))

    submit(booted, 'alpha')
    await waitIdle(booted, 'done')

    // Info, soft and hard, each once, for the project and the global scope.
    const project = levels.filter((entry) => entry.scope === 'project:alpha')
    expect(project.map((entry) => entry.level)).toEqual(['info', 'soft', 'hard'])
    expect(new Set(project.map((entry) => entry.period))).toEqual(new Set(['day']))

    // A second request must not re-announce.
    const before = levels.length
    submit(booted, 'alpha', 'again')
    await waitIdle(booted, 'second done')
    expect(levels.length).toBe(before)
  }, 45_000)
})

// ── startup recovery ───────────────────────────────────────────────────────

describe('startup recovery', () => {
  it('marks a run left running as interrupted', async () => {
    const booted = await bootGovernor({ projects: { alpha: {} } })
    // Simulate a crash: a run row left in `running` with no live agent.
    const now = Date.now()
    booted.store.runs.start(
      {
        id: 'crashed-run',
        inbound_id: null,
        project_id: 'alpha',
        owner_key: 'project:alpha',
        session_id: 'dead-session',
        provider: 'fake',
        model: 'fake-model',
      },
      now,
    )
    expect(booted.store.runs.get('crashed-run')?.status).toBe('running')

    const events: string[] = []
    booted.ctx.on('ops/run-interrupted', ({ runId }) => events.push(runId))
    const recovery = booted.governor.recover()

    expect(recovery.interrupted).toBe(1)
    expect(events).toEqual(['crashed-run'])
    expect(booted.store.runs.get('crashed-run')?.status).toBe('interrupted')
    expect(booted.store.runs.get('crashed-run')?.stop_reason).toBe('crash')
  }, 30_000)

  it('dispatches requests that were pending at the crash', async () => {
    const first = await bootGovernor({ projects: { alpha: {} } })
    const dataDir = first.dataDir
    // A pending request with no agent to run it, as a crash mid-queue leaves.
    first.store.inbound.insert(
      {
        id: 'orphan-request',
        source: 'channel',
        project_id: 'alpha',
        payload: JSON.stringify({ v: 1, content: [{ type: 'text', text: 'do it' }] }),
        priority: 0,
      },
      Date.now(),
    )
    await first.meter.stop()
    await first.boot.dispose()

    const second = await bootGovernor({ dataDir, projects: { alpha: {} } })
    await waitFor(() => second.store.inbound.get('orphan-request')?.status === 'done', {
      timeoutMs: 20_000,
      label: 'orphan dispatched',
    })
  }, 45_000)
})

// ── edge cases the prompt names ────────────────────────────────────────────

describe('edge cases', () => {
  it('handles many submissions in the same tick', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {}, beta: {}, gamma: {}, delta: {}, epsilon: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nconcurrency:\n  global_max_running: 2\n${PRICING}`,
      script: [{ text: 'fast', usage: { inputTokens: 10, outputTokens: 0 } }],
      repeatLast: true,
    })

    // Five submissions before any dispatch pass can run.
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((projectId) => submit(booted, projectId))
    expect(new Set(ids).size).toBe(5)

    await waitFor(
      () => ids.every((id) => booted.store.inbound.get(id)?.status === 'done'),
      { timeoutMs: 25_000, label: 'all five done' },
    )
    expect(booted.store.runs.recent(10).filter((run) => run.status === 'completed')).toHaveLength(5)
  }, 45_000)

  it('never runs more than the limit, even under a burst', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {}, beta: {}, gamma: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nconcurrency:\n  global_max_running: 2\n${PRICING}`,
      script: [{ text: 'slow', latencyMs: 200, usage: { inputTokens: 10, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha')
    submit(booted, 'beta')
    submit(booted, 'gamma')

    // Sample the running count while the burst drains.
    let peak = 0
    for (let index = 0; index < 40; index += 1) {
      peak = Math.max(peak, booted.governor.status().running.length)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // Two concurrent passes could each read a free slot and both take it, which
    // is how a limit silently becomes double.
    expect(peak).toBeLessThanOrEqual(2)

    await waitFor(() => booted.governor.status().running.length === 0, { timeoutMs: 20_000, label: 'drained' })
    expect(booted.store.inbound.pendingCount()).toBe(0)
  }, 45_000)

  it('admits interactive work immediately and queues background work behind it', async () => {
    const booted = await bootGovernor({
      projects: { alpha: {}, beta: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\nconcurrency:\n  global_max_running: 1\n  reserve_interactive: 0\n${PRICING}`,
      script: [{ text: 'slow', latencyMs: 300, usage: { inputTokens: 10, outputTokens: 0 } }],
      repeatLast: true,
    })

    submit(booted, 'alpha', 'background', 2)
    await waitFor(() => booted.governor.status().running.length === 1, { label: 'background running' })
    submit(booted, 'beta', 'interactive', 0)

    // With one slot and a background job holding it, the interactive request
    // waits — priority orders the QUEUE, it does not preempt a running turn.
    await waitFor(() => booted.governor.status().pending.length === 1, { label: 'interactive queued' })
    await waitIdle(booted, 'drained')
  }, 45_000)

  it('rejects a request for an unknown project', async () => {
    const booted = await bootGovernor({ projects: { alpha: {} } })
    const rejected: string[] = []
    booted.ctx.on('ops/request-rejected', ({ code }) => rejected.push(code))
    submit(booted, 'ghost')
    await waitFor(() => rejected.length > 0, { timeoutMs: 20_000, label: 'rejected' })
    expect(rejected[0]).toBe('PROJECT_NOT_FOUND')
  }, 30_000)

  it('rejects an unpriced model before calling a provider', async () => {
    // The `fake/*` glob prices every fake model, so this test needs a provider
    // with NO entry at all — which is the case a new provider actually produces.
    const booted = await bootGovernor({
      projects: { alpha: { provider: 'unpriced-provider', model: 'unlisted' } },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\n${PRICING}`,
    })
    const rejected: string[] = []
    booted.ctx.on('ops/request-rejected', ({ code }) => rejected.push(code))

    submit(booted, 'alpha')
    await waitFor(() => rejected.length > 0, { timeoutMs: 20_000, label: 'rejected' })
    // The price check makes the project invalid at configuration time, so the
    // request is refused as such, with the reason ("has no price").
    expect(rejected[0]).toBe('PROJECT_INVALID')
    // FACT: the provider was never called, so nothing was spent discovering the
    // gap — which is the whole point of `block`.
    expect(booted.boot.fake?.callCount ?? 0).toBe(0)
  }, 30_000)

  it('reports status with slots, budgets and the queue', async () => {
    const booted = await bootGovernor({ projects: { alpha: {} } })
    submit(booted, 'alpha')
    await waitFor(() => booted.store.runs.recent(1).length > 0, { timeoutMs: 20_000, label: 'ran' })
    await waitFor(() => booted.governor.status().running.length === 0, { timeoutMs: 20_000, label: 'idle' })

    const status = booted.governor.status()
    expect(status.panic).toBe(false)
    expect(status.slots.globalLimit).toBeGreaterThan(0)
    expect(status.budgets.map((budget) => budget.scope)).toContain('global')
    expect(status.budgets.map((budget) => budget.scope)).toContain('project:alpha')
  }, 30_000)
})

// ── the no-bypass rule ─────────────────────────────────────────────────────

describe('the loop check', () => {
  /**
   * A project that ticks `ticks` times with a new argument each, then answers: only the
   * limits and the loop check stop it. Requests to `fake/judge-model` are the checker's,
   * answered by `answer`.
   */
  async function checked(limits: string, answer: (call: number) => string, options: { ticks?: number; model?: boolean } = {}): Promise<{ booted: Booted; facts: string[]; verdicts: Array<{ verdict: string; onLoop?: string; failures?: number }>; stops: string[] }> {
    const booted = await bootGovernor({
      projects: { alpha: {} },
      opsYaml: `timezone: UTC\ndata_dir: ${JSON.stringify('PLACEHOLDER')}\n${options.model === false ? '' : 'judge:\n  model: fake/judge-model\n'}limits:\n  loop_repeat_threshold: 99\n  stall_steps: 0\n${limits}${PRICING}`,
    })
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    ;(await booted.projects.ensureAgent('alpha')).ctx.tools.register(
      defineTool({ name: 'tick', description: 'tick', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: async () => 'tick' }),
    )
    const facts: string[] = []
    let agentCalls = 0
    booted.boot.fake!.setScript((request) => {
      if (request.model === 'judge-model') {
        facts.push(request.lastUserText)
        return { text: answer(facts.length), usage: { inputTokens: 500, outputTokens: 20 } }
      }
      if (agentCalls >= (options.ticks ?? Infinity)) return { text: 'done', usage: { inputTokens: 10, outputTokens: 0 } }
      agentCalls += 1
      return { text: 'all done, it works now', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: 'tick', arguments: JSON.stringify({ n: agentCalls }), id: `c${agentCalls}` }] }
    })
    const verdicts: Array<{ verdict: string; onLoop?: string; failures?: number }> = []
    booted.ctx.on('ops/judge-verdict', ({ verdict, onLoop, failures }) => verdicts.push({ verdict, ...(onLoop === undefined ? {} : { onLoop }), ...(failures === undefined ? {} : { failures }) }))
    const stops: string[] = []
    booted.ctx.on('ops/run-stopped', ({ reason, detail }) => stops.push(`${reason}: ${detail}`))
    return { booted, facts, verdicts, stops }
  }
  const LOOP = '{"verdict":"loop","reason":"it repeats itself"}'
  const PROGRESS = '{"verdict":"progress","reason":"new results each step"}'

  it('reads the run every loop_check_steps steps from what code measured, and progress lets it finish', async () => {
    const { booted, facts, verdicts, stops } = await checked('  loop_check_steps: 3\n', () => PROGRESS, { ticks: 7 })
    submit(booted, 'alpha', 'make the tests pass')
    await waitIdle(booted, 'the run')
    expect(stops).toEqual([])
    expect(verdicts).toEqual([{ verdict: 'progress' }, { verdict: 'progress' }])
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'completed', steps: 8 })
    // The facts are code's: the request verbatim, the counts, the agent's words fenced as data.
    expect(facts[0]).toContain('> make the tests pass')
    expect(facts[0]).toContain('Steps so far: 3.')
    expect(facts[0]).toMatch(/Last 3 step\(s\): 3 new result\(s\), 0 repeated, 0 tool error\(s\)/)
    expect(facts[0]).toContain('<<<AGENT_MESSAGE\nall done, it works now\nAGENT_MESSAGE>>>')
    expect(facts[1]).toContain('Steps so far: 6.')
    expect(facts[1]).toMatch(/Last 3 step\(s\)/)
    // Its requests are the run's: audited, and counted in the run's cost.
    expect(booted.store.audit.recent(50).filter((row) => row.action === 'judge.verdict')).toHaveLength(2)
    await booted.meter.flush()
    expect(booted.store.usage.totalsByRun(booted.store.runs.recent(1)[0]!.id).input_tokens).toBeGreaterThanOrEqual(2 * 500)
  }, 45_000)

  it('without a model, there is no loop check', async () => {
    const { booted, facts, stops } = await checked('  loop_check_steps: 3\n', () => LOOP, { ticks: 7, model: false })
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'the run')
    expect(facts).toEqual([])
    expect(stops).toEqual([])
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'completed' })
  }, 45_000)

  it('on_loop stop: a loop stops the run, without asking anyone', async () => {
    const { booted, verdicts, stops } = await checked('  loop_check_steps: 3\n  on_loop: stop\n', () => LOOP)
    let asked = false
    booted.governor.setCheckpointAsker(async () => {
      asked = true
      return { kind: 'continue' }
    })
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'stopped by the loop check')
    expect(stops).toEqual(['loop_checked: the loop checker found a loop: it repeats itself'])
    expect(verdicts).toEqual([{ verdict: 'loop', onLoop: 'stop' }])
    expect(asked).toBe(false)
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'limit_stopped', steps: 3 })
  }, 45_000)

  it('on_loop notify: a loop is reported and the run goes on', async () => {
    const { booted, verdicts, stops } = await checked('  loop_check_steps: 3\n  on_loop: notify\n', () => LOOP, { ticks: 7 })
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'the run')
    expect(stops).toEqual([])
    expect(verdicts).toEqual([{ verdict: 'loop', onLoop: 'notify' }, { verdict: 'loop', onLoop: 'notify' }])
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'completed', steps: 8 })
  }, 45_000)

  it('on_loop ask: waits for the answer; Continue goes on, Stop stops', async () => {
    const { booted, stops } = await checked('  loop_check_steps: 3\n  on_loop: ask\n', () => LOOP)
    const asked: Array<{ steps: number; reason: string }> = []
    booted.governor.setCheckpointAsker(async ({ steps, reason }) => {
      asked.push({ steps, reason })
      return asked.length === 1 ? { kind: 'continue' } : { kind: 'stop', detail: 'stopped by test' }
    })
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'stopped at the second question')
    expect(asked).toEqual([{ steps: 3, reason: 'it repeats itself' }, { steps: 6, reason: 'it repeats itself' }])
    expect(stops).toEqual(['loop_checked: the loop checker found a loop (it repeats itself): stopped by test'])
  }, 45_000)

  it('on_loop ask: stops when nobody can be asked', async () => {
    const nobody = await checked('  loop_check_steps: 2\n  on_loop: ask\n', () => LOOP)
    submit(nobody.booted, 'alpha', 'go')
    await waitIdle(nobody.booted, 'stopped')
    expect(nobody.stops).toEqual(['loop_checked: the loop checker found a loop (it repeats itself), and nobody can be asked whether it goes on'])
  }, 45_000)

  it('on_loop ask: stops when the question fails', async () => {
    const { booted, stops } = await checked('  loop_check_steps: 2\n  on_loop: ask\n', () => LOOP)
    booted.governor.setCheckpointAsker(async () => {
      throw new Error('no chat')
    })
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'stopped')
    expect(stops).toEqual(['loop_checked: the loop checker found a loop (it repeats itself): the question could not be asked'])
  }, 45_000)

  it('on_loop ask: stops a run stopped while it waits', async () => {
    const { booted, stops } = await checked('  loop_check_steps: 2\n  on_loop: ask\n', () => LOOP)
    let asked = false
    let aborted = false
    booted.governor.setCheckpointAsker((_question, signal) => {
      asked = true
      signal.addEventListener('abort', () => (aborted = true))
      return new Promise(() => undefined)
    })
    submit(booted, 'alpha', 'go')
    await waitFor(() => asked, { timeoutMs: 20_000, label: 'the question asked' })
    expect(booted.governor.status().running[0]?.checkpoint).toMatchObject({ steps: 2, reason: 'it repeats itself' })
    expect(booted.governor.stop({ projectId: 'alpha' })).toBe(true)
    await waitIdle(booted, 'stopped while waiting')
    expect(stops).toEqual(['loop_checked: the loop checker found a loop (it repeats itself): it was stopped while it waited'])
    expect(aborted).toBe(true)
  }, 45_000)

  it('an answer that is not a verdict decides nothing: the run goes on, and the failures are counted', async () => {
    const { booted, verdicts, stops } = await checked('  loop_check_steps: 2\n  on_loop: stop\n', () => 'Sure! Keep going, it looks great.', { ticks: 7 })
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'the run')
    expect(stops).toEqual([])
    expect(verdicts).toEqual([1, 2, 3].map((failures) => ({ verdict: 'invalid', failures })))
    expect(booted.store.runs.recent(1)[0]).toMatchObject({ status: 'completed' })
  }, 45_000)

  it('never takes a run past its ceiling, whatever it answers', async () => {
    const { booted, stops } = await checked('  loop_check_steps: 3\n  max_steps_total: 8\n', () => PROGRESS)
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'stopped at the ceiling')
    expect(stops).toEqual(['max_steps_total: the run reached its ceiling of 8 steps'])
    expect(booted.store.runs.recent(1)[0]?.steps).toBe(8)
  }, 45_000)
})

describe('long runs, with the default limits', () => {
  /** One scripted step: the tool, its arguments, what it answers and whether it writes a file. */
  interface Step {
    readonly tool: string
    readonly args: string
    readonly result: string
    readonly writes?: boolean
  }

  /**
   * Run a project through the real governor with ops.yaml's defaults (threshold 5,
   * stall 25, ceiling 1000, no loop check). The model calls `script(n)` at its n-th
   * request, or finishes when it returns undefined. Nobody is there to answer a question.
   */
  async function longRun(script: (n: number) => Step | undefined): Promise<{ status: string | undefined; steps: number | undefined; stops: string[] }> {
    const booted = await bootGovernor({ projects: { alpha: {} } })
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const { writeFileSync: write } = await import('node:fs')
    const cwd = booted.projects.configOf('alpha')!.cwd
    const agent = await booted.projects.ensureAgent('alpha')
    let pending: Step | undefined
    let files = 0
    for (const tool of ['read', 'edit', 'test', 'grep', 'ls']) {
      agent.ctx.tools.register(
        defineTool({ name: tool, description: tool, parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: async () => {
          if (pending?.writes === true) write(join(cwd, `out-${files++}.txt`), 'x')
          return pending?.result ?? ''
        } }),
      )
    }
    let calls = 0
    booted.boot.fake!.setScript(() => {
      calls += 1
      pending = script(calls)
      return pending === undefined
        ? { text: 'done', usage: { inputTokens: 10, outputTokens: 0 } }
        : { text: 'x', usage: { inputTokens: 10, outputTokens: 0 }, toolCalls: [{ name: pending.tool, arguments: pending.args, id: `c${calls}` }] }
    })
    const stops: string[] = []
    booted.ctx.on('ops/run-stopped', ({ reason, detail }) => stops.push(`${reason}: ${detail}`))
    submit(booted, 'alpha', 'go')
    await waitIdle(booted, 'the long run')
    const run = booted.store.runs.recent(1)[0]
    return { status: run?.status, steps: run?.steps, stops }
  }

  const same = (tool: string, args: object, result: string): Step => ({ tool, args: JSON.stringify(args), result })

  it('1. the same call with the same result stops at the threshold', async () => {
    const run = await longRun(() => same('test', { cmd: 'npm test' }, 'FAIL login.test.ts: 3 failed'))
    expect(run.stops).toEqual(['loop_detected: "test" gave the same result 5 times in a row, with the same arguments'])
    expect(run.steps).toBe(5)
  }, 60_000)

  it('2. the same call with a new result each time is progress', async () => {
    const run = await longRun((n) => (n <= 80 ? same('test', { cmd: 'npm test' }, `${80 - n} failed`) : undefined))
    expect(run.stops).toEqual([])
    expect(run).toMatchObject({ status: 'completed', steps: 81 })
  }, 60_000)

  it('3. a cycle of two calls stops', async () => {
    const run = await longRun((n) => (n % 2 === 1 ? same('read', { path: 'a.ts' }, 'const a = 1') : same('edit', { path: 'a.ts', text: 'const a = 1' }, 'no change')))
    expect(run.stops).toEqual(['loop_detected: a cycle of 2 calls (read, edit) repeated 5 times with the same results'])
    expect(run.steps).toBe(10)
  }, 60_000)

  it('4. a cycle of three calls stops', async () => {
    const cycle = [same('read', { path: 'a.ts' }, 'x'), same('edit', { path: 'a.ts' }, 'ok'), same('test', {}, '1 failed')]
    const run = await longRun((n) => cycle[(n - 1) % 3])
    expect(run.stops).toEqual(['loop_detected: a cycle of 3 calls (read, edit, test) repeated 5 times with the same results'])
    expect(run.steps).toBe(15)
  }, 60_000)

  it('5. A-B-A-C is no loop, but brings nothing new: stalled', async () => {
    const cycle = [same('read', { path: 'a.ts' }, 'x'), same('edit', { path: 'a.ts' }, 'ok'), same('read', { path: 'a.ts' }, 'x'), same('test', {}, '1 failed')]
    const run = await longRun((n) => cycle[(n - 1) % 4])
    // The last new result is step 4 (the first test); 25 repeats follow.
    expect(run.stops).toEqual(['stalled: 25 steps in a row with no new result and no file changed'])
    expect(run.steps).toBe(29)
  }, 60_000)

  it('6. arguments in another key order are the same call', async () => {
    const run = await longRun((n) => ({ tool: 'grep', args: n % 2 === 0 ? '{"pattern":"TODO","path":"src"}' : '{"path":"src","pattern":"TODO"}', result: 'src/a.ts:3: TODO' }))
    expect(run.stops).toEqual(['loop_detected: "grep" gave the same result 5 times in a row, with the same arguments'])
    expect(run.steps).toBe(5)
  }, 60_000)

  it('7. results that differ only by the clock, a duration or a pid are the same result', async () => {
    const run = await longRun((n) => same('test', { cmd: 'npm test' }, `2026-10-19T10:00:${String(n).padStart(2, '0')}Z pid ${4000 + n}: 3 failed in ${100 + n}ms`))
    expect(run.stops).toEqual(['loop_detected: "test" gave the same result 5 times in a row, with the same arguments'])
    expect(run.steps).toBe(5)
  }, 60_000)

  it('8. varied calls that bring nothing new and change no file stop as stalled', async () => {
    const run = await longRun((n) => same('ls', { path: `dir-${n % 5}` }, 'empty'))
    expect(run.stops).toEqual(['stalled: 25 steps in a row with no new result and no file changed'])
    expect(run.steps).toBe(30)
  }, 60_000)

  it('9. the same answers while every step writes a file is work: no stall', async () => {
    const run = await longRun((n) => (n <= 80 ? { ...same('edit', { path: `dir-${n % 5}` }, 'written'), writes: true } : undefined))
    expect(run.stops).toEqual([])
    expect(run).toMatchObject({ status: 'completed', steps: 81 })
  }, 60_000)

  it('10. long work with new results is never cut off, and nobody is asked anything', async () => {
    const run = await longRun((n) => (n <= 150 ? same('test', { cmd: 'npm test' }, `${150 - n} failed`) : undefined))
    expect(run.stops).toEqual([])
    expect(run).toMatchObject({ status: 'completed', steps: 151 })
  }, 60_000)
})

describe('ADR 0002: no execution path bypasses submit', () => {
  it('calls opsProjects.deliver only from ops-governor', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')

    /** Every TypeScript source file under a directory. */
    function sources(dir: string): string[] {
      const found: string[] = []
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'lib' || entry === 'dist') continue
        const full = joinPath(dir, entry)
        if (statSync(full).isDirectory()) found.push(...sources(full))
        else if (entry.endsWith('.ts')) found.push(full)
      }
      return found
    }

    const violations: string[] = []
    for (const file of sources(joinPath(process.cwd(), 'packages'))) {
      // Tests exercise the primitive directly, which is how the capability is
      // proven to work; they are not production execution paths.
      if (file.includes('/test/')) continue
      const text = readFileSync(file, 'utf8')
      // `opsProjects.deliver(` specifically: `channel.deliver(...)` is a
      // different method on a different service, and matching it would flag a
      // doc-comment example in `ops-types`.
      if (!/opsProjects\.deliver\s*\(|ctx\.opsProjects\.deliver\s*\(/.test(text)) continue
      // The governor and the package that OWNS the method are allowed.
      if (file.includes('ops-governor/')) continue
      if (file.includes('ops-projects/src/')) continue
      violations.push(file)
    }

    // FACT: ADR 0002 is enforced by the capability token, but a grep is what
    // catches a future plugin that tries to call it and would be surprised.
    expect(violations).toEqual([])
  })
})

// ── ask_project ────────────────────────────────────────────────────────────

describe('ask_project', () => {
  it('runs the other project through the governor and hands its answer back; the answerer cannot ask back', async () => {
    const usage = { inputTokens: 100, outputTokens: 0 }
    const booted = await bootGovernor({
      projects: { alpha: { tools: { agents: 'allow' } }, beta: { tools: { agents: 'allow' } } },
      script: [
        // alpha asks beta
        { text: 'asking', toolCalls: [{ name: 'ask_project', arguments: '{"project":"beta","question":"What is the build command?"}', id: 'a1' }], usage },
        // beta tries to ask alpha back, is refused, then answers
        { text: 'checking', toolCalls: [{ name: 'ask_project', arguments: '{"project":"alpha","question":"loop?"}', id: 'b1' }], usage },
        { text: 'npm run build', usage },
        // alpha finishes with the answer in hand
        { text: 'done', usage },
      ],
      repeatLast: true,
    })
    const outputs: string[] = []
    const results: string[] = []
    booted.ctx.on('tools/result' as never, ((exec: { name: string }, result: unknown) => void results.push(`${exec.name} ${JSON.stringify(result)}`)) as never)
    booted.ctx.on('ops/run-output', ({ owner }) => void outputs.push(owner.kind === 'project' ? owner.projectId : owner.kind))
    booted.governor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })
    await waitFor(() => booted.store.runs.recent(5).length === 2 && booted.governor.status().running.length === 0, { timeoutMs: 30_000, label: 'both runs ended' })

    const beta = booted.store.runs.byOwner('project:beta', 5)[0]
    expect(beta?.status).toBe('completed')
    expect(booted.store.inbound.get(beta?.id as string)?.source).toBe('project')
    const toolResults = JSON.stringify(booted.store.audit.byTarget('beta'))
    expect(toolResults).toContain('project.asked')
    // What the tools returned: beta's refusal to ask back, then beta's answer to alpha.
    expect(results).toHaveLength(2)
    expect(results[0]).toContain('cannot ask one yourself')
    expect(results[1]).toContain('beta answers')
    expect(results[1]).toContain('npm run build')
    expect(JSON.stringify(booted.boot.fake?.requests)).toContain('Project alpha asks')
    expect(outputs.sort()).toEqual(['alpha', 'beta'])
  }, 40_000)
})

describe('the steps of an agent an extension runs for a project', () => {
  /** A governed run of `site`, as the governor keeps one, without starting an agent. */
  function governedRun(booted: Booted, runId: string): { pendingStop: unknown } {
    const track = {
      runId,
      owner: { kind: 'project', projectId: 'site' },
      sessionId: `session-${runId}`,
      provider: 'fake',
      model: { provider: 'fake', model: 'fake-model' },
      startedAt: Date.now(),
      steps: 0,
      recentToolCalls: [],
      pendingCalls: new Map(),
      seenSteps: new Set(),
      sinceNew: 0,
      lastTree: undefined,
      stallCheck: undefined,
      stalled: undefined,
      lastToolCall: undefined,
      pendingStop: undefined,
      downgradeAudited: false,
      requestId: undefined,
    }
    ;(booted.governor as unknown as { running: Map<string, unknown> }).running.set(track.sessionId, track)
    return track
  }

  it('stops it when its steps loop, says why, and lets steps with new results go on; outside a governed run it goes on', async () => {
    const booted = await bootGovernor({ projects: { site: { limits: { loop_repeat_threshold: 3 } } } })
    governedRun(booted, 'run-del')
    const steps: unknown[] = []
    const stops: unknown[] = []
    booted.ctx.on('ops/delegated-step', (payload) => void steps.push(payload))
    booted.ctx.on('ops/delegated-stop', (payload) => void stops.push(payload))
    const step = (result: string, runId = 'run-del') => booted.governor.delegatedStep({ projectId: 'site', server: 'cc', runId, message: { tool: 'Bash', arguments: { command: 'npm test' }, ok: false, result } })

    // The same test, failing differently each time: progress.
    expect(step('1 failing')).toEqual({ continue: true })
    expect(step('2 failing')).toEqual({ continue: true })
    expect(step('3 failing')).toEqual({ continue: true })
    // The same result three times in a row: a loop.
    expect(step('3 failing')).toEqual({ continue: true })
    const looped = step('3 failing')
    expect(looped.continue).toBe(false)
    expect(looped.reason).toContain('"cc:Bash" gave the same result 3 times')
    expect(stops).toEqual([expect.objectContaining({ projectId: 'site', runId: 'run-del', server: 'cc', reason: 'loop_detected' })])
    expect(steps).toHaveLength(5)
    expect(steps[4]).toMatchObject({ tool: 'Bash', ok: false, steps: 5 })
    // Its history starts again: one more step is not a loop.
    expect(step('3 failing')).toEqual({ continue: true })
    // They do not count toward the run's own steps.
    expect((booted.governor as unknown as { running: Map<string, { steps: number }> }).running.get('session-run-del')?.steps).toBe(0)
    expect(step('x', 'run-unknown')).toEqual({ continue: true })
  }, 30_000)

  it('records its turns on a subscription at no cost, priced beside, and stops it past the day’s turns', async () => {
    const booted = await bootGovernor({ projects: { site: { delegate: { day_turns: 2 } } } })
    governedRun(booted, 'run-use')
    const stops: unknown[] = []
    booted.ctx.on('ops/delegated-stop', (payload) => void stops.push(payload))
    // 100 × $3 + 50 × $0.30 + 20 × $15 per million tokens: 615 micro-USD a turn.
    const usage = () => booted.governor.delegatedUsage({ projectId: 'site', server: 'cc', runId: 'run-use', message: { model: 'claude-sonnet-x', input_tokens: 100, cached_tokens: 50, output_tokens: 20 } })
    expect(usage()).toEqual({ continue: true })
    const second = usage()
    expect(second.continue).toBe(false)
    expect(second.reason).toContain('2 turns for today (delegate.day_turns)')
    expect(stops).toEqual([expect.objectContaining({ reason: 'day_limit', server: 'cc' })])
    expect(booted.meter.spending('project:site').dayMicros).toBe(0)
    expect(booted.meter.notional('project:site', Date.now()).dayMicros).toBe(1_230)
    expect(booted.meter.runTotals('run-use')).toMatchObject({ inputTokens: 200, outputTokens: 40 })
    // Its steps show in the run's status.
    booted.governor.delegatedStep({ projectId: 'site', server: 'cc', runId: 'run-use', message: { tool: 'Edit', arguments: {}, ok: true, result: 'ok' } })
    expect(booted.governor.status().running.find((run) => run.runId === 'run-use')?.delegated).toEqual({ steps: 1, server: 'cc', tool: 'Edit', ok: true })
    expect(() => booted.projects.hostHandle('usage', () => ({}))).toThrow(/already answered/)
  }, 30_000)

  it('charges its turns on the API against the budget, at the catalog’s price', async () => {
    const booted = await bootGovernor({ projects: { site: { delegate: { backend: 'api' } } } })
    governedRun(booted, 'run-api')
    expect(booted.governor.delegatedUsage({ projectId: 'site', server: 'cc', runId: 'run-api', message: { model: 'claude-sonnet-x', input_tokens: 100, cached_tokens: 50, output_tokens: 20 } })).toEqual({ continue: true })
    expect(booted.meter.spending('project:site').dayMicros).toBe(615)
    expect(booted.meter.notional('project:site', Date.now()).dayMicros).toBe(0)
  }, 30_000)

  it('stops it while the run is stopping, and answers step on the host channel', async () => {
    const booted = await bootGovernor({ projects: { site: {} } })
    const track = governedRun(booted, 'run-stop')
    track.pendingStop = { reason: 'max_steps_total', detail: 'the run reached its ceiling of 10 steps' }
    expect(booted.governor.delegatedStep({ projectId: 'site', server: 'cc', runId: 'run-stop', message: { tool: 'Read', arguments: {}, ok: true, result: 'x' } })).toEqual({ continue: false, reason: 'the run is stopping: the run reached its ceiling of 10 steps' })
    expect(() => booted.projects.hostHandle('step', () => ({}))).toThrow(/already answered/)
  }, 30_000)
})
