// == ARGUS AGENT PROJECT ==
/**
 * Keeping prices current: a weekly refresh of the dataset, a daily one of
 * OpenRouter's own price list.
 *
 * The network is consulted on a timer, never on the path of a request: a price
 * decision always reads the table in memory, so a slow or dead network can delay
 * an update but never block a run. What a refresh brings is validated before it
 * replaces anything, saved in the database (so a restart does not fall back to
 * the shipped snapshot), and applied at once. A refresh that fails keeps the last
 * good prices and says so.
 *
 * @module @argus-agent/meter/refresh
 */
import type { ModelRef } from '@argus-agent/types'
import type { OpsStore } from '@argus-agent/store'
import { DATASET_URL, catalogFromExport, type Catalog } from './catalog.js'
import type { Price, PriceTable, ResolvedPrice } from './pricing.js'

/** OpenRouter's public model list, prices included. */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
/** One model's providers on OpenRouter, each with its own price. */
export const openRouterEndpointsUrl = (model: string): string =>
  `https://openrouter.ai/api/v1/models/${model.replace(/:[\w-]+$/, '')}/endpoints`

const DAY_MS = 24 * 60 * 60 * 1000
/** How often each source is refreshed. */
export const DATASET_EVERY_MS = 7 * DAY_MS
export const OPENROUTER_EVERY_MS = DAY_MS
/** A catalog older than this is worth a warning. */
export const STALE_AFTER_MS = 28 * DAY_MS

const KEYS = {
  catalog: 'pricing.catalog',
  catalogAt: 'pricing.catalog_fetched_at',
  openRouter: 'pricing.openrouter',
  openRouterAt: 'pricing.openrouter_fetched_at',
  ceilings: 'pricing.openrouter_ceilings',
} as const

/**
 * OpenRouter's price list, as USD per million tokens by model id.
 *
 * OpenRouter quotes USD per TOKEN, as strings. A negative price marks a router
 * whose price depends on where it routes (`openrouter/auto`); such a model has no
 * fixed price and is left out, so it stays unpriced rather than priced at a guess.
 *
 * @param document the parsed `/api/v1/models` response.
 * @returns the prices.
 * @throws when the document does not have the response's shape.
 */
export function parseOpenRouter(document: unknown): Map<string, Price> {
  const data = (document as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error('the OpenRouter response has no `data` list')
  const prices = new Map<string, Price>()
  for (const model of data as Array<{ id?: unknown; pricing?: Record<string, unknown> }>) {
    if (typeof model.id !== 'string') continue
    const price = priceOf(model.pricing)
    if (price !== undefined) prices.set(model.id, price)
  }
  return prices
}

/**
 * The HIGHEST price among a model's OpenRouter providers, per component.
 *
 * OpenRouter routes each request to one of a model's providers, and bills that
 * provider's price — not the one `/models` lists, which can be fifty times lower
 * (DeepSeek V4 Flash input, 2026-10-06: listed $0.0082, Azure $0.21, Cloudflare
 * $0.44 per million). dsh does not pass on the cost OpenRouter reports, so the
 * meter charges the ceiling: a budget can then stop early, never late.
 *
 * @param document the parsed `/api/v1/models/{id}/endpoints` response.
 * @returns the ceiling, or `undefined` when no provider has a fixed price.
 */
export function parseOpenRouterCeiling(document: unknown): Price | undefined {
  const endpoints = (document as { data?: { endpoints?: unknown } })?.data?.endpoints
  if (!Array.isArray(endpoints)) throw new Error('the OpenRouter response has no `endpoints` list')
  let ceiling: Price | undefined
  for (const endpoint of endpoints as Array<{ pricing?: Record<string, unknown> }>) {
    const price = priceOf(endpoint.pricing)
    if (price === undefined) continue
    ceiling =
      ceiling === undefined
        ? price
        : {
            input: Math.max(ceiling.input, price.input),
            output: Math.max(ceiling.output, price.output),
            cached: Math.max(ceiling.cached, price.cached),
            cacheWrite: Math.max(ceiling.cacheWrite ?? 0, price.cacheWrite ?? 0),
          }
  }
  return ceiling
}

/** One OpenRouter `pricing` object, per token as strings, to USD per million. */
function priceOf(pricing: Record<string, unknown> | undefined): Price | undefined {
  if (pricing === undefined) return undefined
  const perMillion = (value: unknown): number | undefined => {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1e6) / 1e6 : undefined
  }
  const input = perMillion(pricing['prompt'])
  const output = perMillion(pricing['completion'])
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    cached: perMillion(pricing['input_cache_read']) ?? input,
    cacheWrite: perMillion(pricing['input_cache_write']) ?? input,
  }
}

/**
 * Why a refreshed catalog must not replace the current one, or `undefined`.
 *
 * A truncated download, a schema change or a bad publish must never replace a
 * catalog that works: the cost would be every price silently gone.
 *
 * @param catalog the candidate.
 * @returns the reason it is refused.
 */
