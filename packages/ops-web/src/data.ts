// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/data` — what the dashboard shows, read from the services.
 *
 * Read only. Every change the web makes goes through a command, so this module
 * never writes and never decides anything.
 *
 * @module @argus-agent/web/data
 */
import type { OpsStore } from '@argus-agent/store'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsProjects } from '@argus-agent/projects'
import { ownerKey, type Owner, type Scope, type ToolPolicy } from '@argus-agent/types'

/** What the overview needs from the scheduler, when it is mounted. */
export interface SchedulePort {
  list(): ReadonlyArray<{ id: string; cron: string; project_id: string | null; prompt: string; enabled: boolean; next_run_at: number; model: string | null }>
}

/** What the settings page needs from the providers row. */
export interface ProvidersPort {
  keyStatus(): ReadonlyArray<{ provider: string; configured: boolean; writable: boolean }>
}

/** What the settings page needs from the front desk. */
export interface FrontDeskPort {
  currentModel(): string
}

/** The services the snapshots read. */
export interface DataSources {
  readonly store: OpsStore
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  readonly projects: OpsProjects
  readonly schedules: () => SchedulePort | undefined
  readonly providers: () => ProvidersPort | undefined
  readonly frontDesk: () => FrontDeskPort | undefined
  readonly now: () => number
}

/** Days of spending the trend shows. */
const TREND_DAYS = 14

/** One project, as the constellation draws it. */
export interface ProjectView {
  readonly id: string
  readonly description: string | null
  readonly status: string
  readonly model: string
  readonly running: boolean
  readonly waiting: boolean
  /** Today's spending against the project's daily budget, 0–100+, or null when unlimited. */
  readonly dayPct: number | null
  readonly dayMicros: number
  readonly invalid: string | null
}

/** The overview. */
export interface Overview {
  readonly now: number
  readonly panic: boolean
  readonly slots: { readonly used: number; readonly limit: number; readonly pending: number }
  readonly projects: readonly ProjectView[]
  readonly spend: {
    readonly dayMicros: number
    readonly dayLimitMicros: number | null
    readonly monthMicros: number
    readonly monthLimitMicros: number | null
    readonly trend: ReadonlyArray<{ readonly day: string; readonly micros: number }>
  }
  readonly runs: ReadonlyArray<{ readonly runId: string; readonly who: string; readonly model: string; readonly steps: number; readonly startedAt: number; readonly micros: number }>
  readonly approvals: ReadonlyArray<{ readonly id: string; readonly projectId: string | null; readonly action: string; readonly kind: string; readonly at: number }>
  readonly schedules: ReadonlyArray<{ readonly id: string; readonly cron: string; readonly who: string; readonly what: string; readonly enabled: boolean; readonly next: number }>
  readonly log: ReadonlyArray<{ readonly at: number; readonly actor: string; readonly action: string; readonly target: string | null }>
}

/** The settings page. */
export interface Settings {
  readonly defaults: { readonly tasks: string; readonly frontDesk: string | null }
  readonly keys: ReadonlyArray<{ readonly provider: string; readonly configured: boolean; readonly writable: boolean }>
  readonly projects: ReadonlyArray<{ readonly id: string; readonly model: string; readonly tools: ToolPolicy; readonly dayUsd: number; readonly monthUsd: number }>
}

/** Who an owner is, in a word. */
function labelOf(owner: Owner): string {
  return owner.kind === 'project' ? owner.projectId : owner.kind === 'adhoc' ? 'task' : 'front desk'
}

/** The day before `day` (`YYYY-MM-DD`), by calendar arithmetic on the label. */
function dayBefore(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - n)
  return date.toISOString().slice(0, 10)
}

/** A budget's limit and spend for a scope, from the governor's status. */
function budgetOf(status: ReturnType<OpsGovernor['status']>, scope: Scope, period: 'day' | 'month'): { limit: number | null; pct: number | null } {
  const state = status.budgets.find((entry) => entry.scope === scope && entry.period === period)
  return { limit: state?.limitMicros === undefined ? null : Number(state.limitMicros), pct: state?.pct ?? null }
}

