// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/commands/types` — the channel-agnostic command contract.
 *
 * A command returns this and knows nothing about Telegram, the Web UI or a test
 * harness. `ops-channel` renders it; `ops-telegram` turns buttons into an inline
 * keyboard. That separation is what makes the commands testable without a
 * channel and reusable from every one.
 *
 * @module @argus-agent/commands/types
 */
import type { ChannelAddress } from '@argus-agent/types'

/** A file a command wants delivered: text it built, or a file on disk. */
export type CommandFile =
  | {
      /** The file name shown to the user. */
      readonly name: string
      /** The content. */
      readonly content: string
      /** A MIME type, when it is not text. */
      readonly contentType?: string
    }
  | {
      readonly name: string
      /** An absolute path, read by the channel when it sends. */
      readonly path: string
      /** The size, so a channel can refuse what it cannot send. */
      readonly sizeBytes: number
    }

/** One tappable button. */
export interface CommandButton {
  /** The label shown. */
  readonly label: string
  /** The command line the button runs when tapped. */
  readonly command: string
}

/**
 * A confirmation request.
 *
 * The channel shows Yes/No buttons; the command runs only on Yes, within
 * `expiresAt`. A destructive command returns this **instead of** acting, so an
 * accidental tap cannot destroy anything.
 */
export interface Confirmation {
  /** The question asked. */
  readonly prompt: string
  /** The command to run on Yes. */
  readonly onYes: string
  /** A correlation token the channel echoes back. */
  readonly token: string
  /** When the confirmation lapses. */
  readonly expiresAt: number
  /** What happens if it is not answered; always "nothing" for a destructive act. */
  readonly onNoText: string
}

/** What a command returns. */
export interface CommandResult {
  /** The text to send. */
  readonly text: string
  /** Files to attach. */
  readonly files?: readonly CommandFile[]
  /** Buttons to offer. */
  readonly buttons?: readonly CommandButton[]
  /** A confirmation to request instead of acting. */
  readonly confirm?: Confirmation
  /**
   * Whether the command failed.
   *
   * A failed command still carries text — the message that explains the syntax —
   * because a command's whole job is to tell the user what to do next.
   */
  readonly error?: boolean
  /**
   * The command's own machine-readable outcome, for a caller that is not a human.
   *
   * `/projects` from a script wants the list, not the formatting.
   */
  readonly data?: unknown
}

/** Who invoked a command and from where. */
export interface CommandContext {
  /** Where the reply goes. */
  readonly address: ChannelAddress
  /** The platform user id, for the audit log. */
  readonly userId: string
  /** The chat's active project, when one is set. */
  readonly activeProject?: string
  /** Whether the caller is the admin (`access.admin`), for the admin-only commands. */
  readonly isAdmin?: boolean
  /** The current time, injected so tests control it. */
  readonly now: number
}

/** A command's identity and help text. */
export interface CommandSpec {
  /** The name without a leading slash. */
  readonly name: string
  /** One line, used by `/help` and by a platform's command menu. */
  readonly description: string
  /** The full syntax line, shown on a parse error. */
  readonly syntax: string
  /** A longer explanation for `/help <command>`. */
  readonly detail: string
  /** Examples that work. */
  readonly examples: readonly string[]
  /** Whether the command changes state, and so is audited. */
  readonly mutating: boolean
  /** Whether it is destructive, and so requires confirmation. */
  readonly destructive?: boolean
  /** Whether only the admin may run it. */
  readonly adminOnly?: boolean
  /** Whether it needs another plugin's service. */
  readonly requires?: string
  /**
   * Whether its arguments carry a secret. The audit row then keeps only the first
   * argument, and the channel deletes the message that carried it.
   */
  readonly secret?: boolean
}

/** A command implementation: its help text and its behavior. */
export interface CommandHandler {
  readonly spec: CommandSpec
  run(input: string, context: CommandContext): CommandResult | Promise<CommandResult>
}

/** A user `/allow` added. */
export interface AddedUser {
  readonly channel: string
  readonly userId: string
}

/** The `runtime_state` key that holds the users `/allow` added. */
export const ADDED_USERS_KEY = 'access.added_users'

/** Build a successful result. */
export function result(text: string, extra: Partial<CommandResult> = {}): CommandResult {
  return { text, ...extra }
}

/** Build a failed result. */
export function errorResult(text: string): CommandResult {
  return { text, error: true }
}
