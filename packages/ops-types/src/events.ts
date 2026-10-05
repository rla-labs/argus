// == ARGUS AGENT PROJECT ==
/**
 * Event-declaration scaffolding.
 *
 * Argus Agent plugins communicate through services (direct calls) and through their
 * own Cordis events, all prefixed `ops/`. Each plugin declares its events by
 * merging into {@link OpsEventMap}; the bundle's `src/events.ts` merges that map
 * into Cordis's own `Events` interface once, so emitters and listeners are
 * type-checked against a single vocabulary.
 *
 * The indirection exists so a plugin can declare its events without importing
 * Cordis's augmentation target directly, which keeps `ops-types` free of a
 * runtime Cordis dependency.
 *
 * @module @argus-agent/types/events
 */

/**
 * The payload map for every `ops/*` event.
 *
 * A plugin merges its own events in, keyed by the full event name:
 *
 * ```ts
 * declare module '@argus-agent/types' {
 *   interface OpsEventMap {
 *     'ops/run-output'(payload: { owner: Owner; sessionId: string }): void
 *   }
 * }
 * ```
 *
 * The value is a function signature whose parameters are the event's arguments,
 * matching Cordis's own `Events` convention. `void` as the return type means
 * the event is fire-and-forget (`emit` mode); `Promise<void>` means listeners
 * are awaited (`parallel` or `serial` mode).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface OpsEventMap {
  /** A configuration (re)load was requested. */
  'ops/config-load'(): void
  /** The configuration is in force. */
  'ops/config-loaded'(payload: { readonly configPath: string }): void
}

/** Every `ops/*` event name. */
export type OpsEventName = keyof OpsEventMap & string

/**
 * The payload type of one event.
 * @template T the event name.
 */
export type OpsEventPayload<T extends OpsEventName> = Parameters<OpsEventMap[T]>

/**
 * Whether an event name belongs to Argus Agent.
 *
 * Every `ops/*` event does; nothing else should. Used by tests that assert no
 * plugin invented an unprefixed event.
 *
 * @param name the event name to test.
 * @returns whether the name carries the `ops/` prefix.
 */
export function isOpsEvent(name: string): name is OpsEventName {
  return name.startsWith('ops/')
}

/** The prefix every Argus Agent event carries. */
export const OPS_EVENT_PREFIX = 'ops/'
