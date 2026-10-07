// == ARGUS AGENT PROJECT ==
/**
 * The price table: `provider/model` → USD per million tokens.
 *
 * A price is resolved from the first source that has one:
 *
 * 1. `ops.yaml` — an exact `provider/model`, then a `provider/*` glob. The
 *    operator always wins: a negotiated discount, a correction, a new model.
 * 2. A **local** provider (`local_providers`, default `ollama`) — free, and
 *    expected to be.
 * 3. For `openrouter`: the highest price among the model's providers (fetched for
 *    the models in use), else its listed price (refreshed daily), else `:free` as free.
 * 4. The catalog (`catalog.ts`): the snapshot shipped with Argus, replaced by a
 *    weekly refresh of the dataset; for OpenRouter ids, the vendor's price.
 * 5. Every other provider: pi-ai's model catalog (`provider-catalog.ts`), the one
 *    dsh routes with. A direct provider bills its published price, so tokens times
 *    this price is the bill.
 *
 * Any remote model that resolves to $0 needs the operator's confirmation.
 *
 * A model none of them prices stays unpriced, and `unknown_model_policy` decides.
 *
 * @module @argus-agent/meter/pricing
 */
import z from '@deepseek-ai/schemastery'
import type { MicroUsd, ModelRef } from '@argus-agent/types'
import type { Schema } from './schema-type.js'
import { CATALOG_PROVIDERS, OPENROUTER_VENDORS, modelKey, type Catalog, type CatalogEntry } from './catalog.js'

/** USD per million tokens for one model. */
export interface Price {
  /** Uncached input tokens. */
  readonly input: number
  /** Tokens read from the provider's prompt cache. */
  readonly cached: number
  /** Generated tokens. */
  readonly output: number
  /** Tokens written to the prompt cache. Defaults to `input` when not configured. */
  readonly cacheWrite?: number
}

/** Where a resolved price came from. */
export type PriceSource = 'config' | 'local' | 'openrouter' | 'openrouter-free' | 'catalog' | 'provider-catalog'

/** One resolved price entry, with where it came from. */
export interface ResolvedPrice extends Price {
  /** What matched: a `provider/model` or `provider/*` key, or the catalog's `provider/model`. */
  readonly matchedBy: string
  /** Whether the match was an exact key rather than a glob. */
  readonly exact: boolean
  readonly source: PriceSource
  /** For a catalog price: the model's status (`latest`, `legacy`, `retired`, …). */
  readonly status?: string
  /** For a catalog price: when the dataset last verified it. */
  readonly verifiedAt?: string | null
}

/** Whether every component of a price is zero. */
export function isFree(price: Price): boolean {
  return price.input === 0 && price.cached === 0 && price.output === 0 && (price.cacheWrite ?? 0) === 0
}

/** The `pricing` section schema. */
export const priceEntrySchema: Schema = z.object({
  input: z.number().default(0),
  cached: z.number().default(0),
  output: z.number().default(0),
  cache_write: z.number(),
})

/** How to treat a model with no price entry. */
export type UnknownModelPolicy = 'block' | 'warn'

/** The pricing-related configuration. */
export interface PricingConfig {
  readonly pricing: Readonly<Record<string, Price & { readonly cache_write?: number }>>
  readonly unknown_model_policy: UnknownModelPolicy
  /** Providers that run on the operator's own hardware and cost nothing per token. */
  readonly local_providers?: readonly string[]
}

/** The providers treated as local when `local_providers` is not set. */
export const DEFAULT_LOCAL_PROVIDERS: readonly string[] = ['ollama']

