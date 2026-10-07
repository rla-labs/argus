// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/telegram/config` — the `telegram` section.
 *
 * @module @argus-agent/telegram/config
 */
import z from '@deepseek-ai/schemastery'
import type { Schema } from './schema-type.js'

/** The `telegram` section. */
export interface TelegramSection {
  /** The BotFather token; unset, `TELEGRAM_BOT_TOKEN` from the environment. */
  readonly bot_token: string | null
  /** Maximum characters per message, below Telegram's own 4096. */
  readonly max_text_length: number
  /** Maximum file size to send, in bytes. */
  readonly max_file_bytes: number
  /** Whether messages from groups are processed at all. */
  readonly allow_groups: boolean
  /** Whether to register the command menu with Telegram. */
  readonly register_commands: boolean
  /** The base delay between sends to one chat, in milliseconds. */
  readonly send_interval_ms: number
  /** How many sends may be retried before one is abandoned. */
  readonly max_attempts: number
  /** Whether long polling is used. Webhooks need a public domain. */
  readonly polling: boolean
}

/** The `telegram` schema. */
export const telegramSchema: Schema = z
  .object({
    bot_token: z.union([z.string(), z.const(null)]).default(null),
    max_text_length: z.number().min(100).max(4096).default(4000),
    max_file_bytes: z.number().min(1).default(50 * 1024 * 1024),
    allow_groups: z.boolean().default(false),
    register_commands: z.boolean().default(true),
    send_interval_ms: z.number().min(0).default(1_000),
    max_attempts: z.number().min(1).default(5),
    polling: z.boolean().default(true),
  })
  .default({})

/**
 * Build the section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function telegramOf(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): TelegramSection {
  const parse = telegramSchema as unknown as (value: unknown) => TelegramSection
  const parsed = parse(raw['telegram'] ?? {})
  // `bot_token` is materialized explicitly: schemastery does not apply a union
  // member's default when the whole section is omitted, so a deployment with no
  // `telegram:` block would otherwise get `undefined` where the type promises
  // `string | null` — and the token check would compare against a missing key.
  // Unset, it is `TELEGRAM_BOT_TOKEN`: the installers put the token there, so a
  // minimal ops.yaml need not mention it.
  const fromEnv = env['TELEGRAM_BOT_TOKEN']
  return { ...parsed, bot_token: parsed.bot_token ?? (fromEnv === undefined || fromEnv === '' ? null : fromEnv) }
}

/**
 * Whether a token looks usable.
 *
 * BotFather tokens are `<digits>:<base64ish>`. The check exists to catch an
 * unexpanded `${TELEGRAM_BOT_TOKEN}` — which is a plausible mistake and produces a
 * confusing 401 from Telegram rather than a clear message from here.
 *
 * @param token the token.
 * @returns whether it looks like a BotFather token.
 */
export function looksLikeToken(token: string | null): boolean {
  return token !== null && /^\d+:[A-Za-z0-9_-]{20,}$/.test(token)
}

/**
 * A warning for a token that does not look right.
 *
 * It never echoes the value: a token in a log is a leaked token.
 *
 * @param token the configured token.
 * @returns the warning, or `undefined` when the token looks fine.
 */
export function tokenWarning(token: string | null): string | undefined {
  if (token === null || token.trim().length === 0) {
    return 'telegram.bot_token is not set, so the adapter will not start. Set it to ${TELEGRAM_BOT_TOKEN} and export that variable.'
  }
  if (!looksLikeToken(token)) {
    return 'telegram.bot_token does not look like a BotFather token (<digits>:<secret>). It may be an unexpanded ${TELEGRAM_BOT_TOKEN}.'
  }
  return undefined
}
