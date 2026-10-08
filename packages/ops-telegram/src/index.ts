// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/telegram` — the Telegram channel adapter.
 *
 * It registers a `ChannelAdapter` with `ops-channel` and contains **no business
 * logic**: no routing, no allowlist, no command parsing. Access control is by
 * Telegram user id, and it lives in `ops-channel` where it belongs.
 *
 * @module @argus-agent/telegram
 */
import type { Context } from '@deepseek-ai/cordis'
import { TelegramChannelAdapter, type TelegramApi, type TelegramState } from './adapter.js'
import { telegramOf, telegramSchema, tokenWarning } from './config.js'
// Importing the declarations is what registers `opsChannel` and `opsCommands`
// on Cordis's `Context`; a type-only consumer needs these modules loaded.
import '@argus-agent/channel'
import '@argus-agent/commands'

export * from './adapter.js'
export * from './config.js'
export * from './convert.js'
export * from './queue.js'

/** Stable Cordis plugin name. */
export const name = 'ops-telegram'

/**
 * The services this plugin requires.
 *
 * `opsChannel` is required: an adapter with nothing to register against cannot do
 * anything at all, and mounting one would be a configuration mistake worth
 * reporting rather than tolerating.
 */
export const inject = ['opsConfigRegistry', 'opsRawConfig', 'opsChannel', 'opsCommands']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Telegram adapter, once it is registered. */
    opsTelegram: TelegramChannelAdapter
  }
}

/**
 * A Bot API surface to use instead of grammY's, for a test.
 *
 * Module-level rather than read from a config row: Cordis validates a row's
 * `config` against a plugin's `Config` schema and hands it to a **class**
 * constructor, and this plugin is a plain function export because that is the
 * shape every other Argus Agent plugin uses. A test sets this before booting; a
 * deployment never touches it.
 */
let injectedApi: TelegramApi | undefined

/**
 * Inject a Bot API surface, for a test.
 *
 * @param api the API, or `undefined` to clear it.
 */
export function setTelegramApi(api: TelegramApi | undefined): void {
  injectedApi = api
}

/**
 * Mount the Telegram adapter.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  // Contributed to the registry, so ops.yaml validates the section and the boot
  // check does not report it as an unknown key.
  const section = ctx.opsConfigRegistry.extend('telegram', telegramSchema)
  ctx.effect(() => section)

  const config = telegramOf(ctx.opsRawConfig)

  const warning = tokenWarning(config.bot_token)
  if (warning !== undefined) {
    // Reported and not fatal: a deployment may mount the adapter before its secret
    // is provisioned, and the rest of the system still works. The warning never
    // echoes the value — a token in a log is a leaked token.
    ctx.logger('ops-telegram').warn('%s', warning)
    return
  }

  const adapter = new TelegramChannelAdapter({
    token: config.bot_token as string,
    allowGroups: config.allow_groups,
    maxTextLength: config.max_text_length,
    maxFileBytes: config.max_file_bytes,
    sendIntervalMs: config.send_interval_ms,
    maxAttempts: config.max_attempts,
    registerCommands: config.register_commands,
    // The command menu Telegram shows comes from the command layer, so the two
    // cannot drift apart.
    commands: ctx.opsCommands.specs().map((spec) => ({ name: spec.name, description: spec.description })),
    ...(injectedApi === undefined ? {} : { api: injectedApi }),
    onState: (state: TelegramState, detail?: string) => {
      // Every transition is logged, which is what makes a silent bot diagnosable:
      // the state tells you whether it ever connected.
      const logger = ctx.logger('ops-telegram')
      if (state === 'failed' || state === 'reconnecting') {
        logger.warn('telegram %s%s', state, detail === undefined ? '' : `: ${detail}`)
      } else {
        logger.info('telegram %s%s', state, detail === undefined ? '' : `: ${detail}`)
      }
    },
  })

  ctx.provide('opsTelegram', adapter)

  const dispose = ctx.opsChannel.register(adapter)
  ctx.effect(() => () => {
    void dispose()
  })

  if (config.allow_groups) {
    ctx
      .logger('ops-telegram')
      .info('telegram.allow_groups is true; access is still checked by user id in ops-channel')
  }
}
