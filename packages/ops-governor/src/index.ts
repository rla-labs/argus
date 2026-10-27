// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/governor` — the only path to execution.
 *
 * It claims the delivery capability from `ops-projects`, wires the pure decision
 * functions to dsh's events, and owns the dispatcher, the budgets and the kill
 * switch.
 *
 * @module @argus-agent/governor
 */
import type { Context } from '@deepseek-ai/cordis'
import { OpsGovernor, type GovernorOptions } from './service.js'
import { governorConfigOf, budgetsSchema, concurrencySchema, judgeSchema, limitsSchema, queuesSchema, pausedPolicySchema } from './config.js'
import './events.js'
import { registerAskProject } from './ask-project.js'

export * from './config.js'
export * from './state.js'
export * from './decide.js'
export * from './service.js'
export * from './judge.js'

/** Stable Cordis plugin name. */
export const name = 'ops-governor'

/**
 * The services this plugin requires.
 *
 * `opsMeter` is required rather than optional: without a price table the
 * governor cannot tell a priced model from an unpriced one, and admitting an
 * unpriced model is exactly the leak `block` exists to prevent.
 */
export const inject = ['opsRawConfig', 'opsConfigRegistry', 'opsStore', 'opsProjects', 'opsMeter', 'agents', 'tools', 'llm']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Argus Agent governor: the only path to execution. */
    opsGovernor: OpsGovernor
  }
}

/**
 * Mount the governor.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  const raw = ctx.opsRawConfig
  const config = governorConfigOf(raw)

  // The sections are registered so a typo in `ops.yaml` is reported by the
  // bundle's validation, and so `docs/developer-docs.md#configuration-reference` has a schema to point at.
  const concurrency = ctx.opsConfigRegistry.extend('concurrency', concurrencySchema)
  const budgets = ctx.opsConfigRegistry.extend('budgets', budgetsSchema)
  const limits = ctx.opsConfigRegistry.extend('limits', limitsSchema)
  const queues = ctx.opsConfigRegistry.extend('queues', queuesSchema)
  const paused = ctx.opsConfigRegistry.extend('paused_policy', pausedPolicySchema)
  const judge = ctx.opsConfigRegistry.extend('judge', judgeSchema)
  for (const section of [concurrency, budgets, limits, queues, paused, judge]) {
    ctx.effect(() => section)
  }

  // ADR 0002 in code: the governor claims the delivery capability, so no other
  // plugin can call `opsProjects.deliver()` without asking for it by name.
  const capability = ctx.opsProjects.claimDelivery(name)

  const governor = new OpsGovernor(ctx, {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    meter: ctx.opsMeter,
    config,
    capability,
    now: () => Date.now(),
  } satisfies GovernorOptions)

  ctx.provide('opsGovernor', governor)
  registerAskProject(ctx, governor)
  // The steps of agents extensions run for a project (Claude Code), on their host channel.
  ctx.effect(() => ctx.opsProjects.hostHandle('step', (call) => governor.delegatedStep(call)))
  ctx.effect(() => ctx.opsProjects.hostHandle('usage', (call) => governor.delegatedUsage(call)))
  // What extensions' agents ask of a provider through Argus's routes (Codex): admitted and counted here.
  ctx.effect(() => ctx.opsProjects.setRouteGovernor({ admit: (call) => governor.routeAdmit(call), usage: (call) => governor.routeUsage(call) }))
  ctx.effect(() => () => {
    governor.dispose()
  })

  // ── startup recovery ─────────────────────────────────────────────────────
  const recovery = governor.recover()
  if (recovery.interrupted > 0) {
    ctx.logger('ops-governor').warn('marked %d interrupted run(s)', recovery.interrupted)
  }
  if (governor.isPanic) {
    ctx.logger('ops-governor').warn('panic mode restored; call resumeAll() to continue')
  }
  governor.requestDispatch()

  // ── budget re-evaluation ─────────────────────────────────────────────────
  ctx.on('ops/usage', ({ scope }) => {
    governor.onUsage(scope)
  })

  // ── slot accounting ──────────────────────────────────────────────────────
  ctx.on('ops/agent-running', ({ owner, sessionId }) => {
    governor.onAgentRunning(sessionId)
    void owner
  })

  ctx.on('ops/agent-idle', ({ sessionId }) => {
    governor.onAgentIdle(sessionId)
  })

  // ── step enforcement ─────────────────────────────────────────────────────
  // A waterfall: returning `{ kind: 'reject' }` closes the turn cleanly, which
  // is the only way to stop a run at a step boundary (SPIKES.md spike 3).
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    const sessionId = agent.id as string
    // Only a governed run is stopped. An agent the governor never admitted —
    // a test's, or another plugin's — must not be halted by a budget that is not
    // its own, so the decided step passes through untouched.
    if (!governor.isGoverned(sessionId)) return decision
    // A no-progress check may be looking at the folder: the step waits for its answer.
    await governor.settle(sessionId)
    // At a checkpoint this waits for the answer; the turn's signal ends the wait on a stop.
    return (await governor.preStep(sessionId, signal)).kind === 'reject' ? { kind: 'reject' } : decision
  })

  // ── model downgrade ──────────────────────────────────────────────────────
  // A waterfall over the frozen call config. Returning a replacement switches the
  // model for that request only; `agent.options` keeps the original (spike 3).
  if (process.env['OPS_GOV_NO_REQUEST_HOOK'] !== '1') ctx.on('agent/request', async ({ agent }, next) => {
    // `next()` is awaited FIRST, so the downstream config is resolved before any
    // decision. The decision itself is wrapped: this hook sits on the critical
    // path of every model call, and a throw here would hang the turn rather than
    // fail it — an audit write failing must not stop a run.
    const config = await next()
    try {
      const replacement = governor.requestModel(agent.id as string, {
        provider: config.provider,
        model: config.model,
      })
      return replacement === undefined ? config : { ...config, ...replacement }
    } catch (error) {
      ctx.logger('ops-governor').warn('downgrade check failed: %s', (error as Error).message)
      return config
    }
  })

  // ── tool-call observation, for loop detection ────────────────────────────
  // `tool/call` carries the name and the raw argument JSON. Reading it here
  // rather than from an assembled message keeps loop detection close to the
  // event that caused it.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      // The agent's own words, which the loop checker sees as untrusted data.
      const content = (event.data as { message?: { content?: ReadonlyArray<{ type?: string; text?: unknown }> } }).message?.content ?? []
      governor.noteAssistantText(session.id as string, content.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n'))
      return
    }
    if (event.type === 'tool/result') {
      const message = (event.data as { message?: { toolCallId?: string; content?: unknown; isError?: boolean } }).message
      if (typeof message?.toolCallId === 'string') governor.noteToolResult(session.id as string, message.toolCallId, resultText(message.content), message.isError === true)
      return
    }
    if (event.type !== 'tool/call') return
    const data = event.data as { name?: string; arguments?: string; callId?: string }
    if (typeof data.name !== 'string') return
    governor.noteToolCall(session.id as string, data.name, data.arguments ?? '', typeof data.callId === 'string' ? data.callId : undefined)
  })
}

/**
 * A tool result's content as text: its text blocks, and any other block serialized.
 *
 * @param content the result message's content blocks.
 * @returns the text.
 */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content
    .map((block: { type?: string; text?: unknown }) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify(block)))
    .join('\n')
}
