// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/store` — the persistence plugin.
 *
 * Registers `ctx.opsStore`, the only component in Argus Agent that touches SQLite
 * (ADR 0003). It opens the database, applies migrations, and exposes typed
 * repositories.
 *
 * @module @argus-agent/store
 */
import { mkdirSync } from 'node:fs'
import { InstanceLock, INSTANCE_LOCK_FILE } from './instance-lock.js'
import { join, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import: brings in `ctx.opsConfig` / `ctx.opsConfigRegistry`.
import type {} from '@argus-agent/types'
import { STORE_CONFIG_SECTION, storeConfigSchema, type StoreConfig } from './config.js'
import { OpsStore } from './service.js'
import './events.js'

export * from './connection.js'
export * from './migrations.js'
export * from './service.js'
export * from './types.js'
export * from './config.js'
export * from './instance-lock.js'
export {
  ApprovalsRepository,
  AuditRepository,
  BudgetsRepository,
  ChatContextRepository,
  InboundRepository,
  ProjectsRepository,
  RunsRepository,
  RuntimeStateRepository,
  SchedulesRepository,
  UsageRepository,
} from './repositories/index.js'
export type { InboundInput } from './repositories/inbound.js'
export type { RunInput } from './repositories/runs.js'
export type { BudgetInput } from './repositories/budgets.js'
export type { DailyDelta, ModelTotals, ScopeTotals } from './repositories/usage.js'

/** Stable Cordis plugin name. */
export const name = 'ops-store'

/**
 * The services this plugin requires before it can activate.
 *
 * Both are declared, and the pair is safe only because the loader validates
 * **lazily**: `opsConfig` is published as a Proxy whose first property read
 * assembles the schema. So the sequence is — the registry appears, this row
 * activates, it registers its `storage` section, and only then does reading
 * `ctx.opsConfig` trigger validation against the now-complete schema.
 *
 * Declaring `opsConfig` without lazy validation would deadlock: the store would
 * wait for a config whose validation needs the store's own section.
 */
export const inject = ['opsConfigRegistry', 'opsConfig', 'opsRawConfig']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Argus Agent persistence service. */
    opsStore: OpsStore
  }
}

/**
 * Resolve the database path from configuration.
 *
 * @param config the `storage` section.
 * @param dataDir the deployment's absolute data directory.
 * @returns the absolute database path.
 */
export function resolveDatabasePath(config: StoreConfig, dataDir: string): string {
  return isAbsolute(config.database) ? resolve(config.database) : join(dataDir, config.database)
}

/**
 * The absolute data directory, from the raw document.
 *
 * `ctx.opsConfig.dataDirAbs` would be the natural source, but reading it
 * triggers full validation — see the comment in `apply`. The resolution rules are
 * the loader's, kept here as one line rather than duplicated logic.
 *
 * @param raw the raw parsed document.
 * @returns the absolute data directory.
 */
function resolveDataDir(raw: Record<string, unknown>): string {
  const configured = raw['data_dir']
  return typeof configured === 'string' && configured.length > 0 ? resolve(configured) : '/data'
}

/**
 * Mount the store.
 *
 * The section is registered **first**, then the configuration is read. The read
 * is what triggers the loader's lazy validation, and by this point this plugin's
 * own section is part of the schema — which is the whole reason the loader
 * validates on first read rather than at activation.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  const section = ctx.opsConfigRegistry.extend(STORE_CONFIG_SECTION, storeConfigSchema)
  ctx.effect(() => section)

  // The SECTION is read from the raw document, not from `ctx.opsConfig`. Doing
  // so avoids triggering the bundle's full validation here: this row activates
  // early, and other plugins have not registered their sections yet, so a
  // perfectly valid key such as `pricing` would be reported as unknown. The
  // store needs only its own section and the root paths, both of which the raw
  // document has.
  //
  // The schema's defaults must be applied explicitly, because reading the raw
  // section yields `undefined` for every omitted key.
  const raw = ctx.opsRawConfig
  const config = storeConfigSchema(raw[STORE_CONFIG_SECTION] ?? {}) as StoreConfig
  const dataDir = resolveDataDir(raw)
  const databasePath = resolveDatabasePath(config, dataDir)

  // One process per data directory, before anything is opened or migrated.
  mkdirSync(dataDir, { recursive: true })
  const lock = InstanceLock.acquire(join(dataDir, INSTANCE_LOCK_FILE))
  ctx.effect(() => () => lock.release())

  const store = new OpsStore({
    path: databasePath,
    busyTimeoutMs: config.busy_timeout_ms,
  })

  ctx.provide('opsStore', store)
  ctx.effect(() => () => store.close())

  ctx.emit('ops/store-ready', { databasePath, migrations: store.migrationsApplied })

  if (config.integrity_check_on_open) {
    const integrity = store.integrity()
    if (integrity !== 'ok') {
      ctx.logger('ops-store').warn('database integrity check reported a problem: %s', integrity)
    }
  }
}
