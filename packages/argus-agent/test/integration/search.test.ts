// == ARGUS AGENT PROJECT ==
/**
 * The search row in a real composition: dsh's `web` service pinned to `argus`, a search
 * from inside a project's agent answered by the backend ops.yaml names (a local
 * SearXNG here) and charged its price to that project; a backend without its key
 * fails clearly, and `argus doctor` says what to do.
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootOps, BASE_ENTRIES, OPTIONAL_ENTRIES, persistenceEntry, userMessage, type OpsBoot } from '@argus-agent/testkit'
import type { OpsWebSearch } from '../../src/search-row.js'

const boots: OpsBoot[] = []
const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const boot of boots.splice(0)) await boot.dispose()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A SearXNG stand-in on a free port; records the queries it gets. */
async function fakeSearxng(): Promise<{ url: string; queries: string[] }> {
  const queries: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    queries.push(`${url.pathname}?${url.searchParams.toString()}`)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ results: [{ title: 'Argus', url: 'https://a.example/argus', content: 'An agent system' }, { url: 'https://a.example/2' }] }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries }
}

async function boot(webSearch: string, script: unknown[] = [{ text: 'done' }]): Promise<OpsBoot> {
  const dataDir = mkdtempSync(join(tmpdir(), 'argus-search-'))
  dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects', 'site'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
  writeFileSync(join(dataDir, 'config', 'projects', 'site.yaml'), `id: site\ncwd: ${JSON.stringify(join(dataDir, 'projects', 'site'))}\nprovider: fake\nmodel: fake-model\n`)
  const credentials = join(dataDir, '.credentials.yaml')
  writeFileSync(credentials, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const booted = await bootOps({
    dataDir,
    bareModuleBaseUrl: import.meta.url,
    fake: { script: script as never, repeatLast: true },
    files: { 'config/ops.yaml': `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\npricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n${webSearch}\n` },
    replaceEntries: [
      ...BASE_ENTRIES,
      persistenceEntry(join(dataDir, 'sessions')),
      { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local', config: { path: credentials, watch: false } },
      OPTIONAL_ENTRIES.agentPresets,
      { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'argus' } },
      { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
      { id: 'ops-web-search', name: '@argus-agent/argus-agent/search-row' },
      { id: 'ops-store', name: '@argus-agent/store' },
      { id: 'ops-projects', name: '@argus-agent/projects' },
      { id: 'ops-meter', name: '@argus-agent/meter' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
    ],
  })
  boots.push(booted)
  return booted
}

type Ctx = {
  web: { search(request: { query: string; maxResults?: number }): Promise<{ sources: Array<{ url: string }> }> }
  opsWebSearch: OpsWebSearch
  opsProjects: { ensureAgent(id: string): Promise<{ ctx: { tools: { register(tool: unknown): unknown } }; followup(message: unknown): void; whenIdle(): Promise<void> }> }
  opsMeter: { flush(): Promise<void> }
  opsStore: { usage: { eventsBetween(from: number, to: number): Array<{ provider: string; scope: string; model: string; cost_micros: number }> } }
}

describe('the search row', () => {
  it('answers a project agent\'s search through SearXNG and charges the project its price', async () => {
    const searxng = await fakeSearxng()
    const booted = await boot(
      `web_search:\n  provider: searxng\n  searxng_url: ${searxng.url}\n  price_usd: 0.002`,
      [{ text: 'searching', toolCalls: [{ name: 'probe_search', arguments: '{"query":"argus agent"}' }] }, { text: 'done' }],
    )
    const ctx = booted.ctx as unknown as Ctx
    expect(ctx.opsWebSearch.status()).toEqual({ provider: 'searxng', ready: true, priceMicros: 2_000 })

    const agent = await ctx.opsProjects.ensureAgent('site')
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    let found = ''
    agent.ctx.tools.register(
      defineTool({
        name: 'probe_search',
        description: 'search',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
        execute: async (args: { query: string }) => {
          found = JSON.stringify(await ctx.web.search({ query: args.query, maxResults: 1 }))
          return found
        },
      } as never),
    )
    agent.followup(userMessage('m-1', 'search'))
    await agent.whenIdle()

    expect(searxng.queries).toEqual(['/search?q=argus+agent&format=json'])
    // dsh's seam keeps the caller's bound.
    expect(JSON.parse(found)).toMatchObject({ sources: [{ url: 'https://a.example/argus', title: 'Argus' }], truncated: true })
    // Charged to the project, as `searxng/search`, at the configured price.
    await ctx.opsMeter.flush()
    const rows = ctx.opsStore.usage.eventsBetween(0, Number.MAX_SAFE_INTEGER).filter((row) => row.provider === 'searxng')
    expect(rows).toMatchObject([{ scope: 'project:site', model: 'search', cost_micros: 2_000 }])
  }, 60_000)

  it('fails clearly without the chosen provider\'s key, and doctor says how to fix it', async () => {
    const ctx = (await boot('web_search:\n  provider: tavily')).ctx as unknown as Ctx
    expect(ctx.opsWebSearch.status()).toMatchObject({ provider: 'tavily', ready: false, fix: 'send /key tavily <key>', priceMicros: 8_000 })
    const error = await ctx.web.search({ query: 'q' }).catch((caught: unknown) => caught as { code: string })
    expect(error.code).toBe('WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    expect(ctx.opsWebSearch.doctor()).toEqual([{ ok: false, check: 'web search: tavily', detail: 'it cannot search: every web_search fails', fix: 'send /key tavily <key>' }])
  }, 60_000)

  it('stays on DeepSeek when ops.yaml names no provider', async () => {
    const ctx = (await boot('')).ctx as unknown as Ctx
    expect(ctx.opsWebSearch.status()).toEqual({ provider: 'deepseek', ready: false, fix: 'send /key deepseek <key>' })
  }, 60_000)
})
