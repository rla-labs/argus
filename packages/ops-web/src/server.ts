// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/server` — the HTTP side of the web interface.
 *
 * `node:http`, no framework: a handful of routes, all JSON or static files. Every
 * route but the login, the page shell and its static files needs a session; every
 * POST also needs the `x-argus` header, which a cross-site form cannot send, on top
 * of the `SameSite=Strict` cookie. A change is never made here: it is a command line
 * run through `ops-commands` as the logged-in person.
 *
 * @module @argus-agent/web/server
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebAuth, Session } from './auth.js'
import type { WebChannelAdapter } from './web-channel.js'

/** The session cookie's name. */
export const COOKIE = 'argus_session'
/** The largest request body read, in bytes. */
const MAX_BODY = 64 * 1024

/** A command's outcome, as the browser gets it. */
export interface CommandOutcome {
  readonly text: string
  readonly error: boolean
  readonly buttons: ReadonlyArray<{ label: string; command: string }>
}

/** What the server needs from the rest of the plugin. */
export interface ServerDeps {
  readonly host: string
  readonly port: number
  /** Whether the browser reaches it over HTTPS, for the cookie's `Secure`. */
  readonly secure: boolean
  readonly auth: WebAuth
  readonly sessionHours: number
  readonly chat: WebChannelAdapter
  readonly overview: () => unknown
  readonly settings: () => unknown
  readonly runCommand: (line: string, session: Session) => Promise<CommandOutcome>
  readonly answerApproval: (approvalId: string, value: string, session: Session) => boolean
  /** Subscribe to "something changed"; returns the unsubscribe. */
  readonly onChange: (listener: (topic: string) => void) => () => void
  readonly log: (message: string) => void
}

