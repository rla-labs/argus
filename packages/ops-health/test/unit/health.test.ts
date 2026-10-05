// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for `ops-health`'s pure layers.
 *
 * The report arithmetic, the status roll-up, the alert rules and the backup
 * rotation — everything decidable without a clock, a store or a running endpoint.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { down, ok, degraded, rankOf, worstOf } from '@argus-agent/types'
import {
  formatDuration,
  httpStatusFor,
  renderReport,
  rollUp,
  shouldAlert,
  shouldAlertThreshold,
  summarise,
} from '../../src/model.js'
import {
  dailyReport,
  formatBytes,
  formatUsd,
  parseRetry,
  retryValue,
  startupButtons,
  startupReport,
} from '../../src/report.js'
import { backupPath, backupsToPrune, listBackups, pruneBackups } from '../../src/backup.js'
import { healthOf, nextTimeOfDay, parseTimeOfDay } from '../../src/config.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-health-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── the status vocabulary ──────────────────────────────────────────────────

describe('worstOf', () => {
  it('returns ok for an empty list', () => {
    expect(worstOf([])).toBe('ok')
  })

  it('returns the worst status', () => {
    expect(worstOf(['ok', 'degraded'])).toBe('degraded')
    expect(worstOf(['ok', 'down'])).toBe('down')
    expect(worstOf(['degraded', 'down'])).toBe('down')
  })

  it('ignores order', () => {
    expect(worstOf(['down', 'ok'])).toBe('down')
    expect(worstOf(['degraded', 'ok', 'degraded'])).toBe('degraded')
  })

  it('is ok when everything is ok', () => {
    expect(worstOf(['ok', 'ok', 'ok'])).toBe('ok')
  })
})

describe('rankOf', () => {
  it('orders the three statuses', () => {
    expect(rankOf('ok')).toBeLessThan(rankOf('degraded'))
    expect(rankOf('degraded')).toBeLessThan(rankOf('down'))
  })
})

describe('the constructors', () => {
  it('build each status with details', () => {
    expect(ok({ a: 1 })).toEqual({ status: 'ok', details: { a: 1 } })
    expect(degraded()).toEqual({ status: 'degraded', details: {} })
    expect(down({ reason: 'x' })).toEqual({ status: 'down', details: { reason: 'x' } })
  })
})

// ── the roll-up ────────────────────────────────────────────────────────────

describe('rollUp', () => {
  const base = { uptimeMs: 5_000, version: '0.1.0', now: 1_000_000 }

  it('is ok when every subsystem is', () => {
    const report = rollUp({
      ...base,
      subsystems: [
        { name: 'opsStore', health: ok({ pending: 0 }) },
        { name: 'opsMeter', health: ok() },
      ],
    })
    expect(report.status).toBe('ok')
    expect(report.problems).toEqual([])
    expect(report.subsystems['opsStore']?.details).toEqual({ pending: 0 })
  })

  it('is degraded when one subsystem is', () => {
    const report = rollUp({
      ...base,
      subsystems: [
        { name: 'opsStore', health: ok() },
        { name: 'opsChannel', health: degraded({ reason: 'no adapter' }) },
      ],
    })
    expect(report.status).toBe('degraded')
    expect(report.problems).toEqual(['opsChannel'])
  })

  it('is down when one subsystem is', () => {
    const report = rollUp({
      ...base,
      subsystems: [
        { name: 'opsStore', health: ok() },
        { name: 'opsGovernor', health: down({ reason: 'panic' }) },
      ],
    })
    expect(report.status).toBe('down')
    expect(report.problems).toEqual(['opsGovernor'])
  })

  it('treats a MISSING service as down', () => {
    // A plugin that should be mounted and is not cannot do its job. Treating
    // absence as healthy would make a half-mounted system look fine.
    const report = rollUp({
      ...base,
      subsystems: [
        { name: 'opsStore', health: ok() },
        { name: 'opsMemory', health: undefined },
      ],
    })
    expect(report.status).toBe('down')
    expect(report.problems).toContain('opsMemory')
    expect(report.subsystems['opsMemory']?.details['reason']).toContain('not provided')
  })

  it('names every problem, not just the worst', () => {
    const report = rollUp({
      ...base,
      subsystems: [
        { name: 'a', health: degraded() },
        { name: 'b', health: down() },
        { name: 'c', health: degraded() },
        { name: 'd', health: ok() },
      ],
    })
    expect([...report.problems].sort()).toEqual(['a', 'b', 'c'])
  })

  it('carries the uptime, version and time through', () => {
    const report = rollUp({ ...base, subsystems: [] })
    expect(report.uptimeMs).toBe(5_000)
    expect(report.version).toBe('0.1.0')
    expect(report.now).toBe(1_000_000)
  })

  it('is ok for no subsystems at all', () => {
    expect(rollUp({ ...base, subsystems: [] }).status).toBe('ok')
  })
})