export function rejectCatalog(catalog: Catalog): string | undefined {
  if (catalog.entries.length < 20) return `only ${catalog.entries.length} priced model(s)`
  for (const provider of ['deepseek', 'anthropic', 'openai']) {
    if (!catalog.entries.some((entry) => entry.provider === provider)) return `no ${provider} models`
  }
  const implausible = catalog.entries.find((entry) =>
    [entry.input, entry.cached, entry.output, entry.cacheWrite].some((p) => !(p >= 0 && p < 1000)),
  )
  if (implausible !== undefined) return `an implausible price for ${implausible.provider}/${implausible.model}`
  return undefined
}

/** One change to the price of a model in use. */
export interface PriceChange {
  readonly model: string
  readonly before: { readonly input: number; readonly output: number } | null
  readonly after: { readonly input: number; readonly output: number } | null
}

/** What the refresher needs. */
export interface RefresherOptions {
  readonly store: OpsStore
  readonly prices: PriceTable
  readonly now: () => number
  readonly fetch: typeof fetch
  readonly log: { info(message: string): void; warn(message: string): void }
  /** The models in use, whose price changes the operator hears about. */
  readonly watched: () => readonly ModelRef[]
  /** Told about price changes to models in use. */
  readonly onChanges: (changes: readonly PriceChange[]) => void
  /** Told whenever a refresh replaced prices, whether or not a model in use moved. */
  readonly onApplied?: () => void
}

/** Refreshes the dataset weekly and OpenRouter daily, on a timer. */
export class PriceRefresher {
  private timers: ReturnType<typeof setTimeout>[] = []
  private warnedStaleOn: string | undefined
  /** Aborted by `stop()`: nothing in flight may touch the store or the table after it. */
  private readonly halt = new AbortController()

  constructor(private readonly options: RefresherOptions) {}

  /**
   * Apply what earlier refreshes saved, so a restart keeps the latest prices.
   * A saved catalog older than the shipped snapshot is ignored.
   */
  load(): void {
    const { store, prices } = this.options
    const saved = store.runtimeState.get<Catalog>(KEYS.catalog)
    const shipped = prices.catalogInfo?.retrievedAt ?? ''
    if (saved !== undefined && rejectCatalog(saved) === undefined && saved.meta.retrievedAt >= shipped) {
      prices.setCatalog(saved)
    }
    const openRouter = store.runtimeState.get<{ fetchedAt: string; prices: Record<string, Price> }>(KEYS.openRouter)
    if (openRouter !== undefined) prices.setOpenRouter(new Map(Object.entries(openRouter.prices)), openRouter.fetchedAt)
    const ceilings = store.runtimeState.get<Record<string, Price>>(KEYS.ceilings)
    if (ceilings !== undefined) prices.setOpenRouterCeilings(new Map(Object.entries(ceilings)))
  }

  /**
   * Start the timer. The first check waits a few minutes, so a crash loop does not
   * hammer the sources and a boot is never slowed by the network — unless no
   * OpenRouter list was ever saved: then every OpenRouter model outside the shipped
   * catalog is unpriced, and blocked, until the check runs, so it runs within seconds.
   * @param firstAfterMs delay before the first check.
   * @param everyMs interval between checks.
   * @returns a function that stops the timer.
   */
  start(firstAfterMs = 5 * 60_000, everyMs = 6 * 60 * 60_000): () => void {
    if (this.options.store.runtimeState.get(KEYS.openRouterAt) === undefined) firstAfterMs = Math.min(firstAfterMs, 10_000)
    const tick = () => void this.refreshIfDue()
    const first = setTimeout(() => {
      tick()
      const interval = setInterval(tick, everyMs)
      interval.unref?.()
      this.timers.push(interval)
    }, firstAfterMs)
    first.unref?.()
    this.timers.push(first)
    // A model put in use since the last refresh (a `/new`) gets its ceiling within
    // a minute. Only missing ones are fetched, so this is idle almost always.
    const missing = setInterval(() => void this.refreshCeilings(false), 60_000)
    missing.unref?.()
    this.timers.push(missing)
    return () => this.stop()
  }