/** A running server. */
export interface WebServer {
  readonly port: number
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** The bare module names the import map resolves, and where each one's file is. */
const VENDOR: Record<string, string> = {
  'preact.mjs': 'preact',
  'hooks.mjs': 'preact/hooks',
  'htm.mjs': 'htm',
  'htm-preact.mjs': 'htm/preact',
}

/**
 * Start the server.
 *
 * @param deps what it serves.
 * @returns the running server.
 */
export async function startWebServer(deps: ServerDeps): Promise<WebServer> {
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
  const clientDir = fileURLToPath(new URL('./client/', import.meta.url))
  const shell = readFileSync(join(publicDir, 'index.html'), 'utf8')
  // The import map is the page's one inline script; its hash is what the CSP allows.
  const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(shell)?.[1] ?? ''
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${createHash('sha256').update(importMap).digest('base64')}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')

  const server: Server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      deps.log(`web: ${request.method} ${pathOf(request)} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) send(response, 500, { error: 'internal error' })
      else response.end()
    })
  })

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = pathOf(request)
    const method = request.method ?? 'GET'
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', csp)

    // ── no session needed ────────────────────────────────────────────────
    if (method === 'GET' && path === '/login') {
      const token = new URL(request.url ?? '/', 'http://x').searchParams.get('token') ?? ''
      const outcome = deps.auth.login(token, request.socket.remoteAddress ?? '?')
      if (!outcome.ok) {
        response.writeHead(outcome.reason === 'limited' ? 429 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(loginPage(outcome.reason))
        return
      }
      const cookie = [
        `${COOKIE}=${outcome.sessionId}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${deps.sessionHours * 3600}`,
        ...(deps.secure ? ['Secure'] : []),
      ].join('; ')
      response.writeHead(303, { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      response.writeHead(200, { 'content-type': TYPES['.html'] as string, 'cache-control': 'no-store' })
      response.end(shell)
      return
    }
    if (method === 'GET' && path.startsWith('/static/')) return serveFile(response, publicDir, path.slice('/static/'.length))
    if (method === 'GET' && path.startsWith('/client/')) return serveFile(response, clientDir, path.slice('/client/'.length))
    if (method === 'GET' && path.startsWith('/vendor/')) {
      const specifier = VENDOR[path.slice('/vendor/'.length)]
      if (specifier === undefined) return send(response, 404, { error: 'not found' })
      const file = fileURLToPath(import.meta.resolve(specifier))
      response.writeHead(200, { 'content-type': TYPES['.mjs'] as string, 'cache-control': 'max-age=3600' })
      response.end(readFileSync(file))
      return
    }

    // ── a session from here on ───────────────────────────────────────────
    const sessionId = cookieOf(request)
    const session = deps.auth.session(sessionId)
    if (session === undefined) return send(response, 401, { error: 'not signed in' })
    if (method === 'POST' && request.headers['x-argus'] !== '1') return send(response, 403, { error: 'missing x-argus header' })

    if (method === 'GET' && path === '/api/me') return send(response, 200, { userId: session.userId, expiresAt: session.expiresAt })
    if (method === 'POST' && path === '/api/logout') {
      deps.auth.logout(sessionId)
      response.writeHead(204, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
      response.end()
      return
    }
    if (method === 'GET' && path === '/api/overview') return send(response, 200, deps.overview())
    if (method === 'GET' && path === '/api/settings') return send(response, 200, deps.settings())
    if (method === 'GET' && path === '/api/events') return events(request, response, session)
    if (method === 'POST' && path === '/api/command') {
      const body = await readJson(request)
      const line = typeof body['line'] === 'string' ? body['line'].trim() : ''
      if (!line.startsWith('/')) return send(response, 400, { error: 'line must be a command' })
      return send(response, 200, await deps.runCommand(line, session))
    }
    const approval = /^\/api\/approvals\/([^/]+)$/.exec(path)
    if (method === 'POST' && approval !== null) {
      const body = await readJson(request)
      const value = typeof body['value'] === 'string' ? body['value'] : ''
      const ok = deps.answerApproval(decodeURIComponent(approval[1] as string), value, session)
      return send(response, ok ? 200 : 409, ok ? { ok } : { error: 'that question is no longer waiting' })
    }
    if (method === 'GET' && path === '/api/chat') return send(response, 200, { entries: deps.chat.history(session.userId) })
    if (method === 'POST' && path === '/api/chat') {
      const body = await readJson(request)
      const text = typeof body['text'] === 'string' ? body['text'] : ''
      if (text.trim().length === 0) return send(response, 400, { error: 'empty message' })
      deps.chat.receive(session.userId, text)
      return send(response, 202, { ok: true })
    }
    if (method === 'POST' && path === '/api/chat/press') {
      const body = await readJson(request)
      const ok = deps.chat.press(session.userId, String(body['entryId'] ?? ''), String(body['value'] ?? ''))
      return send(response, ok ? 200 : 409, { ok })
    }
    const download = /^\/api\/files\/([^/]+)$/.exec(path)
    if (method === 'GET' && download !== null) {
      const file = deps.chat.file(session.userId, decodeURIComponent(download[1] as string))
      if (file === undefined) return send(response, 404, { error: 'not found' })
      const bytes = file.bytes ?? (file.path === undefined ? undefined : readFileSync(file.path))
      if (bytes === undefined) return send(response, 404, { error: 'not found' })
      response.writeHead(200, {
        'content-type': file.mimeType ?? 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'cache-control': 'no-store',
      })
      response.end(bytes)
      return
    }
    send(response, 404, { error: 'not found' })
  }

  /** Server-sent events: a `changed` line per topic, and the person's chat. */
  function events(request: IncomingMessage, response: ServerResponse, session: Session): void {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    response.write('retry: 3000\n\n')
    const unsubscribe = deps.onChange((topic) => {
      // A chat change is only for the person whose chat it is.
      if (topic.startsWith('chat:') && topic !== `chat:${session.userId}`) return
      response.write(`event: changed\ndata: ${topic.startsWith('chat:') ? 'chat' : topic}\n\n`)
    })
    const ping = setInterval(() => response.write(': ping\n\n'), 25_000)
    request.on('close', () => {
      clearInterval(ping)
      unsubscribe()
    })
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(deps.port, deps.host, () => resolveListen())
  })
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : deps.port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections()
        server.close(() => resolveClose())
      }),
  }
}

/** The request's path, without the query. */
function pathOf(request: IncomingMessage): string {
  return (request.url ?? '/').split('?')[0] ?? '/'
}

/** The session cookie, when the request carries one. */
function cookieOf(request: IncomingMessage): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === COOKIE) return value.join('=')
  }
  return undefined
}

/** A JSON answer. */
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': TYPES['.json'] as string, 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** A static file from under `root`, never outside it. */
function serveFile(response: ServerResponse, root: string, relative: string): void {
  const full = resolve(root, normalize(decodeURIComponent(relative)))
  if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) return send(response, 404, { error: 'not found' })
  try {
    if (!statSync(full).isFile()) return send(response, 404, { error: 'not found' })
  } catch {
    return send(response, 404, { error: 'not found' })
  }
  response.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  response.end(readFileSync(full))
}

/** A JSON request body, at most {@link MAX_BODY} bytes. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The page a failed login shows. */
function loginPage(reason: 'limited' | 'invalid'): string {
  const text =
    reason === 'limited'
      ? 'Too many failed attempts from this address. Wait a quarter of an hour.'
      : 'This link is not valid: it was used already, or it is older than 10 minutes. Send /web to the bot for a new one.'
  return `<!doctype html><meta charset="utf-8"><title>Argus</title><body style="font:16px system-ui;background:#04070d;color:#dcebfa;padding:40px"><p>${text}</p></body>`
}
