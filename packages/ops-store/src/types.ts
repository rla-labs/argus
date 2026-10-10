// == ARGUS AGENT PROJECT ==
/**
 * Row types: the typed shapes repositories return.
 *
 * Rows are plain objects, never ORM entities. SQLite has no boolean and no
 * `undefined`, so this module owns the conversion in both directions: `0`/`1`
 * for booleans, `null` for an absent value, JSON text for a structured field.
 *
 * @module @argus-agent/store/types
 */
import type { ChannelAddress, MicroUsd, Owner, Priority, Scope } from '@argus-agent/types'

/** A project's status. */
export type ProjectStatus = 'active' | 'paused' | 'archived'

/** A project's persisted runtime state. Configuration lives in YAML. */
export interface ProjectRow {
  readonly id: string
  readonly cwd: string
  readonly provider: string
  readonly model: string
  readonly fallback_model: string | null
  readonly preset: string | null
  readonly description: string | null
  readonly session_id: string | null
  readonly status: ProjectStatus
  readonly created_at: number
  readonly updated_at: number
}

/** What a request's producer is. */
export type InboundSource = 'channel' | 'scheduler' | 'orchestrator' | 'project'

/** A request's lifecycle state. */
export type InboundStatus = 'pending' | 'admitted' | 'rejected' | 'done'

/** One received request, written before anything runs. */
export interface InboundRow {
  readonly id: string
  readonly source: InboundSource
  readonly project_id: string | null
  /** JSON-encoded content blocks. */
  readonly payload: string
  readonly priority: Priority
  readonly status: InboundStatus
  readonly reject_reason: string | null
  readonly created_at: number
  readonly admitted_at: number | null
  readonly run_id: string | null
  /** JSON-encoded {@link ChannelAddress}, or null. */
  readonly reply_chat: string | null
}

/** A run's terminal or in-flight state. */
export type RunStatus =
  | 'running'
  | 'completed'
  | 'aborted'
  | 'error'
  | 'budget_stopped'
  | 'limit_stopped'
  | 'interrupted'

/** One admitted request, from delivery to the agent returning to idle. */
export interface RunRow {
  readonly id: string
  readonly inbound_id: string | null
  readonly project_id: string | null
  readonly owner_key: string
  readonly session_id: string
  readonly provider: string
  readonly model: string
  readonly status: RunStatus
  readonly steps: number
  readonly started_at: number
  readonly ended_at: number | null
  readonly reply_chat: string | null
  readonly stop_reason: string | null
}

/** One model request's cost, the raw append-only record. */
export interface UsageEventRow {
  readonly id: number
  readonly ts: number
  readonly run_id: string | null
  readonly project_id: string | null
  readonly scope: Scope
  readonly root_session: string
  readonly session_id: string
  readonly provider: string
  readonly model: string
  readonly input_tokens: number
  readonly cached_tokens: number
  readonly output_tokens: number
  readonly cost_micros: number
}

/** A usage event as it is appended, before the store assigns an id. */
export type UsageEventInput = Omit<UsageEventRow, 'id'>

/** One scope's totals for one day. */
export interface UsageDailyRow {
  readonly day: string
  readonly scope: Scope
  readonly input_tokens: number
  readonly cached_tokens: number
  readonly output_tokens: number
  readonly cost_micros: number
}

/** A budget's limit and thresholds for one scope and period. */
export interface BudgetRow {
  readonly scope: Scope
  readonly period: 'day' | 'month'
  readonly limit_micros: number
  readonly info_pct: number
  readonly soft_pct: number
  readonly action_soft: 'warn' | 'downgrade'
  readonly action_hard: 'pause' | 'reject_new'
  readonly override_until: number | null
  readonly override_micros: number
}

/** What a schedule does when a firing was missed. */
export type MisfirePolicy = 'run_once' | 'skip'

/** One cron schedule. */
export interface ScheduleRow {
  readonly id: string
  readonly cron: string
  readonly timezone: string
  readonly project_id: string | null
  readonly prompt: string
  readonly reply_chat: string
  readonly enabled: boolean
  readonly last_run_at: number | null
  readonly next_run_at: number
  readonly misfire: MisfirePolicy
  readonly last_request_id: string | null
  readonly model: string | null
  readonly created_at: number
}

/** A schedule as it is created. */
export type ScheduleInput = Omit<ScheduleRow, 'enabled' | 'last_run_at' | 'last_request_id' | 'created_at'> &
  Partial<Pick<ScheduleRow, 'enabled' | 'last_run_at' | 'last_request_id' | 'created_at'>>

/** Which project a chat is currently working in. */
export interface ChatContextRow {
  readonly channel: string
  readonly chat_id: string
  readonly active_project_id: string | null
  readonly updated_at: number
}

/** One audit entry. */
export interface AuditRow {
  readonly id: number
  readonly ts: number
  readonly actor: string
  readonly action: string
  readonly target: string | null
  readonly details_json: string | null
}

/** An audit entry as it is written. */
export type AuditInput = Omit<AuditRow, 'id' | 'ts'> & { readonly ts?: number }

/** An approval's outcome. */
export type ApprovalStatus = 'pending' | 'granted' | 'denied' | 'timeout' | 'unavailable'

/** One approval request and its decision. */
export interface ApprovalRow {
  readonly id: string
  readonly run_id: string | null
  readonly project_id: string | null
  readonly request_json: string
  readonly status: ApprovalStatus
  readonly decided_by: string | null
  readonly decided_at: number | null
  readonly created_at: number
}

/** An approval as it is recorded. */
export type ApprovalInput = Omit<ApprovalRow, 'status' | 'decided_by' | 'decided_at' | 'created_at'> &
  Partial<Pick<ApprovalRow, 'status' | 'created_at'>>

/** Totals for one scope over one period. */
export interface UsageTotals {
  readonly input_tokens: number
  readonly cached_tokens: number
  readonly output_tokens: number
  readonly cost_micros: MicroUsd
}

/** An empty {@link UsageTotals}. */
export const ZERO_TOTALS: UsageTotals = {
  input_tokens: 0,
  cached_tokens: 0,
  output_tokens: 0,
  cost_micros: 0 as MicroUsd,
}

/** A run's live progress, as the meter tracks it. */
export interface RunProgress {
  readonly runId: string
  readonly steps: number
  readonly cost_micros: MicroUsd
  readonly input_tokens: number
  readonly output_tokens: number
}

/** The identity a run's usage is attributed to. */
export interface RunAttribution {
  readonly owner: Owner
  readonly scope: Scope
  readonly projectId: string | null
}

/** Decode a stored address, or `undefined` when it is malformed. */
export type { ChannelAddress }
