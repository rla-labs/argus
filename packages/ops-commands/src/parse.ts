// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/commands/parse` — strict argument parsing for the command layer.
 *
 * Every parser is pure and returns a discriminated result rather than throwing,
 * so a command handler is a series of `if (!result.ok) return fail(result)` and
 * the error message is always the one the parser produced. **A parse error must
 * show the correct syntax**: that is the whole reason this module is separate
 * from the handlers and tested on its own.
 *
 * @module @argus-agent/commands/parse
 */

/** A successful parse. */
export interface ParseOk<T> {
  readonly ok: true
  readonly value: T
}

/** A failed parse, carrying a message that shows the correct syntax. */
export interface ParseFail {
  readonly ok: false
  readonly message: string
}

/** The result of a parse. */
export type ParseResult<T> = ParseOk<T> | ParseFail

/** Succeed. */
export function ok<T>(value: T): ParseOk<T> {
  return { ok: true, value }
}

/** Fail with a message that shows the correct syntax. */
export function fail(message: string): ParseFail {
  return { ok: false, message }
}

/**
 * Split a command's raw input into whitespace-separated tokens.
 *
 * Quotes group: `"a b"` is one token. That matters for `/task`, whose text is
 * free-form and may legitimately contain anything, and for `/p` with a project
 * id that a user pasted with stray whitespace.
 *
 * @param raw the text following the command name.
 * @returns the tokens, with quotes removed.
 */
export function tokenize(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false

  for (const char of raw.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * The remainder of a raw input starting at a token index, restored to plain text.
 *
 * `/task` forwards its text **verbatim**, so it cannot use the tokenized form: a
 * user who typed two spaces or a newline meant them (AGENTS.md rule 7). This
 * finds where the nth token begins and returns everything from there, trimmed of
 * the separator whitespace only.
 *
 * @param raw the text following the command name.
 * @param skip how many leading tokens to skip.
 * @returns the remaining text, or an empty string.
 */
export function restAfter(raw: string, skip: number): string {
  let index = 0
  let seen = 0
  const text = raw.trimStart()

  while (index < text.length && seen < skip) {
    // Skip the token.
    while (index < text.length && !isSpace(text[index] as string)) index += 1
    // Skip the separator.
    while (index < text.length && isSpace(text[index] as string)) index += 1
    seen += 1
  }
  return seen === skip ? text.slice(index) : ''
}

/** Whether a character is whitespace. */
function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

/** A parsed duration. */
export interface Duration {
  /** The duration in milliseconds. */
  readonly ms: number
  /** The original text, for echoing back. */
  readonly text: string
}

/**
 * Parse a duration such as `30m`, `2h`, `1d`, `90s`, or a bare number of minutes.
 *
 * A bare number is minutes, because that is what an operator means by
 * `/budget project:x unlock 30`.
 *
 * @param text the text to parse.
 * @returns the duration.
 */
export function parseDuration(text: string): ParseResult<Duration> {
  const match = /^(\d+(?:\.\d+)?)([smhdw]?)$/.exec(text.trim().toLowerCase())
  if (match === null) {
    return fail(`"${text}" is not a duration. Use 90s, 30m, 2h, 1d.`)
  }
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail('a duration must be greater than zero. Use 90s, 30m, 2h, 1d.')
  }
  const unit = match[2] === '' ? 'm' : (match[2] as 's' | 'm' | 'h' | 'd' | 'w')
  const scale: Record<'s' | 'm' | 'h' | 'd' | 'w', number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }
  const ms = Math.round(amount * scale[unit])
  if (ms > 365 * 86_400_000) {
    return fail('a duration longer than a year is not accepted; use a permanent override instead.')
  }
  return ok({ ms, text: text.trim() })
}

/**
 * Parse a dollar amount into micro-USD.
 *
 * Accepts `2`, `2.5`, `$2`, `$2.50`. A bare number is USD.
 *
 * @param text the text to parse.
 * @returns the amount in micro-USD.
 */
export function parseMoney(text: string): ParseResult<number> {
  const cleaned = text.trim().replace(/^\$/, '')
  if (!/^\d+(?:\.\d{1,6})?$/.test(cleaned)) {
    return fail(`"${text}" is not an amount. Use 2, 2.5 or $2.50.`)
  }
  const amount = Number(cleaned)
  if (!Number.isFinite(amount) || amount < 0) {
    return fail('an amount cannot be negative.')
  }
  return ok(Math.round(amount * 1_000_000))
}

/** A parsed `provider/model` reference. */
export interface ModelRefText {
  readonly provider: string
  readonly model: string
  /** The original text. */
  readonly text: string
}

/**
 * Parse `provider/model`, splitting at the **first** slash.
 *
 * A model id may itself contain slashes (`openrouter/deepseek/…`), so splitting
 * anywhere else would produce a wrong provider.
 *
 * @param text the text to parse.
 * @returns the reference.
 */
