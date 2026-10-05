// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-commands`.
 *
 * @module @argus-agent/commands/events
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A command ran.
     *
     * Emitted after the handler returned, so a listener that reads state sees the
     * command's effect. A command that requested confirmation does **not** emit:
     * nothing changed yet.
     *
     * @param payload.name the command name, without a slash.
     * @param payload.userId who ran it.
     * @param payload.failed whether it returned an error.
     * @mode emit
     */
    'ops/command-run'(payload: {
      readonly name: string
      readonly userId: string
      readonly failed: boolean
    }): void
  }
}

export {}
