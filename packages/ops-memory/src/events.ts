// == ARGUS AGENT PROJECT ==
/**
 * Cordis event declarations owned by `ops-memory`.
 *
 * @module @argus-agent/memory/events
 */
// Brings in the `ops/*` event map's module resolution, as the other plugins do.
import type {} from '@argus-agent/types'

/** Where memory was injected, and how much fitted. */
export type MemoryScope = 'project' | 'user-only' | 'none'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Memory was injected into an agent.
     *
     * Emitted for every agent, including the ones that receive nothing — so a
     * consumer can tell "no memory was injected" from "the plugin did not run".
     *
     * @param payload.source why the session started, from dsh's `agent/created`.
     * @param payload.truncated whether part of the memory was left out.
     * @mode emit
     */
    'ops/memory-injected'(payload: {
      readonly sessionId: string
      readonly projectId: string | null
      readonly scope: MemoryScope
      readonly source: string
      readonly tokens: number
      readonly included: readonly string[]
      readonly omitted: readonly string[]
      readonly truncated: boolean
    }): void

    /**
     * A project's memory file was updated.
     * @param payload.summary a one-line diff, for an audit consumer.
     * @mode emit
     */
    'ops/memory-updated'(payload: {
      readonly projectId: string
      readonly section: string
      readonly mode: 'replace' | 'append'
      readonly bytes: number
      readonly summary: string
      readonly sessionId: string
    }): void

    /**
     * A turn was indexed for recall.
     * @mode emit
     */
    'ops/memory-indexed'(payload: {
      readonly projectId: string
      readonly sessionId: string
      readonly turn: number
      readonly roles: readonly string[]
    }): void
  }
}

export {}
