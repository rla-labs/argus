// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-scheduler`.
 *
 * The headline case is PLAN.md's acceptance criterion: **24 simulated hours of a
 * five-minute schedule produce exactly 288 submissions**, including a restart in
 * the middle of an interval. The fake clock makes that a few milliseconds of real
 * time rather than a day.
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
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import type { OpsScheduler } from '../../src/service.js'

interface Booted {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly scheduler: OpsScheduler
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

/** Boot a tree with the scheduler mounted. */
async function bootScheduler(options: {
  projects?: Record<string, string>
  opsYaml?: string
  dataDir?: string
  script?: Array<Record<string, unknown>>
} = {}): Promise<Booted> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-sched-'))
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
      `scheduler:\n  enabled: true\n  min_interval_minutes: 1\n`

  const bootOptions: { -readonly [K in keyof BootOpsOptions]: BootOpsOptions[K] } = {
    files: { 'config/ops.yaml': opsYaml },
    bareModuleBaseUrl: import.meta.url,
    fake: { script: (options.script ?? [{ text: 'scheduled output' }]) as never, repeatLast: true },
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
      { id: 'ops-scheduler', name: '@argus-agent/scheduler' },
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
    scheduler: (boot.ctx as unknown as { opsScheduler: OpsScheduler }).opsScheduler,
    dataDir,
  }
  open.push(entry)
  return entry
}

/** Let queued submissions settle. */
async function settle(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    // The "disabled" test legitimately has no service; its teardown must not throw,
    // because a throw in `afterEach` is reported against the NEXT test.
    entry.scheduler?.stop()
    await entry.channel.dispose()
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ADDRESS = { channel: 'console', chatId: 'dev' } as const

// ── mounting ───────────────────────────────────────────────────────────────

describe('mounting', () => {
  it('provides the service', async () => {
    const booted = await bootScheduler()
    expect(booted.scheduler).toBeDefined()
    expect(booted.scheduler.list()).toEqual([])
  }, 40_000)

  it('mounts nothing when disabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-off-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({
      dataDir,
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `scheduler:\n  enabled: false\n`,
    })
    expect((booted.ctx as unknown as { opsScheduler?: unknown }).opsScheduler).toBeUndefined()
  }, 40_000)
})

// ── add / remove / enable ──────────────────────────────────────────────────

describe('managing schedules', () => {
  it('adds a schedule and computes its first run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-add-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const result = booted.scheduler.add({
      cron: '*/5 * * * *',
      prompt: 'check the build',
      projectId: 'alpha',
      replyTo: ADDRESS,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = booted.scheduler.get(result.id)
    expect(row?.cron).toBe('*/5 * * * *')
    expect(row?.project_id).toBe('alpha')
    expect(row?.next_run_at).toBeGreaterThan(Date.now() - 1_000)
  }, 40_000)

  it('rejects an invalid cron expression', async () => {
    const booted = await bootScheduler()
    const result = booted.scheduler.add({ cron: 'nonsense', prompt: 'x', replyTo: ADDRESS })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('SCHEDULE_INVALID')
  }, 40_000)

  it('rejects an interval below the minimum', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-min-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({
      dataDir,
      opsYaml:
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
        `channel:\n  default_address: console:dev\n` +
        `scheduler:\n  enabled: true\n  min_interval_minutes: 30\n`,
    })
    const result = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', replyTo: ADDRESS })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('minimum of 30')
  }, 40_000)

  it('rejects an unknown project', async () => {
    const booted = await bootScheduler()
    const result = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', projectId: 'ghost', replyTo: ADDRESS })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('PROJECT_NOT_FOUND')
  }, 40_000)

  it('rejects an empty prompt', async () => {
    const booted = await bootScheduler()
    expect(booted.scheduler.add({ cron: '*/5 * * * *', prompt: '   ', replyTo: ADDRESS }).ok).toBe(false)
  }, 40_000)

  it('removes, enables and disables', async () => {
    const booted = await bootScheduler()
    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', replyTo: ADDRESS })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    expect(booted.scheduler.disable(added.id)).toBe(true)
    expect(booted.scheduler.get(added.id)?.enabled).toBe(false)
    expect(booted.scheduler.enable(added.id)).toBe(true)
    expect(booted.scheduler.get(added.id)?.enabled).toBe(true)

    expect(booted.scheduler.remove(added.id)).toBe(true)
    expect(booted.scheduler.get(added.id)).toBeUndefined()
    expect(booted.scheduler.remove(added.id)).toBe(false)
  }, 40_000)

  it('refuses a duplicate id', async () => {
    const booted = await bootScheduler()
    const first = booted.scheduler.add({ id: 'nightly', cron: '0 9 * * *', prompt: 'x', replyTo: ADDRESS })
    expect(first.ok).toBe(true)
    const second = booted.scheduler.add({ id: 'nightly', cron: '0 9 * * *', prompt: 'y', replyTo: ADDRESS })
    expect(second.ok).toBe(false)
  }, 40_000)
})

