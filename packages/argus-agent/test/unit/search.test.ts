// == ARGUS AGENT PROJECT ==
/**
 * The search backends: the request each sends (the key in its header only), how its
 * answer maps to sources, the bound on results, and errors that never carry the key.
 */
import { describe, expect, it } from 'vitest'
import { runSearch, type SearchCall } from '../../src/search.js'

const KEY = 'sk-secret-search-key-1234'

/** A fetch that records the request and answers with `body` and `status`. */
function fakeFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: fn, calls }
}

const ANSWERS: Record<SearchCall['provider'], unknown> = {
  tavily: { answer: 'An answer', results: [{ title: 'T1', url: 'https://a.example/1', content: 'S1', published_date: '2026-10-01' }, { url: 'https://a.example/2' }, { title: 'no url' }] },
  brave: { web: { results: [{ title: 'T1', url: 'https://a.example/1', description: 'S1', page_age: '2026-10-01' }, { url: 'https://a.example/2' }] } },
  serper: { answerBox: { answer: 'An answer' }, organic: [{ title: 'T1', link: 'https://a.example/1', snippet: 'S1', date: '2026-10-01' }, { link: 'https://a.example/2' }] },
  searxng: { results: [{ title: 'T1', url: 'https://a.example/1', content: 'S1', publishedDate: '2026-10-01' }, { url: 'https://a.example/2' }] },
}

describe('runSearch', () => {
  for (const provider of ['tavily', 'brave', 'serper', 'searxng'] as const) {
    it(`${provider}: sends the query to its host, the key in a header only, and maps the sources`, async () => {
      const fake = fakeFetch(ANSWERS[provider])
      const call: SearchCall = provider === 'searxng' ? { provider, url: 'http://searxng.internal:8080/', fetch: fake.fetch } : { provider, key: KEY, fetch: fake.fetch }
      const result = await runSearch(call, { query: 'argus agent', maxResults: 3 })

      expect(result.sources[0]).toEqual({ url: 'https://a.example/1', title: 'T1', snippet: 'S1', publishedAt: '2026-10-01' })
      expect(result.sources[1]).toEqual({ url: 'https://a.example/2' })
      expect(result.sources).toHaveLength(2)
      if (provider === 'tavily' || provider === 'serper') expect(result.content).toBe('An answer')

      const [request] = fake.calls
      const host = { tavily: 'api.tavily.com', brave: 'api.search.brave.com', serper: 'google.serper.dev', searxng: 'searxng.internal:8080' }[provider]
      expect(new URL(request!.url).host).toBe(host)
      expect(request!.url).not.toContain(KEY)
      expect(String(request!.init.body ?? '')).not.toContain(KEY)
      expect(request!.init.redirect).toBe('error')
      const headers = JSON.stringify(request!.init.headers)
      if (provider === 'searxng') expect(headers).not.toContain(KEY)
      else expect(headers).toContain(KEY)
      // The count asked for is the caller's bound.
      const asked = `${request!.url} ${String(request!.init.body ?? '')}`
      if (provider !== 'searxng') expect(asked).toMatch(/"max_results":3|count=3|"num":3/)
      expect(asked).toContain(provider === 'searxng' || provider === 'brave' ? 'argus+agent' : 'argus agent')
    })
  }

  it('asks for at most 20 sources, and 10 when the caller sets no bound', async () => {
    const fake = fakeFetch(ANSWERS.serper)
    await runSearch({ provider: 'serper', key: KEY, fetch: fake.fetch }, { query: 'q', maxResults: 500 })
    await runSearch({ provider: 'serper', key: KEY, fetch: fake.fetch }, { query: 'q' })
    expect(fake.calls.map((call) => JSON.parse(String(call.init.body)).num)).toEqual([20, 10])
  })

  it('reports a refused key, a quota and an unreachable host without the key', async () => {
    for (const [status, why] of [[401, 'the key was refused'], [429, 'rate limit or quota reached'], [500, 'HTTP 500']] as const) {
      const error = await runSearch({ provider: 'tavily', key: KEY, fetch: fakeFetch({ detail: KEY }, status).fetch }, { query: 'q' }).catch((caught: unknown) => caught as Error & { code: string })
      expect(error.message).toContain(why)
      expect(error.message).not.toContain(KEY)
      expect(error.code).toBe('WEB_PROVIDER_ERROR')
    }
    const down = (async () => {
      throw new Error(`connect failed with ${KEY}`)
    }) as unknown as typeof fetch
    const error = await runSearch({ provider: 'brave', key: KEY, fetch: down }, { query: 'q' }).catch((caught: unknown) => caught as Error)
    expect(error.message).toContain('could not be reached')
    expect(error.message).not.toContain(KEY)
  })

  it('reports a cancelled search as aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const never = (async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
      return new Response('{}')
    }) as unknown as typeof fetch
    const error = await runSearch({ provider: 'tavily', key: KEY, fetch: never }, { query: 'q' }, controller.signal).catch((caught: unknown) => caught as { code: string })
    expect(error.code).toBe('WEB_ABORTED')
  })
})
