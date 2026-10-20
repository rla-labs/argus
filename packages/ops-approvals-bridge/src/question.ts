// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/approvals-bridge/question` — what the operator sees, and what the
 * buttons carry.
 *
 * @module @argus-agent/approvals-bridge/question
 */
import { formatUsd, type Button, type MicroUsd } from '@argus-agent/types'
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
  /** How many times the same action was approved by a person in this project in the last 7 days. */
  readonly repeated?: number
  /** A scheduled run's wait, in seconds, instead of `timeoutMinutes`. */
  readonly unattendedSeconds?: number
}

/**
 * The command that makes a rule: what a button or a person sends.
 *
 * @param rule the rule.
 * @param projectId the project.
 * @returns the command line.
 */
export function ruleCommand(rule: AlwaysRule, projectId: string): string {
  return `/rule ${projectId} ${rule.key === 'tools.web_hosts' ? 'host ' : ''}${rule.entry}`
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
    input.unattendedSeconds === undefined
      ? `No answer in ${input.timeoutMinutes} minute(s) means NO.`
      : `A scheduled run: no answer in ${input.unattendedSeconds} second(s) means NO.`,
  )
  if ((input.repeated ?? 0) >= 2) {
    lines.push(`Approved ${input.repeated} times in the last 7 days: “Always allow” makes it a rule.`)
  }
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

/** The loop question's button values. */
export const CONTINUE = 'continue'
export const STOP = 'stop'

/** What a loop question says. */
export interface CheckpointInput {
  readonly projectId: string | null
  readonly runId: string
  /** Why the loop checker thinks it is a loop. */
  readonly reason: string
  readonly steps: number
  readonly elapsedMs: number
  /** Files changed since the run started; undefined without snapshots. */
  readonly changes: { readonly files: number; readonly added: number; readonly removed: number } | undefined
  readonly costMicros: number
  readonly timeoutMinutes: number
}

/** The loop question's buttons. */
export function checkpointButtons(): Button[] {
  return [
    { value: CONTINUE, label: 'Continue' },
    { value: STOP, label: 'Stop' },
  ]
}

/**
 * The loop question: why the checker thinks the run goes in circles, and what the run
 * did, so a person decides knowing both.
 *
 * @param input what the checker said and the run did.
 * @returns the text.
 */
export function checkpointQuestion(input: CheckpointInput): string {
  const where = input.projectId === null ? 'an ad-hoc task' : `project ${input.projectId}`
  const lines = [
    `Possible loop: ${where}`,
    '',
    `The loop checker: ${sanitize(input.reason, 200)}`,
    '',
    `  run     ${input.runId}`,
    `  steps   ${input.steps}`,
    `  time    ${Math.round(input.elapsedMs / 60_000)} min`,
  ]
  if (input.changes !== undefined) {
    lines.push(`  files   ${input.changes.files} changed (+${input.changes.added} −${input.changes.removed}) since it started`)
  }
  lines.push(
    `  cost    ${formatUsd(input.costMicros as MicroUsd, { decimals: 4 })}`,
    '',
    `Continue lets it go on. No answer in ${input.timeoutMinutes} minute(s) stops it; its work is kept, and "continue" picks it up.`,
  )
  return lines.join('\n')
}