export function parseModelRef(text: string): ParseResult<ModelRefText> {
  const trimmed = text.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) {
    return fail(`"${text}" is not a model. Use provider/model, for example anthropic/claude-sonnet-x.`)
  }
  const provider = trimmed.slice(0, slash)
  const model = trimmed.slice(slash + 1)
  if (/\s/.test(provider) || /\s/.test(model)) {
    return fail('a model reference cannot contain spaces.')
  }
  return ok({ provider, model, text: trimmed })
}

/** The period a usage or budget query covers. */
export type PeriodText = 'day' | 'month'

/**
 * Parse a period word.
 * @param text the text.
 * @returns the period, or `undefined` when it is not one.
 */
export function parsePeriod(text: string): PeriodText | undefined {
  const lowered = text.trim().toLowerCase()
  if (lowered === 'day' || lowered === 'today' || lowered === 'd') return 'day'
  if (lowered === 'month' || lowered === 'm') return 'month'
  return undefined
}

/**
 * Validate a project id against the same pattern the loader enforces.
 *
 * Kept in step with `ops-projects`' `PROJECT_ID_PATTERN`: a command that accepted
 * an id the loader rejects would write a file that fails the next reload.
 *
 * @param text the text.
 * @returns whether it is a valid id.
 */
export function isValidProjectId(text: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,40}$/.test(text)
}

/** A parsed scope selector for `/budget` and `/usage`. */
export interface ScopeText {
  /** The scope string the services use. */
  readonly scope: string
  /** Whether the user asked for the global scope. */
  readonly global: boolean
  /** Whether the user asked for the ad-hoc scope. */
  readonly adhoc: boolean
  /** The project id, when the scope is a project. */
  readonly projectId: string | undefined
}

/**
 * Parse a scope selector.
 *
 * Accepts `global`, `adhoc`, a bare project id, and the explicit `project:<id>`
 * form that `budgetState` reports — so an operator can copy a scope out of the
 * output and paste it back.
 *
 * @param text the text.
 * @param activeProject the chat's active project, used when the text is empty.
 * @returns the scope.
 */
export function parseScope(text: string, activeProject?: string): ParseResult<ScopeText> {
  const trimmed = text.trim().toLowerCase()
  if (trimmed === '' ) {
    if (activeProject === undefined) {
      return fail('no scope given and this chat has no active project. Use /p <id> first, or name a scope: global, adhoc or a project id.')
    }
    return ok({ scope: `project:${activeProject}`, global: false, adhoc: false, projectId: activeProject })
  }
  if (trimmed === 'global' || trimmed === 'all') {
    return ok({ scope: 'global', global: true, adhoc: false, projectId: undefined })
  }
  if (trimmed === 'adhoc' || trimmed === 'task' || trimmed === 'tasks') {
    return ok({ scope: 'adhoc', global: false, adhoc: true, projectId: undefined })
  }
  const bare = trimmed.startsWith('project:') ? trimmed.slice('project:'.length) : trimmed
  if (!isValidProjectId(bare)) {
    return fail(`"${text}" is not a scope. Use global, adhoc, or a project id.`)
  }
  return ok({ scope: `project:${bare}`, global: false, adhoc: false, projectId: bare })
}

/**
 * Format micro-USD as a dollar string.
 *
 * Six decimals are kept when the amount is small enough to need them, because a
 * metered deployment routinely deals in fractions of a cent and a report that
 * rounds to `$0.00` is useless.
 *
 * @param micros integer micro-USD.
 * @returns the formatted amount, without a currency symbol.
 */
export function formatUsd(micros: number): string {
  const dollars = micros / 1_000_000
  if (dollars === 0) return '0'
  if (Math.abs(dollars) < 0.01) return dollars.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return dollars.toFixed(2)
}

/**
 * Format a duration in milliseconds for a human.
 * @param ms the duration.
 * @returns a short form such as `2h 5m` or `45s`.
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s'
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}

/**
 * Format an epoch timestamp as an age relative to now.
 * @param ts the timestamp.
 * @param now the current time.
 * @returns a short form such as `5m ago`.
 */
export function formatAge(ts: number, now: number): string {
  return `${formatDuration(Math.max(0, now - ts))} ago`
}

/**
 * Pad a table's columns.
 *
 * Every list command renders through this, so the output is consistent and a
 * test can assert on a whole block rather than on a substring.
 *
 * @param rows the rows, including the header.
 * @returns the rendered lines.
 */
export function renderTable(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return []
  const columns = Math.max(...rows.map((row) => row.length))
  const widths: number[] = []
  for (let index = 0; index < columns; index += 1) {
    widths[index] = Math.max(...rows.map((row) => (row[index] ?? '').length))
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

/**
 * Truncate a string to a maximum length, with an ellipsis.
 * @param text the text.
 * @param max the maximum length.
 * @returns the truncated text.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * The spread of past values: the typical one (median), a big one (90th percentile)
 * and the largest. Nearest-rank percentiles, so every figure is one that happened.
 *
 * @param values the values, in any order.
 * @returns the spread, or `undefined` for no values.
 */
export function spreadOf(values: readonly number[]): { typical: number; big: number; most: number } | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number
  return { typical: rank(0.5), big: rank(0.9), most: sorted[sorted.length - 1] as number }
}
