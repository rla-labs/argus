// == ARGUS AGENT PROJECT ==
/**
 * The egress proxy: a forward proxy on loopback that reaches the public internet only.
 *
 * A browser an agent drives would otherwise reach whatever the server can: Argus's own
 * ports, the private network, the cloud's metadata service. Chromium is started with
 * `--proxy-server` pointing here (`${ARGUS_EGRESS_PROXY}` in an MCP server's `env`), and
 * every request, loopback included, goes through it. Like `web_fetch`, it resolves the
 * name, refuses the whole answer if any address is not public, and connects to the address
 * it checked, so a name that changes its answer in between (DNS rebinding) cannot slip
 * through. A redirect is a new request, checked again.
 *
 * Not a boundary against the agent's own shell, which has the network: that is the
 * `shell` approval's job.
 *
 * It also serves **routes** (`/r/<random>/v1/…`): an agent an extension runs (Claude Code)
 * talks to its model provider through one, and the route adds the credential, so the key
 * or the subscription's token is never in that agent's environment, where its own shell
 * could read it. A route is a capability: it works while its server runs, for the paths
 * under `/v1/` only, and whoever holds it can use the credential, never read it.
 *
 * @module @argus-agent/projects/egress
 */
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, connect, isIP, isIPv6 } from 'node:net'

/** The ranges no browser of a project may reach: everything that is not public unicast. */
const BLOCKED = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(address, prefix, 'ipv6')

/**
 * Whether an address is public unicast. An IPv4-mapped IPv6 address is judged by its IPv4.
 *
 * @param address an IP address.
 * @returns true only for an address on the public internet.
 */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped !== undefined) return !BLOCKED.check(mapped, 'ipv4')
  if (isIP(address) === 0) return false
  return !BLOCKED.check(address, isIPv6(address) ? 'ipv6' : 'ipv4')
}

/** How the proxy resolves a name; a test gives its own. */
export type Resolve = (host: string) => Promise<readonly string[]>

const systemResolve: Resolve = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address)

/**
 * The credential a route adds: Anthropic's API key (`x-api-key`), a Claude subscription's
 * OAuth token (`Authorization`, with its beta), or a bearer key (OpenAI).
 */
export type RouteCredential = { readonly kind: 'api-key' | 'oauth' | 'bearer'; readonly value: string }

/** What one request through a route used, read from the provider's answer. */
export interface RouteUsage {
  readonly model: string
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
}

/** What a route may do besides adding the credential: refuse a request, and count what it used. */
export interface RouteWatch {
  /** Before a request goes: why it must not (a budget, a limit), or undefined. */
  readonly admit?: (model: string | undefined) => string | undefined
  /** After its answer: the model and the tokens the provider says it used. */
  readonly usage?: (usage: RouteUsage) => void
}

/** A route to a model provider, with the credential it adds. */
interface Route {
  readonly upstream: URL
  /** The credential now, or why there is none (said to the agent). */
  readonly credential: () => Promise<RouteCredential | string>
  readonly watch: RouteWatch
}

/** The largest request a route reads before forwarding it (a model request with its context). */
const ROUTE_BODY_MAX = 32 * 1024 * 1024

/** The beta Anthropic requires for a subscription's OAuth token. */
const OAUTH_BETA = 'oauth-2025-04-20'

/** The forward proxy. */
export class EgressProxy {
  private server: Server | undefined
  private starting: Promise<string> | undefined
  private readonly routes = new Map<string, Route>()

  /**
   * Add a route to a model provider (`https://api.anthropic.com`), adding the credential.
   *
   * @param upstream the provider's base URL.
   * @param credential the credential when a request comes, or why there is none.
   * @returns its path on the proxy (`/r/<random>`), and what removes it.
   */
  addRoute(upstream: string, credential: Route['credential'], watch: RouteWatch = {}): { readonly path: string; readonly remove: () => void } {
    const id = randomBytes(18).toString('hex')
    this.routes.set(id, { upstream: new URL(upstream), credential, watch })
    return { path: `/r/${id}`, remove: () => void this.routes.delete(id) }
  }

