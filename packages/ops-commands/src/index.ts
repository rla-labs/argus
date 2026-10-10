// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/commands` — the deterministic command layer.
 *
 * Every system action a human can trigger, executable with **no model turn**, and
 * independent of any chat platform: `ops-channel` calls `runCommand`, the Web UI
 * reaches the same handlers through `ctx.commands`, and a test calls them
 * directly.
 *
 * @module @argus-agent/commands
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { OpsCommands, type CommandsOptions, type FrontDeskPort, type HealthPort, type KeysPort, type MemoryPort, type SchedulerPort } from './service.js'
import type { CommandInvocation, CommandResult as DshCommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandContext, CommandResult } from './types.js'
import { pathsOf } from '@argus-agent/argus-agent'
import { reload as projectsReload, type ReloadReport } from '@argus-agent/projects'
import { decodeAddress } from '@argus-agent/types'
import './events.js'

export * from './parse.js'
export * from './types.js'
export * from './service.js'
export { buildHandlers } from './handlers.js'

/** Stable Cordis plugin name. */
export const name = 'ops-commands'

/**
 * The services this plugin requires.
 *
 * `commands` is dsh's own registry. It is required rather than optional: without
 * it the commands exist only for `runCommand`, and a user typing `/status` in the
 * Web UI would get nothing.
 */
export const inject = ['opsConfigRegistry', 'opsRawConfig', 'opsStore', 'opsProjects', 'opsMeter', 'opsGovernor', 'commands']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Argus Agent command layer. */
    opsCommands: OpsCommands
  }
}

/**
 * Mount the command layer.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  // `tasks` is this plugin's section; contributed so ops.yaml validates it.
  const section = ctx.opsConfigRegistry.extend('tasks', tasksSchema)
  ctx.effect(() => section)

  const paths = pathsOf(ctx.opsRawConfig)

  const options: { -readonly [K in keyof CommandsOptions]: CommandsOptions[K] } = {
    store: ctx.opsStore,
    projects: ctx.opsProjects,
    meter: ctx.opsMeter,
    governor: ctx.opsGovernor,
    projectsConfigDir: paths.projectsDir,
    projectsRoot: join(paths.dataDirAbs, 'projects'),
    // Re-reading the directory is how `/new` makes a project usable without a
    // restart. The governor is re-dispatched because a new project may unblock a
    // request that was waiting for it.
    reloadProjects: () => reload(ctx),
    now: () => Date.now(),
  }

  // Optional delegates. Absent is a normal deployment, not a failure: `/cron`
  // then replies "scheduler not installed" and `/health` falls back to what the
  // governor can see.
  const scheduler = ctx.get('opsScheduler' as never) as unknown as SchedulerPort | undefined
  const health = ctx.get('opsHealth' as never) as unknown as HealthPort | undefined
  if (scheduler !== undefined) options.scheduler = scheduler
  if (health !== undefined) options.health = health
  // Live, like ops-channel's: the orchestrator may mount after this plugin.
  options.hasOrchestrator = () => ctx.get('opsOrchestrator' as never) !== undefined
  options.memory = () => ctx.get('opsMemory' as never) as unknown as MemoryPort | undefined
  options.keys = () => ctx.get('opsProviders' as never) as unknown as KeysPort | undefined
  options.frontDesk = () => ctx.get('opsOrchestrator' as never) as unknown as FrontDeskPort | undefined
  options.configPath = () => (ctx.get('opsConfig' as never) as unknown as { configPath?: string } | undefined)?.configPath

  const commands = new OpsCommands(options)
  ctx.provide('opsCommands', commands)

  // ── registration on dsh's own registry ───────────────────────────────────
  // Every command is registered, so the Web UI's command menu lists them and a
  // user can run one without a model turn (SPIKES.md spike 6).
  for (const spec of commands.specs()) {
    ctx.effect(() =>
      ctx.commands.register({
        name: spec.name,
        description: spec.description,
        ...(spec.detail.length === 0 ? {} : {}),
        handler: (invocation) => runRegistered(ctx, commands, spec.name, invocation),
      }),
    )
  }

  // ── the confirmation tap ─────────────────────────────────────────────────
  // `/confirm` is part of the handler list above, so it is registered by the loop
  // and reached by `runCommand` too. That matters: a channel renders a
  // confirmation's Yes/No buttons as that line, so an answer runs through the same
  // dispatch, audit and access path as any other command.

  ctx.effect(() => () => {
    /* registrations unwind through their own effects */
  })
}

