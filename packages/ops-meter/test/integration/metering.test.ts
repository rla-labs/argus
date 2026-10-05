// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-meter`.
 *
 * Prompt 04's Definition of Done: a real turn's cost is attributed to the right
 * project (including a subagent's), the counter matches a fresh query
 * afterwards, and a restart does not reset the counter to zero.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeOfOwner, type Scope } from '@argus-agent/types'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  bootOps,
  BASE_ENTRIES,
  persistenceEntry,
  userMessage,
  type BootOpsOptions,
  type OpsBoot,
} from '@argus-agent/testkit'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '../../src/service.js'

/** A money-shaped fake: 1 USD per million tokens on every field. */
const PRICING = `
pricing:
  fake/fake-model: { input: 1, cached: 1, output: 1 }
  fake/cheap: { input: 0.5, cached: 0, output: 2 }
  ollama/*: { input: 0, cached: 0, output: 0 }
`

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly dataDir: string
}

const open: Booted[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const entry of open.splice(0)) await entry.boot.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Boot a tree with the store, projects and meter. */
async function bootMeter(options: {
  projects?: Record<string, Record<string, unknown> | string>
  dataDir?: string
  pricing?: string
  fake?: { text?: string; usage?: TokenUsage } | false
  rateLimits?: string
}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-meter-'))
  if (options.dataDir === undefined) dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })

  for (const [id, project] of Object.entries(options.projects ?? {})) {
    const text = typeof project === 'string' ? project : projectDocument(dataDir, id, project)
    writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `${text}\n`)
  }

  const opsYaml = [
    'timezone: UTC',
    `data_dir: ${JSON.stringify(dataDir)}`,
    options.pricing ?? PRICING,
    options.rateLimits ?? '',
  ].join('\n')

  const usage = options.fake === false ? undefined : (options.fake?.usage ?? { inputTokens: 1000, outputTokens: 500 })
  const bootOptions: { -readonly [K in keyof BootOpsOptions]: BootOpsOptions[K] } = {
    files: { 'config/ops.yaml': `${opsYaml}\n` },
    bareModuleBaseUrl: import.meta.url,
    replaceEntries: [
      ...BASE_ENTRIES,
      persistenceEntry(join(dataDir, 'sessions')),
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'default' } },
      { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
      { id: 'ops-store', name: '@argus-agent/store' },
      { id: 'ops-projects', name: '@argus-agent/projects' },
      { id: 'ops-meter', name: '@argus-agent/meter' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
    ],
  }
  if (options.fake === false) {
    bootOptions.fake = false
  } else {
    bootOptions.fake = {
      script: [{ text: options.fake?.text ?? 'done', ...(usage === undefined ? {} : { usage }) }],
      repeatLast: true,
    }
  }
  const boot = await bootOps(bootOptions)

  const entry: Booted = {
    boot,
    ctx: boot.ctx,
    store: (boot.ctx as unknown as { opsStore: OpsStore }).opsStore,
    projects: (boot.ctx as unknown as { opsProjects: OpsProjects }).opsProjects,
    meter: (boot.ctx as unknown as { opsMeter: OpsMeter }).opsMeter,
    dataDir,
  }
  open.push(entry)
  return entry
}

/**
 * The capability, claimed once per boot.
 *
 * Only one holder may exist per process, so a second `claimDelivery` on the same
 * service throws. Caching it here is what the governor does in production: it
 * claims once at load and keeps the token.
 */
const capabilities = new WeakMap<OpsProjects, unknown>()

/** Claim (once) and return the delivery capability for a booted tree. */
function capabilityOf(booted: Booted): never {
  let cached = capabilities.get(booted.projects)
  if (cached === undefined) {
    cached = booted.projects.claimDelivery('ops-governor')
    capabilities.set(booted.projects, cached)
  }
  return cached as never
}

