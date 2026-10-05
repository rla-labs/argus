// == ARGUS AGENT PROJECT ==
/**
 * The configuration *loader* row.
 *
 * Validates `ops.yaml` against the assembled schema and publishes
 * `ctx.opsConfig`.
 *
 * **Ordering.** The registry is provided by a separate row that activates
 * first, and every plugin that owns a section registers it during its own
 * `apply`. Cordis mounts rows concurrently and offers no "wait for all rows"
 * event, so this row cannot assume the schema is complete the moment it runs.
 * It therefore validates **on first read** rather than at activation: by the
 * time a plugin asks for its configuration, that plugin has necessarily already
 * registered its own section, and every other row has had the same chance.
 *
 * The validation is memoized, so the file is read and checked once.
 *
 * @module @argus-agent/argus-agent/loader-row
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LoadedOpsConfig } from '@argus-agent/types'
import { configRegistry } from './config.js'
import { loadOpsConfig, parseRawConfig, resolveConfigPath } from './loader.js'

/** Stable Cordis plugin name. */
export const name = 'ops-config'

/**
 * The registry must exist before this row activates.
 *
 * It provides the registry service; this row needs it to assemble the schema.
 * That is the whole dependency — the schema's completeness is handled by
 * validating lazily rather than by an ordering guarantee Cordis cannot give.
 */
export const inject = ['opsConfigRegistry']

/** Config accepted by the loader row. */
export interface Config {
  /** Explicit path to `ops.yaml`; otherwise `${ARGUS_AGENT_CONFIG}` or `<data_dir>/config/ops.yaml`. */
  readonly path?: string
}

/** Per-context memo of the validated document. */
const loadedByContext = new WeakMap<Context, LoadedOpsConfig>()

/**
 * Per-context memo of the raw parsed document.
 *
 * Published as `ctx.opsRawConfig` so a plugin can read its OWN section without
 * triggering the cross-section validation. That matters for ordering: the first
 * plugin to read `ctx.opsConfig` triggers validation, and if it reads before a
 * later plugin has registered its section, the unknown-key check fails for a key
 * that is perfectly valid. A plugin whose section is self-contained reads the raw
 * document and validates only its own slice.
 */
const rawByContext = new WeakMap<Context, Record<string, unknown>>()

/** How long no section may be contributed before the boot check runs. */
export const BOOT_CHECK_QUIET_MS = 1000

/** The context key under which the raw document is published. */
export const RAW_CONFIG_SERVICE = 'opsRawConfig'

/**
 * Load and validate `ops.yaml`, memoizing per context.
 *
 * @param ctx the row's context.
 * @param config the row's config.
 * @returns the validated configuration.
 * @throws {OpsConfigError} naming the invalid or unknown key.
 */
export function loadFor(ctx: Context, config: Config = {}): LoadedOpsConfig {
  const cached = loadedByContext.get(ctx)
  if (cached !== undefined) return cached

  const loaded = loadOpsConfig(configRegistry, { path: config.path })
  loadedByContext.set(ctx, loaded)
  return loaded
}

/**
 * Publish `opsConfig` as a service whose value is resolved on first access.
 *
 * A plain `Proxy` was the first attempt and it leaked: it intercepted every
 * property access, including the internal probes test frameworks and Cordis
 * itself perform, and each one triggered a config load — or threw for a key
 * that was never meant to be a config key.
 *
 * `ctx.provide` accepts a value with accessors, so the deferral lives on the
 * individual property instead: the object is real, and only the properties the
 * loader owns are lazy.
 *
 * @param ctx the row's context.
 * @param config the row's config.
 */
function provideLazyConfig(ctx: Context, config: Config): void {
  const target: Record<string, unknown> = {}
  // Only the keys the loader is responsible for are defined as accessors. Any
  // other property read (a framework probe, a `Symbol`) sees an ordinary
  // object with no such property.
  for (const key of [
    'timezone',
    'data_dir',
    'config_dir',
    'dsh_home',
    'configPath',
    'dataDirAbs',
    'projectsDir',
    'dshHomeAbs',
    'databasePath',
    'scratchDir',
    'stateDir',
    'backupsDir',
    'raw',
  ]) {
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => (loadFor(ctx, config) as unknown as Record<string, unknown>)[key],
    })
  }
  ctx.provide('opsConfig', target as unknown as LoadedOpsConfig)
}

/**
 * Publish a lazily-validated `opsConfig`.
 *
 * `ctx.provide` is effect-scoped, so unloading this row removes the service and
 * every dependent plugin unloads with it. Validation happens on the first read
 * of a configuration value, which is exactly the semantics needed: a plugin
 * reads its configuration inside its own `apply`, after registering its
 * section, so by then the whole schema is assembled.
 *
 * @param ctx the row's context.
 * @param config the row's config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // The raw document is published first and eagerly, because reading it never
  // depends on another plugin's section being registered.
  const path = config.path ?? resolveConfigPath()
  const raw = parseRawConfig(path)
  rawByContext.set(ctx, raw)
  ctx.provide(RAW_CONFIG_SERVICE, raw)

  provideLazyConfig(ctx, config)

  // Validate once at boot, so a bad file is reported without waiting for a plugin
  // to trip over it. Not immediately: plugins register their sections as they
  // activate, and validating before the last one has would report every later
  // section as an unknown key. The check runs once no section has been
  // contributed for BOOT_CHECK_QUIET_MS. A failure is a warning, not fatal: the
  // lazy path re-throws for whichever plugin actually reads a value.
  ctx.inject(['opsConfig'], (configCtx) => {
    configCtx.effect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const check = () => {
        try {
          const loaded = loadFor(configCtx, config)
          configCtx.emit('ops/config-loaded', { configPath: loaded.configPath })
        } catch (error) {
          configCtx
            .logger('ops-config')
            .warn('ops.yaml did not validate at boot: %s', (error as Error).message)
        }
      }
      // ponytail: a quiet period, not a "tree is ready" signal — Cordis 4 has none.
      const schedule = () => {
        clearTimeout(timer)
        timer = setTimeout(check, BOOT_CHECK_QUIET_MS)
        timer.unref?.()
      }
      const off = configRegistry.onExtend(schedule)
      schedule()
      return () => {
        off()
        clearTimeout(timer)
      }
    }, 'ops-config boot check')
  })
}
