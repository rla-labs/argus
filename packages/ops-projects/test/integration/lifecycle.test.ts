// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for `ops-projects`.
 *
 * The Definition of Done for prompt 03: two projects run in parallel in their
 * own folders with different models; a restart preserves the conversation; a
 * subagent's session resolves to its parent project; and run output is emitted
 * once per run with the right content.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { OpsError, projectOwner, adhocOwner } from '@argus-agent/types'
import { recordSessionEvents, userMessage, waitFor } from '@argus-agent/testkit'
import { bootProjects, writeProject } from '../helpers.js'

/** A capability the tests can use, standing in for the governor. */
function governorCapability(projects: { claimDelivery(holder: string): unknown }): never {
  return projects.claimDelivery('ops-governor') as never
}

describe('ensureAgent', () => {
  it('creates an agent for a configured project with its own cwd and model', async () => {
    const { projects, dataDir } = await bootProjects({
      projects: { site: { model: 'site-model' } },
    })

    const agent = await projects.ensureAgent('site')
    expect(agent.session.header.cwd).toBe(join(dataDir, 'projects', 'site'))
    expect(agent.options.model).toBe('site-model')
    expect(agent.status).toBe('idle')
  })

  it('creates the project directory when it does not exist', async () => {
    const { projects, dataDir } = await bootProjects({ projects: { site: {} } })
    expect(existsSync(join(dataDir, 'projects', 'site'))).toBe(false)
    await projects.ensureAgent('site')
    expect(existsSync(join(dataDir, 'projects', 'site'))).toBe(true)
  })

  it('returns the same agent on a second call', async () => {
    const { projects } = await bootProjects({ projects: { site: {} } })
    const first = await projects.ensureAgent('site')
    const second = await projects.ensureAgent('site')
    expect(second.id).toBe(first.id)
  })

  it('shares one creation between concurrent calls', async () => {
    const { projects } = await bootProjects({ projects: { site: {} } })
    // Single-flight: two dispatcher passes must not produce two agents for one
    // project, which would double its concurrency and split its conversation.
    const [a, b, c] = await Promise.all([
      projects.ensureAgent('site'),
      projects.ensureAgent('site'),
      projects.ensureAgent('site'),
    ])
    expect(a.id).toBe(b.id)
    expect(b.id).toBe(c.id)
    expect(projects.listLive()).toHaveLength(1)
  })

  it('records the session in the store', async () => {
    const { projects, store } = await bootProjects({ projects: { site: {} } })
    const agent = await projects.ensureAgent('site')
    expect(store.projects.get('site')?.session_id).toBe(agent.id)
  })

  it('rejects an unconfigured project', async () => {
    const { projects } = await bootProjects({ projects: { site: {} } })
    try {
      await projects.ensureAgent('missing')
      throw new Error('expected a throw')
    } catch (error) {
      expect(OpsError.hasCode(error, 'PROJECT_NOT_FOUND')).toBe(true)
    }
  })

  it('runs two projects in parallel in their own folders with different models', async () => {
    const { projects, boot } = await bootProjects({
      projects: { alpha: { model: 'model-alpha' }, beta: { model: 'model-beta' } },
      fake: {
        script: [{ text: 'alpha reply' }, { text: 'beta reply' }],
        repeatLast: true,
      },
    })

    const alpha = await projects.ensureAgent('alpha')
    const beta = await projects.ensureAgent('beta')

    const events = recordSessionEvents(boot.ctx)
    alpha.followup(userMessage('a-1', 'alpha work'))
    beta.followup(userMessage('b-1', 'beta work'))
    await Promise.all([alpha.whenIdle(), beta.whenIdle()])

    // Each ran in its own folder, with its own model.
    expect(alpha.session.header.cwd).toContain('alpha')
    expect(beta.session.header.cwd).toContain('beta')
    expect(alpha.options.model).toBe('model-alpha')
    expect(beta.options.model).toBe('model-beta')

    // Both produced output, and the adapter saw both models.
    expect(events.ofType('assistant/message')).toHaveLength(2)
    const models = (boot.fake?.requests ?? []).map((request) => request.model).sort()
    expect(models).toEqual(['model-alpha', 'model-beta'])
  })
})

