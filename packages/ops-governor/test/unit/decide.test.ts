// == ARGUS AGENT PROJECT ==
/**
 * Table-driven tests for the pure decision functions.
 *
 * The prompt's design requirement: all decision logic is pure, and tested
 * exhaustively. Each case states a state, a request and the expected verdict, so
 * a reader can check the table against the specification without reading any
 * service code.
 */
import { describe, expect, it } from 'vitest'
import { micros, projectOwner, adhocOwner, type Scope } from '@argus-agent/types'
import {
  checkBudgets,
  decideAdmission,
  decideDowngrade,
  decideStep,
  detectLoop,
  evaluateBudget,
  levelOf,
  planStalled,
  planThresholds,
  stableStringify,
  toolCallKey,
  type Rejection,
} from '../../src/decide.js'
import {
  applicableScopes,
  countRunning,
  countRunningForProvider,
  effectiveLimit,
  overrideActive,
  slotView,
  slotsAllow,
  usdToMicros,
  type BudgetState,
  type PendingRequest,
  type ScopeBudget,
} from '../../src/state.js'
import { projectRequest, adhocRequest, snapshot } from '../helpers.js'

/** A budget state, with sensible defaults. */
function budgetState(overrides: Partial<BudgetState> & { scope: Scope }): BudgetState {
  return {
    period: 'day',
    level: 'ok',
    pct: 0,
    limitMicros: micros(1_000_000),
    spentMicros: micros(0),
    overrideMicros: micros(0),
    overrideUntil: undefined,
    downgraded: false,
    paused: false,
    ...overrides,
  }
}

/** A scope budget, with sensible defaults. */
function scopeBudget(overrides: Partial<ScopeBudget> & { scope: Scope }): ScopeBudget {
  return {
    period: 'day',
    limitMicros: micros(1_000_000),
    spentMicros: micros(0),
    overrideMicros: micros(0),
    overrideUntil: undefined,
    ...overrides,
  }
}

// ── applicableScopes ───────────────────────────────────────────────────────

describe('applicableScopes', () => {
  const cases: Array<[string, PendingRequest['target'], Scope[]]> = [
    ['a project is checked against itself and global', { kind: 'project', projectId: 'site' }, ['project:site', 'global']],
    ['an ad-hoc task is checked against adhoc and global', { kind: 'adhoc', runId: 'r1' }, ['adhoc', 'global']],
  ]

  it.each(cases)('%s', (_name, target, expected) => {
    expect(applicableScopes(target)).toEqual(expected)
  })
})

// ── slotView / slotsAllow ──────────────────────────────────────────────────

describe('slotView', () => {
  it('gives a scheduled request fewer slots than the global maximum', () => {
    const snap = snapshot({ globalMaxRunning: 3, reserveInteractive: 1 })
    const view = slotView(snap, projectRequest({ priority: 1 }))
    expect(view.globalLimit).toBe(3)
    // Priority 1 may not take the reserved slot.
    expect(view.globalEffectiveLimit).toBe(2)
  })

  it('gives an interactive request the full global maximum', () => {
    const snap = snapshot({ globalMaxRunning: 3, reserveInteractive: 1 })
    expect(slotView(snap, projectRequest({ priority: 0 })).globalEffectiveLimit).toBe(3)
  })

  it('never reports a negative limit', () => {
    // `reserve_interactive` larger than `global_max_running` would otherwise make
    // the effective limit negative and admit everything.
    const snap = snapshot({ globalMaxRunning: 1, reserveInteractive: 5 })
    expect(slotView(snap, projectRequest({ priority: 1 })).globalEffectiveLimit).toBe(0)
  })

  it('counts running agents by provider and by kind', () => {
    const snap = snapshot({
      running: [
        { sessionId: 'a', owner: projectOwner('x'), runId: 'r1', provider: 'anthropic', targetKind: 'project' },
        { sessionId: 'b', owner: adhocOwner('r2'), runId: 'r2', provider: 'anthropic', targetKind: 'adhoc' },
        { sessionId: 'c', owner: projectOwner('y'), runId: 'r3', provider: 'deepseek', targetKind: 'project' },
      ],
    })
    expect(countRunning(snap, 'project')).toBe(2)
    expect(countRunning(snap, 'adhoc')).toBe(1)
    expect(countRunningForProvider(snap, 'anthropic')).toBe(2)
    expect(countRunningForProvider(snap, 'none')).toBe(0)
  })
})

