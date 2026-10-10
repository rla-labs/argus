// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/channel` — the channel abstraction.
 *
 * All routing and access control live here, so a platform adapter
 * (`ops-telegram`, a future `slack`, the test `console`) only translates between
 * its platform and the types in `@argus-agent/types`.
 *
 * @module @argus-agent/channel
 */
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChannelAddress, Owner } from '@argus-agent/types'
import { pathsOf } from '@argus-agent/argus-agent'
import { OpsChannel, type ChannelOptions } from './service.js'
import { accessOf, accessSchema, adminOf, allowedWithAdmin, channelOf, channelSchema, parseAddress } from './config.js'
import { progressText, type OutputSubject } from './format.js'
import './events.js'

export * from './access.js'
export * from './config.js'
export * from './format.js'
export * from './registry.js'
export * from './routing.js'
export * from './service.js'

/** Stable Cordis plugin name. */
export const name = 'ops-channel'

/**
 * The services this plugin requires.
 *
 * `opsCommands` is required: a channel that cannot run a command would deliver
 * free text and nothing else, which is not the contract.
 */
export const inject = ['opsConfigRegistry', 'opsRawConfig', 'opsStore', 'opsProjects', 'opsMeter', 'opsGovernor', 'opsCommands', 'tools']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Argus Agent channel service. */
    opsChannel: OpsChannel
  }
}