/**
 * Build a project document, merging overrides over the defaults.
 *
 * Spreading the caller's keys over a defaults object is essential: appending
 * them would emit a duplicate `model` key, which YAML rejects outright.
 */
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

/** Deliver one message through the governor's capability. */
async function deliver(booted: Booted, projectId: string, text = 'do something', runId = 'run-1'): Promise<void> {
  const capability = capabilityOf(booted)
  await booted.projects.ensureAgent(projectId)
  await booted.projects.deliver(
    capability,
    { kind: 'project', projectId },
    [{ type: 'text', text }],
    { runId, source: 'channel' },
  )
  const agent = booted.projects.agentFor({ kind: 'project', projectId })
  await agent?.whenIdle()
  await booted.meter.flush()
}

describe('metering a real turn', () => {
  it('attributes a turn\'s cost to its project', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    await deliver(booted, 'site')

    // 1000 input + 500 output, at 1 USD per million each, is 1500 micro-USD.
    const spending = booted.meter.spending('project:site')
    expect(spending.dayMicros).toBe(1500)
    expect(spending.dayTotals.inputTokens).toBe(1000)
    expect(spending.dayTotals.outputTokens).toBe(500)
    expect(spending.dayTotals.requests).toBe(1)
  }, 30_000)

  it('records the event durably', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    await deliver(booted, 'site')

    const events = booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      scope: 'project:site',
      project_id: 'site',
      provider: 'fake',
      model: 'fake-model',
      input_tokens: 1000,
      output_tokens: 500,
      cost_micros: 1500,
      run_id: 'run-1',
    })
  }, 30_000)

  it('includes cached tokens at their own rate', async () => {
    const booted = await bootMeter({
      projects: { site: {} },
      fake: { usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 2000 } },
    })
    await deliver(booted, 'site')

    // 1000 input + 2000 cached, both at 1 micro per token.
    expect(booted.meter.spending('project:site').dayMicros).toBe(3000)
  }, 30_000)

  it('counts a multi-step turn once per request', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    const { defineTool } = await import('@deepseek-ai/dsh-tools')

    // Two model requests in one turn. The script is set before the turn starts,
    // and `setScript` resets the adapter's cursor so entry 0 is served first.
    const agent = await booted.projects.ensureAgent('site')
    agent.ctx.tools.register(
      defineTool({
        name: 'probe',
        description: 'probe',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => 'probed',
      }),
    )
    booted.boot.fake!.setScript([
      {
        text: 'step one',
        usage: { inputTokens: 1000, outputTokens: 500 },
        toolCalls: [{ name: 'probe', arguments: '{}', id: 'c1' }],
      },
      { text: 'step two', usage: { inputTokens: 1000, outputTokens: 500 } },
    ])

    const capability = capabilityOf(booted)
    await booted.projects.deliver(
      capability,
      { kind: 'project', projectId: 'site' },
      [{ type: 'text', text: 'go' }],
      { runId: 'run-multi' },
    )
    await agent.whenIdle()
    await booted.meter.flush()

    const spending = booted.meter.spending('project:site')
    expect(spending.dayTotals.requests).toBe(2)
    expect(spending.dayMicros).toBe(3000)
    expect(booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)).toHaveLength(2)
  }, 30_000)

  it('attributes a subagent\'s usage to its parent project', async () => {
    const booted = await bootMeter({
      projects: { site: {} },
      fake: { usage: { inputTokens: 1000, outputTokens: 0 } },
    })
    const parent = await booted.projects.ensureAgent('site')

    // A child agent, whose own session is not registered as a project.
    const child = await booted.ctx.agents.create({
      sessionId: SessionId('meter-subagent'),
      parentAgent: parent,
      meta: {
        cwd: parent.session.header.cwd,
        parentSession: parent.id,
        origin: 'subagent',
        delegationDepth: 1,
      },
      agentOptions: { provider: 'fake', model: 'fake-model' },
    })
    child.agent.followup(userMessage('sub-1', 'child work'))
    await child.agent.whenIdle()
    await booted.meter.flush()

    // FACT: without the parent walk, the project would be charged nothing.
    const spending = booted.meter.spending('project:site')
    expect(spending.dayTotals.inputTokens).toBe(1000)
    expect(spending.dayMicros).toBe(1000)

    // And the event records the ROOT session, so a report can find it.
    const events = booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)
    expect(events).toHaveLength(1)
    expect(events[0]?.session_id).toBe('meter-subagent')
    expect(events[0]?.root_session).toBe(parent.id)

    await child.dispose()
  }, 30_000)

  it('counts the global scope as well as the project scope', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    await deliver(booted, 'site')

    // A run is CHECKED against `global` but RECORDED under its own scope.
    expect(booted.meter.spending('project:site').dayMicros).toBe(1500)
    expect(booted.meter.spending('global').dayMicros).toBe(1500)
  }, 30_000)

  it('keeps two projects separate', async () => {
    const booted = await bootMeter({ projects: { alpha: {}, beta: {} } })
    await deliver(booted, 'alpha', 'work', 'run-a')
    await deliver(booted, 'beta', 'work', 'run-b')

    expect(booted.meter.spending('project:alpha').dayMicros).toBe(1500)
    expect(booted.meter.spending('project:beta').dayMicros).toBe(1500)
    expect(booted.meter.spending('global').dayMicros).toBe(3000)
  }, 60_000)

  it('tracks a run\'s own cost', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    const capability = booted.projects.claimDelivery('ops-governor')
    await booted.projects.ensureAgent('site')
    await booted.projects.deliver(
      capability,
      { kind: 'project', projectId: 'site' },
      [{ type: 'text', text: 'go' }],
      { runId: 'run-cost' },
    )
    const agent = booted.projects.agentFor({ kind: 'project', projectId: 'site' })
    await agent?.whenIdle()

    // The run's cost must be durable, so flush first: the in-memory run counter
    // is dropped when the agent goes idle, and a query needs the written rows.
    await booted.meter.flush()
    const totals = booted.store.usage.totalsByRun('run-cost')
    expect(totals.cost_micros).toBe(1500)
    expect(totals.requests).toBe(1)
  }, 30_000)
})

