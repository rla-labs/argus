// == ARGUS AGENT PROJECT ==
/**
 * Web search backends other than DeepSeek: Tavily, Brave, Serper and SearXNG.
 *
 * Each is one HTTP request to a fixed host (SearXNG: the admin's URL), mapped to dsh's
 * search result. The key goes in that request's header and nowhere else: never in a
 * URL, an error or a log line.
 *
 * @module @argus-agent/argus-agent/search
 */
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { WebError } from '@deepseek-ai/dsh-web'

/** The backends `web_search.provider` may name. */
export const SEARCH_PROVIDERS = ['deepseek', 'tavily', 'brave', 'serper', 'searxng'] as const
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number]

/** The variable each keyed backend reads its key from: `/key <provider> <key>` saves it. */
export const SEARCH_KEYS: Readonly<Record<string, string>> = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  serper: 'SERPER_API_KEY',
}

/** List price per search, in micro-USD, checked 2026-10-21. `web_search.price_usd` overrides it. */
export const SEARCH_PRICES: Readonly<Record<string, number>> = {
  tavily: 8_000,
  brave: 5_000,
  serper: 1_000,
  searxng: 0,
}

/** Sources asked for when the caller sets no bound, and the most any backend is asked for. */
const DEFAULT_RESULTS = 10
const MAX_RESULTS = 20

type Fetch = typeof fetch

/** What one HTTP backend needs for a search. */
export interface SearchCall {
  readonly provider: Exclude<SearchProviderName, 'deepseek'>
  /** The key; undefined for SearXNG. */
  readonly key?: string
  /** SearXNG's base URL. */
  readonly url?: string
  readonly fetch?: Fetch
}

/**
 * The request a backend is sent.
 * @param call the backend and its key.
 * @param query the query.
 * @param count how many sources to ask for.
 * @returns the URL and the fetch options.
 */
export function searchRequest(call: SearchCall, query: string, count: number): { url: string; init: RequestInit } {
  const json = { 'content-type': 'application/json', accept: 'application/json' }
  switch (call.provider) {
    case 'tavily':
      return {
        url: 'https://api.tavily.com/search',
        init: { method: 'POST', headers: { ...json, authorization: `Bearer ${call.key ?? ''}` }, body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }) },
      }
    case 'brave':
      return {
        url: `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count) })}`,
        init: { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': call.key ?? '' } },
      }
    case 'serper':
      return {
        url: 'https://google.serper.dev/search',
        init: { method: 'POST', headers: { ...json, 'x-api-key': call.key ?? '' }, body: JSON.stringify({ q: query, num: count }) },
      }
    case 'searxng':
      return {
        url: `${(call.url ?? '').replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`,
        init: { method: 'GET', headers: { accept: 'application/json' } },
      }
  }
}

/** A string field of an untyped object, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** One source, from an untyped result with the backend's own field names. */
function source(item: unknown, fields: { url: string; title: string; snippet: string; date: string }): WebSearchSource[] {
  const row = (item ?? {}) as Record<string, unknown>
  const url = text(row[fields.url])
  if (url === undefined) return []
  const title = text(row[fields.title])
  const snippet = text(row[fields.snippet])
  const publishedAt = text(row[fields.date])
  return [{ url, ...(title === undefined ? {} : { title }), ...(snippet === undefined ? {} : { snippet }), ...(publishedAt === undefined ? {} : { publishedAt }) }]
}

/**
 * A backend's answer, as dsh's search result. The seam truncates to `maxResults`.
 * @param provider the backend.
 * @param body its parsed JSON.
 * @returns the result.
 */
export function searchResult(provider: SearchCall['provider'], body: unknown): WebSearchResult {
  const root = (body ?? {}) as Record<string, unknown>
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  switch (provider) {
    case 'tavily': {
      const content = text(root['answer'])
      return { ...(content === undefined ? {} : { content }), sources: list(root['results']).flatMap((item) => source(item, { url: 'url', title: 'title', snippet: 'content', date: 'published_date' })), truncated: false }
    }
    case 'brave':
      return { sources: list((root['web'] as Record<string, unknown> | undefined)?.['results']).flatMap((item) => source(item, { url: 'url', title: 'title', snippet: 'description', date: 'page_age' })), truncated: false }
    case 'serper': {
      const answer = (root['answerBox'] ?? {}) as Record<string, unknown>
      const content = text(answer['answer']) ?? text(answer['snippet'])
      return { ...(content === undefined ? {} : { content }), sources: list(root['organic']).flatMap((item) => source(item, { url: 'link', title: 'title', snippet: 'snippet', date: 'date' })), truncated: false }
    }
    case 'searxng':
      return { sources: list(root['results']).flatMap((item) => source(item, { url: 'url', title: 'title', snippet: 'content', date: 'publishedDate' })), truncated: false }
  }
}

/**
 * Run one search on an HTTP backend.
 *
 * @param call the backend, its key or URL.
 * @param request what dsh asks for.
 * @param signal cancellation.
 * @returns the result.
 * @throws {WebError} `WEB_ABORTED` when cancelled, `WEB_PROVIDER_ERROR` for any failure; never with the key.
 */
export async function runSearch(call: SearchCall, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
  const count = Math.min(Math.max(request.maxResults ?? DEFAULT_RESULTS, 1), MAX_RESULTS)
  const { url, init } = searchRequest(call, request.query, count)
  const host = new URL(url).host
  let response: Response
  try {
    response = await (call.fetch ?? fetch)(url, { ...init, redirect: 'error', ...(signal === undefined ? {} : { signal }) })
  } catch (error) {
    if (signal?.aborted === true) throw new WebError(`${call.provider} search aborted`, 'WEB_ABORTED', { cause: signal.reason })
    throw new WebError(`${call.provider} search: ${host} could not be reached (${(error as Error).name})`, 'WEB_PROVIDER_ERROR')
  }
  if (!response.ok) {
    const why = response.status === 401 || response.status === 403 ? ': the key was refused' : response.status === 429 ? ': rate limit or quota reached' : ''
    throw new WebError(`${call.provider} search: ${host} answered HTTP ${response.status}${why}`, 'WEB_PROVIDER_ERROR')
  }
  try {
    return searchResult(call.provider, await response.json())
  } catch {
    throw new WebError(`${call.provider} search: ${host} did not answer JSON`, 'WEB_PROVIDER_ERROR')
  }
}
