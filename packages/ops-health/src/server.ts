// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/health/server` — the loopback HTTP endpoint.
 *
 * Bound to **127.0.0.1 only**. It has no authentication, and it reports the shape of
 * the system — plugin names, queue depths, budget states — which is reconnaissance an
 * attacker should not get for free. A container healthcheck runs inside the
 * container, and an operator reaches it through an SSH tunnel; neither needs a
 * public bind, and `docs/user/security.md` says so.
 *
 * @module @argus-agent/health/server
 */
import { createServer, type Server } from 'node:http'
import { httpStatusFor, type HealthReport } from './model.js'

/** A running endpoint. */
export interface HealthServer {
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

/** What the endpoint needs. */
export interface ServerOptions {
  readonly port: number
  /** Builds the current report. */
  readonly report: () => HealthReport
  /** Called on a request, for a log. */
  readonly onRequest?: (info: { readonly path: string; readonly status: number }) => void
}

/**
 * Start the endpoint.
 *
 * @param options the port and the report source.
 * @returns the running server.
 * @throws when the port is taken, so a deployment learns at boot rather than
 *   discovering that its healthcheck has been reporting a stale process.
 */
export async function startHealthServer(options: ServerOptions): Promise<HealthServer> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'

    if (request.method !== 'GET') {
      options.onRequest?.({ path, status: 405 })
      response.writeHead(405, { 'content-type': 'application/json', allow: 'GET' })
      response.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }

    if (path === '/health' || path === '/healthz' || path === '/') {
      const report = options.report()
      const status = httpStatusFor(report.status)
      options.onRequest?.({ path, status })
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(report, null, 2))
      return
    }

    options.onRequest?.({ path, status: 404 })
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found', paths: ['/health'] }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1, never 0.0.0.0.
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    port: options.port,
    url: `http://127.0.0.1:${options.port}/health`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)))
      })
    },
  }
}
