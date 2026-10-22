// == ARGUS AGENT PROJECT ==
/**
 * A remote MCP server that signs in with OAuth, against a fake authorization server and
 * a fake MCP server: the admin connects it per project, the agent reaches it through the
 * loopback proxy with a token it never holds, the token is refreshed during use, a
 * refused grant takes the tools away and tells the admin, and disconnecting revokes it.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { oauthSecretName } from '../../src/oauth.js'
import { bootProjects } from '../helpers.js'

const listen = (server: Server): Promise<string> => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
const bodyOf = async (request: IncomingMessage): Promise<string> => {
  let text = ''
  for await (const chunk of request) text += chunk
  return text
}

/** The provider: discovery, dynamic registration, PKCE, rotating refresh tokens, revocation. */
const provider = {
  clients: new Map<string, { client_id: string; client_secret: string; redirect_uris: string[] }>(),
  codes: new Map<string, { client: string; challenge: string; redirect: string; resource: string | null }>(),
  access: new Map<string, number>(),
  refresh: new Set<string>(),
  revoked: [] as string[],
  refreshes: 0,
  lifetime: 61,
}
let AS = ''
let MCP = ''
const servers: Server[] = []

beforeAll(async () => {
  const as = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register`, revocation_endpoint: `${AS}/revoke`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
      })
    }
    if (url.pathname === '/register') {
      const meta = JSON.parse(await bodyOf(request)) as { redirect_uris: string[] }
      const client = { ...meta, client_id: `client-${randomBytes(4).toString('hex')}`, client_secret: `CS-SECRET-${randomBytes(6).toString('hex')}` }
      provider.clients.set(client.client_id, client)
      return json(201, client)
    }
    if (url.pathname === '/authorize') {
      // The consent screen, answered at once.
      const params = url.searchParams
      const code = randomBytes(8).toString('hex')
      provider.codes.set(code, { client: params.get('client_id') ?? '', challenge: params.get('code_challenge') ?? '', redirect: params.get('redirect_uri') ?? '', resource: params.get('resource') })
      response.writeHead(302, { location: `${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}&iss=${encodeURIComponent(AS)}` })
      return response.end()
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(await bodyOf(request))
      const client = provider.clients.get(params.get('client_id') ?? '')
      if (client === undefined || client.client_secret !== params.get('client_secret')) return json(401, { error: 'invalid_client' })
      const issue = () => {
        const access = `AT-SECRET-${randomBytes(6).toString('hex')}`
        const refresh = `RT-SECRET-${randomBytes(6).toString('hex')}`
        provider.access.set(access, Date.now() + provider.lifetime * 1000)
        provider.refresh.add(refresh)
        return json(200, { access_token: access, token_type: 'Bearer', expires_in: provider.lifetime, refresh_token: refresh, scope: 'docs.read' })
      }
      if (params.get('grant_type') === 'authorization_code') {
        const code = provider.codes.get(params.get('code') ?? '')
        provider.codes.delete(params.get('code') ?? '')
        const verified = code !== undefined && code.client === client.client_id && code.redirect === params.get('redirect_uri') && code.challenge === createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url')
        return verified ? issue() : json(400, { error: 'invalid_grant' })
      }
      if (params.get('grant_type') === 'refresh_token') {
        const token = params.get('refresh_token') ?? ''
        if (!provider.refresh.has(token)) return json(400, { error: 'invalid_grant' })
        provider.refresh.delete(token)
        provider.refreshes++
        return issue()
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    if (url.pathname === '/revoke') {
      provider.revoked.push(new URLSearchParams(await bodyOf(request)).get('token') ?? '')
      response.writeHead(200)
      return response.end()
    }
    response.writeHead(404)
    response.end()
  })
  AS = await listen(as)

  const sessions = new Set<string>()
  const mcp = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ resource: `${MCP}/mcp`, authorization_servers: [AS] }))
    }
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const expires = provider.access.get(token)
    if (expires === undefined || expires < Date.now()) {
      response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource/mcp"` })
      return response.end()
    }
    if (request.method !== 'POST') {
      response.writeHead(request.method === 'DELETE' ? 200 : 405)
      return response.end()
    }
    const message = JSON.parse(await bodyOf(request)) as { id?: number; method: string; params?: { protocolVersion?: string } }
    if (message.method === 'initialize') {
      const session = randomBytes(8).toString('hex')
      sessions.add(session)
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session })
      return response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1' } } }))
    }
    if (message.id === undefined) {
      response.writeHead(202)
      return response.end()
    }
    if (message.method === 'tools/list') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'whoami', description: 'who', inputSchema: { type: 'object' } }] } }))
    }
    // A call is answered as an event stream: the proxy must stream it through.
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'alice' }] } })}\n\n`)
  })
  MCP = await listen(mcp)
  servers.push(as, mcp)
})

afterAll(() => {
  for (const server of servers) server.close()
})

/** The tool an agent sees under a name, through the scope-aware lookup. */
async function toolOf(agent: unknown, name: string): Promise<{ execute(args: unknown, exec: unknown): Promise<unknown> } | undefined> {
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  const ctx = (agent as { ctx: { tools: { get(name: string, scope: unknown): unknown } } }).ctx
  return ctx.tools.get(name, scopeOf(ctx as never)) as never
}

const call = async (tool: { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined): Promise<string> => {
  try {
    return JSON.stringify(await tool?.execute({}, { signal: new AbortController().signal }))
  } catch (error) {
    return String((error as Error).message)
  }
}

describe('an MCP server that signs in with OAuth', () => {
  it('is connected per project, reached with a token the agent never holds, refreshed, refused, and revoked', async () => {
    const server = { url: `${MCP}/mcp`, oauth: { scopes: ['docs.read'] } }
    const booted = await bootProjects({ projects: { site: { mcp: { docs: server } }, other: { mcp: { docs: server } } } })
    const secrets = new Map<string, string>()
    ;(booted.ctx as unknown as { provide(name: string, value: unknown): void }).provide('credentials', {
      set: async (ref: unknown, value: string) => void secrets.set(String(ref), value),
      unset: async (ref: unknown) => void secrets.delete(String(ref)),
      resolve: async (ref: unknown) => (secrets.has(String(ref)) ? { value: secrets.get(String(ref)) } : undefined),
    })
    const events: Array<{ projectId: string; state: string }> = []
    ;(booted.ctx as unknown as { on(name: string, listener: (payload: { projectId: string; state: string }) => void): void }).on('ops/mcp-auth', (payload) => void events.push(payload))
    const { projects } = booted

    // Not connected: left out, and said so.
    expect(await toolOf(await projects.ensureAgent('site'), 'mcp__docs__whoami')).toBeUndefined()
    expect(JSON.stringify(await projects.doctor())).toContain('the MCP server docs is not connected')

    // The admin connects: /mcp connect's key, the web's start, the provider, the callback.
    const prepared = projects.oauth.prepare('site', 'docs')
    if (!prepared.ok) throw new Error(prepared.message)
    const begun = await projects.oauth.begin(prepared.key, 'http://127.0.0.1:3090/oauth/callback')
    if (!begun.ok) throw new Error(begun.message)
    expect(new URL(begun.url).searchParams.get('code_challenge_method')).toBe('S256')
    expect(new URL(begun.url).searchParams.get('resource')).toBe(`${MCP}/mcp`)
    expect(await projects.oauth.begin(prepared.key, 'http://127.0.0.1:3090/oauth/callback')).toMatchObject({ ok: false })
    const consent = await fetch(begun.url, { redirect: 'manual' })
    const back = new URL(consent.headers.get('location') ?? '')
    expect(await projects.oauth.finish(back.searchParams)).toMatchObject({ ok: true, message: expect.stringContaining('site: docs is connected') })
    expect(await projects.oauth.finish(back.searchParams)).toMatchObject({ ok: false })
    expect(events).toEqual([{ projectId: 'site', server: 'docs', state: 'connected' }])
    expect([...secrets.keys()].some((name) => name.includes(oauthSecretName('site', 'docs')))).toBe(true)

    // The next message's agent has the tool; dsh is given the proxy, not the server.
    const tool = await toolOf(await projects.ensureAgent('site'), 'mcp__docs__whoami')
    expect(tool).toBeDefined()
    expect(await call(tool)).toContain('alice')
    expect(await toolOf(await projects.ensureAgent('other'), 'mcp__docs__whoami')).toBeUndefined()

    // The token nears its expiry: refreshed once, even for three calls at once.
    await new Promise((done) => setTimeout(done, 1_200))
    const results = await Promise.all([call(tool), call(tool), call(tool)])
    expect(results.every((text) => text.includes('alice'))).toBe(true)
    expect(provider.refreshes).toBe(1)

    // The provider refuses the grant: the call tells the model to ask the admin, the admin
    // is told (the event ops-health listens to), and the server is signed out.
    provider.refresh.clear()
    await new Promise((done) => setTimeout(done, 1_200))
    expect(await call(tool)).toMatch(/not connected, or its sign-in was refused: ask the admin/)
    expect(events.at(-1)).toMatchObject({ projectId: 'site', server: 'docs', state: 'failed', reason: 'invalid_grant' })
    expect(await projects.oauth.status('site', 'docs')).toMatchObject({ state: 'failed' })

    // Connected again, then disconnected: revoked at the provider, forgotten here.
    const again = projects.oauth.prepare('site', 'docs')
    if (!again.ok) throw new Error(again.message)
    const second = await projects.oauth.begin(again.key, 'http://127.0.0.1:3090/oauth/callback')
    if (!second.ok) throw new Error(second.message)
    expect(await projects.oauth.finish(new URL((await fetch(second.url, { redirect: 'manual' })).headers.get('location') ?? '').searchParams)).toMatchObject({ ok: true })
    expect(await projects.oauth.disconnect('site', 'docs')).toBe(true)
    expect(provider.revoked.at(-1)).toMatch(/^RT-SECRET-/)
    expect([...secrets.keys()].some((name) => name.includes(oauthSecretName('site', 'docs')))).toBe(false)
    expect(await projects.oauth.status('site', 'docs')).toEqual({ state: 'not connected' })

    // No token or client secret in the audit log.
    const audit = JSON.stringify(booted.store.audit.byAction('mcp.oauth.connect', 10)) + JSON.stringify(booted.store.audit.byAction('mcp.oauth.refresh-failed', 10)) + JSON.stringify(booted.store.audit.byAction('mcp.oauth.disconnect', 10))
    expect(audit).toContain('mcp.oauth')
    expect(audit).not.toMatch(/AT-SECRET|RT-SECRET|CS-SECRET/)
  }, 60_000)

  it('refuses a callback it did not start, a server with no oauth block, and a client not in ops.yaml', async () => {
    const booted = await bootProjects({ projects: { site: { mcp: { plain: { url: `${MCP}/mcp` }, docs: { url: `${MCP}/mcp`, oauth: { client: 'google' } } } } } })
    const { projects } = booted
    expect(await projects.oauth.finish(new URLSearchParams({ state: 'forged', code: 'x' }))).toMatchObject({ ok: false, message: expect.stringContaining('not known') })
    expect(projects.oauth.prepare('site', 'plain')).toMatchObject({ ok: false, message: expect.stringContaining('does not sign in with OAuth') })
    expect(projects.oauth.prepare('site', 'docs')).toMatchObject({ ok: false, message: expect.stringContaining('no OAuth client "google"') })
    expect(projects.oauth.begin('never-made-key-0123456789', 'http://127.0.0.1:3090/oauth/callback')).resolves.toMatchObject({ ok: false })
  }, 60_000)
})
