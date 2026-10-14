// == ARGUS AGENT PROJECT ==
/**
 * The web interface in a real composition: a `/web` link signs in, a password set
 * from it signs in too, the API answers with a session and refuses without one,
 * commands run with the user's role, the chat is one of the user's channels, and a
 * question another channel asked can be answered from the web.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BASE_ENTRIES, ConsoleChannelAdapter, bootOps, persistenceEntry, waitFor, type OpsBoot } from '@argus-agent/testkit'
import type { OpsChannel } from '@argus-agent/channel'
import type { OpsCommands } from '@argus-agent/commands'
import type { OpsStore } from '@argus-agent/store'
import type { OpsWeb } from '@argus-agent/web'

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

async function bootWeb(options: { noAdmin?: boolean } = {}): Promise<Booted> {
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
        `web:\n  port: 0\n`,
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
    expect(reset.text).toContain('password is removed')
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
    expect(list).toEqual([expect.objectContaining({ id: 'alpha', description: 'The test site', monthMicros: 0 })])
    const alpha = await json('/api/projects/alpha')
    expect(alpha).toMatchObject({ id: 'alpha', model: 'fake/fake-model', runs: [], approvals: [], schedules: [] })
    expect(alpha['tools']).toMatchObject({ agents: 'off' })
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
    expect(await json('/api/schedules')).toEqual({ schedules: [] })
    expect((await run('/cron add alpha "0 9 * * 1-5" check the build')).error).toBe(false)
    expect((await json('/api/schedules'))['schedules']).toEqual([expect.objectContaining({ cron: '0 9 * * 1-5', projectId: 'alpha', prompt: 'check the build', enabled: true })])
    // A run id that is no running task falls through to a project, and none is that.
    expect((await run('/stop not-a-run')).text).toContain('not running')
  }, 60_000)
})