describe('slotsAllow', () => {
  const base: {
    globalUsed: number
    globalLimit: number
    globalEffectiveLimit: number
    providerUsed: number
    providerLimit: number | undefined
    adhocUsed: number
    adhocLimit: number
    providerBlocked: boolean
  } = {
    globalUsed: 0,
    globalLimit: 3,
    globalEffectiveLimit: 3,
    providerUsed: 0,
    providerLimit: undefined,
    adhocUsed: 0,
    adhocLimit: 1,
    providerBlocked: false,
  }

  const cases: Array<[string, Partial<typeof base>, boolean, string | undefined]> = [
    ['an empty system admits', {}, true, undefined],
    ['a full global budget waits', { globalUsed: 3 }, false, 'global_slots_full'],
    [
      'reserved slots report their own reason',
      { globalUsed: 2, globalEffectiveLimit: 2, globalLimit: 3 },
      false,
      'global_slots_reserved',
    ],
    ['a full provider waits', { providerUsed: 1, providerLimit: 1 }, false, 'provider_slots_full:1'],
    ['a full adhoc group waits', { adhocUsed: 1, adhocLimit: 1 }, false, 'adhoc_slots_full'],
    ['an inapplicable adhoc limit does not block', { adhocUsed: 9, adhocLimit: undefined }, true, undefined],
    ['a blocked provider waits', { providerBlocked: true }, false, 'provider_rate_limit'],
  ]

  it.each(cases)('%s', (_name, overrides, allowed, blockedBy) => {
    const result = slotsAllow({ ...base, ...overrides })
    expect(result.allowed).toBe(allowed)
    expect(result.blockedBy).toBe(blockedBy)
  })

  it('reports the first failing limit, not all of them', () => {
    // The order is fixed so a reason is deterministic: rate, then global, then
    // provider, then adhoc.
    const result = slotsAllow({
      ...base,
      globalUsed: 3,
      providerUsed: 5,
      providerLimit: 1,
      adhocUsed: 9,
    })
    expect(result.blockedBy).toBe('global_slots_full')
  })
})

// ── decideAdmission ────────────────────────────────────────────────────────

