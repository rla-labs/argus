// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/server` — the HTTP side of the web interface.
 *
 * `node:http`, no framework: a handful of routes, all JSON or static files. Every
 * route but the sign-in, the page shell and its static files needs a session; every
 * POST also needs the `x-argus` header, which a cross-site form cannot send, on top
 * of the `SameSite=Strict` cookie. A change is never made here: it is a command line
 * run through `ops-commands` as the logged-in person.
 *
 * In public mode (`web.public`, behind a reverse proxy with HTTPS) the cookie is
 * always `Secure`, HSTS is sent, the client's address is the proxy's
 * `X-Forwarded-For`, and a session whose user has no second factor may only set one.
 *
 * @module @argus-agent/web/server
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebAuth, Session } from './auth.js'
import type { SetupGate } from './setup.js'
import { ownsChat, threadChat, threadOf, type WebChannelAdapter } from './web-channel.js'
import type { Locales } from './locales.js'
import { FileRefusal, listFolder, receiveUpload, sendFile, sendZip, type DownloadLinks } from './files.js'

/** The session cookie's name. */
export const COOKIE = 'argus_session'
/** The cookie that carries a sign-in's ticket from the password (or link) to the code. */
export const TICKET_COOKIE = 'argus_ticket'
/** What a session without a second factor may do in public mode: set one up. */
const SETTING_UP = new Set(['/api/me', '/api/totp/start', '/api/totp/confirm', '/api/logout'])
/** The largest request body read, in bytes. */
const MAX_BODY = 64 * 1024

/** A command's outcome, as the browser gets it. */
export interface CommandOutcome {
  readonly text: string
  readonly error: boolean
  readonly buttons: ReadonlyArray<{ label: string; command: string }>
  /** Files the command produced (`/get`), downloadable at `/api/files/:id`. */
  readonly files?: ReadonlyArray<{ id: string; name: string }>
}

/** What the server needs from the rest of the plugin. */
export interface ServerDeps {
  readonly host: string
  readonly port: number
  /** Whether the browser reaches it over HTTPS, for the cookie's `Secure`. */
  readonly secure: boolean
  /** Public mode: HSTS, the proxy's client address, a second factor required. */
  readonly public: boolean
  readonly auth: WebAuth
  /** The first admin's setup link. */
  readonly setup: SetupGate
  readonly sessionHours: number
  readonly chat: WebChannelAdapter
  /** Point a person's project thread at its project, so what they write there goes to it. */
  readonly bindThread: (userId: string, projectId: string) => boolean
  /** The open sessions of one-off tasks, with what each was first asked. */
  readonly sessions: () => unknown
  /** Who the session's user is, for `/api/me`. */
  readonly me: (session: Session) => unknown
  /** Every user, for the admin; `undefined` for anyone else. */
  readonly users: (session: Session) => unknown
  readonly overview: () => unknown
  readonly projects: () => unknown
  /** One project, or `undefined` when there is none. */
  readonly project: (id: string) => unknown
  readonly templates: () => unknown
  readonly tasks: () => unknown
  readonly schedules: () => unknown
  readonly runs: () => unknown
  readonly settings: () => unknown
  /** Every `ops.yaml` setting, described; `undefined` when the file is not known. */
  readonly systemSettings: () => unknown
  /** The interface's languages, and the packs the admin adds. */
  readonly locales: Locales
  /** Keep the language a user reads the interface in; null follows the browser. */
  readonly setLanguage: (userId: string, code: string | null) => void
  /** The installed extensions, with what each asks and which projects use it. */
  readonly extensions: () => unknown
  /** Every secret something needs, grouped, for the admin; never a value. */
  readonly secrets: () => Promise<unknown>
  /** A project's settings, described; `undefined` when there is no such project. */
  readonly projectSettings: (id: string) => Promise<unknown>
  /** Every model a provider names, with its price and whether it can run. */
  readonly models: () => unknown
  readonly runCommand: (line: string, session: Session) => Promise<CommandOutcome>
  readonly answerApproval: (approvalId: string, value: string, session: Session) => boolean
  /** Continue or stop a run the loop checker found in a loop. */
  readonly answerCheckpoint: (runId: string, value: string, session: Session) => boolean
  /** A project's folder, or `undefined` when there is no such project. */
  readonly projectDir: (id: string) => string | undefined
  /** The largest upload, in bytes. */
  readonly maxUploadBytes: number
  /** The command sandbox, for a project's zip: `root` writable, `reads` read-only. */
  readonly confineZip: (argv: readonly string[], root: string, reads: readonly string[]) => Promise<readonly string[]>
  /** Where a zip is made before it is sent. */
  readonly zipScratch: string
  /** The one-time download links. */
  readonly links: DownloadLinks
  /** Whether a session's user is the admin. */
  readonly isAdmin: (session: Session) => boolean
  /** OAuth for MCP servers: the admin's sign-in at a provider, and its answer. */
  readonly oauth?: {
    begin(key: string, redirectUri: string): Promise<{ ok: true; url: string } | { ok: false; message: string }>
    finish(params: URLSearchParams): Promise<{ ok: boolean; message: string }>
  }
  /** The address the interface is opened at, without a trailing slash. */
  readonly publicUrl: string
  /** Record an upload. */
  readonly uploaded: (session: Session, projectId: string, path: string, bytes: number) => void
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
  '.woff2': 'font/woff2',
}