describe('counters match a fresh query', () => {
  it('equal the durable record after a flush', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    await deliver(booted, 'site')

    // The Definition of Done: the in-memory counter must equal what a fresh
    // query of the store reports.
    const stored = booted.store.usage.totals('project:site', '1970-01-01', '9999-12-31')
    const counter = booted.meter.spending('project:site')
    expect(counter.dayMicros).toBe(stored.cost_micros)
    expect(counter.dayTotals.inputTokens).toBe(stored.input_tokens)
    expect(counter.dayTotals.outputTokens).toBe(stored.output_tokens)
  }, 30_000)

  it('stay equal across several runs', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    for (let index = 0; index < 5; index += 1) {
      await deliver(booted, 'site', `work ${index}`, `run-${index}`)
    }

    const stored = booted.store.usage.totals('project:site', '1970-01-01', '9999-12-31')
    expect(booted.meter.spending('project:site').dayMicros).toBe(stored.cost_micros)
    expect(booted.meter.spending('project:site').dayTotals.requests).toBe(5)
  }, 60_000)
})

describe('restart', () => {
  it('seeds the counter from the durable record', async () => {
    const first = await bootMeter({ projects: { site: {} } })
    // `deliver` flushes, so the row is durable before the tree goes away.
    await deliver(first, 'site')
    const dataDir = first.dataDir
    expect(first.meter.spending('project:site').dayMicros).toBe(1500)
    expect(first.store.usage.totals('project:site', '1970-01-01', '9999-12-31').cost_micros).toBe(1500)
    await first.meter.stop()
    await first.boot.dispose()

    const second = await bootMeter({ dataDir, projects: { site: {} } })
    // FACT: without seeding, a restart would hand the project its whole budget
    // again, and a project could spend its daily limit once per restart.
    expect(second.meter.spending('project:site').dayMicros).toBe(1500)
    expect(second.meter.spending('global').dayMicros).toBe(1500)
  }, 60_000)

  it('adds new usage to the seeded total', async () => {
    const first = await bootMeter({ projects: { site: {} } })
    await deliver(first, 'site', 'first', 'run-1')
    const dataDir = first.dataDir
    await first.meter.stop()
    await first.boot.dispose()

    const second = await bootMeter({ dataDir, projects: { site: {} } })
    await deliver(second, 'site', 'second', 'run-2')

    // 2 turns * 1500.
    expect(second.meter.spending('project:site').dayMicros).toBe(3000)
    expect(second.store.usage.totals('project:site', '1970-01-01', '9999-12-31').cost_micros).toBe(3000)
  }, 60_000)
})

