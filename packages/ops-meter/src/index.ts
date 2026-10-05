// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/meter` — real-time token and cost accounting.
 *
 * Listens to every model request, attributes it to exactly one owner, prices it
 * from the `pricing` table in `ops.yaml`, and records it durably. The counters it
 * keeps are what the governor checks on every step.
 *
 * @module @argus-agent/meter
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { Scope } from '@argus-agent/types'
import { scopeOfOwner } from '@argus-agent/types'
import { OpsMeter, type MeterOptions } from './service.js'
import { PriceTable, pricingSectionSchema, pricingTableSchema, type PricingConfig } from './pricing.js'
import { RateLimiter } from './rate-window.js'
import { TimezoneCalendar } from './time.js'
import './events.js'

export * from './pricing.js'
export * from './time.js'
export * from './counters.js'
export * from './rate-window.js'
export * from './service.js'

/** Stable Cordis plugin name. */
export const name = 'ops-meter'

/** The services this plugin requires. */
export const inject = ['opsRawConfig', 'opsConfigRegistry', 'opsStore', 'opsProjects', 'sessions', 'agents']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Argus Agent metering service. */
    opsMeter: OpsMeter
  }
}

/**
 * The `rate_limits` section schema.
 *
 * A dict of `provider → { tokens_per_minute }`. A provider with no entry is
 * unlimited, which is the right default: a limit the operator did not configure
 * must not silently throttle a provider.
 */
const rateLimitsSchema = z
  .dict(
    z.object({
      tokens_per_minute: z.number().min(1),
    }),
  )
  .default({})

/** Extract the per-provider ceilings from a validated section. */
function rateLimitsOf(raw: unknown): Record<string, number> {
  const parsed = (rateLimitsSchema as unknown as (v: unknown) => Record<string, { tokens_per_minute: number }>)(raw ?? {})
  const limits: Record<string, number> = {}
  for (const [provider, spec] of Object.entries(parsed)) {
    if (spec !== null && typeof spec === 'object' && typeof spec.tokens_per_minute === 'number') {
      limits[provider] = spec.tokens_per_minute
    }
  }
  return limits
}

/** Read the model from a session's folded request header, when it has one. */
function modelFromHeader(session: Session): { provider: string; model: string } | undefined {
  const header = session.requestHeader()
  const provider = header?.config.provider
  const model = header?.config.model
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined
}

/** Read the model from an agent's options, when the agent is still live. */
function modelFromAgent(ctx: Context, sessionId: string): { provider: string; model: string } | undefined {
  const agent = ctx.agents.get(sessionId as never)
  const options = agent?.options as { provider?: string; model?: string } | undefined
  return typeof options?.provider === 'string' && typeof options.model === 'string'
    ? { provider: options.provider, model: options.model }
    : undefined
}

/**
 * Mount the meter.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  // `pricing` owns two top-level keys, so it contributes two sections: a
  // deployment that lists prices but never sets a policy is valid.
  const pricingSection = ctx.opsConfigRegistry.extend('pricing', pricingTableSchema)
  const policySection = ctx.opsConfigRegistry.extend(
    'unknown_model_policy',
    z.union([z.const('block'), z.const('warn')]).default('block'),
  )
  const rateSection = ctx.opsConfigRegistry.extend('rate_limits', rateLimitsSchema)
  ctx.effect(() => pricingSection)
  ctx.effect(() => policySection)
  ctx.effect(() => rateSection)

  // Read from the RAW document: this row activates before later plugins register
  // their sections, and reading `ctx.opsConfig` would trigger the cross-section
  // unknown-key check too early.
  const raw = ctx.opsRawConfig
  const pricing = pricingSectionSchema(raw) as unknown as PricingConfig
  const rateLimits = rateLimitsOf(raw['rate_limits'])

  const calendar = new TimezoneCalendar(typeof raw['timezone'] === 'string' ? raw['timezone'] : 'UTC')
  const meter = new OpsMeter(ctx, {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    calendar,
    prices: new PriceTable(pricing),
    rateLimiter: new RateLimiter(rateLimits),
    flushThreshold: 50,
    flushIntervalMs: 5_000,
    now: () => Date.now(),
  } satisfies MeterOptions)

  ctx.provide('opsMeter', meter)
  ctx.effect(() => () => {
    void meter.stop()
  })

  // Seed from the durable record, so a restart does not reset a budget.
  const scopes: Scope[] = ['adhoc', 'orchestrator']
  for (const projectId of ctx.opsProjects.configuredIds()) {
    scopes.push(scopeOfOwner({ kind: 'project', projectId }))
  }
  meter.start(scopes)

  // ── metering ─────────────────────────────────────────────────────────────
  // A settled assistant message carries the request's usage (SPIKES.md spike 2).
  // This is the authoritative source: the stream frame arrives earlier but is
  // transient, and the log event is what the reconciliation compares against.
  ctx.on('session/event', (session, event) => {
    if (meter.isStopped) return
    if (event.type !== 'assistant/message') return
    const data = event.data as { usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } }
    if (data.usage === undefined) return

    const sessionId = session.id as string
    const owner = ctx.opsProjects.ownerOf(sessionId)
    if (owner === undefined) return
    const rootSessionId = ctx.opsProjects.rootSessionOf(sessionId)
    // Prefer the tracked header; fall back to the session's own fold, then to
    // the agent's options. An unknown model is charged zero and reported, which
    // is visible, rather than silently attributed to a wrong price.
    const model =
      meter.modelOf(sessionId) ??
      modelFromHeader(session) ??
      modelFromAgent(ctx, sessionId) ?? { provider: 'unknown', model: 'unknown' }
    const ts = Date.now()

    try {
      meter.record({
        sessionId,
        rootSessionId,
        owner,
        model,
        usage: data.usage,
        runId: ctx.opsProjects.runOf(sessionId),
        ts,
      })
    } catch (error) {
      // An unpriced model under the block policy. The governor refuses the next
      // step; the meter must not crash the event bus for it.
      ctx.logger('ops-meter').warn('could not record usage: %s', (error as Error).message)
    }
  })

  ctx.on('ops/agent-idle', ({ runId }) => {
    if (runId !== undefined) meter.forgetRun(runId)
  })

  // The price table and the rate limits are captured at load, so a change to
  // either needs this row to be reloaded. Nothing to do on a config event.
}