describe('decideAdmission', () => {
  const options = { pausedPolicy: 'keep' as const }

  /** Assert a verdict is a rejection with a code. */
  function expectReject(verdict: ReturnType<typeof decideAdmission>, code: Rejection['code']): Rejection {
    expect(verdict.kind).toBe('reject')
    if (verdict.kind !== 'reject') throw new Error('unreachable')
    expect(verdict.rejection.code).toBe(code)
    return verdict.rejection
  }

  it('admits into an empty system', () => {
    expect(decideAdmission(snapshot(), projectRequest(), options)).toEqual({ kind: 'admit' })
  })

  it('rejects everything in panic mode', () => {
    const verdict = decideAdmission(snapshot({ panic: true }), projectRequest(), options)
    expectReject(verdict, 'PANIC_MODE')
  })

  it('rejects panic even for an interactive request', () => {
    // Panic is absolute: no priority bypasses it.
    expectReject(
      decideAdmission(snapshot({ panic: true }), projectRequest({ priority: 0 }), options),
      'PANIC_MODE',
    )
  })

  it('rejects a request for an unknown project', () => {
    const verdict = decideAdmission(snapshot(), projectRequest({ projectId: 'ghost' }), {
      ...options,
      knownProjects: new Set(['site']),
    })
    expectReject(verdict, 'PROJECT_NOT_FOUND')
  })

  it('rejects a request for an invalid project with the file problem, not "not found"', () => {
    const verdict = decideAdmission(snapshot(), projectRequest({ projectId: 'site' }), {
      ...options,
      knownProjects: new Set(['other']),
      invalidProjects: new Map([['site', 'project "site" is ignored: site.yaml does not validate']]),
    })
    expectReject(verdict, 'PROJECT_INVALID')
    expect(verdict.kind === 'reject' && verdict.rejection.message).toContain('does not validate')
  })

  it('admits a request for a known project', () => {
    expect(
      decideAdmission(snapshot(), projectRequest({ projectId: 'site' }), {
        ...options,
        knownProjects: new Set(['site']),
      }),
    ).toEqual({ kind: 'admit' })
  })

  it('rejects scheduled work for a paused project', () => {
    const verdict = decideAdmission(
      snapshot({ pausedProjects: new Set(['site']) }),
      projectRequest({ priority: 1 }),
      options,
    )
    const rejection = expectReject(verdict, 'PROJECT_PAUSED')
    expect(rejection.scope).toBe('project:site')
  })

  it('KEEPS an interactive request pending for a paused project', () => {
    // The documented choice: a budget pause must not discard what a human typed.
    // The message waits, and an override or a rollover lets it through.
    const verdict = decideAdmission(
      snapshot({ pausedProjects: new Set(['site']) }),
      projectRequest({ priority: 0 }),
      options,
    )
    expect(verdict).toEqual({ kind: 'wait', blockedBy: 'project_paused' })
  })

  it('rejects an interactive request when the policy says reject', () => {
    const verdict = decideAdmission(
      snapshot({ pausedProjects: new Set(['site']) }),
      projectRequest({ priority: 0 }),
      { pausedPolicy: 'reject' },
    )
    expectReject(verdict, 'PROJECT_PAUSED')
  })

  it('rejects when the project budget is hard', () => {
    const verdict = decideAdmission(
      snapshot({
        budgets: new Map([['project:site' as Scope, budgetState({ scope: 'project:site' as Scope, level: 'hard' })]]),
      }),
      projectRequest(),
      options,
    )
    const rejection = expectReject(verdict, 'BUDGET_EXCEEDED')
    expect(rejection.scope).toBe('project:site')
    expect(rejection.period).toBe('day')
  })

  it('rejects when the GLOBAL budget is hard, even with project headroom', () => {
    // The global budget is what stops one project spending the system's money.
    const verdict = decideAdmission(
      snapshot({
        budgets: new Map([
          ['project:site' as Scope, budgetState({ scope: 'project:site' as Scope, level: 'ok' })],
          ['global' as Scope, budgetState({ scope: 'global' as Scope, level: 'hard' })],
        ]),
      }),
      projectRequest(),
      options,
    )
    expectReject(verdict, 'BUDGET_EXCEEDED').scope
    expect(expectReject(verdict, 'BUDGET_EXCEEDED').scope).toBe('global')
  })

  it('rejects when the adhoc budget is hard', () => {
    const verdict = decideAdmission(
      snapshot({
        budgets: new Map([['adhoc' as Scope, budgetState({ scope: 'adhoc' as Scope, level: 'hard' })]]),
      }),
      adhocRequest(),
      options,
    )
    expectReject(verdict, 'BUDGET_EXCEEDED').scope
    expect(expectReject(verdict, 'BUDGET_EXCEEDED').scope).toBe('adhoc')
  })

  it('does NOT consult the project budget for an ad-hoc request', () => {
    // An ad-hoc task has no project, so a paused project budget is irrelevant.
    const verdict = decideAdmission(
      snapshot({
        budgets: new Map([['project:site' as Scope, budgetState({ scope: 'project:site' as Scope, level: 'hard' })]]),
      }),
      adhocRequest(),
      options,
    )
    expect(verdict).toEqual({ kind: 'admit' })
  })

  it('still admits at the soft threshold', () => {
    const verdict = decideAdmission(
      snapshot({
        budgets: new Map([['project:site' as Scope, budgetState({ scope: 'project:site' as Scope, level: 'soft' })]]),
      }),
      projectRequest(),
      options,
    )
    expect(verdict).toEqual({ kind: 'admit' })
  })

  it('waits for non-interactive work above the global interactive-only threshold', () => {
    const verdict = decideAdmission(snapshot({ globalInteractiveOnly: true }), projectRequest({ priority: 1 }), options)
    expect(verdict).toEqual({ kind: 'wait', blockedBy: 'global_interactive_only' })
  })

  it('admits interactive work above the global interactive-only threshold', () => {
    expect(
      decideAdmission(snapshot({ globalInteractiveOnly: true }), projectRequest({ priority: 0 }), options),
    ).toEqual({ kind: 'admit' })
  })

  it('rejects a free remote model the operator has not confirmed, and says how to allow it', () => {
    const verdict = decideAdmission(
      { ...snapshot(), freeUnconfirmed: (model) => model.model.endsWith(':free') },
      projectRequest({ model: { provider: 'openrouter', model: 'deepseek/deepseek-flash:free' } }),
      options,
    )
    const rejection = expectReject(verdict, 'FREE_MODEL_UNCONFIRMED')
    expect(rejection.message).toContain('/allow-free openrouter/deepseek/deepseek-flash:free')
    // A confirmed or paid model is unaffected.
    expect(
      decideAdmission({ ...snapshot(), freeUnconfirmed: () => false }, projectRequest(), options).kind,
    ).toBe('admit')
  })

  it('rejects a model a check refuses (no API key), with the check\'s code and message', () => {
    const verdict = decideAdmission(
      {
        ...snapshot(),
        modelProblem: (model) =>
          model.provider === 'zai' ? { code: 'PROVIDER_KEY_MISSING', message: 'set ZAI_API_KEY' } : undefined,
      },
      projectRequest({ model: { provider: 'zai', model: 'glm-5.3-flash' } }),
      options,
    )
    expect(expectReject(verdict, 'PROVIDER_KEY_MISSING').message).toBe('set ZAI_API_KEY')
    expect(decideAdmission({ ...snapshot(), modelProblem: () => undefined }, projectRequest(), options).kind).toBe('admit')
  })

  it('rejects an unpriced model', () => {
    const verdict = decideAdmission(
      snapshot({ pricesNothing: true }),
      projectRequest({ model: { provider: 'x', model: 'y' } }),
      options,
    )
    const rejection = expectReject(verdict, 'UNPRICED_MODEL')
    expect(rejection.message).toContain('x/y')
  })

  it('checks the budget BEFORE the price', () => {
    // An exhausted budget is the more actionable failure, so it is reported.
    const verdict = decideAdmission(
      snapshot({
        pricesNothing: true,
        budgets: new Map([['project:site' as Scope, budgetState({ scope: 'project:site' as Scope, level: 'hard' })]]),
      }),
      projectRequest(),
      options,
    )
    expectReject(verdict, 'BUDGET_EXCEEDED')
  })

  it('attaches to a running agent instead of taking a new slot', () => {
    const snap = snapshot({
      globalMaxRunning: 1,
      running: [
        { sessionId: 'a', owner: projectOwner('site'), runId: 'run-1', provider: 'fake', targetKind: 'project' },
      ],
    })
    // The global limit is full, but the target is already running — a delivery
    // into a live agent queues in its inbox and adds no concurrency.
    expect(decideAdmission(snap, projectRequest(), options)).toEqual({ kind: 'admit', attachToRun: 'run-1' })
  })

  it('waits when the global limit is full for a DIFFERENT project', () => {
    const snap = snapshot({
      globalMaxRunning: 1,
      running: [
        { sessionId: 'a', owner: projectOwner('other'), runId: 'run-1', provider: 'fake', targetKind: 'project' },
      ],
    })
    const verdict = decideAdmission(snap, projectRequest(), options)
    expect(verdict).toEqual({ kind: 'wait', blockedBy: 'global_slots_full' })
  })

  it('attaches an ad-hoc request to its own running run', () => {
    const snap = snapshot({
      running: [
        { sessionId: 'a', owner: adhocOwner('r1'), runId: 'r1', provider: 'fake', targetKind: 'adhoc' },
      ],
    })
    expect(decideAdmission(snap, adhocRequest({ runId: 'r1' }), options)).toEqual({
      kind: 'admit',
      attachToRun: 'r1',
    })
  })

  it('does not attach an ad-hoc request to a different run', () => {
    const snap = snapshot({
      running: [
        { sessionId: 'a', owner: adhocOwner('r1'), runId: 'r1', provider: 'fake', targetKind: 'adhoc' },
      ],
    })
    expect(decideAdmission(snap, adhocRequest({ runId: 'r2' }), options).kind).toBe('wait')
  })

  it('does not attach a project request to an ad-hoc run', () => {
    const snap = snapshot({
      running: [
        { sessionId: 'a', owner: adhocOwner('r1'), runId: 'r1', provider: 'fake', targetKind: 'adhoc' },
      ],
    })
    expect(decideAdmission(snap, projectRequest(), options).kind).toBe('admit')
  })

  it('waits when the ad-hoc group is full', () => {
    const snap = snapshot({
      adhocMaxRunning: 1,
      running: [
        { sessionId: 'a', owner: adhocOwner('r1'), runId: 'r1', provider: 'fake', targetKind: 'adhoc' },
      ],
    })
    expect(decideAdmission(snap, adhocRequest({ runId: 'r2' }), options)).toEqual({
      kind: 'wait',
      blockedBy: 'adhoc_slots_full',
    })
  })

  it('admits a project request while the ad-hoc group is full', () => {
    // Separate pools: a stuck ad-hoc task must not block project work.
    const snap = snapshot({
      adhocMaxRunning: 1,
      running: [
        { sessionId: 'a', owner: adhocOwner('r1'), runId: 'r1', provider: 'fake', targetKind: 'adhoc' },
      ],
    })
    expect(decideAdmission(snap, projectRequest(), options)).toEqual({ kind: 'admit' })
  })

  it('waits when the provider limit is full', () => {
    const snap = snapshot({
      globalMaxRunning: 5,
      perProvider: { fake: 1 },
      running: [
        { sessionId: 'a', owner: projectOwner('other'), runId: 'r1', provider: 'fake', targetKind: 'project' },
      ],
    })
    expect(decideAdmission(snap, projectRequest(), options)).toEqual({
      kind: 'wait',
      blockedBy: 'provider_slots_full:1',
    })
  })

  it('waits when the provider rate window is exhausted', () => {
    const snap = snapshot({ providerBlocked: { fake: true } })
    expect(decideAdmission(snap, projectRequest(), options)).toEqual({
      kind: 'wait',
      blockedBy: 'provider_rate_limit',
    })
  })

  it('keeps a scheduled request out of the reserved slot while an interactive one fits', () => {
    // The interactive reservation, end to end: two of three slots are used and
    // one is reserved, so a scheduled request waits while an interactive admits.
    const snap = snapshot({
      globalMaxRunning: 3,
      reserveInteractive: 1,
      running: [
        { sessionId: 'a', owner: projectOwner('p1'), runId: 'r1', provider: 'fake', targetKind: 'project' },
        { sessionId: 'b', owner: projectOwner('p2'), runId: 'r2', provider: 'fake', targetKind: 'project' },
      ],
    })
    expect(decideAdmission(snap, projectRequest({ projectId: 'p9', priority: 1 }), options)).toEqual({
      kind: 'wait',
      blockedBy: 'global_slots_reserved',
    })
    expect(decideAdmission(snap, projectRequest({ projectId: 'p9', priority: 0 }), options)).toEqual({
      kind: 'admit',
    })
  })

  it('prefers the panic check over every other denial', () => {
    const snap = snapshot({
      panic: true,
      pausedProjects: new Set(['site']),
      pricesNothing: true,
    })
    expectReject(decideAdmission(snap, projectRequest(), options), 'PANIC_MODE')
  })

  it('prefers the pause check over the budget', () => {
    const snap = snapshot({
      pausedProjects: new Set(['site']),
      budgets: new Map([['project:site' as Scope, budgetState({ scope: 'project:site' as Scope, level: 'hard' })]]),
    })
    // Both apply; `PROJECT_PAUSED` is the more specific, actionable one.
    expectReject(decideAdmission(snap, projectRequest({ priority: 1 }), options), 'PROJECT_PAUSED')
  })
})

