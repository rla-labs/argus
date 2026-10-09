// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/channel/format` — turning a run's output into a message.
 *
 * Pure functions, because the rules here are the ones a user notices: a prefix
 * that says where a message came from, a long answer that arrives as a file
 * rather than being truncated, and a progress line that updates instead of
 * flooding.
 *
 * @module @argus-agent/channel/format
 */
import { formatUsd } from '@argus-agent/commands'
import type {
  AdapterLimits,
  ContentBlockLike,
  OutgoingFile,
} from '@argus-agent/types'

/** What a run's output is about. */
export interface OutputSubject {
  readonly kind: 'project' | 'adhoc' | 'orchestrator'
  readonly projectId?: string
}

/**
 * The prefix that says where a message came from.
 *
 * `[project-id]` for a project, `[task]` for a one-off, and nothing for the
 * orchestrator — its replies are the conversation itself, and a prefix would read
 * as noise.
 *
 * @param subject what the output is about.
 * @returns the prefix, including its trailing space, or an empty string.
 */
export function prefixFor(subject: OutputSubject): string {
  switch (subject.kind) {
    case 'project':
      return `[${subject.projectId ?? 'project'}] `
    case 'adhoc':
      return '[task] '
    case 'orchestrator':
      return ''
  }
}

/** The text of a content-block list. */
export function textOf(content: readonly ContentBlockLike[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

/** What a formatted message holds. */
export interface FormattedOutput {
  /** The message text, already prefixed and possibly a summary line. */
  readonly text: string
  /** Files to attach. */
  readonly files: readonly OutgoingFile[]
  /** Paths of files too large to attach, named in the text. */
  readonly tooLarge: readonly string[]
}

/**
 * Format a run's output as a message.
 *
 * Three rules, in order:
 *
 * 1. The prefix.
 * 2. Text longer than the adapter allows becomes a `.md` **attachment** with a
 *    short summary line, rather than being truncated. Truncating a project's
 *    answer would silently lose the end of it, which for a report is the part
 *    that matters.
 * 3. A produced file within `maxFileBytes` is attached; a larger one is listed by
 *    path, because the operator can fetch it and the channel cannot send it.
 *
 * @param content the run's output blocks.
 * @param subject what the output is about.
 * @param limits the adapter's limits.
 * @param produced files the run produced.
 * @returns the message and what could not be attached.
 */
export function formatOutput(
  content: readonly ContentBlockLike[],
  subject: OutputSubject,
  limits: AdapterLimits,
  produced: readonly { readonly name: string; readonly path: string; readonly sizeBytes?: number }[] = [],
): FormattedOutput {
  const prefix = prefixFor(subject)
  const body = textOf(content)
  const files: OutgoingFile[] = []
  const tooLarge: string[] = []

  let text = `${prefix}${body}`.trimEnd()

  for (const file of produced) {
    if (file.sizeBytes !== undefined && file.sizeBytes > limits.maxFileBytes) {
      tooLarge.push(file.path)
      continue
    }
    files.push({ name: file.name, path: file.path })
  }

  // The length check counts the FINAL text, including any file list, because that
  // is what the adapter will actually send.
  const withFiles = appendTooLarge(text, tooLarge)
  if (withFiles.length > limits.maxTextLength) {
    const fileName = `${subject.kind === 'project' ? (subject.projectId ?? 'project') : subject.kind}-output.md`
    files.push({ name: fileName, bytes: new TextEncoder().encode(withFiles) })
    return {
      text: summarise(prefix, body, withFiles.length, fileName, limits.maxTextLength),
      files,
      tooLarge,
    }
  }

  return { text: withFiles, files, tooLarge }
}

/** Append the "too large to attach" list. */
function appendTooLarge(text: string, tooLarge: readonly string[]): string {
  if (tooLarge.length === 0) return text
  return `${text}\n\nToo large to send:\n${tooLarge.map((path) => `  ${path}`).join('\n')}`
}

/**
 * A summary line for output that was converted to a file.
 *
 * The result must be **short**: the whole reason for converting was that the text
 * did not fit, so a summary that is itself long defeats the conversion. The head
 * is trimmed against a fixed budget, and the caller's limit is respected.
 *
 * @param prefix the subject prefix.
 * @param body the full text.
 * @param length how long the full text is.
 * @param fileName the attachment's name.
 * @param maxLength the adapter's limit.
 * @returns the summary.
 */
export function summarise(
  prefix: string,
  body: string,
  length: number,
  fileName: string,
  maxLength = 400,
): string {
  const trailer = `\n\n(${length} characters — sent as ${fileName})`
  // One character of headroom: a summary exactly at the limit is one an adapter
  // that counts differently would reject, and the point of the conversion is that
  // the message always fits.
  const budget = Math.max(0, maxLength - prefix.length - trailer.length - 1)
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? ''
  const head = firstLine.length > budget ? `${firstLine.slice(0, Math.max(0, budget - 1))}…` : firstLine
  return `${prefix}${head}${trailer}`.trimEnd()
}

/** A per-run progress state. */
export interface ProgressState {
  /** The message the adapter sent, so later updates edit it. */
  messageId: string | undefined
  /** When the last update was sent. */
  lastSentAt: number
  /** Whether anything has been sent yet. */
  sent: boolean
}

/**
 * Whether a progress update may be sent now.
 *
 * The **first** update is immediate, so a long run shows something at once
 * instead of a blank chat for up to an interval. Later ones are throttled, because
 * an edit per step would spend the adapter's rate limit on a message nobody is
 * reading yet.
 *
 * @param state the run's progress state.
 * @param now the current time.
 * @param intervalMs the configured interval.
 * @returns whether to send.
 */
export function shouldSendProgress(state: ProgressState, now: number, intervalMs: number): boolean {
  if (!state.sent) return true
  return now - state.lastSentAt >= intervalMs
}

/** What a progress message says. */
export interface ProgressInput {
  readonly subject: OutputSubject
  readonly steps: number
  readonly elapsedMs: number
  readonly maxSteps: number
  readonly costMicros: number
}

/**
 * The progress text.
 *
 * It carries the step count **against the limit**, because "12 steps" means
 * nothing to an operator and "12 (limit 60 per run)" tells them how much rope is
 * left. "12 of 60" read as sixty tasks to do.
 *
 * @param input the run's progress.
 * @returns the text.
 */
export function progressText(input: ProgressInput): string {
  const prefix = prefixFor(input.subject)
  const minutes = Math.floor(input.elapsedMs / 60_000)
  const seconds = Math.floor((input.elapsedMs % 60_000) / 1_000)
  const elapsed = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
  return (
    `${prefix}working…\n` +
    `  step    ${input.steps} (limit ${input.maxSteps} per run)\n` +
    `  elapsed ${elapsed}\n` +
    `  cost    $${formatUsd(input.costMicros)}`
  )
}

/** A run-end banner. */
export function stoppedText(subject: OutputSubject, reason: string, detail: string): string {
  return `${prefixFor(subject)}stopped: ${detail}\n(reason: ${reason})`
}

/** An interruption notice. */
export function interruptedText(subject: OutputSubject, runId: string): string {
  return `${prefixFor(subject)}run ${runId} was interrupted by a restart. Nothing was lost that had finished.`
}

/** A budget threshold notice. */
export function budgetText(
  scope: string,
  level: string,
  pct: number,
  spentMicros: number,
  limitMicros: number,
): string {
  const emoji = level === 'hard' ? '⛔' : level === 'soft' ? '⚠️' : 'ℹ️'
  return (
    `${emoji} ${scope} budget ${level} (${pct.toFixed(0)}%)\n` +
    `  spent  $${formatUsd(spentMicros)}\n` +
    `  limit  $${formatUsd(limitMicros)}`
  )
}

/** A stalled-queue notice. */
export function stalledText(
  requestId: string,
  projectId: string | null,
  waitedMs: number,
  reason: string | undefined,
): string {
  const minutes = Math.floor(waitedMs / 60_000)
  return (
    `A request has been waiting ${minutes} minute(s).\n` +
    `  request  ${requestId}\n` +
    `  project  ${projectId ?? 'adhoc'}\n` +
    (reason === undefined ? '  reason   not yet determined' : `  reason   ${reason}`)
  )
}

/** A panic notice. */
export function panicText(cancelled: number, tookMs: number): string {
  return (
    `⛔ PANIC: stopped ${cancelled} agent(s) in ${tookMs} ms.\n` +
    'Nothing new will run until /resume-all.'
  )
}

/**
 * The operator's notice when a price refresh moved the price of a model in use.
 * @param changes per model, USD per 1M tokens before and after.
 * @returns the text.
 */
export function pricesChangedText(
  changes: ReadonlyArray<{
    readonly model: string
    readonly before: { readonly input: number; readonly output: number } | null
    readonly after: { readonly input: number; readonly output: number } | null
  }>,
): string {
  const price = (p: { input: number; output: number } | null) => (p === null ? 'no price' : `$${p.input} in / $${p.output} out`)
  const lines = ['💲 Prices changed for model(s) in use (per 1M tokens):']
  for (const change of changes) lines.push(`  ${change.model}: ${price(change.before)} → ${price(change.after)}`)
  if (changes.some((change) => change.after === null)) {
    lines.push('', 'A model with no price is refused until you add it to pricing in ops.yaml.')
  }
  return lines.join('\n')
}

/** A request the governor refused, told to the chat that sent it. */
export function rejectedText(code: string, message: string): string {
  return `Not run (${code}): ${message}`
}

/**
 * The operator's notice when the set of invalid project files changes.
 *
 * @param invalid every invalid project now.
 * @param fixed projects that validate again.
 * @returns the text.
 */
export function invalidProjectsText(
  invalid: readonly { readonly id: string; readonly path: string; readonly reason: string }[],
  fixed: readonly string[],
): string {
  const lines: string[] = []
  if (fixed.length > 0) lines.push(`✅ Valid again: ${fixed.join(', ')}`)
  if (invalid.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`⚠️ ${invalid.length} project file(s) do not validate. These projects are ignored; everything else keeps running.`)
    for (const project of invalid) {
      lines.push('', `${project.id} — ${project.path}`)
      for (const issue of project.reason.split('\n')) lines.push(`  ${issue}`)
    }
    lines.push('', 'Fix the file(s), then send /reload.')
  }
  return lines.join('\n')
}

/** A schedule-skipped notice. */
export function scheduleSkippedText(name: string, reason: string, nextRunAt?: number): string {
  const next =
    nextRunAt === undefined ? '' : `\nNext attempt: ${new Date(nextRunAt).toISOString()}`
  return `Scheduled task "${name}" was skipped: ${reason}${next}`
}

/**
 * Split a message into chunks of at most `maxTextLength`.
 *
 * Splitting happens at a **newline** where one is available, so a chunk boundary
 * does not cut a sentence in half. An adapter that must split long text uses this
 * rather than slicing.
 *
 * @param text the text.
 * @param maxTextLength the adapter's limit.
 * @returns the chunks.
 */
export function chunkText(text: string, maxTextLength: number): string[] {
  if (text.length <= maxTextLength) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxTextLength) {
    // The window is one character wider than the limit so a newline sitting
    // exactly at the boundary is found and can end the chunk.
    const window = remaining.slice(0, maxTextLength + 1)
    const breakAt = window.lastIndexOf('\n')
    // A newline in the last tenth is used; otherwise the cut is hard, because
    // searching further back would produce a tiny first chunk.
    const cut = breakAt >= maxTextLength * 0.9 ? breakAt : maxTextLength
    // The newline that ends a chunk is KEPT, so joining the chunks restores the
    // original text exactly. Dropping it would silently join two lines.
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}