describe('restart', () => {
  it('resumes the conversation from the persisted session', async () => {
    const first = await bootProjects({
      projects: { site: {} },
      fake: { script: [{ text: 'first answer' }], repeatLast: true },
    })
    const dataDir = first.dataDir

    const agent = await first.projects.ensureAgent('site')
    const sessionId = agent.id
    agent.followup(userMessage('m-1', 'remember this'))
    await agent.whenIdle()
    await first.ctx.sessions.flush(agent.session)
    // Dispose the tree; the session log stays in the data directory.
    await first.dispose()

    const second = await bootProjects({
      dataDir,
      projects: { site: {} },
      fake: { script: [{ text: 'second answer' }], repeatLast: true },
    })
    const resumed = await second.projects.ensureAgent('site')

    // FACT: the same session came back, with its earlier turn intact.
    expect(resumed.id).toBe(sessionId)
    expect(resumed.session.snapshotEvents().length).toBeGreaterThan(0)

    // And it accepts new work.
    resumed.followup(userMessage('m-2', 'continue'))
    await resumed.whenIdle()
    expect(resumed.status).toBe('idle')
  }, 60_000)

  it('starts a fresh session when the recorded one is gone', async () => {
    const first = await bootProjects({ projects: { site: {} } })
    const dataDir = first.dataDir
    const agent = await first.projects.ensureAgent('site')
    const oldSession = agent.id
    await first.dispose()

    // Record a session id that has no log, which is what a deleted session
    // directory leaves behind.
    const second = await bootProjects({ dataDir, projects: { site: {} } })
    second.store.projects.setSession('site', 'does-not-exist', Date.now())
    const fresh = await second.projects.ensureAgent('site')

    // FACT: a resume that cannot find its log is not fatal. The project starts
    // fresh and the loss is recorded in the audit log.
    expect(fresh.id).not.toBe('does-not-exist')
    expect(fresh.id).not.toBe(oldSession)
    const audit = second.store.audit.byAction('session.resume-failed')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.target).toBe('site')
  }, 60_000)

  it('archives the old session on reset and creates a new one', async () => {
    const { projects, store } = await bootProjects({ projects: { site: {} } })
    const before = await projects.ensureAgent('site')
    await projects.reset('site', 'user-1')

    const after = await projects.ensureAgent('site')
    expect(after.id).not.toBe(before.id)

    const audit = store.audit.byAction('project.reset')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor).toBe('user-1')
    expect(audit[0]?.details_json).toContain(before.id as string)
  }, 30_000)
})

describe('ownership', () => {
  it('resolves a project session to its project owner', async () => {
    const { projects } = await bootProjects({ projects: { site: {} } })
    const agent = await projects.ensureAgent('site')
    expect(projects.ownerOf(agent.id as string)).toEqual(projectOwner('site'))
  })

  it('resolves an ad-hoc session to its run', async () => {
    const { projects } = await bootProjects()
    const agent = await projects.createEphemeral({
      kind: 'adhoc',
      runId: 'run-7',
      model: { provider: 'fake', model: 'cheap' },
    })
    expect(projects.ownerOf(agent.id as string)).toEqual(adhocOwner('run-7'))
  })

  it('resolves the orchestrator session', async () => {
    const { projects } = await bootProjects()
    const agent = await projects.createEphemeral({
      kind: 'orchestrator',
      runId: 'ignored',
      model: { provider: 'fake', model: 'flash' },
    })
    expect(projects.ownerOf(agent.id as string)).toEqual({ kind: 'orchestrator' })
    // The front desk has no project session to record, which is not a fault.
    expect(projects.health().status).toBe('ok')
  })

  it('resolves a subagent session to its parent project', async () => {
    const { projects, ctx } = await bootProjects({ projects: { site: {} } })
    const parent = await projects.ensureAgent('site')

    // A child created with `parentAgent` records the durable parent link and is
    // announced through `agent/created`, which the plugin links.
    const child = await ctx.agents.create({
      sessionId: SessionId('subagent-1'),
      parentAgent: parent,
      meta: { cwd: join(parent.session.header.cwd ?? '/tmp', 'sub'), parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'fake', model: 'fake-model' },
    })

    expect(projects.ownerOf('subagent-1')).toEqual(projectOwner('site'))

    // And a grandchild, to prove the walk is not one level deep.
    const grandchild = await ctx.agents.create({
      sessionId: SessionId('subagent-2'),
      parentAgent: child.agent,
      meta: { cwd: parent.session.header.cwd, parentSession: child.agent.id, origin: 'subagent', delegationDepth: 2 },
      agentOptions: { provider: 'fake', model: 'fake-model' },
    })
    expect(projects.ownerOf('subagent-2')).toEqual(projectOwner('site'))

    await grandchild.dispose()
    await child.dispose()
  }, 30_000)

  it('returns undefined for an unknown session instead of throwing', async () => {
    const { projects } = await bootProjects()
    expect(projects.ownerOf('nobody')).toBeUndefined()
    expect(projects.runOf('nobody')).toBeUndefined()
  })

  it('stops resolving a session after its agent is disposed', async () => {
    const { projects, ctx } = await bootProjects({ projects: { site: {} } })
    const agent = await projects.ensureAgent('site')
    const sessionId = agent.id as string

    const handle = ctx.agents.get(agent.id)
    expect(handle).toBeDefined()
    // Disposing through the plugin's wrapped disposer unregisters the session.
    await projects.reset('site')
    expect(projects.ownerOf(sessionId)).toBeUndefined()
  }, 30_000)
})

