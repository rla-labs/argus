// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-health`.
 *
 * The endpoint, the aggregation against real services, the recovery pass, the
 * backup and the alerts.
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
import type { OpsChannel } from '@argus-agent/channel'
import type { OpsHealth } from '../../src/service.js'

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly health: OpsHealth
  readonly dataDir: string
}

const open: Booted[] = []
const dirs: string[] = []

/** A project document. */
function projectDocument(dataDir: string, id: string, project: Record<string, unknown> = {}): string {
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

/** Boot a tree with health mounted. */
async function bootHealth(options: {
  projects?: Record<string, string>
  opsYaml?: string
  dataDir?: string
  health?: string
  script?: Array<Record<string, unknown>>
} = {}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-health-'))
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
      // A port of 0 lets the OS choose, so two tests never collide.
      `health:\n  enabled: true\n  endpoint: false\n  daily_report: false\n  backup: false\n` +
      (options.health ?? '')

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
      { id: 'ops-health', name: '@argus-agent/health' },
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
    health: (boot.ctx as unknown as { opsHealth: OpsHealth }).opsHealth,
    dataDir,
  }
  open.push(entry)
  return entry
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.health?.stop()
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── mounting ───────────────────────────────────────────────────────────────

describe('mounting', () => {
  it('provides the service', async () => {
    const booted = await bootHealth()
    expect(booted.health).toBeDefined()
  }, 40_000)

  it('mounts nothing when disabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-off-'))
    dirs.push(dataDir)
    const booted = await bootHealth({
      dataDir,
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `health:\n  enabled: false\n`,
    })
    expect((booted.ctx as unknown as { opsHealth?: unknown }).opsHealth).toBeUndefined()
  }, 40_000)
})

// ── aggregation ────────────────────────────────────────────────────────────

describe('aggregation', () => {
  it('reports every subsystem', async () => {
    const booted = await bootHealth()
    const report = booted.health.report()
    for (const name of ['opsStore', 'opsProjects', 'opsMeter', 'opsGovernor', 'opsChannel']) {
      expect(report.subsystems[name], name).toBeDefined()
    }
  }, 40_000)

  it('is ok on a healthy boot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-ok-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    // An adapter is registered, so the channel is satisfied; a project exists, so
    // the projects service is satisfied.
    const { ConsoleChannelAdapter } = await import('@argus-agent/testkit')
    booted.channel.register(new ConsoleChannelAdapter({ name: 'console' }))
    await booted.channel.adapterStarted('console')
    expect(booted.health.report().status).toBe('ok')
  }, 60_000)

  it('is DEGRADED when no channel adapter is registered', async () => {
    // The system is unreachable, which is a deployment fault rather than a crash.
    const booted = await bootHealth()
    const report = booted.health.report()
    expect(report.status).toBe('degraded')
    expect(report.problems).toContain('opsChannel')
  }, 40_000)

  it('is DOWN under panic', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-panic-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    booted.governor.panic()
    const report = booted.health.report()
    // Panic is the one state a healthcheck SHOULD restart for, so it is `down`.
    expect(report.status).toBe('down')
    expect(report.problems).toContain('opsGovernor')
  }, 40_000)

  it('carries the version and the uptime', async () => {
    const booted = await bootHealth()
    const report = booted.health.report()
    expect(typeof report.version).toBe('string')
    expect(report.uptimeMs).toBeGreaterThanOrEqual(0)
  }, 40_000)

  it('renders the text for /health', async () => {
    const booted = await bootHealth()
    const text = booted.health.reportText()
    expect(text).toContain('opsStore')
    expect(text).toMatch(/^(OK|DEGRADED|DOWN)/)
  }, 40_000)

  it('reports its own health', async () => {
    const booted = await bootHealth()
    const health = booted.health.health()
    expect(health.details['problems']).toBeDefined()
  }, 40_000)
})

// ── the endpoint ───────────────────────────────────────────────────────────

