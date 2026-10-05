// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/health/config` — the `health` section.
 *
 * @module @argus-agent/health/config
 */
import z from '@deepseek-ai/schemastery'
import type { Schema } from './schema-type.js'

/** The `health` section. */
export interface HealthSection {
  /** Whether the health plugin is mounted at all. */
  readonly enabled: boolean
  /** Whether the HTTP endpoint is served. */
  readonly endpoint: boolean
  /** The port, on loopback only. */
  readonly port: number
  /** The local time the daily report is sent, `HH:MM`. */
  readonly daily_report_time: string
  /** Whether the daily report is sent at all. */
  readonly daily_report: boolean
  /** The local time the database backup runs, `HH:MM`. */
  readonly backup_time: string
  /** Whether backups run at all. */
  readonly backup: boolean
  /** How many backups to keep. */
  readonly backup_keep: number
  /** The disk-used percentage worth warning about. */
  readonly disk_warn_pct: number
  /** The minimum gap between threshold alerts, in minutes. */
  readonly alert_interval_minutes: number
  /** Whether the startup report is sent. */
  readonly startup_report: boolean
  /** How many provider errors in a window are worth alerting about. */
  readonly error_alert_threshold: number
}

/** `HH:MM`, 24-hour. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** The `health` schema. */
export const healthSchema: Schema = z
  .object({
    enabled: z.boolean().default(true),
    endpoint: z.boolean().default(true),
    port: z.number().min(1).max(65_535).default(3090),
    daily_report_time: z.string().default('09:00'),
    daily_report: z.boolean().default(true),
    backup_time: z.string().default('03:30'),
    backup: z.boolean().default(true),
    backup_keep: z.number().min(1).default(7),
    disk_warn_pct: z.number().min(1).max(100).default(85),
    alert_interval_minutes: z.number().min(1).default(60),
    startup_report: z.boolean().default(true),
    error_alert_threshold: z.number().min(1).default(5),
  })
  .default({})

/**
 * Build the section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function healthOf(raw: Record<string, unknown>): HealthSection {
  const parse = healthSchema as unknown as (value: unknown) => HealthSection
  const parsed = parse(raw['health'] ?? {})
  if (!TIME_PATTERN.test(parsed.daily_report_time)) {
    throw new Error(`health.daily_report_time must be HH:MM, got ${JSON.stringify(parsed.daily_report_time)}`)
  }
  if (!TIME_PATTERN.test(parsed.backup_time)) {
    throw new Error(`health.backup_time must be HH:MM, got ${JSON.stringify(parsed.backup_time)}`)
  }
  return parsed
}

/**
 * Parse `HH:MM` into hours and minutes.
 *
 * @param time the time.
 * @returns the parts, or `undefined` when malformed.
 */
export function parseTimeOfDay(time: string): { readonly hours: number; readonly minutes: number } | undefined {
  const match = TIME_PATTERN.exec(time)
  if (match === null) return undefined
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

/**
 * The next occurrence of a local time of day, in epoch milliseconds.
 *
 * The local time is resolved through `Intl`, so a timezone with a DST transition
 * lands on the right wall clock rather than drifting by an hour twice a year.
 *
 * @param time the local time, `HH:MM`.
 * @param timezone the IANA timezone.
 * @param now the current time.
 * @returns the next occurrence.
 */
export function nextTimeOfDay(time: string, timezone: string, now: number): number {
  const parsed = parseTimeOfDay(time)
  if (parsed === undefined) return now + 24 * 3_600_000

  // Walk forward in one-minute steps, starting STRICTLY after `now`. A day is 1440
  // steps, which is trivial, and it sidesteps every DST edge case: the answer is
  // whichever instant `Intl` renders as the requested wall clock.
  //
  // `Math.floor(...) + 1` rather than `Math.ceil(...)`: when `now` is EXACTLY on a
  // minute boundary, `ceil` returns `now` itself — and a timer armed at a delay of
  // zero fires immediately, re-arms to the same instant, and spins forever.
  const start = (Math.floor(now / 60_000) + 1) * 60_000
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const target = `${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}`

  for (let step = 0; step <= 2880; step += 1) {
    const candidate = start + step * 60_000
    if (formatter.format(new Date(candidate)) === target) return candidate
  }
  return now + 24 * 3_600_000
}