// ── budgets ────────────────────────────────────────────────────────────────

describe('levelOf', () => {
  const thresholds = { infoPct: 50, softPct: 80 }

  const cases: Array<[string, number, number, string]> = [
    ['0% is ok', 0, 1_000_000, 'ok'],
    ['49% is ok', 490_000, 1_000_000, 'ok'],
    ['50% is info', 500_000, 1_000_000, 'info'],
    ['79% is info', 790_000, 1_000_000, 'info'],
    ['80% is soft', 800_000, 1_000_000, 'soft'],
    ['99% is soft', 990_000, 1_000_000, 'soft'],
    ['100% is hard', 1_000_000, 1_000_000, 'hard'],
    ['over 100% is hard', 2_000_000, 1_000_000, 'hard'],
    ['a zero limit is hard at once', 0, 0, 'hard'],
  ]

  it.each(cases)('%s', (_name, spent, limit, expected) => {
    expect(
      levelOf(
        scopeBudget({ scope: 'global' as Scope, spentMicros: micros(spent), limitMicros: micros(limit) }),
        1_000,
        thresholds,
      ),
    ).toBe(expected)
  })

  it('is ok for an unlimited scope', () => {
    expect(
      levelOf(scopeBudget({ scope: 'global' as Scope, limitMicros: undefined, spentMicros: micros(9_999_999) }), 1_000, thresholds),
    ).toBe('ok')
  })
})