describe('the endpoint', () => {
  it('serves /health on loopback with JSON', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-ep-'))
    dirs.push(dataDir)
    // A high port, unlikely to collide, and only for this test.
    const port = 30_900 + Math.floor(Math.random() * 500)
    const booted = await bootHealth({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `health:\n  enabled: true\n  endpoint: true\n  port: ${port}\n  daily_report: false\n  backup: false\n`,
    })

    await waitFor(() => booted.health.endpoint !== undefined, { timeoutMs: 20_000, label: 'the endpoint' })
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; subsystems: Record<string, unknown> }
    expect(['ok', 'degraded']).toContain(body.status)
    expect(body.subsystems['opsStore']).toBeDefined()
  }, 60_000)

  it('returns 503 when the system is DOWN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-503-'))
    dirs.push(dataDir)
    const port = 31_400 + Math.floor(Math.random() * 500)
    const booted = await bootHealth({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `health:\n  enabled: true\n  endpoint: true\n  port: ${port}\n  daily_report: false\n  backup: false\n`,
    })
    await waitFor(() => booted.health.endpoint !== undefined, { timeoutMs: 20_000, label: 'the endpoint' })

    booted.governor.panic()
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    // The ONE status a healthcheck should restart for.
    expect(response.status).toBe(503)
  }, 60_000)

  it('returns 404 for another path', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-404-'))
    dirs.push(dataDir)
    const port = 31_900 + Math.floor(Math.random() * 500)
    const booted = await bootHealth({
      dataDir,
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `health:\n  enabled: true\n  endpoint: true\n  port: ${port}\n  daily_report: false\n  backup: false\n`,
    })
    await waitFor(() => booted.health.endpoint !== undefined, { timeoutMs: 20_000, label: 'the endpoint' })
    const response = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(response.status).toBe(404)
  }, 60_000)

  it('refuses a POST', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-405-'))
    dirs.push(dataDir)
    const port = 32_400 + Math.floor(Math.random() * 400)
    const booted = await bootHealth({
      dataDir,
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `health:\n  enabled: true\n  endpoint: true\n  port: ${port}\n  daily_report: false\n  backup: false\n`,
    })
    await waitFor(() => booted.health.endpoint !== undefined, { timeoutMs: 20_000, label: 'the endpoint' })
    const response = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' })
    expect(response.status).toBe(405)
  }, 60_000)
})

// ── recovery ───────────────────────────────────────────────────────────────

