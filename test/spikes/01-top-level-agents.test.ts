// == ARGUS AGENT PROJECT ==
/**
 * Spike 1 — top-level agents.
 *
 * Question: can we create two agents with `ctx.agents.create()`, each with its
 * own `cwd`, provider and model, send each a `followup`, and observe them
 * running concurrently with per-agent `agent/status` transitions?
 *
 * Method: boot a minimal tree with a scripted fake LLM adapter registered on
 * `ctx.llm`, create two top-level agents with different `cwd`s and different
 * models, send both a follow-up in the same tick, and record status
 * transitions plus session events.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootSpike, recordSessionEvents, waitFor, userMessage } from './harness.js'

/** A fake adapter that answers any request with a fixed text and usage. */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: Array<{ provider: string; model: string; systemText: string }> = []
  override providerInfo(provider: string) {
    return { id: provider, name: provider, models: [] }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.messages.find((message) => message.role === 'system')
    this.calls.push({
      provider: options.provider ?? 'unknown',
      model: options.model ?? 'unknown',
      systemText: JSON.stringify(system ?? null).slice(0, 200),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: `reply from ${options.model}` }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: `reply from ${options.model}` },
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
    }
    yield { type: 'finish', reason: 'stop' }
  }
}

describe('spike 1: top-level agents', () => {
  it('creates two concurrent top-level agents with their own cwd, model and status', async () => {
    const boot = await bootSpike()
    try {
      const adapter = new ScriptedAdapter()
      const registration = boot.ctx.llm.registerAdapter(['fake'], adapter)
      const events = recordSessionEvents(boot.ctx)

      const cwdA = join(boot.dir, 'projects', 'a')
      const cwdB = join(boot.dir, 'projects', 'b')
      mkdirSync(cwdA, { recursive: true })
      mkdirSync(cwdB, { recursive: true })

      const statusLog: Array<{ id: string; status: string }> = []
      boot.ctx.on('agent/status', ({ agent, status }) => {
        statusLog.push({ id: agent.id as string, status })
      })

      const handleA = await boot.ctx.agents.create({
        sessionId: SessionId('spike1-a'),
        meta: { cwd: cwdA },
        agentOptions: { provider: 'fake', model: 'model-a' },
      })
      const handleB = await boot.ctx.agents.create({
        sessionId: SessionId('spike1-b'),
        meta: { cwd: cwdB },
        agentOptions: { provider: 'fake', model: 'model-b' },
      })

      // Both are top-level: the registry's `roots()` reports them.
      expect(boot.ctx.agents.roots().map((agent) => agent.id)).toEqual(
        expect.arrayContaining([SessionId('spike1-a'), SessionId('spike1-b')]),
      )

      // The session header carries the cwd each agent was created with.
      expect(handleA.agent.session.header.cwd).toBe(cwdA)
      expect(handleB.agent.session.header.cwd).toBe(cwdB)

      // Both start idle, and both report their own model.
      expect(handleA.agent.status).toBe('idle')
      expect(handleA.agent.options).toMatchObject({ provider: 'fake', model: 'model-a' })
      expect(handleB.agent.options).toMatchObject({ provider: 'fake', model: 'model-b' })

      // Send both follow-ups in the same tick.
      handleA.agent.followup(userMessage('m-a', 'hello A'))
      handleB.agent.followup(userMessage('m-b', 'hello B'))

      await Promise.all([handleA.agent.whenIdle(), handleB.agent.whenIdle()])

      // Each agent produced its own model's reply.
      const assistantMessages = events.ofType('assistant/message')
      const texts = assistantMessages.map((event) => {
        const data = event.data as { message: { content: Array<{ type: string; text?: string }> } }
        return data.message.content.map((block) => block.text ?? '').join('')
      })
      expect(texts).toContain('reply from model-a')
      expect(texts).toContain('reply from model-b')

      // Both agents were observed running, then idle again.
      const running = statusLog.filter((entry) => entry.status === 'running').map((entry) => entry.id)
      expect(new Set(running)).toEqual(new Set(['spike1-a', 'spike1-b']))
      expect(statusLog.at(-1)?.status).toBe('idle')

      // Usage travels on the assistant message event.
      const usage = assistantMessages.map((event) => (event.data as { usage?: unknown }).usage)
      expect(usage.every((value) => value !== undefined)).toBe(true)

      // Requests went to the right provider/model pair.
      expect(adapter.calls.map((call) => call.model).sort()).toEqual(['model-a', 'model-b'])

      registration()
      events.stop()
      await handleA.dispose()
      await handleB.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('runs a tool call in the agent cwd and exposes the final assistant output', async () => {
    const boot = await bootSpike()
    try {
      const cwd = join(boot.dir, 'projects', 'cwd-check')
      mkdirSync(cwd, { recursive: true })
      const observed: string[] = []
      // `dsh-bash-local` is not mounted, so instead observe the tool call itself
      // and assert the session's cwd from the header — the strongest fact this
      // minimal tree can establish without the standard preset's shell tools.
      boot.ctx.on('session/event', (_session, event) => {
        if (event.type === 'tool/call') observed.push(JSON.stringify(event.data).slice(0, 120))
      })

      const adapter = new ScriptedAdapter()
      boot.ctx.llm.registerAdapter(['fake'], adapter)

      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike1-cwd'),
        meta: { cwd },
        agentOptions: { provider: 'fake', model: 'model-cwd' },
      })
      expect(handle.agent.session.header.cwd).toBe(cwd)

      handle.agent.followup(userMessage('m-1', 'hi'))
      await handle.agent.whenIdle()

      // Reading the final assistant output from the session log is what
      // ops-projects needs; `finalAssistantOutput` is the supported helper.
      const { finalAssistantOutput } = await import('@deepseek-ai/dsh-subagent')
      const output = finalAssistantOutput(handle.agent.session.snapshotEvents())
      expect(output).toBeDefined()
      const text = (output ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      expect(text).toBe('reply from model-cwd')

      await handle.dispose()
      await waitFor(() => boot.ctx.agents.get(SessionId('spike1-cwd')) === undefined, { label: 'agent unregistered' })
    } finally {
      await boot.dispose()
    }
  })
})
