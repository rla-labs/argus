// == ARGUS AGENT PROJECT ==
/**
 * Fixtures for the governor's tests.
 *
 * The snapshot builders exist so a table-driven test states only the fields a
 * case is about, and every other field has a documented default.
 */
import { micros, type Priority, type Scope } from '@argus-agent/types'
import type {
  BudgetState,
  GovernorSnapshot,
  PendingRequest,
  RunningAgent,
} from '../src/state.js'

/** Options for {@link snapshot}. */
export interface SnapshotOptions {
  panic?: boolean
  globalInteractiveOnly?: boolean
  globalMaxRunning?: number
  perProvider?: Record<string, number>
  adhocMaxRunning?: number
  reserveInteractive?: number
  providerBlocked?: Record<string, boolean>
  pausedProjects?: ReadonlySet<string>
  downgradedOwners?: ReadonlySet<string>
  budgets?: ReadonlyMap<Scope, BudgetState>
  running?: readonly Partial<RunningAgent>[]
  /** When true, NO model is priced. */
  pricesNothing?: boolean
}

/**
 * Build a snapshot with defaults.
 *
 * Every default is the *permissive* one, so a test that sets nothing describes a
 * healthy empty system and each case's overrides are the whole story.
 *
 * @param options the fields to override.
 * @returns the snapshot.
 */
export function snapshot(options: SnapshotOptions = {}): GovernorSnapshot {
  const running = new Map<string, RunningAgent>()
  for (const entry of options.running ?? []) {
    const agent: RunningAgent = {
      sessionId: entry.sessionId ?? 'session-1',
      owner: entry.owner ?? { kind: 'project', projectId: 'site' },
      runId: entry.runId ?? 'run-1',
      provider: entry.provider ?? 'fake',
      targetKind: entry.targetKind ?? 'project',
      startedAt: entry.startedAt ?? 0,
    }
    running.set(agent.sessionId, agent)
  }

  return {
    panic: options.panic ?? false,
    globalInteractiveOnly: options.globalInteractiveOnly ?? false,
    running,
    config: {
      globalMaxRunning: options.globalMaxRunning ?? 3,
      perProvider: options.perProvider ?? {},
      adhocMaxRunning: options.adhocMaxRunning ?? 1,
      reserveInteractive: options.reserveInteractive ?? 0,
    },
    providerBlocked: options.providerBlocked ?? {},
    pausedProjects: options.pausedProjects ?? new Set(),
    downgradedOwners: options.downgradedOwners ?? new Set(),
    budgets: options.budgets ?? new Map(),
    priced: options.pricesNothing === true ? () => false : () => true,
  }
}

/** Options for {@link projectRequest}. */
export interface RequestOptions {
  id?: string
  projectId?: string
  priority?: Priority
  provider?: string
  model?: { provider: string; model: string }
  submittedAt?: number
  source?: PendingRequest['source']
}

/** Build a project request. */
export function projectRequest(options: RequestOptions = {}): PendingRequest {
  return {
    id: options.id ?? 'req-1',
    priority: options.priority ?? 0,
    source: options.source ?? 'channel',
    target: { kind: 'project', projectId: options.projectId ?? 'site' },
    provider: options.provider ?? 'fake',
    model: options.model ?? { provider: 'fake', model: 'fake-model' },
    submittedAt: options.submittedAt ?? 0,
  }
}

/** Build an ad-hoc request. */
export function adhocRequest(
  options: RequestOptions & { runId?: string } = {},
): PendingRequest {
  return {
    id: options.id ?? 'req-1',
    priority: options.priority ?? 0,
    source: options.source ?? 'orchestrator',
    target: {
      kind: 'adhoc',
      runId: options.runId ?? 'adhoc-1',
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    provider: options.provider ?? 'fake',
    model: options.model ?? { provider: 'fake', model: 'fake-model' },
    submittedAt: options.submittedAt ?? 0,
  }
}

/** A budget state at a level. */
export function atLevel(scope: string, level: BudgetState['level']): BudgetState {
  return {
    scope: scope as Scope,
    period: 'day',
    level,
    pct: level === 'ok' ? 10 : level === 'info' ? 55 : level === 'soft' ? 85 : 100,
    limitMicros: micros(3_000_000),
    spentMicros: micros(level === 'hard' ? 3_000_000 : 1_000_000),
    overrideMicros: micros(0),
    overrideUntil: undefined,
    downgraded: false,
    paused: false,
  }
}
