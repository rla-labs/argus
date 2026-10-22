// == ARGUS AGENT PROJECT ==
/**
 * OAuth for a project's remote MCP servers, done by Argus.
 *
 * The admin connects a server once per project (`/mcp connect`): Argus sends the admin's
 * browser to the provider with PKCE and a one-time `state`, takes the code at the web's
 * `/oauth/callback`, and keeps the grant in the credentials store, under a name per
 * project and server. The agent never holds a token: dsh is pointed at a loopback proxy
 * ({@link OAuthProxy}) that adds a fresh access token to each request and refreshes it
 * when it expires, in the middle of a run if need be.
 *
 * The protocol is `@modelcontextprotocol/client`'s (discovery, dynamic registration,
 * PKCE, code exchange, refresh); this module holds the state between the steps.
 *
 * @module @argus-agent/projects/oauth
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  OAuthError,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/client'
import z from '@deepseek-ai/schemastery'
import type { McpServer } from '@argus-agent/types'

/** The prefix of every grant's credential name; reserved like `ARGUS_GIT_` and `ARGUS_MAIL_`. */
export const OAUTH_SECRET_PREFIX = 'ARGUS_OAUTH_'

/** How long a `/mcp connect` link, and a sign-in started from it, stay valid. */
const PENDING_MS = 10 * 60_000

/** A token this close to its expiry is refreshed before it is used. */
const EARLY_REFRESH_MS = 60_000

/**
 * The credential name of one project's grant for one server.
 *
 * @param projectId the project.
 * @param server the server's name.
 * @returns `ARGUS_OAUTH_<24 hex>`.
 */
export function oauthSecretName(projectId: string, server: string): string {
  return `${OAUTH_SECRET_PREFIX}${createHash('sha256').update(`${projectId}/${server}`).digest('hex').slice(0, 24).toUpperCase()}`
}

/** Whether a credential name is a grant's, which only Argus's proxy may use. */
export function isOAuthSecretName(name: string): boolean {
  return name.toUpperCase().startsWith(OAUTH_SECRET_PREFIX)
}

/** Extra parameters a provider needs, by preset name. */
export const OAUTH_PRESETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Without these Google gives no refresh token, and the grant would last an hour.
  google: { access_type: 'offline', prompt: 'consent' },
  slack: {},
}

/** A client the admin registered at a provider (`oauth_clients.<name>` in `ops.yaml`). */
export interface OAuthClientSettings {
  readonly preset?: string
  readonly client_id: string
  /** May hold `${NAME}`, filled from the credentials store. */
  readonly client_secret?: string
  /** Endpoints, for a provider that does not publish them; otherwise discovered. */
  readonly authorization_url?: string
  readonly token_url?: string
  readonly revocation_url?: string
}

export const oauthClientsSchema: z = z
  .dict(
    z.object({
      preset: z.union(Object.keys(OAUTH_PRESETS).map((name) => z.const(name))).description('Extra parameters a provider needs: google, slack'),
      client_id: z.string().required(),
      client_secret: z.string().description('${NAME}, set with /key NAME …'),
      authorization_url: z.string(),
      token_url: z.string(),
      revocation_url: z.string(),
    }),
  )
  .default({})
  .description('OAuth clients the admin registered at providers, for MCP servers that sign in')

/**
 * The `oauth_clients` section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the clients by name.
 */
export function oauthClientsOf(raw: Record<string, unknown>): Readonly<Record<string, OAuthClientSettings>> {
  const parse = oauthClientsSchema as unknown as (value: unknown) => Record<string, OAuthClientSettings>
  return parse(raw['oauth_clients'] ?? {})
}

/** What is kept in the credentials store for one project and server. */
interface Grant {
  readonly v: 1
  /** The server's URL when it was connected: another URL needs a new connection. */
  readonly url: string
  readonly as: string
  readonly metadata: AuthorizationServerMetadata
  /** The client: one from `oauth_clients`, by name, or one Argus registered itself. */
  readonly client: { readonly name: string } | { readonly registered: { readonly client_id: string; readonly client_secret?: string } }
  readonly tokens: { readonly access_token: string; readonly refresh_token?: string; readonly expires_at?: number; readonly scope?: string }
  readonly connectedAt: number
  /** Set when the provider refused a refresh: the admin must connect again. */
  readonly failed?: string
}

