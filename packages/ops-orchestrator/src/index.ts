// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/orchestrator` — the front desk.
 *
 * A cheap, fast model that answers questions about the system and routes work to
 * projects. It has **no shell, no file access and no web tools**, and it cannot
 * rewrite an instruction: the forwarding tools take a `messageRef` and this plugin
 * fetches the original text from the store.
 *
 * @module @argus-agent/orchestrator
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: brings in the `ctx.agentPresets` augmentation.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import '@argus-agent/channel'
import { orchestratorOf, orchestratorSchema } from './config.js'
import { OpsOrchestrator } from './service.js'
import { systemPrompt } from './prompt.js'
import { orchestratorPreset } from './preset.js'

export * from './config.js'
export * from './preset.js'
export * from './prompt.js'
export * from './refs.js'
export * from './service.js'
export * from './tools.js'

/** Stable Cordis plugin name. */
export const name = 'ops-orchestrator'

/**
 * The services this plugin requires.
 *
 * Every one is required: the orchestrator runs through the governor like any other
 * work, its spending is metered, and its reply goes out through the channel.
 */
export const inject = [
  'opsRawConfig',
  // `opsConfigRegistry` and NOT `opsConfig`: injecting the validated config would
  // read it during this plugin's own resolution, before this plugin has
  // contributed its section — and the read would fail on an unknown key. The raw
  // document is available immediately, which is what the section is built from.
  'opsConfigRegistry',
  'agentPresets',
  'opsStore',
  'opsProjects',
  'opsMeter',
  'opsGovernor',
  'opsChannel',
]

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The orchestrator, once the plugin is mounted. */
    opsOrchestrator: OpsOrchestrator
  }
}

/**
 * Mount the orchestrator.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  // The section is contributed to the registry, so `ops.yaml` validates it and an
  // unknown key inside it is an error rather than something silently ignored.
  const section = ctx.opsConfigRegistry.extend('orchestrator', orchestratorSchema)
  ctx.effect(() => section)

  const config = orchestratorOf(ctx.opsRawConfig)
  const logger = ctx.logger('ops-orchestrator')

  if (!config.enabled) {
    logger.info('the orchestrator is disabled by orchestrator.enabled')
    return
  }

  const dataDir = typeof ctx.opsRawConfig['data_dir'] === 'string' ? ctx.opsRawConfig['data_dir'] : '/data'
  const service = new OpsOrchestrator(ctx, {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    meter: ctx.opsMeter,
    governor: ctx.opsGovernor,
    channel: ctx.opsChannel,
    config,
    scratchDir: `${dataDir}/scratch/orchestrator`,
    now: () => Date.now(),
  })

  ctx.provide('opsOrchestrator', service)

  // The preset is registered so the orchestrator agent can name it. It mounts no
  // dsh plugins — the five tools are registered per-agent — and its purpose is the
  // restriction the setup callback applies.
  void ctx.agentPresets.register(orchestratorPreset()).then((dispose: () => Promise<void>) => {
    ctx.effect(() => () => void dispose())
  })

  // The prompt is read eagerly, so a missing file fails the mount rather than the
  // first message a user sends.
  const prompt = systemPrompt()
  logger.info(
    'orchestrator ready: model=%s, %d tool(s), prompt %d characters, allowed task models=%s',
    config.model,
    service.allowedTools().length,
    prompt.length,
    config.allowed_task_models.length === 0 ? '(none)' : config.allowed_task_models.join(','),
  )

  /**
   * Take a free-text message.
   *
   * The reply goes out through the channel, prefixed with nothing: the
   * orchestrator is answering the person directly, not reporting for a project.
   */
  ctx.on('ops/orchestrator-input', (payload) => {
    void service
      .submit({
        messageRef: payload.messageRef,
        address: payload.address,
        userId: payload.userId,
        text: payload.text,
        attachments: payload.attachments ?? [],
      })
      .then(async (reply) => {
        if (reply === undefined || reply.trim().length === 0) {
          // A turn that produced nothing is reported rather than left silent: a
          // user who gets no reply cannot tell whether the system heard them.
          await ctx.opsChannel.reply(payload.address, 'I did not have an answer for that. Try naming a project.')
          return
        }
        await ctx.opsChannel.reply(payload.address, reply)
      })
      .catch((error: unknown) => {
        logger.warn('the orchestrator failed: %s', error instanceof Error ? error.message : String(error))
        void ctx.opsChannel.reply(payload.address, 'Something went wrong handling that. Try again.')
      })
  })

  ctx.effect(() => () => {
    void service.reset()
  })
}
