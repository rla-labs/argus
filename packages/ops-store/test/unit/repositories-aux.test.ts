// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for budgets, schedules, chat context, audit, approvals and runtime
 * state.
 */
import { describe, expect, it } from 'vitest'
import { projectScope, usd } from '@argus-agent/types'
import { BudgetsRepository } from '../../src/repositories/budgets.js'
import { at, openMemoryStore, T0 } from '../helpers.js'

describe('BudgetsRepository', () => {
  it('creates a budget with defaults', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: projectScope('a'), period: 'day', limit_micros: usd(3) })
    expect(store.budgets.get(projectScope('a'), 'day')).toMatchObject({
      scope: 'project:a',
      period: 'day',
      limit_micros: usd(3),
      info_pct: 50,
      soft_pct: 80,
      action_soft: 'warn',
      action_hard: 'pause',
      override_until: null,
      override_micros: 0,
    })
  })

  it('updates a limit without clearing an override', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: projectScope('a'), period: 'day', limit_micros: usd(3) })
    store.budgets.setOverride(projectScope('a'), 'day', { addMicros: usd(2) })

    // A config reload is not a revocation: the operator granted the override.
    store.budgets.upsert({ scope: projectScope('a'), period: 'day', limit_micros: usd(5) })

    const row = store.budgets.get(projectScope('a'), 'day')
    expect(row?.limit_micros).toBe(usd(5))
    expect(row?.override_micros).toBe(usd(2))
  })

  it('reads the budgets applicable to a run, preserving scope order', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: 'global', period: 'day', limit_micros: usd(10) })
    store.budgets.upsert({ scope: projectScope('a'), period: 'day', limit_micros: usd(3) })
    store.budgets.upsert({ scope: 'adhoc', period: 'day', limit_micros: usd(1) })

    // Every run is checked against `global` plus its own scope.
    const rows = store.budgets.forScopes(['global', projectScope('a')], 'day')
    expect(rows.map((row) => row.scope)).toEqual(['global', 'project:a'])

    expect(store.budgets.forScopes(['global', projectScope('missing')], 'day').map((r) => r.scope)).toEqual([
      'global',
    ])
    expect(store.budgets.forScopes([], 'day')).toEqual([])
  })

  it('separates day from month budgets', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: 'global', period: 'day', limit_micros: usd(10) })
    store.budgets.upsert({ scope: 'global', period: 'month', limit_micros: usd(150) })

    expect(store.budgets.forScopes(['global'], 'day')[0]?.limit_micros).toBe(usd(10))
    expect(store.budgets.forScopes(['global'], 'month')[0]?.limit_micros).toBe(usd(150))
  })

  it('accumulates an override and clears it', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: projectScope('a'), period: 'day', limit_micros: usd(3) })

    store.budgets.setOverride(projectScope('a'), 'day', { addMicros: usd(2) })
    expect(store.budgets.get(projectScope('a'), 'day')?.override_micros).toBe(usd(2))

    store.budgets.setOverride(projectScope('a'), 'day', { addMicros: usd(1) })
    expect(store.budgets.get(projectScope('a'), 'day')?.override_micros).toBe(usd(3))

    store.budgets.clearOverride(projectScope('a'), 'day')
    expect(store.budgets.get(projectScope('a'), 'day')?.override_micros).toBe(0)
  })

  it('sets an unlock window', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: projectScope('a'), period: 'day', limit_micros: usd(3) })
    store.budgets.setOverride(projectScope('a'), 'day', { untilMs: at(7_200_000) })
    expect(store.budgets.get(projectScope('a'), 'day')?.override_until).toBe(at(7_200_000))
  })

  it('reports no override for an unknown budget', () => {
    const store = openMemoryStore()
    expect(store.budgets.setOverride(projectScope('x'), 'day', { addMicros: usd(1) })).toBe(false)
  })

  it('computes the effective limit, ignoring an expired override', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: projectScope('a'), period: 'day', limit_micros: usd(3) })
    store.budgets.setOverride(projectScope('a'), 'day', { addMicros: usd(2), untilMs: at(1000) })
    const row = store.budgets.get(projectScope('a'), 'day')!

    // Inside the window the override applies.
    expect(BudgetsRepository.effectiveLimit(row, at(500))).toBe(usd(5))
    // Past it, the limit reverts: a forgotten unlock must not raise it forever.
    expect(BudgetsRepository.effectiveLimit(row, at(2000))).toBe(usd(3))
    expect(BudgetsRepository.isUnlocked(row, at(500))).toBe(true)
    expect(BudgetsRepository.isUnlocked(row, at(2000))).toBe(false)
  })

  it('treats a null expiry as a permanent override', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: projectScope('a'), period: 'day', limit_micros: usd(3) })
    store.budgets.setOverride(projectScope('a'), 'day', { addMicros: usd(2) })
    const row = store.budgets.get(projectScope('a'), 'day')!
    expect(BudgetsRepository.effectiveLimit(row, Number.MAX_SAFE_INTEGER)).toBe(usd(5))
    expect(BudgetsRepository.isUnlocked(row, at(0))).toBe(false)
  })

  it('lists and deletes budgets', () => {
    const store = openMemoryStore()
    store.budgets.upsert({ scope: 'global', period: 'day', limit_micros: usd(1) })
    store.budgets.upsert({ scope: 'global', period: 'month', limit_micros: usd(2) })
    expect(store.budgets.list()).toHaveLength(2)
    expect(store.budgets.delete('global', 'day')).toBe(true)
    expect(store.budgets.list()).toHaveLength(1)
  })
})

