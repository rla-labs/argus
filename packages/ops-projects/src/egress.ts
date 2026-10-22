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
 * @module @argus-agent/projects/egress
 */
import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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

/** The forward proxy. */
export class EgressProxy {
  private server: Server | undefined
  private starting: Promise<string> | undefined

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
        void this.forward(request.url ?? '', request.method ?? 'GET', request.headers, request, response)
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
