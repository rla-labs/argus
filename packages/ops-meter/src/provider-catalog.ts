// == ARGUS AGENT PROJECT ==
/**
 * Prices from pi-ai's model catalog — the catalog dsh's own adapter routes with —
 * for every provider the AI API Pricing dataset does not cover (Z.ai, Groq, Mistral,
 * xAI, Google, …).
 *
 * The catalog is fixed per pi-ai version, so it ages between releases; `ops.yaml`
 * overrides it. A model it lists at $0 in and out is a price it does not know, not
 * a free model, and stays unpriced.
 *
 * @module @argus-agent/meter/provider-catalog
 */
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type { ModelRef } from '@argus-agent/types'
import type { Price } from './pricing.js'

let prices: Map<string, Price> | undefined

/**
 * One model's price in pi-ai's catalog, USD per million tokens.
 * @param ref the model.
 * @returns the price, or `undefined` when the catalog has none.
 */
export function providerCatalogPrice(ref: ModelRef): Price | undefined {
  prices ??= load()
  return prices.get(`${ref.provider}/${ref.model}`)
}

function load(): Map<string, Price> {
  const result = new Map<string, Price>()
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider as BuiltinProvider)) {
      const { input, output, cacheRead, cacheWrite } = model.cost
      if (input === 0 && output === 0) continue
      // A cache write the catalog does not price is billed as input, as elsewhere.
      result.set(`${provider}/${model.id}`, { input, output, cached: cacheRead, cacheWrite: cacheWrite > 0 ? cacheWrite : input })
    }
  }
  return result
}