describe('effectiveLimit and overrides', () => {
  it('adds a live override', () => {
    const budget = scopeBudget({ scope: 'global' as Scope, overrideMicros: micros(500_000), overrideUntil: 5_000 })
    expect(effectiveLimit(budget, 1_000)).toBe(micros(1_500_000))
  })

  it('ignores an expired override', () => {
    const budget = scopeBudget({ scope: 'global' as Scope, overrideMicros: micros(500_000), overrideUntil: 1_000 })
    expect(effectiveLimit(budget, 1_000)).toBe(micros(1_000_000))
    expect(overrideActive(budget, 1_000)).toBe(false)
  })

  it('treats an override with no expiry as permanent', () => {
    const budget = scopeBudget({ scope: 'global' as Scope, overrideMicros: micros(500_000) })
    expect(overrideActive(budget, 9_999_999)).toBe(true)
    expect(effectiveLimit(budget, 9_999_999)).toBe(micros(1_500_000))
  })

  it('stays unlimited for an unlimited scope with an override', () => {
    const budget = scopeBudget({ scope: 'global' as Scope, limitMicros: undefined, overrideMicros: micros(1) })
    expect(effectiveLimit(budget, 1_000)).toBeUndefined()
  })

  it('un-pauses a hard budget once the override covers the spend', () => {
    // The override is what makes `/budget` able to resume a paused project.
    const spent = micros(1_200_000)
    const before = scopeBudget({ scope: 'global' as Scope, spentMicros: spent })
    expect(levelOf(before, 1_000, { infoPct: 50, softPct: 80 })).toBe('hard')

    const after = scopeBudget({
      scope: 'global' as Scope,
      spentMicros: spent,
      overrideMicros: micros(500_000),
    })
    expect(levelOf(after, 1_000, { infoPct: 50, softPct: 80 })).toBe('soft')
  })
})

