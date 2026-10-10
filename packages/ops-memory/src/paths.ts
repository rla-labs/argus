// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/memory/paths` — where memory lives, and the budgets on it.
 *
 * **Everything in this module is about keeping memory OUT of a project's
 * workspace.** A project's agent has file tools rooted at its `cwd` and a shell
 * that can run anywhere the sandbox allows; memory inside that directory is memory
 * the agent can read, rewrite or delete as a side effect of doing its job. The
 * state tree is a sibling of the project, not a child of it.
 *
 * @module @argus-agent/memory/paths
 */
import { join } from 'node:path'

/** The pattern a project id must match, shared with the project loader. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/

/**
 * Whether a project id is safe to turn into a path component.
 *
 * The same pattern `ops-projects` uses. It is checked here as well, and the
 * duplication is deliberate: this module builds filesystem paths, and a
 * path-traversal id reaching `join` would be an escape from the state tree. A
 * second check at the point of use is defence in depth, not redundancy.
 *
 * @param id the project id.
 * @returns whether it is usable as a path component.
 */
export function isSafeProjectId(id: string): boolean {
  return PROJECT_ID_PATTERN.test(id)
}

/**
 * A project's state directory.
 *
 * @param dataDir the deployment's data directory.
 * @param projectId the project id.
 * @returns the absolute path.
 * @throws {Error} when the id is not safe to use as a path component.
 */
export function projectStateDir(dataDir: string, projectId: string): string {
  if (!isSafeProjectId(projectId)) {
    // Refusing here rather than sanitizing: a project id that cannot be a path
    // component is a programming error upstream, and silently mangling it would
    // write one project's memory into another's directory.
    throw new Error(`refusing to build a memory path for unsafe project id ${JSON.stringify(projectId)}`)
  }
  return join(dataDir, 'state', projectId)
}

/**
 * A project's `MEMORY.md`.
 *
 * @param dataDir the data directory.
 * @param projectId the project id.
 * @returns the absolute path.
 */
export function memoryFile(dataDir: string, projectId: string): string {
  return join(projectStateDir(dataDir, projectId), 'MEMORY.md')
}

/**
 * A project's recall index.
 *
 * @param dataDir the data directory.
 * @param projectId the project id.
 * @returns the absolute path.
 */
export function recallFile(dataDir: string, projectId: string): string {
  return join(projectStateDir(dataDir, projectId), 'recall.sqlite')
}

/**
 * The global user profile.
 *
 * Global, so it is **not** under any project's state directory: it is shared by
 * every agent, and a project must not be able to reach it by a path derived from
 * its own id.
 *
 * @param dataDir the data directory.
 * @returns the absolute path.
 */
export function userProfileFile(dataDir: string): string {
  return join(dataDir, 'memory', 'USER.md')
}

/**
 * A project's `INSTRUCTIONS.md`: what the person wants of it, in the system prompt.
 *
 * Beside `MEMORY.md`, outside the project's folder, so the agent cannot rewrite
 * its own instructions.
 *
 * @param dataDir the data directory.
 * @param projectId the project id.
 * @returns the absolute path.
 */
export function instructionsFile(dataDir: string, projectId: string): string {
  return join(projectStateDir(dataDir, projectId), 'INSTRUCTIONS.md')
}

/** The largest `INSTRUCTIONS.md` that is written: it is in every request's prompt. */
export const MAX_INSTRUCTIONS_BYTES = 8 * 1024

/** The default `memory.max_inject_tokens`. */
export const DEFAULT_MAX_INJECT_TOKENS = 2000

/** The default `memory.max_file_bytes`. */
export const DEFAULT_MAX_FILE_BYTES = 16 * 1024

/**
 * Estimate a text's token count.
 *
 * Four characters per token, which is the usual rough figure for English and code.
 * It is an **estimate**, and that is stated wherever a budget is documented: a real
 * tokenizer would be a dependency and a per-model decision, and the budget exists
 * to bound a prompt's size rather than to predict a bill.
 *
 * Rounds up, so a short text is never estimated at zero.
 *
 * @param text the text.
 * @returns the estimated tokens.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

/** Where memory is injected, and how much of it. */
export interface MemoryBudgets {
  /** The estimated-token budget for everything injected into one agent. */
  readonly maxInjectTokens: number
  /** The largest `MEMORY.md` may become. */
  readonly maxFileBytes: number
}
