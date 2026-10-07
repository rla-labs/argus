// == ARGUS AGENT PROJECT ==
/**
 * The error hierarchy.
 *
 * Every error Argus Agent throws is an {@link OpsError} carrying a stable `code`
 * string. Codes are part of the public contract: a command handler, a channel
 * adapter and a test all branch on `code`, never on the message. Each plugin
 * extends {@link OpsErrorCodeMap} by declaration merging in its own
 * `src/errors.ts`, so the set of codes is the union of what is mounted and the
 * compiler rejects a typo.
 *
 * @module @argus-agent/types/errors
 */

/**
 * Error codes contributed by each plugin.
 *
 * A plugin merges its own variant into this interface. The union below is
 * therefore the complete set of codes the composition can throw.
 */
export interface OpsErrorCodeMap {
  /** A configuration value is missing, malformed or contradictory. */
  'CONFIG_INVALID': true
  /** A referenced project does not exist. */
  'PROJECT_NOT_FOUND': true
  /** A project's file exists but does not validate; it is ignored until fixed. */
  'PROJECT_INVALID': true
  /** Another Argus Agent process already uses this data directory. */
  'INSTANCE_LOCKED': true
  /** A project exists but its status forbids the operation (`paused`, `archived`). */
  'PROJECT_NOT_ACTIVE': true
  /** A project's configuration file is missing or invalid. */
  'PROJECT_CONFIG_INVALID': true
  /** A budget limit refuses the request. */
  'BUDGET_EXCEEDED': true
  /** The target model has no price and `unknown_model_policy` is `block`. */
  'UNPRICED_MODEL': true
  /** A model names a provider no route serves: not in the catalog, not declared in `providers:`. */
  'PROVIDER_UNKNOWN': true
  /** A model's provider has no API key: `<PROVIDER>_API_KEY` is not set. */
  'PROVIDER_KEY_MISSING': true
  /** A provider authenticates by sign-in (Bedrock, Vertex, Azure, …), which Argus does not support. */
  'PROVIDER_UNSUPPORTED': true
  /** A provider is known but does not offer this model. */
  'MODEL_UNKNOWN': true
  /** No concurrency slot is free. */
  'NO_SLOT': true
  /** The system is in panic mode and accepts nothing. */
  'PANIC_MODE': true
  /** A per-run limit (steps, wallclock, loop) stopped the run. */
  'RUN_LIMIT_EXCEEDED': true
  /** The same tool with identical arguments repeated past the threshold. */
  'LOOP_DETECTED': true
  /** A caller tried to start execution without going through the governor. */
  'GOVERNOR_REQUIRED': true
  /** A capability token is missing, wrong, or already used. */
  'INVALID_CAPABILITY': true
  /** A command's arguments could not be parsed. */
  'COMMAND_USAGE': true
  /** A command is not registered, or its dependency is not installed. */
  'COMMAND_UNAVAILABLE': true
  /** An operation requires confirmation that was not given. */
  'CONFIRMATION_REQUIRED': true
  /** A channel adapter is not registered. */
  'CHANNEL_UNAVAILABLE': true
  /** The user is not on the allowlist. */
  'ACCESS_DENIED': true
  /** A cron expression is invalid or too frequent. */
  'SCHEDULE_INVALID': true
  /** A referenced schedule does not exist. */
  'SCHEDULE_NOT_FOUND': true
  /** A durable store operation failed. */
  'STORE_ERROR': true
  /** A migration is missing, out of order, or newer than the code knows. */
  'MIGRATION_ERROR': true
  /** A memory operation was refused (size, isolation, unknown section). */
  'MEMORY_REFUSED': true
  /** An approval was refused, timed out, or had no answerer. */
  'APPROVAL_DENIED': true
  /** A model reference is malformed. */
  'INVALID_MODEL_REF': true
  /** A requested operation is not implemented in this build. */
  'NOT_IMPLEMENTED': true
  /** An invariant that indicates a bug was violated. */
  'INTERNAL': true
}

/** Every error code Argus Agent can throw. */
export type OpsErrorCode = keyof OpsErrorCodeMap

/**
 * An error with a stable, machine-readable code.
 *
 * @example
 * ```ts
 * try {
 *   await ctx.opsGovernor.submit(request)
 * } catch (error) {
 *   if (OpsError.hasCode(error, 'BUDGET_EXCEEDED')) {
 *     await channel.deliver(address, { text: 'Budget exhausted for today.' })
 *   }
 *   throw error
 * }
 * ```
 */
export class OpsError extends Error {
  /** Stable machine-readable code. Branch on this, never on `message`. */
  readonly code: OpsErrorCode

