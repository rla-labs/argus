// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/telegram` — the Telegram channel adapter.
 *
 * It registers a `ChannelAdapter` with `ops-channel` and contains **no business
 * logic**: no routing, no allowlist, no command parsing. Access control is by
 * Telegram user id, and it lives in `ops-channel` where it belongs.
 *
 * Telegram is optional. The token is `telegram.bot_token` when `ops.yaml` sets it
 * (fixed until a restart), else `TELEGRAM_BOT_TOKEN` from dsh's credentials store,
 * where `/key telegram` saves it and the launch environment wins. The adapter
 * starts when that token appears, restarts when it changes and stops when it goes,
 * with no restart of Argus.
 *
 * @module @argus-agent/telegram
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
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
 * reporting rather than tolerating. `credentials` is where the token is saved.
 */
export const inject = ['opsConfigRegistry', 'opsRawConfig', 'opsChannel', 'opsCommands', 'credentials']

/** The credential the token is saved under (`/key telegram`). */
export const TOKEN_NAME = 'TELEGRAM_BOT_TOKEN'

/**
 * Starts, restarts and stops the adapter as the token comes and goes. Changes are
 * applied one after another, so two quick changes cannot leave two bots polling.
 */
export class TelegramSwitch {
  private current: { readonly token: string; readonly stop: () => Promise<void> } | undefined
  private queue: Promise<void> = Promise.resolve()

  /** @param startWith starts an adapter with a token and returns how to stop it. */
  constructor(private readonly startWith: (token: string) => () => Promise<void>) {}

  /** The token the running adapter uses, if one runs. */
  get token(): string | undefined {
    return this.current?.token
  }

  /**
   * Use a token from now on; `undefined` stops the adapter.
   *
   * @param token the token, or `undefined`.
   * @returns when the change is applied.
   */
  set(token: string | undefined): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (token === this.current?.token) return
        const previous = this.current
        this.current = undefined
        await previous?.stop()
        if (token !== undefined) this.current = { token, stop: this.startWith(token) }
      })
      .catch(() => undefined)
    return this.queue
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
  const logger = ctx.logger('ops-telegram')

  const start = (token: string): (() => Promise<void>) => {
    const adapter = new TelegramChannelAdapter({
      token,
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
        if (state === 'failed' || state === 'reconnecting') {
          logger.warn('telegram %s%s', state, detail === undefined ? '' : `: ${detail}`)
        } else {
          logger.info('telegram %s%s', state, detail === undefined ? '' : `: ${detail}`)
        }
      },
    })
    return ctx.opsChannel.register(adapter)
  }
  const telegram = new TelegramSwitch(start)
  ctx.effect(() => () => void telegram.set(undefined))

  // ops.yaml's token, when it names one, is fixed; otherwise the credentials store.
  const fixed = telegramOf(ctx.opsRawConfig, {}).bot_token?.trim() || undefined
  const load = async (): Promise<void> => {
    let token = fixed
    if (token === undefined) {
      try {
        token = (await ctx.credentials.resolve(credentialRef(TOKEN_NAME)))?.value?.trim() || undefined
      } catch (error) {
        logger.warn('the Telegram token could not be read: %s', error instanceof Error ? error.message : String(error))
      }
    }
    if (token === undefined) {
      logger.info('Telegram is off: there is no bot token. Save one with /key telegram <token> (from @BotFather) and it starts at once.')
      return telegram.set(undefined)
    }
    const warning = tokenWarning(token)
    if (warning !== undefined) {
      // Reported and not fatal; the warning never echoes the value — a token in a
      // log is a leaked token.
      logger.warn('%s', warning)
      return telegram.set(undefined)
    }
    if (telegram.token !== undefined && telegram.token !== token) logger.info('the Telegram token changed; restarting the bot')
    return telegram.set(token)
  }
  void load()
  if (fixed === undefined) {
    ctx.on('credentials/reference-updated', (ref) => {
      if (String(ref) === TOKEN_NAME) void load()
    })
  }

  if (config.allow_groups) {
    logger.info('telegram.allow_groups is true; access is still checked by user id in ops-channel')
  }
}
