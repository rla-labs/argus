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
import type { ModelRef, Scope } from '@argus-agent/types'
import { parseModelRef, scopeOfOwner } from '@argus-agent/types'
import { OpsMeter, type MeterOptions } from './service.js'
import { PriceTable, localProvidersSchema, pricingSectionSchema, pricingTableSchema, type PricingConfig } from './pricing.js'
import { SNAPSHOT } from './catalog-snapshot.js'
import { providerCatalogPrice } from './provider-catalog.js'
import { PriceRefresher } from './refresh.js'
import { RateLimiter } from './rate-window.js'
import { TimezoneCalendar } from './time.js'
import './events.js'

export * from './pricing.js'
export * from './catalog.js'
export * from './refresh.js'
export { SNAPSHOT as PRICE_CATALOG } from './catalog-snapshot.js'
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
/** A section's `model: provider/model`, or `undefined`. */
function sectionModel(section: unknown): ModelRef | undefined {
  const text = (section as { model?: unknown } | undefined)?.model
  return typeof text === 'string' ? parseModelRef(text) : undefined
}

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
  const localSection = ctx.opsConfigRegistry.extend('local_providers', localProvidersSchema)
  const refreshSection = ctx.opsConfigRegistry.extend('price_refresh', z.boolean().default(true))
  ctx.effect(() => refreshSection)
  ctx.effect(() => pricingSection)
  ctx.effect(() => policySection)
  ctx.effect(() => rateSection)
  ctx.effect(() => localSection)

  // Read from the RAW document: this row activates before later plugins register
  // their sections, and reading `ctx.opsConfig` would trigger the cross-section
  // unknown-key check too early.
  const raw = ctx.opsRawConfig
  const pricing = {
    ...(pricingSectionSchema(raw) as unknown as PricingConfig),
    local_providers: localProvidersSchema(raw['local_providers']) as unknown as string[],
  }
  const rateLimits = rateLimitsOf(raw['rate_limits'])

  const meterPrices = new PriceTable(pricing, SNAPSHOT, providerCatalogPrice)
  const calendar = new TimezoneCalendar(typeof raw['timezone'] === 'string' ? raw['timezone'] : 'UTC')
  // Prices saved by earlier refreshes apply at once; the refresh itself runs on a
  // timer, so the network never delays a boot or a request.
  const refresher = new PriceRefresher({
    store: ctx.opsStore,
    prices: meterPrices,
    now: () => Date.now(),
    fetch: globalThis.fetch,
    log: { info: (m) => ctx.logger('ops-meter').info('%s', m), warn: (m) => ctx.logger('ops-meter').warn('%s', m) },
    watched: () => [
      ...ctx.opsProjects
        .configuredIds()
        .map((id) => ctx.opsProjects.configOf(id))
        .filter((config) => config !== undefined)
        .map((config) => ({ provider: config.provider, model: config.model })),
      // The ad-hoc and orchestrator models run too, before any project exists.
      ...[sectionModel(raw['tasks']), sectionModel(raw['orchestrator'])].filter((ref) => ref !== undefined),
    ],
    onChanges: (changes) => ctx.emit('ops/prices-changed', { changes }),
    // A project refused for want of a price comes back once one arrives.
    onApplied: () => ctx.opsProjects.recheckModels(),
  })
  const meter = new OpsMeter(ctx, {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    calendar,
    prices: meterPrices,
    rateLimiter: new RateLimiter(rateLimits),
    flushThreshold: 50,
    flushIntervalMs: 5_000,
    now: () => Date.now(),
    ...(raw['price_refresh'] === false
      ? {}
      : { ensurePriced: (model: ModelRef) => refresher.refreshCeilings(false, model) }),
  } satisfies MeterOptions)

  ctx.provide('opsMeter', meter)

  refresher.load()
  if (raw['price_refresh'] !== false) {
    const stop = refresher.start()
    ctx.effect(() => stop)
  } else {
    ctx.logger('ops-meter').info('price refresh is off (price_refresh: false); using the catalog from %s', meterPrices.catalogInfo?.retrievedAt ?? 'the release')
  }

  // A model with no price cannot run under `block`, so it is refused at configuration
  // time — the project is invalid, `/new` refuses it — not at its first request.
  if (meterPrices.unknownPolicy === 'block') {
    ctx.effect(() =>
      ctx.opsProjects.addModelCheck((model) =>
        meterPrices.isPriced(model)
          ? undefined
          : {
              code: 'UNPRICED_MODEL',
              message: `${model.provider}/${model.model} has no price; add it to pricing in ops.yaml (USD per million tokens)`,
            },
      ),
    )
  }

  warnAboutProjectModels(ctx, meter)
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

/**
 * Tell the operator, at boot, about a project whose model cannot run as expected:
 * unpriced (refused under `block`), retired by its provider, or free and not yet
 * confirmed. The governor refuses the first and the last with the same reason;
 * this says it before anyone sends a message.
 *
 * @param ctx the plugin's context.
 * @param meter the meter.
 */
function warnAboutProjectModels(ctx: Context, meter: OpsMeter): void {
  const logger = ctx.logger('ops-meter')
  const info = meter.catalogInfo
  logger.info(
    'price catalog: %s (%s), retrieved %s',
    info?.title ?? SNAPSHOT.meta.title,
    info?.license ?? SNAPSHOT.meta.license,
    info?.retrievedAt ?? SNAPSHOT.meta.retrievedAt,
  )
  for (const id of ctx.opsProjects.configuredIds()) {
    const config = ctx.opsProjects.configOf(id)
    if (config === undefined) continue
    const model = { provider: config.provider, model: config.model }
    const price = meter.priceOf(model)
    const name = `${config.provider}/${config.model}`
    if (price === undefined) {
      logger.warn('project %s uses %s, which has no price: add it to `pricing` in ops.yaml', id, name)
    } else if (price.status === 'retired') {
      logger.warn('project %s uses %s, which its provider has retired; requests to it will likely fail', id, name)
    } else if (meter.needsFreeConfirmation(model)) {
      logger.warn('project %s uses %s, which is free and not yet confirmed: send /allow-free %s', id, name, name)
    }
  }
}

