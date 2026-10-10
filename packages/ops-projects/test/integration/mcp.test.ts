// == ARGUS AGENT PROJECT ==
/**
 * A project's MCP servers: mounted in its agent's scope, with `${NAME}` filled from
 * the credentials, and left out (not fatal) when a secret is missing.
 */
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bootProjects } from '../helpers.js'

const server = fileURLToPath(new URL('../fixtures/echo-mcp.mjs', import.meta.url))
const echo = { command: process.execPath, args: [server], env: { ECHO_SECRET: '${ECHO_SECRET}' } }

afterEach(() => {
  delete process.env['ECHO_SECRET']
})

/** The tool an agent sees under a name, through the scope-aware lookup. */
async function toolOf(agent: unknown, name: string): Promise<{ execute(args: unknown, exec: unknown): Promise<unknown> } | undefined> {
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  const ctx = (agent as { ctx: { tools: { get(name: string, scope: unknown): unknown } } }).ctx
  return ctx.tools.get(name, scopeOf(ctx as never)) as never
}

describe('MCP servers', () => {
  it('gives a project its servers’ tools, with the secret filled in, and no one else', async () => {
    process.env['ECHO_SECRET'] = 'from-the-env'
    const { projects } = await bootProjects({ projects: { site: { mcp: { echo } }, other: {} } })
    const tool = await toolOf(await projects.ensureAgent('site'), 'mcp__echo__echo')
    expect(tool).toBeDefined()
    const out = (await tool?.execute({ text: 'hi' }, { signal: new AbortController().signal })) as { content: Array<{ text: string }> }
    expect(JSON.stringify(out)).toContain('hi (from-the-env)')
    expect(await toolOf(await projects.ensureAgent('other'), 'mcp__echo__echo')).toBeUndefined()
  }, 60_000)

  it('leaves out a server whose secret is not set, and the project still runs', async () => {
    const { projects } = await bootProjects({ projects: { site: { mcp: { echo } } } })
    const agent = await projects.ensureAgent('site')
    expect(await toolOf(agent, 'mcp__echo__echo')).toBeUndefined()
  }, 60_000)
})
