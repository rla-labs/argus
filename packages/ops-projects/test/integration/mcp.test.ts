// == ARGUS AGENT PROJECT ==
/**
 * A project's MCP servers: mounted in its agent's scope, with `${NAME}` filled from
 * the credentials, and left out (not fatal) when a secret is missing. A local server runs
 * confined, with a home of its own that the agent's shell cannot read, or not at all.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ArgusSandbox from '@argus-agent/argus-agent/sandbox-row'
import { afterEach, describe, expect, it } from 'vitest'
import { bootProjects } from '../helpers.js'

const fixture = fileURLToPath(new URL('../fixtures/echo-mcp.mjs', import.meta.url))
const SANDBOX = [{ id: 'sandbox', name: '@argus-agent/argus-agent/sandbox-row' }]
const landlock = new ArgusSandbox(new Context()).doctor()[0]?.ok === true
const made: string[] = []

/**
 * A data folder whose projects each hold the echo server: a confined server reads only
 * the system and its project's folder, so the program must be there.
 */
function dataWithEcho(...ids: string[]): { dataDir: string; echo: (id: string) => { command: string; args: string[]; env: Record<string, string> } } {
  const dataDir = mkdtempSync(join(tmpdir(), 'ops-projects-mcp-'))
  made.push(dataDir)
  for (const id of ids) {
    mkdirSync(join(dataDir, 'projects', id), { recursive: true })
    copyFileSync(fixture, join(dataDir, 'projects', id, 'echo-mcp.mjs'))
  }
  return { dataDir, echo: (id) => ({ command: process.execPath, args: [join(dataDir, 'projects', id, 'echo-mcp.mjs')], env: { ECHO_SECRET: '${ECHO_SECRET}' } }) }
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env['ECHO_SECRET']
  delete process.env['ARGUS_GIT_0123ABCD']
  delete process.env['ARGUS_MAIL_DEFAULT']
  delete process.env['ARGUS_OAUTH_0123ABCD']
})

/** The tool an agent sees under a name, through the scope-aware lookup. */
async function toolOf(agent: unknown, name: string): Promise<{ execute(args: unknown, exec: unknown): Promise<unknown> } | undefined> {
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  const ctx = (agent as { ctx: { tools: { get(name: string, scope: unknown): unknown } } }).ctx
  return ctx.tools.get(name, scopeOf(ctx as never)) as never
}