describe('deliver', () => {
  it('refuses a caller without the governor capability', async () => {
    const { projects } = await bootProjects({ projects: { site: {} } })
    await projects.ensureAgent('site')

    try {
      await projects.deliver({ scope: 'deliver', id: Symbol('fake') }, { kind: 'project', projectId: 'site' }, [
        { type: 'text', text: 'hello' },
      ], { runId: 'run-1' })
      throw new Error('expected a throw')
    } catch (error) {
      expect(OpsError.hasCode(error, 'GOVERNOR_REQUIRED')).toBe(true)
    }
  })

  it('delivers with the capability and records the run', async () => {
    const { projects } = await bootProjects({
      projects: { site: {} },
      fake: { script: [{ text: 'delivered' }], repeatLast: true },
    })
    const capability = governorCapability(projects)
    await projects.ensureAgent('site')

    const result = await projects.deliver(
      capability,
      { kind: 'project', projectId: 'site' },
      [{ type: 'text', text: 'verbatim instruction' }],
      { runId: 'run-1', source: 'channel' },
    )
    expect(result.queued).toBe(false)
    expect(projects.runOf(result.sessionId)).toBe('run-1')

    const agent = projects.agentFor({ kind: 'project', projectId: 'site' })
    await agent?.whenIdle()
  }, 30_000)

  it('reports a delivery to a running agent as queued', async () => {
    const { projects } = await bootProjects({
      projects: { site: {} },
      fake: { script: [{ text: 'slow', latencyMs: 300 }], repeatLast: true },
    })
    const capability = governorCapability(projects)
    const agent = await projects.ensureAgent('site')

    await projects.deliver(capability, { kind: 'project', projectId: 'site' }, [{ type: 'text', text: 'first' }], {
      runId: 'run-1',
    })
    // The second delivery lands while the first turn is running, so it queues in
    // the agent's inbox rather than consuming a second concurrency slot.
    const second = await projects.deliver(
      capability,
      { kind: 'project', projectId: 'site' },
      [{ type: 'text', text: 'second' }],
      { runId: 'run-2' },
    )
    expect(second.queued).toBe(true)
    await agent.whenIdle()
  }, 30_000)

  it('rejects a delivery to a target with no live agent', async () => {
    const { projects } = await bootProjects({ projects: { site: {} } })
    const capability = governorCapability(projects)
    try {
      await projects.deliver(capability, { kind: 'project', projectId: 'site' }, [{ type: 'text', text: 'x' }], {
        runId: 'run-1',
      })
      throw new Error('expected a throw')
    } catch (error) {
      expect(OpsError.hasCode(error, 'PROJECT_NOT_FOUND')).toBe(true)
    }
  })
})

describe('cancel', () => {
  it('cancels a running turn and keeps the inbox', async () => {
    const { projects } = await bootProjects({
      projects: { site: {} },
      fake: { script: [{ text: 'never finishes', latencyMs: 60_000 }], repeatLast: true },
    })
    const capability = governorCapability(projects)
    const agent = await projects.ensureAgent('site')

    await projects.deliver(capability, { kind: 'project', projectId: 'site' }, [{ type: 'text', text: 'work' }], {
      runId: 'run-1',
    })
    await waitFor(() => agent.status === 'running', { label: 'agent running' })

    expect(projects.cancel({ kind: 'project', projectId: 'site' })).toBe(true)
    await waitFor(() => agent.status === 'idle', { label: 'agent idle after cancel' })
  }, 30_000)

  it('reports no cancel for a target with no live agent', async () => {
    const { projects } = await bootProjects()
    expect(projects.cancel({ kind: 'project', projectId: 'missing' })).toBe(false)
  })
})