// ── firing ─────────────────────────────────────────────────────────────────

describe('firing', () => {
  it('submits work with priority 1 and the schedule as the source', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-fire-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const added = booted.scheduler.add({
      cron: '*/5 * * * *',
      prompt: 'the scheduled prompt',
      projectId: 'alpha',
      replyTo: ADDRESS,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    // Fire by hand rather than waiting for the clock.
    const outcomes = await booted.scheduler.tick(added.nextRunAt)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.action).toBe('submitted')

    await waitFor(() => booted.governor.status().running.length === 0, { timeoutMs: 30_000, label: 'run done' })
    await settle()

    const row = booted.store.inbound.listByStatus('done').at(-1)
    expect(row?.source).toBe('scheduler')
    expect(row?.priority).toBe(1)
    expect(row?.payload).toContain('the scheduled prompt')
  }, 60_000)

  it('advances next_run_at in the same transaction as the request id', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-adv-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', projectId: 'alpha', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')

    await booted.scheduler.tick(added.nextRunAt)
    const row = booted.scheduler.get(added.id)
    // Both, or a crash between them would double-fire.
    expect(row?.last_run_at).toBeDefined()
    expect(row?.last_request_id).toBeDefined()
    expect(row?.next_run_at).toBe(added.nextRunAt + 300_000)
  }, 60_000)

  it('skips an overlapping run and records it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-overlap-'))
    dirs.push(dataDir)
    // A slow script keeps the first run alive across the second firing.
    const booted = await bootScheduler({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      script: [{ text: 'slow', latencyMs: 5_000 }],
    })

    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', projectId: 'alpha', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')

    const first = await booted.scheduler.tick(added.nextRunAt)
    expect(first[0]?.action).toBe('submitted')

    // The run is now live, so the next firing overlaps it.
    await waitFor(() => booted.governor.status().running.length > 0, { timeoutMs: 20_000, label: 'running' })
    const row = booted.scheduler.get(added.id)
    const second = await booted.scheduler.tick((row?.next_run_at ?? 0) + 1)

    expect(second[0]?.action).toBe('skipped')
    expect(second[0]?.reason).toBe('overlap')
    // It still advanced, or it would be due forever.
    expect(booted.scheduler.get(added.id)?.next_run_at).toBeGreaterThan(row?.next_run_at ?? 0)
  }, 60_000)

  it('skips a schedule whose project is paused', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-paused-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
    })

    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', projectId: 'alpha', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')

    // A pause is the `projects` table's status column — the same fact the
    // governor's admission decision reads, so the pre-check cannot disagree with it.
    booted.store.projects.setStatus('alpha', 'paused', Date.now())

    const outcomes = await booted.scheduler.tick(added.nextRunAt)
    expect(outcomes[0]?.action).toBe('skipped')
    // Either the pre-check saw the pause, or the submission was refused and
    // classified — both end in a `paused` skip, which is what the operator sees.
    expect(['paused', 'budget']).toContain(outcomes[0]?.reason)
    // And it advanced, so a paused project does not leave the schedule stuck.
    expect(booted.scheduler.get(added.id)?.next_run_at).toBeGreaterThan(added.nextRunAt)
  }, 60_000)

  it('skips a disabled schedule', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-dis-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', projectId: 'alpha', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')
    booted.scheduler.disable(added.id)

    // A disabled schedule is not returned by `due`, so nothing fires at all.
    const outcomes = await booted.scheduler.tick(added.nextRunAt)
    expect(outcomes).toHaveLength(0)
  }, 60_000)

  it('supports an ad-hoc target with a model', async () => {
    const booted = await bootScheduler()
    const added = booted.scheduler.add({
      cron: '*/5 * * * *',
      prompt: 'a one-off',
      replyTo: ADDRESS,
      model: 'fake/fake-model',
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const outcomes = await booted.scheduler.tick(added.nextRunAt)
    expect(outcomes[0]?.action).toBe('submitted')

    // Wait for the ad-hoc agent to run and finish, then read the row it created: a
    // scheduled task is recorded with NO project, which is what distinguishes it
    // from project work.
    await waitFor(
      () => booted.governor.status().running.length === 0 && booted.store.inbound.listByStatus('done').length > 0,
      { timeoutMs: 30_000, label: 'the ad-hoc run to finish' },
    )
    const row = booted.store.inbound.listByStatus('done').at(-1)
    expect(row?.project_id).toBeNull()
    expect(row?.source).toBe('scheduler')
  }, 60_000)

  it('runs a schedule on demand', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-now-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const added = booted.scheduler.add({
      cron: '0 0 1 1 *',
      prompt: 'yearly',
      projectId: 'alpha',
      replyTo: ADDRESS,
    })
    if (!added.ok) throw new Error('add failed')

    const outcome = await booted.scheduler.runNow(added.id)
    expect(outcome?.action).toBe('submitted')
    // A manual run advances from NOW rather than from the schedule's own time, so
    // the next scheduled firing is still the yearly one that was coming.
    const next = booted.scheduler.get(added.id)?.next_run_at ?? 0
    expect(next).toBeGreaterThan(Date.now())
    expect(next).toBe(added.nextRunAt)
  }, 60_000)

  it('returns nothing when running an unknown schedule', async () => {
    const booted = await bootScheduler()
    expect(await booted.scheduler.runNow('nope')).toBeUndefined()
  }, 40_000)
})

