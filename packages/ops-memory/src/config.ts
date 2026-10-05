// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/memory/config` — the `memory` section.
 *
 * @module @argus-agent/memory/config
 */
import z from '@deepseek-ai/schemastery'
import type { Schema } from './schema-type.js'
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_INJECT_TOKENS } from './paths.js'

/** The `memory` section. */
export interface MemorySection {
  /** Whether memory is injected and its tools registered at all. */
  readonly enabled: boolean
  /** The estimated-token budget for everything injected into one agent. */
  readonly max_inject_tokens: number
  /** The largest a project's `MEMORY.md` may become. */
  readonly max_file_bytes: number
  /** Whether the user profile is injected by default. */
  readonly user_profile: boolean
  /** Whether turns are indexed for `recall`. */
  readonly index_turns: boolean
  /** How many recall results a query returns by default. */
  readonly recall_limit: number
}

/** The `memory` schema. */
export const memorySchema: Schema = z
  .object({
    enabled: z.boolean().default(true),
    max_inject_tokens: z.number().min(100).default(DEFAULT_MAX_INJECT_TOKENS),
    max_file_bytes: z.number().min(512).default(DEFAULT_MAX_FILE_BYTES),
    user_profile: z.boolean().default(true),
    index_turns: z.boolean().default(true),
    recall_limit: z.number().min(1).max(50).default(5),
  })
  .default({})

/**
 * Build the section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function memoryOf(raw: Record<string, unknown>): MemorySection {
  const parse = memorySchema as unknown as (value: unknown) => MemorySection
  return parse(raw['memory'] ?? {})
}