  /**
   * @param resolve how names are resolved.
   * @param allowed which resolved address may be reached: public ones, unless a test says otherwise.
   */
  constructor(
    private readonly resolve: Resolve = systemResolve,
    private readonly allowed: (address: string) => boolean = isPublicAddress,
  ) {}

  /**
   * The proxy's URL, starting it on first use.
   *
   * @returns `http://127.0.0.1:<port>`.
   */
  url(): Promise<string> {
    this.starting ??= new Promise<string>((done, fail) => {
      const server = createServer((request, response) => {
        // A route, asked of the proxy directly or through it (an absolute URL to itself).
        const target = request.url ?? ''
        const local = target.startsWith('/r/') ? target : this.ownPath(target)
        if (local !== undefined) {
          void this.route(local, request, response)
          return
        }
        void this.forward(target, request.method ?? 'GET', request.headers, request, response)
      })
      server.on('connect', (request, socket, head) => {
        const target = request.url ?? ''
        const colon = target.lastIndexOf(':')
        const host = target.slice(0, colon).replace(/^\[|\]$/g, '')
        const port = Number(target.slice(colon + 1))
        void this.address(host).then(
          (address) => {
            if (address === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
              socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nArgus: this address is not on the public internet.\n')
              return
            }
            const upstream = connect(port, address, () => {
              socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
              upstream.write(head)
              upstream.pipe(socket)
              socket.pipe(upstream)
            })
            upstream.on('error', () => socket.destroy())
            socket.on('error', () => upstream.destroy())
          },
          () => socket.destroy(),
        )
      })
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        done(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
      })
    })
    return this.starting
  }

  /** Stop listening. */
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.starting = undefined
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }

  /** The path of an absolute URL to this proxy itself, or undefined. */
  private ownPath(target: string): string | undefined {
    const port = (this.server?.address() as { port: number } | null | undefined)?.port
    try {
      const url = new URL(target)
      return port !== undefined && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && Number(url.port) === port && url.pathname.startsWith('/r/') ? `${url.pathname}${url.search}` : undefined
    } catch {
      return undefined
    }
  }

  /** A request on a route: to the provider, with the credential put in. */
  private async route(target: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refuse = (status: number, message: string): void => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'not_found_error', message } }))
    }
    const match = /^\/r\/([0-9a-f]+)(\/v1\/[^?#]*(?:\?[^#]*)?)$/.exec(target)
    const route = match === null ? undefined : this.routes.get(match[1] as string)
    if (match === null || route === undefined) return refuse(404, 'Argus: no such route (it ends with the server that had it), or a path outside /v1/.')
    let credential: RouteCredential | string
    try {
      credential = await route.credential()
    } catch (error) {
      credential = (error as Error).message
    }
    if (typeof credential === 'string') return refuse(401, `Argus: ${credential}`)
    // The request is read whole: its model decides whether it may go (a price, a budget).
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > ROUTE_BODY_MAX) return refuse(413, 'Argus: the request is too large.')
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks)
    const model = modelOf(body)
    const refusal = route.watch.admit?.(model)
    if (refusal !== undefined) {
      // 403, not 429: an agent retries a 429 and loses the reason; this one is final.
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'permission_error', code: 'argus_refused', message: `Argus: ${refusal}` } }))
      return
    }
    // Under the upstream's own path (OpenRouter's is /api).
    const url = new URL(`${route.upstream.pathname.replace(/\/$/, '')}${match[2] as string}`, route.upstream)
    const { host: _host, authorization: _authorization, 'x-api-key': _key, 'proxy-connection': _proxy, connection: _connection, 'content-length': _length, ...rest } = request.headers
    const headers: IncomingHttpHeaders = { ...rest, host: url.host, 'content-length': String(body.length) }
    if (credential.kind === 'api-key') {
      headers['x-api-key'] = credential.value
    } else if (credential.kind === 'bearer') {
      headers['authorization'] = `Bearer ${credential.value}`
    } else {
      headers['authorization'] = `Bearer ${credential.value}`
      const betas = String(headers['anthropic-beta'] ?? '').split(',').map((beta) => beta.trim()).filter((beta) => beta.length > 0)
      headers['anthropic-beta'] = [...new Set([...betas, OAUTH_BETA])].join(',')
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = send(url, { method: request.method ?? 'POST', headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      const counted = route.watch.usage
      if (counted !== undefined && (answer.statusCode ?? 0) < 300) {
        // Read as it passes: the answer goes on to the agent unchanged and unbuffered.
        const reader = usageReader(String(answer.headers['content-type'] ?? ''), model)
        answer.on('data', (chunk: Buffer) => reader.push(chunk))
        answer.on('end', () => {
          const usage = reader.done()
          if (usage !== undefined) counted(usage)
        })
      }
      answer.pipe(response)
    })
    upstream.on('error', () => (response.headersSent ? response.destroy() : refuse(502, 'Argus: the provider could not be reached.')))
    upstream.end(body)
  }

  /** The address to connect to, or `undefined` when any answer is not allowed. */
  private async address(host: string): Promise<string | undefined> {
    try {
      const addresses = isIP(host) === 0 ? await this.resolve(host) : [host]
      return addresses.length > 0 && addresses.every((address) => this.allowed(address)) ? addresses[0] : undefined
    } catch {
      return undefined
    }
  }

  /** A plain-HTTP request, forwarded to the checked address. */
  private async forward(target: string, method: string, headers: IncomingHttpHeaders, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(target)
    } catch {
      response.writeHead(400).end()
      return
    }
    const address = url.protocol === 'http:' ? await this.address(url.hostname.replace(/^\[|\]$/g, '')) : undefined
    if (address === undefined) {
      response.writeHead(403, { 'content-type': 'text/plain' }).end('Argus: this address is not on the public internet.\n')
      return
    }
    const { 'proxy-connection': _drop, ...rest } = headers
    const upstream = httpRequest({ host: address, port: url.port === '' ? 80 : Number(url.port), path: `${url.pathname}${url.search}`, method, headers: { ...rest, host: url.host } }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
    })
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
  }
}