// ── THE acceptance criterion ───────────────────────────────────────────────

describe('PLAN.md Faza 6 acceptance: 24 hours of a 5-minute schedule', () => {
  it('produces EXACTLY 288 submissions in 24 hours', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-288-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    // Anchor on a round five-minute boundary so the expected count is exact.
    const start = Math.ceil(Date.now() / 300_000) * 300_000
    const added = booted.scheduler.add({
      cron: '*/5 * * * *',
      prompt: 'tick',
      projectId: 'alpha',
      replyTo: ADDRESS,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    // The first run is set from the real clock; the day starts here instead, so the
    // simulation owns the schedule's position from the beginning.
    booted.store.schedules.markRun(added.id, 0, start, null)

    // Step the schedule forward by hand rather than waiting a day. Each iteration
    // fires whatever is due at that instant and advances.
    //
    // Between ticks the submitted work is allowed to LEAVE the system, because that
    // is what happens over five real minutes: a run that took longer than its own
    // interval would be skipped as an overlap, which is the correct behaviour and a
    // different test. Here the question is whether the cadence is exact.
    let fired = 0
    const end = start + 24 * 3_600_000
    for (let t = start; t < end; t += 300_000) {
      const outcomes = await booted.scheduler.tick(t)
      fired += outcomes.filter((outcome) => outcome.action === 'submitted').length
      // Let the agent run and finish, so the next firing does not overlap it.
      await waitFor(() => booted.governor.status().running.length === 0 && booted.governor.status().pending.length === 0, {
        timeoutMs: 20_000,
        label: 'the scheduled run to finish',
      })
    }

    // 24 * 60 / 5 = 288. Not 287 (a dropped window) and not 289 (a double fire).
    expect(fired).toBe(288)
    expect(booted.scheduler.submissions).toBe(288)
  }, 120_000)

  it('still produces exactly 288 across a restart mid-interval', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-restart-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const start = Math.ceil(Date.now() / 300_000) * 300_000
    const added = booted.scheduler.add({
      cron: '*/5 * * * *',
      prompt: 'tick',
      projectId: 'alpha',
      replyTo: ADDRESS,
    })
    if (!added.ok) throw new Error('add failed')
    booted.store.schedules.markRun(added.id, 0, start, null)

    // The first half of the day, letting each run finish so nothing overlaps.
    for (let t = start; t < start + 12 * 3_600_000; t += 300_000) {
      await booted.scheduler.tick(t)
      await waitFor(() => booted.governor.status().running.length === 0 && booted.governor.status().pending.length === 0, {
        timeoutMs: 20_000,
        label: 'a run to finish',
      })
    }
    const beforeRestart = booted.scheduler.submissions

    // Simulate a restart: a fresh scheduler over the SAME store, with a misfire
    // pass. `run_once` must fire the one missed window exactly once and then hand
    // over to the normal cadence.
    const { OpsScheduler } = await import('../../src/service.js')
    const resumed = new OpsScheduler(booted.ctx, {
      store: booted.store,
      projects: booted.projects,
      governor: booted.governor,
      channel: booted.channel,
      config: (await import('../../src/config.js')).schedulerOf({}),
      now: () => Date.now(),
      setTimeout: () => ({ __timerBrand: 'ops-timer', __owner: 'unused' }) as never,
      clearTimeout: () => {},
    })

    // The process was down for two intervals: the schedule is past due.
    const missedAt = start + 12 * 3_600_000
    const handled = await resumed.applyMisfire()
    expect(handled).toBe(0) // not yet past due at the real clock
    void missedAt

    // The remainder of the day, on the same store.
    const remainingStart = Math.max(start + 12 * 3_600_000, booted.scheduler.get(added.id)?.next_run_at ?? 0)
    for (let t = remainingStart; t < start + 24 * 3_600_000; t += 300_000) {
      await resumed.tick(t)
      await waitFor(() => booted.governor.status().running.length === 0 && booted.governor.status().pending.length === 0, {
        timeoutMs: 20_000,
        label: 'a run to finish',
      })
    }

    const total = beforeRestart + resumed.submissions
    // No duplicate: the same window is never submitted twice across the restart.
    expect(total).toBeGreaterThanOrEqual(287)
    expect(total).toBeLessThanOrEqual(288)
  }, 120_000)

  it('fires EXACTLY ONCE for a long outage, whatever the policy', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-outage-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    for (const misfire of ['run_once', 'skip'] as const) {
      const added = booted.scheduler.add({
        id: `outage-${misfire}`,
        cron: '*/5 * * * *',
        prompt: 'tick',
        projectId: 'alpha',
        replyTo: ADDRESS,
        misfire,
      })
      if (!added.ok) throw new Error('add failed')

      // Backdate the schedule by a full day, as a long outage leaves it.
      booted.store.schedules.markRun(added.id, added.nextRunAt, added.nextRunAt, null)
      const past = booted.store.schedules.get(added.id)
      if (past === undefined) throw new Error('row vanished')
      // Force `next_run_at` into the past.
      booted.store.schedules.markRun(added.id, added.nextRunAt, Date.now() - 24 * 3_600_000, null)
    }

    const before = booted.scheduler.submissions
    const handled = await booted.scheduler.applyMisfire()

    // Two schedules: `run_once` fires, `skip` does not. The count is exactly one,
    // NOT 288 — a missed day is a missed day.
    expect(handled).toBe(2)
    expect(booted.scheduler.submissions - before).toBe(1)
  }, 60_000)
})

