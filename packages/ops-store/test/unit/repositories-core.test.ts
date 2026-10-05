// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the projects, inbound and runs repositories.
 *
 * These three tables are the spine of the system: a project owns a session, a
 * request is written before anything runs, and a run is the unit of accounting.
 */
import { describe, expect, it } from 'vitest'
import { projectOwner } from '@argus-agent/types'
import { at, openMemoryStore, T0 } from '../helpers.js'

describe('ProjectsRepository', () => {
  it('creates a project and reads it back', () => {
    const store = openMemoryStore()
    store.projects.upsert(
      { id: 'site', cwd: '/data/projects/site', provider: 'fake', model: 'm1' },
      T0,
    )
    const row = store.projects.get('site')
    expect(row).toMatchObject({
      id: 'site',
      cwd: '/data/projects/site',
      provider: 'fake',
      model: 'm1',
      status: 'active',
      session_id: null,
      fallback_model: null,
      created_at: T0,
    })
  })

  it('returns undefined for an unknown project', () => {
    expect(openMemoryStore().projects.get('nope')).toBeUndefined()
  })

  it('preserves session_id, status and created_at across a config reload', () => {
    const store = openMemoryStore()
    store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm1' }, T0)
    store.projects.setSession('a', 'session-1', T0)
    store.projects.setStatus('a', 'paused', T0)

    // A reload changes the model and the description but must not drop the
    // conversation or un-pause the project.
    store.projects.upsert(
      { id: 'a', cwd: '/p/a', provider: 'fake', model: 'm2', description: 'updated' },
      at(1000),
    )

    const row = store.projects.get('a')
    expect(row?.model).toBe('m2')
    expect(row?.description).toBe('updated')
    expect(row?.session_id).toBe('session-1')
    expect(row?.status).toBe('paused')
    expect(row?.created_at).toBe(T0)
    expect(row?.updated_at).toBe(at(1000))
  })

  it('updates optional fields, including clearing them', () => {
    const store = openMemoryStore()
    store.projects.upsert(
      { id: 'a', cwd: '/p/a', provider: 'fake', model: 'm', fallback_model: 'fb', preset: 'standard' },
      T0,
    )
    expect(store.projects.get('a')).toMatchObject({ fallback_model: 'fb', preset: 'standard' })

    store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, at(1))
    expect(store.projects.get('a')).toMatchObject({ fallback_model: null, preset: null })
  })

  it('lists projects, optionally by status', () => {
    const store = openMemoryStore()
    store.projects.upsert({ id: 'b', cwd: '/p/b', provider: 'fake', model: 'm' }, T0)
    store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, T0)
    store.projects.upsert({ id: 'c', cwd: '/p/c', provider: 'fake', model: 'm' }, T0)
    store.projects.setStatus('c', 'archived', T0)

    expect(store.projects.list().map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(store.projects.list({ status: 'active' }).map((row) => row.id)).toEqual(['a', 'b'])
    expect(store.projects.list({ status: 'archived' }).map((row) => row.id)).toEqual(['c'])
  })

  it('sets the session, status, model and cwd independently', () => {
    const store = openMemoryStore()
    store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm1' }, T0)

    expect(store.projects.setSession('a', 's1', at(1))).toBe(true)
    expect(store.projects.setStatus('a', 'paused', at(2))).toBe(true)
    expect(store.projects.setModel('a', 'm2', at(3))).toBe(true)
    expect(store.projects.setCwd('a', '/p/a2', at(4))).toBe(true)

    expect(store.projects.get('a')).toMatchObject({
      session_id: 's1',
      status: 'paused',
      model: 'm2',
      cwd: '/p/a2',
    })
  })

  it('reports no update for an unknown project', () => {
    const store = openMemoryStore()
    expect(store.projects.setSession('nope', 's', T0)).toBe(false)
    expect(store.projects.setStatus('nope', 'paused', T0)).toBe(false)
    expect(store.projects.setModel('nope', 'm', T0)).toBe(false)
    expect(store.projects.setCwd('nope', '/x', T0)).toBe(false)
  })

  it('can clear a session id', () => {
    const store = openMemoryStore()
    store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, T0)
    store.projects.setSession('a', 's1', T0)
    store.projects.setSession('a', null, at(1))
    expect(store.projects.get('a')?.session_id).toBeNull()
  })
})