/** The model a request asks for, from its JSON body. */
function modelOf(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads the usage from a provider's answer as it passes: OpenAI's Responses stream
 * (`response.completed`, its `response.usage` and `model`) or a JSON answer (`usage`).
 * Only what usage needs is kept: the last complete event of a stream, or a bounded body.
 *
 * @param contentType the answer's content type.
 * @param asked the model the request asked for, when the answer does not say.
 * @returns what to feed the chunks to, and what reads the usage at the end.
 */
export function usageReader(contentType: string, asked: string | undefined): { push(chunk: Buffer): void; done(): RouteUsage | undefined } {
  const toUsage = (value: unknown): RouteUsage | undefined => {
    const holder = value as { model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } } } | undefined
    const usage = holder?.usage
    if (usage === undefined || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined
    const cached = typeof usage.input_tokens_details?.cached_tokens === 'number' ? usage.input_tokens_details.cached_tokens : 0
    // OpenAI counts the cached tokens inside input_tokens; Argus prices them apart.
    return { model: typeof holder?.model === 'string' ? holder.model : (asked ?? 'unknown'), inputTokens: Math.max(0, usage.input_tokens - cached), cachedTokens: cached, outputTokens: usage.output_tokens }
  }
  if (contentType.includes('text/event-stream')) {
    let pending = ''
    let found: RouteUsage | undefined
    const line = (text: string): void => {
      if (!text.startsWith('data:') || !text.includes('"response.completed"')) return
      try {
        const event = JSON.parse(text.slice(5).trim()) as { type?: string; response?: unknown }
        if (event.type === 'response.completed') found = toUsage(event.response) ?? found
      } catch {
        // Not an event this reader needs.
      }
    }
    return {
      push(chunk) {
        pending += chunk.toString('utf8')
        let at = pending.indexOf('\n')
        while (at !== -1) {
          line(pending.slice(0, at))
          pending = pending.slice(at + 1)
          at = pending.indexOf('\n')
        }
      },
      done() {
        line(pending)
        return found
      },
    }
  }
  const parts: Buffer[] = []
  let size = 0
  return {
    push(chunk) {
      size += chunk.length
      if (size <= ROUTE_BODY_MAX) parts.push(chunk)
    },
    done() {
      try {
        return toUsage(JSON.parse(Buffer.concat(parts).toString('utf8')))
      } catch {
        return undefined
      }
    },
  }
}
