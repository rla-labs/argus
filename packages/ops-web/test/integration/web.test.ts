// == ARGUS AGENT PROJECT ==
/**
 * The web interface in a real composition: a `/web` link signs in, the API answers
 * with a session and refuses without one, the chat is a channel, and a question
 * another channel asked can be answered from the web.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BASE_ENTRIES, ConsoleChannelAdapter, bootOps, persistenceEntry, waitFor, type OpsBoot } from '@argus-agent/testkit'
import type { OpsChannel } from '@argus-agent/channel'
import type { OpsCommands } from '@argus-agent/commands'
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
}

async function bootWeb(): Promise<Booted> {
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
        // The web's users are Telegram's; no Telegram adapter is needed for that.
        `access:\n  allowed_users:\n    - { channel: telegram, userId: '42' }\n    - { channel: console, userId: user-1 }\n  admin: telegram:42\n` +
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
      { id: 'ops-web', name: '@argus-agent/web' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
    ],
  })
  boots.push(boot)
  const ctx = boot.ctx as unknown as { opsChannel: OpsChannel; opsCommands: OpsCommands; opsWeb: OpsWeb }
  await waitFor(() => ctx.opsWeb?.port !== undefined, { timeoutMs: 10_000, label: 'web listening' })
  return { boot, base: `http://127.0.0.1:${ctx.opsWeb.port}`, channel: ctx.opsChannel, commands: ctx.opsCommands, web: ctx.opsWeb }
}

/** Sign in as Telegram user 42 through `/web`, returning the cookie. */
async function signIn(booted: Booted): Promise<string> {
  const out = await booted.commands.runCommand('/web', { address: { channel: 'telegram', chatId: '42' }, userId: '42', isAdmin: true, now: Date.now() })
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
    expect(booted.channel.answeredBy('approval:a1')).toBe('42')
    const again = await fetch(`${booted.base}/api/approvals/a1`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-argus': '1' },
      body: JSON.stringify({ value: 'approve' }),
    })
    expect(again.status).toBe(409)
  }, 60_000)
})
