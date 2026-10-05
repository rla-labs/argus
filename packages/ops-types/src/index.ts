// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/types` — shared types, branded primitives and the error hierarchy.
 *
 * Types only, plus tiny constructors and type guards. There is no service, no
 * I/O and no state here: every other `ops-*` package depends on this one, so it
 * must stay dependency-light and free of side effects.
 *
 * @module @argus-agent/types
 */

export * from './scope.js'
export * from './owner.js'
export * from './model.js'
export * from './channel.js'
export * from './channel-adapter.js'
export * from './errors.js'
export * from './events.js'
export * from './clock.js'
export * from './config.js'
export * from './messages.js'
export * from './health.js'
