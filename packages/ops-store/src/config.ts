// == ARGUS AGENT PROJECT ==
/**
 * Configuration for `ops-store`.
 *
 * @module @argus-agent/store/config
 */
import z from '@deepseek-ai/schemastery'

/** The `storage` section of `ops.yaml`. */
export interface StoreConfig {
  /**
   * Database file name, relative to `data_dir` unless absolute.
   *
   * A separate key from `data_dir` so a deployment can put the database on a
   * different volume than the project workspaces.
   */
  readonly database: string
  /** Milliseconds to wait for a lock before failing. */
  readonly busy_timeout_ms: number
  /** How long to keep raw usage events, in days. `usage_daily` is never pruned. */
  readonly usage_retention_days: number
  /** How long to keep finished `inbound` rows, in days. */
  readonly inbound_retention_days: number
  /** Whether to run `PRAGMA integrity_check` at startup. */
  readonly integrity_check_on_open: boolean
}

/** The section schema. */
export const storeConfigSchema = z.object({
  database: z.string().default('ops.sqlite').description('Database file, relative to data_dir'),
  busy_timeout_ms: z.number().default(5000).description('Lock wait before failing, in milliseconds'),
  usage_retention_days: z
    .number()
    .default(90)
    .description('Raw usage events to keep; usage_daily and audit_log are never pruned'),
  inbound_retention_days: z.number().default(7).description('Finished inbound rows to keep'),
  integrity_check_on_open: z.boolean().default(false).description('Run PRAGMA integrity_check at startup'),
})

/** The section name in `ops.yaml`. */
export const STORE_CONFIG_SECTION = 'storage'
