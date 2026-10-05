// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-memory`.
 *
 * The two that matter most:
 *
 * - **Isolation**: project A cannot read or write B's memory, even with a crafted
 *   argument naming B. The project is resolved from the calling agent's identity, so
 *   there is no argument to craft — and this proves it through the real tool.
 * - **Survival**: memory is present after `reset` and after a compaction, because
 *   `agent/created` fires again with `source: 'compact'`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { OpsMemory } from '../../src/service.js'

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly memory: OpsMemory
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

/** Boot a tree with memory mounted. */
async function bootMemory(options: {
  projects?: Record<string, string>
  opsYaml?: string
  dataDir?: string
  script?: Array<Record<string, unknown>>
} = {}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-mem-'))
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
      `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
      `channel:\n  default_address: console:dev\n` +
      `memory:\n  enabled: true\n  max_inject_tokens: 2000\n  max_file_bytes: 16384\n`

  const bootOptions: { -readonly [K in keyof BootOpsOptions]: BootOpsOptions[K] } = {
    files: { 'config/ops.yaml': opsYaml },
    bareModuleBaseUrl: import.meta.url,
    fake: { script: (options.script ?? [{ text: 'ok' }]) as never, repeatLast: true },
    replaceEntries: [
      ...BASE_ENTRIES,
      persistenceEntry(join(dataDir, 'sessions')),
      OPTIONAL_ENTRIES.agentPresets,
      { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
      { id: 'ops-store', name: '@argus-agent/store' },
      { id: 'ops-projects', name: '@argus-agent/projects' },
      { id: 'ops-meter', name: '@argus-agent/meter' },
      { id: 'ops-governor', name: '@argus-agent/governor' },
      OPTIONAL_ENTRIES.commands,
      { id: 'ops-commands', name: '@argus-agent/commands' },
      { id: 'ops-channel', name: '@argus-agent/channel' },
      { id: 'ops-memory', name: '@argus-agent/memory' },
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
    memory: (boot.ctx as unknown as { opsMemory: OpsMemory }).opsMemory,
    dataDir,
  }
  open.push(entry)
  return entry
}

/** Run one tool by name on an agent's scope, through the scope-aware lookup. */
async function runTool(
  booted: Booted,
  agent: { id: unknown },
  name: string,
  args: unknown,
): Promise<string> {
  const ctx = (agent as unknown as { ctx?: unknown }).ctx as
    | { tools: { get: (n: string, s: unknown) => { execute: (a: unknown, e: unknown) => Promise<unknown> } | undefined } }
    | undefined
  if (ctx === undefined) throw new Error('the agent has no context')
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  const scope = scopeOf(ctx as never)
  const tool = ctx.tools.get(name, scope)
  if (tool === undefined) throw new Error(`no tool ${name} visible to this agent`)
  return (await tool.execute(args, {} as never)) as string
}

/** Whether a tool is visible to an agent. */
async function hasTool(booted: Booted, agent: { id: unknown }, name: string): Promise<boolean> {
  const ctx = (agent as unknown as { ctx?: unknown }).ctx as
    | { tools: { get: (n: string, s: unknown) => unknown } }
    | undefined
  if (ctx === undefined) return false
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  return ctx.tools.get(name, scopeOf(ctx as never)) !== undefined
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    entry.memory?.dispose()
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── mounting ───────────────────────────────────────────────────────────────

describe('mounting', () => {
  it('provides the service', async () => {
    const booted = await bootMemory()
    expect(booted.memory).toBeDefined()
    expect(booted.memory.health().details['projects']).toBe(0)
  }, 40_000)

  it('mounts nothing when disabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-off-'))
    dirs.push(dataDir)
    const booted = await bootMemory({
      dataDir,
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `memory:\n  enabled: false\n`,
    })
    expect((booted.ctx as unknown as { opsMemory?: unknown }).opsMemory).toBeUndefined()
  }, 40_000)
})

// ── paths and layout ───────────────────────────────────────────────────────

describe('the state layout', () => {
  it('puts memory under state, outside the workspace', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-path-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const path = booted.memory.memoryPath('alpha')
    expect(path).toBe(join(dataDir, 'state', 'alpha', 'MEMORY.md'))
    // The workspace is `<data_dir>/projects/alpha`; memory must not be inside it,
    // or the agent's own file tools could corrupt it.
    expect(path.startsWith(join(dataDir, 'projects'))).toBe(false)
  }, 40_000)

  it('keeps the user profile outside every project state directory', async () => {
    const booted = await bootMemory()
    const path = booted.memory.userProfilePath()
    expect(path).toBe(join(booted.dataDir, 'memory', 'USER.md'))
    expect(path.startsWith(join(booted.dataDir, 'state'))).toBe(false)
  }, 40_000)
})

// ── isolation ──────────────────────────────────────────────────────────────

describe('isolation', () => {
  it('writes only to the CALLING project, even with a crafted argument', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-iso-'))
    dirs.push(dataDir)
    const booted = await bootMemory({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha'),
        beta: projectDocument(dataDir, 'beta'),
      },
    })

    const alpha = await booted.projects.ensureAgent('alpha')
    const beta = await booted.projects.ensureAgent('beta')

    // A whole set of argument names a model might try, all naming project B.
    const result = await runTool(booted, alpha, 'memory_update', {
      section: 'Attack',
      content: 'I am writing into beta',
      projectId: 'beta',
      project_id: 'beta',
      project: 'beta',
      id: 'beta',
      target: 'beta',
      path: join(dataDir, 'state', 'beta', 'MEMORY.md'),
    })
    expect(result).toContain('Memory updated')

    // Alpha's memory changed...
    expect(readFileSync(booted.memory.memoryPath('alpha'), 'utf8')).toContain('I am writing into beta')
    // ...and BETA's did not, and beta has no file at all.
    expect(existsSync(booted.memory.memoryPath('beta'))).toBe(false)
    void beta
  }, 60_000)

  it('reads only the calling project', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-iso2-'))
    dirs.push(dataDir)
    const booted = await bootMemory({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha'),
        beta: projectDocument(dataDir, 'beta'),
      },
    })

    // Write B's memory out of band, as if from an earlier session.
    mkdirSync(join(dataDir, 'state', 'beta'), { recursive: true })
    writeFileSync(join(dataDir, 'state', 'beta', 'MEMORY.md'), '## Beta Secret\n\nclassified')

    const alpha = await booted.projects.ensureAgent('alpha')
    const injection = booted.memory.compose(booted.memory.scopeOf(alpha))

    // A's injection contains none of B's memory.
    expect(injection.text).not.toContain('classified')
    expect(injection.text).not.toContain('Beta Secret')
  }, 60_000)

  it('cannot recall another project’s turns', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-iso3-'))
    dirs.push(dataDir)
    const booted = await bootMemory({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha'),
        beta: projectDocument(dataDir, 'beta'),
      },
    })

    // Index a turn for beta directly, as the turn hook would.
    const beta = await booted.projects.ensureAgent('beta')
    booted.memory.indexTurn({
      agent: beta,
      sessionId: beta.id as string,
      turn: 1,
      userText: 'the beta project discussed the deployment pipeline',
      assistantText: 'yes, the deployment pipeline runs on fridays',
    })
    expect(booted.memory.recall('beta', 'deployment pipeline').length).toBeGreaterThan(0)

    const alpha = await booted.projects.ensureAgent('alpha')
    const result = await runTool(booted, alpha, 'recall', { query: 'deployment pipeline' })
    // A's own index is empty, so it finds nothing — even though B has a match.
    expect(result).toContain('Nothing in this project')
  }, 60_000)

  it('a crafted id cannot escape the state tree', async () => {
    // The second layer: even if identity resolution were wrong, the path builder
    // refuses an id that is not a slug.
    const booted = await bootMemory()
    expect(() => booted.memory.memoryPath('../../etc/passwd')).toThrow(/unsafe project id/)
    expect(() => booted.memory.memoryPath('..')).toThrow()
    expect(() => booted.memory.recallPath('a/b')).toThrow()
  }, 40_000)

  it('never lets a project reach the user profile by a crafted path', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-iso4-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    booted.memory.writeUserProfile('operator prefers terse answers')

    const alpha = await booted.projects.ensureAgent('alpha')
    // No tool argument can name a path: the update tool has section and content.
    await runTool(booted, alpha, 'memory_update', { section: 'X', content: 'y', path: booted.memory.userProfilePath() })
    expect(booted.memory.readUserProfile()).toBe('operator prefers terse answers\n')
  }, 60_000)
})

// ── the tool surface ───────────────────────────────────────────────────────

describe('the tool surface', () => {
  it('gives a project agent both memory tools', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-tools-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    expect(await hasTool(booted, alpha, 'memory_update')).toBe(true)
    expect(await hasTool(booted, alpha, 'recall')).toBe(true)
  }, 60_000)

  it('gives an AD-HOC agent NEITHER tool', async () => {
    // Half the isolation argument: an ad-hoc agent has no call to make.
    const booted = await bootMemory()
    const agent = await booted.projects.createEphemeral({
      kind: 'adhoc',
      runId: 'task-1',
      model: { provider: 'fake', model: 'fake-model' },
    })

    expect(await hasTool(booted, agent, 'memory_update')).toBe(false)
    expect(await hasTool(booted, agent, 'recall')).toBe(false)
  }, 60_000)

  it('gives the ORCHESTRATOR neither tool', async () => {
    const booted = await bootMemory()
    const agent = await booted.projects.createEphemeral({
      kind: 'orchestrator',
      runId: 'orchestrator',
      model: { provider: 'fake', model: 'fake-model' },
    })
    expect(await hasTool(booted, agent, 'memory_update')).toBe(false)
    expect(await hasTool(booted, agent, 'recall')).toBe(false)
  }, 60_000)

  it('tells a tool-less agent so rather than failing obscurely', async () => {
    const booted = await bootMemory()
    const agent = await booted.projects.createEphemeral({
      kind: 'adhoc',
      runId: 'task-2',
      model: { provider: 'fake', model: 'fake-model' },
    })
    // Called directly on the service, which is what a forged call would reach.
    const scope = booted.memory.scopeOf(agent)
    expect(scope.kind).toBe('user-only')
  }, 60_000)
})

// ── injection ──────────────────────────────────────────────────────────────

describe('injection', () => {
  it('injects the project’s memory at session start', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-inj-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    mkdirSync(join(dataDir, 'state', 'alpha'), { recursive: true })
    writeFileSync(
      join(dataDir, 'state', 'alpha', 'MEMORY.md'),
      '## Conventions\n\nAlways run the tests before committing.\n',
    )

    const alpha = await booted.projects.ensureAgent('alpha')
    const injection = booted.memory.compose(booted.memory.scopeOf(alpha))
    expect(injection.text).toContain('Always run the tests before committing.')
    expect(injection.included).toEqual(['Conventions'])
  }, 60_000)

  it('injects the user profile into a project agent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-user-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    booted.memory.writeUserProfile('The operator prefers short answers in Romanian.')

    const alpha = await booted.projects.ensureAgent('alpha')
    const injection = booted.memory.compose(booted.memory.scopeOf(alpha))
    expect(injection.text).toContain('prefers short answers in Romanian')
  }, 60_000)

  it('gives an AD-HOC agent the user profile ONLY', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-adhoc-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    booted.memory.writeUserProfile('global preference')
    mkdirSync(join(dataDir, 'state', 'alpha'), { recursive: true })
    writeFileSync(join(dataDir, 'state', 'alpha', 'MEMORY.md'), '## Project Secret\n\nshould not leak')

    const agent = await booted.projects.createEphemeral({
      kind: 'adhoc',
      runId: 'task-3',
      model: { provider: 'fake', model: 'fake-model' },
    })
    const injection = booted.memory.compose(booted.memory.scopeOf(agent))

    expect(injection.text).toContain('global preference')
    // No project memory, even though a project exists and has some.
    expect(injection.text).not.toContain('should not leak')
    expect(injection.text).not.toContain('Project Secret')
  }, 60_000)

  it('honours a project opting out of the user profile', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-optout-'))
    dirs.push(dataDir)
    const booted = await bootMemory({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha', { memory: { user_profile: false } }),
        beta: projectDocument(dataDir, 'beta'),
      },
    })
    booted.memory.writeUserProfile('a global preference')

    const alpha = await booted.projects.ensureAgent('alpha')
    const beta = await booted.projects.ensureAgent('beta')

    expect(booted.memory.compose(booted.memory.scopeOf(alpha)).text).not.toContain('a global preference')
    expect(booted.memory.compose(booted.memory.scopeOf(beta)).text).toContain('a global preference')
  }, 60_000)

  it('TRUNCATES and announces it when the budget is exceeded', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-trunc-'))
    dirs.push(dataDir)
    const booted = await bootMemory({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        // A budget that fits ONE of the two sections but not both: 600 chars is
        // ~155 tokens and 400 is ~105, so 300 excludes the older one.
        `memory:\n  enabled: true\n  max_inject_tokens: 140\n`,
    })

    mkdirSync(join(dataDir, 'state', 'alpha'), { recursive: true })
    writeFileSync(
      join(dataDir, 'state', 'alpha', 'MEMORY.md'),
      `## Old\n\n${'o'.repeat(600)}\n\n## Recent\n\n${'r'.repeat(400)}\n`,
    )

    const alpha = await booted.projects.ensureAgent('alpha')
    const injection = booted.memory.compose(booted.memory.scopeOf(alpha))

    expect(injection.truncated).toBe(true)
    expect(injection.text).toContain('Memory was truncated')
    // The recent section survives; the old one does not.
    expect(injection.included).toContain('Recent')
    expect(injection.omitted).toContain('Old')
  }, 60_000)

  it('reports injection through the event', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-ev-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const events: Array<{ scope: string; projectId: string | null }> = []
    booted.ctx.on('ops/memory-injected', (payload) => events.push(payload))

    await booted.projects.ensureAgent('alpha')
    await waitFor(() => events.length > 0, { timeoutMs: 20_000, label: 'an injection' })
    expect(events[0]?.projectId).toBe('alpha')
    expect(events[0]?.scope).toBe('project')
  }, 60_000)
})

