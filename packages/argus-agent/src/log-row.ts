// == ARGUS AGENT PROJECT ==
/**
 * The log row: plugin logs to stderr.
 *
 * Cordis's only built-in log exporter is an in-memory buffer, and neither the base
 * nor the headless bundle mounts one that writes anywhere. Without this row every
 * `ctx.logger(...)` line — a bad bot token, a Telegram failure, a recovery report —
 * is invisible to `docker logs` and `journalctl`.
 *
 * One line per message: `<level> <logger> <text>`, no colors, so the journal and
 * the container log stay greppable. `debug` is left out.
 *
 * @module @argus-agent/argus-agent/log-row
 */
import { Logger, type Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'ops-log'

/** Cordis levels: error 0, info 1, warn 2, debug 3. A message passes when its level is at most this. */
const LEVEL = 2

/**
 * Register the stderr exporter. It is effect-scoped: unloading the row removes it.
 *
 * @param ctx the row's context.
 */
export function apply(ctx: Context): void {
  const exporter = {
    colors: 0,
    levels: { default: LEVEL },
    export(message: { type: string; name: string }) {
      process.stderr.write(`${message.type} ${message.name} ${Logger.format(exporter, message as never)}\n`)
    },
  }
  ctx.logger.exporter(exporter)
}