describe('InboundRepository', () => {
  const request = {
    id: 'req-1',
    source: 'channel' as const,
    project_id: 'a',
    payload: '[{"type":"text","text":"hi"}]',
    priority: 0 as const,
  }

  it('inserts a pending request', () => {
    const store = openMemoryStore()
    store.inbound.insert(request, T0)
    const row = store.inbound.get('req-1')
    expect(row).toMatchObject({
      id: 'req-1',
      source: 'channel',
      project_id: 'a',
      priority: 0,
      status: 'pending',
      created_at: T0,
      admitted_at: null,
      run_id: null,
    })
  })

  it('stores a null project for an ad-hoc task', () => {
    const store = openMemoryStore()
    store.inbound.insert({ ...request, id: 'req-adhoc', project_id: null }, T0)
    expect(store.inbound.get('req-adhoc')?.project_id).toBeNull()
  })

  it('orders pending requests by priority, then age', () => {
    const store = openMemoryStore()
    // Inserted out of order on purpose: a low-priority request that arrived
    // first must still come after a high-priority one that arrived later.
    store.inbound.insert({ ...request, id: 'bg-old', priority: 2 }, at(0))
    store.inbound.insert({ ...request, id: 'sched', priority: 1 }, at(10))
    store.inbound.insert({ ...request, id: 'human', priority: 0 }, at(20))
    store.inbound.insert({ ...request, id: 'bg-new', priority: 2 }, at(30))

    expect(store.inbound.nextPending(10).map((row) => row.id)).toEqual([
      'human',
      'sched',
      'bg-old',
      'bg-new',
    ])
  })

  it('breaks a priority tie by age', () => {
    const store = openMemoryStore()
    store.inbound.insert({ ...request, id: 'second', priority: 0 }, at(100))
    store.inbound.insert({ ...request, id: 'first', priority: 0 }, at(50))
    expect(store.inbound.nextPending(10).map((row) => row.id)).toEqual(['first', 'second'])
  })

  it('limits and filters pending requests by project', () => {
    const store = openMemoryStore()
    store.inbound.insert({ ...request, id: 'a1', project_id: 'a' }, at(0))
    store.inbound.insert({ ...request, id: 'b1', project_id: 'b' }, at(1))
    store.inbound.insert({ ...request, id: 'a2', project_id: 'a' }, at(2))

    expect(store.inbound.nextPending(1).map((row) => row.id)).toEqual(['a1'])
    expect(store.inbound.nextPending(10, 'a').map((row) => row.id)).toEqual(['a1', 'a2'])
  })

  it('admits a request once and attaches its run', () => {
    const store = openMemoryStore()
    store.inbound.insert(request, T0)

    expect(store.inbound.markAdmitted('req-1', 'run-1', at(100))).toBe(true)
    expect(store.inbound.get('req-1')).toMatchObject({
      status: 'admitted',
      run_id: 'run-1',
      admitted_at: at(100),
    })

    // The guard is what makes two racing dispatcher passes safe.
    expect(store.inbound.markAdmitted('req-1', 'run-2', at(200))).toBe(false)
    expect(store.inbound.get('req-1')?.run_id).toBe('run-1')
  })

  it('rejects a request with a reason, once', () => {
    const store = openMemoryStore()
    store.inbound.insert(request, T0)
    expect(store.inbound.markRejected('req-1', 'BUDGET_EXCEEDED')).toBe(true)
    expect(store.inbound.get('req-1')).toMatchObject({
      status: 'rejected',
      reject_reason: 'BUDGET_EXCEEDED',
    })
    expect(store.inbound.markRejected('req-1', 'other')).toBe(false)
  })

  it('does not admit a rejected request', () => {
    const store = openMemoryStore()
    store.inbound.insert(request, T0)
    store.inbound.markRejected('req-1', 'PANIC_MODE')
    expect(store.inbound.markAdmitted('req-1', 'run-1', T0)).toBe(false)
  })

  it('counts pending requests and reports the oldest', () => {
    const store = openMemoryStore()
    expect(store.inbound.pendingCount()).toBe(0)
    expect(store.inbound.oldestPendingAt()).toBeUndefined()

    store.inbound.insert({ ...request, id: 'r1' }, at(100))
    store.inbound.insert({ ...request, id: 'r2' }, at(50))
    expect(store.inbound.pendingCount()).toBe(2)
    expect(store.inbound.oldestPendingAt()).toBe(at(50))

    store.inbound.markAdmitted('r2', 'run', T0)
    expect(store.inbound.pendingCount()).toBe(1)
    expect(store.inbound.oldestPendingAt()).toBe(at(100))
  })

  it('lists by status', () => {
    const store = openMemoryStore()
    store.inbound.insert({ ...request, id: 'r1' }, T0)
    store.inbound.insert({ ...request, id: 'r2' }, at(1))
    store.inbound.markRejected('r2', 'reason')

    expect(store.inbound.listByStatus('pending').map((row) => row.id)).toEqual(['r1'])
    expect(store.inbound.listByStatus('rejected').map((row) => row.id)).toEqual(['r2'])
  })

  it('marks a request done', () => {
    const store = openMemoryStore()
    store.inbound.insert(request, T0)
    expect(store.inbound.markDone('req-1')).toBe(true)
    expect(store.inbound.get('req-1')?.status).toBe('done')
  })

  it('prunes only terminal requests', () => {
    const store = openMemoryStore()
    store.inbound.insert({ ...request, id: 'done-old' }, at(0))
    store.inbound.markDone('done-old')
    store.inbound.insert({ ...request, id: 'rejected-old' }, at(0))
    store.inbound.markRejected('rejected-old', 'reason')
    store.inbound.insert({ ...request, id: 'pending-old' }, at(0))
    store.inbound.insert({ ...request, id: 'done-new' }, at(10_000))
    store.inbound.markDone('done-new')

    const deleted = store.inbound.prune(at(5000))
    expect(deleted).toBe(2)
    // A pending request is a promise not yet kept; it is never discarded.
    expect(store.inbound.get('pending-old')).toBeDefined()
    expect(store.inbound.get('done-new')).toBeDefined()
    expect(store.inbound.get('done-old')).toBeUndefined()
  })

  it('rejects a duplicate request id', () => {
    const store = openMemoryStore()
    store.inbound.insert(request, T0)
    expect(() => store.inbound.insert(request, T0)).toThrow()
  })
})

