// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/commands/service` — `ctx.opsCommands`.
 *
 * Every command a human can run, as a pure function of the services it is handed.
 * No command calls a model, and no command bypasses the governor: `/task` goes
 * through `submit()`, and `/stop` through the governor's own `stop()`.
 *
 * @module @argus-agent/commands/service
 */
import type { ReloadReport } from '@argus-agent/projects'
import { randomUUID } from 'node:crypto'
import type { ChannelAddress, DoctorFinding, ServiceHealth } from '@argus-agent/types'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsGovernor } from '@argus-agent/governor'
import { truncate } from './parse.js'
import { describeSchema, pendingRestart, systemApply, type SchemaNode, type SettingField } from './settings.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { buildHandlers } from './handlers.js'
import { BUILT_IN_TEMPLATES, loadTemplates } from '@argus-agent/projects'
import {
  errorResult,
  result,
  type CommandContext,
  type CommandHandler,
  type CommandResult,
  type CommandSpec,
  type Confirmation,
} from './types.js'

/** Options for the service. */
export interface CommandsOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly meter: OpsMeter
  readonly governor: OpsGovernor
  /** Where project files are written. */
  readonly projectsConfigDir: string
  /** Where project folders are created. */
  readonly projectsRoot: string
  /** The deployment's own project templates (`<config_dir>/templates`). */
  readonly templatesDir: string
  /** Delegate for `/cron`, looked up live: `ops-scheduler` mounts after this plugin. */
  readonly scheduler?: () => SchedulerPort | undefined
  /** Delegate for `/health`, looked up live: `ops-health` mounts after this plugin. */
  readonly health?: () => HealthPort | undefined
  /** Delegate for `/memory`, looked up live because `ops-memory` may mount later. */
  readonly memory?: () => MemoryPort | undefined
  /** Delegate for `/web`: the web interface, looked up live. */
  readonly web?: () => WebPort | undefined
  /** Delegate for `/defaults frontdesk`: the front desk, looked up live. */
  readonly frontDesk?: () => FrontDeskPort | undefined
  /** The `ops.yaml` path `/defaults` writes to; looked up live. */
  readonly configPath?: () => string | undefined
  /** Delegate for `/key`: the model providers, looked up live. */
  readonly keys?: () => KeysPort | undefined
  /** The web search backend, for `/tools`; looked up live. */
  readonly search?: () => SearchPort | undefined
  /** Whether free text has a destination without an active project; for `/start`. */
  readonly hasOrchestrator?: () => boolean
  /** The whole `ops.yaml` schema, as the mounted plugins assemble it; for `/config`. */
  readonly configSchema?: () => SchemaNode
  /** Validate a whole raw `ops.yaml`; throws naming what is wrong. */
  readonly validateConfig?: (raw: unknown) => void
  /** `ops.yaml` as Argus read it at start, to tell what waits for a restart. */
  readonly bootConfig?: () => unknown
  /**
   * Restart Argus once the runs in progress finish (at most two minutes); present only
   * when something starts it again (Docker, systemd).
   */
  readonly restart?: () => void
  /** Re-read the project directory after a change; returns what the load did. */
  readonly reloadProjects: () => ReloadReport
  /** Reads the current time; injected so tests control it. */
  readonly now: () => number
}

/** What `/cron` needs from `ops-scheduler`. */
export interface SchedulerPort {
  run(line: string, context: CommandContext): CommandResult
}

/** What `/memory` needs from `ops-memory`. */
export interface MemoryPort {
  memoryPath(projectId: string): string
  readMemory(projectId: string): string
  sections(projectId: string): Array<{ name: string; chars: number }>
  forgetSection(
    projectId: string,
    section: string,
    actor: string,
  ): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly sections: readonly string[] }
  instructionsPath(projectId: string): string
  readInstructions(projectId: string): string
  writeInstructions(projectId: string, text: string, actor: string): { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly message: string }
}

/** What `/web` needs from `ops-web`. */
export interface WebPort {
  /** A one-time sign-in link for an Argus user, valid 10 minutes. */
  loginLink(userId: string): string
  /** The same, valid 24 hours: an invitation or a password reset. */
  inviteLink(userId: string): string
  /** Where the interface is opened, without a trailing slash: `/mcp connect`'s link. */
  readonly publicUrl: string
}

/** What `/defaults` needs from `ops-orchestrator`. */
export interface FrontDeskPort {
  currentModel(): string
  setModel(model: string): void
}

/** What `/key` needs from the providers row (`ctx.opsProviders`). */
/** The web search backend, as the bundle's search row reports it. */
export interface SearchPort {
  status(): { provider: string; ready: boolean; fix?: string; priceMicros?: number }
}