describe('httpStatusFor', () => {
  it('returns 200 for ok', () => {
    expect(httpStatusFor('ok')).toBe(200)
  })

  it('returns 200 for DEGRADED', () => {
    // The important one. A failing healthcheck restarts the container, and
    // restarting a merely-degraded system loses in-flight work while fixing
    // nothing.
    expect(httpStatusFor('degraded')).toBe(200)
  })

  it('returns 503 only for down', () => {
    expect(httpStatusFor('down')).toBe(503)
  })
})

describe('summarise', () => {
  const base = { uptimeMs: 90_000, version: '1.2.3', now: 0, subsystems: {}, problems: [] }

  it('says ok with no problems', () => {
    const text = summarise({ ...base, status: 'ok' })
    expect(text).toContain('OK')
    expect(text).toContain('1.2.3')
    expect(text).not.toContain('problem')
  })

  it('names the problems', () => {
    const text = summarise({ ...base, status: 'degraded', problems: ['opsChannel', 'opsMeter'] })
    expect(text).toContain('DEGRADED')
    expect(text).toContain('2 problem(s)')
    expect(text).toContain('opsChannel')
  })
})

describe('renderReport', () => {
  it('lists every subsystem with its status', () => {
    const report = rollUp({
      uptimeMs: 1_000,
      version: '0.1.0',
      now: 0,
      subsystems: [
        { name: 'opsStore', health: ok() },
        { name: 'opsGovernor', health: down({ reason: 'panic mode is engaged' }) },
      ],
    })
    const text = renderReport(report)
    expect(text).toContain('status    down')
    expect(text).toContain('opsStore')
    expect(text).toContain('opsGovernor')
    expect(text).toContain('panic mode is engaged')
  })

  it('sorts the subsystems so the output is stable', () => {
    const report = rollUp({
      uptimeMs: 0,
      version: 'v',
      now: 0,
      subsystems: [
        { name: 'zeta', health: ok() },
        { name: 'alpha', health: ok() },
      ],
    })
    expect(renderReport(report).indexOf('alpha')).toBeLessThan(renderReport(report).indexOf('zeta'))
  })
})

