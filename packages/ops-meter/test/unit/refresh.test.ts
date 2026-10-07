// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the price refresh. No network: `fetch` is a fake, and the store
 * is an in-memory database.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpsStore } from '@argus-agent/store'
import { SNAPSHOT } from '../../src/catalog-snapshot.js'
import { PriceTable, isFree } from '../../src/pricing.js'
import {
  DATASET_EVERY_MS,
  OPENROUTER_EVERY_MS,
  PriceRefresher,
  parseOpenRouter,
  parseOpenRouterCeiling,
  rejectCatalog,
  type PriceChange,
} from '../../src/refresh.js'

const stores: OpsStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/** A dataset export with enough models to pass validation; deepseek-flash at `flashInput`. */
function datasetExport(flashInput: number, updated = '2026-11-01T00:00:00Z') {
  const row = (provider: string, model: string, input: number) => ({
    provider_id: provider,
    model_id: model,
    input_price_per_1m_tokens: input,
    cached_input_price_per_1m_tokens: input / 10,
    output_price_per_1m_tokens: input * 4,
    currency: 'USD',
    pricing_unit: '1M tokens',
    status: 'latest',
    last_verified_at: '2026-10-30',
    official_source_url: 'https://example.com',
    pricing_components: [],
    pricing_tiers: [],
    time_pricing: null,
  })
  const records = [row('deepseek', 'deepseek-flash', flashInput)]
  for (let i = 0; i < 10; i += 1) records.push(row('anthropic', `claude-${i}`, 1 + i), row('openai', `gpt-${i}`, 1 + i))
  return { metadata: { last_updated: updated }, records }
}

