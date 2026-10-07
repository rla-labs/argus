// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the price catalog and the resolution chain.
 *
 * The catalog is conservative on purpose — a budget that underestimates is
 * exceeded — so the tests pin which price wins when a model has several.
 */
import { describe, expect, it } from 'vitest'
import { modelKey, normalizeDataset, type Catalog } from '../../src/catalog.js'
import { SNAPSHOT } from '../../src/catalog-snapshot.js'
import { PriceTable, isFree, priceRequest } from '../../src/pricing.js'

const tiered = {
  provider_id: 'google-gemini',
  model_id: 'gemini-x-pro',
  input_price_per_1m_tokens: '1.25',
  cached_input_price_per_1m_tokens: '0.125',
  output_price_per_1m_tokens: '10',
  currency: 'USD',
  pricing_unit: '1M tokens',
  status: 'latest',
  last_verified_at: '2026-09-20',
  official_source_url: 'https://example.com/pricing',
  // As the CSV carries it: JSON text in a cell.
  pricing_tiers_json: JSON.stringify([
    { processing_mode: 'standard', input_price_per_1m_tokens: 2.5, cached_input_price_per_1m_tokens: 0.25, output_price_per_1m_tokens: 15 },
    { processing_mode: 'priority', input_price_per_1m_tokens: 4.5, cached_input_price_per_1m_tokens: 0.45, output_price_per_1m_tokens: 27 },
  ]),
  pricing_components_json: '[]',
  time_pricing_json: 'null',
}

describe('normalizeDataset', () => {
  it('takes the highest STANDARD tier, never batch or priority', () => {
    const [entry] = normalizeDataset([tiered])
    expect(entry).toMatchObject({ input: 2.5, cached: 0.25, output: 15 })
  })

  it('takes the peak-hour price when a provider discounts off-peak hours', () => {
    const [entry] = normalizeDataset([
      {
        ...tiered,
        provider_id: 'deepseek',
        model_id: 'deepseek-flash',
        input_price_per_1m_tokens: '0.15',
        output_price_per_1m_tokens: '0.6',
        pricing_tiers_json: '[]',
        // The JSON export carries nested fields as objects, not text.
        time_pricing_json: { periods: [{ inputPrice: 0.15, outputPrice: 0.6 }, { inputPrice: 0.3, outputPrice: 1.2, cachedInputPrice: 0.006 }] },
      },
    ])
    expect(entry).toMatchObject({ input: 0.3, output: 1.2 })
  })

  it('prefers the 5-minute cache write, and falls back to input for cache prices it lacks', () => {
    const [withWrite] = normalizeDataset([
      {
        ...tiered,
        pricing_tiers_json: '[]',
        pricing_components_json: JSON.stringify([
          { component: 'cache_write_5m', amount: '1.5625', condition: { processing_mode: 'standard' } },
          { component: 'cache_write_1h', amount: '2.5', condition: { processing_mode: 'standard' } },
        ]),
      },
    ])
    expect(withWrite!.cacheWrite).toBe(1.5625)
    const [bare] = normalizeDataset([{ ...tiered, pricing_tiers_json: '[]', cached_input_price_per_1m_tokens: '' }])
    expect(bare).toMatchObject({ cached: 1.25, cacheWrite: 1.25 })
  })

  it('skips rows not priced per token, and rows without both input and output prices', () => {
    expect(normalizeDataset([{ ...tiered, pricing_unit: '', billing_unit: 'per_1000_pages', input_price_per_1m_tokens: '', pricing_tiers_json: '[]' }])).toEqual([])
    expect(normalizeDataset([{ ...tiered, pricing_unit: 'per minute' }])).toEqual([])
  })
})

describe('modelKey', () => {
  it('meets an API id with a date snapshot and a dataset id with a dot', () => {
    expect(modelKey('claude-haiku-4-5-20251001')).toBe(modelKey('claude-haiku-4.5'))
    expect(modelKey('Claude-Fable-5-1')).toBe('claude-fable-5-1')
  })
})

