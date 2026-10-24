// == ARGUS AGENT PROJECT ==
/**
 * The web interface in a real composition: a `/web` link signs in, a password set
 * from it signs in too, the API answers with a session and refuses without one,
 * commands run with the user's role, the chat is one of the user's channels, and a
 * question another channel asked can be answered from the web.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BASE_ENTRIES, ConsoleChannelAdapter, bootOps, persistenceEntry, waitFor, type OpsBoot } from '@argus-agent/testkit'
import type { OpsChannel } from '@argus-agent/channel'
import type { OpsCommands } from '@argus-agent/commands'
import type { OpsStore } from '@argus-agent/store'
import { codeAt, stepAt, type OpsWeb } from '@argus-agent/web'
import { checkpointQuestionId, type OpsGovernor } from '@argus-agent/governor'

const boots: OpsBoot[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const boot of boots.splice(0)) await boot.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Booted {
  readonly boot: OpsBoot
  readonly base: string
  readonly channel: OpsChannel
  readonly commands: OpsCommands
  readonly web: OpsWeb
  readonly store: OpsStore
  /** The admin's Argus user id. */
  readonly admin: string
  readonly dataDir: string
}

async function bootWeb(options: { noAdmin?: boolean; public?: boolean; maxUploadMb?: number; sandbox?: boolean; tailscale?: boolean } = {}): Promise<Booted> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ops-web-'))
  dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects', 'alpha'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
  writeFileSync(
    join(dataDir, 'config', 'projects', 'alpha.yaml'),
    `id: alpha\ncwd: ${JSON.stringify(join(dataDir, 'projects', 'alpha'))}\nprovider: fake\nmodel: fake-model\ndescription: The test site\n`,
  )
  const boot = await bootOps({
    dataDir,
    bareModuleBaseUrl: import.meta.url,
    fake: { script: [{ text: 'the answer', usage: { inputTokens: 100, outputTokens: 0 } }] as never, repeatLast: true },
    files: {
      'config/ops.yaml':
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
        `tasks:\n  model: fake/fake-model\n` +
        `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `budgets:\n  default_day_usd: 100\n` +
        // The admin is a Telegram user; no Telegram adapter is needed to ask for a link.
        (options.noAdmin === true
          ? ''
          : `access:\n  allowed_users:\n    - { channel: telegram, userId: '42' }\n    - { channel: console, userId: user-1 }\n  admin: telegram:42\n`) +
        `channel:\n  default_address: console:default-chat\n` +
        `web:\n  port: 0\n` +
        (options.maxUploadMb === undefined ? '' : `  max_upload_mb: ${options.maxUploadMb}\n`) +
        (options.tailscale === true ? `  tailscale_identity: true\n` : '') +
        (options.public === true ? `  public: true\n  public_url: https://argus.example\n` : ''),
    },
    replaceEntries: [
      ...BASE_ENTRIES,
      persistenceEntry(join(dataDir, 'sessions')),
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'default' } },
      { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
      { id: 'ops-store', name: '@argus-agent/store' },
      { id: 'ops-projects', name: '@argus-agent/projects' },
      { id: 'ops-meter', name: '@argus-agent/meter' },
      { id: 'ops-governor', name: '@argus-agent/governor' },
      { id: 'commands', name: '@deepseek-ai/dsh-commands' },
      { id: 'ops-commands', name: '@argus-agent/commands' },
      { id: 'ops-channel', name: '@argus-agent/channel' },
      // After ops-commands, as in the bundle: /cron must find it all the same.
      { id: 'ops-scheduler', name: '@argus-agent/scheduler' },
      { id: 'ops-web', name: '@argus-agent/web' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
      ...(options.sandbox === true ? [{ id: 'sandbox', name: '@argus-agent/argus-agent/sandbox-row' }] : []),
    ],
  })
  boots.push(boot)
  const ctx = boot.ctx as unknown as { opsChannel: OpsChannel; opsCommands: OpsCommands; opsWeb: OpsWeb; opsStore: OpsStore }
  await waitFor(() => ctx.opsWeb?.port !== undefined, { timeoutMs: 10_000, label: 'web listening' })
  const admin = ctx.opsStore.users.admin()?.id ?? ''
  return { boot, base: `http://127.0.0.1:${ctx.opsWeb.port}`, channel: ctx.opsChannel, commands: ctx.opsCommands, web: ctx.opsWeb, store: ctx.opsStore, admin, dataDir }
}

/** Sign in as the admin (Telegram user 42) through `/web`, returning the cookie. */
async function signIn(booted: Booted): Promise<string> {
  const out = await booted.commands.runCommand('/web', {
    address: { channel: 'telegram', chatId: '42' },
    userId: '42',
    user: { id: booted.admin, role: 'admin' },
    isAdmin: true,
    now: Date.now(),
  })
  const token = /token=([\w-]+)/.exec(out.text)?.[1] ?? ''
  const login = await fetch(`${booted.base}/login?token=${token}`, { redirect: 'manual' })
  expect(login.status).toBe(303)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  expect(login.headers.get('set-cookie')).toContain('HttpOnly')
  expect(login.headers.get('set-cookie')).toContain('SameSite=Strict')
  // The link works once.
  expect((await fetch(`${booted.base}/login?token=${token}`, { redirect: 'manual' })).status).toBe(401)
  return cookie
}

