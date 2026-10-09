// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/orchestrator/tools` — the five tools, and nothing else.
 *
 * Each is built from a {@link ToolHost} rather than from the plugin directly, so
 * a tool's behavior is testable without booting an agent: the host is a small
 * interface a test implements in ten lines.
 *
 * **The two forwarding tools take a `messageRef`, never text.** That is what makes
 * verbatim forwarding structural: `send_to_project` has no parameter a model could
 * put a rewritten instruction into.
 *
 * @module @argus-agent/orchestrator/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { asData, noteTooLong, refProblem, refProblemMessage, withNote } from './refs.js'
import { taskModelAllowed, type OrchestratorSection } from './config.js'

/** What the tools need from the surrounding plugin. */
export interface ToolHost {
  /** The originating message of the current turn, if any. */
  readonly messageRef: string | undefined
  /** The chat this turn belongs to, for the active-project switch. */
  readonly address: { readonly channel: string; readonly chatId: string } | undefined
  /** The configuration. */
  readonly config: OrchestratorSection
  /** Every configured project, with what a listing shows. */
  listProjects(): Array<{
    readonly id: string
    readonly description: string | null
    readonly status: string
    readonly model: string
  }>
  /** Resolve a message reference to its text. */
  resolveRef(ref: string): { readonly text: string; readonly projectId: string | null } | undefined
  /** Submit the original text to a project. */
  sendToProject(input: {
    readonly projectId: string
    readonly text: string
    readonly messageRef: string
  }): { readonly requestId: string }
  /** Submit an ad-hoc task. */
  runTask(input: {
    readonly text: string
    readonly messageRef: string
    readonly model?: string
  }): { readonly requestId: string }
  /** Make a project the chat's active one. */
  setActiveProject(projectId: string): void
  /** A project's live status. */
  projectStatus(projectId: string):
    | {
        readonly found: true
        readonly status: string
        readonly model: string
        readonly running: boolean
        readonly steps: number
        readonly dayMicros: number
        readonly monthMicros: number
        readonly budgetLevel: string
      }
    | { readonly found: false }
  /** A usage report. */
  usageSummary(period: 'day' | 'month'): Array<{
    readonly scope: string
    readonly costMicros: number
    readonly requests: number
    readonly inputTokens: number
    readonly outputTokens: number
  }>
  /** Record the final reply. */
  answer(text: string): void
}

/** A tool result, which `defineTool` requires to be declared. */
type ToolResult = string

/** Wrap a plain string tool result so its schema and render agree. */
function stringOutput(): {
  readonly schema: { readonly type: 'string' }
  readonly render: (args: unknown, value: ToolResult) => Array<{ readonly type: 'text'; readonly text: string }>
} {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }
}

/**
 * Format a table of rows for a tool result.
 *
 * @param rows the rows, including the header.
 * @returns the text.
 */
function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '(nothing)'
  const widths = rows[0]?.map((_, index) => Math.max(...rows.map((row) => (row[index] ?? '').length))) ?? []
  return rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd())
    .join('\n')
}

/**
 * Resolve the reference a forwarding tool was given.
 *
 * @param host the tool host.
 * @param value the `messageRef` the model passed.
 * @returns the text to forward, or an error message.
 */
/** How many forwarded messages are remembered, to refuse sending one twice. */
const FORWARDED_CAP = 100

function resolveForward(
  host: ToolHost,
  forwarded: ReadonlyMap<string, string>,
  value: unknown,
): { readonly ok: true; readonly text: string; readonly messageRef: string } | { readonly ok: false; readonly error: string } {
  const problem = refProblem(value)
  if (problem !== undefined) return { ok: false, error: refProblemMessage(problem) }

  const ref = (value as string).trim()
  const sent = forwarded.get(ref)
  if (sent !== undefined) {
    // A model waiting for a result it cannot see retries; each retry would start
    // the same work again, so a message is forwarded once.
    return { ok: false, error: `That message was already sent (request ${sent}); it runs once. Do not send it again: tell the person it is running and end your turn.` }
  }
  const resolved = host.resolveRef(ref)
  if (resolved === undefined) {
    // A model that invented a reference gets told so, rather than having its
    // invention forwarded as if it were the user's words.
    return { ok: false, error: refProblemMessage('unknown') }
  }
  return { ok: true, text: resolved.text, messageRef: ref }
}