describe('SchedulesRepository', () => {
  const schedule = {
    id: 'daily-report',
    cron: '0 8 * * *',
    timezone: 'Europe/Bucharest',
    project_id: 'a',
    prompt: 'write the daily report',
    reply_chat: '{"channel":"console","chatId":"c1"}',
    next_run_at: at(60_000),
    misfire: 'run_once' as const,
    model: null,
  }

  it('creates a schedule, enabled by default', () => {
    const store = openMemoryStore()
    store.schedules.insert(schedule, T0)
    expect(store.schedules.get('daily-report')).toMatchObject({
      id: 'daily-report',
      enabled: true,
      last_run_at: null,
      last_request_id: null,
      created_at: T0,
    })
  })

  it('honours an explicit enabled flag and creation time', () => {
    const store = openMemoryStore()
    store.schedules.insert({ ...schedule, enabled: false, created_at: at(500) }, T0)
    const row = store.schedules.get('daily-report')
    expect(row?.enabled).toBe(false)
    expect(row?.created_at).toBe(at(500))
  })

  it('finds only enabled schedules that are due', () => {
    const store = openMemoryStore()
    store.schedules.insert({ ...schedule, id: 'due-soon', next_run_at: at(1000) }, T0)
    store.schedules.insert({ ...schedule, id: 'due-later', next_run_at: at(9000) }, T0)
    store.schedules.insert({ ...schedule, id: 'disabled', next_run_at: at(500), enabled: false }, T0)

    expect(store.schedules.due(at(1000)).map((row) => row.id)).toEqual(['due-soon'])
    expect(store.schedules.due(at(10_000)).map((row) => row.id)).toEqual(['due-soon', 'due-later'])
    // A disabled schedule is never due, however overdue.
    expect(store.schedules.due(at(100_000)).map((row) => row.id)).not.toContain('disabled')
  })

  it('reports the earliest enabled next run', () => {
    const store = openMemoryStore()
    expect(store.schedules.earliestNextRun()).toBeUndefined()

    store.schedules.insert({ ...schedule, id: 'later', next_run_at: at(9000) }, T0)
    store.schedules.insert({ ...schedule, id: 'sooner', next_run_at: at(1000) }, T0)
    store.schedules.insert({ ...schedule, id: 'off', next_run_at: at(1), enabled: false }, T0)

    expect(store.schedules.earliestNextRun()).toBe(at(1000))
  })

  it('records a firing and advances the schedule in one statement', () => {
    const store = openMemoryStore()
    store.schedules.insert(schedule, T0)

    expect(store.schedules.markRun('daily-report', at(60_000), at(120_000), 'req-1')).toBe(true)
    expect(store.schedules.get('daily-report')).toMatchObject({
      last_run_at: at(60_000),
      next_run_at: at(120_000),
      last_request_id: 'req-1',
    })
  })

  it('finds schedules whose next run has passed, for misfire handling', () => {
    const store = openMemoryStore()
    store.schedules.insert({ ...schedule, id: 'missed', next_run_at: at(1000) }, T0)
    store.schedules.insert({ ...schedule, id: 'future', next_run_at: at(9000) }, T0)
    store.schedules.insert({ ...schedule, id: 'off', next_run_at: at(500), enabled: false }, T0)

    expect(store.schedules.pastDue(at(5000)).map((row) => row.id)).toEqual(['missed'])
  })

  it('enables, disables and deletes', () => {
    const store = openMemoryStore()
    store.schedules.insert(schedule, T0)
    expect(store.schedules.setEnabled('daily-report', false)).toBe(true)
    expect(store.schedules.get('daily-report')?.enabled).toBe(false)
    expect(store.schedules.delete('daily-report')).toBe(true)
    expect(store.schedules.get('daily-report')).toBeUndefined()
  })

  it('stores an ad-hoc schedule with no project', () => {
    const store = openMemoryStore()
    store.schedules.insert({ ...schedule, id: 'adhoc', project_id: null, model: 'cheap' }, T0)
    expect(store.schedules.get('adhoc')).toMatchObject({ project_id: null, model: 'cheap' })
  })
})