export interface KeysPort {
  keyStatus(): ReadonlyArray<{ provider: string; name: string; configured: boolean; source?: string; writable: boolean }>
  setKey(provider: string, key: string): Promise<{ ok: boolean; message: string }>
  removeKey(provider: string): Promise<{ ok: boolean; message: string }>
}

/** What `/health` needs from `ops-health`. */
export interface HealthPort {
  report(): { readonly text: string }
}

/** How long a confirmation stays valid. */
export const CONFIRMATION_TTL_MS = 60_000

/** A pending confirmation. */
interface PendingConfirmation {
  readonly token: string
  readonly command: string
  readonly address: ChannelAddress
  readonly userId: string
  readonly expiresAt: number
}

/**
 * The command layer.
 *
 * Exposed as `ctx.opsCommands`.
 */
export class OpsCommands {
  private readonly handlers = new Map<string, CommandHandler>()
  private readonly confirmations = new Map<string, PendingConfirmation>()

  /**
   * A health report.
   *
   * `degraded` when confirmations have piled up unanswered, which means an operator
   * is being asked and not answering — the commands that need one are effectively
   * unavailable.
   *
   * @returns the report.
   */
  health(): ServiceHealth {
    const pending = this.confirmations.size
    const details: Record<string, unknown> = {
      commands: this.handlers.size,
      pendingConfirmations: pending,
    }
    if (pending >= 3) {
      return { status: 'degraded', details: { ...details, reason: 'several confirmations are unanswered' } }
    }
    return { status: 'ok', details }
  }

  /**
   * Every `ops.yaml` setting, for the web's settings pages: its value in the file now,
   * its default, and when a change applies.
   *
   * @returns the settings, the keys waiting for a restart, and whether Argus can restart
   *   itself; undefined when the schema or the file is not known.
   */
  systemSettings(): { readonly file: string; readonly fields: readonly SettingField[]; readonly pending: readonly string[]; readonly restartable: boolean } | undefined {
    const file = this.options.configPath?.()
    const schema = this.options.configSchema?.()
    if (file === undefined || schema === undefined) return undefined
    const raw = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as unknown
    return {
      file,
      fields: describeSchema(schema, raw, systemApply),
      pending: pendingRestart(schema, raw, this.options.bootConfig?.() ?? raw),
      restartable: this.options.restart !== undefined,
    }
  }

  /**
   * `argus doctor`: can `/task` run. Its model is `tasks.model`, whose default is a
   * DeepSeek model, so an install with only another provider's key fails here first.
   *
   * @returns the finding.
   */
  async doctor(): Promise<DoctorFinding[]> {
    const model = this.options.governor.adhocModel()
    const name = `${model.provider}/${model.model}`
    await this.options.meter.ensurePriced(model)
    const problem = this.options.projects.checkModel(model)
    return [
      problem === undefined
        ? { ok: true, check: 'the /task model', detail: name }
        : { ok: false, check: 'the /task model', detail: problem.message, fix: `send /defaults tasks <provider/model> with a model you have a key for (now ${name})` },
    ]
  }

  constructor(private readonly options: CommandsOptions) {
    for (const handler of buildHandlers({
      options,
      service: {
        activeProjectOf: (address) => this.activeProjectOf(address),
        requestConfirmationFor: (command, context, prompt) =>
          this.requestConfirmation(command, context, prompt),
        // `/help` reads the registry, so it must see every command including the
        // ones registered after it in the list.
        specs: () => this.specs(),
        confirm: (token, accepted, context) => this.confirm(token, accepted, context),
        systemSettings: () => this.systemSettings(),
        runCommand: (line, context) => this.runCommand(line, context),
      },
    })) {
      this.handlers.set(handler.spec.name, handler)
    }
  }



