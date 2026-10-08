// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/approvals-bridge` — approvals on Telegram.
 *
 * It composes into dsh's `approval/request` **waterfall**: returning an outcome
 * claims the request, and `next()` delegates (SPIKES.md spike 5). Every path
 * returns an outcome — never a throw — so a failure inside the bridge becomes a
 * refusal rather than an exception in dsh's chain.
 *
 * @module @argus-agent/approvals-bridge
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: brings in the `ctx.approval` augmentation.
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: brings in the `tools/pre-execute` event.
import type {} from '@deepseek-ai/dsh-tools'
import { approvalsOf, approvalsSchema } from './config.js'
import { OpsApprovalsBridge, type BridgeRequest } from './service.js'

export * from './argv.js'
export * from './config.js'
export * from './policy.js'
export * from './question.js'
export * from './service.js'

/** Stable Cordis plugin name. */
export const name = 'ops-approvals-bridge'

/**
 * The services this plugin requires.
 *
 * `approval` is the seam it answers on. `opsProjects` resolves which project and
 * run a request belongs to, and `opsChannel` is how a question reaches a person.
 */
export const inject = [
  'opsRawConfig',
  'opsConfigRegistry',
  'opsStore',
  'opsProjects',
  'opsGovernor',
  'opsChannel',
  'approval',
]

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The bridge, once the plugin is mounted. */
    opsApprovals: OpsApprovalsBridge
  }
}

/**
 * Mount the bridge.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  const section = ctx.opsConfigRegistry.extend('approvals', approvalsSchema)
  ctx.effect(() => section)

  const config = approvalsOf(ctx.opsRawConfig)
  const logger = ctx.logger('ops-approvals')

  if (!config.enabled) {
    // Not mounted means no answerer, which means dsh's chain falls through to
    // `'unavailable'` — a refusal. Disabling the bridge is safe by construction.
    logger.info('the approvals bridge is disabled; requests will be refused')
    return
  }

  const bridge = new OpsApprovalsBridge(ctx, {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    governor: ctx.opsGovernor,
    channel: ctx.opsChannel,
    config,
    now: () => Date.now(),
  })

  ctx.provide('opsApprovals', bridge)

  /**
   * The answerer.
   *
   * A waterfall listener: returning an outcome claims the request, and `next()`
   * delegates to the rest of the chain. With nothing composed the chain falls
   * through to `'unavailable'`, which is dsh's own fail-closed default.
   */
  ctx.on('approval/request', async function (this: unknown, request, next) {
    return bridge.handle(request as BridgeRequest, next)
  })

  /**
   * The trigger. dsh asks for approval only when a `tools/pre-execute` listener
   * answers `ask`; the bridge's gate does, for commands and file writes.
   */
  ctx.on('tools/pre-execute', async (exec, next) => bridge.gate(exec) ?? next())

  logger.info(
    'approvals ready: ad-hoc policy=%s, timeout=%d minute(s), run grants=%s',
    config.approvals_adhoc,
    config.timeout_minutes,
    config.allow_run_grant ? 'on' : 'off',
  )

  // A finished run's grants are dropped, so a long-lived process does not
  // accumulate authority for runs that are over.
  ctx.on('ops/agent-idle', (payload) => {
    if (payload.runId !== undefined) bridge.forgetRun(payload.runId)
  })
}
