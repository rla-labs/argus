// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the price table and the cost arithmetic.
 *
 * Money is the one place a rounding mistake compounds silently, so the
 * arithmetic is asserted against hand-computed values.
 */
import { describe, expect, it } from 'vitest'
import { micros, usd, MICROS_PER_USD } from '@argus-agent/types'
import { PriceTable, priceRequest, zeroCost, type Price, type PricingConfig } from '../../src/pricing.js'

/** Build a table from a pricing configuration. */
function table(pricing: Record<string, Price>, policy: PricingConfig['unknown_model_policy'] = 'block') {
  return new PriceTable({ pricing, unknown_model_policy: policy })
}

describe('PriceTable.resolve', () => {
  it('matches an exact provider/model key', () => {
    const prices = table({ 'anthropic/claude-sonnet-x': { input: 3, cached: 0.3, output: 15 } })
    const resolved = prices.resolve({ provider: 'anthropic', model: 'claude-sonnet-x' })
    expect(resolved).toEqual({ input: 3, cached: 0.3, output: 15, matchedBy: 'anthropic/claude-sonnet-x', exact: true, source: 'config' })
  })

  it('matches a provider glob', () => {
    const prices = table({ 'ollama/*': { input: 0, cached: 0, output: 0 } })
    const resolved = prices.resolve({ provider: 'ollama', model: 'llama3' })
    expect(resolved).toMatchObject({ matchedBy: 'ollama/*', exact: false })
  })

  it('prefers an exact key over a glob for the same provider', () => {
    const prices = table({
      'deepseek/*': { input: 0.1, cached: 0.01, output: 0.2 },
      'deepseek/deepseek-flash': { input: 0, cached: 0, output: 0 },
    })
    // The deployment priced the whole provider, then corrected one model.
    expect(prices.resolve({ provider: 'deepseek', model: 'deepseek-flash' })?.input).toBe(0)
    expect(prices.resolve({ provider: 'deepseek', model: 'other' })?.input).toBe(0.1)
  })

  it('returns undefined for an unlisted provider', () => {
    const prices = table({ 'anthropic/*': { input: 1, cached: 0, output: 1 } })
    expect(prices.resolve({ provider: 'openai', model: 'gpt' })).toBeUndefined()
  })

  it('does not match a glob against a different provider', () => {
    const prices = table({ 'ollama/*': { input: 0, cached: 0, output: 0 } })
    expect(prices.resolve({ provider: 'ollama-remote', model: 'x' })).toBeUndefined()
  })

  it('handles a model id containing a slash', () => {
    // OpenRouter-style: the provider is `openrouter`, the model is `a/b`.
    const prices = table({ 'openrouter/deepseek/deepseek-v4.1-flash': { input: 0.1, cached: 0, output: 0.2 } })
    const resolved = prices.resolve({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' })
    expect(resolved?.output).toBe(0.2)
  })

  it('reports whether a model is priced', () => {
    const prices = table({ 'a/b': { input: 1, cached: 0, output: 1 } })
    expect(prices.isPriced({ provider: 'a', model: 'b' })).toBe(true)
    expect(prices.isPriced({ provider: 'a', model: 'c' })).toBe(false)
  })

  it('lists its keys, globs marked', () => {
    const prices = table({
      'b/exact': { input: 1, cached: 0, output: 1 },
      'a/*': { input: 1, cached: 0, output: 1 },
    })
    expect(prices.keys()).toEqual(['a/*', 'b/exact'])
  })

  it('exposes the unknown-model policy', () => {
    expect(table({}, 'warn').unknownPolicy).toBe('warn')
    expect(table({}, 'block').unknownPolicy).toBe('block')
  })
})

describe('priceRequest', () => {
  /** A price where each token costs exactly one micro-USD per million tokens. */
  const onePerMillion: Price = { input: 1, cached: 1, output: 1 }

  it('charges nothing for zero tokens', () => {
    expect(priceRequest(onePerMillion, { inputTokens: 0, cachedTokens: 0, outputTokens: 0 })).toBe(0)
  })

  it('prices one million tokens at the configured rate', () => {
    // A price of 1 USD per million tokens, one million tokens, is exactly 1 USD.
    expect(priceRequest(onePerMillion, { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 })).toBe(
      usd(1),
    )
  })

  it('prices a realistic request by hand', () => {
    // claude-sonnet-x at $3 in / $0.30 cached / $15 out per million.
    const price: Price = { input: 3, cached: 0.3, output: 15 }
    const counts = { inputTokens: 1500, cachedTokens: 2000, outputTokens: 800 }

    // input:  1500 * 3     = 4500 micro-USD
    // cached: 2000 * 0.3   =  600 micro-USD
    // output:  800 * 15    = 12000 micro-USD
    // total:  17100 micro-USD = $0.0171
    expect(priceRequest(price, counts)).toBe(17_100)
    expect(17_100 / MICROS_PER_USD).toBeCloseTo(0.0171, 10)
  })

  it('rounds once, at the end, rather than per field', () => {
    // Each field alone rounds to 0.333, so per-field rounding would give 1 while
    // the exact total is 1.0.
    const price: Price = { input: 1, cached: 1, output: 1 }
    const counts = { inputTokens: 333_333, cachedTokens: 333_333, outputTokens: 333_334 }
    // Exact: 333333 + 333333 + 333334 = 1_000_000 micro-USD.
    expect(priceRequest(price, counts)).toBe(1_000_000)
  })

  it('rounds half up at the micro-USD boundary', () => {
    const price: Price = { input: 1, cached: 0, output: 0 }
    expect(priceRequest(price, { inputTokens: 0.4, cachedTokens: 0, outputTokens: 0 })).toBe(0)
    expect(priceRequest(price, { inputTokens: 0.5, cachedTokens: 0, outputTokens: 0 })).toBe(1)
    expect(priceRequest(price, { inputTokens: 0.6, cachedTokens: 0, outputTokens: 0 })).toBe(1)
  })

  it('treats cached tokens as disjoint from input', () => {
    // dsh reports `inputTokens` as uncached input only, so the two are summed,
    // not subtracted. If they overlapped, this would charge 2000 tokens' worth
    // for what the provider billed as 1000.
    const price: Price = { input: 1, cached: 10, output: 1 }
    const counts = { inputTokens: 1000, cachedTokens: 1000, outputTokens: 0 }
    expect(priceRequest(price, counts)).toBe(11_000)
  })

  it('stays exact across a thousand small requests', () => {
    // The reason money is integer micro-USD: 0.001 USD a thousand times is
    // exactly 1 USD, where a float accumulator drifts.
    const price: Price = { input: 1, cached: 0, output: 0 }
    let total = 0
    for (let index = 0; index < 1000; index += 1) {
      total += priceRequest(price, { inputTokens: 1000, cachedTokens: 0, outputTokens: 0 })
    }
    expect(total).toBe(1_000_000)
    expect(total).toBe(usd(1))
  })

  it('handles a free model', () => {
    expect(
      priceRequest({ input: 0, cached: 0, output: 0 }, { inputTokens: 999_999, cachedTokens: 1, outputTokens: 5 }),
    ).toBe(0)
  })

  it('produces an integer for a fractional price', () => {
    // $0.14 per million input tokens, 1234 tokens: 172.76 -> 173 micro-USD.
    const cost = priceRequest({ input: 0.14, cached: 0, output: 0 }, { inputTokens: 1234, cachedTokens: 0, outputTokens: 0 })
    expect(Number.isInteger(cost)).toBe(true)
    expect(cost).toBe(173)
  })

  it('never produces a negative or non-finite cost', () => {
    const cost = priceRequest({ input: 3, cached: 0.3, output: 15 }, { inputTokens: 1, cachedTokens: 1, outputTokens: 1 })
    expect(cost).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(cost)).toBe(true)
  })
})

describe('zeroCost', () => {
  it('is zero micro-USD', () => {
    expect(zeroCost()).toBe(micros(0))
  })
})

describe('the provider catalog (pi-ai)', () => {
  it('prices a direct provider the dataset does not cover, at its published price', async () => {
    const { providerCatalogPrice } = await import('../../src/provider-catalog.js')
    const table = new PriceTable({ pricing: {}, unknown_model_policy: 'block' }, undefined, providerCatalogPrice)
    expect(table.resolve({ provider: 'zai', model: 'glm-5.3-flash' })).toMatchObject({
      input: 0.15,
      output: 0.5,
      cached: 0.03,
      source: 'provider-catalog',
    })
    // $0 in and out is a price the catalog does not know, not a free model.
    expect(table.resolve({ provider: 'zai', model: 'glm-5.3-highspeed' })).toBeUndefined()
    // A router keeps its own rules.
    expect(table.resolve({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash' })).toBeUndefined()
    // ops.yaml wins.
    const configured = new PriceTable(
      { pricing: { 'zai/glm-5.3-flash': { input: 1, cached: 1, output: 1 } }, unknown_model_policy: 'block' },
      undefined,
      providerCatalogPrice,
    )
    expect(configured.resolve({ provider: 'zai', model: 'glm-5.3-flash' })?.source).toBe('config')
  })
})