const call = async (tool: { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined, args: unknown): Promise<string> =>
  JSON.stringify(await tool?.execute(args, { signal: new AbortController().signal }))

describe.skipIf(!landlock)('MCP servers', () => {
  it('gives a project its servers’ tools, with the secret filled in, and no one else', async () => {
    process.env['ECHO_SECRET'] = 'from-the-env'
    const { dataDir, echo } = dataWithEcho('site')
    const { projects } = await bootProjects({ dataDir, projects: { site: { mcp: { echo: echo('site') } }, other: {} }, entries: SANDBOX })
    const tool = await toolOf(await projects.ensureAgent('site'), 'mcp__echo__echo')
    expect(tool).toBeDefined()
    expect(await call(tool, { text: 'hi' })).toContain('hi (from-the-env)')
    expect(await toolOf(await projects.ensureAgent('other'), 'mcp__echo__echo')).toBeUndefined()
  }, 60_000)

  it('runs a local server confined, with a home of its own the agent’s shell cannot read', async () => {
    process.env['ECHO_SECRET'] = 'x'
    const { dataDir, echo } = dataWithEcho('site', 'other')
    const { projects } = await bootProjects({ dataDir, projects: { site: { mcp: { echo: echo('site') } }, other: { mcp: { echo: echo('other') } } }, entries: SANDBOX })
    const home = projects.mcpHomeOf('site', 'echo')
    const out = await call(await toolOf(await projects.ensureAgent('site'), 'mcp__echo__home'), {})
    expect(out).toContain(`home: ${home}; config: ${home}/.config`)
    expect(readFileSync(join(home, 'token'), 'utf8')).toBe('TOKEN-IN-HOME')
    expect(home.startsWith(projects.configOf('site')!.cwd)).toBe(false)

    // The agent's shell, confined to the project's folder as dsh's bash is.
    const sandbox = new ArgusSandbox(new Context())
    const { argv } = await sandbox.confineReading(['sh', '-c', `cat ${home}/token; ls ${home}; ln -s ${home}/token leak; cat leak`], { mode: 'workspace-write', workspaceRoot: projects.configOf('site')!.cwd }, [])
    const shell = spawnSync(argv[0]!, argv.slice(1), { cwd: projects.configOf('site')!.cwd, encoding: 'utf8' })
    expect(`${shell.stdout}${shell.stderr}`).not.toContain('TOKEN-IN-HOME')
    expect(shell.stderr).toMatch(/Permission denied/)

    // Another project's server keeps its own home, and cannot read this one.
    await call(await toolOf(await projects.ensureAgent('other'), 'mcp__echo__home'), {})
    expect(existsSync(join(projects.mcpHomeOf('other', 'echo'), 'token'))).toBe(true)
    expect(projects.mcpHomeOf('other', 'echo')).not.toBe(home)
  }, 60_000)

  it('empties a server’s home on reset, and starts it afresh at the next message', async () => {
    process.env['ECHO_SECRET'] = 'x'
    const { dataDir, echo } = dataWithEcho('site')
    const { projects } = await bootProjects({ dataDir, projects: { site: { mcp: { echo: echo('site') } } }, entries: SANDBOX })
    await call(await toolOf(await projects.ensureAgent('site'), 'mcp__echo__home'), {})
    const token = join(projects.mcpHomeOf('site', 'echo'), 'token')
    expect(existsSync(token)).toBe(true)
    expect(await projects.resetMcpHome('site', 'echo')).toBe('reset')
    expect(existsSync(token)).toBe(false)
    expect(await call(await toolOf(await projects.ensureAgent('site'), 'mcp__echo__echo'), { text: 'again' })).toContain('again (x)')
  }, 60_000)

  it('leaves out a server whose secret is not set, and the project still runs', async () => {
    const { dataDir, echo } = dataWithEcho('site')
    const { projects } = await bootProjects({ dataDir, projects: { site: { mcp: { echo: echo('site') } } }, entries: SANDBOX })
    expect(await toolOf(await projects.ensureAgent('site'), 'mcp__echo__echo')).toBeUndefined()
  }, 60_000)

  it('never hands a server a git token, even one the environment holds', async () => {
    process.env['ARGUS_GIT_0123ABCD'] = 'ghp_secret'
    const { dataDir, echo } = dataWithEcho('site')
    const { projects } = await bootProjects({ dataDir, projects: { site: { mcp: { echo: { ...echo('site'), env: { ECHO_SECRET: '${ARGUS_GIT_0123ABCD}' } } } } }, entries: SANDBOX })
    expect(await toolOf(await projects.ensureAgent('site'), 'mcp__echo__echo')).toBeUndefined()
  }, 60_000)

  it('never hands a server an OAuth grant, even one the environment holds', async () => {
    process.env['ARGUS_OAUTH_0123ABCD'] = '{"tokens":{}}'
    const { dataDir, echo } = dataWithEcho('site')
    const { projects } = await bootProjects({ dataDir, projects: { site: { mcp: { echo: { ...echo('site'), env: { ECHO_SECRET: '${ARGUS_OAUTH_0123ABCD}' } } } } }, entries: SANDBOX })
    expect(await toolOf(await projects.ensureAgent('site'), 'mcp__echo__echo')).toBeUndefined()
  }, 60_000)

  it('never hands a server a mail account, even one the environment holds', async () => {
    process.env['ARGUS_MAIL_DEFAULT'] = 'smtps://u:secret@mail.example.com'
    const { dataDir, echo } = dataWithEcho('site')
    const { projects } = await bootProjects({ dataDir, projects: { site: { mcp: { echo: { ...echo('site'), env: { ECHO_SECRET: '${ARGUS_MAIL_DEFAULT}' } } } } }, entries: SANDBOX })
    expect(await toolOf(await projects.ensureAgent('site'), 'mcp__echo__echo')).toBeUndefined()
  }, 60_000)
})

describe('MCP servers without the sandbox', () => {
  it('leaves a local server out, and the project still runs', async () => {
    process.env['ECHO_SECRET'] = 'x'
    const { dataDir, echo } = dataWithEcho('site')
    const { projects } = await bootProjects({ dataDir, projects: { site: { mcp: { echo: echo('site') } } } })
    expect(await toolOf(await projects.ensureAgent('site'), 'mcp__echo__echo')).toBeUndefined()
  }, 60_000)
})
