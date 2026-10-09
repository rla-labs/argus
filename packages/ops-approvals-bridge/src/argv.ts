// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/approvals-bridge/argv` — parsing commands and matching allow rules.
 *
 * **This module is a security boundary.** The `auto_allow` list decides what a
 * project may run without a human looking at it, and a mistake here is a bypass:
 * someone writes `auto_allow: ["git status"]` expecting read-only inspection and
 * gets `git status; rm -rf /` executed unattended.
 *
 * The rule that makes it safe:
 *
 * > **Match on PARSED TOKENS, exactly. Never a substring, never a prefix of the
 * > raw string, never a regular expression.**
 *
 * A raw-string prefix match on `"git status"` accepts `"git status; rm -rf /"`,
 * because the forbidden part comes *after* the permitted prefix. Token matching
 * cannot: the argv is `['git','status;','rm','-rf','/']`, and comparing element by
 * element against `['git','status']` fails at the second token.
 *
 * @module @argus-agent/approvals-bridge/argv
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** What a request's action looks like, once parsed. */
export interface ParsedAction {
  /** The tool being asked about. */
  readonly toolName: string
  /** The argv, when the tool is a process runner. */
  readonly argv: readonly string[]
  /** A file path, when the tool is a file operation. */
  readonly path?: string
  /** The kind of action, for scoping an "approve all". */
  readonly kind: ActionKind
}

/** The category of an action, used to scope a run-wide approval. */
export type ActionKind = 'command' | 'file-write' | 'file-read' | 'network' | 'other'

/**
 * Split a command line into argv tokens.
 *
 * Handles quoting the way a shell would — single quotes verbatim, double quotes
 * with backslash escapes — because a rule written against an unquoted form must
 * not match a quoted one and vice versa. It does **not** interpret shell
 * metacharacters: `;`, `&&`, `|` and `$()` are ordinary characters, which is
 * exactly what makes the token comparison safe.
 *
 * Returns `[]` for a malformed line (an unterminated quote), which matches no rule
 * and therefore asks.
 *
 * @param line the command line.
 * @returns the tokens.
 */
export function tokenizeCommand(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | undefined

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string

    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && index + 1 < line.length) {
        index += 1
        current += line[index] as string
      } else current += char
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < line.length) {
      index += 1
      current += line[index] as string
      started = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
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

  if (quote !== undefined) return [] // an unterminated quote: unusable, so it asks
  if (started) tokens.push(current)
  return tokens
}

/**
 * Tokens that chain, background, substitute or redirect a command.
 *
 * **A prefix match alone is not safe.** `['git','status','&&','rm','-rf','/']`
 * begins with `git status`, so a rule for `git status` would allow it — and the
 * second command would run unattended. Exact token comparison stops
 * `git status; rm -rf /` (where `;` glues itself to the token) but **not**
 * `git status && rm -rf /`, where the metacharacter is a token of its own.
 *
 * So any argv containing one of these is refused an automatic allow. It still
 * reaches a human, which is the correct outcome for a compound command: the
 * allowlist names one command, and this is more than one.
 */
const CHAINING_TOKENS: ReadonlySet<string> = new Set([
  '&&',
  '||',
  '&',
  ';',
  '|',
  '|||',
  '>',
  '>>',
  '<',
  '2>',
  '2>>',
  '<<',
  '<<<',
  ';;',
  '|&',
])

/**
 * Whether any token chains, backgrounds, substitutes or redirects.
 *
 * Also catches substitution and redirection *inside* a token, since those attach
 * to an argument: `$(...)`, `` `...` ``, `${...}`, and a leading `<`/`>`.
 *
 * @param argv the parsed tokens.
 * @returns whether the command is compound or does more than one thing.
 */
export function isCompound(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (CHAINING_TOKENS.has(token)) return true
    // Attached substitution or redirection, which cannot be seen as a separate
    // token because it is glued to an argument.
    if (token.includes('$(') || token.includes('`') || token.includes('${')) return true
    if (token.startsWith('>') || token.startsWith('<')) return true
  }
  return false
}

/**
 * Whether an argv matches an allow rule, token by token.
 *
 * The rule matches when the argv **begins with** the rule's tokens **and the argv
 * is a single command**. That is a prefix at the *token* level, which is the useful
 * notion: `git status` should cover `git status --short` but never `git push`, and
 * never `git status && rm -rf /`.
 *
 * @param argv the parsed tokens.
 * @param rule the rule's tokens.
 * @returns whether it matches.
 */
export function matchesRule(argv: readonly string[], rule: readonly string[]): boolean {
  if (rule.length === 0 || argv.length < rule.length) return false
  // One rule names one command. A compound argv is more than one, so it goes to a
  // human however neatly its prefix matches.
  if (isCompound(argv)) return false
  for (let index = 0; index < rule.length; index += 1) {
    // Exact comparison. Not `includes`, not `startsWith` on a joined string.
    if (argv[index] !== rule[index]) return false
  }
  // The rule must account for the WHOLE argv once trailing options are allowed.
  // Without this, a line break followed by a second command — which tokenizes to
  // a plain five-token
  // list with no metacharacter, because a newline is a token separator — would
  // match a rule for the first two tokens and run the second command unattended.
  return coversRest(argv, rule.length)
}

/**
 * Whether the tokens after a rule's match are options rather than a new command.
 *
 * A rule for `git status` must accept `git status --short` (an option) and refuse
 * `git status rm -rf /` (a second command). The distinction: everything after the
 * match must look like a flag — a leading `-` — or be a value attached to one.
 *
 * Requiring flags is the conservative reading, and it costs only a longer rule when
 * a command legitimately takes positional arguments after the matched prefix.
 *
 * @param argv the parsed tokens.
 * @param matched how many tokens the rule consumed.
 * @returns whether the tail is options only.
 */