/** The credentials store, as far as grants need it. */
export interface OAuthSecrets {
  set(ref: unknown, value: string): Promise<unknown>
  unset(ref: unknown): Promise<unknown>
  resolve(ref: unknown): Promise<{ value: string } | undefined>
}

/** Where the module learns about the world it runs in. */
export interface OAuthDeps {
  readonly secrets: () => OAuthSecrets | undefined
  readonly ref: (name: string) => unknown
  readonly clients: () => Readonly<Record<string, OAuthClientSettings>>
  /** A project's server, as configured now. */
  readonly serverOf: (projectId: string, server: string) => McpServer | undefined
  /** Fill `${NAME}` in a client secret. */
  readonly expand: (value: string) => Promise<string>
  readonly audit: (action: string, projectId: string, details: Record<string, unknown>) => void
  /** A grant was made, removed or refused: the project's agent is rebuilt, the admin told. */
  readonly changed: (projectId: string, server: string, state: 'connected' | 'disconnected' | 'failed', reason?: string) => void
  readonly now?: () => number
  readonly fetch?: typeof fetch
}

/** The server is not connected, or its grant was refused: the model is told to ask the admin. */
export class NotConnectedError extends Error {}

/** A connection under way, between the admin's click and the provider's answer. */
interface PendingSignIn {
  readonly projectId: string
  readonly server: string
  readonly url: string
  readonly as: string
  readonly metadata: AuthorizationServerMetadata
  readonly client: Grant['client']
  readonly clientInformation: OAuthClientInformationMixed
  readonly codeVerifier: string
  readonly redirectUri: string
  readonly expires: number
}

/** OAuth grants for MCP servers: connecting, refreshing, disconnecting. */
export class McpOAuth {
  private readonly links = new Map<string, { projectId: string; server: string; expires: number }>()
  private readonly signIns = new Map<string, PendingSignIn>()
  private readonly cache = new Map<string, Grant | null>()
  private readonly refreshing = new Map<string, Promise<Grant>>()
  private readonly now: () => number

