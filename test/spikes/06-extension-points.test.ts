// == ARGUS AGENT PROJECT ==
/**
 * Spike 6 — extension-point facts.
 *
 * The remaining questions prompt 00 asks about, answered as executable facts:
 * how a plugin declares service dependencies in Cordis, how to register a
 * command on `ctx.commands` and how its output returns, how to register a tool
 * scoped to one agent, how to compose a preset with a restricted tool set, and
 * what the default/configurable limits of the job registry and subagent depth
 * are.
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { bootSpike } from './harness.js'

describe('spike 6: extension points', () => {
  it('declares and provides a Cordis service with inject', async () => {
    // FACT: a Cordis service is a class extending `Service`. Declaring
    // `static inject = ['name']` keeps the plugin pending until that service
    // exists. A service must be announced with `ctx.provide(name, value)`,
    // which returns the disposer; the service disappears on unload.
    class Greeter extends Service {
      static inject = ['logger'] as const
      greet(): string {
        return 'hello'
      }
    }

    const boot = await bootSpike()
    try {
      // FACT: the provider must be registered through `ctx.plugin` so Cordis
      // owns its lifecycle. `ctx.provide` is the registration call.
      const fiber = boot.ctx.plugin({
        name: 'greeter-provider',
        apply(ctx) {
          ctx.provide('greeter', new Greeter(ctx))
        },
      })
      await fiber
      const greeter = (boot.ctx as unknown as { greeter?: Greeter }).greeter
      expect(greeter?.greet()).toBe('hello')

      // FACT: disposing the fiber unloads the service — the effect contract
      // AGENTS.md requires of every registration.
      await fiber.dispose()
      expect((boot.ctx as unknown as { greeter?: Greeter }).greeter).toBeUndefined()
    } finally {
      await boot.dispose()
    }
  })

  it('registers a command whose result returns without a model turn', async () => {
    const boot = await bootSpike([{ id: 'commands', name: '@deepseek-ai/dsh-commands' }])
    try {
      // FACT: `ctx.commands.register({ name, description, handler })` returns a
      // disposer. The handler runs with no model turn and returns a
      // `CommandResult` of `{ kind: 'success', text }` or
      // `{ kind: 'error', text }`.
      const registered = boot.ctx.commands.register({
        name: 'ops-probe',
        description: 'spike command',
        handler: (invocation) => ({
          kind: 'success' as const,
          text: `probe:${invocation.rawInput.trim()}`,
        }),
      })
      expect(typeof registered).toBe('function')

      // FACT: resolution is per-agent. `find` takes the receiving agent.
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike6-cmd'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
      })
      const definition = boot.ctx.commands.find(handle.agent, 'ops-probe')
      expect(definition?.description).toBe('spike command')

      // FACT: invoking the handler directly is how a headless caller
      // (ops-commands' own `runCommand`) gets the same result the UI renders.
      const result = await definition!.handler({
        commandId: 'c1' as never,
        agent: handle.agent,
        rawInput: '  value  ',
        attachments: [],
        signal: new AbortController().signal,
      })
      expect(result).toEqual({ kind: 'success', text: 'probe:value' })

      // FACT: the descriptor list is what Telegram's `setMyCommands` reads.
      const names = boot.ctx.commands.list(handle.agent).map((entry) => entry.name)
      expect(names).toContain('ops-probe')

      registered()
      expect(boot.ctx.commands.find(handle.agent, 'ops-probe')).toBeUndefined()
      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('registers a tool scoped to one agent only', async () => {
    const boot = await bootSpike()
    try {
      // FACT: `defineTool` requires a canonical `output` schema plus a pure
      // `render` projecting the validated value to model content blocks. The
      // `execute` body returns the canonical value, not content blocks.
      const tool: ToolDefinition = defineTool({
        name: 'ops_scoped_probe',
        description: 'spike tool',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          return 'scoped'
        },
      })

      const scopedId = SessionId('spike6-scoped')
      const otherId = SessionId('spike6-other')
      let scopedAgent: { ctx: Context } | undefined

      const handle = await boot.ctx.agents.create({
        sessionId: scopedId,
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
        // FACT: `setup` receives the unpublished agent's scoped context. A tool
        // registered through it is visible ONLY to that agent and unwinds when
        // the agent is disposed — this is how the orchestrator's restricted
        // toolset and ops-memory's per-project tools are built.
        setup(agentCtx, agent) {
          scopedAgent = agent
          agentCtx.tools.register(tool)
        },
      })
      const other = await boot.ctx.agents.create({
        sessionId: otherId,
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
      })

      expect(scopedAgent).toBeDefined()

      // FACT: `ctx.tools.get(name, scope)` is the scope-aware lookup. Passing
      // the agent's scope key resolves scoped shadowing and restriction; the
      // global view (no scope) never sees a scoped registration. This is the
      // exact call ops-orchestrator's "tool list is exactly the allowed set"
      // test uses.
      const { scopeOf } = await import('@deepseek-ai/dsh-scope')
      const scopedKey = scopeOf(handle.agent.ctx)
      expect(boot.ctx.tools.get('ops_scoped_probe', scopedKey)).toBeDefined()
      expect(boot.ctx.tools.get('ops_scoped_probe')).toBeUndefined()

      const otherKey = scopeOf(other.agent.ctx)
      expect(boot.ctx.tools.get('ops_scoped_probe', otherKey)).toBeUndefined()

      // FACT: disposing the agent unwinds the scoped registration.
      await handle.dispose()
      expect(boot.ctx.tools.get('ops_scoped_probe', scopedKey)).toBeUndefined()

      await other.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('reports the subagent depth default and the tool restriction API', async () => {
    const boot = await bootSpike([{ id: 'subagent', name: '@deepseek-ai/dsh-subagent' }])
    try {
      // FACT: `ctx.subagents` carries `maxDepth` (default 1) and
      // `maxActiveSubagents` (default 8) as volatile config, read through the
      // registry. ops-governor sets the project's depth limit here.
      const subagents = boot.ctx.subagents as unknown as {
        resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined
      }
      expect(typeof subagents.resolveMaxDepth).toBe('function')
      expect(subagents.resolveMaxDepth(undefined)).toBe(1)
      expect(subagents.resolveMaxDepth(2)).toBe(2)

      // FACT: `ctx.tools.restrict({ allow, deny })` narrows the INHERITED tool
      // surface for the calling scope and returns a disposer. It validates
      // against the GLOBAL tool set, so restricting a name that does not exist
      // globally throws — a restricted-away global tool reads as absent to that
      // scope. This is the mechanism for a preset with no shell and no files.
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike6-restrict'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
      })
      const scopedTools = (handle.agent.ctx as unknown as {
        tools: { restrict(filter: { allow?: string[]; deny?: string[] }): () => void }
      }).tools
      expect(() => scopedTools.restrict({ deny: ['no_such_tool'] })).toThrow(/unknown global tool/)
      const lift = scopedTools.restrict({ allow: [] })
      expect(typeof lift).toBe('function')
      lift()
      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('composes a preset through ctx.agentPresets.mount', async () => {
    const boot = await bootSpike([
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'ops' } },
      { id: 'preset-ops', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'ops', plugins: [] } },
    ])
    try {
      // FACT: presets are declared as Cordis entry lists and registered on
      // `ctx.agentPresets`. `mount(agentCtx, id)` binds an unpublished agent to
      // a preset revision; the preset's child plugins register into that
      // agent's scope, which is exactly how a per-project toolset is installed.
      const preset = await boot.ctx.agentPresets.resolve('ops')
      expect(preset.id).toBe('ops')

      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike6-preset'),
        meta: { cwd: boot.dir, agentPreset: 'ops' },
        agentOptions: { provider: 'fake', model: 'm' },
        setup: async (agentCtx) => {
          await boot.ctx.agentPresets.mount(agentCtx, 'ops')
        },
      })
      // FACT: the bound preset id is recorded in the session header, so a
      // resume restores the same composition.
      expect(handle.agent.session.header.agentPreset).toBe('ops')
      expect(boot.ctx.agentPresets.composedPreset(handle.agent.ctx)).toBe('ops')

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })
})