describe('run output', () => {
  it('emits ops/run-output once per run with the final assistant content', async () => {
    const { projects, ctx } = await bootProjects({
      projects: { site: {} },
      fake: { script: [{ text: 'the final answer' }], repeatLast: true },
    })
    const capability = governorCapability(projects)
    await projects.ensureAgent('site')

    const outputs: Array<{ owner: unknown; sessionId: string; runId: string; text: string }> = []
    ctx.on('ops/run-output', ({ owner, sessionId, runId, content }) => {
      outputs.push({
        owner,
        sessionId,
        runId,
        text: content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
      })
    })

    const delivered = await projects.deliver(
      capability,
      { kind: 'project', projectId: 'site' },
      [{ type: 'text', text: 'do it' }],
      { runId: 'run-42' },
    )
    const agent = projects.agentFor({ kind: 'project', projectId: 'site' })
    await agent?.whenIdle()

    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.runId).toBe('run-42')
    expect(outputs[0]?.sessionId).toBe(delivered.sessionId)
    expect(outputs[0]?.owner).toEqual(projectOwner('site'))
    expect(outputs[0]?.text).toBe('the final answer')
  }, 30_000)

  it('emits one output per run when a run has several steps', async () => {
    const { projects, ctx } = await bootProjects({
      projects: { site: {} },
      entries: [{ id: 'tools', name: '@deepseek-ai/dsh-tools' }],
      fake: {
        script: [
          { text: 'step one', toolCalls: [{ name: 'probe', arguments: '{}', id: 'c1' }] },
          { text: 'step two' },
        ],
        repeatLast: false,
      },
    })
    const capability = governorCapability(projects)

    // Register a trivial tool into the project's scope after creation.
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const agent = await projects.ensureAgent('site')
    agent.ctx.tools.register(
      defineTool({
        name: 'probe',
        description: 'probe',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => 'probed',
      }),
    )

    const outputs: string[] = []
    ctx.on('ops/run-output', ({ content }) => {
      outputs.push(content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
    })

    await projects.deliver(capability, { kind: 'project', projectId: 'site' }, [{ type: 'text', text: 'go' }], {
      runId: 'run-1',
    })
    await agent.whenIdle()

    // One run, two model requests, one output carrying the LAST assistant text.
    expect(outputs).toEqual(['step two'])
  }, 30_000)

  it('emits nothing for a run that produced no assistant message', async () => {
    const { projects, ctx } = await bootProjects({
      projects: { site: {} },
      fake: { script: [{ text: 'ok' }], repeatLast: true },
    })
    const capability = governorCapability(projects)
    await projects.ensureAgent('site')

    // Reject every step, so the turn closes without an assistant message.
    ctx.on('agent/pre-step', async () => ({ kind: 'reject' as const }))

    const outputs: unknown[] = []
    ctx.on('ops/run-output', ({ content }) => outputs.push(content))

    await projects.deliver(capability, { kind: 'project', projectId: 'site' }, [{ type: 'text', text: 'x' }], {
      runId: 'run-1',
    })
    const agent = projects.agentFor({ kind: 'project', projectId: 'site' })
    await agent?.whenIdle()

    // The run still closed and the event still fired, with empty content.
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toEqual([])
  }, 30_000)
})

describe('lifecycle events', () => {
  it('emits running and idle with the owner', async () => {
    const { projects, ctx } = await bootProjects({
      projects: { site: {} },
      fake: { script: [{ text: 'ok' }], repeatLast: true },
    })
    const capability = governorCapability(projects)
    await projects.ensureAgent('site')

    const seen: Array<{ event: string; owner: unknown; runId?: string | undefined }> = []
    ctx.on('ops/agent-running', ({ owner }) => seen.push({ event: 'running', owner }))
    ctx.on('ops/agent-idle', ({ owner, runId }) => seen.push({ event: 'idle', owner, runId }))

    await projects.deliver(capability, { kind: 'project', projectId: 'site' }, [{ type: 'text', text: 'x' }], {
      runId: 'run-1',
    })
    const agent = projects.agentFor({ kind: 'project', projectId: 'site' })
    await agent?.whenIdle()

    expect(seen.map((entry) => entry.event)).toEqual(['running', 'idle'])
    expect(seen[0]?.owner).toEqual(projectOwner('site'))
    // The idle event carries the run that just ended, so the governor can close
    // its bookkeeping.
    expect(seen[1]?.runId).toBe('run-1')
  }, 30_000)
})

