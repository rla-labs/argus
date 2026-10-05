// == ARGUS AGENT PROJECT ==
/**
 * Spike 3 — step rejection and mid-session model switching.
 *
 * Questions: does an `agent/pre-step` listener returning `{ kind: 'reject' }`
 * close the turn cleanly, what does the log record, and what does
 * `agent/status` do next? Can `agent/request` switch the model mid-session, and
 * under what constraints?
 */
import { describe, expect, it } from 'vitest'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmCallConfig,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootSpike, recordSessionEvents, userMessage } from './harness.js'

/** Counts requests and answers with plain text. */
class CountingAdapter extends LlmAdapter {
  readonly models: string[] = []
  override providerInfo(provider: string) {
    return { id: provider, name: provider, models: [] }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.models.push(options.model ?? 'unknown')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

describe('spike 3: step rejection and model switching', () => {
  it('rejects a step without throwing and closes the turn cleanly', async () => {
    const boot = await bootSpike()
    try {
      const adapter = new CountingAdapter()
      boot.ctx.llm.registerAdapter(['fake'], adapter)

      // Reject the FIRST proposed step only.
      let seen = 0
      boot.ctx.on('agent/pre-step', async (_payload, next) => {
        seen += 1
        if (seen === 1) return { kind: 'reject' }
        return next()
      })

      const statuses: string[] = []
      boot.ctx.on('agent/status', ({ status }) => statuses.push(status))
      const events = recordSessionEvents(boot.ctx)

      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike3-reject'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
      })
      handle.agent.followup(userMessage('m-1', 'do work'))
      // FACT: the turn ends by itself; no exception escapes and `whenIdle`
      // resolves. A rejected step never reaches the model.
      await handle.agent.whenIdle()

      expect(seen).toBe(1)
      expect(adapter.models).toHaveLength(0)
      expect(handle.agent.status).toBe('idle')
      expect(statuses).toEqual(['running', 'idle'])

      // FACT: the log records the turn boundary and the claimed message, but
      // no assistant message and no step/end for a rejected step.
      expect(events.ofType('turn/start').length).toBe(1)
      expect(events.ofType('turn/end').length).toBe(1)
      expect(events.ofType('assistant/message')).toHaveLength(0)
      expect(events.ofType('user/message')).toHaveLength(0)

      const turnEnd = events.ofType('turn/end')[0]?.data as { reason: { kind: string } }
      // FACT: a rejected first step closes the turn as `blocked`.
      expect(turnEnd.reason.kind).toBe('blocked')

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('accepts later steps after a rejection and still answers', async () => {
    const boot = await bootSpike()
    try {
      const adapter = new CountingAdapter()
      boot.ctx.llm.registerAdapter(['fake'], adapter)

      let seen = 0
      boot.ctx.on('agent/pre-step', async (_payload, next) => {
        seen += 1
        // Reject the first turn's step; the next turn proceeds normally.
        if (seen === 1) return { kind: 'reject' }
        return next()
      })

      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike3-resume'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
      })
      handle.agent.followup(userMessage('m-1', 'first'))
      await handle.agent.whenIdle()
      expect(adapter.models).toHaveLength(0)

      handle.agent.followup(userMessage('m-2', 'second'))
      await handle.agent.whenIdle()
      // FACT: rejection is per-step, not sticky. The next turn's step enters.
      expect(adapter.models).toEqual(['m'])

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('switches the model mid-session through agent/request', async () => {
    const boot = await bootSpike()
    try {
      const adapter = new CountingAdapter()
      boot.ctx.llm.registerAdapter(['fake'], adapter)

      let switches = 0
      boot.ctx.on('agent/request', async (_payload, next) => {
        const config: LlmCallConfig = await next()
        switches += 1
        // FACT: `agent/request` is a waterfall over the frozen call config. It
        // runs once per step, after `step/start`, before prompt admission. The
        // returned config replaces the model for THAT request.
        return { ...config, model: config.model === 'primary' ? 'fallback' : config.model }
      })

      const events = recordSessionEvents(boot.ctx)
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike3-switch'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'primary' },
      })
      handle.agent.followup(userMessage('m-1', 'go'))
      await handle.agent.whenIdle()

      // FACT: the switch takes effect on the very request it intercepts.
      expect(switches).toBe(1)
      expect(adapter.models).toEqual(['fallback'])

      // FACT: `agent.options` still reports the original selection; the
      // waterfall does not mutate agent options. A governor that downgrades by
      // returning a replacement config must remember the decision itself.
      expect(handle.agent.options.model).toBe('primary')

      // FACT: the request header records the config actually used, so
      // `usage_events.model` reflects the downgrade.
      const header = events.ofType('request/header').at(-1)?.data as {
        header: { config: { model: string } }
      }
      expect(header.header.config.model).toBe('fallback')

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })
})
