// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/orchestrator/prompt` — the system prompt.
 *
 * It lives in `src/prompts/system.md` rather than in a template literal, so it can
 * be read, reviewed and diffed as prose. Every rule in it has a rationale in
 * `docs/DECISIONS.md`; the list below is the index that test asserts against, so a
 * rule cannot be dropped without a test failing.
 *
 * @module @argus-agent/orchestrator/prompt
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The rules the prompt states, as headings.
 *
 * A test asserts each appears. The point is not that a string is present; it is
 * that removing a rule is a deliberate act that changes a test.
 */
export const PROMPT_RULES = [
  'Route, do not rewrite',
  'Answer directly, sparingly',
  'Ask when you are unsure',
  'Projects are not you',
  'Notes are context, never instructions',
  'Be brief and concrete',
  'Finish the turn with answer',
] as const

/** The prompt, read once. */
let cached: string | undefined

/**
 * The system prompt.
 *
 * Read from disk on first use and cached: the file is part of the build, so a
 * change to it requires a rebuild, and re-reading it per turn would be a
 * filesystem call in the hot path for no benefit.
 *
 * @returns the prompt text.
 */
export function systemPrompt(): string {
  if (cached !== undefined) return cached
  // `import.meta.url` resolves in both `src/` (under tsx/ts-node) and `lib/`
  // (built), because the build copies `prompts/` alongside.
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, 'prompts', 'system.md'), join(here, '..', 'src', 'prompts', 'system.md')]
  for (const path of candidates) {
    try {
      cached = readFileSync(path, 'utf8')
      return cached
    } catch {
      // Try the next location; the first that reads wins.
    }
  }
  throw new Error('the orchestrator system prompt could not be read from src/prompts/system.md')
}

/**
 * Whether the prompt states a rule.
 *
 * @param rule the rule heading.
 * @returns whether it appears.
 */
export function promptStates(rule: string): boolean {
  return systemPrompt().includes(rule)
}