describe('formatDuration', () => {
  it.each([
    [5_000, '5s'],
    [90_000, '1m 30s'],
    [3_600_000, '1h 0m'],
    [90_000_000, '1d 1h'],
  ])('renders %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

// ── alerts ─────────────────────────────────────────────────────────────────

describe('shouldAlert', () => {
  it('alerts when anything first becomes unhealthy', () => {
    expect(shouldAlert(undefined, 'degraded')).toBe(true)
    expect(shouldAlert(undefined, 'down')).toBe(true)
  })

  it('does NOT alert on ok', () => {
    expect(shouldAlert('down', 'ok')).toBe(false)
  })

  it('does not alert when a status stays where it was', () => {
    // That is a notification per healthcheck, which is how a channel gets muted.
    expect(shouldAlert('degraded', 'degraded')).toBe(false)
    expect(shouldAlert('down', 'down')).toBe(false)
  })

  it('alerts when it gets WORSE', () => {
    expect(shouldAlert('degraded', 'down')).toBe(true)
  })

  it('alerts when the shape changes within the unhealthy range', () => {
    // down → degraded is an improvement, and it is still a change worth knowing:
    // the failure moved, so whatever the operator was about to do about it changed.
    expect(shouldAlert('down', 'degraded')).toBe(true)
  })
})

describe('shouldAlertThreshold', () => {
  it('does not alert below the threshold', () => {
    expect(shouldAlertThreshold(50, 85, undefined, 0, 60_000)).toBe(false)
  })

  it('alerts at the threshold', () => {
    expect(shouldAlertThreshold(85, 85, undefined, 0, 60_000)).toBe(true)
  })

  it('alerts on the first breach', () => {
    expect(shouldAlertThreshold(99, 85, undefined, 0, 60_000)).toBe(true)
  })

  it('RATE-LIMITS a sustained breach', () => {
    // A disk at 95% must produce one alert per interval, not one per check.
    expect(shouldAlertThreshold(95, 85, 0, 30_000, 60_000)).toBe(false)
    expect(shouldAlertThreshold(95, 85, 0, 60_000, 60_000)).toBe(true)
    expect(shouldAlertThreshold(95, 85, 0, 120_000, 60_000)).toBe(true)
  })
})

// ── the daily report ───────────────────────────────────────────────────────

describe('dailyReport', () => {
  const snapshot = {
    day: '2026-10-03',
    projects: [
      { projectId: 'alpha', costMicros: 1_500_000, runs: 4 },
      { projectId: 'beta', costMicros: 500_000, runs: 1 },
    ],
    unscopedMicros: 250_000,
    runsByStatus: { completed: 4, error: 1 },
    budgets: [
      { scope: 'project:alpha', level: 'ok', pct: 20, spentMicros: 1_500_000, limitMicros: 7_500_000 },
      { scope: 'project:beta', level: 'soft', pct: 85, spentMicros: 8_500_000, limitMicros: 10_000_000 },
    ],
    skips: { overlap: 2, paused: 1 },
    errors: { RATE_LIMIT: 3 },
    disk: { usedPct: 42, freeBytes: 12_000_000_000 },
  }

  it('states the date and the total cost', () => {
    const text = dailyReport(snapshot)
    expect(text).toContain('2026-10-03')
    // 1.5 + 0.5 + 0.25 = 2.25
    expect(text).toContain('$2.2500')
  })

  it('lists projects by cost, most first', () => {
    const text = dailyReport(snapshot)
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'))
    expect(text).toContain('4 run(s)')
  })

  it('names the unscoped spend', () => {
    expect(dailyReport(snapshot)).toContain('tasks and the front desk')
  })

  it('lists runs by status', () => {
    const text = dailyReport(snapshot)
    expect(text).toContain('completed')
    expect(text).toContain('error')
  })

  it('shows only the budgets that are not ok', () => {
    const text = dailyReport(snapshot)
    expect(text).toContain('project:beta')
    expect(text).toContain('85%')
    // alpha is within its limit, so it is not listed.
    expect(text).not.toContain('project:alpha')
  })

  it('says so when every budget is fine', () => {
    const text = dailyReport({ ...snapshot, budgets: [] })
    expect(text).toContain('all within their limits')
  })

  it('lists schedule skips by reason', () => {
    const text = dailyReport(snapshot)
    expect(text).toContain('overlap')
    expect(text).toContain('2 skipped')
  })

  it('lists errors', () => {
    expect(dailyReport(snapshot)).toContain('RATE_LIMIT')
  })

  it('reports disk usage', () => {
    expect(dailyReport(snapshot)).toContain('42% used')
  })

  it('KEEPS EVERY SECTION even when empty', () => {
    // A report that omits an empty section reads as "nothing happened" when it
    // means "I did not look", and an operator who learns to skim stops reading the
    // one that matters.
    const text = dailyReport({
      day: '2026-10-03',
      projects: [],
      unscopedMicros: 0,
      runsByStatus: {},
      budgets: [],
      skips: {},
      errors: {},
      disk: undefined,
    })
    for (const heading of ['Cost today', 'Runs', 'Budgets', 'Schedules', 'Errors', 'Disk']) {
      expect(text, heading).toContain(heading)
    }
    expect(text).toContain('none')
    expect(text).toContain('unknown')
  })

  it('says nothing was spent when nothing was', () => {
    const text = dailyReport({
      day: '2026-10-03',
      projects: [],
      unscopedMicros: 0,
      runsByStatus: {},
      budgets: [],
      skips: {},
      errors: {},
      disk: undefined,
    })
    expect(text).toContain('nothing was spent')
    expect(text).toContain('nothing was skipped')
  })
})

describe('startupReport', () => {
  const base = { version: '0.1.0', interrupted: [], pending: 0, orphaned: [] }

  it('says nothing was interrupted when nothing was', () => {
    expect(startupReport(base)).toContain('No run was interrupted')
  })

  it('names each interrupted run and its project', () => {
    const text = startupReport(
      {
        ...base,
        interrupted: [
          { runId: 'r1', projectId: 'alpha', requestId: 'req-1', startedAt: 0 },
          { runId: 'r2', projectId: null, requestId: 'req-2', startedAt: 0 },
        ],
      },
      () => '5m',
    )
    expect(text).toContain('2 run(s) were interrupted')
    expect(text).toContain('alpha')
    expect(text).toContain('a one-off task')
    expect(text).toContain('Retry')
  })

  it('reports the queue size', () => {
    expect(startupReport({ ...base, pending: 7 })).toContain('7 request(s) waiting')
  })

  it('names the requests that cannot run', () => {
    const text = startupReport({
      ...base,
      orphaned: [{ requestId: 'req-9', reason: 'project "gone" no longer exists' }],
    })
    expect(text).toContain('req-9')
    expect(text).toContain('no longer exists')
  })

  it('says the request will be resubmitted, not retyped', () => {
    expect(
      startupReport({ ...base, interrupted: [{ runId: 'r', projectId: 'a', requestId: 'q', startedAt: 0 }] }),
    ).toContain('resubmit the original request')
  })
})

describe('startupButtons', () => {
  it('offers one Retry per request', () => {
    const buttons = startupButtons(['req-1', 'req-2'])
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.value).toBe('__retry:req-1')
    expect(buttons[1]?.label).toBe('Retry 2')
  })

  it('CAPS the buttons', () => {
    // A message with twenty buttons is unreadable, and a platform may reject it.
    expect(startupButtons(['a', 'b', 'c', 'd', 'e', 'f'], 5)).toHaveLength(5)
  })

  it('offers nothing for nothing', () => {
    expect(startupButtons([])).toEqual([])
  })
})

describe('parseRetry', () => {
  it('reads a retry value', () => {
    expect(parseRetry(retryValue('req-1'))).toBe('req-1')
  })

  it('returns undefined for anything else', () => {
    // A value this plugin does not own must not be treated as a retry.
    for (const value of ['approve', '__confirm:x:yes', '/help', '', 'retry:1']) {
      expect(parseRetry(value), value).toBeUndefined()
    }
  })
})

describe('formatters', () => {
  it('renders micro-USD as dollars', () => {
    expect(formatUsd(1_500_000)).toBe('$1.5000')
    expect(formatUsd(0)).toBe('$0.0000')
  })

  it('renders bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

// ── backups ────────────────────────────────────────────────────────────────

describe('backupPath', () => {
  it('dates the file', () => {
    expect(backupPath('/data', '2026-10-03')).toBe('/data/backups/ops-2026-10-03.sqlite')
  })
})

describe('listBackups', () => {
  it('returns nothing when there is no directory', () => {
    expect(listBackups(tempDir())).toEqual([])
  })

  it('lists only dated backups, newest first', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'backups'), { recursive: true })
    writeFileSync(join(dir, 'backups', 'ops-2026-10-01.sqlite'), 'a')
    writeFileSync(join(dir, 'backups', 'ops-2026-10-03.sqlite'), 'b')
    writeFileSync(join(dir, 'backups', 'ops-2026-10-02.sqlite'), 'c')
    const found = listBackups(dir)
    expect(found.map((path) => path.split('/').pop())).toEqual([
      'ops-2026-10-03.sqlite',
      'ops-2026-10-02.sqlite',
      'ops-2026-10-01.sqlite',
    ])
  })

  it('IGNORES files it did not create', () => {
    // A rotation that globs too broadly deletes something it did not make.
    const dir = tempDir()
    mkdirSync(join(dir, 'backups'), { recursive: true })
    writeFileSync(join(dir, 'backups', 'ops-2026-10-01.sqlite'), 'a')
    writeFileSync(join(dir, 'backups', 'important.txt'), 'do not delete')
    writeFileSync(join(dir, 'backups', 'ops-backup.sqlite'), 'not dated')
    writeFileSync(join(dir, 'backups', 'notes.sqlite'), 'not ours')
    expect(listBackups(dir)).toHaveLength(1)
  })
})

describe('backupsToPrune', () => {
  it('keeps the newest N, including the one just written', () => {
    const existing = ['d3', 'd2', 'd1']
    expect(backupsToPrune(existing, 2)).toEqual(['d1'])
    expect(backupsToPrune(existing, 3)).toEqual([])
    expect(backupsToPrune(existing, 7)).toEqual([])
  })

  it('prunes everything when keep is zero', () => {
    expect(backupsToPrune(['a', 'b'], 0)).toEqual(['a', 'b'])
  })
})

describe('pruneBackups', () => {
  it('deletes beyond the keep count', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'backups'), { recursive: true })
    for (const day of ['01', '02', '03', '04']) {
      writeFileSync(join(dir, 'backups', `ops-2026-10-${day}.sqlite`), 'x')
    }
    const pruned = pruneBackups(dir, 2)
    expect(pruned).toHaveLength(2)
    expect(listBackups(dir)).toHaveLength(2)
    // The newest two survive.
    expect(listBackups(dir)[0]?.endsWith('ops-2026-10-04.sqlite')).toBe(true)
  })

  it('leaves an unrelated file alone', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'backups'), { recursive: true })
    writeFileSync(join(dir, 'backups', 'ops-2026-10-01.sqlite'), 'x')
    writeFileSync(join(dir, 'backups', 'important.txt'), 'keep me')
    pruneBackups(dir, 0)
    expect(existsSync(join(dir, 'backups', 'important.txt'))).toBe(true)
  })
})

