// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by the Argus Agent bundle.
 *
 * Every `ops/*` event in the system is declared here (or in the declaring
 * plugin's own `src/events.ts` via declaration merging into the interface
 * below), so listeners and emitters are type-checked against one vocabulary.
 *
 * @module @argus-agent/argus-agent/events
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The configuration layer should (re)load `ops.yaml`.
     *
     * Emitted when the bundle mounts with `defer: true`, and on an explicit
     * reload request. Listeners that depend on configuration values should
     * re-read `ctx.opsConfig` when this fires.
     *
     * @mode emit
     */
    'ops/config-load'(): void

    /**
     * The configuration was loaded or reloaded successfully.
     *
     * Emitted after `ctx.opsConfig` holds a fresh validated document.
     *
     * @param config the configuration that is now in force.
     * @mode emit
     */
    'ops/config-loaded'(config: { readonly configPath: string }): void
  }
}

export {}