  constructor(private readonly deps: OAuthDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Start `/mcp connect`: a one-time key for the web's `/oauth/start/<key>`.
   *
   * @returns the key, or why the server cannot be connected.
   */
  prepare(projectId: string, server: string): { ok: true; key: string } | { ok: false; message: string } {
    const config = this.deps.serverOf(projectId, server)
    if (config === undefined) return { ok: false, message: `${projectId} has no MCP server "${server}".` }
    if (config.oauth === null || config.url === null) return { ok: false, message: `${server} does not sign in with OAuth: give it oauth: in the project's mcp block.` }
    if (config.oauth.client !== null && this.deps.clients()[config.oauth.client] === undefined) {
      return { ok: false, message: `There is no OAuth client "${config.oauth.client}" in ops.yaml (oauth_clients).` }
    }
    const key = randomBytes(24).toString('base64url')
    this.sweep()
    this.links.set(key, { projectId, server, expires: this.now() + PENDING_MS })
    return { ok: true, key }
  }

  /**
   * The web's `/oauth/start/<key>`, opened by the admin: where to send the browser.
   *
   * @param key the key `prepare` gave, used once.
   * @param redirectUri `<public_url>/oauth/callback`.
   * @returns the provider's sign-in URL, or why not.
   */
  async begin(key: string, redirectUri: string): Promise<{ ok: true; url: string; projectId: string; server: string } | { ok: false; message: string }> {
    const link = this.links.get(key)
    this.links.delete(key)
    if (link === undefined || link.expires < this.now()) return { ok: false, message: 'This link is not valid: it was used already, or it is older than ten minutes. Send /mcp connect again.' }
    const config = this.deps.serverOf(link.projectId, link.server)
    if (config?.oauth === null || config?.oauth === undefined || config.url === null) return { ok: false, message: `${link.projectId} no longer has an OAuth server "${link.server}".` }
    try {
      const named = config.oauth.client === null ? undefined : this.deps.clients()[config.oauth.client]
      if (config.oauth.client !== null && named === undefined) return { ok: false, message: `There is no OAuth client "${config.oauth.client}" in ops.yaml.` }
      const { as, metadata } = await this.discover(config.url, named)
      let client: Grant['client']
      let clientInformation: OAuthClientInformationMixed
      if (named !== undefined) {
        client = { name: config.oauth.client as string }
        clientInformation = await this.clientOf(client)
      } else {
        if (metadata.registration_endpoint === undefined) {
          return { ok: false, message: `${new URL(as).host} does not let a client register itself: register one there, add it under oauth_clients in ops.yaml, and name it in mcp.${link.server}.oauth.client.` }
        }
        const methods = metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
        const registered = await registerClient(as, {
          metadata,
          clientMetadata: {
            client_name: 'Argus',
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: methods.includes('client_secret_post') ? 'client_secret_post' : methods.includes('none') ? 'none' : 'client_secret_basic',
          },
          ...this.fetchOption(),
        })
        client = { registered: { client_id: registered.client_id, ...(registered.client_secret === undefined ? {} : { client_secret: registered.client_secret }) } }
        clientInformation = client.registered
      }
      const state = randomBytes(32).toString('base64url')
      const scope = config.oauth.scopes.length > 0 ? config.oauth.scopes.join(' ') : undefined
      const { authorizationUrl, codeVerifier } = await startAuthorization(as, {
        metadata,
        clientInformation,
        redirectUrl: redirectUri,
        state,
        resource: new URL(config.url),
        ...(scope === undefined ? {} : { scope }),
      })
      for (const [name, value] of Object.entries(OAUTH_PRESETS[named?.preset ?? ''] ?? {})) authorizationUrl.searchParams.set(name, value)
      this.sweep()
      this.signIns.set(state, { projectId: link.projectId, server: link.server, url: config.url, as, metadata, client, clientInformation, codeVerifier, redirectUri, expires: this.now() + PENDING_MS })
      return { ok: true, url: authorizationUrl.toString(), projectId: link.projectId, server: link.server }
    } catch (error) {
      return { ok: false, message: `Could not start the sign-in: ${messageOf(error)}` }
    }
  }

  /**
   * The web's `/oauth/callback`: exchange the code, keep the grant.
   *
   * @param params the callback's query: `state`, then `code` (and `iss`) or `error`.
   * @returns what to tell the admin.
   */
  async finish(params: URLSearchParams): Promise<{ ok: boolean; message: string }> {
    const state = params.get('state') ?? ''
    const pending = this.signIns.get(state)
    this.signIns.delete(state)
    if (pending === undefined || pending.expires < this.now()) return { ok: false, message: 'This sign-in is not known, or it took more than ten minutes. Send /mcp connect again.' }
    const where = `${pending.projectId}: ${pending.server}`
    const refused = params.get('error')
    if (refused !== null) return { ok: false, message: `${where} was not connected: the provider said ${refused}${params.get('error_description') === null ? '' : ` (${params.get('error_description')})`}.` }
    const code = params.get('code')
    if (code === null) return { ok: false, message: `${where} was not connected: the provider sent no code.` }
    // A different issuer than the one asked is a mix-up (RFC 9207): refused.
    const iss = params.get('iss')
    if (iss !== null && pending.metadata.issuer !== undefined && iss !== pending.metadata.issuer) return { ok: false, message: `${where} was not connected: the answer came from ${iss}, not ${pending.metadata.issuer}.` }
    try {
      const tokens = await exchangeAuthorization(pending.as, {
        metadata: pending.metadata,
        clientInformation: pending.clientInformation,
        authorizationCode: code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        resource: new URL(pending.url),
        ...this.fetchOption(),
      })
      const grant: Grant = { v: 1, url: pending.url, as: pending.as, metadata: pending.metadata, client: pending.client, tokens: this.tokensOf(tokens), connectedAt: this.now() }
      await this.save(pending.projectId, pending.server, grant)
      this.deps.audit('mcp.oauth.connect', pending.projectId, { server: pending.server, issuer: pending.metadata.issuer ?? pending.as, scope: tokens.scope ?? null, refresh: tokens.refresh_token !== undefined })
      this.deps.changed(pending.projectId, pending.server, 'connected')
      const lasting = tokens.refresh_token === undefined ? ' The provider gave no refresh token: when this access expires, connect again.' : ''
      return { ok: true, message: `${where} is connected. The project's next message has its tools.${lasting}` }
    } catch (error) {
      return { ok: false, message: `${where} was not connected: ${messageOf(error)}` }
    }
  }

  /**
   * Whether a project's server is connected.
   *
   * @returns `connected`, `not connected`, or why the provider refused the grant.
   */
  async status(projectId: string, server: string): Promise<{ state: 'connected' | 'not connected' | 'failed'; reason?: string }> {
    const grant = await this.load(projectId, server)
    const config = this.deps.serverOf(projectId, server)
    if (grant === null || (config?.url !== undefined && config.url !== null && grant.url !== config.url)) return { state: 'not connected' }
    return grant.failed === undefined ? { state: 'connected' } : { state: 'failed', reason: grant.failed }
  }

  /**
   * A fresh access token for a project's server, refreshed when it is about to expire.
   *
   * @throws {NotConnectedError} when there is no grant, or the provider refused it.
   */
  async accessToken(projectId: string, server: string, force = false): Promise<string> {
    const grant = await this.load(projectId, server)
    if (grant === null) throw new NotConnectedError(`${server} is not connected`)
    if (grant.failed !== undefined) throw new NotConnectedError(`${server}'s grant was refused: ${grant.failed}`)
    const expiry = grant.tokens.expires_at
    if (!force && (expiry === undefined || this.now() < expiry - EARLY_REFRESH_MS)) return grant.tokens.access_token
    const key = oauthSecretName(projectId, server)
    // One refresh at a time per grant: a provider that rotates refresh tokens would
    // refuse the second of two concurrent ones, and the grant with it.
    let flight = this.refreshing.get(key)
    if (flight === undefined) {
      flight = this.refresh(projectId, server, grant).finally(() => this.refreshing.delete(key))
      this.refreshing.set(key, flight)
    }
    return (await flight).tokens.access_token
  }

  /**
   * Forget a project's grant, revoking it at the provider when it says how.
   *
   * @returns whether there was one.
   */
  async disconnect(projectId: string, server: string): Promise<boolean> {
    const grant = await this.load(projectId, server)
    if (grant === null) return false
    const endpoint = (grant.metadata as { revocation_endpoint?: string }).revocation_endpoint
    if (endpoint !== undefined) {
      try {
        const client = await this.clientOf(grant.client)
        const body = new URLSearchParams({ token: grant.tokens.refresh_token ?? grant.tokens.access_token, token_type_hint: grant.tokens.refresh_token === undefined ? 'access_token' : 'refresh_token', client_id: client.client_id })
        if ('client_secret' in client && typeof client.client_secret === 'string') body.set('client_secret', client.client_secret)
        await (this.deps.fetch ?? fetch)(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) })
      } catch {
        // Revocation is a courtesy: the grant is forgotten here either way.
      }
    }
    await this.deps.secrets()?.unset(this.deps.ref(oauthSecretName(projectId, server)))
    this.cache.set(oauthSecretName(projectId, server), null)
    this.deps.audit('mcp.oauth.disconnect', projectId, { server, revoked: endpoint !== undefined })
    this.deps.changed(projectId, server, 'disconnected')
    return true
  }

  private async refresh(projectId: string, server: string, grant: Grant): Promise<Grant> {
    if (grant.tokens.refresh_token === undefined) return this.fail(projectId, server, grant, 'it expired, and the provider gave no refresh token')
    let tokens: OAuthTokens
    try {
      tokens = await refreshAuthorization(grant.as, {
        metadata: grant.metadata,
        clientInformation: await this.clientOf(grant.client),
        refreshToken: grant.tokens.refresh_token,
        resource: new URL(grant.url),
        ...this.fetchOption(),
      })
    } catch (error) {
      // A refused grant needs the admin; anything else (the network) is tried again next call.
      if (error instanceof OAuthError && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)) return this.fail(projectId, server, grant, error.code)
      throw error
    }
    const next: Grant = { ...grant, tokens: { ...this.tokensOf(tokens), refresh_token: tokens.refresh_token ?? grant.tokens.refresh_token } }
    await this.save(projectId, server, next)
    return next
  }

  private async fail(projectId: string, server: string, grant: Grant, reason: string): Promise<never> {
    await this.save(projectId, server, { ...grant, failed: reason })
    this.deps.audit('mcp.oauth.refresh-failed', projectId, { server, reason })
    this.deps.changed(projectId, server, 'failed', reason)
    throw new NotConnectedError(`${server}'s grant was refused: ${reason}`)
  }

  /** The provider's endpoints: the admin's, or discovered from the server (RFC 9728, 8414). */
  private async discover(url: string, named: OAuthClientSettings | undefined): Promise<{ as: string; metadata: AuthorizationServerMetadata }> {
    if (named?.authorization_url !== undefined && named.token_url !== undefined) {
      const issuer = new URL(named.authorization_url).origin
      return {
        as: issuer,
        metadata: {
          issuer,
          authorization_endpoint: named.authorization_url,
          token_endpoint: named.token_url,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          ...(named.revocation_url === undefined ? {} : { revocation_endpoint: named.revocation_url }),
        } as AuthorizationServerMetadata,
      }
    }
    const info = await discoverOAuthServerInfo(url, this.fetchOption())
    if (info.authorizationServerMetadata === undefined) throw new Error(`${new URL(url).host} publishes no OAuth metadata: give the client's authorization_url and token_url in ops.yaml`)
    const metadata = named?.revocation_url === undefined ? info.authorizationServerMetadata : { ...info.authorizationServerMetadata, revocation_endpoint: named.revocation_url }
    return { as: info.authorizationServerUrl, metadata }
  }

  /** The client's id and secret, the secret filled in from the credentials store. */
  private async clientOf(client: Grant['client']): Promise<{ client_id: string; client_secret?: string }> {
    if ('registered' in client) return client.registered
    const named = this.deps.clients()[client.name]
    if (named === undefined) throw new NotConnectedError(`the OAuth client ${client.name} is no longer in ops.yaml`)
    return named.client_secret === undefined ? { client_id: named.client_id } : { client_id: named.client_id, client_secret: await this.deps.expand(named.client_secret) }
  }

  private tokensOf(tokens: OAuthTokens): Grant['tokens'] {
    return {
      access_token: tokens.access_token,
      ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
      ...(tokens.expires_in === undefined ? {} : { expires_at: this.now() + tokens.expires_in * 1000 }),
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    }
  }

  private async load(projectId: string, server: string): Promise<Grant | null> {
    const key = oauthSecretName(projectId, server)
    if (this.cache.has(key)) return this.cache.get(key) ?? null
    const found = await this.deps.secrets()?.resolve(this.deps.ref(key))
    let grant: Grant | null = null
    if (found !== undefined) {
      try {
        const parsed = JSON.parse(found.value) as Grant
        if (parsed.v === 1) grant = parsed
      } catch {
        // An unreadable grant is no grant: connect again.
      }
    }
    this.cache.set(key, grant)
    return grant
  }

  private async save(projectId: string, server: string, grant: Grant): Promise<void> {
    const secrets = this.deps.secrets()
    if (secrets === undefined) throw new Error('the credentials store is not available')
    const key = oauthSecretName(projectId, server)
    await secrets.set(this.deps.ref(key), JSON.stringify(grant))
    this.cache.set(key, grant)
  }

  private fetchOption(): { fetchFn?: typeof fetch } {
    return this.deps.fetch === undefined ? {} : { fetchFn: this.deps.fetch }
  }

  /** Drop what expired, so an abandoned sign-in does not linger. */
  private sweep(): void {
    const now = this.now()
    for (const [key, link] of this.links) if (link.expires < now) this.links.delete(key)
    for (const [key, pending] of this.signIns) if (pending.expires < now) this.signIns.delete(key)
  }
}