// ── config ─────────────────────────────────────────────────────────────────

describe('healthOf', () => {
  it('applies every default', () => {
    const config = healthOf({})
    expect(config.enabled).toBe(true)
    expect(config.port).toBe(3090)
    expect(config.daily_report_time).toBe('09:00')
    expect(config.backup_time).toBe('03:30')
    expect(config.backup_keep).toBe(7)
    expect(config.disk_warn_pct).toBe(85)
  })

  it('honours explicit values', () => {
    const config = healthOf({
      health: { port: 9999, daily_report_time: '18:30', backup_keep: 3, endpoint: false },
    })
    expect(config.port).toBe(9999)
    expect(config.daily_report_time).toBe('18:30')
    expect(config.backup_keep).toBe(3)
    expect(config.endpoint).toBe(false)
  })

  it('REJECTS a malformed report time', () => {
    expect(() => healthOf({ health: { daily_report_time: '9am' } })).toThrow(/HH:MM/)
    expect(() => healthOf({ health: { daily_report_time: '25:00' } })).toThrow()
    expect(() => healthOf({ health: { backup_time: '03:60' } })).toThrow()
  })

  it('rejects a port out of range', () => {
    expect(() => healthOf({ health: { port: 70_000 } })).toThrow()
  })

  it('rejects a disk percentage above 100', () => {
    expect(() => healthOf({ health: { disk_warn_pct: 120 } })).toThrow()
  })
})

