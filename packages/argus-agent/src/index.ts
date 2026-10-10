// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/argus-agent` — the bundle that composes every ops-* plugin.
 *
 * The bundle's Cordis patch (`cordis.patch.yml`) lists one row per ops plugin,
 * in dependency order. Two of those rows are the bundle's own:
 *
 * - `ops-config-registry` publishes `ctx.opsConfigRegistry`, so a plugin can
 *   contribute its configuration section during its own activation.
 * - `ops-config` injects the registry, validates `ops.yaml` against the
 *   complete schema, and publishes `ctx.opsConfig`.
 *
 * The split exists because Cordis mounts rows concurrently as their
 * dependencies resolve. A single row could not both provide the registry and
 * validate a document whose sections are contributed by rows that have not run
 * yet; two rows plus a dependency express that ordering declaratively.
 *
 * @module @argus-agent/argus-agent
 */
// Importing the declarations is what registers them on Cordis's `Events`
// interface; a type-only consumer needs this module to see them.
import './events.js'

export * from './config.js'
export * from './loader.js'
export * from './events.js'

export * as configRegistryRow from './registry-row.js'
export * as configLoaderRow from './loader-row.js'
export { OpsProviders, buildRoutes, envKeys, type KeyStore, type KeyInfo, type KeyStatus, type KeyChange, providersSchema, SIGN_IN_PROVIDERS, type DeclaredProvider, type ProviderRoute } from './providers-row.js'