function openRouterResponse(count = 60) {
  const data = [
    { id: 'deepseek/deepseek-flash', pricing: { prompt: '0.00000025', completion: '0.000001', input_cache_read: '0.000000005' } },
    { id: 'deepseek/deepseek-flash:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
  ]
  for (let i = 0; i < count; i += 1) data.push({ id: `vendor/model-${i}`, pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000001' } })
  return { data }
}

/** A fake fetch answering per URL. */
function fakeFetch(answers: Record<string, () => unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const key = Object.keys(answers).find((k) => String(url).includes(k))
    if (key === undefined) return new Response('not found', { status: 404 })
    const body = answers[key]!()
    if (body instanceof Error) throw body
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

function setup(fetchImpl: typeof fetch, options: { now?: () => number; store?: OpsStore } = {}) {
  const store = options.store ?? new OpsStore({ path: ':memory:' })
  if (options.store === undefined) stores.push(store)
  const prices = new PriceTable({ pricing: {}, unknown_model_policy: 'block' }, SNAPSHOT)
  const logs: string[] = []
  const changes: PriceChange[] = []
  const refresher = new PriceRefresher({
    store,
    prices,
    now: options.now ?? (() => Date.parse('2026-11-02T00:00:00Z')),
    fetch: fetchImpl,
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
    watched: () => [{ provider: 'deepseek', model: 'deepseek-flash' }],
    onChanges: (c) => changes.push(...c),
  })
  return { store, prices, refresher, logs, changes }
}

describe('parseOpenRouter', () => {
  it('converts USD per token to USD per million, and leaves out dynamically priced routers', () => {
    const prices = parseOpenRouter(openRouterResponse(0))
    expect(prices.get('deepseek/deepseek-flash')).toEqual({ input: 0.25, output: 1, cached: 0.005, cacheWrite: 0.25 })
    expect(isFree(prices.get('deepseek/deepseek-flash:free')!)).toBe(true)
    expect(prices.has('openrouter/auto')).toBe(false)
  })
})

describe('rejectCatalog', () => {
  it('refuses a truncated, partial or implausible catalog', () => {
    expect(rejectCatalog({ meta: SNAPSHOT.meta, entries: SNAPSHOT.entries.slice(0, 5) })).toMatch(/only 5/)
    expect(rejectCatalog({ meta: SNAPSHOT.meta, entries: SNAPSHOT.entries.filter((e) => e.provider !== 'openai') })).toMatch(/no openai/)
    const bad = SNAPSHOT.entries.map((e, i) => (i === 0 ? { ...e, output: 5000 } : e))
    expect(rejectCatalog({ meta: SNAPSHOT.meta, entries: bad })).toMatch(/implausible/)
    expect(rejectCatalog(SNAPSHOT)).toBeUndefined()
  })
})

describe('PriceRefresher', () => {
  it('replaces, saves and applies a valid dataset, and reports the price change of a model in use', async () => {
    const { refresher, prices, store, changes } = setup(fakeFetch({ 'aicostbudget.com': () => datasetExport(0.2) }))
    expect(await refresher.refreshDataset()).toBe(true)
    expect(prices.resolve({ provider: 'deepseek', model: 'deepseek-flash' })?.input).toBe(0.2)
    expect(prices.catalogInfo?.retrievedAt).toBe('2026-11-01')
    expect(store.runtimeState.get('pricing.catalog')).toBeDefined()
    expect(changes).toEqual([{ model: 'deepseek/deepseek-flash', before: { input: 0.3, output: 1.2 }, after: { input: 0.2, output: 0.8 } }])
  })

  it('keeps the last good catalog when a refresh fails or is refused, and says so', async () => {
    for (const answer of [() => new Error('ECONNRESET'), () => ({ records: [] }), () => ({ nope: true })]) {
      const { refresher, prices, logs } = setup(fakeFetch({ 'aicostbudget.com': answer }))
      expect(await refresher.refreshDataset()).toBe(false)
      expect(prices.resolve({ provider: 'deepseek', model: 'deepseek-flash' })?.input).toBe(0.3)
      expect(logs.some((line) => line.startsWith('warn') && line.includes('keeping the catalog'))).toBe(true)
    }
  })

  it('restores saved prices after a restart, instead of falling back to the shipped snapshot', async () => {
    const first = setup(fakeFetch({ 'aicostbudget.com': () => datasetExport(0.2), 'openrouter.ai': () => openRouterResponse() }))
    await first.refresher.refreshDataset()
    await first.refresher.refreshOpenRouter()

    const restarted = setup(fakeFetch({}), { store: first.store })
    restarted.refresher.load()
    expect(restarted.prices.resolve({ provider: 'deepseek', model: 'deepseek-flash' })?.input).toBe(0.2)
    expect(restarted.prices.resolve({ provider: 'openrouter', model: 'deepseek/deepseek-flash' })).toMatchObject({ input: 0.25, source: 'openrouter' })
  })

  it("prefers OpenRouter's own price over the vendor's, and a free live model stays free", async () => {
    const { refresher, prices } = setup(fakeFetch({ 'openrouter.ai': () => openRouterResponse() }))
    expect(prices.resolve({ provider: 'openrouter', model: 'deepseek/deepseek-flash' })).toMatchObject({ input: 0.3, source: 'catalog' })
    await refresher.refreshOpenRouter()
    expect(prices.resolve({ provider: 'openrouter', model: 'deepseek/deepseek-flash' })).toMatchObject({ input: 0.25, source: 'openrouter' })
    expect(isFree(prices.resolve({ provider: 'openrouter', model: 'deepseek/deepseek-flash:free' })!)).toBe(true)
  })

  it('refreshes the dataset weekly and OpenRouter daily', async () => {
    let now = Date.parse('2026-11-02T00:00:00Z')
    const calls: string[] = []
    const fetchImpl = fakeFetch({
      'aicostbudget.com': () => (calls.push('dataset'), datasetExport(0.3)),
      'openrouter.ai': () => (calls.push('openrouter'), openRouterResponse()),
    })
    const { refresher } = setup(fetchImpl, { now: () => now })
    await refresher.refreshIfDue()
    expect(calls).toEqual(['dataset', 'openrouter'])
    now += OPENROUTER_EVERY_MS
    await refresher.refreshIfDue()
    expect(calls).toEqual(['dataset', 'openrouter', 'openrouter'])
    now += DATASET_EVERY_MS
    await refresher.refreshIfDue()
    expect(calls.filter((c) => c === 'dataset')).toHaveLength(2)
  })
})

describe('PriceRefresher.start', () => {
  const waitForTick = () => new Promise((resolve) => setTimeout(resolve, 50))

  it('fetches within seconds when no OpenRouter list was ever saved, else waits', async () => {
    const calls: string[] = []
    const fetchImpl = fakeFetch({
      'aicostbudget': () => (calls.push('dataset'), datasetExport(0.3)),
      'openrouter.ai': () => (calls.push('openrouter'), openRouterResponse()),
    })
    const { store, refresher } = setup(fetchImpl)
    refresher.start(60_000, 6 * 60 * 60_000)
    // ponytail: real timers; the first-boot delay is capped at 10 s.
    await new Promise((resolve) => setTimeout(resolve, 10_100))
    refresher.stop()
    expect(calls).toContain('openrouter')

    // A restart with a saved list keeps the delay.
    calls.length = 0
    const restarted = setup(fetchImpl, { store }).refresher
    restarted.start(60_000)
    await waitForTick()
    restarted.stop()
    expect(calls).toEqual([])
  }, 20_000)

  it('touches nothing after stop(), even with a request in flight', async () => {
    let release: () => void = () => undefined
    const fetchImpl = (async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return new Response(JSON.stringify(openRouterResponse()), { status: 200 })
    }) as unknown as typeof fetch
    const { store, refresher, logs } = setup(fetchImpl)
    const pending = refresher.refreshOpenRouter()
    refresher.stop()
    store.close()
    release()
    await expect(pending).resolves.toBe(false)
    expect(logs).toEqual([])
  })
})

describe('OpenRouter provider ceilings', () => {
  const endpoints = (...prices: Array<[string, string]>) => ({
    data: { endpoints: prices.map(([prompt, completion]) => ({ pricing: { prompt, completion } })) },
  })

  it('takes the highest price of each component across providers', () => {
    const ceiling = parseOpenRouterCeiling(endpoints(['0.0000000082', '0.00000128'], ['0.00000021', '0.00000056']))
    expect(ceiling).toMatchObject({ input: 0.21, output: 1.28 })
    expect(parseOpenRouterCeiling(endpoints())).toBeUndefined()
    expect(() => parseOpenRouterCeiling({})).toThrow(/endpoints/)
  })

  it('charges the ceiling over the listed price, fetches only what is missing, and keeps it over a restart', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url))
      const body = String(url).endsWith('/endpoints')
        ? endpoints(['0.0000000082', '0.00000128'], ['0.00000044', '0.00000056'])
        : openRouterResponse()
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const store = new OpsStore({ path: ':memory:' })
    stores.push(store)
    const make = () => {
      const prices = new PriceTable({ pricing: {}, unknown_model_policy: 'block' }, SNAPSHOT)
      const refresher = new PriceRefresher({
        store,
        prices,
        now: () => Date.parse('2026-11-02T00:00:00Z'),
        fetch: fetchImpl,
        log: { info: () => undefined, warn: () => undefined },
        watched: () => [{ provider: 'openrouter', model: 'vendor/model-1' }, { provider: 'openrouter', model: 'x/y:free' }],
        onChanges: () => undefined,
      })
      return { prices, refresher }
    }
    const ref = { provider: 'openrouter', model: 'vendor/model-1' }

    const first = make()
    await first.refresher.refreshOpenRouter()
    expect(first.prices.resolve(ref)).toMatchObject({ input: 0.44, output: 1.28, source: 'openrouter' })
    // `:free` variants are not looked up.
    expect(calls.filter((url) => url.endsWith('/endpoints'))).toEqual([
      'https://openrouter.ai/api/v1/models/vendor/model-1/endpoints',
    ])

    calls.length = 0
    await first.refresher.refreshCeilings(false)
    expect(calls).toEqual([])

    const restarted = make()
    restarted.refresher.load()
    expect(restarted.prices.resolve(ref)).toMatchObject({ input: 0.44, output: 1.28 })

    // `/new` with a model nothing uses yet: fetched on the spot, before its first request.
    calls.length = 0
    const fresh = { provider: 'openrouter', model: 'vendor/model-2' }
    await restarted.refresher.refreshCeilings(false, fresh)
    expect(calls).toEqual(['https://openrouter.ai/api/v1/models/vendor/model-2/endpoints'])
    expect(restarted.prices.resolve(fresh)).toMatchObject({ input: 0.44, output: 1.28 })
  })
})