describe('parseTimeOfDay', () => {
  it('parses HH:MM', () => {
    expect(parseTimeOfDay('09:30')).toEqual({ hours: 9, minutes: 30 })
    expect(parseTimeOfDay('00:00')).toEqual({ hours: 0, minutes: 0 })
    expect(parseTimeOfDay('23:59')).toEqual({ hours: 23, minutes: 59 })
  })

  it('returns undefined for a malformed time', () => {
    for (const value of ['9:30', '24:00', '09:60', '', 'noon']) {
      expect(parseTimeOfDay(value), value).toBeUndefined()
    }
  })
})

describe('nextTimeOfDay', () => {
  const at = (iso: string): number => Date.parse(iso)

  it('finds today when the time is still ahead', () => {
    const now = at('2026-10-03T06:00:00Z')
    // 09:00 UTC is still ahead.
    expect(nextTimeOfDay('09:00', 'UTC', now)).toBe(at('2026-10-03T09:00:00Z'))
  })

  it('finds tomorrow when the time has passed', () => {
    const now = at('2026-10-03T10:00:00Z')
    expect(nextTimeOfDay('09:00', 'UTC', now)).toBe(at('2026-10-04T09:00:00Z'))
  })

  it('is strictly in the future', () => {
    const now = at('2026-10-03T09:00:00Z')
    // Exactly at the time: the NEXT one, not now — otherwise a timer would fire
    // immediately and then re-arm to the same instant forever.
    expect(nextTimeOfDay('09:00', 'UTC', now)).toBe(at('2026-10-04T09:00:00Z'))
  })

  it('resolves a LOCAL time in the configured timezone', () => {
    const now = at('2026-10-03T00:00:00Z')
    // 09:00 in Bucharest (UTC+3 in October) is 06:00 UTC.
    expect(nextTimeOfDay('09:00', 'Europe/Bucharest', now)).toBe(at('2026-10-03T06:00:00Z'))
  })

  it('keeps the local time across a DST transition', () => {
    // The day before the autumn change, 09:00 local is 06:00 UTC; on the day it is
    // 07:00 UTC. The wall clock is what is preserved, which is what a person means
    // by "at 09:00".
    const before = at('2026-10-24T00:00:00Z')
    const first = nextTimeOfDay('09:00', 'Europe/Bucharest', before)
    expect(first).toBe(at('2026-10-24T06:00:00Z'))

    const next = nextTimeOfDay('09:00', 'Europe/Bucharest', first)
    expect(next).toBe(at('2026-10-25T07:00:00Z'))
  })

  it('runs within two days for any input', () => {
    const now = at('2026-10-03T12:34:56Z')
    const next = nextTimeOfDay('12:35', 'UTC', now)
    expect(next - now).toBeLessThanOrEqual(48 * 3_600_000)
    expect(next).toBeGreaterThan(now)
  })

  it('falls back to a day ahead for a malformed time', () => {
    const now = at('2026-10-03T00:00:00Z')
    expect(nextTimeOfDay('nonsense', 'UTC', now)).toBe(now + 24 * 3_600_000)
  })
})