describe('setModel', () => {
  it('records an override in the store and the audit log', async () => {
    const { projects, store } = await bootProjects({ projects: { site: {} } })
    expect(projects.setModel('site', 'new-model', 'user-1')).toBe(true)
    expect(store.projects.get('site')?.model).toBe('new-model')
    expect(store.audit.byAction('project.model-changed')).toHaveLength(1)
  })

  it('reports an unknown project', async () => {
    const { projects } = await bootProjects()
    expect(projects.setModel('missing', 'm')).toBe(false)
  })

  it('applies to the next agent, not the live one', async () => {
    const { projects } = await bootProjects({ projects: { site: {} } })
    const before = await projects.ensureAgent('site')
    expect(before.options.model).toBe('fake-model')

    projects.setModel('site', 'new-model')
    // dsh fixes the model at creation (SPIKES.md spike 3), so the live agent is
    // unchanged.
    expect(before.options.model).toBe('fake-model')
  })
})

describe('project configuration sync', () => {
  it('archives a project removed from the directory, never deletes it', async () => {
    const { projects, store, dataDir } = await bootProjects({ projects: { site: {} } })
    await projects.ensureAgent('site')
    expect(store.projects.get('site')?.status).toBe('active')

    // Remove the file and reload.
    const { rmSync } = await import('node:fs')
    rmSync(join(dataDir, 'config', 'projects', 'site.yaml'))
    const { reload } = await import('../../src/index.js')
    const report = reload(projects['ctx'] as never, projects)

    expect(report.archived).toEqual(['site'])
    expect(store.projects.get('site')?.status).toBe('archived')
    // The row still exists, so its usage history keeps its subject.
    expect(store.projects.get('site')).toBeDefined()
  }, 30_000)

  it('restores a project that comes back', async () => {
    const { projects, store, dataDir } = await bootProjects({ projects: { site: {} } })
    const { rmSync } = await import('node:fs')
    const { reload } = await import('../../src/index.js')

    rmSync(join(dataDir, 'config', 'projects', 'site.yaml'))
    reload(projects['ctx'] as never, projects)
    expect(store.projects.get('site')?.status).toBe('archived')

    writeProject(dataDir, 'site')
    const report = reload(projects['ctx'] as never, projects)
    expect(report.restored).toEqual(['site'])
    expect(store.projects.get('site')?.status).toBe('active')
  }, 30_000)

  it('keeps a paused project paused across a reload', async () => {
    const { projects, store, dataDir } = await bootProjects({ projects: { site: {} } })
    store.projects.setStatus('site', 'paused', Date.now())

    writeProject(dataDir, 'site', { description: 'changed' })
    const { reload } = await import('../../src/index.js')
    reload(projects['ctx'] as never, projects)

    // Pausing is a decision about budget, not about configuration.
    expect(store.projects.get('site')?.status).toBe('paused')
    expect(store.projects.get('site')?.description).toBe('changed')
  }, 30_000)

  it('preserves the session across a reload', async () => {
    const { projects, store, dataDir } = await bootProjects({ projects: { site: {} } })
    const agent = await projects.ensureAgent('site')

    writeProject(dataDir, 'site', { model: 'updated-model' })
    const { reload } = await import('../../src/index.js')
    reload(projects['ctx'] as never, projects)

    const row = store.projects.get('site')
    expect(row?.model).toBe('updated-model')
    expect(row?.session_id).toBe(agent.id)
  }, 30_000)
})

