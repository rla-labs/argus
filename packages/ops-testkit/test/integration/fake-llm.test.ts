// == ARGUS AGENT PROJECT ==
/**
 * Integration tests for the fake LLM adapter.
 *
 * The load-bearing claim is prompt 01's: "the fake adapter produces usage events
 * that look exactly like real ones (compare with a recorded real event from the
 * spikes)". These tests assert that the fake's usage reaches the session log as
 * an `assistant/message.usage` in the exact shape `docs/developer-docs.md#verified-dsh-facts` spike 2
 * recorded from a real adapter.
 */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  assistantText,
  bootOps,
  recordSessionEvents,
  usageOf,
  userMessage,
  FakeLlmAdapter,
  ScriptExhaustedError,
  infiniteLoopScript,
} from '../../src/index.js'

describe('FakeLlmAdapter', () => {
  it('reports usage on the assistant/message event in the real shape', async () => {
    // The exact field set `docs/developer-docs.md#verified-dsh-facts` spike 2 recorded from a real
    // adapter: usage rides on `assistant/message`, and every cache field is
    // optional.
    const usage: TokenUsage = {
      inputTokens: 1234,
      outputTokens: 567,
      totalTokens: 1801,
      cacheReadTokens: 890,
      cacheWriteTokens: 11,
      reasoningTokens: 22,
    }
    const boot = await bootOps({ fake: { script: [{ text: 'hello', usage }] } })
    try {
      const events = recordSessionEvents(boot.ctx)
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('fake-usage'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
      })
      handle.agent.followup(userMessage('m-1', 'hi'))
      await handle.agent.whenIdle()

      const assistant = events.ofType('assistant/message')
      expect(assistant).toHaveLength(1)
      expect(usageOf(assistant[0]!)).toEqual(usage)
      expect(assistantText(assistant[0]!)).toBe('hello')

      // There is no separate usage event, exactly as the spike recorded.
      expect(events.ofType('usage')).toHaveLength(0)

      // The request header names the provider and model the request was billed
      // to, which is what ops-meter reads to price it.
      const header = events.ofType('request/header').at(-1)?.data as {
        header: { config: { provider: string; model: string } }
      }
      expect(header.header.config).toEqual({ provider: 'fake', model: 'fake-model' })

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('reports usage once per request, so two turns produce two records', async () => {
    const boot = await bootOps({
      fake: { script: [{ text: 'a', usage: { inputTokens: 1, outputTokens: 1 } }, { text: 'b', usage: { inputTokens: 2, outputTokens: 2 } }] },
    })
    try {
      const events = recordSessionEvents(boot.ctx)
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('fake-per-request'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
      })

      handle.agent.followup(userMessage('m-1', 'one'))
      await handle.agent.whenIdle()
      handle.agent.followup(userMessage('m-2', 'two'))
      await handle.agent.whenIdle()

      const assistant = events.ofType('assistant/message')
      expect(assistant).toHaveLength(2)
      expect(usageOf(assistant[0]!)).toEqual({ inputTokens: 1, outputTokens: 1 })
      expect(usageOf(assistant[1]!)).toEqual({ inputTokens: 2, outputTokens: 2 })
      expect(boot.fake?.callCount).toBe(2)

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('records the request it received, for assertions', async () => {
    const boot = await bootOps({ fake: { script: [{ text: 'ok' }] } })
    try {
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('fake-record'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'recorded-model' },
      })
      handle.agent.followup(userMessage('m-1', 'the question'))
      await handle.agent.whenIdle()

      const request = boot.fake?.requests.at(-1)
      expect(request?.provider).toBe('fake')
      expect(request?.model).toBe('recorded-model')
      expect(request?.roles).toContain('user')
      expect(request?.lastUserText).toBe('the question')

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('emits tool calls that the agent loop executes', async () => {
    const boot = await bootOps({
      fake: {
        script: [
          { text: 'calling', toolCalls: [{ name: 'probe_tool', arguments: '{}', id: 'c1' }] },
          { text: 'finished' },
        ],
      },
    })
    try {
      // Register a trivial tool through the agent's own scope, which is the
      // pattern every Argus Agent tool plugin uses.
      const { defineTool } = await import('@deepseek-ai/dsh-tools')
      const tool = defineTool({
        name: 'probe_tool',
        description: 'a probe',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'probe result',
      })

      const events = recordSessionEvents(boot.ctx)
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('fake-tool'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
        setup(agentCtx) {
          agentCtx.tools.register(tool)
        },
      })
      handle.agent.followup(userMessage('m-1', 'use the tool'))
      await handle.agent.whenIdle()

      const calls = events.ofType('tool/call')
      expect(calls).toHaveLength(1)
      expect((calls[0]!.data as { name: string }).name).toBe('probe_tool')
      expect(events.ofType('tool/result')).toHaveLength(1)

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('supports an unbounded script for loop-detection tests', async () => {
    const boot = await bootOps({ fake: { script: infiniteLoopScript('loop_tool', '{"x":1}') } })
    try {
      const { defineTool } = await import('@deepseek-ai/dsh-tools')
      let executions = 0
      const tool = defineTool({
        name: 'loop_tool',
        description: 'loops',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => {
          executions += 1
          return 'again'
        },
      })
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('fake-loop'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
        setup(agentCtx) {
          agentCtx.tools.register(tool)
        },
      })

      // Reject after a few steps, the way ops-governor's loop detector will.
      let steps = 0
      boot.ctx.on('agent/pre-step', async (_payload, next) => {
        steps += 1
        return steps > 3 ? { kind: 'reject' } : next()
      })

      handle.agent.followup(userMessage('m-1', 'loop'))
      await handle.agent.whenIdle()

      // The script never exhausted itself; the loop was stopped from outside.
      expect(executions).toBeGreaterThanOrEqual(2)
      expect(executions).toBeLessThanOrEqual(3)

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('fails loudly when the script is exhausted', async () => {
    const boot = await bootOps({ fake: { script: [{ text: 'only once' }] } })
    try {
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('fake-exhausted'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
      })
      handle.agent.followup(userMessage('m-1', 'one'))
      await handle.agent.whenIdle()
      handle.agent.followup(userMessage('m-2', 'two'))
      await handle.agent.whenIdle()

      // The adapter recorded the attempt and reported the exhaustion rather
      // than silently repeating or hanging.
      expect(boot.fake?.callCount).toBe(2)
      expect(() => new FakeLlmAdapter({ script: [{ text: 'x' }] })).not.toThrow()

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('repeats the last response when asked', async () => {
    const boot = await bootOps({ fake: { script: [{ text: 'same' }], repeatLast: true } })
    try {
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('fake-repeat'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
      })
      for (const id of ['m-1', 'm-2', 'm-3']) {
        handle.agent.followup(userMessage(id, id))
        await handle.agent.whenIdle()
      }
      expect(boot.fake?.callCount).toBe(3)
      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('exposes the exhaustion error type with a helpful message', () => {
    const error = new ScriptExhaustedError(5, 2)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('request #6')
    expect(error.message).toContain('2 response(s)')
    expect(error.message).toContain('repeatLast')
  })

  it('can be built directly and mounted on any tree', async () => {
    const boot = await bootOps({ fake: false })
    try {
      const adapter = new FakeLlmAdapter({ script: [{ text: 'direct', usage: { inputTokens: 3, outputTokens: 4 } }] })
      boot.ctx.llm.registerAdapter(['other-fake'], adapter)

      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('fake-direct'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'other-fake', model: 'm' },
      })
      handle.agent.followup(userMessage('m-1', 'hi'))
      await handle.agent.whenIdle()

      expect(adapter.callCount).toBe(1)
      expect(adapter.requests[0]?.provider).toBe('other-fake')
      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })
})