/**
 * The overview, now.
 *
 * @param sources the services.
 * @returns the snapshot.
 */
export function overview(sources: DataSources): Overview {
  const { store, meter, governor, projects } = sources
  const status = governor.status()
  const pending = store.approvals.listPending()
  const waiting = new Set(pending.map((row) => row.project_id))
  const running = new Map(status.running.map((run) => [ownerKey(run.owner), run]))

  const ids = [...new Set([...projects.configuredIds(), ...store.projects.list().filter((row) => row.status !== 'archived').map((row) => row.id)])].sort()
  const projectViews: ProjectView[] = ids.map((id) => {
    const row = store.projects.get(id)
    const config = projects.configOf(id)
    const scope = `project:${id}` as Scope
    return {
      id,
      description: config?.description ?? row?.description ?? null,
      status: row?.status ?? 'idle',
      model: row?.model ?? (config === undefined ? '?' : `${config.provider}/${config.model}`),
      running: running.has(`project:${id}`),
      waiting: waiting.has(id),
      dayPct: budgetOf(status, scope, 'day').pct,
      dayMicros: Number(meter.spending(scope).dayMicros),
      invalid: projects.invalidOf(id)?.reason ?? null,
    }
  })

  const global = meter.spending('global')
  const trend = Array.from({ length: TREND_DAYS }, (_, index) => {
    const day = dayBefore(global.day, TREND_DAYS - 1 - index)
    return { day, micros: day === global.day ? Number(global.dayMicros) : (store.usage.daily('global', day)?.cost_micros ?? 0) }
  })

  return {
    now: sources.now(),
    panic: status.panic,
    slots: { used: status.slots.globalUsed, limit: status.slots.globalLimit, pending: status.slots.pending },
    projects: projectViews,
    spend: {
      dayMicros: Number(global.dayMicros),
      dayLimitMicros: budgetOf(status, 'global', 'day').limit,
      monthMicros: Number(global.monthMicros),
      monthLimitMicros: budgetOf(status, 'global', 'month').limit,
      trend,
    },
    runs: status.running.map((run) => ({
      runId: run.runId,
      who: labelOf(run.owner),
      model: store.runs.get(run.runId)?.model ?? run.provider,
      steps: run.steps,
      startedAt: run.startedAt,
      micros: Number(meter.runTotals(run.runId).costMicros),
    })),
    approvals: pending.map((row) => {
      const request = parseJson(row.request_json)
      return {
        id: row.id,
        projectId: row.project_id,
        action: typeof request['action'] === 'string' ? request['action'] : String(request['toolName'] ?? '?'),
        kind: typeof request['kind'] === 'string' ? request['kind'] : 'other',
        at: row.created_at,
      }
    }),
    schedules: (sources.schedules()?.list() ?? []).map((row) => ({
      id: row.id,
      cron: row.cron,
      who: row.project_id ?? 'task',
      what: row.prompt.length > 80 ? `${row.prompt.slice(0, 79)}…` : row.prompt,
      enabled: row.enabled,
      next: row.next_run_at,
    })),
    log: store.audit.recent(12).map((row) => ({ at: row.ts, actor: row.actor, action: row.action, target: row.target })),
  }
}

/**
 * The settings, now.
 *
 * @param sources the services.
 * @returns the snapshot.
 */
export function settings(sources: DataSources): Settings {
  const adhoc = sources.governor.adhocModel()
  return {
    defaults: { tasks: `${adhoc.provider}/${adhoc.model}`, frontDesk: sources.frontDesk()?.currentModel() ?? null },
    keys: (sources.providers()?.keyStatus() ?? []).map((entry) => ({ provider: entry.provider, configured: entry.configured, writable: entry.writable })),
    projects: sources.projects.configuredIds().flatMap((id) => {
      const config = sources.projects.configOf(id)
      return config === undefined
        ? []
        : [{ id, model: `${config.provider}/${config.model}`, tools: config.tools, dayUsd: config.budget.day_usd, monthUsd: config.budget.month_usd }]
    }),
  }
}

/** A JSON object, or an empty one. */
function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export { dayBefore }
