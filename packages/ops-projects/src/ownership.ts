// == ARGUS AGENT PROJECT ==
/**
 * The ownership map: which owner a session belongs to.
 *
 * Every session in the process resolves to exactly one {@link Owner}:
 *
 * - a session created by `ensureAgent` or `createEphemeral` is registered
 *   directly;
 * - a **subagent** session is not registered, so it is resolved by walking
 *   `session.header.parentSession` to the root (SPIKES.md spike 2);
 * - an unknown session resolves to `undefined`, never a throw.
 *
 * The map is also the run tracker's index: a session's current run is what the
 * meter attributes usage to.
 *
 * @module @argus-agent/projects/ownership
 */
import type { Owner } from '@argus-agent/types'
import { ownerKey } from '@argus-agent/types'

/** A session's registration. */
interface Entry {
  readonly owner: Owner
  /** The run this session is currently serving, when one is open. */
  runId: string | undefined
}

/** The owner and run a session resolves to. */
export interface Resolved {
  readonly owner: Owner
  readonly runId: string | undefined
}

/**
 * Tracks which owner each live session belongs to.
 *
 * Keyed by session id as a string, because a dsh `SessionId` is branded and a
 * `Map<SessionId, …>` would force every caller to brand its lookups.
 */
export class OwnershipMap {
  private readonly bySession = new Map<string, Entry>()
  /** Cached root resolutions for child sessions, so a deep walk happens once. */
  private readonly rootCache = new Map<string, string>()
  private readonly childIndex = new Map<string, Set<string>>()

  /**
   * Register a session as belonging to an owner.
   *
   * @param sessionId the session id.
   * @param owner the owner.
   * @param runId the run the session is serving, when one is open.
   */
  register(sessionId: string, owner: Owner, runId?: string): void {
    this.bySession.set(sessionId, { owner, runId })
    // A direct registration invalidates any cached child resolution, because a
    // child may have been walked before its parent was registered.
    this.rootCache.clear()
  }

  /**
   * Record a parent link, so a child can be resolved without a session header.
   *
   * Used for in-process subagents, whose `parentAgent` relation is known here
   * but whose session header is only read on a cold path.
   *
   * @param childSessionId the child session.
   * @param parentSessionId the parent session.
   */
  linkChild(childSessionId: string, parentSessionId: string): void {
    const children = this.childIndex.get(parentSessionId) ?? new Set<string>()
    children.add(childSessionId)
    this.childIndex.set(parentSessionId, children)
    this.rootCache.delete(childSessionId)
  }

  /**
   * Open a run for a session.
   * @param sessionId the session.
   * @param runId the run id.
   */
  setRun(sessionId: string, runId: string): void {
    const entry = this.bySession.get(sessionId)
    if (entry) {
      this.bySession.set(sessionId, { owner: entry.owner, runId })
      return
    }
    // A session whose owner is not known yet still needs its run recorded, so
    // usage arriving before registration is attributed once the owner appears.
    this.pendingRuns.set(sessionId, runId)
  }

  /** Runs recorded for sessions whose owner was not registered yet. */
  private readonly pendingRuns = new Map<string, string>()

  /**
   * Close a session's run.
   * @param sessionId the session.
   */
  clearRun(sessionId: string): void {
    const entry = this.bySession.get(sessionId)
    if (entry) this.bySession.set(sessionId, { owner: entry.owner, runId: undefined })
    this.pendingRuns.delete(sessionId)
  }

  /**
   * Remove a session's registration.
   *
   * Called when an agent is disposed. The parent link is kept, because a
   * subagent's session may still be resolved by a meter that saw its events
   * before the disposal.
   *
   * @param sessionId the session.
   */
  unregister(sessionId: string): void {
    this.bySession.delete(sessionId)
    this.pendingRuns.delete(sessionId)
    this.rootCache.delete(sessionId)
  }

  /**
   * Resolve a session directly, without walking parents.
   * @param sessionId the session.
   * @returns the entry, or `undefined`.
   */
  get(sessionId: string): Resolved | undefined {
    const entry = this.bySession.get(sessionId)
    if (entry) return { owner: entry.owner, runId: entry.runId }
    const pending = this.pendingRuns.get(sessionId)
    return pending === undefined ? undefined : { owner: undefined as never, runId: pending }
  }