describe('evaluateBudget', () => {
  it('reports the percentage and level', () => {
    const state = evaluateBudget(
      scopeBudget({ scope: 'project:site' as Scope, spentMicros: micros(600_000) }),
      1_000,
      { infoPct: 50, softPct: 80 },
      { downgraded: false, hardAction: 'pause' },
    )
    expect(state.level).toBe('info')
    expect(state.pct).toBeCloseTo(60)
    expect(state.downgraded).toBe(false)
  })

  it('marks a downgraded scope only once it passes a threshold', () => {
    const ok = evaluateBudget(
      scopeBudget({ scope: 'project:site' as Scope }),
      1_000,
      { infoPct: 50, softPct: 80 },
      { downgraded: true, hardAction: 'warn' as 'pause' },
    )
    expect(ok.downgraded).toBe(false)

    const soft = evaluateBudget(
      scopeBudget({ scope: 'project:site' as Scope, spentMicros: micros(900_000) }),
      1_000,
      { infoPct: 50, softPct: 80 },
      { downgraded: true, hardAction: 'pause' },
    )
    expect(soft.downgraded).toBe(true)
  })

  it('reports paused only when the hard action pauses', () => {
    const pausing = evaluateBudget(
      scopeBudget({ scope: 'global' as Scope, spentMicros: micros(2_000_000) }),
      1_000,
      { infoPct: 50, softPct: 80 },
      { downgraded: false, hardAction: 'pause' },
    )
    expect(pausing.paused).toBe(true)

    const rejecting = evaluateBudget(
      scopeBudget({ scope: 'global' as Scope, spentMicros: micros(2_000_000) }),
      1_000,
      { infoPct: 50, softPct: 80 },
      { downgraded: false, hardAction: 'reject_new' },
    )
    expect(rejecting.paused).toBe(false)
    expect(rejecting.level).toBe('hard')
  })
})

describe('planThresholds', () => {
  it('announces each level once', () => {
    const announced = new Set<string>()
    const states = [budgetState({ scope: 'project:site' as Scope, level: 'soft', pct: 85 })]

    const first = planThresholds(states, announced)
    // A jump to soft announces info as well, so a listener never sees `hard` or
    // `soft` without the lower warnings.
    expect(first.map((entry) => entry.level)).toEqual(['info', 'soft'])

    expect(planThresholds(states, announced)).toEqual([])
  })

  it('announces info, soft and hard in order when jumping to hard', () => {
    const announced = new Set<string>()
    const states = [budgetState({ scope: 'global' as Scope, level: 'hard', pct: 120 })]
    expect(planThresholds(states, announced).map((entry) => entry.level)).toEqual(['info', 'soft', 'hard'])
  })

  it('tracks a scope and period independently', () => {
    const announced = new Set<string>()
    const day = budgetState({ scope: 'global' as Scope, period: 'day', level: 'soft', pct: 90 })
    const month = budgetState({ scope: 'global' as Scope, period: 'month', level: 'soft', pct: 90 })
    expect(planThresholds([day, month], announced)).toHaveLength(4)
  })

  it('says nothing for an ok budget', () => {
    expect(planThresholds([budgetState({ scope: 'global' as Scope })], new Set())).toEqual([])
  })

  it('skips an unlimited scope', () => {
    // There is no percentage to report for a scope with no limit.
    const states = [budgetState({ scope: 'global' as Scope, level: 'soft', limitMicros: undefined, pct: undefined })]
    expect(planThresholds(states, new Set())).toEqual([])
  })
})

