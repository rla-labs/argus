// == ARGUS AGENT PROJECT ==
/**
 * The providers' lists: models.dev for any provider, DeepInfra's own for DeepInfra.
 * The fragments are trimmed from the real responses (2026-10-19). No network.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpsStore } from '@argus-agent/store'
import { SNAPSHOT } from '../../src/catalog-snapshot.js'
import { PriceTable } from '../../src/pricing.js'
import { PriceRefresher, parseDeepInfra, parseModelsDev } from '../../src/refresh.js'

const NOW = Date.parse('2026-10-19T12:00:00Z')

/** DeepInfra's `/models/list`: a plain model, a discounted one, one whose discount ends tomorrow. */
function deepInfraList(extra = 0) {
  const tokens = (input: number, output: number, more: Record<string, unknown> = {}) => ({
    type: 'tokens',
    cents_per_input_token: input,
    cents_per_output_token: output,
    discount: null,
    discount_ends_at: null,
    rate_per_input_token_cached: 0.2,
    rate_per_input_token_cache_write: null,
    ...more,
  })
  const list = [
    { model_name: 'deepseek-ai/DeepSeek-V4-Flash', type: 'text-generation', deprecated: null, pricing: tokens(9e-6, 1.8e-5) },
    { model_name: 'deepseek-ai/DeepSeek-V4.1-Flash', type: 'text-generation', deprecated: null, pricing: tokens(2e-5, 6e-5, { discount: 0.3, rate_per_input_token_cached: 0.03 }) },
    { model_name: 'zai-org/GLM-5.3-Flash', type: 'text-generation', deprecated: null, pricing: tokens(1.5e-5, 5e-5, { discount: 0.5, discount_ends_at: NOW / 1000 + 3600 }) },
    { model_name: 'old/model', type: 'text-generation', deprecated: 1700000000, pricing: tokens(1e-5, 1e-5) },
    { model_name: 'BAAI/bge-m3', type: 'embeddings', deprecated: null, pricing: tokens(1e-6, 0) },
  ]
  for (let i = 0; i < extra; i += 1) list.push({ model_name: `vendor/model-${i}`, type: 'text-generation', deprecated: null, pricing: tokens(1e-5, 2e-5) })
  return list
}

/** models.dev's `api.json`: a plain model, one with a long-context tier and dearer reasoning, OpenRouter. */
function modelsDev(extra = 0) {
  const models: Record<string, { cost?: Record<string, unknown> }> = {
    'deepseek-ai/DeepSeek-V4-Flash': { cost: { input: 0.09, output: 0.18, cache_read: 0.018 } },
    'acme/long': {
      cost: { input: 0.1, output: 0.5, reasoning: 0.8, cache_read: 0.01, tiers: [{ input: 0.2, output: 0.75, cache_read: 0.02, tier: { type: 'context', size: 272000 } }] },
    },
    'acme/no-price': {},
  }
  for (let i = 0; i < extra; i += 1) models[`vendor/model-${i}`] = { cost: { input: 1, output: 2 } }
  return { together: { id: 'together', models }, openrouter: { id: 'openrouter', models: { 'x/y': { cost: { input: 9, output: 9 } } } } }
}

describe('parseModelsDev', () => {
  it('keys by provider/model, takes the highest tier, and leaves OpenRouter to its own rules', () => {
    const prices = parseModelsDev(modelsDev())
    expect(prices.get('together/deepseek-ai/DeepSeek-V4-Flash')).toEqual({ input: 0.09, output: 0.18, cached: 0.018, cacheWrite: 0.09 })
    expect(prices.get('together/acme/long')).toEqual({ input: 0.2, output: 0.8, cached: 0.02, cacheWrite: 0.2 })
    expect(prices.has('together/acme/no-price')).toBe(false)
    expect(prices.has('openrouter/x/y')).toBe(false)
    expect(() => parseModelsDev([])).toThrow(/not an object/)
  })
})

describe('parseDeepInfra', () => {
  it('bills the discount, the cached share, and a discount ending within a day not at all', () => {
    const prices = parseDeepInfra(deepInfraList(), NOW)
    expect(prices.get('deepseek-ai/DeepSeek-V4-Flash')).toEqual({ input: 0.09, output: 0.18, cached: 0.018, cacheWrite: 0.09 })
    expect(prices.get('deepseek-ai/DeepSeek-V4.1-Flash')).toEqual({ input: 0.14, output: 0.42, cached: 0.0042, cacheWrite: 0.14 })
    expect(prices.get('zai-org/GLM-5.3-Flash')).toMatchObject({ input: 0.15, output: 0.5 })
    expect(parseDeepInfra(deepInfraList(), NOW - 2 * 86_400_000).get('zai-org/GLM-5.3-Flash')).toMatchObject({ input: 0.075, output: 0.25 })
    expect([...prices.keys()]).not.toContain('old/model')
    expect([...prices.keys()]).not.toContain('BAAI/bge-m3')
    expect(() => parseDeepInfra({}, NOW)).toThrow(/not a list/)
  })
})

describe('the providers lists in the price table', () => {
  const stores: OpsStore[] = []
  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
  })

  function make(store: OpsStore, answers: { modelsDev?: () => unknown; deepInfra?: () => unknown }) {
    const prices = new PriceTable({ pricing: { 'together/acme/long': { input: 1, cached: 1, output: 1 } }, unknown_model_policy: 'block' }, SNAPSHOT)
    const logs: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      const answer = String(url).includes('models.dev') ? answers.modelsDev : answers.deepInfra
      if (answer === undefined) return new Response('down', { status: 503 })
      return new Response(JSON.stringify(answer()), { status: 200 })
    }) as typeof fetch
    const refresher = new PriceRefresher({
      store,
      prices,
      now: () => NOW,
      fetch: fetchImpl,
      log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
      watched: () => [],
      onChanges: () => undefined,
    })
    return { prices, refresher, logs }
  }

  it('prices a declared provider, DeepInfra from its own list, ops.yaml first, and keeps it over a restart and a failed refresh', async () => {
    const store = new OpsStore({ path: ':memory:' })
    stores.push(store)
    const { prices, refresher } = make(store, { modelsDev: () => modelsDev(1000), deepInfra: () => deepInfraList(20) })
    const flash = { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4.1-Flash' }
    expect(prices.resolve(flash)).toBeUndefined()
    expect(await refresher.refreshLists()).toBe(true)
    expect(prices.resolve(flash)).toMatchObject({ input: 0.14, source: 'deepinfra', verifiedAt: '2026-10-19' })
    expect(prices.resolve({ provider: 'together', model: 'deepseek-ai/DeepSeek-V4-Flash' })).toMatchObject({ input: 0.09, source: 'models.dev' })
    expect(prices.resolve({ provider: 'together', model: 'acme/long' })).toMatchObject({ input: 1, source: 'config' })
    // A catalog provider keeps the catalog's price; OpenRouter keeps its own rules.
    expect(prices.resolve({ provider: 'deepseek', model: 'deepseek-flash' })?.source).toBe('catalog')
    expect(prices.resolve({ provider: 'openrouter', model: 'x/y' })).toBeUndefined()

    // A restart whose refresh fails, or brings a truncated list, keeps the saved prices.
    const restarted = make(store, { deepInfra: () => deepInfraList() })
    restarted.refresher.load()
    expect(await restarted.refresher.refreshLists()).toBe(false)
    expect(restarted.prices.resolve(flash)).toMatchObject({ input: 0.14, source: 'deepinfra' })
    expect(restarted.logs.filter((line) => line.startsWith('warn'))).toHaveLength(2)
  })
})