describe('config validation at boot', () => {
  it('keeps running when one project file is invalid, ignoring only that project', async () => {
    // Fault tolerance: a bad file must not take the system down with it.
    const { ctx, projects, store } = await bootProjects({
      projects: { good: {}, bad: 'id: bad\ncwd: /etc\nprovider: fake\nmodel: m\n' },
    })
    expect((ctx as unknown as { opsProjects?: unknown }).opsProjects).toBeDefined()
    expect(projects.configuredIds()).toEqual(['good'])

    const invalid = projects.invalidProjects()
    expect(invalid.map((p) => p.id)).toEqual(['bad'])
    expect(invalid[0]!.path).toMatch(/bad\.yaml$/)
    expect(invalid[0]!.reason).toMatch(/cwd/)

    // The valid project works; the invalid one is refused with the reason.
    await projects.ensureAgent('good')
    const error = await projects.ensureAgent('bad').catch((caught: unknown) => caught)
    expect(OpsError.hasCode(error, 'PROJECT_INVALID')).toBe(true)
    expect((error as Error).message).toMatch(/\/reload/)
    expect(store.projects.get('bad')).toBeUndefined()

    const health = projects.health()
    expect(health.status).toBe('degraded')
    expect(String(health.details?.['reason'])).toContain('bad')
  }, 30_000)

  it('marks a file whose id does not match its name as invalid', async () => {
    const { projects } = await bootProjects({
      projects: { site: 'id: other\ncwd: /data/projects/site\nprovider: fake\nmodel: m\n' },
    })
    expect(projects.configuredIds()).toEqual([])
    expect(projects.invalidProjects().map((p) => p.id)).toEqual(['site'])
  })

  it('never archives a project whose file became invalid, and brings it back once fixed', async () => {
    const { projects, store, dataDir, ctx } = await bootProjects({ projects: { site: {} } })
    expect(store.projects.get('site')?.status).toBe('active')
    const events: Array<{ invalid: readonly { id: string }[]; fixed: readonly string[] }> = []
    ;(ctx as unknown as { on(name: string, listener: (payload: never) => void): void }).on(
      'ops/projects-invalid',
      (payload: never) => events.push(payload),
    )
    const { writeFileSync } = await import('node:fs')
    const { reload } = await import('../../src/index.js')
    const file = join(dataDir, 'config', 'projects', 'site.yaml')

    // A typo: the project is ignored, NOT archived — a typo is not a deletion.
    writeFileSync(file, 'id: site\ncwd: /etc\nprovider: fake\nmodel: m\n')
    const broken = reload(projects['ctx'] as never, projects)
    expect(broken.invalid.map((p) => p.id)).toEqual(['site'])
    expect(broken.archived).toEqual([])
    expect(store.projects.get('site')?.status).toBe('active')
    expect(projects.configOf('site')).toBeUndefined()
    expect(events.at(-1)?.invalid.map((p) => p.id)).toEqual(['site'])

    // A second reload with the same problem says nothing new.
    reload(projects['ctx'] as never, projects)
    expect(events).toHaveLength(1)

    // Fixed: back, and the operator is told.
    writeProject(dataDir, 'site')
    const fixed = reload(projects['ctx'] as never, projects)
    expect(fixed.fixed).toEqual(['site'])
    expect(fixed.invalid).toEqual([])
    expect(projects.configOf('site')).toBeDefined()
    expect(projects.health().status).toBe('ok')
    expect(events.at(-1)).toEqual({ invalid: [], fixed: ['site'] })
  }, 30_000)

  it('marks a project invalid when a model check fails, and brings it back when the check goes', async () => {
    const { projects } = await bootProjects({
      projects: { good: {}, keyless: { model: 'needs-key', fallback_model: 'fake/also-keyless' } },
    })
    expect(projects.configuredIds()).toEqual(['good', 'keyless'])

    const dispose = projects.addModelCheck((model) =>
      model.model.includes('keyless') || model.model === 'needs-key'
        ? { code: 'PROVIDER_KEY_MISSING', message: 'set FAKE_API_KEY' }
        : undefined,
    )
    // Re-checked at once, without a reload of the files.
    expect(projects.configuredIds()).toEqual(['good'])
    expect(projects.invalidOf('keyless')?.reason).toBe('model: set FAKE_API_KEY\nfallback_model: set FAKE_API_KEY')
    expect(projects.checkModel({ provider: 'fake', model: 'needs-key' })?.code).toBe('PROVIDER_KEY_MISSING')

    dispose()
    expect(projects.configuredIds()).toEqual(['good', 'keyless'])
    expect(projects.checkModel({ provider: 'fake', model: 'needs-key' })).toBeUndefined()
  }, 30_000)

  it('boots with no projects directory at all', async () => {
    const { projects, store } = await bootProjects()
    expect(projects.configuredIds()).toEqual([])
    expect(store.projects.list()).toEqual([])
  })

  it('exposes the loaded configuration', async () => {
    const { projects } = await bootProjects({ projects: { site: { description: 'hello' } } })
    expect(projects.configuredIds()).toEqual(['site'])
    expect(projects.configOf('site')?.description).toBe('hello')
    expect(projects.configOf('missing')).toBeUndefined()
  })
})