describe('the web interface', () => {
  it('keeps a conversation per project and per session: what is written there goes there, and the answer comes back there only', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const post = (path: string, body: unknown): Promise<Response> => fetch(`${booted.base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify(body) })
    const history = async (thread: string): Promise<Array<{ from: string; text: string }>> => ((await (await fetch(`${booted.base}/api/chat?thread=${encodeURIComponent(thread)}`, { headers: { cookie } })).json()) as { entries: Array<{ from: string; text: string }> }).entries

    expect((await post('/api/chat', { thread: 'p:alpha', text: 'make  the page' })).status).toBe(202)
    const until = async (check: () => Promise<boolean>, label: string): Promise<void> => {
      for (const started = Date.now(); !(await check()); ) {
        if (Date.now() - started > 20_000) throw new Error(`timed out: ${label}`)
        await new Promise((done) => setTimeout(done, 100))
      }
    }
    await until(async () => (await history('p:alpha')).some((entry) => entry.from === 'argus' && entry.text.includes('the answer')), 'the project answers in its thread')
    expect((await history('p:alpha'))[0]).toMatchObject({ from: 'you', text: 'make  the page' })
    expect(await history('')).toEqual([])
    const runs = booted.store.runs.byOwner('project:alpha', 5)
    expect(runs).toHaveLength(1)
    const unread = (await (await fetch(`${booted.base}/api/chat/unread`, { headers: { cookie } })).json()) as { count: number; threads: Record<string, number> }
    expect(unread.threads['p:alpha']).toBeGreaterThan(0)
    await post('/api/chat/read', { thread: 'p:alpha' })
    expect(((await (await fetch(`${booted.base}/api/chat/unread`, { headers: { cookie } })).json()) as { count: number }).count).toBe(0)

    // A session: the text shows as written, and goes to the session.
    expect((await post('/api/chat', { thread: 's:task-web12345', text: 'compare  three hosts' })).status).toBe(202)
    await until(async () => (await history('s:task-web12345')).some((entry) => entry.from === 'argus' && entry.text.includes('the answer')), 'the session answers in its thread')
    expect((await history('s:task-web12345'))[0]).toMatchObject({ from: 'you', text: 'compare  three hosts' })
    const sessions = ((await (await fetch(`${booted.base}/api/sessions`, { headers: { cookie } })).json()) as { sessions: Array<{ id: string; text: string | null }> }).sessions
    // Shown in the list with its spacing tidied; sent verbatim.
    expect(sessions).toEqual([expect.objectContaining({ id: 'task-web12345', text: 'compare three hosts' })])

    expect((await post('/api/chat', { thread: 'p:nope', text: 'hi' })).status).toBe(404)
    expect((await post('/api/chat', { thread: 'x:../alpha', text: 'hi' })).status).toBe(400)
    expect((await post('/api/chat', { thread: 's:../../etc', text: 'hi' })).status).toBe(400)
  }, 60_000)

  it('lists a project\'s folder and serves its files so that nothing in them runs, and nothing outside it', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const dir = join(booted.dataDir, 'projects', 'alpha')
    mkdirSync(join(dir, 'reports'))
    writeFileSync(join(dir, 'reports', 'week.md'), '# Week\n')
    writeFileSync(join(dir, 'page.html'), '<script>alert(1)</script>')
    symlinkSync('/etc/passwd', join(dir, 'passwd'))
    const get = (path: string): Promise<Response> => fetch(`${booted.base}${path}`, { headers: { cookie } })
    const listing = (await (await get('/api/projects/alpha/files')).json()) as { entries: Array<{ name: string; dir: boolean }> }
    expect(listing.entries.map((entry) => entry.name)).toEqual(['reports', 'page.html'])
    const reports = (await (await get('/api/projects/alpha/files?path=reports')).json()) as { entries?: Array<{ name: string }>; error?: string }
    expect(reports.error).toBeUndefined()
    expect(reports.entries?.map((entry) => entry.name)).toEqual(['week.md'])

    const md = await get('/api/projects/alpha/file?path=reports/week.md')
    expect(md.status).toBe(200)
    expect(await md.text()).toBe('# Week\n')
    const html = await get('/api/projects/alpha/file?path=page.html')
    expect(html.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(html.headers.get('content-security-policy')).toContain('sandbox')
    expect(html.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await get('/api/projects/alpha/file?path=page.html&download=1')).headers.get('content-disposition')).toMatch(/^attachment/)
    for (const path of ['passwd', '../../config/ops.yaml', '/etc/passwd', 'nothing.txt']) {
      expect([403, 404], path).toContain((await get(`/api/projects/alpha/file?path=${encodeURIComponent(path)}`)).status)
    }
    expect((await get('/api/projects/nope/files')).status).toBe(404)
  }, 60_000)

  it('describes a project\'s settings, whose own each is, and its servers, extensions and remotes; and the models with their prices', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const get = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(`${booted.base}${path}`, { headers: { cookie } })).json()) as Record<string, unknown>
    const body = await get('/api/projects/alpha/settings')
    const fields = body['fields'] as Array<{ key: string; own: boolean; value: unknown }>
    expect(fields.find((field) => field.key === 'description')).toMatchObject({ own: true, value: 'The test site' })
    expect(fields.find((field) => field.key === 'budget.day_usd')).toMatchObject({ own: false })
    expect(fields.some((field) => field.key === 'cwd' || field.key === 'id')).toBe(false)
    expect(body).toMatchObject({ model: 'fake/fake-model', mcp: [], git: [], undo: [] })
    expect((await fetch(`${booted.base}/api/projects/nope/settings`, { headers: { cookie } })).status).toBe(404)
    expect(Array.isArray((await get('/api/models'))['models'])).toBe(true)
  }, 60_000)

  it('serves the languages, takes a pack, keeps a user\'s language, and lists the secrets and extensions to the admin', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const post = (path: string, body: unknown): Promise<Response> => fetch(`${booted.base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify(body) })
    const get = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(`${booted.base}${path}`, { headers: { cookie } })).json()) as Record<string, unknown>
    // The sign-in page reads its language before anyone signs in.
    expect((await fetch(`${booted.base}/locales/ro.json`)).status).toBe(200)
    expect((await fetch(`${booted.base}/locales/..%2Fen.json`)).status).toBe(404)
    expect(((await get('/api/locales'))['locales'] as Array<{ code: string }>).map((locale) => locale.code)).toEqual(['en', 'ro'])

    expect((await post('/api/locales/de', { 'nav.inbox': 'Posteingang', _name: 'Deutsch' })).status).toBe(200)
    expect((await post('/api/locales/de', { 'not.a.key': 'x' })).status).toBe(400)
    expect((await post('/api/locales/ro', { 'nav.inbox': 'x' })).status).toBe(400)
    expect((await post('/api/locales/<script>', { 'nav.inbox': 'x' })).status).toBe(400)
    const de = ((await get('/api/locales'))['locales'] as Array<{ code: string; name: string; keys: number }>).find((locale) => locale.code === 'de')
    expect(de).toMatchObject({ name: 'Deutsch', keys: 1 })
    expect(await (await fetch(`${booted.base}/locales/de.json`)).json()).toMatchObject({ 'nav.inbox': 'Posteingang' })

    expect((await post('/api/me/language', { code: 'de' })).status).toBe(200)
    expect((await get('/api/me'))['language']).toBe('de')
    expect((await post('/api/me/language', { code: 'xx' })).status).toBe(400)
    expect((await post('/api/locales/de/remove', {})).status).toBe(200)

    expect(Array.isArray((await get('/api/secrets'))['groups'])).toBe(true)
    expect((await get('/api/extensions'))['extensions']).toEqual([])
  }, 60_000)

  it('signs in a linked Tailscale login through tailscale serve, no one else, and only when it is on', async () => {
    const booted = await bootWeb({ tailscale: true })
    const me = (headers: Record<string, string>): Promise<Response> => fetch(`${booted.base}/api/me`, { headers })
    expect((await me({ 'tailscale-user-login': 'romeo@github' })).status).toBe(401)
    const linked = await booted.commands.runCommand(`/users tailscale ${booted.admin} Romeo@GitHub`, { address: { channel: 'web', chatId: booted.admin }, userId: booted.admin, user: { id: booted.admin, role: 'admin' }, isAdmin: true, now: Date.now() })
    expect(linked.text).toContain('romeo@github')
    const signed = await me({ 'tailscale-user-login': 'romeo@github' })
    expect(signed.status).toBe(200)
    expect(signed.headers.get('set-cookie')).toContain('HttpOnly')
    expect(((await signed.json()) as { role: string }).role).toBe('admin')
    expect((await me({ 'tailscale-user-login': 'someone@github' })).status).toBe(401)
    expect(booted.store.audit.recent(20).some((row) => row.action === 'web.signin' && row.target === 'tailscale')).toBe(true)
  }, 60_000)

  it('ignores a Tailscale identity unless web.tailscale_identity is on', async () => {
    const off = await bootWeb()
    await off.commands.runCommand(`/users tailscale ${off.admin} romeo@github`, { address: { channel: 'web', chatId: off.admin }, userId: off.admin, user: { id: off.admin, role: 'admin' }, isAdmin: true, now: Date.now() })
    expect((await fetch(`${off.base}/api/me`, { headers: { 'tailscale-user-login': 'romeo@github' } })).status).toBe(401)
  }, 60_000)

  it('lists where the user is signed in and ends the other sessions', async () => {
    const booted = await bootWeb()
    const first = await signIn(booted)
    const second = await signIn(booted)
    const list = ((await (await fetch(`${booted.base}/api/me/sessions`, { headers: { cookie: second } })).json()) as { sessions: Array<{ id: string; current: boolean }> }).sessions
    expect(list).toHaveLength(2)
    expect(list.filter((each) => each.current)).toHaveLength(1)
    const end = await fetch(`${booted.base}/api/me/sessions/others/end`, { method: 'POST', headers: { cookie: second, 'content-type': 'application/json', 'x-argus': '1' }, body: '{}' })
    expect(((await end.json()) as { ended: number }).ended).toBe(1)
    expect((await fetch(`${booted.base}/api/me`, { headers: { cookie: first } })).status).toBe(401)
    expect((await fetch(`${booted.base}/api/me`, { headers: { cookie: second } })).status).toBe(200)
  }, 60_000)

  it('describes every ops.yaml setting to the admin, web\'s own included', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const response = await fetch(`${booted.base}/api/settings/system`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { fields: Array<{ key: string; kind: string; min: number | null; apply: string }>; pending: string[]; restartable: boolean }
    expect(body.fields.find((field) => field.key === 'web.session_hours')).toMatchObject({ kind: 'number', min: 1, apply: 'restart' })
    expect(body.pending).toEqual([])
    expect((await fetch(`${booted.base}/api/settings/system`)).status).toBe(401)
  })

  it('serves the page\'s fonts without a session, and nothing else from /fonts/', async () => {
    const booted = await bootWeb()
    const font = await fetch(`${booted.base}/fonts/space-grotesk-latin-ext-600-normal.woff2`)
    expect(font.status).toBe(200)
    expect(font.headers.get('content-type')).toBe('font/woff2')
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000)
    for (const path of ['/fonts/space-grotesk-cyrillic-600-normal.woff2', '/fonts/..%2Fpackage.json', '/fonts/index.css']) {
      expect((await fetch(`${booted.base}${path}`)).status, path).toBe(404)
    }
    expect(font.headers.get('content-security-policy')).toContain("font-src 'self'")
  })

  it('with no admin, the one-time setup link creates the admin and signs them in', async () => {
    const booted = await bootWeb({ noAdmin: true })
    const file = join(booted.dataDir, 'state', 'setup-link')
    const link = readFileSync(file, 'utf8').trim()
    const token = /token=([\w-]+)/.exec(link)?.[1] ?? ''
    expect((await fetch(`${booted.base}/setup?token=wrong`)).status).toBe(404)
    expect((await fetch(`${booted.base}/setup?token=${token}`)).status).toBe(200)
    const create = (login: string): Promise<Response> =>
      fetch(`${booted.base}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-argus': '1' },
        body: JSON.stringify({ token, name: 'Ana', login, password: 'a long password' }),
      })
    const created = await create('ana')
    expect(created.status).toBe(204)
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const me = (await (await fetch(`${booted.base}/api/me`, { headers: { cookie } })).json()) as { role: string; login: string }
    expect(me).toMatchObject({ role: 'admin', login: 'ana' })
    expect(existsSync(file)).toBe(false)
    // Once only, and the page is gone.
    expect((await create('eve')).status).toBe(401)
    expect((await fetch(`${booted.base}/setup?token=${token}`)).status).toBe(404)
    // The settings carry what the setup page shows.
    const settings = (await (await fetch(`${booted.base}/api/settings`, { headers: { cookie } })).json()) as { system: unknown }
    expect(settings.system).toEqual({ timezone: 'UTC', dayUsd: 100, monthUsd: 40 })
  })

  it('in public mode, a session first sets up a code, and every sign-in then asks for one', async () => {
    const booted = await bootWeb({ public: true })
    const out = await booted.commands.runCommand('/web', { address: { channel: 'telegram', chatId: '42' }, userId: '42', user: { id: booted.admin, role: 'admin' }, isAdmin: true, now: Date.now() })
    const link = /token=([\w-]+)/.exec(out.text)?.[1] ?? ''
    const first = await fetch(`${booted.base}/login?token=${link}`, { redirect: 'manual' })
    expect(first.headers.get('strict-transport-security')).toContain('max-age=')
    expect(first.headers.get('set-cookie')).toContain('Secure')
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const api = (path: string, body?: unknown): Promise<Response> =>
      fetch(`${booted.base}${path}`, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify(body) })
    // Nothing but the code's setup, until there is one.
    expect((await api('/api/overview')).status).toBe(403)
    expect(await (await api('/api/me')).json()).toMatchObject({ totp: false, totpRequired: true, publicMode: true })
    const doctor = () => booted.web.doctor().find((finding) => finding.check.includes('second factor'))
    expect(doctor()).toMatchObject({ ok: false })
    const { secret } = (await (await api('/api/totp/start', {})).json()) as { secret: string }
    expect((await api('/api/totp/confirm', { code: '000000' === codeAt(secret, stepAt(Date.now())) ? '111111' : '000000' })).status).toBe(400)
    const confirmed = (await (await api('/api/totp/confirm', { code: codeAt(secret, stepAt(Date.now())) })).json()) as { recovery: string[] }
    expect(confirmed.recovery).toHaveLength(10)
    expect((await api('/api/overview')).status).toBe(200)
    expect(doctor()).toMatchObject({ ok: true })
    // In public mode it cannot be turned off.
    expect((await api('/api/totp/disable', { code: confirmed.recovery[0] })).status).toBe(403)

    // The next link asks for the code: a ticket cookie, then the code.
    const again = await booted.commands.runCommand('/web', { address: { channel: 'telegram', chatId: '42' }, userId: '42', user: { id: booted.admin, role: 'admin' }, isAdmin: true, now: Date.now() })
    const second = await fetch(`${booted.base}/login?token=${/token=([\w-]+)/.exec(again.text)?.[1] ?? ''}`, { redirect: 'manual' })
    expect(second.status).toBe(303)
    expect(second.headers.get('location')).toBe('/?step=code')
    const ticket = (second.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(ticket).toMatch(/^argus_ticket=/)
    const code = (value: string): Promise<Response> =>
      fetch(`${booted.base}/login/code`, { method: 'POST', headers: { cookie: ticket, 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify({ code: value }) })
    // The code just used for the setup does not work twice; a recovery code does, once.
    expect((await code(codeAt(secret, stepAt(Date.now())))).status).toBe(401)
    const signedIn = await code(confirmed.recovery[1] ?? '')
    expect(signedIn.status).toBe(204)
    expect(signedIn.headers.get('set-cookie')).toContain('argus_session=')
  })

  it('with an admin, there is no setup link', async () => {
    const booted = await bootWeb()
    expect(existsSync(join(booted.dataDir, 'state', 'setup-link'))).toBe(false)
  })

  it('signs in through a /web link, and refuses the API without a session or the header', async () => {
    const booted = await bootWeb()
    expect((await fetch(`${booted.base}/api/overview`)).status).toBe(401)
    const shell = await fetch(`${booted.base}/`)
    expect(shell.status).toBe(200)
    expect(shell.headers.get('content-security-policy')).toContain("default-src 'self'")
    for (const path of ['/vendor/preact.mjs', '/vendor/htm-preact.mjs', '/client/app.js', '/static/locales/ro.json', '/static/app.css']) {
      expect((await fetch(`${booted.base}${path}`)).status, path).toBe(200)
    }
    expect((await fetch(`${booted.base}/static/../package.json`)).status).not.toBe(200)

    const cookie = await signIn(booted)
    const overview = (await (await fetch(`${booted.base}/api/overview`, { headers: { cookie } })).json()) as { projects: Array<{ id: string; description: string }> }
    expect(overview.projects.map((project) => project.id)).toEqual(['alpha'])
    const settings = (await (await fetch(`${booted.base}/api/settings`, { headers: { cookie } })).json()) as { defaults: { tasks: string }; projects: Array<{ tools: { agents: string } }> }
    expect(settings.defaults.tasks).toBe('fake/fake-model')
    expect(settings.projects[0]?.tools.agents).toBe('off')

    const noHeader = await fetch(`${booted.base}/api/command`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ line: '/defaults' }) })
    expect(noHeader.status).toBe(403)
    const command = await fetch(`${booted.base}/api/command`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' },
      body: JSON.stringify({ line: '/set alpha tools.web allow' }),
    })
    expect(((await command.json()) as { text: string }).text).toContain('tools.web')
  }, 60_000)

  it('is a chat channel: a command typed there is answered there', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const headers = { cookie, 'content-type': 'application/json', 'x-argus': '1' }
    expect((await fetch(`${booted.base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ text: '/projects' }) })).status).toBe(202)
    let entries: Array<{ from: string; text: string }> = []
    for (let tries = 0; tries < 100 && entries.length < 2; tries++) {
      entries = ((await (await fetch(`${booted.base}/api/chat`, { headers: { cookie } })).json()) as { entries: typeof entries }).entries
      if (entries.length < 2) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(entries[0]).toMatchObject({ from: 'you', text: '/projects' })
    expect(entries[1]?.text).toContain('alpha')
  }, 60_000)

  it('answers from the web a question another channel asked', async () => {
    const booted = await bootWeb()
    const console = new ConsoleChannelAdapter()
    booted.channel.register(console)
    const cookie = await signIn(booted)
    const asked = booted.channel.ask({ channel: 'console', chatId: 'chat-1' }, 'Run it?', [{ value: 'approve', label: 'Approve' }], 60_000, 'approval:a1')
    const answer = await fetch(`${booted.base}/api/approvals/a1`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' },
      body: JSON.stringify({ value: 'approve' }),
    })
    expect(answer.status).toBe(200)
    expect(await asked).toEqual({ kind: 'button', value: 'approve' })
    expect(booted.channel.answeredBy('approval:a1')).toBe(booted.admin)
    const again = await fetch(`${booted.base}/api/approvals/a1`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' },
      body: JSON.stringify({ value: 'approve' }),
    })
    expect(again.status).toBe(409)
  }, 60_000)

  it('shows a run the loop checker found in a loop, and stops it from the web', async () => {
    const booted = await bootWeb()
    const console = new ConsoleChannelAdapter()
    booted.channel.register(console)
    const cookie = await signIn(booted)
    const headers = { cookie, 'content-type': 'application/json', 'x-argus': '1' }
    for (const line of ['/set alpha limits.loop_check_steps 2', '/set alpha limits.on_loop ask']) {
      await fetch(`${booted.base}/api/command`, { method: 'POST', headers, body: JSON.stringify({ line }) })
    }
    const governor = (booted.boot.ctx as unknown as { opsGovernor: OpsGovernor }).opsGovernor
    governor.setJudgeModel({ provider: 'fake', model: 'judge-model' })
    // The bridge's part, reduced: ask on a channel under the id the web answers.
    governor.setCheckpointAsker(async (question) => {
      const answer = await booted.channel.ask({ channel: 'console', chatId: 'chat-1' }, 'Go on?', [{ value: 'continue', label: 'Continue' }, { value: 'stop', label: 'Stop' }], 60_000, checkpointQuestionId(question.runId, question.steps))
      return answer !== 'timeout' && answer.value === 'continue' ? { kind: 'continue' } : { kind: 'stop', detail: 'stopped from the web' }
    })
    // Calls to a tool that does not exist: each step ends with an error, and the run goes on.
    let n = 0
    booted.boot.fake!.setScript(((request: { model: string }) =>
      request.model === 'judge-model'
        ? { text: '{"verdict":"loop","reason":"every call fails."}' }
        : { text: 'x', toolCalls: [{ name: 'missing', arguments: JSON.stringify({ n: ++n }), id: `c${n}` }] }) as never)
    const stops: string[] = []
    booted.boot.ctx.on('ops/run-stopped', ({ detail }) => stops.push(detail))
    governor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })

    type Waiting = { checkpoints: Array<{ runId: string; who: string; steps: number; reason: string }> }
    let overview: Waiting = { checkpoints: [] }
    for (let tries = 0; tries < 200 && overview.checkpoints.length === 0; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      overview = (await (await fetch(`${booted.base}/api/overview`, { headers: { cookie } })).json()) as Waiting
    }
    expect(overview.checkpoints[0]).toMatchObject({ who: 'alpha', steps: 2, reason: 'every call fails.' })
    const runId = overview.checkpoints[0]!.runId
    expect((await fetch(`${booted.base}/api/checkpoints/${runId}`, { method: 'POST', headers, body: JSON.stringify({ value: 'stop' }) })).status).toBe(200)
    await waitFor(() => stops.length > 0, { timeoutMs: 20_000, label: 'the stop' })
    expect(stops).toEqual(['the loop checker found a loop (every call fails.): stopped from the web'])
    expect((await fetch(`${booted.base}/api/checkpoints/${runId}`, { method: 'POST', headers, body: JSON.stringify({ value: 'stop' }) })).status).toBe(409)
  }, 60_000)

  it('sets a password from a /web session, then signs in with it; a wrong one is refused', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const headers = { cookie, 'content-type': 'application/json', 'x-argus': '1' }
    const me = (await (await fetch(`${booted.base}/api/me`, { headers: { cookie } })).json()) as Record<string, unknown>
    expect(me).toMatchObject({ userId: booted.admin, role: 'admin', hasPassword: false, mayResetPassword: true })
    const set = await fetch(`${booted.base}/api/password`, { method: 'POST', headers, body: JSON.stringify({ login: 'admin', password: 'a long password' }) })
    expect(set.status).toBe(200)

    const json = { 'content-type': 'application/json', 'x-argus': '1' }
    expect((await fetch(`${booted.base}/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: 'admin', password: 'wrong password' }) })).status).toBe(401)
    const login = await fetch(`${booted.base}/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: 'Admin', password: 'a long password' }) })
    expect(login.status).toBe(204)
    const second = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const again = (await (await fetch(`${booted.base}/api/me`, { headers: { cookie: second } })).json()) as Record<string, unknown>
    expect(again).toMatchObject({ login: 'admin', hasPassword: true, mayResetPassword: false })
  }, 60_000)

  it('runs a command with the user\'s role: an operator is refused an admin command', async () => {
    const booted = await bootWeb()
    booted.store.users.create({ id: 'op-1', role: 'operator' }, Date.now())
    const token = /token=([\w-]+)/.exec(booted.web.loginLink('op-1'))?.[1] ?? ''
    const login = await fetch(`${booted.base}/login?token=${token}`, { redirect: 'manual' })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const run = async (line: string): Promise<{ text: string; error: boolean }> =>
      (await (await fetch(`${booted.base}/api/command`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify({ line }) })).json()) as { text: string; error: boolean }
    expect((await run('/allow')).text).toContain('Only the admin')
    expect((await run('/projects')).text).toContain('alpha')
  }, 60_000)

  it('starts an MCP server\'s sign-in for the admin only, and refuses a callback it did not start', async () => {
    const booted = await bootWeb()
    const start = `${booted.base}/oauth/start/${'k'.repeat(32)}`
    expect((await fetch(start, { redirect: 'manual' })).status).toBe(401)
    booted.store.users.create({ id: 'op-1', role: 'operator' }, Date.now())
    const token = /token=([\w-]+)/.exec(booted.web.loginLink('op-1'))?.[1] ?? ''
    const operator = ((await fetch(`${booted.base}/login?token=${token}`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect((await fetch(start, { redirect: 'manual', headers: { cookie: operator } })).status).toBe(401)
    const admin = await signIn(booted)
    const unknown = await fetch(start, { redirect: 'manual', headers: { cookie: admin } })
    expect(unknown.status).toBe(400)
    expect(await unknown.text()).toContain('This link is not valid')
    // The provider's redirect carries no cookie; an unknown state is refused all the same.
    const forged = await fetch(`${booted.base}/oauth/callback?state=forged&code=x`)
    expect(forged.status).toBe(400)
    expect(await forged.text()).toContain('This sign-in is not known')
  }, 60_000)

  it('is one of the user\'s channels: a notice to the user reaches the web chat', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    await booted.channel.send({ channel: 'user', chatId: booted.admin }, { text: 'budget reached' })
    const entries = ((await (await fetch(`${booted.base}/api/chat`, { headers: { cookie } })).json()) as { entries: Array<{ text: string }> }).entries
    expect(entries.map((entry) => entry.text)).toContain('budget reached')
    expect(((await (await fetch(`${booted.base}/api/chat/unread`, { headers: { cookie } })).json()) as { count: number }).count).toBe(1)
    await fetch(`${booted.base}/api/chat/read`, { method: 'POST', headers: { cookie, 'x-argus': '1' } })
    expect(((await (await fetch(`${booted.base}/api/chat/unread`, { headers: { cookie } })).json()) as { count: number }).count).toBe(0)
  }, 60_000)

  it('/users invites an operator who sets a password; reset and remove sign them out; only the admin sees /api/users', async () => {
    const booted = await bootWeb()
    const admin = await signIn(booted)
    const json = (cookie: string) => ({ cookie, 'content-type': 'application/json', 'x-argus': '1' })
    const run = async (cookie: string, line: string): Promise<{ text: string; error: boolean }> =>
      (await (await fetch(`${booted.base}/api/command`, { method: 'POST', headers: json(cookie), body: JSON.stringify({ line }) })).json()) as { text: string; error: boolean }
    const follow = async (text: string): Promise<string> => {
      const token = /token=([\w-]+)/.exec(text)?.[1] ?? ''
      const login = await fetch(`${booted.base}/login?token=${token}`, { redirect: 'manual' })
      expect(login.status).toBe(303)
      return (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    }
    const me = async (cookie: string): Promise<Response> => fetch(`${booted.base}/api/me`, { headers: { cookie } })

    const invited = await run(admin, '/users invite Ana Pop')
    expect(invited.text).toContain('Ana Pop is an operator')
    const ana = await follow(invited.text)
    expect(await (await me(ana)).json()).toMatchObject({ name: 'Ana Pop', role: 'operator', hasPassword: false })
    expect((await fetch(`${booted.base}/api/password`, { method: 'POST', headers: json(ana), body: JSON.stringify({ login: 'ana', password: 'a long password' }) })).status).toBe(200)
    expect((await fetch(`${booted.base}/api/users`, { headers: { cookie: ana } })).status).toBe(403)
    const users = ((await (await fetch(`${booted.base}/api/users`, { headers: { cookie: admin } })).json()) as { users: Array<{ id: string; name: string | null; login: string | null; role: string }> }).users
    expect(users).toContainEqual(expect.objectContaining({ name: 'Ana Pop', login: 'ana', role: 'operator' }))
    expect((await run(admin, '/users')).text).toContain('Ana Pop  operator')

    const reset = await run(admin, '/users reset ana')
    expect(reset.text).toContain('authenticator code are removed')
    expect((await me(ana)).status).toBe(401)
    const again = await follow(reset.text)
    expect(await (await me(again)).json()).toMatchObject({ hasPassword: false, mayResetPassword: true })

    const id = users.find((user) => user.name === 'Ana Pop')?.id ?? ''
    expect((await run(admin, `/users remove ${id}`)).text).toContain('can no longer use Argus')
    expect((await me(again)).status).toBe(401)
    expect((await run(admin, `/users enable ${id}`)).text).toContain('can use Argus again')
    expect((await run(admin, `/users name ${id} Ana P.`)).text).toContain('is called Ana P. now')
    expect(booted.store.users.get(id)).toMatchObject({ name: 'Ana P.', disabled_at: null })
    expect((await run(admin, `/users reset telegram:42`)).error).toBe(true)
  }, 60_000)

  it('/link connects a channel the user did not have; nothing else from a stranger runs', async () => {
    const booted = await bootWeb()
    const tg = new ConsoleChannelAdapter({ name: 'tg' })
    booted.channel.register(tg)
    booted.store.users.create({ id: 'ana', name: 'Ana', role: 'operator' }, Date.now())
    const token = /token=([\w-]+)/.exec(booted.web.loginLink('ana'))?.[1] ?? ''
    const cookie = ((await fetch(`${booted.base}/login?token=${token}`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const out = (await (await fetch(`${booted.base}/api/command`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify({ line: '/link' }) })).json()) as { text: string }
    const code = /\/link (\w+)/.exec(out.text)?.[1] ?? ''
    expect(code).toMatch(/^[A-Z0-9]{8}$/)

    const say = async (text: string, userId = 'stranger-7'): Promise<string> => {
      const before = tg.sent.length
      await tg.receive({ text, userId, chatId: userId })
      await waitFor(() => tg.sent.length > before, { timeoutMs: 10_000, label: 'a reply' })
      return tg.lastSent?.message.text ?? ''
    }
    // A stranger is refused (no answer, an audit row), except for /link.
    await tg.receive({ text: '/projects', userId: 'stranger-7', chatId: 'stranger-7' })
    await waitFor(() => booted.store.audit.byAction('channel.refused').length > 0, { timeoutMs: 10_000, label: 'refused' })
    expect(tg.sent.filter((sent) => sent.to.chatId === 'stranger-7')).toEqual([])
    expect(await say('/link WRONG123')).toContain('not valid')
    expect(await say(`/link ${code.toLowerCase()}`)).toContain("Connected: this tg account is Ana's")
    expect(booted.store.users.identity('tg', 'stranger-7')?.user_id).toBe('ana')
    expect(await say('/projects')).toContain('alpha')
    // A code works once.
    expect(await say(`/link ${code}`, 'stranger-8')).toContain('not valid')
    // Five wrong codes from one sender lock it out.
    for (let i = 0; i < 4; i++) await say(`/link BAD${i}CODE`, 'stranger-8')
    expect(await say('/link BADXCODE', 'stranger-8')).toContain('Too many wrong codes')
  }, 60_000)

  it('names the person who answered, in the note on the other copies', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    booted.store.users.setName(booted.admin, 'Romeo')
    const tg = new ConsoleChannelAdapter({ name: 'telegram' })
    booted.channel.register(tg)
    const asked = booted.channel.ask({ channel: 'user', chatId: booted.admin }, 'Run it?', [{ value: 'approve', label: 'Approve' }], 60_000, 'approval:n1')
    await waitFor(() => tg.pendingCount > 0, { timeoutMs: 10_000, label: 'asked on telegram' })
    const answer = await fetch(`${booted.base}/api/approvals/n1`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify({ value: 'approve' }) })
    expect(answer.status).toBe(200)
    await asked
    expect(tg.closed).toEqual([{ id: 'approval:n1', note: 'Answered by Romeo on web: Approve' }])
    expect(booted.channel.answeredBy('approval:n1')).toBe(booted.admin)
  }, 60_000)

  it('serves the Projects pages: the list, a project, the templates, and 404 for an unknown one', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const json = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(`${booted.base}${path}`, { headers: { cookie } })).json()) as Record<string, unknown>
    const list = (await json('/api/projects'))['projects'] as Array<Record<string, unknown>>
    expect(list).toEqual([expect.objectContaining({ id: 'alpha', description: 'The test site', monthMicros: 0, lastRun: null, step: null, next: null, pending: 0 })])
    const alpha = await json('/api/projects/alpha')
    expect(alpha).toMatchObject({ id: 'alpha', model: 'fake/fake-model', runs: [], approvals: [], schedules: [] })
    expect(alpha['tools']).toMatchObject({ agents: 'off' })
    // A schedule is the card's next run; an approval makes it wait for you.
    await booted.commands.runCommand('/cron add alpha "0 9 * * *" Send the report', { address: { channel: 'web', chatId: booted.admin }, userId: booted.admin, user: { id: booted.admin, role: 'admin' }, isAdmin: true, now: Date.now() })
    booted.store.approvals.insert({ id: 'ap1', run_id: null, project_id: 'alpha', request_json: JSON.stringify({ action: 'npm test', kind: 'command' }), status: 'pending' }, Date.now())
    const again = ((await json('/api/projects'))['projects'] as Array<{ next: { what: string } | null; pending: number }>)[0]
    expect(again?.next?.what).toBe('Send the report')
    expect(again?.pending).toBe(1)
    expect((await fetch(`${booted.base}/api/projects/nope`, { headers: { cookie } })).status).toBe(404)
    const templates = (await json('/api/templates'))['templates'] as Array<{ name: string; summary: string }>
    expect(templates.map((template) => template.name)).toContain('site')
    expect((await json('/api/me'))['adminOnly']).toEqual(expect.arrayContaining(['users', 'archive', 'set']))
  }, 60_000)

  it('gives a file a command produced (/get) as a download link', async () => {
    const booted = await bootWeb()
    writeFileSync(join(booted.dataDir, 'projects', 'alpha', 'report.md'), '# Report\n')
    const cookie = await signIn(booted)
    const out = (await (await fetch(`${booted.base}/api/command`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' },
      body: JSON.stringify({ line: '/get alpha report.md' }),
    })).json()) as { files?: Array<{ id: string; name: string }> }
    expect(out.files?.map((file) => file.name)).toEqual(['report.md'])
    const download = await fetch(`${booted.base}/api/files/${out.files?.[0]?.id ?? ''}`, { headers: { cookie } })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('# Report\n')
  }, 60_000)

  it('serves Tasks, Schedules and Runs & costs, and /stop stops a task by its run id', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const json = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(`${booted.base}${path}`, { headers: { cookie } })).json()) as Record<string, unknown>
    const run = async (line: string): Promise<{ text: string; error: boolean }> =>
      (await (await fetch(`${booted.base}/api/command`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify({ line }) })).json()) as { text: string; error: boolean }

    expect((await run('/task summarise the news')).error).toBe(false)
    let tasks: Array<{ text: string | null; status: string }> = []
    for (let tries = 0; tries < 100 && tasks[0]?.status !== 'completed'; tries++) {
      tasks = (await json('/api/tasks'))['tasks'] as typeof tasks
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(tasks[0]).toMatchObject({ text: 'summarise the news', who: 'task', running: false })

    const runs = await json('/api/runs')
    expect((runs['scopes'] as Array<{ scope: string }>).map((row) => row.scope)).toEqual(['global', 'adhoc', 'orchestrator', 'project:alpha'])
    expect((runs['runs'] as unknown[]).length).toBeGreaterThan(0)
    expect((runs['log'] as Array<{ action: string }>).length).toBeGreaterThan(0)
    expect(await json('/api/schedules')).toEqual({ schedules: [], triggers: [] })
    expect((await run('/cron add alpha "0 9 * * 1-5" check the build')).error).toBe(false)
    expect((await json('/api/schedules'))['schedules']).toEqual([expect.objectContaining({ cron: '0 9 * * 1-5', projectId: 'alpha', prompt: 'check the build', enabled: true })])
    expect((await run(`/trigger add alpha mail from:comenzi@client.ro subject:'Comanda nouă' every:10 "Process {{mail.id}}"`)).error).toBe(false)
    expect((await json('/api/schedules'))['triggers']).toEqual([
      expect.objectContaining({ projectId: 'alpha', from: ['comenzi@client.ro'], subject: 'Comanda nouă', folder: 'INBOX', every: 10, prompt: 'Process {{mail.id}}', enabled: true, runsThisHour: 0, perHour: 6, error: null }),
    ])
    expect((await run('/trigger add alpha mail "no senders"')).error).toBe(true)
    // A run id that is no running task falls through to a project, and none is that.
    expect((await run('/stop not-a-run')).text).toContain('not running')
  }, 60_000)
})

