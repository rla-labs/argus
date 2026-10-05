// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-store`.
 *
 * @module @argus-agent/store/events
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The store opened and finished applying migrations.
     *
     * Emitted once per process, after `ctx.opsStore` is available. A plugin that
     * recovers state at startup (the governor restoring panic mode, the health
     * check reading the last backup) listens for this rather than racing the
     * service's availability.
     *
     * @param payload.databasePath the absolute database path.
     * @param payload.migrations the migration versions applied by this process.
     * @mode emit
     */
    'ops/store-ready'(payload: {
      readonly databasePath: string
      readonly migrations: readonly number[]
    }): void
  }
}

export {}
