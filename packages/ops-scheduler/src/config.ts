// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/scheduler/config` — the `scheduler` section.
 *
 * @module @argus-agent/scheduler/config
 */
import z from '@deepseek-ai/schemastery'
import type { Schema } from './schema-type.js'

/** The `scheduler` section. */
/** The misfire policies a schedule may have. */
export const MISFIRE_POLICIES = ['run_once', 'skip'] as const

/** One misfire policy. */
export type MisfirePolicy = (typeof MISFIRE_POLICIES)[number]

export interface SchedulerSection {
  /** Whether scheduling is active. */
  readonly enabled: boolean
  /** The shortest interval a cron expression may have. */
  readonly min_interval_minutes: number
  /** The default timezone for a schedule that does not name one. */
  readonly timezone: string | null
  /** How long before a due time the timer wakes, in milliseconds. */
  readonly grace_ms: number
  /** The misfire policy new schedules get. */
  readonly default_misfire: MisfirePolicy
  /** How many firing records to keep, for `/cron list` context. */
  readonly max_schedules: number
}

/** The `scheduler` schema. */
export const schedulerSchema: Schema = z
  .object({
    enabled: z.boolean().default(true),
    min_interval_minutes: z.number().min(1).default(1),
    timezone: z.union([z.string(), z.const(null)]).default(null),
    grace_ms: z.number().min(0).max(60_000).default(1_000),
    default_misfire: z.union([z.const('run_once'), z.const('skip')]).default('run_once'),
    max_schedules: z.number().min(1).default(500),
  })
  .default({})

/**
 * Build the section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function schedulerOf(raw: Record<string, unknown>): SchedulerSection {
  const parse = schedulerSchema as unknown as (value: unknown) => SchedulerSection
  const parsed = parse(raw['scheduler'] ?? {})
  const fallback = typeof raw['timezone'] === 'string' ? raw['timezone'] : null
  return {
    ...parsed,
    // The deployment's timezone is the natural default, so a schedule does not
    // have to repeat it. `scheduler.timezone` overrides it.
    timezone: parsed.timezone ?? fallback,
  }
}

/**
 * Whether a value is a misfire policy.
 *
 * @param value the value.
 * @returns whether it is one.
 */
export function isMisfirePolicy(value: unknown): value is MisfirePolicy {
  return value === 'run_once' || value === 'skip'
}