/** The headers passed through the proxy, both ways; nothing else, so no token comes in. */
const REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version']

/** One server served through the proxy. */
interface ProxyRoute {
  readonly url: string
  readonly token: (force: boolean) => Promise<string>
}

/**
 * A loopback HTTP proxy in front of remote MCP servers that sign in with OAuth.
 *
 * dsh's MCP client takes fixed headers, set when the server is mounted; a token lasts an
 * hour and a run may last longer. So dsh is given `http://127.0.0.1:<port>/<route>`, a
 * random route per mounted server, and the proxy adds a fresh token to every request.
 */
export class OAuthProxy {
  private server: Server | undefined
  private starting: Promise<number> | undefined
  private readonly routes = new Map<string, ProxyRoute>()

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /**
   * Serve one server.
   *
   * @param url the server's real URL.
   * @param token a fresh access token; `force` after the server refused the last one.
   * @returns the URL dsh connects to, and the undo.
   */
  async add(url: string, token: (force: boolean) => Promise<string>): Promise<{ url: string; remove: () => void }> {
    const port = await this.listen()
    const route = randomBytes(32).toString('base64url')
    this.routes.set(route, { url, token })
    return { url: `http://127.0.0.1:${port}/${route}`, remove: () => void this.routes.delete(route) }
  }