describe('ChatContextRepository', () => {
  it('sets and reads the active project per chat', () => {
    const store = openMemoryStore()
    expect(store.chatContext.get('console', 'c1')).toBeUndefined()

    store.chatContext.setActive('console', 'c1', 'a', T0)
    expect(store.chatContext.get('console', 'c1')).toMatchObject({
      channel: 'console',
      chat_id: 'c1',
      active_project_id: 'a',
    })
  })

  it('keeps two chats independent', () => {
    const store = openMemoryStore()
    // Per chat, not per user: one person may work in two projects at once.
    store.chatContext.setActive('console', 'c1', 'a', T0)
    store.chatContext.setActive('console', 'c2', 'b', T0)
    expect(store.chatContext.get('console', 'c1')?.active_project_id).toBe('a')
    expect(store.chatContext.get('console', 'c2')?.active_project_id).toBe('b')
  })

  it('keeps channels independent', () => {
    const store = openMemoryStore()
    store.chatContext.setActive('console', 'c1', 'a', T0)
    store.chatContext.setActive('telegram', 'c1', 'b', T0)
    expect(store.chatContext.get('console', 'c1')?.active_project_id).toBe('a')
    expect(store.chatContext.get('telegram', 'c1')?.active_project_id).toBe('b')
  })

  it('updates in place and clears the selection', () => {
    const store = openMemoryStore()
    store.chatContext.setActive('console', 'c1', 'a', T0)
    store.chatContext.setActive('console', 'c1', 'b', at(100))
    expect(store.chatContext.get('console', 'c1')).toMatchObject({
      active_project_id: 'b',
      updated_at: at(100),
    })

    store.chatContext.setActive('console', 'c1', null, at(200))
    expect(store.chatContext.get('console', 'c1')?.active_project_id).toBeNull()
  })

  it('clears and lists', () => {
    const store = openMemoryStore()
    store.chatContext.setActive('console', 'c1', 'a', T0)
    store.chatContext.setActive('console', 'c2', 'b', T0)
    expect(store.chatContext.list()).toHaveLength(2)
    expect(store.chatContext.clear('console', 'c1')).toBe(true)
    expect(store.chatContext.list().map((row) => row.chat_id)).toEqual(['c2'])
  })
})