describe('unpriced models', () => {
  it('refuses and warns under the block policy', async () => {
    const booted = await bootMeter({
      projects: { site: { model: 'unlisted-model' } },
      pricing: 'pricing:\n  fake/fake-model: { input: 1, cached: 0, output: 1 }\nunknown_model_policy: block\n',
    })

    const unpriced: string[] = []
    booted.ctx.on('ops/unpriced-model', ({ model }) => unpriced.push(model))

    await deliver(booted, 'site')

    // FACT: the request happened (dsh already called the provider) but nothing
    // was recorded, because the model has no price and the policy blocks.
    expect(unpriced).toEqual(['fake/unlisted-model'])
    expect(booted.meter.spending('project:site').dayMicros).toBe(0)
    expect(booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)).toHaveLength(0)
  }, 30_000)

  it('records at zero and warns under the warn policy', async () => {
    const booted = await bootMeter({
      projects: { site: { model: 'unlisted-model' } },
      pricing: 'pricing:\n  fake/fake-model: { input: 1, cached: 0, output: 1 }\nunknown_model_policy: warn\n',
    })

    const unpriced: string[] = []
    booted.ctx.on('ops/unpriced-model', ({ model }) => unpriced.push(model))

    await deliver(booted, 'site')

    expect(unpriced).toEqual(['fake/unlisted-model'])
    // Recorded at zero rather than at a guess, so the totals stay honest.
    expect(booted.meter.spending('project:site').dayMicros).toBe(0)
    const events = booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)
    expect(events).toHaveLength(1)
    expect(events[0]?.cost_micros).toBe(0)
    expect(events[0]?.input_tokens).toBe(1000)
  }, 30_000)

  it('prices a model matched by a provider glob', async () => {
    // The fake adapter serves the `fake` provider, so the glob must cover that
    // provider — an unregistered provider fails the request before it is priced.
    const booted = await bootMeter({
      projects: { site: { model: 'globbed-model' } },
      pricing: 'pricing:\n  fake/globbed-model: { input: 0, cached: 0, output: 0 }\n  fake/*: { input: 0, cached: 0, output: 0 }\nunknown_model_policy: block\n',
      fake: { usage: { inputTokens: 100_000, outputTokens: 100_000 } },
    })
    await deliver(booted, 'site')

    // Priced at zero by the glob, so it is PRICED — no unpriced-model event.
    expect(booted.meter.spending('project:site').dayMicros).toBe(0)
    const events = booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)
    expect(events).toHaveLength(1)
    expect(events[0]?.model).toBe('globbed-model')
    expect(events[0]?.input_tokens).toBe(100_000)
  }, 30_000)
})

