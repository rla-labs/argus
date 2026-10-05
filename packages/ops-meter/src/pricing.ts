// == ARGUS AGENT PROJECT ==
/**
 * The price table: `provider/model` → USD per million tokens.
 *
 * Prices live in `ops.yaml`, never in code, because they change without notice
 * and a deployment must be able to correct one without a release. The table
 * supports a `provider/*` glob, and the **most specific** match wins, so a
 * deployment can price a whole provider cheaply and then correct one model.
 *
 * @module @argus-agent/meter/pricing
 */
import z from '@deepseek-ai/schemastery'
import type { MicroUsd, ModelRef } from '@argus-agent/types'
import type { Schema } from './schema-type.js'

/** USD per million tokens for one model. */
export interface Price {
  /** Uncached input tokens. */
  readonly input: number
  /** Tokens read from the provider's prompt cache. */
  readonly cached: number
  /** Generated tokens. */
  readonly output: number
}

/** One resolved price entry, with the pattern that matched. */
export interface ResolvedPrice extends Price {
  /** The table key that matched: an exact `provider/model` or a `provider/*`. */
  readonly matchedBy: string
  /** Whether the match was an exact key rather than a glob. */
  readonly exact: boolean
}

/** The `pricing` section schema. */
export const priceEntrySchema: Schema = z.object({
  input: z.number().default(0),
  cached: z.number().default(0),
  output: z.number().default(0),
})

/** How to treat a model with no price entry. */
export type UnknownModelPolicy = 'block' | 'warn'

/** The pricing-related configuration. */
export interface PricingConfig {
  readonly pricing: Readonly<Record<string, Price>>
  readonly unknown_model_policy: UnknownModelPolicy
}

/**
 * The `pricing` section schema.
 *
 * `pricing` and `unknown_model_policy` are separate top-level keys in
 * `ops.yaml`, so the section schema covers both:
 *
 * ```yaml
 * pricing:
 *   anthropic/claude-sonnet-x: { input: 3, cached: 0.3, output: 15 }
 * unknown_model_policy: block
 * ```
 */
export const pricingSectionSchema: Schema = z.object({
  pricing: z.dict(priceEntrySchema).default({}),
  unknown_model_policy: z.union([z.const('block'), z.const('warn')]).default('block'),
})

/** The `pricing` table alone, for validating just that key. */
export const pricingTableSchema: Schema = z.dict(priceEntrySchema).default({})

/**
 * The price table.
 *
 * Built once from configuration and queried on every model request, so lookups
 * are a map hit followed by at most a glob scan.
 */
export class PriceTable {
  private readonly exact = new Map<string, Price>()
  private readonly globs = new Map<string, Price>()
  private readonly policy: UnknownModelPolicy

  /**
   * @param config the pricing configuration.
   */
  constructor(config: PricingConfig) {
    for (const [key, price] of Object.entries(config.pricing)) {
      if (key.endsWith('/*')) {
        this.globs.set(key.slice(0, -2), normalise(price))
      } else {
        this.exact.set(key, normalise(price))
      }
    }
    this.policy = config.unknown_model_policy
  }

  /**
   * Resolve one model's price.
   *
   * An exact `provider/model` key wins over a `provider/*` glob, which wins over
   * nothing. Within globs, the longest provider name wins, so a narrower glob is
   * never shadowed by a broader one.
   *
   * @param ref the model.
   * @returns the price and how it matched, or `undefined` when no entry applies.
   */
  resolve(ref: ModelRef): ResolvedPrice | undefined {
    const key = `${ref.provider}/${ref.model}`
    const exact = this.exact.get(key)
    if (exact !== undefined) return { ...exact, matchedBy: key, exact: true }

    const glob = this.globs.get(ref.provider)
    if (glob !== undefined) return { ...glob, matchedBy: `${ref.provider}/*`, exact: false }

    return undefined
  }

  /**
   * Whether the model is priced.
   * @param ref the model.
   * @returns whether an entry applies.
   */
  isPriced(ref: ModelRef): boolean {
    return this.resolve(ref) !== undefined
  }

  /** How to treat an unpriced model. */
  get unknownPolicy(): UnknownModelPolicy {
    return this.policy
  }

  /** Every configured key, sorted. For diagnostics. */
  keys(): string[] {
    return [...this.exact.keys(), ...[...this.globs.keys()].map((provider) => `${provider}/*`)].sort()
  }
}

/** Round a price's fields to integer micro-USD-friendly numbers. */
function normalise(price: Price): Price {
  return { input: price.input, cached: price.cached, output: price.output }
}

/**
 * The token counts one request reported.
 *
 * Counts are **disjoint** in dsh's vocabulary: `input` is uncached input only,
 * and `cached` is separate — so they are summed, not subtracted
 * (`dsh-llm/lib/types/types.d.ts`).
 */
export interface TokenCounts {
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
}

/**
 * Price one request in integer micro-USD.
 *
 * The money unit is micro-USD and the price is USD per **million** tokens, so
 * the conversion is `tokens × price × MICROS_PER_USD / 1_000_000` — which
 * simplifies to `tokens × price` when the price is expressed per million and the
 * result in micro-USD. The three terms are summed **before** the single rounding
 * step, because rounding each field separately would compound the error on every
 * request.
 *
 * @param price the resolved price.
 * @param counts the token counts.
 * @returns the cost in integer micro-USD.
 */
export function priceRequest(price: Price, counts: TokenCounts): MicroUsd {
  const inputMicros = counts.inputTokens * price.input
  const cachedMicros = counts.cachedTokens * price.cached
  const outputMicros = counts.outputTokens * price.output
  return Math.round(inputMicros + cachedMicros + outputMicros) as MicroUsd
}

/**
 * Price one request at zero.
 *
 * Used under `unknown_model_policy: warn`, where an unpriced model runs but is
 * accounted at zero rather than at a guess.
 *
 * @returns zero micro-USD.
 */
export function zeroCost(): MicroUsd {
  return 0 as MicroUsd
}