function coversRest(argv: readonly string[], matched: number): boolean {
  for (let index = matched; index < argv.length; index += 1) {
    const token = argv[index] as string
    // A flag, or the value of a flag that was written `--opt=value`.
    if (token.startsWith('-')) continue
    // A bare word after the match is a positional argument, which could be a
    // subcommand or a path a rule did not name. Refuse it: the rule can be
    // extended to name it explicitly.
    return false
  }
  return true
}

/** The result of consulting the allowlist. */
export type AllowMatch =
  | { readonly allowed: true; readonly rule: string }
  | { readonly allowed: false }

/**
 * Whether an argv is allowed without asking.
 *
 * @param argv the parsed tokens.
 * @param rules the configured rules, each a command line.
 * @returns the match, naming the rule that allowed it.
 */
export function matchAllowList(argv: readonly string[], rules: readonly string[]): AllowMatch {
  // An empty argv must never be allowed by an empty rule, and an empty rule list
  // allows nothing.
  if (argv.length === 0) return { allowed: false }

  for (const rule of rules) {
    const ruleTokens = tokenizeCommand(rule)
    if (matchesRule(argv, ruleTokens)) return { allowed: true, rule }
  }
  return { allowed: false }
}

/**
 * Classify an action, for scoping a run-wide approval.
 *
 * "Approve all for this run" must mean *all actions of this kind*, not all actions
 * of any kind. Approving a batch of `git status` calls must not silently authorize
 * the `git push` that follows.
 *
 * @param toolName the tool.
 * @param argv the argv, when there is one.
 * @returns the kind.
 */
export function classifyAction(toolName: string, argv: readonly string[]): ActionKind {
  const name = toolName.toLowerCase()

  if (isProcessTool(name)) return 'command'
  if (isWriteTool(name)) return 'file-write'
  if (isReadTool(name)) return 'file-read'
  if (isNetworkTool(name)) return 'network'
  if (argv.length > 0) return 'command'
  return 'other'
}

/** Whether a tool runs a process. */
function isProcessTool(name: string): boolean {
  return (
    name === 'bash' ||
    name === 'pwsh' ||
    name === 'run_code' ||
    name === 'shell' ||
    name === 'exec' ||
    name === 'run' ||
    name.includes('terminal') ||
    name.includes('command')
  )
}

/** Whether a tool writes a file. */
function isWriteTool(name: string): boolean {
  return name === 'write' || name === 'edit' || name === 'multiedit' || name === 'patch' || name.includes('write')
}

/** Whether a tool reads a file. */
function isReadTool(name: string): boolean {
  return name === 'read' || name === 'read_image' || name === 'glob' || name === 'grep' || name === 'ls'
}

/** Whether a tool reaches the network. */
function isNetworkTool(name: string): boolean {
  return name.includes('fetch') || name.includes('web') || name.includes('http') || name.includes('curl')
}

/**
 * Build the parsed action for a request.
 *
 * @param toolName the tool.
 * @param argv the argv, when the caller could extract one.
 * @param path a file path, when the caller could extract one.
 * @returns the action.
 */
export function parseAction(
  toolName: string,
  argv: readonly string[] = [],
  path?: string,
): ParsedAction {
  return {
    toolName,
    argv,
    ...(path === undefined ? {} : { path }),
    kind: classifyAction(toolName, argv),
  }
}

/**
 * A short, safe rendering of an action for a message.
 *
 * Truncated, because an approval question is a chat message with a length limit
 * and a command could be enormous. Control characters are stripped: a command
 * containing a newline could otherwise forge extra lines in the question and make
 * the displayed action differ from the one being approved — which is the whole
 * thing a human is supposed to be checking.
 *
 * @param action the action.
 * @param maxLength the maximum length.
 * @returns the rendering.
 */
export function renderAction(action: ParsedAction, maxLength = 300): string {
  const raw =
    action.argv.length > 0
      ? action.argv.join(' ')
      : action.path !== undefined
        ? `${action.toolName} ${action.path}`
        : action.toolName

  // Strip control characters, including newlines and tabs, then collapse runs of
  // spaces so the rendering cannot be padded to hide a suffix off-screen.
  // Matching control characters IS the job here: they are what could forge extra
  // lines in a message and make the displayed action differ from the approved one.
  /* eslint-disable no-control-regex -- see above */
  const withoutControls = raw.replace(/[\u0000-\u001F\u007F]/g, ' ')
  /* eslint-enable no-control-regex */
  const cleaned = withoutControls.replace(/ {2,}/g, ' ').trim()

  if (cleaned.length <= maxLength) return cleaned
  // Keep the START, which is what identifies the command, and say it was cut.
  return `${cleaned.slice(0, maxLength - 3)}...`
}

/**
 * Whether a path an agent names stays inside its folder.
 *
 * Relative paths resolve against the folder, as dsh's file tools resolve them, and
 * both sides go through `realpath` so a symlink inside the folder cannot point out of
 * it. A `~` path is outside:
 * it is not resolved here, and a backend that expands it would reach the home folder.
 *
 * @param root the agent's folder.
 * @param path the path, absolute or relative to `root`.
 * @returns whether it is `root` or below it.
 */
export function isInside(root: string, path: string): boolean {
  if (path.startsWith('~')) return false
  // The nearest part that exists is resolved, and the rest kept: a file not yet
  // made under a symlinked folder is still under the symlink's target.
  const real = (target: string): string => {
    try {
      return realpathSync(target)
    } catch {
      const parent = dirname(target)
      return parent === target ? target : join(real(parent), basename(target))
    }
  }
  const base = real(resolve(root))
  const rel = relative(base, real(resolve(base, path)))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