describe('ad-hoc and orchestrator agents', () => {
  it('creates an ad-hoc agent in the scratch directory', async () => {
    const { projects, dataDir } = await bootProjects()
    const agent = await projects.createEphemeral({
      kind: 'adhoc',
      runId: 'run-3',
      model: { provider: 'fake', model: 'cheap' },
    })
    expect(agent.session.header.cwd).toBe(join(dataDir, 'scratch', 'run-3'))
    expect(agent.options.model).toBe('cheap')
  })

  it('creates the orchestrator in its own scratch directory', async () => {
    const { projects, dataDir } = await bootProjects()
    const agent = await projects.createEphemeral({
      kind: 'orchestrator',
      runId: 'ignored',
      model: { provider: 'fake', model: 'flash' },
    })
    expect(agent.session.header.cwd).toBe(join(dataDir, 'scratch', 'orchestrator'))
  })

  it('returns the same agent for a repeated ad-hoc run id', async () => {
    const { projects } = await bootProjects()
    const first = await projects.createEphemeral({
      kind: 'adhoc',
      runId: 'run-1',
      model: { provider: 'fake', model: 'm' },
    })
    const second = await projects.createEphemeral({
      kind: 'adhoc',
      runId: 'run-1',
      model: { provider: 'fake', model: 'm' },
    })
    expect(second.id).toBe(first.id)
  })

  it('keeps two ad-hoc runs separate', async () => {
    const { projects } = await bootProjects()
    const first = await projects.createEphemeral({
      kind: 'adhoc',
      runId: 'run-1',
      model: { provider: 'fake', model: 'm' },
    })
    const second = await projects.createEphemeral({
      kind: 'adhoc',
      runId: 'run-2',
      model: { provider: 'fake', model: 'm' },
    })
    expect(second.id).not.toBe(first.id)
    expect(projects.listLive()).toHaveLength(2)
  })
})

describe('teardown', () => {
  it('disposes every agent on unload', async () => {
    const { projects, ctx, store } = await bootProjects({ projects: { site: {} } })
    const agent = await projects.ensureAgent('site')
    expect(ctx.agents.get(agent.id)).toBeDefined()

    await projects.disposeAll()
    // The agent is unregistered and its session is gone.
    expect(projects.listLive()).toHaveLength(0)
    expect(projects.ownerOf(agent.id as string)).toBeUndefined()
    // The project row survives: disposing an agent is not deleting a project.
    expect(store.projects.get('site')).toBeDefined()
  }, 30_000)

  it('reports no live agents before anything is created', async () => {
    const { projects } = await bootProjects()
    expect(projects.listLive()).toEqual([])
    expect(projects.isRunning({ kind: 'project', projectId: 'site' })).toBe(false)
  })
})

describe('project files on disk', () => {
  it('reads a project file written by hand', async () => {
    const { projects, dataDir } = await bootProjects()
    writeProject(dataDir, 'handmade', { description: 'written after boot' })
    const { reload } = await import('../../src/index.js')
    reload(projects['ctx'] as never, projects)

    expect(projects.configOf('handmade')?.description).toBe('written after boot')
    const agent = await projects.ensureAgent('handmade')
    expect(agent.session.header.cwd).toBe(join(dataDir, 'projects', 'handmade'))
  }, 30_000)

  it('does not create the project directory until an agent is needed', async () => {
    const { projects, dataDir } = await bootProjects()
    writeProject(dataDir, 'lazy')
    const { reload } = await import('../../src/index.js')
    reload(projects['ctx'] as never, projects)

    expect(existsSync(join(dataDir, 'projects', 'lazy'))).toBe(false)
    await projects.ensureAgent('lazy')
    expect(existsSync(join(dataDir, 'projects', 'lazy'))).toBe(true)
  }, 30_000)
})
