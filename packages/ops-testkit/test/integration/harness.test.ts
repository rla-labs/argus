// == ARGUS AGENT PROJECT ==
/**
 * Tests for the boot harness.
 *
 * Prompt 01's requirement: "the harness boots and disposes 20 times in a row
 * without leaks". A leak here would make every later integration suite
 * unreliable, so it is asserted directly.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only imports bring in each package's `Context` augmentation, so the
// optional services this test asserts on are typed.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  BASE_ENTRIES,
  bootOps,
  liveBootCount,
  persistenceEntry,
  renderEntries,
  userMessage,
} from '../../src/index.js'

describe('bootOps', () => {
  it('boots and disposes 20 times in a row without leaking', async () => {
    const boots: Awaited<ReturnType<typeof bootOps>>[] = []
    try {
      for (let index = 0; index < 20; index += 1) {
        const boot = await bootOps({ fake: { script: [{ text: `run ${index}` }], repeatLast: true } })
        boots.push(boot)

        // Each boot works: create an agent, run a turn, get the answer.
        const handle = await boot.ctx.agents.create({
          sessionId: SessionId(`leak-${index}`),
          meta: { cwd: boot.dir },
          agentOptions: { provider: 'fake', model: 'fake-model' },
        })
        handle.agent.followup(userMessage('m-1', 'hi'))
        await handle.agent.whenIdle()
        expect(handle.agent.status).toBe('idle')
        await handle.dispose()

        // Dispose immediately, so at most one tree is live at a time.
        const dir = boot.dir
        await boot.dispose()
        // FACT: disposal removes the temporary directory as well as the tree.
        expect(existsSync(dir)).toBe(false)
      }

      // FACT: every boot's fiber reached DISPOSED; none is still live.
      expect(liveBootCount(boots)).toBe(0)
    } finally {
      for (const boot of boots) {
        if (existsSync(boot.dir)) await boot.dispose()
      }
    }
  }, 120_000)

  it('gives each boot an isolated temporary directory', async () => {
    const first = await bootOps()
    const second = await bootOps()
    try {
      expect(first.dir).not.toBe(second.dir)
      expect(first.sessionsRoot.startsWith(first.dir)).toBe(true)
      expect(second.sessionsRoot.startsWith(second.dir)).toBe(true)
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it('writes requested fixture files into the boot directory', async () => {
    const boot = await bootOps({
      files: { 'config/ops.yaml': 'timezone: UTC\n', 'config/projects/a.yaml': 'id: a\n' },
    })
    try {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      expect(readFileSync(join(boot.dir, 'config', 'ops.yaml'), 'utf8')).toBe('timezone: UTC\n')
      expect(readFileSync(join(boot.dir, 'config', 'projects', 'a.yaml'), 'utf8')).toBe('id: a\n')
    } finally {
      await boot.dispose()
    }
  })

  it('mounts no adapter when fake is false', async () => {
    const boot = await bootOps({ fake: false })
    try {
      expect(boot.fake).toBeUndefined()
      expect(boot.ctx.llm).toBeDefined()
    } finally {
      await boot.dispose()
    }
  })

  it('mounts the optional rows a test opts into', async () => {
    const boot = await bootOps({
      entries: [
        { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval' },
        { id: 'commands', name: '@deepseek-ai/dsh-commands' },
        { id: 'subagent', name: '@deepseek-ai/dsh-subagent' },
      ],
    })
    try {
      expect(boot.ctx.approval).toBeDefined()
      expect(boot.ctx.commands).toBeDefined()
      expect(boot.ctx.subagents).toBeDefined()
    } finally {
      await boot.dispose()
    }
  })

  it('resumes a session from an explicit sessions root', async () => {
    // This is the crash-recovery pattern: the same root is shared between two
    // boots, so the second sees the log the first wrote. The log directory is
    // keyed by the session's `cwd`, so the resumed agent must use the same one
    // — a real deployment keeps a project's cwd stable for exactly this reason.
    const first = await bootOps({ fake: { script: [{ text: 'first turn' }] } })
    const root = mkdtempSync(join(tmpdir(), 'ops-testkit-resume-'))
    const workDir = join(root, 'work')
    mkdirSync(workDir, { recursive: true })
    const sessionsRoot = join(root, 'sessions')

    try {
      const handle = await first.ctx.agents.create({
        sessionId: SessionId('shared-session'),
        meta: { cwd: workDir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
      })
      handle.agent.followup(userMessage('m-1', 'hello'))
      await handle.agent.whenIdle()
      await first.ctx.sessions.flush(handle.agent.session)
      await handle.dispose()

      // Copy the written log out of the boot's temporary directory, which
      // `dispose()` deletes, into a directory this test owns.
      cpSync(first.sessionsRoot, sessionsRoot, { recursive: true })
    } finally {
      await first.dispose()
    }

    const second = await bootOps({
      sessionsRoot,
      fake: { script: [{ text: 'second turn' }], repeatLast: true },
    })
    try {
      const handle = await second.ctx.agents.resume({
        resumeSessionId: SessionId('shared-session'),
        agentOptions: { provider: 'fake', model: 'fake-model' },
      })
      // FACT: the earlier turn survived, and the conversation continues in the
      // same session rather than starting over.
      expect(handle.agent.session.snapshotEvents().length).toBeGreaterThan(0)
      handle.agent.followup(userMessage('m-2', 'again'))
      await handle.agent.whenIdle()
      expect(handle.agent.status).toBe('idle')
      await handle.dispose()
    } finally {
      await second.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('renderEntries', () => {
  it('quotes plugin specifiers, which YAML would otherwise reject', () => {
    const yaml = renderEntries([{ id: 'llm', name: '@deepseek-ai/dsh-llm' }])
    expect(yaml).toContain('name: "@deepseek-ai/dsh-llm"')
  })

  it('renders nested config, lists and empty values', () => {
    const yaml = renderEntries([
      {
        id: 'agent-loop',
        name: '@deepseek-ai/dsh-agent-loop',
        config: { agents: [], nested: { a: 1, b: 'x' }, list: ['one', 'two'], flag: true, nothing: null },
      },
    ])
    expect(yaml).toContain('agents: []')
    expect(yaml).toContain('nested:')
    expect(yaml).toContain('a: 1')
    expect(yaml).toContain('- "one"')
    expect(yaml).toContain('flag: true')
    expect(yaml).toContain('nothing: null')
  })

  it('renders a one-entry nested map as a block, not as `a: b: c`', async () => {
    const { parse } = await import('yaml')
    const config = { providers: { openrouter: { apiKeyEnv: 'KEY' } } }
    const parsed = parse(renderEntries([{ id: 'x', name: 'x', config }])) as Array<{ config: unknown }>
    expect(parsed[0]?.config).toEqual(config)
  })

  it('renders a disabled row', () => {
    expect(renderEntries([{ id: 'hmr', name: 'x', disabled: true }])).toContain('disabled: true')
  })

  it('produces a parseable document for every base entry', async () => {
    const { parse } = await import('yaml')
    const parsed = parse(renderEntries([...BASE_ENTRIES, persistenceEntry('/tmp/sessions')])) as unknown[]
    expect(parsed).toHaveLength(BASE_ENTRIES.length + 1)
    expect((parsed[0] as { name: string }).name).toBe('@deepseek-ai/dsh-llm')
  })
})