  /**
   * Structured context for logs and diagnostics.
   *
   * Must be JSON-serializable: it is written to `audit_log.details_json` and
   * logged as structured fields.
   */
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: OpsErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OpsError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }

  /**
   * Whether an unknown value is an {@link OpsError} with one exact code.
   *
   * The check is **structural**, not `instanceof`. A workspace can hold two
   * copies of this module — a package's compiled `lib/` and another package's
   * `src/` — and an error thrown by one is not `instanceof` the other's class.
   * Since the whole point of a stable `code` is that a caller can branch on it
   * across a boundary, the duck-typed check is the correct one.
   *
   * @param value the caught value.
   * @param code the code to test.
   * @returns whether it matches.
   */
  static hasCode(value: unknown, code: OpsErrorCode): value is OpsError {
    return isOpsErrorLike(value) && value.code === code
  }

  /**
   * Whether an unknown value is an {@link OpsError}.
   * @param value the caught value.
   * @returns whether it is an OpsError.
   */
  static is(value: unknown): value is OpsError {
    return isOpsErrorLike(value)
  }

  /**
   * Convert any caught value into an {@link OpsError}.
   *
   * A boundary that must not leak an arbitrary throw (an event listener, a
   * command handler) uses this to normalize.
   *
   * @param value the caught value.
   * @param fallbackCode the code to use for a non-`OpsError`.
   * @returns an OpsError, either the original or a wrapper.
   */
  static from(value: unknown, fallbackCode: OpsErrorCode = 'INTERNAL'): OpsError {
    if (value instanceof OpsError) return value
    if (value instanceof Error) {
      return new OpsError(fallbackCode, value.message, { cause: value.name })
    }
    return new OpsError(fallbackCode, String(value))
  }

  /**
   * The error as a structured log line.
   * @returns a plain object with the code, message and details.
   */
  toJSON(): { code: OpsErrorCode; message: string; details: Readonly<Record<string, unknown>> } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/**
 * Every code this module's map declares, for the structural check below.
 *
 * A subclass such as `ProjectConfigError` sets its own `name`, so the check
 * cannot rely on `name === 'OpsError'`. Requiring the code to be one this
 * module knows is both looser (a subclass passes) and stricter (an unrelated
 * object with a `code` field does not).
 */
function isKnownCode(value: unknown): value is OpsErrorCode {
  return typeof value === 'string' && value in KNOWN_CODES
}

/** The code vocabulary, built once from the map's declared keys. */
const KNOWN_CODES: Record<string, true> = {
  CONFIG_INVALID: true,
  PROJECT_NOT_FOUND: true,
  PROJECT_INVALID: true,
  INSTANCE_LOCKED: true,
  PROJECT_NOT_ACTIVE: true,
  PROJECT_CONFIG_INVALID: true,
  BUDGET_EXCEEDED: true,
  UNPRICED_MODEL: true,
  PROVIDER_UNKNOWN: true,
  PROVIDER_KEY_MISSING: true,
  PROVIDER_UNSUPPORTED: true,
  MODEL_UNKNOWN: true,
  NO_SLOT: true,
  PANIC_MODE: true,
  RUN_LIMIT_EXCEEDED: true,
  LOOP_DETECTED: true,
  GOVERNOR_REQUIRED: true,
  INVALID_CAPABILITY: true,
  COMMAND_USAGE: true,
  COMMAND_UNAVAILABLE: true,
  CONFIRMATION_REQUIRED: true,
  CHANNEL_UNAVAILABLE: true,
  ACCESS_DENIED: true,
  SCHEDULE_INVALID: true,
  SCHEDULE_NOT_FOUND: true,
  STORE_ERROR: true,
  MIGRATION_ERROR: true,
  MEMORY_REFUSED: true,
  APPROVAL_DENIED: true,
  INVALID_MODEL_REF: true,
  NOT_IMPLEMENTED: true,
  INTERNAL: true,
}

/**
 * Whether a value looks like an `OpsError` from any copy of this module.
 *
 * @param value the candidate.
 * @returns whether it carries a known code and an object `details`.
 */
function isOpsErrorLike(value: unknown): value is OpsError {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (!isKnownCode(record['code'])) return false
  const details = record['details']
  return details !== null && typeof details === 'object'
}

/**
 * Throw an {@link OpsError}.
 *
 * A convenience for the common `throw opsError('CODE', 'message')` shape, which
 * reads better in guard clauses than `throw new OpsError(...)`.
 *
 * @param code the stable code.
 * @param message the human-readable message.
 * @param details structured context.
 * @returns never — the function always throws.
 */
export function opsError(
  code: OpsErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new OpsError(code, message, details)
}

/**
 * Assert a condition, throwing an {@link OpsError} when it fails.
 *
 * @param condition the condition that must hold.
 * @param code the code to throw when it does not.
 * @param message the message to throw.
 * @param details structured context.
 * @throws {OpsError} when `condition` is falsy.
 */
export function opsAssert(
  condition: unknown,
  code: OpsErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) throw new OpsError(code, message, details)
}
