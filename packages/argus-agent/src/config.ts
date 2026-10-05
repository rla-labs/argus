// == ARGUS AGENT PROJECT ==
/**
 * Config schema and defaults for the Argus Agent bundle.
 *
 * This module owns the *root* of `ops.yaml`. Every plugin contributes its own
 * section by calling {@link ConfigRegistry.extend} at load; the bundle
 * assembles the complete schema, validates the file once, and fails fast at boot
 * naming the invalid key.
 *
 * @module @argus-agent/argus-agent/config
 */
import z from '@deepseek-ai/schemastery'
import type { ConfigIssue, OpsConfig, OpsConfigRegistry } from '@argus-agent/types'

/**
 * Any schemastery schema.
 *
 * The package's default export is a `const` of the callable `Schemastery.Static`
 * type, so the general schema form is `ReturnType<typeof z.object>` widened to
 * the package's own callable shape. Aliasing it keeps public signatures
 * readable without depending on the package's internal type aliases.
 */
type Schema = z


// The configuration contract lives in `@argus-agent/types`, so every plugin can
// name it without depending on the bundle. Re-exported here for convenience.
export type { ConfigIssue, LoadedOpsConfig, OpsConfig } from '@argus-agent/types'

/**
 * The schema of the keys the bundle itself owns.
 *
 * Plugin sections are merged in by {@link ConfigRegistry}; this schema is the
 * seed every deployment must satisfy regardless of which plugins are mounted.
 */
export const rootSchema = z.object({
  timezone: z
    .string()
    .required()
    .description('IANA timezone name, e.g. Europe/Bucharest'),
  data_dir: z.string().default('/data').description('Root of the persistent data tree'),
  config_dir: z.string().default('config').description('Directory holding ops.yaml and projects/*.yaml'),
  dsh_home: z.string().default('dsh-home').description('dsh harness home, relative to data_dir unless absolute'),
})

/** Thrown when `ops.yaml` is missing, unparseable, or invalid. */
export class OpsConfigError extends Error {
  readonly code = 'OPS_CONFIG_INVALID'
  readonly issues: readonly ConfigIssue[]

  constructor(message: string, issues: readonly ConfigIssue[] = []) {
    const detail = issues.length
      ? `\n${issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n')}`
      : ''
    super(`${message}${detail}`)
    this.name = 'OpsConfigError'
    this.issues = issues
  }
}

/**
 * Accumulates the config schema contributed by each plugin.
 *
 * Plugins call {@link extend} during their `apply`, so the assembled schema is
 * a function of what is actually mounted. The bundle validates once after all
 * rows have activated.
 */
export class ConfigRegistry implements OpsConfigRegistry {
  private readonly sections = new Map<string, Schema>()
  private readonly listeners = new Set<() => void>()

  /**
   * Be told whenever a section is contributed.
   * @param listener called after each successful {@link extend}.
   * @returns a disposer that stops the notifications.
   */
  onExtend(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Contribute one top-level section schema.
   * @param name the section key in `ops.yaml`.
   * @param schema the section's schema.
   * @returns a disposer that removes the section again on unload.
   * @throws when another plugin already registered that section name.
   */
  extend(name: string, schema: Schema): () => void {
    if (this.sections.has(name)) {
      throw new OpsConfigError(`duplicate ops.yaml section "${name}"`, [
        { path: name, message: 'already contributed by another plugin' },
      ])
    }
    this.sections.set(name, schema)
    for (const listener of this.listeners) listener()
    return () => {
      this.sections.delete(name)
    }
  }

  /** The section names currently contributed, sorted. */
  get names(): readonly string[] {
    return [...this.sections.keys()].sort()
  }

  /**
   * Build the complete schema: the bundle's own keys plus every contributed
   * section.
   *
   * Schemastery strips unknown keys rather than rejecting them, so
   * {@link validate} does its own unknown-key check against
   * {@link names} — a typo in `ops.yaml` must fail at boot, not silently
   * disable a feature.
   * @returns the assembled schema.
   */
  schema(): Schema {
    const shape: Record<string, Schema> = { ...((rootSchema as unknown as { dict: Record<string, Schema> }).dict) }
    for (const [name, schema] of this.sections) shape[name] = schema
    return z.object(shape) as unknown as Schema
  }

  /**
   * Validate a raw parsed document.
   * @param raw the parsed YAML value.
   * @returns the validated configuration.
   * @throws {OpsConfigError} naming every invalid or unknown key.
   */
  validate(raw: unknown): OpsConfig & Record<string, unknown> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new OpsConfigError('ops.yaml must contain a mapping at the top level', [
        { path: '(root)', message: `found ${Array.isArray(raw) ? 'a list' : typeof raw}` },
      ])
    }
    // Report unknown top-level keys before schema validation, so a typo is
    // named even when the rest of the file is valid.
    const known = new Set(['timezone', 'data_dir', 'config_dir', 'dsh_home', ...this.sections.keys()])
    const issues: ConfigIssue[] = Object.keys(raw as Record<string, unknown>)
      .filter((key) => !known.has(key))
      .map((key) => ({
        path: key,
        message: `unknown key; known keys are: ${[...known].sort().join(', ')}`,
      }))
    if (issues.length > 0) throw new OpsConfigError('ops.yaml has unknown keys', issues)
    try {
      // Schemastery's call signature types the input loosely; the schema is the
      // validator, so the cast is at the boundary rather than in callers.
      return (this.schema() as unknown as (value: unknown) => OpsConfig & Record<string, unknown>)(raw)
    } catch (error) {
      throw new OpsConfigError('ops.yaml failed validation', [
        { path: '(root)', message: (error as Error).message },
      ])
    }
  }
}

/** The process-wide registry. One per Cordis root, created by the bundle. */
export const configRegistry = new ConfigRegistry()
