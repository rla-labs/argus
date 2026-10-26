// == ARGUS AGENT PROJECT ==
/**
 * A route on the egress proxy: the provider gets the credential the route adds, never the
 * agent's own; a route that is gone, an unknown one or a path outside /v1/ is refused.
 */
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressProxy } from '../../src/egress.js'

const servers: Server[] = []
const proxies: EgressProxy[] = []
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close()
  for (const server of servers.splice(0)) server.close()
})

/** A provider that answers with what it received. */
async function provider(): Promise<{ url: string; seen: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> }> {
  const seen: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end('event: message_stop\ndata: {}\n\n')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }
}

/** POST through the proxy, as Claude Code does with its base URL and a dummy token. */
function post(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: 'Bearer argus-route', 'content-type': 'application/json', ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end('{"model":"claude-x"}')
  })
}

describe('a route on the egress proxy', () => {
  it('puts in an API key, or a subscription token with its beta, in place of what the agent sends', async () => {
    const upstream = await provider()
    const proxy = new EgressProxy()
    proxies.push(proxy)
    const base = await proxy.url()
    const api = proxy.addRoute(upstream.url, async () => ({ kind: 'api-key', value: 'sk-ant-api-real' }))
    expect((await post(`${base}${api.path}/v1/messages?beta=true`, { 'x-api-key': 'agent-forged' })).status).toBe(200)
    expect(upstream.seen[0]).toMatchObject({ path: '/v1/messages?beta=true', body: '{"model":"claude-x"}' })
    expect(upstream.seen[0]?.headers['x-api-key']).toBe('sk-ant-api-real')
    expect(upstream.seen[0]?.headers['authorization']).toBeUndefined()

    const oauth = proxy.addRoute(upstream.url, async () => ({ kind: 'oauth', value: 'sk-ant-oat01-real' }))
    expect((await post(`${base}${oauth.path}/v1/messages`, { 'anthropic-beta': 'claude-code-20250219' })).status).toBe(200)
    expect(upstream.seen[1]?.headers['authorization']).toBe('Bearer sk-ant-oat01-real')
    expect(upstream.seen[1]?.headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20')
    expect(upstream.seen[1]?.headers['x-api-key']).toBeUndefined()
  })

  it('says what to do when there is no credential, and refuses a route that is gone, unknown, or a path outside /v1/', async () => {
    const upstream = await provider()
    const proxy = new EgressProxy()
    proxies.push(proxy)
    const base = await proxy.url()
    const none = proxy.addRoute(upstream.url, async () => 'send /key CLAUDE_CODE_OAUTH_TOKEN <token>')
    const missing = await post(`${base}${none.path}/v1/messages`)
    expect(missing.status).toBe(401)
    expect(JSON.parse(missing.body)).toEqual({ type: 'error', error: { type: 'authentication_error', message: 'Argus: send /key CLAUDE_CODE_OAUTH_TOKEN <token>' } })
    const route = proxy.addRoute(upstream.url, async () => ({ kind: 'api-key', value: 'k' }))
    expect((await post(`${base}${route.path}/api/oauth/profile`)).status).toBe(404)
    expect((await post(`${base}/r/feedface/v1/messages`)).status).toBe(404)
    route.remove()
    expect((await post(`${base}${route.path}/v1/messages`)).status).toBe(404)
    expect(upstream.seen).toEqual([])
  })
})