/** The fonts the page uses, from their `@fontsource` packages: a family, its script, a weight. */
const FONT = /^(space-grotesk|ibm-plex-sans|jetbrains-mono)-latin(?:-ext)?-[1-9]00-normal\.woff2$/

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
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')

  const secure = deps.secure || deps.public
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
    if (deps.public) response.setHeader('strict-transport-security', 'max-age=31536000')

    // ── no session needed ────────────────────────────────────────────────
    const cookie = (sessionId: string): string =>
      [`${COOKIE}=${sessionId}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${deps.sessionHours * 3600}`, ...(secure ? ['Secure'] : [])].join('; ')
    const ticketCookie = (ticket: string, maxAge = 300): string =>
      [`${TICKET_COOKIE}=${ticket}`, 'HttpOnly', 'SameSite=Strict', 'Path=/login', `Max-Age=${maxAge}`, ...(secure ? ['Secure'] : [])].join('; ')
    const address = clientAddress(request, deps.public)
    const userAgent = request.headers['user-agent']
    if (method === 'GET' && path === '/login') {
      const token = new URL(request.url ?? '/', 'http://x').searchParams.get('token')
      // No token: the page itself shows the sign-in form.
      if (token === null) {
        response.writeHead(303, { location: '/', 'cache-control': 'no-store' })
        response.end()
        return
      }
      const outcome = deps.auth.login(token, address, userAgent)
      if (!outcome.ok && outcome.reason === 'totp') {
        response.writeHead(303, { location: '/?step=code', 'set-cookie': ticketCookie(outcome.ticket), 'cache-control': 'no-store' })
        response.end()
        return
      }
      if (!outcome.ok) {
        response.writeHead(outcome.reason === 'limited' ? 429 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(loginPage(outcome.reason))
        return
      }
      response.writeHead(303, { location: '/', 'set-cookie': cookie(outcome.sessionId), 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (method === 'POST' && path === '/login') {
      if (request.headers['x-argus'] !== '1') return send(response, 403, { error: 'missing x-argus header' })
      const body = await readJson(request)
      const outcome = await deps.auth.loginWithPassword(String(body['login'] ?? ''), String(body['password'] ?? ''), address, userAgent)
      if (!outcome.ok && outcome.reason === 'totp') {
        response.writeHead(200, { 'content-type': TYPES['.json'] as string, 'set-cookie': ticketCookie(outcome.ticket), 'cache-control': 'no-store' })
        response.end(JSON.stringify({ code: true }))
        return
      }
      if (!outcome.ok) return send(response, outcome.reason === 'limited' ? 429 : 401, { error: outcome.reason })
      response.writeHead(204, { 'set-cookie': cookie(outcome.sessionId), 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (method === 'POST' && path === '/login/code') {
      if (request.headers['x-argus'] !== '1') return send(response, 403, { error: 'missing x-argus header' })
      const body = await readJson(request)
      const outcome = deps.auth.verifyTicket(cookieOf(request, TICKET_COOKIE) ?? '', String(body['code'] ?? ''), address, userAgent)
      if (!outcome.ok) return send(response, outcome.reason === 'limited' ? 429 : 401, { error: outcome.reason })
      response.writeHead(204, { 'set-cookie': [cookie(outcome.sessionId), ticketCookie('', 0)], 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (method === 'GET' && path === '/setup') {
      // The page shows the form for the admin; the link must still be live.
      const token = new URL(request.url ?? '/', 'http://x').searchParams.get('token') ?? ''
      if (!deps.setup.valid(token)) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(messagePage(deps.setup.open ? 'This setup link is not valid: it was used already, or it is older than an hour. Run <code>argus setup-link</code> on the server for a new one.' : 'Argus is set up already. <a href="/" style="color:#7fd4ff">Sign in</a>.'))
        return
      }
      response.writeHead(200, { 'content-type': TYPES['.html'] as string, 'cache-control': 'no-store' })
      response.end(shell)
      return
    }
    if (method === 'POST' && path === '/api/setup') {
      if (request.headers['x-argus'] !== '1') return send(response, 403, { error: 'missing x-argus header' })
      const body = await readJson(request)
      const outcome = await deps.setup.complete(
        String(body['token'] ?? ''),
        { name: String(body['name'] ?? ''), login: String(body['login'] ?? ''), password: String(body['password'] ?? '') },
        userAgent,
      )
      if (!outcome.ok) return send(response, outcome.reason === 'invalid' ? 401 : 400, { error: outcome.reason })
      response.writeHead(204, { 'set-cookie': cookie(outcome.sessionId), 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      response.writeHead(200, { 'content-type': TYPES['.html'] as string, 'cache-control': 'no-store' })
      response.end(shell)
      return
    }
    if (method === 'GET' && path.startsWith('/static/')) return serveFile(response, publicDir, path.slice('/static/'.length))
    // A language's texts: the sign-in page needs them too.
    const localeFile = /^\/locales\/([^/]+)\.json$/.exec(path)
    if (method === 'GET' && localeFile !== null) {
      const file = deps.locales.file(decodeURIComponent(localeFile[1] as string))
      if (file === undefined) return send(response, 404, { error: 'no such language' })
      response.writeHead(200, { 'content-type': TYPES['.json'] as string, 'cache-control': 'no-cache' })
      response.end(readFileSync(file))
      return
    }
    if (method === 'GET' && path.startsWith('/client/')) return serveFile(response, clientDir, path.slice('/client/'.length))
    if (method === 'GET' && path.startsWith('/fonts/')) {
      const file = path.slice('/fonts/'.length)
      const family = FONT.exec(file)?.[1]
      if (family === undefined) return send(response, 404, { error: 'not found' })
      response.writeHead(200, { 'content-type': TYPES['.woff2'] as string, 'cache-control': 'max-age=604800, immutable' })
      response.end(readFileSync(fileURLToPath(import.meta.resolve(`@fontsource/${family}/files/${file}`))))
      return
    }
    if (method === 'GET' && path.startsWith('/vendor/')) {
      const specifier = VENDOR[path.slice('/vendor/'.length)]
      if (specifier === undefined) return send(response, 404, { error: 'not found' })
      const file = fileURLToPath(import.meta.resolve(specifier))
      response.writeHead(200, { 'content-type': TYPES['.mjs'] as string, 'cache-control': 'max-age=3600' })
      response.end(readFileSync(file))
      return
    }

    // The provider's answer to an MCP server's sign-in. A cross-site redirect carries no
    // SameSite=Strict cookie: the one-time state, made for the admin, is what binds it.
    if (method === 'GET' && path === '/oauth/callback' && deps.oauth !== undefined) {
      const outcome = await deps.oauth.finish(new URL(request.url ?? '/', 'http://x').searchParams)
      response.writeHead(outcome.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(messagePage(`${escapeHtml(outcome.message)} <a href="/" style="color:#7fd4ff">Back to Argus</a>.`))
      return
    }

    // ── a session from here on ───────────────────────────────────────────
    const sessionId = cookieOf(request)
    const session = deps.auth.session(sessionId)
    const start = /^\/oauth\/start\/([A-Za-z0-9_-]{20,})$/.exec(path)
    if (method === 'GET' && start !== null && deps.oauth !== undefined) {
      if (session === undefined || !deps.isAdmin(session)) {
        response.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(messagePage('Sign in as the admin first, in this browser, then open the link again. <a href="/" style="color:#7fd4ff">Sign in</a>.'))
        return
      }
      const begun = await deps.oauth.begin(start[1] as string, `${deps.publicUrl}/oauth/callback`)
      if (!begun.ok) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(messagePage(escapeHtml(begun.message)))
        return
      }
      response.writeHead(303, { location: begun.url, 'cache-control': 'no-store' })
      response.end()
      return
    }
    const link = /^\/f\/([A-Za-z0-9_-]{20,})$/.exec(path)
    if (method === 'GET' && link !== null) {
      // A link is used only by someone signed in, and only once; opening it signed out
      // does not use it up.
      if (session === undefined) {
        response.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(messagePage('Sign in first, in this browser, then open the link again. <a href="/" style="color:#7fd4ff">Sign in</a>.'))
        return
      }
      const file = deps.links.take(link[1] as string)
      if (file === undefined) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(messagePage('This download link was used already, or it expired. Ask for the file again.'))
        return
      }
      deps.links.serve(response, file)
      return
    }
    if (session === undefined) return send(response, 401, { error: 'not signed in' })
    if (method === 'POST' && request.headers['x-argus'] !== '1') return send(response, 403, { error: 'missing x-argus header' })
    const hasTotp = deps.auth.hasTotp(session.userId)
    if (deps.public && !hasTotp && !SETTING_UP.has(path)) return send(response, 403, { error: 'second factor required' })

    if (method === 'GET' && path === '/api/me') {
      const me = deps.me(session) as Record<string, unknown>
      return send(response, 200, { ...me, totp: hasTotp, totpRequired: deps.public && !hasTotp, publicMode: deps.public })
    }
    if (method === 'POST' && path === '/api/totp/start') return send(response, 200, deps.auth.startTotp(session.userId))
    if (method === 'POST' && path === '/api/totp/confirm') {
      const body = await readJson(request)
      const recovery = deps.auth.confirmTotp(session.userId, String(body['code'] ?? ''))
      return recovery === undefined ? send(response, 400, { error: 'invalid' }) : send(response, 200, { recovery })
    }
    if (method === 'POST' && path === '/api/totp/disable') {
      if (deps.public) return send(response, 403, { error: 'required in public mode' })
      const body = await readJson(request)
      const ok = deps.auth.disableTotp(session.userId, String(body['code'] ?? ''))
      return send(response, ok ? 200 : 400, ok ? { ok } : { error: 'invalid' })
    }
    if (method === 'POST' && path === '/api/password') {
      const body = await readJson(request)
      const outcome = await deps.auth.setPassword(sessionId ?? '', {
        password: String(body['password'] ?? ''),
        ...(typeof body['login'] === 'string' ? { login: body['login'] } : {}),
        ...(typeof body['current'] === 'string' ? { current: body['current'] } : {}),
      })
      return send(response, outcome.ok ? 200 : 400, outcome.ok ? { ok: true } : { error: outcome.reason })
    }
    if (method === 'POST' && path === '/api/logout') {
      deps.auth.logout(sessionId)
      response.writeHead(204, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
      response.end()
      return
    }
    if (method === 'GET' && path === '/api/users') {
      const users = deps.users(session)
      return users === undefined ? send(response, 403, { error: 'only the admin' }) : send(response, 200, { users })
    }
    if (method === 'GET' && path === '/api/projects') return send(response, 200, { projects: deps.projects() })
    if (method === 'GET' && path === '/api/tasks') return send(response, 200, { tasks: deps.tasks() })
    if (method === 'GET' && path === '/api/schedules') return send(response, 200, { schedules: deps.schedules() })
    if (method === 'GET' && path === '/api/runs') return send(response, 200, deps.runs())
    if (method === 'GET' && path === '/api/templates') return send(response, 200, { templates: deps.templates() })
    const upload = /^\/api\/projects\/([^/]+)\/upload$/.exec(path)
    if (method === 'POST' && upload !== null) {
      const id = decodeURIComponent(upload[1] as string)
      const cwd = deps.projectDir(id)
      if (cwd === undefined) return send(response, 404, { error: 'no such project' })
      const name = new URL(request.url ?? '/', 'http://x').searchParams.get('name') ?? 'upload'
      try {
        const saved = await receiveUpload(request, cwd, name, deps.maxUploadBytes)
        deps.uploaded(session, id, saved.path, saved.bytes)
        return send(response, 201, saved)
      } catch (error) {
        if (error instanceof FileRefusal) return send(response, error.status, { error: error.message })
        throw error
      }
    }
    const folder = /^\/api\/projects\/([^/]+)\/(files|file)$/.exec(path)
    if (method === 'GET' && folder !== null) {
      const cwd = deps.projectDir(decodeURIComponent(folder[1] as string))
      if (cwd === undefined) return send(response, 404, { error: 'no such project' })
      const params = new URL(request.url ?? '/', 'http://x').searchParams
      try {
        if (folder[2] === 'files') return send(response, 200, listFolder(cwd, params.get('path') ?? ''))
        return sendFile(response, cwd, params.get('path') ?? '', params.get('download') === '1')
      } catch (error) {
        if (error instanceof FileRefusal) return send(response, error.status, { error: error.message })
        if ((error as NodeJS.ErrnoException).code === 'ELOOP' || (error as NodeJS.ErrnoException).code === 'ENOENT') return send(response, 404, { error: 'not found' })
        throw error
      }
    }
    const zip = /^\/api\/projects\/([^/]+)\/zip$/.exec(path)
    if (method === 'GET' && zip !== null) {
      const id = decodeURIComponent(zip[1] as string)
      const cwd = deps.projectDir(id)
      if (cwd === undefined) return send(response, 404, { error: 'no such project' })
      const folder = new URL(request.url ?? '/', 'http://x').searchParams.get('path') ?? '.'
      try {
        await sendZip(response, cwd, folder, deps.confineZip, `${id}${folder === '.' ? '' : `-${folder.replace(/[^\w.-]+/g, '-')}`}.zip`, deps.zipScratch)
        return
      } catch (error) {
        if (error instanceof FileRefusal) return send(response, error.status, { error: error.message })
        throw error
      }
    }
    const projectSettings = /^\/api\/projects\/([^/]+)\/settings$/.exec(path)
    if (method === 'GET' && projectSettings !== null) {
      const described = await deps.projectSettings(decodeURIComponent(projectSettings[1] as string))
      return described === undefined ? send(response, 404, { error: 'no such project' }) : send(response, 200, described)
    }
    if (method === 'GET' && path === '/api/models') return send(response, 200, { models: deps.models() })
    if (method === 'GET' && path === '/api/locales') return send(response, 200, { locales: deps.locales.list() })
    if (method === 'GET' && path === '/api/extensions') return send(response, 200, { extensions: deps.extensions() })
    if (method === 'POST' && path === '/api/me/language') {
      const body = await readJson(request)
      const code = body['code'] === null ? null : String(body['code'] ?? '')
      if (code !== null && !deps.locales.list().some((locale) => locale.code === code)) return send(response, 400, { error: 'no such language' })
      deps.setLanguage(session.userId, code)
      return send(response, 200, { ok: true })
    }
    const locale = /^\/api\/locales\/([^/]+?)(\/remove)?$/.exec(path)
    if (method === 'POST' && locale !== null) {
      if (!deps.isAdmin(session)) return send(response, 403, { error: 'only the admin' })
      const code = decodeURIComponent(locale[1] as string)
      if (locale[2] !== undefined) return deps.locales.remove(code) ? send(response, 200, { ok: true }) : send(response, 404, { error: 'no such pack' })
      const why = deps.locales.save(code, await readJson(request, 512 * 1024))
      return why === undefined ? send(response, 200, { ok: true }) : send(response, 400, { error: why })
    }
    if (method === 'GET' && path === '/api/secrets') {
      if (!deps.isAdmin(session)) return send(response, 403, { error: 'only the admin' })
      return send(response, 200, { groups: await deps.secrets() })
    }
    const projectPath = /^\/api\/projects\/([^/]+)$/.exec(path)
    if (method === 'GET' && projectPath !== null) {
      const project = deps.project(decodeURIComponent(projectPath[1] as string))
      return project === undefined ? send(response, 404, { error: 'no such project' }) : send(response, 200, project)
    }
    if (method === 'GET' && path === '/api/overview') return send(response, 200, deps.overview())
    if (method === 'GET' && path === '/api/settings') return send(response, 200, deps.settings())
    if (method === 'GET' && path === '/api/settings/system') {
      if (!deps.isAdmin(session)) return send(response, 403, { error: 'only the admin' })
      const described = deps.systemSettings()
      return described === undefined ? send(response, 404, { error: 'the configuration file is not known' }) : send(response, 200, described)
    }
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
    const checkpoint = /^\/api\/checkpoints\/([^/]+)$/.exec(path)
    if (method === 'POST' && checkpoint !== null) {
      const body = await readJson(request)
      const value = typeof body['value'] === 'string' ? body['value'] : ''
      const ok = deps.answerCheckpoint(decodeURIComponent(checkpoint[1] as string), value, session)
      return send(response, ok ? 200 : 409, ok ? { ok } : { error: 'that run is no longer waiting' })
    }
    if (method === 'GET' && path === '/api/chat') return send(response, 200, { entries: deps.chat.history(session.userId, new URL(request.url ?? '/', 'http://x').searchParams.get('thread') ?? '') })
    if (method === 'GET' && path === '/api/chat/unread') return send(response, 200, { count: deps.chat.unread(session.userId), threads: deps.chat.unreadByThread(session.userId) })
    if (method === 'GET' && path === '/api/sessions') return send(response, 200, { sessions: deps.sessions() })
    if (method === 'POST' && path === '/api/chat/read') {
      const body = await readJson(request)
      deps.chat.markRead(session.userId, typeof body['thread'] === 'string' ? body['thread'] : '')
      return send(response, 200, { ok: true })
    }
    if (method === 'POST' && path === '/api/chat') {
      const body = await readJson(request)
      const text = typeof body['text'] === 'string' ? body['text'] : ''
      const thread = typeof body['thread'] === 'string' ? body['thread'] : ''
      if (text.trim().length === 0) return send(response, 400, { error: 'empty message' })
      if (threadChat(session.userId, thread) === undefined) return send(response, 400, { error: 'no such conversation' })
      // A project's thread speaks to the project; a session's goes to it as /session, the text verbatim inside.
      if (thread.startsWith('p:') && !deps.bindThread(session.userId, thread.slice(2))) return send(response, 404, { error: 'no such project' })
      deps.chat.receive(session.userId, text, thread, thread.startsWith('s:') ? `/session ${thread.slice(2)} ${text}` : undefined)
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
      // A chat change is only for the person whose chat it is; the page learns which thread.
      if (topic.startsWith('chat:') && !ownsChat(session.userId, topic.slice('chat:'.length))) return
      response.write(`event: changed\ndata: ${topic.startsWith('chat:') ? `chat:${threadOf(topic.slice('chat:'.length))}` : topic}\n\n`)
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

/** A cookie's value (the session's, by default), when the request carries it. */
function cookieOf(request: IncomingMessage, wanted = COOKIE): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === wanted) return value.join('=')
  }
  return undefined
}

/**
 * Who is asking, for the failed sign-in limit. In public mode the server is reached
 * only through the proxy, whose last `X-Forwarded-For` entry is the client.
 */
function clientAddress(request: IncomingMessage, behindProxy: boolean): string {
  const forwarded = request.headers['x-forwarded-for']
  if (behindProxy && typeof forwarded === 'string') {
    const last = forwarded.split(',').at(-1)?.trim()
    if (last !== undefined && last.length > 0) return last
  }
  return request.socket.remoteAddress ?? '?'
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
async function readJson(request: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('request body too large')
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
  return messagePage(
    reason === 'limited'
      ? 'Too many failed attempts from this address. Wait a quarter of an hour.'
      : 'This link is not valid: it was used already, or it is older than 10 minutes. Send /web for a new one, or <a href="/" style="color:#7fd4ff">sign in with your password</a>.',
  )
}

/** A page with one message. */
/** Text safe inside HTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function messagePage(text: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Argus</title><body style="font:16px system-ui;background:#04070d;color:#dcebfa;padding:40px"><p>${text}</p></body>`
}