  /**
   * The project templates `/new` offers: the built-in ones and the deployment's.
   *
   * @returns each template's name and one-line summary, by name.
   */
  templates(): Array<{ name: string; summary: string; description: string; instructions: string; settings: Readonly<Record<string, unknown>>; builtIn: boolean; file: boolean; followers: string[] }> {
    const projects = this.options.projects
    return [...loadTemplates(this.options.templatesDir).templates.values()]
      .map((template) => ({
        name: template.name,
        summary: template.summary,
        description: template.description,
        instructions: template.instructions,
        settings: template.settings,
        builtIn: BUILT_IN_TEMPLATES.some((each) => each.name === template.name),
        file: existsSync(join(this.options.templatesDir, `${template.name}.yaml`)),
        followers: projects.configuredIds().filter((id) => projects.configOf(id)?.template === template.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Every registered command, sorted by name. */
  specs(): CommandSpec[] {
    return [...this.handlers.values()].map((handler) => handler.spec).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
  }

  /**
   * Run one command line.
   *
   * The entry point `ops-channel` calls. A line that is not a command is an
   * error, not a silent no-op: the caller decides whether to fall through to the
   * orchestrator, and it can only do that if it is told.
   *
   * @param line the full line, with or without a leading slash.
   * @param context who and where.
   * @returns the result.
   */
  async runCommand(line: string, context: CommandContext): Promise<CommandResult> {
    const parsed = parseLine(line)
    if (parsed === undefined) {
      return errorResult('That is not a command. Send /help for the list.')
    }

    const handler = this.handlers.get(parsed.name)
    if (handler === undefined) {
      return errorResult(`Unknown command /${parsed.name}. Send /help for the list.`)
    }
    // Checked here, not in the handler, so the confirmed form of a command is
    // refused by the same rule as the form that asked.
    if (handler.spec.adminOnly === true && context.isAdmin !== true) {
      return errorResult(`Only the admin can run /${parsed.name}.`)
    }

    try {
      const out = await handler.run(parsed.input, context)
      if (handler.spec.mutating && out.error !== true && out.confirm === undefined) {
        // A secret's command keeps only its first arguments (`/key openrouter`).
        const secret = handler.spec.secret
        const target = secret === undefined || secret === false ? parsed.input.trim() : parsed.input.trim().split(/\s+/).slice(0, secret === true ? 1 : secret).join(' ')
        this.audit(context, `command.${parsed.name}`, target)
      }
      return out
    } catch (err) {
      // A command must never take the harness down: a user's typo or a service
      // failure reports as an error message.
      return errorResult(`/${parsed.name} failed: ${(err as Error).message}`)
    }
  }

  /**
   * Answer a confirmation.
   *
   * @param token the token the channel echoed back.
   * @param accepted whether the user said yes.
   * @param context who and where.
   * @returns the result of running the command, or a note that it lapsed.
   */
  async confirm(
    token: string,
    accepted: boolean,
    context: CommandContext,
  ): Promise<CommandResult> {
    const pending = this.confirmations.get(token)
    if (pending === undefined) {
      return errorResult('That confirmation has already been answered.')
    }
    this.confirmations.delete(token)

    if (pending.expiresAt <= context.now) {
      return errorResult('That confirmation expired. Nothing was changed.')
    }
    if (!accepted) {
      return result('Cancelled. Nothing was changed.')
    }
    if (pending.userId !== context.userId) {
      // A token is scoped to the user who requested it, so a forwarded message
      // cannot be used to confirm someone else's destructive action.
      return errorResult('That confirmation belongs to another user.')
    }
    return this.runCommand(pending.command, context)
  }

  /** Mint a confirmation for a destructive command. */
  private requestConfirmation(command: string, context: CommandContext, prompt: string): CommandResult {
    const token = randomUUID()
    const expiresAt = context.now + CONFIRMATION_TTL_MS
    this.confirmations.set(token, {
      token,
      command,
      address: context.address,
      userId: context.userId,
      expiresAt,
    })
    const confirmation: Confirmation = {
      prompt,
      onYes: command,
      token,
      expiresAt,
      onNoText: 'Nothing will be changed.',
    }
    return result(prompt, {
      confirm: confirmation,
      buttons: [
        { label: 'Yes', command: `__confirm:${token}:yes` },
        { label: 'No', command: `__confirm:${token}:no` },
      ],
    })
  }

  /** Write an audit row for a state-changing command. */
  private audit(context: CommandContext, action: string, target: string): void {
    this.options.store.audit.record(
      {
        actor: context.user?.id ?? context.userId,
        action,
        target: target.length === 0 ? null : truncate(target, 200),
        details: { channel: context.address.channel, chatId: context.address.chatId, userId: context.userId },
      },
      context.now,
    )
  }

  /** Drop expired confirmations. Called by the safety tick. */
  expireConfirmations(now = this.options.now()): number {
    let expired = 0
    for (const [token, pending] of this.confirmations) {
      if (pending.expiresAt <= now) {
        this.confirmations.delete(token)
        expired += 1
      }
    }
    return expired
  }

  /** How many confirmations are pending. For diagnostics. */
  get pendingConfirmations(): number {
    return this.confirmations.size
  }

  // ── helpers shared by handlers ───────────────────────────────────────────

  /** The active project for a chat. */
  activeProjectOf(address: ChannelAddress): string | undefined {
    const row = this.options.store.chatContext.get(address.channel, address.chatId)
    return row?.active_project_id ?? undefined
  }


}

/** Parse a leading-slash command line. */
function parseLine(line: string): { name: string; input: string } | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  const space = withoutSlash.search(/\s/)
  if (space === -1) {
    const name = withoutSlash.toLowerCase()
    return name.length === 0 ? undefined : { name, input: '' }
  }
  const name = withoutSlash.slice(0, space).toLowerCase()
  if (name.length === 0) return undefined
  return { name, input: withoutSlash.slice(space) }
}

export { parseLine }
export { buildHandlers } from './handlers.js'
export type { CommandHandler } from './types.js'