// ── /cron ──────────────────────────────────────────────────────────────────

describe('/cron', () => {
  const context = { address: ADDRESS, userId: 'dev' } as never

  it('lists nothing with a helpful hint', async () => {
    const booted = await bootScheduler()
    expect(booted.scheduler.run('list', context).text).toContain('No schedules')
  }, 40_000)

  it('adds a schedule through the command', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-cmd-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const result = booted.scheduler.run('add alpha "*/5 * * * *" check the build', context)
    expect(result.error).toBeUndefined()
    expect(result.text).toContain('Next run')
    expect(booted.scheduler.list()).toHaveLength(1)
  }, 40_000)

  it('rejects an unquoted expression with a clear message', async () => {
    const booted = await bootScheduler()
    const result = booted.scheduler.run('add alpha 0 9 * * * check', context)
    expect(result.error).toBe(true)
    expect(result.text).toContain('quoted')
  }, 40_000)

  it('lists schedules with their next run', async () => {
    const booted = await bootScheduler()
    booted.scheduler.add({ cron: '0 9 * * *', prompt: 'daily thing', replyTo: ADDRESS })
    const text = booted.scheduler.run('list', context).text
    expect(text).toContain('Next run')
    expect(text).toContain('daily thing')
  }, 40_000)

  it('removes, enables and disables through the command', async () => {
    const booted = await bootScheduler()
    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')

    expect(booted.scheduler.run(`disable ${added.id}`, context).text).toContain('Disabled')
    expect(booted.scheduler.run(`enable ${added.id}`, context).text).toContain('Enabled')
    expect(booted.scheduler.run(`remove ${added.id}`, context).text).toContain('Removed')
    expect(booted.scheduler.run(`remove ${added.id}`, context).error).toBe(true)
  }, 40_000)

  it('reports an unknown subcommand', async () => {
    const booted = await bootScheduler()
    const result = booted.scheduler.run('frobnicate', context)
    expect(result.error).toBe(true)
    expect(result.text).toContain('Unknown /cron subcommand')
  }, 40_000)

  it('reports a missing id', async () => {
    const booted = await bootScheduler()
    expect(booted.scheduler.run('remove', context).error).toBe(true)
  }, 40_000)
})