describe('the resolution chain', () => {
  const catalog: Catalog = {
    meta: { title: 't', url: 'u', license: 'CC BY 4.0', retrievedAt: '2026-10-05', changes: '' },
    entries: [
      { provider: 'deepseek', model: 'deepseek-flash', input: 0.3, cached: 0.006, output: 1.2, cacheWrite: 0.3, status: 'latest', verifiedAt: '2026-09-13', sourceUrl: '' },
      { provider: 'deepseek', model: 'deepseek-v4-flash', input: 0.3, cached: 0.006, output: 1.2, cacheWrite: 0.3, status: 'retired', verifiedAt: null, sourceUrl: '' },
      { provider: 'anthropic', model: 'claude-haiku-4.5', input: 1, cached: 0.1, output: 5, cacheWrite: 1.25, status: 'latest', verifiedAt: '2026-09-22', sourceUrl: '' },
      { provider: 'google-gemini', model: 'gemini-3.5-flash', input: 1.5, cached: 0.15, output: 9, cacheWrite: 1.5, status: 'active', verifiedAt: null, sourceUrl: '' },
    ],
  }
  const prices = (pricing: Record<string, { input: number; cached: number; output: number }> = {}) =>
    new PriceTable({ pricing, unknown_model_policy: 'block' }, catalog)

  it('prices a direct provider from the catalog', () => {
    expect(prices().resolve({ provider: 'deepseek', model: 'deepseek-flash' })).toMatchObject({ input: 0.3, output: 1.2, source: 'catalog', verifiedAt: '2026-09-13' })
  })

  it('lets ops.yaml override the catalog', () => {
    const table = prices({ 'deepseek/deepseek-flash': { input: 0.2, cached: 0.004, output: 0.8 } })
    expect(table.resolve({ provider: 'deepseek', model: 'deepseek-flash' })).toMatchObject({ input: 0.2, source: 'config' })
  })

  it('finds an API id with a date snapshot', () => {
    expect(prices().resolve({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })).toMatchObject({ input: 1, source: 'catalog' })
  })

  it('prices OpenRouter vendor/model ids from the vendor, and :free variants at zero', () => {
    expect(prices().resolve({ provider: 'openrouter', model: 'google/gemini-3.5-flash' })).toMatchObject({ input: 1.5, source: 'catalog' })
    const free = prices().resolve({ provider: 'openrouter', model: 'deepseek/deepseek-flash:free' })
    expect(free).toMatchObject({ source: 'openrouter-free' })
    expect(isFree(free!)).toBe(true)
  })

  it('treats a local provider as free, and an unmapped one as unpriced', () => {
    expect(prices().resolve({ provider: 'ollama', model: 'llama3' })).toMatchObject({ source: 'local', input: 0 })
    expect(prices().resolve({ provider: 'acme', model: 'deepseek-flash' })).toBeUndefined()
    expect(prices().resolve({ provider: 'deepseek', model: 'deepseek-unknown' })).toBeUndefined()
  })

  it('carries a retired status so the operator can be told', () => {
    expect(prices().resolve({ provider: 'deepseek', model: 'deepseek-v4-flash' })?.status).toBe('retired')
  })
})

describe('cache writes', () => {
  it('are priced at their own rate, or at the input rate when there is none', () => {
    const counts = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }
    expect(priceRequest({ input: 1, cached: 0.1, output: 5, cacheWrite: 1.25 }, counts)).toBe(1_250_000)
    expect(priceRequest({ input: 1, cached: 0.1, output: 5 }, counts)).toBe(1_000_000)
  })
})

describe('the shipped snapshot', () => {
  it('is attributed as CC BY 4.0 requires', () => {
    expect(SNAPSHOT.meta.license).toBe('CC BY 4.0')
    expect(SNAPSHOT.meta.url).toContain('aicostbudget.com')
    expect(SNAPSHOT.meta.changes.length).toBeGreaterThan(0)
  })

  it('prices the default models', () => {
    const table = new PriceTable({ pricing: {}, unknown_model_policy: 'block' }, SNAPSHOT)
    for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
      const price = table.resolve({ provider: 'deepseek', model })
      expect(price, model).toBeDefined()
      expect(price!.output, model).toBeGreaterThan(0)
    }
  })

  it('holds only plausible prices', () => {
    for (const entry of SNAPSHOT.entries) {
      for (const field of ['input', 'cached', 'output', 'cacheWrite'] as const) {
        expect(entry[field], `${entry.provider}/${entry.model} ${field}`).toBeGreaterThanOrEqual(0)
        expect(entry[field], `${entry.provider}/${entry.model} ${field}`).toBeLessThan(1000)
      }
    }
  })
})