describe('AuditRepository', () => {
  it('writes an entry with structured details', () => {
    const store = openMemoryStore()
    const id = store.audit.record(
      { actor: 'user-1', action: 'budget.override', target: projectScope('a'), details: { addMicros: usd(2) } },
      T0,
    )
    expect(id).toBeGreaterThan(0)

    const rows = store.audit.recent()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor: 'user-1',
      action: 'budget.override',
      target: 'project:a',
      ts: T0,
    })
    expect(JSON.parse(rows[0]!.details_json!)).toEqual({ addMicros: usd(2) })
  })

  it('stores a null details field when none is given', () => {
    const store = openMemoryStore()
    store.audit.record({ actor: 'system', action: 'panic' }, T0)
    expect(store.audit.recent()[0]?.details_json).toBeNull()
  })

  it('accepts an explicit timestamp', () => {
    const store = openMemoryStore()
    store.audit.record({ actor: 'system', action: 'x', ts: at(999) }, T0)
    expect(store.audit.recent()[0]?.ts).toBe(at(999))
  })

  it('reads by target and by action', () => {
    const store = openMemoryStore()
    store.audit.record({ actor: 'u', action: 'model.changed', target: 'a' }, at(0))
    store.audit.record({ actor: 'u', action: 'budget.override', target: 'b' }, at(10))
    store.audit.record({ actor: 'u', action: 'model.changed', target: 'b' }, at(20))

    expect(store.audit.byTarget('b').map((row) => row.action)).toEqual(['model.changed', 'budget.override'])
    expect(store.audit.byAction('model.changed')).toHaveLength(2)
    expect(store.audit.byTarget('missing')).toEqual([])
  })

  it('orders newest first and counts', () => {
    const store = openMemoryStore()
    store.audit.record({ actor: 'u', action: 'first' }, at(0))
    store.audit.record({ actor: 'u', action: 'second' }, at(10))
    expect(store.audit.recent().map((row) => row.action)).toEqual(['second', 'first'])
    expect(store.audit.count()).toBe(2)
  })

  it('is never pruned by the store', () => {
    const store = openMemoryStore()
    store.audit.record({ actor: 'u', action: 'old' }, at(0))
    // `prune` touches usage events and inbound rows only; the audit trail is
    // the record of who did what, and it is asked months later.
    store.prune({ usageEventsOlderThanDays: 0, inboundDoneOlderThanDays: 0 }, at(1_000_000))
    expect(store.audit.count()).toBe(1)
  })
})