  /** Stop listening. */
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.starting = undefined
    this.routes.clear()
    if (server !== undefined) await new Promise<void>((done) => server.close(() => done()))
  }

  private listen(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request).then(
          async (answer) => {
            response.writeHead(answer.status, answer.headers)
            if (answer.body !== undefined) for await (const chunk of answer.body) response.write(chunk)
            response.end()
          },
          () => {
            if (!response.headersSent) response.writeHead(502)
            response.end()
          },
        )
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        resolve((server.address() as { port: number }).port)
      })
    })
    return this.starting
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; headers: Record<string, string>; body?: AsyncIterable<Uint8Array> }> {
    const route = this.routes.get((request.url ?? '').slice(1))
    if (route === undefined) return { status: 404, headers: {} }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = ['GET', 'HEAD', 'DELETE'].includes(request.method ?? 'GET') ? undefined : Buffer.concat(chunks)
    const headers: Record<string, string> = {}
    for (const name of REQUEST_HEADERS) {
      const value = request.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const send = async (force: boolean): Promise<Response | undefined> => {
      let token: string
      try {
        token = await route.token(force)
      } catch (error) {
        if (error instanceof NotConnectedError) return undefined
        throw error
      }
      return this.fetchFn(route.url, { method: request.method ?? 'GET', headers: { ...headers, authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body }) })
    }
    let upstream = await send(false)
    // A token the server refused before its expiry (revoked, rotated): one refresh, one retry.
    if (upstream?.status === 401) upstream = await send(true)
    if (upstream === undefined || upstream.status === 401) {
      const message = 'This MCP server is not connected, or its sign-in was refused: ask the admin to run /mcp connect for this project and server. Do not retry.'
      return { status: 401, headers: { 'content-type': 'application/json' }, body: [Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }))] as unknown as AsyncIterable<Uint8Array> }
    }
    const out: Record<string, string> = {}
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) out[name] = value
    }
    return { status: upstream.status, headers: out, ...(upstream.body === null ? {} : { body: upstream.body as unknown as AsyncIterable<Uint8Array> }) }
  }
}

/** An error's message, without a token: the SDK's messages hold none, but a provider's might. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/(access_token|refresh_token|client_secret|code)=([^&\s"]+)/gi, '$1=…').slice(0, 300)
}