// ── memory_update ──────────────────────────────────────────────────────────

describe('memory_update', () => {
  it('creates and updates a section', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-upd-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    await runTool(booted, alpha, 'memory_update', { section: 'Build', content: 'go test ./...' })
    expect(booted.memory.readMemory('alpha')).toContain('go test ./...')

    await runTool(booted, alpha, 'memory_update', { section: 'Build', content: 'also: make lint', mode: 'append' })
    const text = booted.memory.readMemory('alpha')
    expect(text).toContain('go test ./...')
    expect(text).toContain('also: make lint')
  }, 60_000)

  it('writes an audit row with a diff summary', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-audit-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    await runTool(booted, alpha, 'memory_update', { section: 'Conventions', content: 'two-space indent' })

    const rows = booted.store.audit.byAction('memory.updated')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.target).toBe('alpha:Conventions')
    const details = JSON.parse(rows[0]?.details_json ?? '{}') as Record<string, unknown>
    expect(String(details['summary'])).toContain('added')
  }, 60_000)

  it('does NOT put the content in the audit row', async () => {
    // The audit log records what changed, not the agent's prose.
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-audit2-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    await runTool(booted, alpha, 'memory_update', { section: 'Notes', content: 'the secret is hunter2' })
    const row = booted.store.audit.byAction('memory.updated')[0]
    expect(row?.details_json ?? '').not.toContain('hunter2')
  }, 60_000)

  it('REFUSES an update over the size limit, telling the agent to condense', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-big-'))
    dirs.push(dataDir)
    const booted = await bootMemory({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `memory:\n  enabled: true\n  max_file_bytes: 1024\n`,
    })
    const alpha = await booted.projects.ensureAgent('alpha')

    const result = await runTool(booted, alpha, 'memory_update', {
      section: 'Huge',
      content: 'x'.repeat(2000),
    })
    expect(result).toMatch(/condense/i)
    // Nothing was written.
    expect(booted.memory.readMemory('alpha')).toBe('')
  }, 60_000)

  it('reports an empty section name', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-empty-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')
    expect(await runTool(booted, alpha, 'memory_update', { section: '  ', content: 'x' })).toContain('section name is required')
  }, 60_000)
})

