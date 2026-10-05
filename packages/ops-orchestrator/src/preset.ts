// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/orchestrator/preset` — the orchestrator's tool surface.
 *
 * Two mechanisms, applied together, because either alone has a gap:
 *
 * - **`restrict({ allow })`** narrows what the agent *inherits* from the global
 *   tool set. This is code, and it is the one that actually holds.
 * - **The preset's plugin list** decides what is mounted at all. This is
 *   configuration, and an operator can edit it.
 *
 * A restriction validates against the global set and **throws on an unknown
 * name** (SPIKES.md spike 6), so a typo fails the boot rather than silently
 * leaving a tool available. A scope's own registrations are exempt from its
 * restriction — which is why the orchestrator's tools are registered in the same
 * `setup` callback that applies the restriction, and are therefore always present.
 *
 * @module @argus-agent/orchestrator/preset
 */
import { ORCHESTRATOR_TOOLS } from './config.js'

/**
 * The tool restriction applied to the orchestrator's scope.
 *
 * **`allow: []`** — nothing is inherited from the global layer at all. This is the
 * only shape that works, and it is also the strongest:
 *
 * - `restrict()` validates its filter against the **global** tool set and throws on
 *   a name it does not know (SPIKES.md spike 6). A `deny` list would therefore have
 *   to name every dangerous tool exactly as some other plugin registered it — and
 *   would throw the moment one of those plugins is not mounted.
 * - A tool this package did not register is not reachable by any name, whether or
 *   not it is listed. That includes a tool a future dsh version adds, which is
 *   precisely the case a deny-list would miss.
 * - The orchestrator's own six tools ride through, because **a scope's own
 *   registrations are exempt from its restriction** — the documented exemption that
 *   this design depends on.
 *
 * The belt to this braces is the preset's plugin list: it mounts no dsh tool plugin
 * at all, so in a composition like the tests' there is nothing global to inherit.
 *
 * @returns the filter.
 */
export function orchestratorRestriction(): { readonly allow: readonly string[] } {
  return { allow: [] }
}

/**
 * The tool names this package registers for the orchestrator.
 *
 * Exported so the test that asserts the surface is exactly the allowed set reads
 * it from one place.
 *
 * @returns the names.
 */
export function orchestratorToolNames(): readonly string[] {
  return [...ORCHESTRATOR_TOOLS]
}

/** The preset's id, as `ops.yaml` names it. */
export const ORCHESTRATOR_PRESET_ID = 'ops-orchestrator'

/**
 * The preset's entry list.
 *
 * Empty of dsh's own tool plugins: no shell, no filesystem, no web. The
 * orchestrator's five tools are registered per-agent by the plugin, not mounted
 * here, because they close over the conversation's state.
 *
 * @returns the plugin rows.
 */
export function orchestratorPresetPlugins(): Array<{ id: string; name: string; config?: unknown }> {
  return []
}

/**
 * The preset definition.
 *
 * @returns the definition a registry can mount.
 */
export function orchestratorPreset(): {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly order: number
  readonly plugins: readonly { readonly id: string; readonly name: string }[]
} {
  return {
    id: ORCHESTRATOR_PRESET_ID,
    name: 'Ops orchestrator',
    description:
      'The front desk: routes work to projects and answers questions about the system. No shell, no file access, no web.',
    // Late, so a project's preset is resolved first and this one narrows it.
    order: 100,
    plugins: orchestratorPresetPlugins(),
  }
}