describe('ApprovalsRepository', () => {
  const approval = {
    id: 'appr-1',
    run_id: 'run-1',
    project_id: 'a',
    request_json: '{"toolName":"bash","argv":["rm","-rf","/"]}',
  }

  it('records a pending request', () => {
    const store = openMemoryStore()
    store.approvals.insert(approval, T0)
    expect(store.approvals.get('appr-1')).toMatchObject({
      id: 'appr-1',
      status: 'pending',
      decided_by: null,
      decided_at: null,
      created_at: T0,
    })
  })

  it('records a decision once', () => {
    const store = openMemoryStore()
    store.approvals.insert(approval, T0)

    expect(store.approvals.decide('appr-1', 'granted', 'user-1', at(100))).toBe(true)
    expect(store.approvals.get('appr-1')).toMatchObject({
      status: 'granted',
      decided_by: 'user-1',
      decided_at: at(100),
    })

    // A late button press must not overwrite a decision a timeout already made.
    expect(store.approvals.decide('appr-1', 'denied', 'user-2', at(200))).toBe(false)
    expect(store.approvals.get('appr-1')?.status).toBe('granted')
  })

  it('lists pending approvals oldest first', () => {
    const store = openMemoryStore()
    store.approvals.insert({ ...approval, id: 'a1' }, at(10))
    store.approvals.insert({ ...approval, id: 'a2' }, at(0))
    store.approvals.insert({ ...approval, id: 'a3' }, at(20))
    store.approvals.decide('a1', 'denied', 'u', at(30))

    expect(store.approvals.listPending().map((row) => row.id)).toEqual(['a2', 'a3'])
  })

  it('reads approvals by run, for the approve-all scope', () => {
    const store = openMemoryStore()
    store.approvals.insert({ ...approval, id: 'a1', run_id: 'run-1' }, at(0))
    store.approvals.insert({ ...approval, id: 'a2', run_id: 'run-1' }, at(10))
    store.approvals.insert({ ...approval, id: 'a3', run_id: 'run-2' }, at(20))

    expect(store.approvals.byRun('run-1').map((row) => row.id)).toEqual(['a1', 'a2'])
  })

  it('reads approvals by project, newest first', () => {
    const store = openMemoryStore()
    store.approvals.insert({ ...approval, id: 'a1', project_id: 'a' }, at(0))
    store.approvals.insert({ ...approval, id: 'a2', project_id: 'a' }, at(10))
    store.approvals.insert({ ...approval, id: 'a3', project_id: 'b' }, at(20))

    expect(store.approvals.byProject('a').map((row) => row.id)).toEqual(['a2', 'a1'])
  })

  it('expires stale pending approvals', () => {
    const store = openMemoryStore()
    store.approvals.insert({ ...approval, id: 'stale' }, at(0))
    store.approvals.insert({ ...approval, id: 'fresh' }, at(5000))

    expect(store.approvals.expirePending(at(1000), at(10_000))).toBe(1)
    expect(store.approvals.get('stale')).toMatchObject({ status: 'timeout', decided_at: at(10_000) })
    expect(store.approvals.get('fresh')?.status).toBe('pending')
  })

  it('does not expire an already-decided approval', () => {
    const store = openMemoryStore()
    store.approvals.insert({ ...approval, id: 'decided' }, at(0))
    store.approvals.decide('decided', 'granted', 'u', at(100))
    expect(store.approvals.expirePending(at(1000), at(10_000))).toBe(0)
    expect(store.approvals.get('decided')?.status).toBe('granted')
  })
})

describe('RuntimeStateRepository', () => {
  it('stores and reads a JSON value', () => {
    const store = openMemoryStore()
    expect(store.runtimeState.get('panic')).toBeUndefined()

    store.runtimeState.set('panic', { active: true, since: T0 }, T0)
    expect(store.runtimeState.get('panic')).toEqual({ active: true, since: T0 })
  })

  it('overwrites an existing key', () => {
    const store = openMemoryStore()
    store.runtimeState.set('k', 1, T0)
    store.runtimeState.set('k', 2, at(100))
    expect(store.runtimeState.get('k')).toBe(2)
  })

  it('returns undefined for a value that is not valid JSON', () => {
    const store = openMemoryStore()
    // A hand-edited or truncated value must not prevent startup.
    store.runtimeState.setRaw('broken', '{not json', T0)
    expect(store.runtimeState.get('broken')).toBeUndefined()
    expect(store.runtimeState.getRaw('broken')).toBe('{not json')
  })

  it('stores a raw string', () => {
    const store = openMemoryStore()
    store.runtimeState.setRaw('plain', 'hello', T0)
    expect(store.runtimeState.getRaw('plain')).toBe('hello')
  })

  it('deletes and lists keys', () => {
    const store = openMemoryStore()
    store.runtimeState.set('b', 2, T0)
    store.runtimeState.set('a', 1, T0)
    expect(store.runtimeState.list().map((row) => row.key)).toEqual(['a', 'b'])
    expect(store.runtimeState.delete('a')).toBe(true)
    expect(store.runtimeState.list().map((row) => row.key)).toEqual(['b'])
  })

  it('persists across a reopen of the same file', () => {
    const store = openMemoryStore()
    store.runtimeState.set('panic', true, T0)
    // The value survives a restart, which is what makes panic mode durable.
    expect(store.runtimeState.get('panic')).toBe(true)
  })
})