describe('checkBudgets', () => {
  it('returns nothing when no applicable scope is hard', () => {
    const snap = snapshot({
      budgets: new Map([['project:site' as Scope, budgetState({ scope: 'project:site' as Scope, level: 'soft' })]]),
    })
    expect(checkBudgets(snap, projectRequest())).toBeUndefined()
  })

  it('ignores a scope with no row', () => {
    expect(checkBudgets(snapshot(), projectRequest())).toBeUndefined()
  })
})

// ── decideStep ─────────────────────────────────────────────────────────────

describe('decideStep', () => {
  const limits = { maxSteps: 10, maxWallclockMs: 60_000, loopRepeatThreshold: 3 }
  const run = {
    runId: 'run-1',
    steps: 0,
    startedAt: 0,
    recentToolCalls: [] as string[],
    budgetLevel: 'ok' as const,
  }

  it('allows a healthy step', () => {
    expect(decideStep(run, limits, 1_000)).toEqual({ kind: 'allow' })
  })

  it('rejects at the step limit', () => {
    const verdict = decideStep({ ...run, steps: 10 }, limits, 1_000)
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'max_steps' })
  })

  it('allows the step just below the limit', () => {
    expect(decideStep({ ...run, steps: 9 }, limits, 1_000)).toEqual({ kind: 'allow' })
  })

  it('rejects past the wall-clock limit', () => {
    const verdict = decideStep(run, limits, 60_000)
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'max_wallclock' })
  })

  it('allows the step just inside the wall-clock limit', () => {
    expect(decideStep(run, limits, 59_999)).toEqual({ kind: 'allow' })
  })

  it('rejects a hard budget', () => {
    const verdict = decideStep({ ...run, budgetLevel: 'hard' }, limits, 1_000)
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'budget_stopped' })
  })

  it('reports budget_stopped over max_steps when both apply', () => {
    // The more actionable cause wins: an operator can raise a budget, but
    // nothing will make the step limit useful again.
    const verdict = decideStep({ ...run, budgetLevel: 'hard', steps: 99 }, limits, 999_999)
    expect(verdict).toMatchObject({ reason: 'budget_stopped' })
  })

  it('reports max_steps over max_wallclock when both apply', () => {
    const verdict = decideStep({ ...run, steps: 99 }, limits, 999_999)
    expect(verdict).toMatchObject({ reason: 'max_steps' })
  })

  it('rejects a detected loop', () => {
    const verdict = decideStep(
      { ...run, recentToolCalls: ['read\u0000{}', 'read\u0000{}', 'read\u0000{}'] },
      limits,
      1_000,
    )
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'loop_detected' })
    expect(verdict.kind === 'reject' ? verdict.detail : '').toContain('read')
  })

  it('does not reject a soft budget', () => {
    expect(decideStep({ ...run, budgetLevel: 'soft' }, limits, 1_000)).toEqual({ kind: 'allow' })
  })

  it('mentions the scope whose budget stopped the run', () => {
    const verdict = decideStep(
      { ...run, budgetLevel: 'hard', budgetScope: 'project:site' as Scope },
      limits,
      1_000,
    )
    expect(verdict.kind === 'reject' ? verdict.detail : '').toContain('project:site')
  })
})

// ── detectLoop ─────────────────────────────────────────────────────────────