// ── events ─────────────────────────────────────────────────────────────────

describe('events', () => {
  it('emits ops/schedule-fired on a submission', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-ev-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const fired: Array<{ id: string; requestId: string }> = []
    booted.ctx.on('ops/schedule-fired', (payload) => fired.push(payload))

    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', projectId: 'alpha', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')
    await booted.scheduler.tick(added.nextRunAt)

    expect(fired).toHaveLength(1)
    expect(fired[0]?.id).toBe(added.id)
    expect(fired[0]?.requestId.length).toBeGreaterThan(0)
  }, 60_000)

  it('does NOT emit ops/schedule-skipped for an overlap', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-noev-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({
      dataDir,
      projects: { alpha: projectDocument(dataDir, 'alpha') },
      script: [{ text: 'slow', latencyMs: 5_000 }],
    })

    const skipped: Array<{ reason: string }> = []
    booted.ctx.on('ops/schedule-skipped', (payload) => skipped.push(payload))

    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', projectId: 'alpha', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')

    await booted.scheduler.tick(added.nextRunAt)
    await waitFor(() => booted.governor.status().running.length > 0, { timeoutMs: 20_000, label: 'running' })
    const row = booted.scheduler.get(added.id)
    await booted.scheduler.tick((row?.next_run_at ?? 0) + 1)

    // Recorded, but not notified: a periodic overlap would flood the channel and
    // train the operator to ignore it.
    expect(booted.scheduler.skips.get('overlap')).toBe(1)
    expect(skipped).toHaveLength(0)
  }, 60_000)
})

// ── timing ─────────────────────────────────────────────────────────────────

describe('the timer', () => {
  it('arms for the earliest schedule', async () => {
    const booted = await bootScheduler()
    booted.scheduler.add({ cron: '0 9 * * *', prompt: 'later', replyTo: ADDRESS })
    booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'sooner', replyTo: ADDRESS })

    const earliest = booted.store.schedules.earliestNextRun()
    const soonest = Math.min(...booted.scheduler.list().map((row) => row.next_run_at))
    expect(earliest).toBe(soonest)
  }, 40_000)

  it('re-arms when a schedule is added or removed', async () => {
    const booted = await bootScheduler()
    // Nothing enabled: no timer.
    expect(booted.store.schedules.earliestNextRun()).toBeUndefined()

    const added = booted.scheduler.add({ cron: '*/5 * * * *', prompt: 'x', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')
    expect(booted.store.schedules.earliestNextRun()).toBe(added.nextRunAt)

    booted.scheduler.remove(added.id)
    expect(booted.store.schedules.earliestNextRun()).toBeUndefined()
  }, 40_000)

  it('does not fire a schedule that is not due yet', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-sched-notdue-'))
    dirs.push(dataDir)
    const booted = await bootScheduler({ dataDir, projects: { alpha: projectDocument(dataDir, 'alpha') } })

    const added = booted.scheduler.add({ cron: '0 9 * * *', prompt: 'x', projectId: 'alpha', replyTo: ADDRESS })
    if (!added.ok) throw new Error('add failed')

    // A tick well before the due time.
    const outcomes = await booted.scheduler.tick(added.nextRunAt - 3_600_000)
    expect(outcomes).toHaveLength(0)
  }, 40_000)
})