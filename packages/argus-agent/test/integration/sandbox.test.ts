// == ARGUS AGENT PROJECT ==
/**
 * The sandbox row under dsh's real bash: what an agent's command may read and write.
 *
 * The shell rows are the base bundle's own (`dsh-subprocess-local`, `dsh-sandbox-policy`,
 * `dsh-bash-sandbox`, `dsh-tool-bash`), resolved through `dsh-base`, with this
 * package's row behind `ctx.sandbox`. Skipped where the kernel has no Landlock.
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { probe } from '@deepseek-ai/node-addon-system/landlock-run'
import { bootOps, userMessage, waitFor } from '@argus-agent/testkit'

const fromAgent = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sandbox/package.json'))
const base = createRequire(resolve(fromAgent.resolve('@deepseek-ai/dsh-sandbox/package.json'), '../../dsh-base/package.json'))
const row = (id: string, pkg: string, config?: unknown) => ({ id, name: base.resolve(pkg), ...(config === undefined ? {} : { config }) })
const ROW = resolve(import.meta.dirname, '../../lib/sandbox-row.js')

const root = mkdtempSync(join(tmpdir(), 'argus-sandbox-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe.skipIf(probe() === 'unusable')('the sandbox row', () => {
  it("confines an agent's bash to its folder: no reading the data, no writing elsewhere", async () => {
    const workspace = join(root, 'projects', 'alpha')
    const other = join(root, 'projects', 'beta')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(other, { recursive: true })
    writeFileSync(join(root, 'ops.sqlite'), 'SECRET-ROWS')
    writeFileSync(join(other, 'notes.md'), 'BETA-NOTES')
    const commands = [
      `cat ${join(root, 'ops.sqlite')}`,
      `cat ${join(other, 'notes.md')}`,
      `echo x > ${join(other, 'planted.md')}`,
      'echo hello > out.txt && cat out.txt',
      'node -e "console.log(6*7)"',
      'echo "$HOME" && touch "$TMPDIR/scratch" && echo tmp-ok',
    ]
    const boot = await bootOps({
      entries: [
        row('subprocess', '@deepseek-ai/dsh-subprocess-local'),
        { id: 'sandbox', name: ROW },
        row('sandbox-policy', '@deepseek-ai/dsh-sandbox-policy', { mode: 'workspace-write' }),
        row('shell-env', '@deepseek-ai/dsh-shell-env'),
        row('bash-sandbox', '@deepseek-ai/dsh-bash-sandbox'),
        row('tool-bash', '@deepseek-ai/dsh-tool-bash'),
      ] as never,
      fake: {
        script: [
          { text: 'running', toolCalls: commands.map((command, index) => ({ name: 'bash', arguments: JSON.stringify({ command, description: `step ${index}` }), id: `c${index}` })) },
          { text: 'done' },
        ],
      },
    })
    try {
      const results = new Map<string, string>()
      boot.ctx.on('tools/result' as never, ((exec: { callId?: string; id?: string; arguments?: unknown }, result: unknown) => {
        const command = (exec.arguments as { command?: string } | undefined)?.command ?? ''
        results.set(command, JSON.stringify(result))
      }) as never)
      const ctx = boot.ctx as never as { agents: { create(o: unknown): Promise<{ agent: { followup(m: unknown): void } }> } }
      const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: workspace }, agentOptions: { provider: 'fake', model: 'm' } })
      handle.agent.followup(userMessage('m-1', 'go'))
      await waitFor(() => results.size === commands.length, { timeoutMs: 30_000, label: 'every command ran' })

      const of = (index: number) => results.get(commands[index] as string) ?? ''
      // The data and another project: not readable.
      expect(of(0)).not.toContain('SECRET-ROWS')
      expect(of(0)).toMatch(/permission denied/i)
      expect(of(1)).not.toContain('BETA-NOTES')
      // Not writable either.
      expect(of(2)).toMatch(/permission denied/i)
      expect(() => readFileSync(join(other, 'planted.md'))).toThrow()
      // Its own folder, Node, and a private home and temp folder: all usable.
      expect(of(3)).toContain('hello')
      expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('hello\n')
      expect(of(4)).toContain('42')
      expect(of(5)).toContain('argus-sandbox')
      expect(of(5)).toContain('tmp-ok')
    } finally {
      await boot.dispose()
    }
  }, 60_000)
})
