// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/memory/truncate` — fitting memory into a budget.
 *
 * Two rules shape this:
 *
 * 1. **The most recent sections win.** A project's recent decisions matter more
 *    than what it concluded a month ago, and a truncated memory that drops them
 *    would be worse than useless.
 * 2. **Truncation is always announced.** An agent that silently received half its
 *    memory will act confidently on an incomplete picture — and worse, may "correct"
 *    a memory file whose contents it never saw. So the injected text says what was
 *    left out and what to do about it.
 *
 * @module @argus-agent/memory/truncate
 */
import type { MemoryBlock } from './memory-file.js'

/** What one injection contains. */
export interface Injection {
  /** The text to inject. */
  readonly text: string
  /** Whether part of the memory was left out. */
  readonly truncated: boolean
  /** The sections that were included, by name. */
  readonly included: readonly string[]
  /** The sections that were left out, by name. */
  readonly omitted: readonly string[]
  /** The estimated tokens of the result. */
  readonly tokens: number
}

/** Options for {@link composeInjection}. */
export interface InjectionOptions {
  /** The user profile's text, injected first. `''` when absent or disabled. */
  readonly userProfile: string
  /** The project's sections, in file order (oldest first). */
  readonly sections: readonly MemoryBlock[]
  /** The estimated-token budget for everything injected. */
  readonly maxTokens: number
  /** The project id, for the announcement. */
  readonly projectId?: string
  /** Estimates tokens; injected so a test controls the arithmetic. */
  readonly estimate: (text: string) => number
}

/** The heading the injected block sits under. */
export const MEMORY_HEADING = '## Project memory'

/**
 * Build the text to inject into an agent.
 *
 * **Whole sections, never a cut-off section.** A section truncated mid-sentence
 * could state half a decision — which is worse than not stating it, because the
 * agent cannot tell. So sections are added newest-first while they fit, and the
 * first one that does not fit ends the selection rather than being split.
 *
 * The user profile is included **whole** and is not subject to the section
 * selection: it is a preference list, it is bounded by its own file, and an agent
 * with half its operator's preferences would violate the other half confidently.
 * Its size is charged against the budget, so a huge `USER.md` reduces how much
 * project memory fits — which is the honest accounting.
 *
 * @param options what to inject and how much.
 * @returns the injection.
 */
export function composeInjection(options: InjectionOptions): Injection {
  const parts: string[] = []
  const omitted: string[] = []

  const profile = options.userProfile.trim()
  let used = 0
  if (profile.length > 0) {
    const block = ['## About the operator', '', profile].join('\n')
    parts.push(block)
    used += options.estimate(block)
  }

  // Newest first: the last section in file order was written most recently, and
  // `applyUpdate` appends a new section at the end.
  const ordered = [...options.sections].reverse()
  const chosen: MemoryBlock[] = []
  let truncated = false

  for (const section of ordered) {
    const block = `### ${section.name}\n\n${section.body}`
    const cost = options.estimate(block)
    if (used + cost > options.maxTokens) {
      // The section does not fit whole. Everything older than it is omitted too,
      // so the selection stays a contiguous recent window rather than a
      // cherry-picked set that would misrepresent what the project knew.
      truncated = true
      omitted.push(section.name)
      continue
    }
    chosen.push(section)
    used += cost
  }

  // Restore file order, so the injected memory reads the way the file does.
  chosen.reverse()

  if (chosen.length > 0) {
    parts.push([MEMORY_HEADING, '', ...chosen.map((section) => `### ${section.name}\n\n${section.body}`)].join('\n'))
  }

  if (truncated) {
    parts.push(
      [
        '## Memory was truncated',
        '',
        `Only the most recent part of this project's memory fitted in the context budget (${options.maxTokens} estimated tokens).`,
        `Omitted: ${omitted.reverse().join(', ')}.`,
        'If you need one of those, it is in the memory file on disk — but read it rather than guessing, and do not overwrite it.',
      ].join('\n'),
    )
  }

  const text = parts.join('\n\n')
  return {
    text,
    truncated,
    included: chosen.map((section) => section.name),
    omitted: omitted.reverse(),
    tokens: options.estimate(text),
  }
}

/**
 * Whether an injection has any content at all.
 *
 * @param injection the injection.
 * @returns whether there is something to inject.
 */
export function hasContent(injection: Injection): boolean {
  return injection.text.trim().length > 0
}