describe('RunsRepository', () => {
  const run = {
    id: 'run-1',
    inbound_id: 'req-1',
    project_id: 'a',
    owner_key: 'project:a',
    session_id: 's1',
    provider: 'fake',
    model: 'm1',
  }

  /**
   * Insert the `inbound` row a run references.
   *
   * `foreign_keys = ON` is part of the schema contract, so a run cannot exist
   * without its request. Every test in this block therefore needs the request
   * first — which is exactly the invariant the store exists to protect.
   */
  function withRequest(store: ReturnType<typeof openMemoryStore>, id = 'req-1', projectId: string | null = 'a'): void {
    store.inbound.insert(
      { id, source: 'channel', project_id: projectId, payload: '[]', priority: 0 },
      T0,
    )
  }

  it('starts a run in the running state', () => {
    const store = openMemoryStore()
    withRequest(store)
    store.runs.start(run, T0)
    expect(store.runs.get('run-1')).toMatchObject({
      id: 'run-1',
      status: 'running',
      steps: 0,
      started_at: T0,
      ended_at: null,
      stop_reason: null,
    })
  })

  it('finishes a run once', () => {
    const store = openMemoryStore()
    withRequest(store)
    store.runs.start(run, T0)
    expect(store.runs.finish('run-1', 'completed', at(500))).toBe(true)
    expect(store.runs.get('run-1')).toMatchObject({ status: 'completed', ended_at: at(500) })

    // A late signal must not rewrite a terminal state.
    expect(store.runs.finish('run-1', 'error', at(600))).toBe(false)
    expect(store.runs.get('run-1')?.status).toBe('completed')
  })

  it('records a stop reason', () => {
    const store = openMemoryStore()
    withRequest(store)
    store.runs.start(run, T0)
    store.runs.finish('run-1', 'budget_stopped', at(100), 'BUDGET_EXCEEDED')
    expect(store.runs.get('run-1')?.stop_reason).toBe('BUDGET_EXCEEDED')
  })

  it('tracks the step count', () => {
    const store = openMemoryStore()
    withRequest(store)
    store.runs.start(run, T0)
    expect(store.runs.setSteps('run-1', 7)).toBe(true)
    expect(store.runs.get('run-1')?.steps).toBe(7)
  })

  it('lists active runs and counts by status', () => {
    const store = openMemoryStore()
    withRequest(store, 'req-r1')
    withRequest(store, 'req-r2')
    store.runs.start({ ...run, id: 'r1', inbound_id: 'req-r1' }, at(0))
    store.runs.start({ ...run, id: 'r2', inbound_id: 'req-r2' }, at(10))
    store.runs.finish('r1', 'completed', at(20))

    expect(store.runs.active().map((row) => row.id)).toEqual(['r2'])
    expect(store.runs.countByStatus('completed')).toBe(1)
    expect(store.runs.countByStatus('running')).toBe(1)
  })

  it('lists runs by owner, newest first', () => {
    const store = openMemoryStore()
    for (const id of ['req-r1', 'req-r2', 'req-r3']) withRequest(store, id)
    store.runs.start({ ...run, id: 'r1', inbound_id: 'req-r1', owner_key: 'project:a' }, at(0))
    store.runs.start({ ...run, id: 'r2', inbound_id: 'req-r2', owner_key: 'project:b' }, at(10))
    store.runs.start({ ...run, id: 'r3', inbound_id: 'req-r3', owner_key: 'project:a' }, at(20))

    expect(store.runs.byOwner('project:a').map((row) => row.id)).toEqual(['r3', 'r1'])
    expect(store.runs.byOwner('project:b').map((row) => row.id)).toEqual(['r2'])
  })

  it('marks every running run interrupted and reports which', () => {
    const store = openMemoryStore()
    for (const id of ['req-r1', 'req-r2', 'req-r3']) withRequest(store, id)
    store.runs.start({ ...run, id: 'r1', inbound_id: 'req-r1' }, at(0))
    store.runs.start({ ...run, id: 'r2', inbound_id: 'req-r2' }, at(10))
    store.runs.start({ ...run, id: 'r3', inbound_id: 'req-r3' }, at(20))
    store.runs.finish('r2', 'completed', at(30))

    const affected = store.runs.markRunningInterrupted(at(1000))
    // The caller reports exactly what was lost, not a bare count.
    expect(affected.map((row) => row.id).sort()).toEqual(['r1', 'r3'])
    expect(store.runs.get('r1')).toMatchObject({
      status: 'interrupted',
      stop_reason: 'crash',
      ended_at: at(1000),
    })
    // A completed run is untouched.
    expect(store.runs.get('r2')?.status).toBe('completed')
    expect(store.runs.active()).toHaveLength(0)
  })

  it('stores the owner key and reply address', () => {
    const store = openMemoryStore()
    withRequest(store)
    const owner = projectOwner('a')
    store.runs.start(
      { ...run, owner_key: `project:${owner.kind === 'project' ? owner.projectId : ''}`, reply_chat: '{"channel":"console","chatId":"c1"}' },
      T0,
    )
    expect(store.runs.get('run-1')?.reply_chat).toBe('{"channel":"console","chatId":"c1"}')
  })
})
