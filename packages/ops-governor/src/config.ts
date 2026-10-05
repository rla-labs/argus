// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/governor/config` — the configuration schema.
 *
 * @module @argus-agent/governor/config
 */
import z from '@deepseek-ai/schemastery'
import type { Schema } from './schema-type.js'

/** The order in which budget actions escalate. */
export const SOFT_ACTIONS = ['warn', 'downgrade'] as const
/** What to do when a scope reaches its hard limit. */
export const HARD_ACTIONS = ['pause', 'reject_new'] as const
/** How a paused project treats a request that arrives while it is paused. */
export const PAUSED_POLICIES = ['keep', 'reject'] as const

/** The soft-threshold action. */
export type SoftAction = (typeof SOFT_ACTIONS)[number]
/** The hard-threshold action. */
export type HardAction = (typeof HARD_ACTIONS)[number]
/** How a paused project treats an arriving request. */
export type PausedPolicy = (typeof PAUSED_POLICIES)[number]

/** Concurrency limits. */
export interface ConcurrencyConfig {
  /** Maximum top-level agents running at once across the system. */
  readonly global_max_running: number
  /** Maximum running agents per provider route. */
  readonly per_provider: Readonly<Record<string, number>>
  /** Maximum running ad-hoc task agents. */
  readonly adhoc_max_running: number
  /**
   * Slots that priority 1–2 work may never take.
   *
   * A scheduled job that fills every slot leaves an interactive message waiting
   * behind it, which is the one case where the system feels broken to a human.
   */
  readonly reserve_interactive: number
}

/** Budget thresholds and actions. */
export interface BudgetsConfig {
  /** Notify at this percentage. */
  readonly info_pct: number
  /** Act at this percentage. */
  readonly soft_pct: number
  /** What the soft threshold does. */
  readonly soft_action: SoftAction
  /** What the hard threshold does. */
  readonly hard_action: HardAction
  /** Above this percentage of the global budget, only interactive work is admitted. */
  readonly global_interactive_only_pct: number
  /** Default daily limit in USD for a scope with no explicit budget row. */
  readonly default_day_usd: number
  /** Default monthly limit in USD. */
  readonly default_month_usd: number
}

/** Per-run limits. */
export interface LimitsConfig {
  /** Steps allowed in one run. */
  readonly max_steps_per_run: number
  /** Wall-clock minutes allowed in one run. */
  readonly max_wallclock_min: number
  /** How many identical consecutive tool calls count as a loop. */
  readonly loop_repeat_threshold: number
  /** How deep subagents may nest inside a project agent. */
  readonly max_subagent_depth: number
}

/** Queue behavior. */
export interface QueuesConfig {
  /** How long a request may stay pending before `ops/queue-stalled` fires. */
  readonly queue_stall_minutes: number
  /** How often the safety tick runs, in seconds. */
  readonly tick_seconds: number
}

/** The governor's whole configuration. */
export interface GovernorConfig {
  readonly concurrency: ConcurrencyConfig
  readonly budgets: BudgetsConfig
  readonly limits: LimitsConfig
  readonly queues: QueuesConfig
  /** How a paused project treats an arriving request. */
  readonly paused_policy: PausedPolicy
}

/** The `concurrency` section. */
export const concurrencySchema: Schema = z
  .object({
    global_max_running: z.number().min(1).default(3),
    per_provider: z.dict(z.number().min(1)).default({}),
    adhoc_max_running: z.number().min(0).default(1),
    reserve_interactive: z.number().min(0).default(1),
  })
  .default({})

/** The `budgets` section. */
export const budgetsSchema: Schema = z
  .object({
    info_pct: z.number().min(0).max(100).default(50),
    soft_pct: z.number().min(0).max(100).default(80),
    soft_action: z.union(SOFT_ACTIONS.map((value) => z.const(value))).default('warn'),
    hard_action: z.union(HARD_ACTIONS.map((value) => z.const(value))).default('pause'),
    global_interactive_only_pct: z.number().min(0).max(100).default(90),
    default_day_usd: z.number().min(0).default(10),
    default_month_usd: z.number().min(0).default(100),
  })
  .default({})

/** The `limits` section. */
export const limitsSchema: Schema = z
  .object({
    max_steps_per_run: z.number().min(1).default(60),
    max_wallclock_min: z.number().min(1).default(45),
    loop_repeat_threshold: z.number().min(2).default(5),
    max_subagent_depth: z.number().min(0).default(1),
  })
  .default({})

/** The `queues` section. */
export const queuesSchema: Schema = z
  .object({
    queue_stall_minutes: z.number().min(1).default(15),
    tick_seconds: z.number().min(1).default(5),
  })
  .default({})

/** The `paused_policy` key. */
export const pausedPolicySchema: Schema = z
  .union(PAUSED_POLICIES.map((value) => z.const(value)))
  .default('keep')

/**
 * Build the whole configuration from the raw document.
 *
 * Each section is validated independently, so a deployment may set only the keys
 * it cares about and inherit a default for every other section.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the configuration with every default applied.
 */
export function governorConfigOf(raw: Record<string, unknown>): GovernorConfig {
  const asFn = <T>(schema: Schema) => schema as unknown as (value: unknown) => T
  return {
    concurrency: asFn<ConcurrencyConfig>(concurrencySchema)(raw['concurrency'] ?? {}),
    budgets: asFn<BudgetsConfig>(budgetsSchema)(raw['budgets'] ?? {}),
    limits: asFn<LimitsConfig>(limitsSchema)(raw['limits'] ?? {}),
    queues: asFn<QueuesConfig>(queuesSchema)(raw['queues'] ?? {}),
    paused_policy: asFn<PausedPolicy>(pausedPolicySchema)(raw['paused_policy'] ?? 'keep'),
  }
}