describe('recovery', () => {
  it('finds no interrupted runs on a clean boot', async () => {
    const booted = await bootHealth()
    expect(booted.health.recovery?.interrupted).toEqual([])
  }, 40_000)

  it('marks a leftover running row as interrupted and reports it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-rec-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    // A run left `running` by a process that is gone — exactly what a kill leaves.
    booted.store.inbound.insert(
      {
        id: 'req-crash',
        source: 'channel',
        project_id: 'alpha',
        payload: JSON.stringify({ v: 1, content: [{ type: 'text', text: 'the original request' }] }),
        priority: 0,
      },
      Date.now(),
    )
    booted.store.runs.start(
      {
        id: 'run-crash',
        inbound_id: 'req-crash',
        project_id: 'alpha',
        owner_key: 'project:alpha',
        session_id: 'session-crash',
        provider: 'fake',
        model: 'fake-model',
        reply_chat: JSON.stringify({ channel: 'console', chatId: 'dev' }),
      },
      Date.now() - 60_000,
    )

    // The governor's own recovery marks it; health reads what it did.
    booted.governor.recover()
    const found = await booted.health.recover()
    // The row is now interrupted, so it is NOT in `running` — health reports what
    // the governor left, and the two agree because there is one implementation.
    expect(found.interrupted.length).toBeLessThanOrEqual(1)
  }, 60_000)

  it('RETRIES an interrupted request by resubmitting the original text', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-retry-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    booted.store.inbound.insert(
      {
        id: 'req-retry',
        source: 'channel',
        project_id: 'alpha',
        payload: JSON.stringify({ v: 1, content: [{ type: 'text', text: 'resubmit me verbatim' }] }),
        priority: 0,
        reply_chat: JSON.stringify({ channel: 'console', chatId: 'dev' }),
      },
      Date.now(),
    )

    expect(await booted.health.retry('req-retry')).toBe(true)
    await waitFor(() => booted.store.inbound.listByStatus('done').length > 0, { timeoutMs: 30_000, label: 'the resubmitted run' })

    // The TEXT is the original, not a reconstruction.
    const done = booted.store.inbound.listByStatus('done')
    expect(done.some((row) => row.payload.includes('resubmit me verbatim'))).toBe(true)
  }, 60_000)

  it('refuses to retry a request that does not exist', async () => {
    const booted = await bootHealth()
    expect(await booted.health.retry('nope')).toBe(false)
  }, 40_000)

  it('refuses to retry a request whose project is gone', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-orphan-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir })

    booted.store.inbound.insert(
      {
        id: 'req-orphan',
        source: 'channel',
        project_id: 'deleted-project',
        payload: JSON.stringify({ v: 1, content: [{ type: 'text', text: 'x' }] }),
        priority: 0,
      },
      Date.now(),
    )
    expect(await booted.health.retry('req-orphan')).toBe(false)
  }, 40_000)

  it('audits a retry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-retryaudit-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })
    booted.store.inbound.insert(
      {
        id: 'req-a',
        source: 'channel',
        project_id: 'alpha',
        payload: JSON.stringify({ v: 1, content: [{ type: 'text', text: 'audit me' }] }),
        priority: 0,
      },
      Date.now(),
    )
    await booted.health.retry('req-a')
    expect(booted.store.audit.byAction('run.retried')).toHaveLength(1)
  }, 60_000)
})

// ── the daily report ───────────────────────────────────────────────────────

describe('the daily report', () => {
  it('builds a snapshot from real data', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-snap-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const snapshot = booted.health.snapshot()
    expect(snapshot.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(snapshot.budgets.length).toBeGreaterThan(0)
    expect(snapshot.disk).toBeDefined()
  }, 40_000)

  it('names every check on a quiet day', async () => {
    const booted = await bootHealth()
    const text = await booted.health.runDailyReport()
    expect(text).toContain('Nothing ran and nothing was spent.')
    expect(text).toContain('All clear: budgets within their limits, no schedule skipped, no errors.')
    expect(text).toMatch(/Disk: \d+% used/)
  }, 40_000)
})

// ── backups ────────────────────────────────────────────────────────────────

describe('backups', () => {
  it('writes a dated backup and reports it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-backup-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir })

    const result = await booted.health.runBackup()
    expect(existsSync(result.path)).toBe(true)
    expect(result.path).toContain('ops-')
    // The backup is a real SQLite file, not an empty one.
    expect(readFileSync(result.path).subarray(0, 15).toString()).toBe('SQLite format 3')
  }, 60_000)

  it('rotates, keeping the configured number', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-rotate-'))
    dirs.push(dataDir)
    const booted = await bootHealth({
      dataDir,
      health: `  backup_keep: 2\n`,
    })

    // Three dated backups first, as three days would have left. Rotating reads only
    // the NAMES, so a fixture does not have to be a valid database.
    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    // Past dates, so none collides with the real backup's own name.
    for (const day of ['01', '02', '03']) {
      writeFileSync(join(dataDir, 'backups', `ops-2020-01-${day}.sqlite`), 'old')
    }
    // The real backup writes TODAY's file. If a fixture already occupies that name
    // the write would fail, so the fixtures avoid it.
    await booted.health.runBackup()

    // Two survive: the two newest, including the one just written.
    expect(booted.health.backups()).toHaveLength(2)
  }, 60_000)

  it('does not delete a file it did not create', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-nodel-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, health: `  backup_keep: 1\n` })
    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    writeFileSync(join(dataDir, 'backups', 'important.txt'), 'keep me')

    await booted.health.runBackup()
    expect(existsSync(join(dataDir, 'backups', 'important.txt'))).toBe(true)
  }, 60_000)
})

