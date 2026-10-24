// == ARGUS AGENT PROJECT ==
/**
 * A local web interface with sample projects, for looking at the page in a browser.
 * Not part of the suite: `pnpm exec tsx test/manual/serve.ts`, then open the printed link.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_ENTRIES, bootOps, persistenceEntry } from '@argus-agent/testkit'
import type { OpsCommands } from '@argus-agent/commands'
import type { OpsStore } from '@argus-agent/store'
import type { OpsWeb } from '@argus-agent/web'
import { Extensions } from '@argus-agent/projects'

const dataDir = mkdtempSync(join(tmpdir(), 'ops-web-manual-'))
mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
for (const [id, description] of [['site-firma', 'The company website'], ['news', 'AI news digests'], ['romeo', 'A futuristic UI'], ['research', 'Background research']]) {
  mkdirSync(join(dataDir, 'projects', id as string), { recursive: true })
  writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `id: ${id}\ncwd: ${JSON.stringify(join(dataDir, 'projects', id as string))}\nprovider: fake\nmodel: fake-model\ndescription: ${description}\n`)
}
// Sending without asking, for the project page's Mail section.
writeFileSync(join(dataDir, 'config', 'projects', 'site-firma.yaml'), `${readFileSync(join(dataDir, 'config', 'projects', 'site-firma.yaml'), 'utf8')}mail:\n  trusted_recipients: { ana@firma.ro: 5, office@firma.ro: 2 }\n`)
// An installed extension, for the project page's Extensions section.
const repo = mkdtempSync(join(tmpdir(), 'ops-web-manual-ext-'))
writeFileSync(join(repo, 'extension.yaml'), 'name: notes\nversion: 1.0.0\nsummary: Note-taking tools\nmcp:\n  notes: {command: node, args: ["${EXTENSION_DIR}/server.js"], access: ask}\n')
const git = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' }
for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'x']]) execFileSync('git', args, { cwd: repo, env: git })
const extensions = new Extensions(join(dataDir, 'extensions'), async (argv) => argv)
await extensions.install((await extensions.fetch(repo, null)).id, 'admin')

const boot = await bootOps({
  dataDir,
  bareModuleBaseUrl: import.meta.url,
  fake: { script: [{ text: 'Done: the site builds and 14 tests pass.', usage: { inputTokens: 5000, outputTokens: 800 } }] as never, repeatLast: true },
  files: {
    'config/ops.yaml':
      `timezone: Europe/Bucharest\ndata_dir: ${JSON.stringify(dataDir)}\ntasks:\n  model: fake/fake-model\n` +
      `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\nbudgets:\n  default_day_usd: 3\n  global_day_usd: 5\n` +
      // SETUP=1: no admin, to try the setup link.
      (process.env['SETUP'] === '1' ? '' : `access:\n  allowed_users:\n    - { channel: telegram, userId: '42' }\n  admin: telegram:42\n`) +
      `web:\n  port: ${process.env['PORT'] ?? '3099'}\n  public_url: http://127.0.0.1:${process.env['PORT'] ?? '3099'}\n` +
      // PUBLIC=1: public mode, to try the authenticator code (127.0.0.1 counts as secure).
      (process.env['PUBLIC'] === '1' ? '  public: true\n' : ''),
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
    { id: 'ops-scheduler', name: '@argus-agent/scheduler' },
    { id: 'ops-web', name: '@argus-agent/web' },
    { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
  ],
})
const ctx = boot.ctx as unknown as { opsCommands: OpsCommands; opsWeb: OpsWeb; opsStore: OpsStore }
const user = { id: ctx.opsStore.users.admin()?.id ?? '', role: 'admin' as const }
// A pending approval whose rule can be named, for the Approvals page's Always allow.
ctx.opsStore.approvals.insert({ id: 'manual-1', run_id: null, project_id: 'site-firma', request_json: JSON.stringify({ toolName: 'bash', action: 'npm run build', kind: 'command', always: { key: 'approvals.auto_allow', entry: 'npm run build' } }), status: 'pending' }, Date.now())
// Mail it sent, and its outbox: one sent after a person approved it, one waiting.
ctx.opsStore.audit.record({ actor: 'site-firma', action: 'mail.send', target: 'site-firma', details: { ok: true, path: 'unasked', addresses: ['ana@firma.ro'] } }, Date.now() - 3_600_000)
const sent = ctx.opsStore.mailOutbox.insert({ project_id: 'site-firma', run_id: null, recipients: 2, digest: 'x', why: 'client@acme.ro is not trusted' }, Date.now() - 7_200_000)
ctx.opsStore.mailOutbox.decide(sent, 'sent', null, null, Date.now() - 7_000_000)
ctx.opsStore.mailOutbox.insert({ project_id: 'site-firma', run_id: null, recipients: 1, digest: 'y', why: null }, Date.now() - 600_000)
const link = async (): Promise<void> => {
  const out = await ctx.opsCommands.runCommand('/web', { address: { channel: 'telegram', chatId: '42' }, userId: '42', user, isAdmin: true, now: Date.now() })
  console.log(out.text)
}
if (process.env['SETUP'] === '1') console.log(readFileSync(join(dataDir, 'state', 'setup-link'), 'utf8'))
else {
  // LINKS=n prints n links: one each for a few browsers (a headless screenshot uses one).
  for (let i = 0; i < Number(process.env['LINKS'] ?? '1'); i++) await link()
  setInterval(() => void link(), 9 * 60_000)
}
