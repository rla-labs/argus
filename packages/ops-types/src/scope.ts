// == ARGUS AGENT PROJECT ==
/**
 * Accounting scopes.
 *
 * A scope is the key a budget and a cost counter are filed under. It is derived
 * from an {@link Owner}, plus `'global'` for the deployment-wide budget.
 *
 * @module @argus-agent/types/scope
 */

/** A budget and accounting key: `global`, a single project, ad-hoc tasks, or the orchestrator. */
export type Scope = 'global' | 'adhoc' | 'orchestrator' | `project:${string}`

/** The scope prefix identifying a project. */
export const PROJECT_SCOPE_PREFIX = 'project:'

/**
 * Build the scope of one project.
 * @param projectId the project slug.
 * @returns the `project:<id>` scope.
 * @throws {TypeError} when `projectId` is empty or contains the separator.
 */
export function projectScope(projectId: string): Scope {
  if (projectId.length === 0) throw new TypeError('projectScope: projectId must not be empty')
  if (projectId.includes(':')) {
    throw new TypeError(`projectScope: projectId must not contain ":": ${JSON.stringify(projectId)}`)
  }
  return `${PROJECT_SCOPE_PREFIX}${projectId}`
}

/**
 * Parse a scope string.
 *
 * Used where a scope arrives from outside typed code — a command argument, a
 * database row, a config key — and must be validated rather than trusted.
 *
 * @param value the candidate scope.
 * @returns the scope, or `undefined` when it is not a valid scope.
 */
export function parseScope(value: string): Scope | undefined {
  if (value === 'global' || value === 'adhoc' || value === 'orchestrator') return value
  if (!value.startsWith(PROJECT_SCOPE_PREFIX)) return undefined
  const id = value.slice(PROJECT_SCOPE_PREFIX.length)
  if (id.length === 0 || id.includes(':')) return undefined
  return `${PROJECT_SCOPE_PREFIX}${id}`
}

/**
 * Read the project id out of a scope.
 * @param scope the scope to inspect.
 * @returns the project id, or `undefined` for a non-project scope.
 */
export function projectIdOfScope(scope: Scope): string | undefined {
  return scope.startsWith(PROJECT_SCOPE_PREFIX) ? scope.slice(PROJECT_SCOPE_PREFIX.length) : undefined
}

/**
 * Whether a scope is one a project's own run is charged to.
 *
 * `global` is deliberately excluded: every run is *checked* against the global
 * budget, but only `project:<id>`, `adhoc` and `orchestrator` are the scope the
 * run's usage is *recorded* under. Keeping these two questions separate is what
 * prevents double-counting in the rollups.
 *
 * @param scope the scope to inspect.
 * @returns whether the scope is a per-owner scope.
 */
export function isOwnerScope(scope: Scope): boolean {
  return scope !== 'global'
}
