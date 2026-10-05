// == ARGUS AGENT PROJECT ==
/**
 * Ownership: what a dsh session belongs to.
 *
 * Every session in the process — a project's agent, an ad-hoc task, the
 * orchestrator, and any subagent they spawn — resolves to exactly one
 * {@link Owner}. `ops-projects` computes it by walking `parentSession` to the
 * root (see `docs/developer-docs.md#verified-dsh-facts` spike 2), and everything downstream
 * (metering, budgets, delivery, memory) asks it rather than guessing.
 *
 * @module @argus-agent/types/owner
 */
import type { Scope } from './scope.js'
import { projectScope } from './scope.js'

/** What a session belongs to. */
export type Owner =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'adhoc'; readonly runId: string }
  | { readonly kind: 'orchestrator' }

/** The owner of a project agent. */
export function projectOwner(projectId: string): Owner {
  return { kind: 'project', projectId }
}

/** The owner of a one-off task. */
export function adhocOwner(runId: string): Owner {
  return { kind: 'adhoc', runId }
}

/** The owner of the orchestrator agent. */
export function orchestratorOwner(): Owner {
  return { kind: 'orchestrator' }
}

/**
 * The accounting scope an owner's usage is recorded under.
 * @param owner the owner to map.
 * @returns the owner's scope (never `global`).
 */
export function scopeOfOwner(owner: Owner): Scope {
  switch (owner.kind) {
    case 'project':
      return projectScope(owner.projectId)
    case 'adhoc':
      return 'adhoc'
    case 'orchestrator':
      return 'orchestrator'
  }
}

/**
 * A stable string identity for an owner, suitable as a map key.
 *
 * Distinct from {@link scopeOfOwner}: an ad-hoc owner's scope is shared by every
 * task, while this identity distinguishes one task from another.
 *
 * @param owner the owner to encode.
 * @returns a stable, collision-free key.
 */
export function ownerKey(owner: Owner): string {
  switch (owner.kind) {
    case 'project':
      return `project:${owner.projectId}`
    case 'adhoc':
      return `adhoc:${owner.runId}`
    case 'orchestrator':
      return 'orchestrator'
  }
}

/**
 * Parse an owner key produced by {@link ownerKey}.
 * @param key the key to parse.
 * @returns the owner, or `undefined` when the key is not a valid owner key.
 */
export function parseOwnerKey(key: string): Owner | undefined {
  if (key === 'orchestrator') return orchestratorOwner()
  if (key.startsWith('project:')) {
    const projectId = key.slice('project:'.length)
    return projectId.length > 0 && !projectId.includes(':') ? projectOwner(projectId) : undefined
  }
  if (key.startsWith('adhoc:')) {
    const runId = key.slice('adhoc:'.length)
    return runId.length > 0 ? adhocOwner(runId) : undefined
  }
  return undefined
}

/**
 * Whether two owners are the same.
 * @param a first owner.
 * @param b second owner.
 * @returns whether they are equal.
 */
export function ownersEqual(a: Owner, b: Owner): boolean {
  return ownerKey(a) === ownerKey(b)
}

/**
 * A human-readable label for an owner, for messages and logs.
 * @param owner the owner to label.
 * @returns the project id, `task`, or `orchestrator`.
 */
export function ownerLabel(owner: Owner): string {
  switch (owner.kind) {
    case 'project':
      return owner.projectId
    case 'adhoc':
      return 'task'
    case 'orchestrator':
      return 'orchestrator'
  }
}