describe('detectLoop', () => {
  const cases: Array<[string, string[], number, boolean]> = [
    ['an empty history is not a loop', [], 3, false],
    ['one call is not a loop', ['a\u0000{}'], 3, false],
    ['two identical calls below the threshold', ['a\u0000{}', 'a\u0000{}'], 3, false],
    ['three identical calls at the threshold', ['a\u0000{}', 'a\u0000{}', 'a\u0000{}'], 3, true],
    ['three identical calls above the threshold', ['a\u0000{}', 'a\u0000{}', 'a\u0000{}', 'a\u0000{}'], 3, true],
    [
      'a DIFFERENT tool breaks the run',
      ['a\u0000{}', 'b\u0000{}', 'a\u0000{}', 'a\u0000{}'],
      3,
      false,
    ],
    [
      'different arguments do not loop',
      ['a\u0000{"x":1}', 'a\u0000{"x":2}', 'a\u0000{"x":3}'],
      3,
      false,
    ],
    [
      'the same tool with identical args three times in a row',
      ['a\u0000{"x":1}', 'a\u0000{"x":1}', 'a\u0000{"x":1}'],
      3,
      true,
    ],
    [
      'an intervening different call resets the count',
      ['a\u0000{}', 'a\u0000{}', 'b\u0000{}', 'a\u0000{}'],
      3,
      false,
    ],
  ]

  it.each(cases)('%s', (_name, calls, threshold, expected) => {
    expect(detectLoop(calls, threshold)).toBe(expected)
  })

  it('is disabled below a threshold of two', () => {
    // A threshold of 1 would stop every run at its first tool call.
    expect(detectLoop(['a\u0000{}', 'a\u0000{}', 'a\u0000{}'], 1)).toBe(false)
    expect(detectLoop(['a\u0000{}'], 0)).toBe(false)
  })
})

describe('toolCallKey and stableStringify', () => {
  it('is order-independent for object keys', () => {
    // Two logically identical argument objects must produce one key, or a model
    // that reorders its JSON would defeat loop detection.
    expect(toolCallKey('read', { a: 1, b: 2 })).toBe(toolCallKey('read', { b: 2, a: 1 }))
  })

  it('distinguishes different values', () => {
    expect(toolCallKey('read', { a: 1 })).not.toBe(toolCallKey('read', { a: 2 }))
  })

  it('distinguishes different tools', () => {
    expect(toolCallKey('read', {})).not.toBe(toolCallKey('write', {}))
  })

  it('handles nested structures', () => {
    expect(stableStringify({ a: { c: 1, b: 2 } })).toBe('{"a":{"b":2,"c":1}}')
    expect(stableStringify([1, { b: 2, a: 1 }])).toBe('[1,{"a":1,"b":2}]')
  })

  it('handles scalars and null', () => {
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(1)).toBe('1')
    expect(stableStringify('x')).toBe('"x"')
    expect(stableStringify(true)).toBe('true')
  })
})

// ── downgrade ──────────────────────────────────────────────────────────────

describe('decideDowngrade', () => {
  const fallback = { provider: 'deepseek', model: 'flash' }

  it('downgrades a marked project', () => {
    expect(decideDowngrade(new Set(['project:site']), 'site', fallback)).toEqual(fallback)
  })

  it('leaves an unmarked project alone', () => {
    expect(decideDowngrade(new Set(['project:other']), 'site', fallback)).toBeUndefined()
  })

  it('leaves a project with no fallback alone', () => {
    expect(decideDowngrade(new Set(['project:site']), 'site', undefined)).toBeUndefined()
  })

  it('leaves an ad-hoc task alone', () => {
    // An ad-hoc task has no project and so no configured fallback.
    expect(decideDowngrade(new Set(['adhoc']), undefined, fallback)).toBeUndefined()
  })
})

// ── planStalled ────────────────────────────────────────────────────────────

describe('planStalled', () => {
  it('reports a request that waited too long', () => {
    const reported = new Set<string>()
    const pending = [projectRequest({ id: 'a', submittedAt: 0 })]
    expect(planStalled(pending, 900_000, 900_000, reported).map((r) => r.id)).toEqual(['a'])
  })

  it('reports a request only once', () => {
    const reported = new Set<string>()
    const pending = [projectRequest({ id: 'a', submittedAt: 0 })]
    planStalled(pending, 900_000, 900_000, reported)
    expect(planStalled(pending, 1_800_000, 900_000, reported)).toEqual([])
  })

  it('says nothing for a fresh request', () => {
    expect(planStalled([projectRequest({ id: 'a', submittedAt: 899_000 })], 900_000, 900_000, new Set())).toEqual([])
  })
})

// ── usdToMicros ────────────────────────────────────────────────────────────

describe('usdToMicros', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [1, 1_000_000],
    [0.5, 500_000],
    [3, 3_000_000],
    [0.000001, 1],
    [40, 40_000_000],
  ]

  it.each(cases)('converts $%s to %s micro-USD', (usd, expected) => {
    expect(usdToMicros(usd)).toBe(expected)
  })

  it('stays exact for a fractional cent', () => {
    // 0.001 USD a thousand times is exactly one dollar.
    let total = 0
    for (let index = 0; index < 1000; index += 1) total += usdToMicros(0.001)
    expect(total).toBe(1_000_000)
  })
})
