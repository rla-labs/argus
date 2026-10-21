// == ARGUS AGENT PROJECT ==
/**
 * The web search row: which backend answers the agents' `web_search`.
 *
 * dsh's base pins `searchProvider: deepseek-official` in its `web` row, and a pinned id
 * wins over `$DSH_WEB_SEARCH_PROVIDER`. The bundle patch pins `argus` instead, and this
 * row registers that one provider: it sends each search to the backend `ops.yaml` names
 * (`web_search.provider`), DeepSeek by default, so an upgrade changes nothing.
 *
 * - **DeepSeek** is dsh's own provider (`DeepSeekSearchProvider`), built here with the
 *   same defaults as the base's row, which the bundle disables. It logs the same session
 *   event, so `ops-meter` charges it as before.
 * - **Tavily, Brave, Serper, SearXNG** are one HTTP request each (`search.ts`). Each
 *   search is charged a fixed price, the list price unless `web_search.price_usd` says
 *   otherwise, through `ops/web-search`, to the project, task or front desk that searched.
 *
 * Provides `ctx.opsWebSearch`: which backend, whether it can search, and `argus doctor`.
 *
 * @module @argus-agent/argus-agent/search-row
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebSearchProvider, WebSearchRequest } from '@deepseek-ai/dsh-web'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
} from '@deepseek-ai/dsh-web-search-deepseek'
import type { DoctorFinding } from '@argus-agent/types'
import { credentialKeys } from './providers-row.js'
import { runSearch, SEARCH_KEYS, SEARCH_PRICES, SEARCH_PROVIDERS, type SearchProviderName } from './search.js'

/** Stable Cordis plugin name. */
export const name = 'ops-web-search'

export const inject = ['opsConfigRegistry', 'opsRawConfig', 'web', 'credentials']

/** The provider id the bundle pins in dsh's `web` row. */
export const ARGUS_SEARCH_PROVIDER = 'argus'

/** DeepSeek's key, which its search shares with its models. */
const DEEPSEEK_KEY = 'DEEPSEEK_API_KEY'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The web search backend, once the search row is mounted. */
    opsWebSearch: OpsWebSearch
  }
}

/** The `web_search` section. */
export interface WebSearchConfig {
  readonly provider: SearchProviderName
  /** SearXNG's base URL, e.g. `http://searxng:8080`. */
  readonly searxng_url?: string
  /** The price of one search, overriding the list price (0 inside a free tier). */
  readonly price_usd?: number
}

export const webSearchSchema: z = z
  .object({
    provider: z.union([...SEARCH_PROVIDERS]).default('deepseek').description('Who answers web_search: deepseek, tavily, brave, serper or searxng'),
    searxng_url: z.string().description('SearXNG\'s base URL, for provider: searxng'),
    price_usd: z.number().min(0).description('Charged per search instead of the provider\'s list price; 0 inside a free tier'),
  })
  .default({ provider: 'deepseek' })
  .description('Web search: which provider answers the agents\' web_search, and what a search costs')

/** What `/tools` and the web show about search. */
export interface SearchStatus {
  readonly provider: SearchProviderName
  /** Whether a search can run: its key, or SearXNG's URL, is set. */
  readonly ready: boolean
  /** What to do when it is not. */
  readonly fix?: string
  /** What one search is charged, in micro-USD; undefined for DeepSeek, charged by its tokens. */
  readonly priceMicros?: number
}

/** The search service. */
export class OpsWebSearch {
  constructor(
    private readonly config: WebSearchConfig,
    private readonly hasKey: (name: string) => boolean,
  ) {}

  /** The backend, whether it can search, and its price. */
  status(): SearchStatus {
    const { provider } = this.config
    const priceMicros = provider === 'deepseek' ? undefined : this.config.price_usd === undefined ? SEARCH_PRICES[provider] : Math.round(this.config.price_usd * 1_000_000)
    const price = priceMicros === undefined ? {} : { priceMicros }
    if (provider === 'searxng') {
      return this.config.searxng_url === undefined || !URL.canParse(this.config.searxng_url)
        ? { provider, ready: false, fix: 'set web_search.searxng_url in ops.yaml to your SearXNG, e.g. http://searxng:8080', ...price }
        : { provider, ready: true, ...price }
    }
    const key = provider === 'deepseek' ? DEEPSEEK_KEY : (SEARCH_KEYS[provider] as string)
    return this.hasKey(key) ? { provider, ready: true, ...price } : { provider, ready: false, fix: `send /key ${provider} <key>`, ...price }
  }