  /**
   * The owner of a session, walking parents for a subagent.
   *
   * The walk uses the in-process child index, so a subagent created through
   * `parentAgent` resolves without a session-header lookup. A caller that also
   * has the session object should prefer {@link resolve} with a header reader,
   * which additionally survives a restart.
   *
   * @param sessionId the session.
   * @returns the owner, or `undefined` when it is unknown.
   */
  ownerOf(sessionId: string): Owner | undefined {
    const direct = this.bySession.get(sessionId)
    if (direct !== undefined) return direct.owner
    const root = this.rootOf(sessionId)
    return root === undefined ? undefined : this.bySession.get(root)?.owner
  }

  /**
   * The run a session is currently serving.
   *
   * Walks to the root when the session itself is not registered, so a subagent's
   * usage is attributed to the parent's run.
   *
   * @param sessionId the session.
   * @returns the run id, or `undefined` when no run is open.
   */
  runOf(sessionId: string): string | undefined {
    const direct = this.bySession.get(sessionId)
    if (direct?.runId !== undefined) return direct.runId
    if (direct) return undefined

    // A child's run is its root's run.
    const root = this.rootOf(sessionId)
    if (root === undefined) return this.pendingRuns.get(sessionId)
    const entry = this.bySession.get(root)
    return entry?.runId ?? this.pendingRuns.get(sessionId)
  }

  /**
   * Walk the parent chain to the root session.
   *
   * Uses the in-process child index first (a subagent created through
   * `parentAgent` is linked here) and falls back to the session's durable
   * `parentSession` header, which is what makes the walk survive a restart.
   *
   * @param sessionId the session.
   * @param lookupHeader reads a session's `parentSession`, when the session object is available.
   * @returns the root session id, or `undefined` when the chain is broken.
   */
  rootOf(sessionId: string, lookupHeader?: (id: string) => string | undefined): string | undefined {
    const cached = this.rootCache.get(sessionId)
    if (cached !== undefined) return cached
    if (this.bySession.has(sessionId)) {
      this.rootCache.set(sessionId, sessionId)
      return sessionId
    }

    // Follow the in-process parent chain, with a visited set so a cycle cannot
    // hang the process.
    const visited = new Set<string>()
    let current = sessionId
    for (;;) {
      if (visited.has(current)) return undefined
      visited.add(current)
      if (this.bySession.has(current)) {
        this.rootCache.set(sessionId, current)
        return current
      }
      const parent = this.parentOf(current, lookupHeader)
      if (parent === undefined) return undefined
      current = parent
    }
  }

  private parentOf(sessionId: string, lookupHeader?: (id: string) => string | undefined): string | undefined {
    for (const [parent, children] of this.childIndex) {
      if (children.has(sessionId)) return parent
    }
    return lookupHeader?.(sessionId)
  }

  /**
   * Resolve a session to its owner, walking parents.
   *
   * @param sessionId the session.
   * @param lookupHeader reads a session's `parentSession` header.
   * @returns the owner and run, or `undefined` when the session is unknown.
   */
  resolve(sessionId: string, lookupHeader?: (id: string) => string | undefined): Resolved | undefined {
    const direct = this.bySession.get(sessionId)
    if (direct) return { owner: direct.owner, runId: direct.runId }

    const root = this.rootOf(sessionId, lookupHeader)
    if (root === undefined) {
      const pending = this.pendingRuns.get(sessionId)
      return pending === undefined ? undefined : { owner: undefined as never, runId: pending }
    }
    const entry = this.bySession.get(root)
    return entry === undefined ? undefined : { owner: entry.owner, runId: entry.runId }
  }

  /** Every registered session and its owner key, for diagnostics. */
  entries(): Array<{ sessionId: string; ownerKey: string; runId: string | undefined }> {
    return [...this.bySession].map(([sessionId, entry]) => ({
      sessionId,
      ownerKey: ownerKey(entry.owner),
      runId: entry.runId,
    }))
  }

  /** How many sessions are registered. */
  get size(): number {
    return this.bySession.size
  }

  /** Drop every registration. Used on unload and between tests. */
  clear(): void {
    this.bySession.clear()
    this.rootCache.clear()
    this.childIndex.clear()
    this.pendingRuns.clear()
  }
}