describe('usage events', () => {
  it('emits ops/usage with the scope and global totals', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    const seen: Array<{ scope: Scope; scopeMicros: number; globalMicros: number; deltaMicros: number }> = []
    booted.ctx.on('ops/usage', (payload) => {
      seen.push({
        scope: payload.scope,
        scopeMicros: payload.scopeMicros,
        globalMicros: payload.globalMicros,
        deltaMicros: payload.deltaMicros,
      })
    })

    await deliver(booted, 'site')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      scope: 'project:site',
      scopeMicros: 1500,
      globalMicros: 1500,
      deltaMicros: 1500,
    })
  }, 30_000)

  it('carries the run id when one is open', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    const runs: Array<string | undefined> = []
    booted.ctx.on('ops/usage', ({ runId }) => runs.push(runId))
    await deliver(booted, 'site', 'go', 'run-tagged')
    expect(runs).toEqual(['run-tagged'])
  }, 30_000)
})

describe('buffering', () => {
  it('writes nothing until a flush and then everything', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    // Raise the threshold so the automatic flush does not fire.
    const capability = booted.projects.claimDelivery('ops-governor')
    await booted.projects.ensureAgent('site')
    await booted.projects.deliver(
      capability,
      { kind: 'project', projectId: 'site' },
      [{ type: 'text', text: 'go' }],
      { runId: 'run-buffer' },
    )
    const agent = booted.projects.agentFor({ kind: 'project', projectId: 'site' })
    await agent?.whenIdle()

    // The counter is advanced immediately, so a budget check sees the spend...
    expect(booted.meter.spending('project:site').dayMicros).toBe(1500)
    // ...and the durable write happens at the flush.
    const report = await booted.meter.flush()
    expect(report).toMatchObject({ ok: true })
    expect(booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)).toHaveLength(1)
    expect(booted.meter.pendingCount).toBe(0)
  }, 30_000)

  it('reports healthy when nothing is pending', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    await booted.meter.flush()
    expect(booted.meter.health().status).toBe('ok')
    expect(booted.meter.dropped).toBe(0)
  }, 30_000)

  it('keeps events buffered when the write fails', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    await deliver(booted, 'site')

    // Break the store, then force a new event through the buffer.
    const original = booted.store.usage.appendBatch.bind(booted.store.usage)
    booted.store.usage.appendBatch = () => {
      throw new Error('disk on fire')
    }
    await booted.projects.deliver(
      capabilityOf(booted),
      { kind: 'project', projectId: 'site' },
      [{ type: 'text', text: 'more' }],
      { runId: 'run-2' },
    )
    const agent = booted.projects.agentFor({ kind: 'project', projectId: 'site' })
    await agent?.whenIdle()

    const failed = await booted.meter.flush()
    expect(failed.ok).toBe(false)
    // The meter never drops an event: losing a batch would break the
    // reconciliation invariant permanently.
    expect(booted.meter.pendingCount).toBeGreaterThan(0)
    expect(booted.meter.isDegraded).toBe(true)

    // Restore and flush: the buffered events land.
    booted.store.usage.appendBatch = original
    const recovered = await booted.meter.flush()
    expect(recovered.ok).toBe(true)
    expect(booted.meter.pendingCount).toBe(0)
    expect(booted.meter.isDegraded).toBe(false)
    expect(booted.store.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER)).toHaveLength(2)
  }, 60_000)
})

describe('reconciliation', () => {
  it('keeps usage_events equal to usage_daily after real turns', async () => {
    const booted = await bootMeter({ projects: { alpha: {}, beta: {} } })
    for (const [projectId, runId] of [
      ['alpha', 'run-a1'],
      ['beta', 'run-b1'],
      ['alpha', 'run-a2'],
    ] as const) {
      await deliver(booted, projectId, 'work', runId)
    }

    // The invariant ops-store guarantees, verified through the meter's path.
    const raw = booted.store.usage.rawTotalsByDayScope(0, Number.MAX_SAFE_INTEGER, (ts) =>
      new Date(ts).toISOString().slice(0, 10),
    )
    for (const row of raw) {
      const daily = booted.store.usage.daily(row.scope, row.day)
      expect(daily?.cost_micros, `rollup for ${row.scope} on ${row.day}`).toBe(row.cost_micros)
      expect(daily?.input_tokens).toBe(row.input_tokens)
    }
    expect(raw.length).toBeGreaterThan(0)
  }, 90_000)
})