describe('files through the web', () => {
  const alpha = (booted: Booted, ...path: string[]): string => join(booted.dataDir, 'projects', 'alpha', ...path)
  const put = (booted: Booted, cookie: string, name: string, body: Buffer | string, extra: Record<string, string> = {}) =>
    fetch(`${booted.base}/api/projects/alpha/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie, 'x-argus': '1', 'content-type': 'application/octet-stream', ...extra }, body })

  it('streams an upload into the project\'s inbox, never over a file and never through a link', async () => {
    const booted = await bootWeb({ maxUploadMb: 1 })
    const cookie = await signIn(booted)
    const first = await put(booted, cookie, 'data.csv', 'a,b\n1,2\n')
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ path: 'inbox/data.csv', bytes: 8 })
    expect(readFileSync(alpha(booted, 'inbox', 'data.csv'), 'utf8')).toBe('a,b\n1,2\n')
    expect(await (await put(booted, cookie, '../../evil name?.csv', 'x')).json()).toEqual({ path: 'inbox/evil name_.csv', bytes: 1 })
    expect(await (await put(booted, cookie, 'data.csv', 'second')).json()).toEqual({ path: 'inbox/data (2).csv', bytes: 6 })
    expect((await put(booted, '', 'x.txt', 'x')).status).toBe(401)
    expect((await fetch(`${booted.base}/api/projects/alpha/upload?name=x`, { method: 'POST', headers: { cookie }, body: 'x' })).status).toBe(403)
    expect((await fetch(`${booted.base}/api/projects/nope/upload?name=x`, { method: 'POST', headers: { cookie, 'x-argus': '1' }, body: 'x' })).status).toBe(404)
    // Over the limit: refused before anything is written.
    const big = await put(booted, cookie, 'big.bin', Buffer.alloc(2 * 1024 * 1024))
    expect(big.status).toBe(413)
    expect(readdirSync(alpha(booted, 'inbox')).sort()).toEqual(['data (2).csv', 'data.csv', 'evil name_.csv'])
    // An inbox the agent made a link to the configuration is not written through.
    rmSync(alpha(booted, 'inbox'), { recursive: true })
    symlinkSync(join(booted.dataDir, 'config'), alpha(booted, 'inbox'))
    expect((await put(booted, cookie, 'ops.yaml', 'evil: true')).status).toBe(409)
    expect(existsSync(join(booted.dataDir, 'config', 'ops.yaml'))).toBe(false)
    expect(booted.store.audit.byAction('web.upload')).toHaveLength(3)
  }, 60_000)

  it('zips a project folder confined: skipped folders left out, a link kept a link', async () => {
    const booted = await bootWeb({ sandbox: true })
    const cookie = await signIn(booted)
    mkdirSync(alpha(booted, 'site', 'node_modules', 'x'), { recursive: true })
    writeFileSync(alpha(booted, 'site', 'index.html'), '<html>')
    writeFileSync(alpha(booted, 'site', 'node_modules', 'x', 'big.js'), 'module')
    writeFileSync(join(booted.dataDir, 'secret.txt'), 'THE-SECRET-CONTENT')
    symlinkSync(join(booted.dataDir, 'secret.txt'), alpha(booted, 'site', 'secret.txt'))
    const response = await fetch(`${booted.base}/api/projects/alpha/zip?path=site`, { headers: { cookie } })
    expect(response.status, response.status === 200 ? '' : await response.clone().text()).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('alpha-site.zip')
    const zip = Buffer.from(await response.arrayBuffer())
    const file = join(booted.dataDir, 'out.zip')
    writeFileSync(file, zip)
    const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n').sort()
    expect(names).toEqual(['site/', 'site/index.html', 'site/secret.txt'])
    expect(zip.toString('latin1')).not.toContain('THE-SECRET-CONTENT')
    expect((await fetch(`${booted.base}/api/projects/alpha/zip?path=../..`, { headers: { cookie } })).status).toBe(400)
    expect((await fetch(`${booted.base}/api/projects/alpha/zip?path=nope`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${booted.base}/api/projects/alpha/zip`, {})).status).toBe(401)
  }, 60_000)

  it('gives a file too big for the chat as a link that needs a session, works once and keeps nothing behind', async () => {
    const booted = await bootWeb()
    const cookie = await signIn(booted)
    const small = new ConsoleChannelAdapter({ name: 'console', limits: { maxTextLength: 4096, maxFileBytes: 10 } })
    const unregister = booted.channel.register(small)
    mkdirSync(alpha(booted, 'out'), { recursive: true })
    writeFileSync(alpha(booted, 'out', 'video.mp4'), 'a large video file')
    const said = await booted.channel.sendFile({ kind: 'project', projectId: 'alpha' }, 'out/video.mp4')
    expect(said).toContain('the person got a download link to it instead')
    // The link names web.public_url, whose port here is the configured 0.
    const local = (text: string | undefined): string => `${booted.base}${/\/f\/[\w-]+/.exec(text ?? '')?.[0] ?? '/none'}`
    const link = local(small.sent.at(-1)?.message.text)
    expect(link).not.toContain('/none')
    // Signed out: refused, and the link is not used up.
    expect((await fetch(link)).status).toBe(401)
    const got = await fetch(link, { headers: { cookie } })
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('a large video file')
    expect((await fetch(link, { headers: { cookie } })).status).toBe(404)

    // A zip made for the link is the web's, and goes once it is taken.
    writeFileSync(alpha(booted, 'out', 'b.txt'), 'more than ten bytes here')
    await booted.channel.sendFile({ kind: 'project', projectId: 'alpha' }, ['out'])
    const zipLink = local(small.sent.at(-1)?.message.text)
    const downloads = join(booted.dataDir, 'state', 'web-downloads')
    expect(readdirSync(downloads)).toHaveLength(1)
    expect((await fetch(zipLink, { headers: { cookie } })).status).toBe(200)
    await waitFor(() => readdirSync(downloads).length === 0, { timeoutMs: 5_000, label: 'the zip is removed' })
    unregister()
  }, 60_000)
})