/** The `local_providers` key. */
export const localProvidersSchema: Schema = z.array(z.string()).default([...DEFAULT_LOCAL_PROVIDERS])

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
  private readonly local: ReadonlySet<string>
  /** Catalog entries by `datasetProvider/modelKey`. */
  private readonly catalog = new Map<string, CatalogEntry>()
  private catalogMeta: Catalog['meta'] | undefined
  /** OpenRouter's live prices by model id, and when they were fetched (YYYY-MM-DD). */
  private openRouter = new Map<string, Price>()
  private openRouterDate: string | null = null
  /** The highest price among each model's OpenRouter providers, which is what is charged. */
  private openRouterCeilings = new Map<string, Price>()

  /**
   * @param config the pricing configuration.
   * @param catalog the dataset catalog.
   * @param providerCatalog prices for the providers the dataset does not cover.
   */
  constructor(
    config: PricingConfig,
    catalog?: Catalog,
    private readonly providerCatalog?: (ref: ModelRef) => Price | undefined,
  ) {
    for (const [key, price] of Object.entries(config.pricing)) {
      if (key.endsWith('/*')) {
        this.globs.set(key.slice(0, -2), normalise(price))
      } else {
        this.exact.set(key, normalise(price))
      }
    }
    this.policy = config.unknown_model_policy
    this.local = new Set(config.local_providers ?? DEFAULT_LOCAL_PROVIDERS)
    if (catalog !== undefined) this.setCatalog(catalog)
  }

  /**
   * Replace the catalog — the shipped snapshot, or a refresh of the dataset.
   * @param catalog the catalog.
   */
  setCatalog(catalog: Catalog): void {
    this.catalog.clear()
    for (const entry of catalog.entries) {
      this.catalog.set(`${entry.provider}/${modelKey(entry.model)}`, entry)
    }
    this.catalogMeta = catalog.meta
  }

  /** Where the catalog came from and when it was retrieved. */
  get catalogInfo(): Catalog['meta'] | undefined {
    return this.catalogMeta
  }

  /**
   * Replace OpenRouter's live price list.
   * @param prices prices by OpenRouter model id (`vendor/model`, `vendor/model:free`).
   * @param fetchedAt when it was fetched, `YYYY-MM-DD`.
   */
  setOpenRouter(prices: ReadonlyMap<string, Price>, fetchedAt: string): void {
    this.openRouter = new Map(prices)
    this.openRouterDate = fetchedAt
  }

  /**
   * Replace the provider ceilings of the OpenRouter models in use.
   * @param ceilings the highest provider price, by OpenRouter model id.
   */
  setOpenRouterCeilings(ceilings: ReadonlyMap<string, Price>): void {
    this.openRouterCeilings = new Map(ceilings)
  }

  /** Whether an OpenRouter model has a provider ceiling. */
  hasOpenRouterCeiling(model: string): boolean {
    return this.openRouterCeilings.has(model)
  }

  /** When OpenRouter's prices were last loaded, or `null`. */
  get openRouterFetchedAt(): string | null {
    return this.openRouterDate
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
    if (exact !== undefined) return { ...exact, matchedBy: key, exact: true, source: 'config' }

    const glob = this.globs.get(ref.provider)
    if (glob !== undefined) return { ...glob, matchedBy: `${ref.provider}/*`, exact: false, source: 'config' }

    if (this.local.has(ref.provider)) {
      return { input: 0, cached: 0, output: 0, cacheWrite: 0, matchedBy: `${ref.provider} (local)`, exact: false, source: 'local' }
    }

    // OpenRouter ids are `vendor/model`, and `vendor/model:free` is a free variant.
    let datasetProvider = CATALOG_PROVIDERS[ref.provider]
    let model = ref.model
    if (ref.provider === 'openrouter') {
      // The ceiling over OpenRouter's providers, when known: the listed price is
      // only one provider's, and a request may be billed by a dearer one.
      const ceiling = this.openRouterCeilings.get(model)
      if (ceiling !== undefined) {
        return { ...ceiling, matchedBy: `${key} (highest provider)`, exact: true, source: 'openrouter', verifiedAt: this.openRouterDate }
      }
      const live = this.openRouter.get(model)
      if (live !== undefined) {
        return { ...live, matchedBy: key, exact: true, source: 'openrouter', verifiedAt: this.openRouterDate }
      }
      if (model.endsWith(':free')) {
        return { input: 0, cached: 0, output: 0, cacheWrite: 0, matchedBy: key, exact: true, source: 'openrouter-free' }
      }
      const slash = model.indexOf('/')
      if (slash > 0) {
        datasetProvider = OPENROUTER_VENDORS[model.slice(0, slash)]
        model = model.slice(slash + 1)
      }
    }
    const entry =
      datasetProvider === undefined
        ? undefined
        : this.catalog.get(`${datasetProvider}/${modelKey(model.replace(/:[\w-]+$/, ''))}`)
    if (entry === undefined) {
      // A router's price depends on where it routes; only its own rules above apply.
      const listed = ref.provider === 'openrouter' ? undefined : this.providerCatalog?.(ref)
      return listed === undefined ? undefined : { ...listed, matchedBy: key, exact: true, source: 'provider-catalog' }
    }
    return {
      input: entry.input,
      cached: entry.cached,
      output: entry.output,
      cacheWrite: entry.cacheWrite,
      matchedBy: `${entry.provider}/${entry.model}`,
      exact: true,
      source: 'catalog',
      status: entry.status,
      verifiedAt: entry.verifiedAt,
    }
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

/** A configured price, with `cache_write` (the YAML spelling) carried as `cacheWrite`. */
function normalise(price: Price & { readonly cache_write?: number }): Price {
  const cacheWrite = price.cache_write ?? price.cacheWrite
  return {
    input: price.input,
    cached: price.cached,
    output: price.output,
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  }
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
  /** Tokens written to the prompt cache; disjoint from `inputTokens`, like `cachedTokens`. */
  readonly cacheWriteTokens?: number
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
  // A provider with no separate cache-write price bills the written tokens as input.
  const writeMicros = (counts.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)
  return Math.round(inputMicros + cachedMicros + outputMicros + writeMicros) as MicroUsd
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