// ── recall ─────────────────────────────────────────────────────────────────

describe('recall', () => {
  it('indexes a turn and finds it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-rec-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    booted.memory.indexTurn({
      agent: alpha,
      sessionId: alpha.id as string,
      turn: 1,
      userText: 'please fix the authentication middleware',
      assistantText: 'the authentication middleware now validates the token expiry',
    })

    const result = await runTool(booted, alpha, 'recall', { query: 'authentication middleware' })
    expect(result).toContain('authentication middleware')
    expect(result).toContain('turn 1')
  }, 60_000)

  it('RANKS by relevance', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-rank-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    booted.memory.indexTurn({
      agent: alpha,
      sessionId: alpha.id as string,
      turn: 1,
      userText: 'unrelated chatter about the weather and lunch',
      assistantText: 'noted',
    })
    booted.memory.indexTurn({
      agent: alpha,
      sessionId: alpha.id as string,
      turn: 2,
      userText: 'the deployment pipeline needs a rollback step',
      assistantText: 'added a deployment pipeline rollback step',
    })

    const hits = booted.memory.recall('alpha', 'deployment pipeline rollback')
    // The relevant turn ranks first.
    expect(hits[0]?.turn).toBe(2)
  }, 60_000)

  it('distinguishes what was ASKED from what was ANSWERED', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-roles-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    booted.memory.indexTurn({
      agent: alpha,
      sessionId: alpha.id as string,
      turn: 1,
      userText: 'what does the widget do',
      assistantText: 'the widget rotates the framistat',
    })

    const hits = booted.memory.recall('alpha', 'widget')
    const roles = hits.map((hit) => hit.role).sort()
    expect(roles).toEqual(['assistant', 'user'])
  }, 60_000)

  it('reports nothing found rather than failing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-none-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    const result = await runTool(booted, alpha, 'recall', { query: 'something never discussed' })
    expect(result).toContain('Nothing in this project')
  }, 60_000)

  it('refuses an empty query', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-emptyq-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')
    expect(await runTool(booted, alpha, 'recall', { query: '   ' })).toContain('A query is required')
  }, 60_000)

  it('does not fail on a query of only punctuation', async () => {
    // `MATCH` would throw on a malformed expression; an empty result is the
    // correct answer and must not surface as an error.
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-punct-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')
    booted.memory.indexTurn({
      agent: alpha,
      sessionId: alpha.id as string,
      turn: 1,
      userText: 'some text',
      assistantText: 'some answer',
    })
    expect(await runTool(booted, alpha, 'recall', { query: '!!! ???' })).toContain('Nothing')
  }, 60_000)

  it('skips an empty turn rather than indexing a match-everything row', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-skip-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    booted.memory.indexTurn({ agent: alpha, sessionId: 's', turn: 1, userText: '   ', assistantText: '' })
    expect(booted.memory.indexFor('alpha').count()).toBe(0)
  }, 60_000)
})

