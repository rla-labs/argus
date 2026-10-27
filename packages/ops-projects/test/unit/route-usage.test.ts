// == ARGUS AGENT PROJECT ==
/**
 * An OpenAI route: Argus's key in place of the agent's, a request refused before it goes,
 * and what each answer used, read from the provider's own answer.
 */
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressProxy, usageReader, type RouteUsage } from '../../src/egress.js'

const servers: Server[] = []
const proxies: EgressProxy[] = []
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close()
  for (const server of servers.splice(0)) server.close()
})

const COMPLETED = { type: 'response.completed', response: { id: 'r1', model: 'gpt-x-2026', usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 30 } } }

describe('usageReader', () => {
  it('reads a Responses stream’s response.completed, however it is cut, cached tokens apart', () => {
    const reader = usageReader('text/event-stream; charset=utf-8', 'gpt-asked')
    const text = `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify(COMPLETED)}\n\n`
    for (let at = 0; at < text.length; at += 7) reader.push(Buffer.from(text.slice(at, at + 7)))
    expect(reader.done()).toEqual({ model: 'gpt-x-2026', inputTokens: 200, cachedTokens: 1000, outputTokens: 30 })
  })

  it('reads a JSON answer, and nothing from one without usage', () => {
    const json = usageReader('application/json', 'gpt-asked')
    json.push(Buffer.from(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2 } })))
    expect(json.done()).toEqual({ model: 'gpt-asked', inputTokens: 10, cachedTokens: 0, outputTokens: 2 })
    const none = usageReader('application/json', undefined)
    none.push(Buffer.from('{"error":"x"}'))
    expect(none.done()).toBeUndefined()
  })
})

describe('an OpenAI route', () => {
  async function openai(): Promise<{ url: string; seen: Array<{ headers: IncomingHttpHeaders; body: string }> }> {
    const seen: Array<{ headers: IncomingHttpHeaders; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        seen.push({ headers: req.headers, body })
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: response.completed\ndata: ${JSON.stringify(COMPLETED)}\n\n`)
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }
  }

  const post = (url: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { authorization: 'Bearer argus-dummy', 'content-type': 'application/json' } }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ model: 'gpt-x-2026', stream: true, input: [] }))
    })

  it('puts in Argus’s key, counts what the answer says it used, and refuses what the governor refuses', async () => {
    const upstream = await openai()
    const proxy = new EgressProxy()
    proxies.push(proxy)
    const base = await proxy.url()
    const counted: RouteUsage[] = []
    const asked: Array<string | undefined> = []
    let refuse: string | undefined
    const route = proxy.addRoute(upstream.url, async () => ({ kind: 'bearer', value: 'sk-proj-real' }), {
      admit: (model) => (asked.push(model), refuse),
      usage: (usage) => counted.push(usage),
    })
    const ok = await post(`${base}${route.path}/v1/responses`)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('response.completed')
    expect(upstream.seen[0]?.headers['authorization']).toBe('Bearer sk-proj-real')
    expect(JSON.parse(upstream.seen[0]?.body ?? '{}')).toMatchObject({ model: 'gpt-x-2026' })
    expect(asked).toEqual(['gpt-x-2026'])
    expect(counted).toEqual([{ model: 'gpt-x-2026', inputTokens: 200, cachedTokens: 1000, outputTokens: 30 }])

    refuse = 'the project budget is exhausted'
    const refused = await post(`${base}${route.path}/v1/responses`)
    expect(refused.status).toBe(429)
    expect(JSON.parse(refused.body).error.message).toBe('Argus: the project budget is exhausted')
    expect(upstream.seen).toHaveLength(1)
    expect(counted).toHaveLength(1)
  })
})
