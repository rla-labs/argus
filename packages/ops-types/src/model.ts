// == ARGUS AGENT PROJECT ==
/**
 * Model references and money.
 *
 * @module @argus-agent/types/model
 */

/** A provider route plus a provider-owned model id. */
export interface ModelRef {
  readonly provider: string
  readonly model: string
}

/**
 * Render a model reference as `provider/model`.
 * @param ref the reference to render.
 * @returns the formatted string.
 */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`
}

/**
 * Parse `provider/model`.
 *
 * The split is on the **first** slash, so a model id that itself contains a
 * slash (`meta-llama/Llama-3-70B`) survives round-tripping.
 *
 * @param value the string to parse.
 * @returns the reference, or `undefined` when the string is not a valid reference.
 */
export function parseModelRef(value: string): ModelRef | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  const provider = value.slice(0, slash)
  const model = value.slice(slash + 1)
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Whether two model references are the same.
 * @param a first reference.
 * @param b second reference.
 * @returns whether they are equal.
 */
export function modelRefsEqual(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model
}

/**
 * Money in integer micro-USD: 1 USD = 1_000_000.
 *
 * Every money value in Argus Agent — database columns, config limits, computed
 * costs — is a `MicroUsd`. Floats are never used for money, because a budget
 * check that compares accumulated floats drifts and can spend past its limit.
 * Conversion to a decimal string happens only for display.
 */
export type MicroUsd = number & { readonly __brand: 'MicroUsd' }

/** Micro-USD per US dollar. */
export const MICROS_PER_USD = 1_000_000

/**
 * Convert whole US dollars to micro-USD.
 * @param amount dollars.
 * @returns the amount in micro-USD.
 */
export function usd(amount: number): MicroUsd {
  return Math.round(amount * MICROS_PER_USD) as MicroUsd
}

/**
 * Admit an integer as micro-USD.
 * @param micros an integer number of micro-USD.
 * @returns the branded value.
 * @throws {TypeError} when the value is not a safe non-negative integer.
 */
export function micros(value: number): MicroUsd {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`micros: expected a non-negative safe integer, got ${String(value)}`)
  }
  return value as MicroUsd
}

/**
 * Add micro-USD amounts.
 * @param a first amount.
 * @param b second amount.
 * @returns the sum.
 */
export function addMicros(a: MicroUsd, b: MicroUsd): MicroUsd {
  return (a + b) as MicroUsd
}

/**
 * Format micro-USD for display.
 *
 * Always six decimal places, so a column of costs aligns and a sub-cent cost is
 * never displayed as `$0.00`.
 *
 * @param amount the amount to format.
 * @param options prefix and precision.
 * @returns the formatted string.
 */
export function formatUsd(
  amount: MicroUsd,
  options: { withSymbol?: boolean; decimals?: number } = {},
): string {
  const decimals = options.decimals ?? 6
  const value = amount / MICROS_PER_USD
  const text = value.toFixed(decimals)
  return options.withSymbol === false ? text : `$${text}`
}

/**
 * Parse a user-supplied money amount into micro-USD.
 *
 * Accepts what a person types in a command: `2`, `2.5`, `$2`, `2 usd`.
 *
 * @param value the text to parse.
 * @returns the amount in micro-USD, or `undefined` when unparseable.
 */
export function parseUsd(value: string): MicroUsd | undefined {
  const cleaned = value.trim().replace(/^\$/, '').replace(/\s*usd$/i, '').trim()
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return usd(parsed)
}