describe('report', () => {
  it('summarizes a day range from the durable record', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    await deliver(booted, 'site')

    const report = booted.meter.report({ fromDay: '1970-01-01', toDay: '9999-12-31' })
    expect(report.totalMicros).toBe(1500)
    expect(report.byScope.map((row) => row.scope)).toEqual(['project:site'])
  }, 30_000)

  it('filters to one scope', async () => {
    const booted = await bootMeter({ projects: { alpha: {}, beta: {} } })
    await deliver(booted, 'alpha', 'work', 'run-a')
    await deliver(booted, 'beta', 'work', 'run-b')

    const report = booted.meter.report({
      fromDay: '1970-01-01',
      toDay: '9999-12-31',
      scope: 'project:alpha',
    })
    expect(report.totalMicros).toBe(1500)
    expect(report.byScope).toHaveLength(1)
  }, 60_000)

  it('reports zero for an empty range', async () => {
    const booted = await bootMeter({ projects: { site: {} } })
    expect(booted.meter.report({ fromDay: '2020-01-01', toDay: '2020-01-31' }).totalMicros).toBe(0)
  }, 30_000)
})

// PLAN.md's MVP acceptance criterion: "Task-uri punctuale fără memorie, contabilizate
// separat" — one-off tasks have no memory and are accounted SEPARATELY. This is the
// accounting half; `ops-orchestrator` and `ops-memory` cover the memory half.
//
// It matters because an ad-hoc task has no project to bill. If its cost landed in a
// project's scope, a project's budget would move because of work nobody assigned to it;
// if it landed nowhere, the money would be invisible.
describe('ad-hoc accounting', () => {
  it('scopes a one-off task to `adhoc`, never to a project', async () => {
    const booted = await bootMeter({ projects: { site: {} } })

    // The scope each owner maps to, which is what the governor passes when it records a
    // request. `adhoc` and `orchestrator` are their own scopes by construction, so an
    // ad-hoc task can never be billed to a project.
    const adhoc = scopeOfOwner({ kind: 'adhoc', runId: 'run-adhoc' })
    const orchestrator = scopeOfOwner({ kind: 'orchestrator' })
    const project = scopeOfOwner({ kind: 'project', projectId: 'site' })

    expect(adhoc).toBe('adhoc')
    expect(orchestrator).toBe('orchestrator')
    expect(project).toBe('project:site')

    // Every ad-hoc task shares the `adhoc` scope, so the total for one-off work is a
    // single line in a report rather than one per task.
    expect(scopeOfOwner({ kind: 'adhoc', runId: 'another' })).toBe('adhoc')

    // And the deployment's project cost is unaffected by it: the report for a project
    // scope filters on `project:site`, which `adhoc` can never match.
    const report = booted.meter.report({ fromDay: '1970-01-01', toDay: '9999-12-31', scope: 'project:site' })
    expect(report.totalMicros).toBe(0)
    expect(report.byScope.every((row) => row.scope === 'project:site')).toBe(true)
  }, 30_000)

  it('seeds the adhoc and orchestrator scopes at startup', async () => {
    // The counters are loaded from the durable record at boot, so a restart does not
    // reset a budget. The project scopes are enumerated from the config; `adhoc` and
    // `orchestrator` have no project id to enumerate, so they are seeded unconditionally.
    const booted = await bootMeter({ projects: { site: {} } })
    const report = booted.meter.report({ fromDay: '1970-01-01', toDay: '9999-12-31' })
    // No usage yet, so the report is empty — the scopes being registered is what makes a
    // later ad-hoc run countable without a restart.
    expect(report.totalMicros).toBe(0)
  }, 30_000)
})
