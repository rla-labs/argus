// == ARGUS AGENT PROJECT ==
/**
 * The egress proxy: a browser's way out reaches the public internet only. A loopback, a
 * private, a link-local or a metadata address is refused, by IP or by a name that resolves
 * to one, over plain HTTP and through CONNECT; an allowed one is reached.
 */
import { createServer, request, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EgressProxy, isPublicAddress } from '../../src/egress.js'

let site: Server
let sitePort = 0
const proxies: EgressProxy[] = []

beforeAll(async () => {
  site = createServer((_req, res) => res.end('the site'))
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', () => done()))
  sitePort = (site.address() as { port: number }).port
})
afterAll(async () => {
  site.close()
  await Promise.all(proxies.map((proxy) => proxy.close()))
})

/** A GET through the proxy, plain HTTP. */
function viaProxy(proxyUrl: string, target: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl)
  return new Promise((done, fail) => {
    const req = request({ host: proxy.hostname, port: proxy.port, path: target, headers: { host: new URL(target).host } }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => done({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', fail)
    req.end()
  })
}

/** A CONNECT through the proxy: its status line. */
function tunnel(proxyUrl: string, target: string): Promise<string> {
  const proxy = new URL(proxyUrl)
  return new Promise((done, fail) => {
    const socket = connect(Number(proxy.port), proxy.hostname, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`))
    socket.once('data', (chunk) => {
      done(String(chunk).split('\r\n')[0] ?? '')
      socket.destroy()
    })
    socket.on('error', fail)
  })
}

describe('the egress proxy', () => {
  it('knows a public address from the others', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    for (const address of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:1.1.1.1']) expect(isPublicAddress(address), address).toBe(true)
  })

  it('refuses what is not public, by address or by a name that resolves to one, both ways', async () => {
    const names: Record<string, string[]> = { 'rebind.example': ['127.0.0.1'], 'mixed.example': ['1.1.1.1', '10.0.0.1'] }
    const proxy = new EgressProxy(async (host) => names[host] ?? [])
    proxies.push(proxy)
    const url = await proxy.url()
    for (const target of [`http://127.0.0.1:${sitePort}/`, `http://localhost:${sitePort}/`, 'http://169.254.169.254/latest/meta-data/', `http://rebind.example:${sitePort}/`, 'http://mixed.example/', 'http://[::1]:3090/']) {
      const answer = await viaProxy(url, target)
      expect(answer.status, target).toBe(403)
      expect(answer.body).not.toContain('the site')
    }
    for (const target of [`127.0.0.1:${sitePort}`, 'rebind.example:443', '[::1]:443', '10.0.0.1:443']) {
      expect(await tunnel(url, target), target).toContain('403')
    }
  })

  it('reaches what is allowed, over HTTP and through CONNECT', async () => {
    // In a test the site is on loopback: this proxy allows it, by name.
    const proxy = new EgressProxy(async (host) => (host === 'site.example' ? ['127.0.0.1'] : []), (address) => address === '127.0.0.1')
    proxies.push(proxy)
    const url = await proxy.url()
    expect(await viaProxy(url, `http://site.example:${sitePort}/`)).toEqual({ status: 200, body: 'the site' })
    expect(await tunnel(url, `site.example:${sitePort}`)).toBe('HTTP/1.1 200 Connection Established')
  })
})
