// == ARGUS AGENT PROJECT ==
/**
 * The providers row in a real composition: pi-ai mounted with a route per
 * provider, `ctx.opsProviders` published, and a project whose provider has no key
 * marked invalid by `ops-projects` — with the rest of the system up.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootOps, BASE_ENTRIES, OPTIONAL_ENTRIES, persistenceEntry, type OpsBoot } from '@argus-agent/testkit'
import type { OpsProviders } from '../../src/providers-row.js'

const boots: OpsBoot[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const boot of boots.splice(0)) await boot.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env['ZAI_API_KEY']
})

describe('the providers row', () => {
  it('routes every catalog and declared provider, and invalidates a keyless project', async () => {
    process.env['ZAI_API_KEY'] = 'test-key'
    const dataDir = mkdtempSync(join(tmpdir(), 'argus-providers-'))
    dirs.push(dataDir)
    for (const id of ['keyed', 'keyless']) mkdirSync(join(dataDir, 'projects', id), { recursive: true })
    mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
    const project = (id: string, provider: string, model: string) =>
      writeFileSync(
        join(dataDir, 'config', 'projects', `${id}.yaml`),
        `id: ${id}\ncwd: ${JSON.stringify(join(dataDir, 'projects', id))}\nprovider: ${provider}\nmodel: ${model}\n`,
      )
    project('keyed', 'zai', 'glm-5.3-flash')
    project('keyless', 'groq', 'llama-3.3-70b-versatile')
    project('stored', 'deepseek', 'deepseek-flash')
    // A key saved in dsh's credentials store counts as much as one in the environment.
    const credentials = join(dataDir, '.credentials.yaml')
    writeFileSync(credentials, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: stored-key\n', { mode: 0o600 })

    const boot = await bootOps({
      dataDir,
      bareModuleBaseUrl: import.meta.url,
      fake: false,
      files: {
        'config/ops.yaml':
          `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
          `providers:\n  deepinfra:\n    base_url: https://api.deepinfra.com/v1/openai\n    models: [deepseek-ai/DeepSeek-V4-Flash]\n`,
      },
      replaceEntries: [
        ...BASE_ENTRIES,
        persistenceEntry(join(dataDir, 'sessions')),
        { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local', config: { path: credentials, watch: false } },
        OPTIONAL_ENTRIES.agentPresets,
        { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
        { id: 'ops-providers', name: '@argus-agent/argus-agent/providers-row' },
        { id: 'ops-store', name: '@argus-agent/store' },
        { id: 'ops-projects', name: '@argus-agent/projects' },
        { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
      ],
    })
    boots.push(boot)
    const ctx = boot.ctx as unknown as {
      llm: { listProviders(): unknown[] }
      opsProviders: OpsProviders
      opsProjects: { configuredIds(): string[]; invalidOf(id: string): { reason: string } | undefined }
    }

    const routes = JSON.stringify(ctx.llm.listProviders())
    for (const provider of ['zai', 'openrouter', 'anthropic', 'deepseek', 'deepinfra']) expect(routes).toContain(`"${provider}"`)
    expect(routes).not.toContain('"amazon-bedrock"')

    expect(ctx.opsProjects.configuredIds().sort()).toEqual(['keyed', 'stored'])
    expect(ctx.opsProjects.invalidOf('keyless')?.reason).toBe(
      'model: groq/llama-3.3-70b-versatile needs an API key: send /key groq <key>',
    )
    expect(ctx.opsProviders.keyStatus().find((entry) => entry.provider === 'deepseek')).toMatchObject({ configured: true, writable: true })
    expect(ctx.opsProviders.keyStatus().find((entry) => entry.provider === 'zai')).toMatchObject({ configured: true, writable: false })
  }, 60_000)
})
