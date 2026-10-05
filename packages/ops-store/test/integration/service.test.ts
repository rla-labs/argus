// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for the `OpsStore` service.
 *
 * The service's job beyond exposing repositories is the operations that span
 * tables: admission, recovery, backup and pruning. Each is asserted here.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectScope, usd } from '@argus-agent/types'
import { openDatabase } from '../../src/connection.js'
import { at, openMemoryStore, openStore, T0 } from '../helpers.js'

const dirs: string[] = []
const closers: Array<() => void> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-store-svc-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The run an admission creates. */
function runFor(inboundId: string, id = 'run-1') {
  return {
    id,
    inbound_id: inboundId,
    project_id: 'a',
    owner_key: 'project:a',
    session_id: 's1',
    provider: 'fake',
    model: 'm',
  }
}

describe('OpsStore.admit', () => {
  it('creates the run and marks the request admitted atomically', () => {
    const store = openMemoryStore()
    store.receive({ id: 'req-1', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)

    const result = store.admit({ inboundId: 'req-1', run: runFor('req-1'), now: at(100) })
    expect(result.admitted).toBe(true)
    expect(result.run).toMatchObject({ id: 'run-1', status: 'running', inbound_id: 'req-1' })
    expect(store.inbound.get('req-1')).toMatchObject({ status: 'admitted', run_id: 'run-1' })
  })

  it('admits a request only once', () => {
    const store = openMemoryStore()
    store.receive({ id: 'req-1', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)

    expect(store.admit({ inboundId: 'req-1', run: runFor('req-1', 'run-1'), now: T0 }).admitted).toBe(true)
    // A second dispatcher pass on the same request must not create a second run
    // for one message.
    expect(store.admit({ inboundId: 'req-1', run: runFor('req-1', 'run-2'), now: T0 }).admitted).toBe(false)
    expect(store.runs.get('run-2')).toBeUndefined()
    expect(store.runs.active()).toHaveLength(1)
  })

  it('does not admit a rejected or unknown request', () => {
    const store = openMemoryStore()
    store.receive({ id: 'req-1', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)
    store.inbound.markRejected('req-1', 'PANIC_MODE')

    expect(store.admit({ inboundId: 'req-1', run: runFor('req-1'), now: T0 }).admitted).toBe(false)
    expect(store.admit({ inboundId: 'missing', run: runFor('missing'), now: T0 }).admitted).toBe(false)
    expect(store.runs.active()).toHaveLength(0)
  })

  it('leaves no run behind when the request was already admitted', () => {
    const store = openMemoryStore()
    store.receive({ id: 'req-1', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)
    store.admit({ inboundId: 'req-1', run: runFor('req-1', 'run-1'), now: T0 })
    store.admit({ inboundId: 'req-1', run: runFor('req-1', 'run-2'), now: T0 })

    // The transaction rolled back: exactly one run exists.
    expect(store.runs.recent()).toHaveLength(1)
    expect(store.runs.get('run-2')).toBeUndefined()
  })

  it('rolls back the inbound update when the run insert fails', () => {
    const store = openMemoryStore()
    store.receive({ id: 'req-1', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)

    // A duplicate run id makes the insert fail after the inbound update.
    store.admit({ inboundId: 'req-1', run: runFor('req-1', 'run-1'), now: T0 })
    store.receive({ id: 'req-2', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)

    expect(() => store.admit({ inboundId: 'req-2', run: runFor('req-2', 'run-1'), now: T0 })).toThrow()
    // The request is still pending, not stranded as admitted without a run.
    expect(store.inbound.get('req-2')).toMatchObject({ status: 'pending', run_id: null })
  })

  it('creates a run for an ad-hoc request with no project', () => {
    const store = openMemoryStore()
    store.receive({ id: 'req-task', source: 'orchestrator', project_id: null, payload: '[]', priority: 0 }, T0)
    const result = store.admit({
      inboundId: 'req-task',
      run: {
        id: 'run-task',
        inbound_id: 'req-task',
        project_id: null,
        owner_key: 'adhoc:run-task',
        session_id: 's-task',
        provider: 'fake',
        model: 'cheap',
      },
      now: T0,
    })
    expect(result.admitted).toBe(true)
    expect(result.run?.project_id).toBeNull()
  })
})

describe('OpsStore.receive', () => {
  it('writes the request before anything runs', () => {
    const store = openMemoryStore()
    store.receive(
      {
        id: 'req-1',
        source: 'channel',
        project_id: 'a',
        payload: '[{"type":"text","text":"hello"}]',
        priority: 0,
        reply_chat: '{"channel":"console","chatId":"c1"}',
      },
      T0,
    )

    const row = store.inbound.get('req-1')
    expect(row?.status).toBe('pending')
    expect(JSON.parse(row!.payload)).toEqual([{ type: 'text', text: 'hello' }])
    expect(JSON.parse(row!.reply_chat!)).toEqual({ channel: 'console', chatId: 'c1' })
  })
})

describe('OpsStore.recoverInterruptedRuns', () => {
  it('marks running runs interrupted and reports them', () => {
    const store = openMemoryStore()
    for (const id of ['r1', 'r2', 'r3']) {
      store.receive({ id: `req-${id}`, source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)
      store.admit({ inboundId: `req-${id}`, run: runFor(`req-${id}`, id), now: T0 })
    }
    store.runs.finish('r2', 'completed', at(100))

    const affected = store.recoverInterruptedRuns(at(1000))
    expect(affected.map((row) => row.id).sort()).toEqual(['r1', 'r3'])
    expect(store.runs.active()).toHaveLength(0)
  })

  it('is a no-op when nothing was running', () => {
    const store = openMemoryStore()
    expect(store.recoverInterruptedRuns(T0)).toEqual([])
  })
})

describe('OpsStore.expireStaleApprovals', () => {
  it('times out approvals left pending by a crash', () => {
    const store = openMemoryStore()
    store.approvals.insert(
      { id: 'stale', run_id: 'run-1', project_id: 'a', request_json: '{}' },
      at(0),
    )
    expect(store.expireStaleApprovals(at(1000), at(10_000))).toBe(1)
    expect(store.approvals.get('stale')?.status).toBe('timeout')
  })
})

describe('OpsStore.backup', () => {
  it('writes a consistent copy that opens independently', async () => {
    const { store } = openStore()
    const dest = join(tempDir(), 'backup.sqlite')

    store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, T0)
    store.usage.appendBatch(
      [
        {
          ts: T0,
          run_id: 'run-1',
          project_id: 'a',
          scope: projectScope('a'),
          root_session: 's1',
          session_id: 's1',
          provider: 'fake',
          model: 'm',
          input_tokens: 10,
          cached_tokens: 0,
          output_tokens: 5,
          cost_micros: usd(0.25),
        },
      ],
      () => '2026-10-03',
    )

    await store.backup(dest)
    expect(existsSync(dest)).toBe(true)
    expect(statSync(dest).size).toBeGreaterThan(0)

    // The copy is a real database with the data in it, not a byte copy of a
    // file whose WAL held the committed rows.
    const restored = openDatabase({ path: dest })
    closers.push(() => restored.close())
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok')
    expect((restored.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1)
    expect(
      (restored.prepare('SELECT SUM(cost_micros) AS c FROM usage_events').get() as { c: number }).c,
    ).toBe(usd(0.25))
  })

  it('reports a clear error when the destination is unwritable', async () => {
    const { store } = openStore()
    const dir = tempDir()
    // A directory cannot be overwritten by a file.
    await expect(store.backup(dir)).rejects.toMatchObject({ code: 'STORE_ERROR' })
  })

  it('can be taken while the database is in use', async () => {
    const { store } = openStore()
    const dest = join(tempDir(), 'online.sqlite')

    // A write interleaved with the backup must not deadlock or corrupt either.
    store.projects.upsert({ id: 'before', cwd: '/p/before', provider: 'fake', model: 'm' }, T0)
    const backup = store.backup(dest)
    store.projects.upsert({ id: 'during', cwd: '/p/during', provider: 'fake', model: 'm' }, at(1))
    await backup

    const restored = openDatabase({ path: dest })
    closers.push(() => restored.close())
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok')
    // The backup has at least the row written before it started.
    expect(restored.prepare('SELECT id FROM projects WHERE id = ?').get('before')).toBeDefined()
  })
})

describe('OpsStore.prune', () => {
  it('prunes raw usage events and terminal inbound rows only', () => {
    const store = openMemoryStore()
    const day = 24 * 60 * 60 * 1000

    store.usage.appendBatch(
      [
        {
          ts: at(0),
          run_id: 'old',
          project_id: 'a',
          scope: projectScope('a'),
          root_session: 's1',
          session_id: 's1',
          provider: 'fake',
          model: 'm',
          input_tokens: 1,
          cached_tokens: 0,
          output_tokens: 1,
          cost_micros: 1,
        },
        {
          ts: at(100 * day),
          run_id: 'new',
          project_id: 'a',
          scope: projectScope('a'),
          root_session: 's1',
          session_id: 's1',
          provider: 'fake',
          model: 'm',
          input_tokens: 1,
          cached_tokens: 0,
          output_tokens: 1,
          cost_micros: 1,
        },
      ],
      () => '2026-10-03',
    )

    store.inbound.insert({ id: 'old-done', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, at(0))
    store.inbound.markDone('old-done')
    store.inbound.insert({ id: 'old-pending', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, at(0))

    const deleted = store.prune({ usageEventsOlderThanDays: 30, inboundDoneOlderThanDays: 30 }, at(100 * day))
    expect(deleted.usageEvents).toBe(1)
    expect(deleted.inbound).toBe(1)

    // `usage_daily` and `audit_log` are never pruned.
    expect(store.usage.daily(projectScope('a'), '2026-10-03')).toBeDefined()
    expect(store.inbound.get('old-pending')).toBeDefined()
    expect(store.inbound.get('old-done')).toBeUndefined()
  })

  it('does nothing when no retention window is given', () => {
    const store = openMemoryStore()
    expect(store.prune({}, T0)).toEqual({ usageEvents: 0, inbound: 0 })
  })
})

describe('OpsStore.transaction', () => {
  it('runs a multi-repository operation atomically', () => {
    const store = openMemoryStore()
    const work = store.transaction(() => {
      store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, T0)
      store.audit.record({ actor: 'system', action: 'project.created', target: 'a' }, T0)
      return 'done'
    })
    expect(work()).toBe('done')
    expect(store.projects.get('a')).toBeDefined()
    expect(store.audit.count()).toBe(1)
  })

  it('rolls back every repository on a throw', () => {
    const store = openMemoryStore()
    const work = store.transaction(() => {
      store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, T0)
      throw new Error('boom')
    })
    expect(() => work()).toThrow('boom')
    expect(store.projects.get('a')).toBeUndefined()
  })
})

describe('OpsStore.health', () => {
  it('reports ok with useful details on a healthy database', () => {
    const store = openMemoryStore()
    const health = store.health()
    expect(health.status).toBe('ok')
    expect(health.details).toMatchObject({ integrity: 'ok', pending: 0, active: 0 })
  })

  it('reflects pending and active counts', () => {
    const store = openMemoryStore()
    store.receive({ id: 'req-1', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)
    store.receive({ id: 'req-2', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, T0)
    store.admit({ inboundId: 'req-1', run: runFor('req-1'), now: T0 })

    expect(store.health().details).toMatchObject({ pending: 1, active: 1 })
  })
})