  /** `argus doctor`: the search backend and whether it can search. */
  doctor(): DoctorFinding[] {
    const status = this.status()
    return [
      status.ready
        ? { ok: true, check: `web search: ${status.provider}`, ...(status.priceMicros === undefined ? {} : { detail: `$${(status.priceMicros / 1_000_000).toFixed(4)} a search` }) }
        : { ok: false, check: `web search: ${status.provider}`, detail: 'it cannot search: every web_search fails', fix: status.fix as string },
    ]
  }
}

/** The calling agent's session, when a search runs inside one. */
function callerSession(ctx: Context): { id: unknown; append(type: string, data: unknown): void } | undefined {
  const agents = ctx.get('agents' as never) as unknown as { currentInitiator(): { session: { id: unknown; append(type: string, data: unknown): void } } | undefined } | undefined
  return agents?.currentInitiator()?.session
}

/**
 * Mount the search provider.
 *
 * @param ctx the row's context.
 */
export async function apply(ctx: Context): Promise<void> {
  const section = ctx.opsConfigRegistry.extend('web_search', webSearchSchema)
  ctx.effect(() => section)
  const logger = ctx.logger('ops-web-search')
  let config: WebSearchConfig
  try {
    config = (webSearchSchema as unknown as (value: unknown) => WebSearchConfig)(ctx.opsRawConfig['web_search'])
  } catch (error) {
    // A malformed section is reported by the config loader; search stays on DeepSeek.
    logger.warn('web_search in ops.yaml does not validate (%s); searching through DeepSeek', (error as Error).message)
    config = { provider: 'deepseek' }
  }

  const keys = await credentialKeys(ctx, [DEEPSEEK_KEY, ...Object.values(SEARCH_KEYS)])
  const service = new OpsWebSearch(config, (key) => keys.has(key))

  const deepseek = new DeepSeekSearchProvider(() => ({
    apiKeyEnv: credentialRef(DEEPSEEK_KEY),
    resolveApiKey: () => keys.value(DEEPSEEK_KEY),
    baseURL: process.env['DEEPSEEK_SEARCH_BASE_URL'] ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: DEEPSEEK_DEFAULT_MODEL,
    apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: DEEPSEEK_DEFAULT_MAX_USES,
    // The event ops-meter charges a DeepSeek search from, as dsh's own row logs it.
    recordRequest: (request) => callerSession(ctx)?.append('web/deepseek-search-llm-request', request),
  }))

  const provider: WebSearchProvider = {
    id: ARGUS_SEARCH_PROVIDER,
    available: () => service.status().ready,
    search: async (request: WebSearchRequest, signal?: AbortSignal) => {
      if (config.provider === 'deepseek') return deepseek.search(request, signal)
      const key = config.provider === 'searxng' ? undefined : await keys.value(SEARCH_KEYS[config.provider] as string)
      logger.debug('search through %s: %s', config.provider, request.query)
      const result = await runSearch({ provider: config.provider, ...(key === undefined ? {} : { key }), ...(config.searxng_url === undefined ? {} : { url: config.searxng_url }) }, request, signal)
      const session = callerSession(ctx)
      const costMicros = service.status().priceMicros ?? 0
      if (session !== undefined) {
        ;(ctx as unknown as { emit(name: string, payload: unknown): void }).emit('ops/web-search', { sessionId: String(session.id), provider: config.provider, costMicros })
      }
      return result
    },
  }
  ctx.effect(() => ctx.web.registerSearchProvider(provider))
  ctx.provide('opsWebSearch', service)

  const status = service.status()
  if (status.ready) logger.info('web search through %s', status.provider)
  else logger.warn('web search through %s cannot work: %s', status.provider, status.fix)
}
