// == ARGUS AGENT PROJECT ==
/**
 * A local web interface with sample projects, for looking at the page in a browser.
 * Not part of the suite: `pnpm exec tsx test/manual/serve.ts`, then open the printed link.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_ENTRIES, bootOps, persistenceEntry } from '@argus-agent/testkit'
import type { OpsCommands } from '@argus-agent/commands'
import type { OpsWeb } from '@argus-agent/web'

const dataDir = mkdtempSync(join(tmpdir(), 'ops-web-manual-'))
mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
for (const [id, description] of [['site-firma', 'The company website'], ['news', 'AI news digests'], ['romeo', 'A futuristic UI'], ['research', 'Background research']]) {
  mkdirSync(join(dataDir, 'projects', id as string), { recursive: true })
  writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `id: ${id}\ncwd: ${JSON.stringify(join(dataDir, 'projects', id as string))}\nprovider: fake\nmodel: fake-model\ndescription: ${description}\n`)
}
const boot = await bootOps({
  dataDir,
  bareModuleBaseUrl: import.meta.url,
  fake: { script: [{ text: 'Done: the site builds and 14 tests pass.', usage: { inputTokens: 5000, outputTokens: 800 } }] as never, repeatLast: true },
  files: {
    'config/ops.yaml':
      `timezone: Europe/Bucharest\ndata_dir: ${JSON.stringify(dataDir)}\ntasks:\n  model: fake/fake-model\n` +
      `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\nbudgets:\n  default_day_usd: 3\n  global_day_usd: 5\n` +
      `access:\n  allowed_users:\n    - { channel: telegram, userId: '42' }\n  admin: telegram:42\n` +
      `web:\n  port: ${process.env['PORT'] ?? '3099'}\n  public_url: http://127.0.0.1:${process.env['PORT'] ?? '3099'}\n`,
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
    { id: 'ops-memory', name: '@argus-agent/memory' },
    { id: 'ops-web', name: '@argus-agent/web' },
    { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
  ],
})
const ctx = boot.ctx as unknown as { opsCommands: OpsCommands; opsWeb: OpsWeb }
const out = await ctx.opsCommands.runCommand('/web', { address: { channel: 'telegram', chatId: '42' }, userId: '42', isAdmin: true, now: Date.now() })
console.log(out.text)
setInterval(async () => {
  const fresh = await ctx.opsCommands.runCommand('/web', { address: { channel: 'telegram', chatId: '42' }, userId: '42', isAdmin: true, now: Date.now() })
  console.log(fresh.text)
}, 9 * 60_000)
