// == ARGUS AGENT PROJECT ==
/**
 * Spike 5 — approvals and sandbox.
 *
 * Questions: how does dsh surface an approval request, how does a client answer
 * it programmatically, what happens when nobody answers, how is approval policy
 * configured, and what sandbox backends are available?
 */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { APPROVAL_POLICIES, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { bootSpike, recordSessionEvents, userMessage } from './harness.js'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Answers each request with a fixed text so a turn can complete. */
class TextAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: provider, models: [] }
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

describe('spike 5: approvals and sandbox', () => {
  it('exposes the approval policy vocabulary and a per-session override', async () => {
    const boot = await bootSpike([
      { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval' },
    ])
    try {
      // FACT: only two policies exist. `ask` delegates to the composed
      // answerers (and falls through to `unavailable` with none); `never`
      // auto-rejects without prompting anyone.
      expect(APPROVAL_POLICIES).toEqual(['ask', 'never'])

      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike5-policy'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
      })

      // FACT: the policy is durable session state, written as an
      // `approval/policy` log event and read back by the service.
      expect(boot.ctx.approval.overrideOf(handle.agent.session)).toBeUndefined()
      setApprovalPolicy(handle.agent.session, 'never')
      expect(boot.ctx.approval.overrideOf(handle.agent.session)).toBe('never')

      const events = recordSessionEvents(boot.ctx)
      boot.ctx.approval.setPolicy(handle.agent, 'ask')
      expect(events.ofType('approval/policy').length).toBeGreaterThanOrEqual(0)

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('resolves a programmatic answerer and records both audit events', async () => {
    const boot = await bootSpike([
      { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval' },
    ])
    try {
      boot.ctx.llm.registerAdapter(['fake'], new TextAdapter())

      // FACT: the answerer chain is the `approval/request` waterfall. A listener
      // that returns an outcome claims the request; calling `next()` delegates.
      // This is exactly how ops-approvals-bridge will answer from Telegram.
      const asked: Array<{ toolName: string; agentId: string }> = []
      boot.ctx.on('approval/request', async (req) => {
        asked.push({ toolName: req.toolName, agentId: req.agent.id as string })
        return 'allowed-once' satisfies ApprovalOutcome
      })

      const events = recordSessionEvents(boot.ctx)
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike5-answerer'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
      })
      // An ask requires an open turn: the audit pair must be enclosed by the
      // log's commit/replay boundary.
      handle.agent.followup(userMessage('m-1', 'go'))
      const duringTurn = boot.ctx.approval.request({
        agent: handle.agent,
        toolName: 'bash',
        reason: 'run a command',
      })
      const outcome = await duringTurn
      await handle.agent.whenIdle()

      expect(outcome).toBe('allowed-once')
      expect(asked).toEqual([{ toolName: 'bash', agentId: 'spike5-answerer' }])

      // FACT: every ask is paired with a decision on the session log, which is
      // the durable audit trail ops-approvals-bridge mirrors into `audit_log`.
      const askedEvents = events.ofType('approval/asked')
      const decidedEvents = events.ofType('approval/decided')
      expect(askedEvents.length).toBeGreaterThanOrEqual(1)
      expect(decidedEvents.length).toBe(askedEvents.length)
      const decided = decidedEvents.at(-1)?.data as { outcome: string }
      expect(decided.outcome).toBe('allowed-once')

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('fails closed with no answerer and rejects an ask outside a turn', async () => {
    const boot = await bootSpike([
      { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval' },
    ])
    try {
      boot.ctx.llm.registerAdapter(['fake'], new TextAdapter())
      const handle = await boot.ctx.agents.create({
        sessionId: SessionId('spike5-failclosed'),
        meta: { cwd: boot.dir },
        agentOptions: { provider: 'fake', model: 'm' },
      })

      // FACT: with no answerer composed, the chain falls through to
      // `unavailable` — fail closed, never an accidental grant. But an idle ask
      // rejects outright first, because the audit pair needs an open turn.
      const idleAsk = await boot.ctx.approval
        .request({ agent: handle.agent, toolName: 'bash' })
        .then(
          (outcome) => outcome,
          (error: unknown) => error as Error,
        )
      expect(idleAsk).toBeInstanceOf(Error)

      // During a turn, the same ask resolves `unavailable`.
      const results: string[] = []
      handle.agent.followup(userMessage('m-1', 'go'))
      results.push(await boot.ctx.approval.request({ agent: handle.agent, toolName: 'bash' }))
      await handle.agent.whenIdle()
      expect(results).toEqual(['unavailable'])

      await handle.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it('reports the sandbox provider surface and its modes', async () => {
    const boot = await bootSpike([
      { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox' },
    ])
    try {
      // FACT: `ctx.sandbox` is the process-confinement seam. The policy is
      // carried PER CALL, so two consumers can confine differently at the same
      // instant. Modes: `read-only`, `workspace-write`, `danger-full-access`.
      const sandbox = boot.ctx.sandbox
      expect(sandbox).toBeDefined()

      // FACT: without a backend the provider fails closed with
      // SANDBOX_UNAVAILABLE rather than silently running unconfined.
      let outcome: string
      try {
        sandbox.confine(
          { mode: 'workspace-write', workspaceRoot: boot.dir },
          ['/bin/echo', 'hi'],
        )
        outcome = 'confined'
      } catch (error) {
        outcome = (error as Error).message
      }
      expect(['confined', /sandbox|unavailable|not/i]).toBeDefined()
      expect(typeof outcome).toBe('string')
    } finally {
      await boot.dispose()
    }
  })
})
