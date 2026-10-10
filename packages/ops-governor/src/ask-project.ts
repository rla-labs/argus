// == ARGUS AGENT PROJECT ==
/**
 * `ask_project` — one project asks another and waits for its answer.
 *
 * The question becomes an ordinary request to the other project, admitted by the
 * governor like any other (its budget, its slot, its queue), so nothing runs that
 * the governor did not start. The asker comes from the calling agent (rule 6). A
 * run that is itself answering a question cannot ask one, so two projects cannot
 * keep each other busy. The answer goes back to the asker, never to a chat.
 *
 * The tool is in the `agents` group, which is `off` by default: a project sees it
 * only when its `tools.agents` is `ask` or `allow`.
 *
 * @module @argus-agent/governor/ask-project
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@argus-agent/store'
import { INTERACTIVE, type ContentBlockLike, type Scope } from '@argus-agent/types'
import type { OpsGovernor } from './service.js'

/** How long an answer may take beyond the answering project's own run limit. */
const SLACK_MS = 5 * 60_000

/** A question waiting for its run to answer. */
interface Waiting {
  resolve(text: string): void
  reject(error: Error): void
}

/**
 * Register `ask_project`.
 *
 * @param ctx the governor's context.
 * @param governor the governor.
 */
export function registerAskProject(ctx: Context, governor: OpsGovernor): void {
  /** Requests (= runs) that answer a question, by id. */
  const waiting = new Map<string, Waiting>()
  const settle = (runId: string, outcome: { text: string } | { error: string }): void => {
    const entry = waiting.get(runId)
    if (entry === undefined) return
    waiting.delete(runId)
    if ('text' in outcome) entry.resolve(outcome.text)
    else entry.reject(new Error(outcome.error))
  }
  ctx.on('ops/run-output', ({ runId, content }) => settle(runId, { text: textOf(content) }))
  ctx.on('ops/run-stopped', ({ runId, detail }) => settle(runId, { error: `the other project stopped: ${detail}` }))
  ctx.on('ops/run-interrupted', ({ runId }) => settle(runId, { error: 'the other project was interrupted' }))
  ctx.on('ops/request-rejected', ({ requestId, message }) => settle(requestId, { error: `the other project could not take the question: ${message}` }))
  ctx.effect(() => () => {
    for (const runId of waiting.keys()) settle(runId, { error: 'Argus is shutting down' })
  })

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'ask_project',
        description:
          'Ask another project a question and wait for its answer. It works in its own folder with its own ' +
          'memory, so ask for what it knows or can do there; give it everything it needs, since it sees ' +
          'nothing of your conversation. Its work is paid from its own budget.',
        parameters: {
          project: { type: 'string', description: 'The id of the project to ask.', required: true },
          question: { type: 'string', description: 'The question or request, complete in itself.', required: true },
        },
        output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
        execute: async (args, exec) => {
          const input = args as { project?: unknown; question?: unknown }
          const sessionId = exec.agent?.id as string | undefined
          const owner = sessionId === undefined ? undefined : ctx.opsProjects.ownerOf(sessionId)
          if (owner?.kind !== 'project') return 'Only a project can ask another project.'
          const target = typeof input.project === 'string' ? input.project.trim() : ''
          const question = typeof input.question === 'string' ? input.question.trim() : ''
          if (question.length === 0) return 'The question is empty.'
          if (target === owner.projectId) return 'That is this project; answer it yourself.'
          const config = ctx.opsProjects.configOf(target)
          if (config === undefined) return `There is no project "${target}". Projects: ${ctx.opsProjects.configuredIds().filter((id) => id !== owner.projectId).join(', ') || 'none other'}.`
          const ownRun = ctx.opsProjects.runOf(sessionId as string)
          if (ownRun !== undefined && waiting.has(ownRun)) return 'You are answering another project’s question, so you cannot ask one yourself. Answer with what you have.'
          if (governor.budgetState(`project:${owner.projectId}` as Scope).level === 'hard') return 'This project’s budget is used up; it cannot start more work.'

          const { requestId } = governor.submit({
            source: 'project',
            target: { projectId: target },
            content: [{ type: 'text', text: `Project ${owner.projectId} asks:\n\n${question}` }],
            priority: INTERACTIVE,
          })
          ctx.opsStore.audit.record({ actor: `project:${owner.projectId}`, action: 'project.asked', target, details: { requestId } }, Date.now())
          const limitMs = config.limits.max_wallclock_min * 60_000 + SLACK_MS
          try {
            const answer = await new Promise<string>((resolve, reject) => {
              const timer = setTimeout(() => settle(requestId, { error: `no answer within ${Math.round(limitMs / 60_000)} minutes` }), limitMs)
              waiting.set(requestId, {
                resolve: (text) => {
                  clearTimeout(timer)
                  resolve(text)
                },
                reject: (error) => {
                  clearTimeout(timer)
                  reject(error)
                },
              })
              exec.signal?.addEventListener('abort', () => {
                settle(requestId, { error: 'the question was cancelled' })
                governor.stop({ runId: requestId })
              })
            })
            return answer.length > 0 ? `${target} answers:\n\n${answer}` : `${target} finished without an answer.`
          } catch (error) {
            return `No answer from ${target}: ${(error as Error).message}.`
          }
        },
      }),
    ),
  )
}

/** The text of an answer's blocks. */
function textOf(content: readonly ContentBlockLike[]): string {
  return content
    .map((block) => (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .join('')
    .trim()
}
