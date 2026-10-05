// == ARGUS AGENT PROJECT ==
/**
 * The configuration *registry* row.
 *
 * This row activates **before** any plugin that owns a config section, because
 * a plugin registers its section during its own `apply` — and the section must
 * be registered before the document containing it can be validated.
 *
 * It publishes only the registry. The loader row validates `ops.yaml` lazily,
 * so no ordering gate is needed between them.
 *
 * @module @argus-agent/argus-agent/registry-row
 */
import type { Context } from '@deepseek-ai/cordis'
import { configRegistry } from './config.js'

/** Stable Cordis plugin name. */
export const name = 'ops-config-registry'

/**
 * Publish the shared section registry.
 *
 * `ctx.provide` is effect-scoped, so unloading this row removes the registry and
 * every dependent plugin unloads with it.
 *
 * @param ctx the row's context.
 */
export function apply(ctx: Context): void {
  ctx.provide('opsConfigRegistry', configRegistry)
}