/**
 * Mount the channel.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  // Both sections are contributed to the registry, so ops.yaml validates them and
  // the boot check does not report them as unknown keys.
  const accessSection = ctx.opsConfigRegistry.extend('access', accessSchema)
  const channelSection = ctx.opsConfigRegistry.extend('channel', channelSchema)
  ctx.effect(() => () => {
    accessSection()
    channelSection()
  })

  const raw = ctx.opsRawConfig
  const access = accessOf(raw)
  const channel = channelOf(raw)
  // The service resolves a relative scratch path against this, so a configured
  // name never depends on the process's working directory.
  const pathsOfDir = pathsOf(raw).dataDirAbs

  const admin = adminOf(access.admin)
  // Unaddressed output goes to the admin unless another address is configured.
  const defaultAddress = parseAddress(channel.default_address) ?? admin

  // Notices are fire-and-forget. A send the channel refuses (a revoked token, a
  // blocked bot) is logged; unhandled, it would take the whole process down.
  const logger = ctx.logger('ops-channel')
  const fire = (delivery: Promise<unknown>): void => {
    delivery.catch((error: unknown) => {
      logger.warn('a notice was not delivered: %s', error instanceof Error ? error.message : String(error))
    })
  }

  // Resolved LIVE rather than captured: `ops-orchestrator` may be mounted after
  // this plugin, and a captured `undefined` would make the channel answer "I do
  // not know where that goes" for the rest of the process. `ctx.get` is cheap.
  const orchestratorOf = (): unknown => ctx.get('opsOrchestrator' as never)

  const service = new OpsChannel({
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    meter: ctx.opsMeter,
    governor: ctx.opsGovernor,
    commands: ctx.opsCommands,
    access: {
      allowed_users: allowedWithAdmin(access.allowed_users, admin),
      admin,
      warnIntervalMs: access.warn_interval_minutes * 60_000,
    },
    channel,
    scratchDir: resolveScratch(channel.attachment_scratch, pathsOfDir),
    hasOrchestrator: () => orchestratorOf() !== undefined,
    onButtonAnswer: (answer) => {
      ctx.emit('ops/channel-button', {
        value: answer.value,
        userId: answer.userId,
        questionId: answer.questionId,
        address: answer.address,
      })
    },
    now: () => Date.now(),
    orchestratorInput: (input) => {
      // Always the event: its handler in ops-orchestrator sends the reply and catches
      // a failed turn. Calling the service here dropped both, and a failed turn
      // became an unhandled rejection that stopped the process.
      ctx.emit('ops/orchestrator-input', input)
    },
  } satisfies ChannelOptions)

  // Re-emitted from the service, which has no context of its own. A press that got
  // this far passed the allowlist and was not a confirmation or a command, so it
  // belongs to whoever offered the button.
  service.configuredDefault = defaultAddress
  ctx.provide('opsChannel', service)

  if (service.access.isEmpty) {
    ctx
      .logger('ops-channel')
      .warn('neither access.admin nor access.allowed_users is configured: every incoming message will be refused')
  }

  ctx.effect(() => () => {
    void service.dispose()
  })

  // ── a run's output, delivered ────────────────────────────────────────────
  ctx.on('ops/run-output', ({ owner, runId, content }) => {
    const subject = subjectOf(owner)
    // The request's address is the durable record; the event has no address of
    // its own, so the inbound row is read for it.
    const replyTo = addressForRun(ctx, runId)
    if (replyTo !== undefined) service.rememberReplyTo(runId, replyTo)
    ctx.emit('ops/channel-output', { owner, runId, content })
    fire(service.deliverRunOutput(runId, subject, content))
  })

  // ── run lifecycle notices ────────────────────────────────────────────────
  ctx.on('ops/run-stopped', ({ owner, runId, reason, detail }) => {
    fire(service.deliverStopped(runId, subjectOf(owner), reason, detail))
  })

  ctx.on('ops/run-interrupted', ({ owner, runId }) => {
    fire(service.deliverInterrupted(runId, subjectOf(owner)))
  })

  // ── budget and queue notices ─────────────────────────────────────────────
  ctx.on('ops/budget-threshold', ({ scope, level, pct, spentMicros, limitMicros }) => {
    fire(service.deliverThreshold(scope, level, pct, spentMicros, limitMicros))
  })

  ctx.on('ops/queue-stalled', ({ requestId, owner, waitedMs, reason }) => {
    const projectId = owner !== undefined && owner.kind === 'project' ? owner.projectId : null
    fire(service.deliverStalled(requestId, projectId, waitedMs, reason))
  })

  ctx.on('ops/panic', ({ cancelled, tookMs }) => {
    fire(service.deliverPanic(cancelled, tookMs))
  })

  // ── refusals: the sender hears why ───────────────────────────────────────
  // A panic is announced once by `ops/panic`; one message per queued request on
  // top of it would be noise.
  ctx.on('ops/request-rejected', ({ requestId, code, message }) => {
    if (code === 'PANIC_MODE') return
    fire(service.deliverRejected(addressForRun(ctx, requestId), code, message))
  })

  // ── prices that moved under a model in use ───────────────────────────────
  ctx.on('ops/prices-changed', ({ changes }) => {
    fire(service.deliverPricesChanged(changes))
  })

  // ── project files that do not validate ───────────────────────────────────
  ctx.on('ops/projects-invalid', ({ invalid, fixed }) => {
    fire(service.deliverInvalidProjects(invalid, fixed))
  })

  // `ops/schedule-skipped` arrives with `ops-scheduler` (prompt 10), which
  // declares the event. The delivery method already exists, so wiring it is one
  // line at that point.
  // ── send_file ────────────────────────────────────────────────────────────
  // Global, so a task's agent has it too: tasks are never composed, so a scoped
  // tool could not reach them. The owner comes from the calling agent (rule 6).
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'send_file',
        description:
          'Send files from your folder to the person, as an attachment in the chat this work came from. ' +
          'One file goes as it is; several files, or a folder, are zipped into one archive for you. Never build an archive yourself.',
        parameters: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders, relative to your folder.', required: true },
          caption: { type: 'string', description: 'Optional short text sent with the file.' },
        },
        output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
        execute: async (args, exec) => {
          const input = args as { paths?: unknown; caption?: unknown }
          const owner = exec.agent === undefined ? undefined : ctx.opsProjects.ownerOf(exec.agent.id as string)
          if (owner === undefined) return 'send_file works only for a project or a task.'
          const paths = (Array.isArray(input.paths) ? input.paths : []).filter((path): path is string => typeof path === 'string')
          return service.sendFile(owner, paths, typeof input.caption === 'string' ? input.caption : undefined)
        },
      }),
    ),
  )

  // ── progress ─────────────────────────────────────────────────────────────
  // Driven from the meter's usage event rather than a timer: a progress update is
  // only interesting when something actually happened.
  ctx.on('ops/usage', ({ owner, runId, deltaMicros }) => {
    if (runId === undefined) return
    const status = ctx.opsGovernor.status()
    const run = status.running.find((entry) => entry.runId === runId)
    if (run === undefined) return

    const now = Date.now()
    const spend = ctx.opsMeter.runTotals(runId)
    fire(service.reportProgress(
      runId,
      subjectOf(owner),
      progressText({
        subject: subjectOf(owner),
        steps: run.steps,
        elapsedMs: now - run.startedAt,
        maxSteps: 60,
        costMicros: (spend.costMicros + deltaMicros) as never,
      }),
    ))
  })

  void ctx.opsMeter
}

/**
 * Resolve the attachment scratch directory.
 *
 * A configured value may be absolute or relative. A relative one resolves under
 * the data directory rather than the process's working directory: a service that
 * wrote into `process.cwd()` would litter wherever the harness happened to start,
 * and would write somewhere different after a restart from another directory.
 *
 * @param configured the configured value.
 * @param dataDir the absolute data directory.
 * @returns the absolute scratch directory.
 */
function resolveScratch(configured: string, dataDir: string): string {
  return isAbsolute(configured) ? configured : join(dataDir, configured)
}

/** The output subject for an owner. */
function subjectOf(owner: Owner): OutputSubject {
  switch (owner.kind) {
    case 'project':
      return { kind: 'project', projectId: owner.projectId }
    case 'adhoc':
      return { kind: 'adhoc' }
    case 'orchestrator':
      return { kind: 'orchestrator' }
  }
}

/** The reply address stored on a run's inbound row. */
function addressForRun(ctx: Context, runId: string): ChannelAddress | undefined {
  const stored = ctx.opsStore.inbound.get(runId)?.reply_chat
  if (stored === null || stored === undefined) return undefined
  try {
    const parsed = JSON.parse(stored) as ChannelAddress
    return typeof parsed.channel === 'string' && typeof parsed.chatId === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}
