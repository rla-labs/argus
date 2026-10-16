// == ARGUS AGENT PROJECT ==
/**
 * How often each built-in template asks: a day's typical tool calls for each kind of
 * project, through the real gate and allowlist. What asks is listed, so a change that
 * makes a template ask more (or less) shows here as a diff.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BASE_ENTRIES, OPTIONAL_ENTRIES, bootOps, persistenceEntry, type OpsBoot } from '@argus-agent/testkit'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsApprovalsBridge } from '../../src/service.js'
import { argumentsOf } from '@argus-agent/governor'
import { matchAllowList } from '../../src/argv.js'

type Call = readonly [tool: string, args: Record<string, unknown>]
const bash = (command: string): Call => ['bash', { command }]

/** A day's work of each kind, as the agent's tool calls. */
const DAYS: Record<string, readonly Call[]> = {
  site: [
    ['read', { path: 'package.json' }], ['glob', { pattern: 'src/**/*.css' }], ['grep', { pattern: 'title', path: 'src' }],
    ['edit', { path: 'src/index.html' }], ['write', { path: 'src/about.html' }],
    bash('ls -la'), bash('cat package.json'), bash('npm install'), bash('npm run build'), bash('npm test'),
    bash('git status'), bash('git add -A'), bash('git commit -m "About page"'), bash('git diff HEAD~1'),
    bash('node scripts/check-links.mjs'), bash('find . -name "*.html"'),
    ['web_fetch', { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/grid' }],
  ],
  research: [
    ['web_search', { query: 'EU AI Act obligations 2026' }],
    ['web_fetch', { url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj' }], ['web_fetch', { url: 'https://artificialintelligenceact.eu/' }],
    ['write', { path: 'notes/ai-act.md' }], ['read', { path: 'notes/ai-act.md' }], ['edit', { path: 'notes/ai-act.md' }],
    bash('ls notes'), bash('grep -rn "Article 50" notes'), bash('python3 summarise.py'),
  ],
  reports: [
    ['read', { path: 'reports/2026-10-15-traffic.md' }], ['web_search', { query: 'site traffic' }], ['web_fetch', { url: 'https://plausible.io/api/v1/stats' }],
    bash('ls reports'), bash('date +%F'), bash('tail -n 40 reports/2026-10-15-traffic.md'),
    bash('node fetch-stats.mjs'), bash('python3 chart.py'),
    ['write', { path: 'reports/2026-10-16-traffic.md' }],
  ],
  devops: [
    bash('uptime'), bash('df -h'), bash('free -m'), bash('ps aux'), bash('top -b -n 1'),
    bash('systemctl status nginx'), bash('journalctl -u nginx -n 100'),
    bash('docker ps'), bash('docker logs web --tail 100'), bash('docker stats --no-stream'), bash('ping -c 3 example.com'),
    bash('ss'), bash('ip addr'),
    bash('systemctl restart nginx'), bash('apt list --upgradable'),
    ['read', { path: 'notes.md' }], ['write', { path: 'notes.md' }],
  ],
}

const dirs: string[] = []
const open: OpsBoot[] = []
afterEach(async () => {
  for (const boot of open.splice(0)) await boot.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the built-in templates', () => {
  it('ask only for what a person should see', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-template-asks-'))
    dirs.push(dataDir)
    mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
    for (const name of Object.keys(DAYS)) {
      mkdirSync(join(dataDir, 'projects', name), { recursive: true })
      writeFileSync(join(dataDir, 'config', 'projects', `${name}.yaml`), `id: ${name}\ncwd: ${join(dataDir, 'projects', name)}\ntemplate: ${name}\nprovider: fake\nmodel: fake-model\n`)
    }
    const boot = await bootOps({
      files: { 'config/ops.yaml': `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\npricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\nchannel:\n  default_address: console:dev\n` },
      bareModuleBaseUrl: import.meta.url,
      fake: { script: [{ text: 'ok' }] as never, repeatLast: true },
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
        OPTIONAL_ENTRIES.approval,
        { id: 'ops-approvals-bridge', name: '@argus-agent/approvals-bridge' },
        { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
      ],
    })
    open.push(boot)
    const projects = (boot.ctx as unknown as { opsProjects: OpsProjects }).opsProjects
    const bridge = (boot.ctx as unknown as { opsApprovals: OpsApprovalsBridge }).opsApprovals

    const outcomes: Record<string, { asks: string[]; refused: string[] }> = {}
    for (const [name, calls] of Object.entries(DAYS)) {
      const agent = await projects.ensureAgent(name)
      const rules = projects.configOf(name)?.approvals.auto_allow ?? []
      const asks: string[] = []
      const refused: string[] = []
      for (const [tool, args] of calls) {
        const verdict = bridge.gate({ name: tool, arguments: args, callId: `${name}-${tool}`, agent: agent as never })?.kind
        // What the gate sends to approval, the allowlist may still let through unasked.
        const listed = verdict === 'ask' && tool === 'bash' && matchAllowList(argumentsOf(args).argv, rules).allowed
        const what = tool === 'bash' ? String(args['command']) : `${tool} ${String(args['path'] ?? args['url'] ?? args['query'] ?? args['pattern'])}`
        if (verdict === 'ask' && !listed) asks.push(what)
        if (verdict === 'deny') refused.push(what)
      }
      outcomes[name] = { asks, refused }
    }

    expect(outcomes).toEqual({
      site: { asks: ['web_fetch https://developer.mozilla.org/en-US/docs/Web/CSS/grid'], refused: [] },
      research: { asks: [], refused: ['python3 summarise.py'] },
      reports: { asks: ['node fetch-stats.mjs', 'python3 chart.py'], refused: [] },
      devops: { asks: ['systemctl restart nginx'], refused: [] },
    })
  }, 60_000)
})