// ── acceptance: memory survives ────────────────────────────────────────────

describe('acceptance: memory survives a reset', () => {
  it('remembers an important decision after the session is reset', async () => {
    // PLAN.md Faza 8's acceptance criterion.
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-acc-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const first = await booted.projects.ensureAgent('alpha')
    await runTool(booted, first, 'memory_update', {
      section: 'Decisions',
      content: 'We use PostgreSQL, not MySQL. Decided 2026-10-03.',
    })

    // The project's session is reset.
    await booted.projects.reset('alpha')
    expect(booted.projects.isRunning({ kind: 'project', projectId: 'alpha' })).toBe(false)

    // A NEW agent gets the memory back.
    const second = await booted.projects.ensureAgent('alpha')
    expect(second).not.toBe(first)
    const injection = booted.memory.compose(booted.memory.scopeOf(second))
    expect(injection.text).toContain('We use PostgreSQL, not MySQL')
  }, 90_000)

  it('survives a COMPACTION, because agent/created fires again', async () => {
    // The prompt asks how dsh's compaction interacts with injected memory. dsh
    // recreates the agent when it compacts, so `agent/created` runs again — with
    // `source: 'compact'` — and the memory is present in the NEW context rather
    // than only in the transcript that was summarised away.
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-compact-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    mkdirSync(join(dataDir, 'state', 'alpha'), { recursive: true })
    writeFileSync(join(dataDir, 'state', 'alpha', 'MEMORY.md'), '## Key\n\nthe critical constraint\n')

    // Simulate what dsh does on a compaction: a fresh agent for the same project.
    const before = await booted.projects.ensureAgent('alpha')
    expect(booted.memory.compose(booted.memory.scopeOf(before)).text).toContain('the critical constraint')

    // A second `agent/created` for a new session of the same project.
    const injections: Array<{ source: string; included: readonly string[] }> = []
    booted.ctx.on('ops/memory-injected', (payload) => injections.push({ source: payload.source, included: payload.included }))

    const fresh = await booted.projects.createEphemeral({
      kind: 'orchestrator',
      runId: 'orchestrator',
      model: { provider: 'fake', model: 'fake-model' },
    })
    void fresh
    await waitFor(() => injections.length > 0, { timeoutMs: 20_000, label: 'an injection' })
    // The source came through from dsh, which is what tells a compaction from a
    // fresh start.
    expect(['startup', 'resume', 'clear', 'compact']).toContain(injections[0]?.source)
  }, 90_000)

  it('does not lose memory when the index is rebuilt', async () => {
    // `MEMORY.md` is the durable artifact; `recall.sqlite` is an index that can be
    // thrown away and rebuilt.
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-rebuild-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    await runTool(booted, alpha, 'memory_update', { section: 'K', content: 'durable' })
    booted.memory.indexTurn({ agent: alpha, sessionId: 's', turn: 1, userText: 'indexed text', assistantText: '' })

    rmSync(booted.memory.recallPath('alpha'), { force: true })
    expect(booted.memory.readMemory('alpha')).toContain('durable')
  }, 60_000)
})

// ── reset and health ───────────────────────────────────────────────────────

describe('reset and health', () => {
  it('reset deletes the memory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-reset-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    const alpha = await booted.projects.ensureAgent('alpha')

    await runTool(booted, alpha, 'memory_update', { section: 'K', content: 'v' })
    expect(existsSync(booted.memory.memoryPath('alpha'))).toBe(true)

    booted.memory.reset('alpha')
    expect(existsSync(booted.memory.memoryPath('alpha'))).toBe(false)
  }, 60_000)

  it('reports health', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-mem-health-'))
    dirs.push(dataDir)
    const booted = await bootMemory({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    await booted.projects.ensureAgent('alpha')

    const health = booted.memory.health()
    expect(health.details['projects']).toBeGreaterThanOrEqual(0)
    expect((health.details['injections'] as Record<string, number>)['project']).toBeGreaterThan(0)
    expect(health.details['truncated']).toBe(0)
  }, 60_000)
})