/**
 * The five tools plus `answer`.
 *
 * @param host what the tools act through.
 * @returns the definitions, in a stable order.
 */
export function buildTools(host: ToolHost): ToolDefinition[] {
  // ponytail: in memory, lost on restart; a restart also forgets the message itself.
  const forwarded = new Map<string, string>()
  const remember = (ref: string, requestId: string): void => {
    forwarded.set(ref, requestId)
    if (forwarded.size > FORWARDED_CAP) forwarded.delete(forwarded.keys().next().value as string)
  }
  return [
    defineTool({
      name: 'list_projects',
      description:
        'List the configured projects with their id, description, status and model. Use this before sending work, and to answer questions about what exists.',
      parameters: {},
      output: stringOutput(),
      execute: async () => {
        const projects = host.listProjects()
        if (projects.length === 0) {
          return 'No projects are configured. Tell the person to create one with /new <id>.'
        }
        return table([
          ['Project', 'Status', 'Model', 'Description'],
          ...projects.map((project) => [
            project.id,
            project.status,
            project.model,
            project.description ?? '',
          ]),
        ])
      },
    }),

    defineTool({
      name: 'send_to_project',
      description:
        'Send a message to a project. The system forwards the original text of messageRef EXACTLY as the person wrote it — you do not supply the text and you must not rewrite it. Use `note` only to say where the request came from.',
      parameters: {
        projectId: { type: 'string', description: 'The project id, from list_projects.', required: true },
        messageRef: {
          type: 'string',
          description: 'The messageRef of the message being routed. NOT the text.',
          required: true,
        },
        note: {
          type: 'string',
          description: 'Optional short context, such as where the request came from. Never part of the request.',
        },
      },
      output: stringOutput(),
      execute: async (args) => {
        const input = args as { projectId?: unknown; messageRef?: unknown; note?: unknown }

        const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : ''
        if (projectId.length === 0) {
          return 'projectId is required. Call list_projects to see the valid ids.'
        }
        if (!host.listProjects().some((project) => project.id === projectId)) {
          const ids = host.listProjects().map((project) => project.id)
          return `No project "${projectId}". The projects are: ${ids.length === 0 ? '(none)' : ids.join(', ')}.`
        }

        const resolved = resolveForward(host, forwarded, input.messageRef)
        if (!resolved.ok) return resolved.error

        const note = typeof input.note === 'string' ? input.note : undefined
        if (note !== undefined && noteTooLong(note, host.config.max_note_length)) {
          return `The note is too long (${note.length} characters; the limit is ${host.config.max_note_length}). A note is context, not part of the request — keep it short, or put it in your answer.`
        }

        const text = withNote(resolved.text, note)
        const { requestId } = host.sendToProject({ projectId, text, messageRef: resolved.messageRef })
        remember(resolved.messageRef, requestId)
        if (host.config.switch_active_on_send && host.address !== undefined) {
          host.setActiveProject(projectId)
        }
        return `Sent to ${projectId}. Request ${requestId}. Its answer will arrive in this chat by itself; you will not see it. Tell the person it was sent, and end your turn.`
      },
    }),

    defineTool({
      name: 'run_task',
      description:
        'Run a one-off task in a scratch folder, using the original text of messageRef exactly as written. Use this when there is no project for the request, or when it is clearly a one-off.',
      parameters: {
        messageRef: {
          type: 'string',
          description: 'The messageRef of the message to run. NOT the text.',
          required: true,
        },
        model: {
          type: 'string',
          description: 'Optional provider/model. Only a configured allowed model is accepted.',
        },
      },
      output: stringOutput(),
      execute: async (args) => {
        const input = args as { messageRef?: unknown; model?: unknown }

        const resolved = resolveForward(host, forwarded, input.messageRef)
        if (!resolved.ok) return resolved.error

        const model = typeof input.model === 'string' && input.model.trim().length > 0 ? input.model.trim() : undefined
        if (!taskModelAllowed(model, host.config.allowed_task_models)) {
          // An empty allowed list permits none, so a model the operator did not
          // name is refused rather than quietly downgraded to the default.
          return `The model "${model}" is not allowed for tasks. Allowed: ${host.config.allowed_task_models.length === 0 ? '(none — omit the model)' : host.config.allowed_task_models.join(', ')}.`
        }

        const { requestId } = host.runTask({
          text: resolved.text,
          messageRef: resolved.messageRef,
          ...(model === undefined ? {} : { model }),
        })
        remember(resolved.messageRef, requestId)
        return `Task started. Request ${requestId}. Its result will arrive in this chat by itself; you will not see it. Tell the person it is running, and end your turn.`
      },
    }),

    defineTool({
      name: 'project_status',
      description:
        'Report one project: whether it is running, its model, what it has spent today and this month, and its budget level.',
      parameters: {
        projectId: { type: 'string', description: 'The project id.', required: true },
      },
      output: stringOutput(),
      execute: async (args) => {
        const projectId = typeof (args as { projectId?: unknown }).projectId === 'string'
          ? ((args as { projectId: string }).projectId).trim()
          : ''
        if (projectId.length === 0) return 'projectId is required. Call list_projects to see the valid ids.'

        const status = host.projectStatus(projectId)
        if (!status.found) {
          const ids = host.listProjects().map((project) => project.id)
          return `No project "${projectId}". The projects are: ${ids.length === 0 ? '(none)' : ids.join(', ')}.`
        }
        return asData(
          'project_status',
          [
            `project   ${projectId}`,
            `status    ${status.status}`,
            `model     ${status.model}`,
            `state     ${status.running ? 'running' : 'idle'}`,
            `steps     ${status.steps}`,
            `today     $${(status.dayMicros / 1_000_000).toFixed(4)}`,
            `month     $${(status.monthMicros / 1_000_000).toFixed(4)}`,
            `budget    ${status.budgetLevel}`,
          ].join('\n'),
        )
      },
    }),

    defineTool({
      name: 'usage_summary',
      description:
        'Report what the system has spent, by scope, for today or this month. Use this to answer cost questions.',
      parameters: {
        period: {
          type: 'string',
          description: 'Either "day" or "month".',
          required: true,
        },
      },
      output: stringOutput(),
      execute: async (args) => {
        const raw = (args as { period?: unknown }).period
        const period = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
        if (period !== 'day' && period !== 'month') {
          return 'period must be "day" or "month".'
        }
        const rows = host.usageSummary(period)
        if (rows.length === 0) return `No usage recorded for this ${period}.`
        const total = rows.reduce((sum, row) => sum + row.costMicros, 0)
        return asData(
          'usage_summary',
          [
            table([
              ['Scope', 'Cost', 'Requests', 'In', 'Out'],
              ...rows.map((row) => [
                row.scope,
                `$${(row.costMicros / 1_000_000).toFixed(4)}`,
                String(row.requests),
                String(row.inputTokens),
                String(row.outputTokens),
              ]),
            ]),
            '',
            `Total: $${(total / 1_000_000).toFixed(4)}`,
          ].join('\n'),
        )
      },
    }),

    defineTool({
      name: 'answer',
      description:
        'Send your reply to the person. This is the ONLY thing they see, and every turn must end with it.',
      parameters: {
        text: { type: 'string', description: 'The reply, in the language the person used.', required: true },
      },
      output: stringOutput(),
      execute: async (args) => {
        const text = (args as { text?: unknown }).text
        if (typeof text !== 'string' || text.trim().length === 0) {
          return 'text is required, and cannot be empty.'
        }
        host.answer(text)
        return 'Delivered.'
      },
    }),
  ]
}

/** Whether a value is one of the allowed tool names. */
export function isOrchestratorTool(name: string, allowed: readonly string[]): boolean {
  return allowed.includes(name)
}