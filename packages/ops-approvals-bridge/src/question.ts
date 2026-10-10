// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/approvals-bridge/question` — what the operator sees, and what the
 * buttons carry.
 *
 * @module @argus-agent/approvals-bridge/question
 */
import type { Button } from '@argus-agent/types'
import { isCompound, renderAction, type ParsedAction } from './argv.js'

/**
 * The button values.
 *
 * Prefixed so the channel's button handler can tell an approval press from a
 * command and from a question answer — the three shapes a button value has.
 */
export const APPROVE = 'approve'
export const DENY = 'deny'
export const APPROVE_ALL = 'approve-all'
export const ALWAYS = 'always'

/** What "Always allow" would write into the project file. */
export interface AlwaysRule {
  /** The project setting it extends. */
  readonly key: 'approvals.auto_allow' | 'tools.web_hosts'
  /** The entry it adds: a whole command, or a host. */
  readonly entry: string
}

/**
 * What "Always allow" would allow from now on, when it can be named exactly.
 *
 * A command is allowed whole (its trailing options aside), never by a prefix: the
 * allowlist matches a rule against the entire command, so `git push origin main`
 * allows exactly that. A compound command has no single rule. A page fetch allows
 * its host.
 *
 * @param toolName the tool.
 * @param action the parsed call.
 * @returns the rule, or `undefined` when there is none to offer.
 */
export function alwaysRuleOf(toolName: string, action: ParsedAction | undefined): AlwaysRule | undefined {
  if (action === undefined) return undefined
  if (action.kind === 'command' && action.argv.length > 0 && !isCompound(action.argv)) {
    const tokens = [...action.argv]
    while (tokens.length > 1 && (tokens.at(-1) as string).startsWith('-')) tokens.pop()
    const entry = tokens.join(' ')
    // A rule is written to YAML and read back as tokens: keep it to plain words.
    return /^[\w./:=@+-]+( [\w./:=@+-]+)*$/.test(entry) && entry.length <= 120 ? { key: 'approvals.auto_allow', entry } : undefined
  }
  if (toolName === 'web_fetch' && action.path !== undefined) {
    try {
      const host = new URL(action.path).hostname.toLowerCase()
      return host.length > 0 ? { key: 'tools.web_hosts', entry: host } : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The "Always allow" button for a rule. */
export function alwaysButton(rule: AlwaysRule, projectId: string): Button {
  const what = rule.entry.length > 40 ? `${rule.entry.slice(0, 39)}…` : rule.entry
  return { value: ALWAYS, label: `Always allow “${what}” in ${projectId}` }
}

/** The buttons every approval question carries. */
export function approvalButtons(): Button[] {
  return [
    { value: APPROVE, label: 'Approve' },
    { value: DENY, label: 'Deny' },
    // The label names the SCOPE, because "approve all" without a scope is a
    // question nobody can answer responsibly.
    { value: APPROVE_ALL, label: 'Approve all of this kind for this run' },
  ]
}

/** What the question is about. */
export interface QuestionInput {
  readonly projectId: string | null
  readonly runId: string
  readonly action: ParsedAction | undefined
  readonly toolName: string
  readonly reason: string | undefined
  readonly timeoutMinutes: number
  /** How many other requests are pending, so the operator knows it is not alone. */
  readonly alsoPending: number
}

/**
 * Build the question text.
 *
 * It states **what**, **where** and **for how long**, because an approval prompt
 * whose subject is ambiguous is worse than no prompt: it trains the operator to
 * press Approve.
 *
 * @param input what the question is about.
 * @returns the text.
 */
export function approvalQuestion(input: QuestionInput): string {
  const where = input.projectId === null ? 'an ad-hoc task' : `project ${input.projectId}`
  const action = input.action === undefined ? input.toolName : renderAction(input.action, 300)
  const kind = input.action?.kind ?? 'other'

  const lines = [
    'Approval needed',
    '',
    `  project   ${where}`,
    `  run       ${input.runId}`,
    `  tool      ${input.toolName}`,
    `  kind      ${kind}`,
    `  action    ${action}`,
  ]
  if (input.reason !== undefined && input.reason.trim().length > 0) {
    lines.push(`  reason    ${sanitize(input.reason, 200)}`)
  }
  lines.push(
    '',
    `No answer in ${input.timeoutMinutes} minute(s) means NO.`,
  )
  if (input.alsoPending > 0) {
    lines.push(`${input.alsoPending} other request(s) are waiting; each is answered on its own.`)
  }
  return lines.join('\n')
}

/**
 * The text for a decision, so the chat shows what happened.
 *
 * @param value the button value.
 * @param action the action.
 * @returns the text.
 */
export function decisionText(value: string, action: ParsedAction | undefined): string {
  const what = action === undefined ? 'the action' : renderAction(action, 120)
  switch (value) {
    case APPROVE:
      return `Approved once: ${what}`
    case APPROVE_ALL:
      return `Approved for this run (all ${action?.kind ?? 'other'} actions): ${what}`
    case DENY:
      return `Denied: ${what}`
    default:
      return `Ignored an unknown answer: ${value}`
  }
}

/**
 * The text a request gets when it is refused without asking.
 *
 * @param reason why.
 * @returns the text.
 */
export function refusedText(reason: string): string {
  return `Refused without asking: ${reason}`
}

/** Strip control characters and truncate. */
export function sanitize(text: string, maxLength: number): string {
  // Matching control characters IS the job here: they are what could forge extra
  // lines in a message and make the displayed action differ from the approved one.
  /* eslint-disable no-control-regex -- see above */
  const withoutControls = text.replace(/[\u0000-\u001F\u007F]/g, ' ')
  /* eslint-enable no-control-regex */
  const cleaned = withoutControls.replace(/ {2,}/g, ' ').trim()
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 3)}...`
}