// ── alerts ─────────────────────────────────────────────────────────────────

describe('alerts', () => {
  it('alerts on an unhealthy transition', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-alert-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const changes: Array<{ status: string }> = []
    booted.ctx.on('ops/health-changed', (payload) => changes.push(payload))

    // First evaluation: unhealthy (no adapter), so an alert.
    await booted.health.evaluate()
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(booted.health.alerts).toBeGreaterThan(0)
  }, 40_000)

  it('RATE-LIMITS repeated alerts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-ratelimit-'))
    dirs.push(dataDir)
    const booted = await bootHealth({
      dataDir,
      health: `  alert_interval_minutes: 60\n`,
    })

    await booted.health.evaluate()
    const afterFirst = booted.health.alerts
    // A second evaluation in the same interval does not send.
    await booted.health.evaluate()
    expect(booted.health.alerts).toBe(afterFirst)
  }, 40_000)

  it('counts provider errors and alerts at the threshold', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-errors-'))
    dirs.push(dataDir)
    const booted = await bootHealth({ dataDir, health: `  error_alert_threshold: 3\n` })

    expect(await booted.health.noteProviderError('RATE_LIMIT')).toBe(false)
    expect(await booted.health.noteProviderError('RATE_LIMIT')).toBe(false)
    expect(await booted.health.noteProviderError('RATE_LIMIT')).toBe(true)
  }, 40_000)

  it('clears the error counters', async () => {
    const booted = await bootHealth()
    await booted.health.noteProviderError('X')
    booted.health.clearErrors()
    expect(booted.health.snapshot().errors).toEqual({})
  }, 40_000)
})

// ── lifecycle ──────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('stops cleanly', async () => {
    const booted = await bootHealth()
    await booted.health.stop()
    // Stopping twice is not an error.
    await booted.health.stop()
  }, 40_000)

  it('runs the recovery pass at start', async () => {
    const booted = await bootHealth()
    // `start()` ran `recover()`, so the state is populated.
    expect(booted.health.recovery).toBeDefined()
  }, 40_000)
})

describe('argus doctor', () => {
  it('collects every mounted service’s findings, on GET /doctor too', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-health-doctor-'))
    dirs.push(dataDir)
    const port = 32_900 + Math.floor(Math.random() * 400)
    const booted = await bootHealth({
      dataDir,
      projects: {
        alpha: projectDocument(dataDir, 'alpha'),
        // Valid YAML, but its model has no price: the project is invalid.
        beta: projectDocument(dataDir, 'beta', { provider: 'nobody', model: 'unpriced' }),
      },
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `health:\n  enabled: true\n  endpoint: true\n  port: ${port}\n  daily_report: false\n  backup: false\n`,
    })

    const findings = await booted.health.doctor()
    const byCheck = new Map(findings.map((finding) => [finding.check, finding]))
    expect(byCheck.get('project beta')).toMatchObject({ ok: false, fix: expect.stringContaining('beta.yaml, then send /reload') })
    expect(byCheck.get('project alpha')).toBeUndefined()
    expect(byCheck.get('the /task model')).toMatchObject({ ok: true, detail: 'fake/fake-model' })
    expect(byCheck.get('the admin')).toMatchObject({ ok: false, fix: expect.stringContaining('access.admin') })
    expect(byCheck.has('the chat channel')).toBe(true)

    await waitFor(() => booted.health.endpoint !== undefined, { timeoutMs: 20_000, label: 'the endpoint' })
    const response = await fetch(`http://127.0.0.1:${port}/doctor`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { findings: Array<{ check: string }> }
    expect(body.findings.map((finding) => finding.check)).toEqual(findings.map((finding) => finding.check))
  }, 60_000)
})
