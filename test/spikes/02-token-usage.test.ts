// == ARGUS AGENT PROJECT ==
/**
 * Spike 2 — token usage.
 *
 * Question: where exactly does token usage appear, which fields does it carry,
 * is it per request or per turn, and does a subagent's usage land in the child's
 * session or the parent's? How do we walk from a child session to its root?
 *
 * Method: a fake adapter that reports a known usage triple; record every
 * session event and every `agent/assistant-stream` frame; then create a
 * subagent and compare the two sessions' logs.
 */
import { describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootSpike, recordSessionEvents, waitFor, userMessage } from './harness.js'

/** Reports a fixed, distinctive usage triple on every request. */
class UsageAdapter extends LlmAdapter {
  requests = 0
  constructor(private readonly usage: TokenUsage) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: provider, models: [] }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: 'stop' }
  }
}

describe('spike 2: token usage', () => {
  it('carries usage on the assistant/message event, once per request', async () => {
    const boot = await bootSpike()
    try {
      const usage: TokenUsage = {
        inputTokens: 1234,
        outputTokens: 567,
        cacheReadTokens: 890,
        cacheWriteTokens: 11,
        reasoningTokens: 22,
        totalTokens: 1801,
      }
      const adapter = new UsageAdapter(usage)
      boot.ctx.llm.registerAdapter(['fake'], adapter)

      const frames: Array<{ type: string; chunkType?: string }> = []
      boot.ctx.on('agent/assistant-stream', ({ frame }) => {
        frames.push(
          frame.type === 'chunk'
            ? { type: frame.type, chunkType: frame.chunk.type }
            : { type: frame.type },
        )
      })

      const events = recordSessionEvents(boot.ctx)
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike2-usage'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'usage-model' },
      })
      handle.agent.followup(userMessage('m-1', 'hello'))
      await handle.agent.whenIdle()

      // FACT: usage is a field of the `assistant/message` session event, not a
      // separate event type. There is no `usage` event in the session log.
      const assistantEvents = events.ofType('assistant/message')
      expect(assistantEvents).toHaveLength(1)
      const data = assistantEvents[0]?.data as { usage?: TokenUsage }
      expect(data.usage).toEqual(usage)
      expect(events.ofType('usage')).toHaveLength(0)

      // FACT: the raw `usage` StreamChunk reaches `agent/assistant-stream`
      // before settlement, so a live listener can meter without waiting for the
      // log write. One `usage` chunk per request.
      expect(frames.filter((frame) => frame.chunkType === 'usage')).toHaveLength(1)

      // FACT: usage is per model request. Two turns produce two events.
      handle.agent.followup(userMessage('m-2', 'again'))
      await handle.agent.whenIdle()
      expect(events.ofType('assistant/message')).toHaveLength(2)
      expect(adapter.requests).toBe(2)

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('exposes the request header with provider and model per request', async () => {
    const boot = await bootSpike()
    try {
      boot.ctx.llm.registerAdapter(
        ['fake'],
        new UsageAdapter({ inputTokens: 1, outputTokens: 1 }),
      )
      const events = recordSessionEvents(boot.ctx)
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike2-header'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'header-model' },
      })
      handle.agent.followup(userMessage('m-1', 'hi'))
      await handle.agent.whenIdle()

      const headers = events.ofType('request/header')
      expect(headers.length).toBeGreaterThan(0)
      const header = headers.at(-1)?.data as { header: { config: { provider: string; model: string } } }
      // FACT: the request header is where a meter reads which model was billed.
      // It carries no usage; usage stays on the assistant message.
      expect(header.header.config.provider).toBe('fake')
      expect(header.header.config.model).toBe('header-model')

      // FACT: the folded header is readable synchronously from the session.
      const folded = handle.agent.session.requestHeader()
      expect(folded?.config.model).toBe('header-model')

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('attributes a subagent session to its parent by walking parentSession', async () => {
    // `ctx.subagents` is the seam whose depth config the governor reads; a
    // concrete provider is not needed to create a child with `parentAgent`.
    const boot = await bootSpike([{ id: 'subagent', name: '@deepseek-ai/dsh-subagent' }])
    try {
      boot.ctx.llm.registerAdapter(
        ['fake'],
        new UsageAdapter({ inputTokens: 10, outputTokens: 5 }),
      )
      const parent = await boot.ctx.agents.create({
        sessionId: SessionId('spike2-parent'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'parent-model' },
      })

      // FACT: a child created with `parentAgent` records `parentSession` in its
      // header, which is the durable lineage the meter walks to the root.
      const child = await boot.ctx.agents.create({
        sessionId: SessionId('spike2-child'),
        parentAgent: parent.agent,
        meta: { cwd: boot.dir, parentSession: parent.agent.session.id, origin: 'subagent', delegationDepth: 1 },
        agentOptions: { provider: 'fake', model: 'child-model' },
      })

      expect(child.agent.session.header.parentSession).toBe(parent.agent.session.id)
      expect(child.agent.session.header.delegationDepth).toBe(1)

      // FACT: `roots()` excludes the child; `list()` includes it. Top-level
      // detection is a runtime relation, not a durable one.
      expect(boot.ctx.agents.roots().map((agent) => agent.id)).toContain(parent.agent.id)
      expect(boot.ctx.agents.roots().map((agent) => agent.id)).not.toContain(child.agent.id)
      expect(boot.ctx.agents.list().map((agent) => agent.id)).toContain(child.agent.id)
      expect(boot.ctx.agents.isOwnedBy(child.agent.id, parent.agent)).toBe(true)

      const childEvents = recordSessionEvents(boot.ctx)
      child.agent.followup(userMessage('m-child', 'child work'))
      await child.agent.whenIdle()

      // FACT: the child's usage lands in the CHILD's session, not the parent's.
      // A meter that only listened to the parent would lose it; attribution must
      // resolve the root through `parentSession`.
      const childAssistant = childEvents
        .ofType('assistant/message')
        .filter((event) => event.sessionId === (child.agent.id as string))
      expect(childAssistant).toHaveLength(1)
      const childUsage = (childAssistant[0]?.data as { usage?: TokenUsage }).usage
      expect(childUsage).toEqual({ inputTokens: 10, outputTokens: 5 })

      await child.dispose()
      await parent.dispose()
      await waitFor(() => boot.ctx.agents.get(SessionId('spike2-child')) === undefined, {
        label: 'child disposed',
      })
    } finally {
      await boot.dispose()
    }
  })
})
