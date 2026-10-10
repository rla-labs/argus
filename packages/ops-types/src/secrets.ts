// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/types/secrets` — whether a message carries an API key.
 *
 * A key pasted into the chat as free text would go to the front desk, and so to a
 * model. `ops-channel` checks every message with this before routing it.
 *
 * @module @argus-agent/types/secrets
 */

/**
 * The shapes of the keys people paste: OpenAI, Anthropic, DeepSeek and OpenRouter
 * (`sk-…`), Google (`AIza…`), Groq (`gsk_…`), xAI (`xai-…`), Hugging Face (`hf_…`),
 * GitHub tokens, and a Telegram bot token. A provider whose keys have no prefix is
 * not caught; `/key` is the way to send one.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bgsk_[A-Za-z0-9]{20,}/,
  /\bxai-[A-Za-z0-9]{20,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/,
]

/**
 * Whether a text contains something shaped like an API key or token.
 *
 * @param text the message.
 * @returns whether it does.
 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * The last four characters of a key, for a confirmation that names it without
 * repeating it.
 *
 * @param key the key.
 * @returns `…abcd`.
 */
export function keyTail(key: string): string {
  return `…${key.trim().slice(-4)}`
}