/** Run a registered command through dsh's registry. */
async function runRegistered(
  ctx: Context,
  commands: OpsCommands,
  commandName: string,
  invocation: CommandInvocation,
): Promise<DshCommandResult> {
  const outcome = await commands.runCommand(
    `/${commandName}${invocation.rawInput}`,
    contextOf(ctx, invocation),
  )
  return toDshResult(outcome)
}

/**
 * Build the command context from a dsh invocation.
 *
 * The address is derived from the SESSION, not from the invocation: a command run
 * from the Web UI belongs to the web channel, and the chat id is the session, so
 * `/p` sets an active project for that conversation and nothing else.
 */
function contextOf(
  ctx: Context,
  invocation: CommandInvocation,
): CommandContext {
  const sessionId = String(invocation.agent.id)
  const owner = ctx.opsProjects.ownerOf(sessionId)
  const active =
    owner !== undefined && owner.kind === 'project'
      ? owner.projectId
      : ctx.opsCommands.activeProjectOf({ channel: 'dsh', chatId: sessionId })

  return {
    address: { channel: 'dsh', chatId: sessionId },
    userId: 'dsh-user',
    // The Web UI is reachable only from the server (a loopback port, an SSH
    // tunnel), so whoever uses it already holds more than the admin commands grant.
    isAdmin: true,
    ...(active === undefined ? {} : { activeProject: active }),
    now: Date.now(),
  }
}

/** Convert a channel-agnostic result into dsh's own result shape. */
function toDshResult(outcome: CommandResult): DshCommandResult {
  if (outcome.error === true) return { kind: 'error', text: outcome.text }
  // Files and buttons have no representation in dsh's result, so they are
  // rendered into the text. A channel that can attach them uses `runCommand`
  // directly and never goes through here.
  const extra: string[] = []
  if (outcome.files !== undefined && outcome.files.length > 0) {
    extra.push(
      '',
      ...outcome.files.flatMap((entry) =>
        'path' in entry ? [`--- ${entry.name}: ${entry.path} ---`] : [`--- ${entry.name} ---`, entry.content],
      ),
    )
  }
  if (outcome.buttons !== undefined && outcome.buttons.length > 0) {
    extra.push('', ...outcome.buttons.map((button) => `[ ${button.label} ]  ${button.command}`))
  }
  return { kind: 'success', text: [outcome.text, ...extra].join('\n') }
}

/** The `tasks` section: the model `/task` runs on, as `provider/model`. */
export const tasksSchema = z
  .object({
    model: z.string().pattern(/^[^/]+\/.+$/).default('deepseek/deepseek-flash'),
  })
  .default({})

/**
 * Re-read the projects directory.
 *
 * The reload is `ops-projects`' own, imported through the bundle's public
 * `reload` helper so this module does not reach into the loader's internals.
 */
function reload(ctx: Context): ReloadReport {
  const report = projectsReload(ctx)
  // A project that became valid may unblock nothing that is queued (requests for
  // an invalid project are refused, not held), but a new one may; a pass is cheap.
  ctx.opsGovernor.requestDispatch()
  return report
}

export { decodeAddress }
export type { CommandContext, CommandResult, SchedulerPort, FrontDeskPort, HealthPort, KeysPort, MemoryPort }
