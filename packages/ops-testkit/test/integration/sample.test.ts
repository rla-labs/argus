// == ARGUS AGENT PROJECT ==
/**
 * Prompt 01's Definition of Done, as an executable test.
 *
 * "A sample integration test boots dsh with the fake adapter, runs one agent
 * turn, and asserts on the recorded usage."
 *
 * This is also the reference example every later plugin's integration test
 * follows, so it is written the way a real test should be.
 */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assistantText,
  bootOps,
  recordSessionEvents,
  usageOf,
  userMessage,
} from '../../src/index.js'

describe('sample integration test', () => {
  it('boots dsh with the fake adapter, runs one turn, and asserts on the usage', async () => {
    // 1. Boot a real dsh composition in a temporary directory. The fake adapter
    //    is registered on `ctx.llm` under provider `fake`.
    const boot = await bootOps({
      fake: {
        script: [
          {
            text: 'The answer is 42.',
            usage: { inputTokens: 1500, outputTokens: 250, cacheReadTokens: 1000 },
          },
        ],
      },
    })

    try {
      // 2. Record every session event, which is how a meter sees usage.
      const events = recordSessionEvents(boot.ctx)

      // 3. Create a top-level agent — the shape every Argus Agent project uses:
      //    its own cwd, its own model, a preset mounted in `setup`.
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('sample-1'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
      })

      // 4. Run exactly one turn.
      handle.agent.followup(userMessage('m-1', 'What is the answer?'))
      await handle.agent.whenIdle()

      // 5. Assert on the recorded usage.
      const assistant = events.ofType('assistant/message')
      expect(assistant).toHaveLength(1)

      expect(usageOf(assistant[0]!)).toEqual({
        inputTokens: 1500,
        outputTokens: 250,
        cacheReadTokens: 1000,
      })

      // The answer itself, extracted the way `ops-projects` will extract a run's
      // final output.
      expect(assistantText(assistant[0]!)).toBe('The answer is 42.')

      // The request header names the billed provider/model, which is what
      // `ops-meter` reads to price the request.
      const header = events.ofType('request/header').at(-1)?.data as {
        header: { config: { provider: string; model: string } }
      }
      expect(header.header.config).toEqual({ provider: 'fake', model: 'fake-model' })

      // The adapter saw exactly one request: one turn, one billed call.
      expect(boot.fake?.callCount).toBe(1)
      expect(boot.fake?.requests[0]?.lastUserText).toBe('What is the answer?')

      // 6. The agent returned to idle, so a governor would release its slot.
      expect(handle.agent.status).toBe('idle')
      expect(handle.agent.session.header.cwd).toBe(boot.dir)

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('supports a multi-step turn whose usage accumulates per request', async () => {
    // The fixture for a cost test: one turn, two model requests, each priced
    // separately. `ops-meter` must attribute both to the same run.
    const boot = await bootOps({
      fake: {
        script: [
          { text: 'thinking', toolCalls: [{ name: 'echo_tool', arguments: '{}', id: 'c1' }], usage: { inputTokens: 100, outputTokens: 10 } },
          { text: 'done', usage: { inputTokens: 200, outputTokens: 20 } },
        ],
      },
    })
    try {
      const { defineTool } = await import('@deepseek-ai/dsh-tools')
      const tool = defineTool({
        name: 'echo_tool',
        description: 'echoes',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => 'echoed',
      })

      const events = recordSessionEvents(boot.ctx)
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('sample-multi'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'fake-model' },
        setup(agentCtx) {
          agentCtx.tools.register(tool)
        },
      })
      handle.agent.followup(userMessage('m-1', 'do it'))
      await handle.agent.whenIdle()

      const assistant = events.ofType('assistant/message')
      expect(assistant).toHaveLength(2)
      const totalInput = assistant.reduce((sum, event) => sum + (usageOf(event)?.inputTokens ?? 0), 0)
      const totalOutput = assistant.reduce((sum, event) => sum + (usageOf(event)?.outputTokens ?? 0), 0)
      expect(totalInput).toBe(300)
      expect(totalOutput).toBe(30)

      // Both requests happened inside ONE turn, which is why per-run limits must
      // be checked at step boundaries rather than only between turns.
      expect(events.ofType('turn/start')).toHaveLength(1)
      expect(events.ofType('step/start')).toHaveLength(2)

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })
})
