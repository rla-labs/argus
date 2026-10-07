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
import type { ChannelAddress, ServiceHealth } from '@argus-agent/types'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsGovernor } from '@argus-agent/governor'
import { truncate } from './parse.js'
import { buildHandlers } from './handlers.js'
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
  /** Delegate for `/cron`, when `ops-scheduler` is mounted. */
  readonly scheduler?: SchedulerPort
  /** Delegate for `/health`, when `ops-health` is mounted. */
  readonly health?: HealthPort
  /** Delegate for `/memory`, looked up live because `ops-memory` may mount later. */
  readonly memory?: () => MemoryPort | undefined
  /** Whether free text has a destination without an active project; for `/start`. */
  readonly hasOrchestrator?: () => boolean
  /** Re-read the project directory after a change; returns what the load did. */
  readonly reloadProjects: () => ReloadReport
  /** Reads the current time; injected so tests control it. */
  readonly now: () => number
  /**
   * The model an ad-hoc task uses.
   *
   * `/task` must name one: the governor cannot price `unknown/unknown`, so a task
   * with no model would be refused with `UNPRICED_MODEL` before it ran.
   */
  readonly adhocModel: { provider: string; model: string }
}

/** What `/cron` needs from `ops-scheduler`. */
export interface SchedulerPort {
  run(line: string, context: CommandContext): CommandResult
}

/** What `/memory` needs from `ops-memory`. */
export interface MemoryPort {
  memoryPath(projectId: string): string
  readMemory(projectId: string): string
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
      },
    })) {
      this.handlers.set(handler.spec.name, handler)
    }
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

    try {
      const out = await handler.run(parsed.input, context)
      if (handler.spec.mutating && out.error !== true && out.confirm === undefined) {
        this.audit(context, `command.${parsed.name}`, parsed.input.trim())
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
        actor: context.userId,
        action,
        target: target.length === 0 ? null : truncate(target, 200),
        details: { channel: context.address.channel, chatId: context.address.chatId },
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