  /** Stop the timer, and abandon whatever is in flight. */
  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.halt.abort()
  }

  /** Refresh whichever source is due. Never throws. */
  async refreshIfDue(): Promise<void> {
    const { store, now } = this.options
    const at = (key: string) => store.runtimeState.get<number>(key) ?? 0
    if (now() - at(KEYS.catalogAt) >= DATASET_EVERY_MS) await this.refreshDataset()
    if (this.halt.signal.aborted) return
    if (now() - at(KEYS.openRouterAt) >= OPENROUTER_EVERY_MS) await this.refreshOpenRouter()
    this.warnIfStale()
  }

  /**
   * Fetch, validate, save and apply the dataset.
   * @returns whether the catalog was replaced.
   */
  async refreshDataset(): Promise<boolean> {
    const { store, prices, now, log } = this.options
    try {
      const document = await this.getJson(DATASET_URL)
      const catalog = catalogFromExport(document, new Date(now()).toISOString().slice(0, 10))
      const refused = rejectCatalog(catalog)
      if (refused !== undefined) {
        log.warn(`price catalog refresh refused (${refused}); keeping the catalog from ${prices.catalogInfo?.retrievedAt ?? 'the release'}`)
        return false
      }
      const changes = this.diff(() => prices.setCatalog(catalog))
      store.runtimeState.set(KEYS.catalog, catalog, now())
      store.runtimeState.set(KEYS.catalogAt, now(), now())
      log.info(`price catalog refreshed: ${catalog.entries.length} model(s), dataset updated ${catalog.meta.retrievedAt}`)
      if (changes.length > 0) this.options.onChanges(changes)
      return true
    } catch (error) {
      if (this.halt.signal.aborted) return false
      log.warn(`price catalog refresh failed (${(error as Error).message}); keeping the catalog from ${prices.catalogInfo?.retrievedAt ?? 'the release'}`)
      return false
    }
  }

  /**
   * Fetch, save and apply OpenRouter's price list.
   * @returns whether it was replaced.
   */
  async refreshOpenRouter(): Promise<boolean> {
    const { store, prices, now, log } = this.options
    try {
      const parsed = parseOpenRouter(await this.getJson(OPENROUTER_MODELS_URL))
      if (parsed.size < 50) {
        log.warn(`OpenRouter price refresh refused (only ${parsed.size} model(s)); keeping the previous prices`)
        return false
      }
      const fetchedAt = new Date(now()).toISOString().slice(0, 10)
      const changes = this.diff(() => prices.setOpenRouter(parsed, fetchedAt))
      store.runtimeState.set(KEYS.openRouter, { fetchedAt, prices: Object.fromEntries(parsed) }, now())
      store.runtimeState.set(KEYS.openRouterAt, now(), now())
      log.info(`OpenRouter prices refreshed: ${parsed.size} model(s)`)
      if (changes.length > 0) this.options.onChanges(changes)
      await this.refreshCeilings(true)
      return true
    } catch (error) {
      if (this.halt.signal.aborted) return false
      log.warn(`OpenRouter price refresh failed (${(error as Error).message}); keeping the previous prices`)
      return false
    }
  }

  /**
   * Fetch the provider ceiling of each OpenRouter model in use.
   * @param all every model in use (the daily refresh), or only those without one.
   */
  async refreshCeilings(all: boolean, only?: ModelRef): Promise<void> {
    const { store, prices, now, log } = this.options
    const models = [...new Set((only === undefined ? this.options.watched() : [only]).filter((m) => m.provider === 'openrouter').map((m) => m.model))]
      .filter((model) => !model.endsWith(':free') && (all || !prices.hasOpenRouterCeiling(model)))
    if (models.length === 0) return
    const ceilings = new Map(Object.entries(store.runtimeState.get<Record<string, Price>>(KEYS.ceilings) ?? {}))
    for (const model of models) {
      try {
        const ceiling = parseOpenRouterCeiling(await this.getJson(openRouterEndpointsUrl(model)))
        if (ceiling !== undefined) ceilings.set(model, ceiling)
      } catch (error) {
        if (this.halt.signal.aborted) return
        log.warn(`OpenRouter provider prices for ${model} failed (${(error as Error).message}); it is charged at the listed price`)
      }
    }
    if (this.halt.signal.aborted) return
    const changes = this.diff(() => prices.setOpenRouterCeilings(ceilings))
    store.runtimeState.set(KEYS.ceilings, Object.fromEntries(ceilings), now())
    if (changes.length > 0) this.options.onChanges(changes)
  }

  /** Apply an update and report how it moved the price of each model in use. */
  private diff(apply: () => void): PriceChange[] {
    try {
      return this.diffOf(apply)
    } finally {
      this.options.onApplied?.()
    }
  }

  private diffOf(apply: () => void): PriceChange[] {
    const models = this.options.watched()
    const summary = (price: ResolvedPrice | undefined) =>
      price === undefined ? null : { input: price.input, output: price.output }
    const before = models.map((model) => summary(this.options.prices.resolve(model)))
    apply()
    const changes: PriceChange[] = []
    models.forEach((model, index) => {
      const after = summary(this.options.prices.resolve(model))
      const was = before[index] ?? null
      if (was?.input !== after?.input || was?.output !== after?.output) {
        changes.push({ model: `${model.provider}/${model.model}`, before: was, after })
      }
    })
    return changes
  }

  /** Warn, at most once a day, when the catalog has not been refreshed for weeks. */
  private warnIfStale(): void {
    const retrieved = this.options.prices.catalogInfo?.retrievedAt
    if (retrieved === undefined) return
    const today = new Date(this.options.now()).toISOString().slice(0, 10)
    if (this.warnedStaleOn === today) return
    if (this.options.now() - Date.parse(retrieved) > STALE_AFTER_MS) {
      this.warnedStaleOn = today
      this.options.log.warn(`the price catalog is from ${retrieved}; refreshes have not succeeded since. Prices may be out of date.`)
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), this.halt.signal])
    const response = await this.options.fetch(url, { signal })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    const body: unknown = await response.json()
    if (this.halt.signal.aborted) throw new Error('stopped')
    return body
  }
}
