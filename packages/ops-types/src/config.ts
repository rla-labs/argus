// == ARGUS AGENT PROJECT ==
/**
 * The shared configuration service contract.
 *
 * The bundle (`@argus-agent/argus-agent`) owns the *implementation* — reading and
 * validating `ops.yaml` — but the *contract* lives here, because every plugin
 * both reads the configuration and contributes a section schema to it. Putting
 * the types in `ops-types` keeps the dependency direction one-way: the bundle
 * depends on the plugins, and every plugin depends only on `ops-types`.
 *
 * @module @argus-agent/types/config
 */
// The module must be imported for its interface to be augmentable; a bare
// `declare module` in a file that never references it is not enough.
import type { Context } from '@deepseek-ai/cordis'

/** Re-exported so a consumer can name the context type. */
export type { Context }

/** The root configuration of an Argus Agent deployment. */
export interface OpsConfig {
  /** IANA timezone name. Day/month budget boundaries and display use it. */
  timezone: string
  /** Root of the persistent data tree. Defaults to `/data`. */
  data_dir: string
  /** Directory holding `ops.yaml` and `projects/*.yaml`, relative to `data_dir` unless absolute. */
  config_dir: string
  /** Where the dsh harness home lives, so sessions persist across restarts. */
  dsh_home: string
}

/**
 * A validated configuration plus every path derived from it.
 *
 * A plugin reads absolute paths from here rather than re-deriving them, so one
 * place decides where the database, the workspaces and the state directory are.
 */
export interface LoadedOpsConfig extends OpsConfig {
  /** Absolute path of the file the configuration was read from. */
  readonly configPath: string
  /** Absolute data directory. */
  readonly dataDirAbs: string
  /** Absolute directory holding `projects/*.yaml`. */
  readonly projectsDir: string
  /** Absolute dsh harness home. */
  readonly dshHomeAbs: string
  /** Absolute SQLite path. */
  readonly databasePath: string
  /** Absolute scratch directory for ad-hoc task workspaces. */
  readonly scratchDir: string
  /** Absolute directory of per-project state, outside the workspaces. */
  readonly stateDir: string
  /** Absolute directory of SQLite backups. */
  readonly backupsDir: string
  /** The raw validated document, including every plugin section. */
  readonly raw: OpsConfig & Record<string, unknown>
}

/** Every configuration problem found while validating, with a JSON path. */
export interface ConfigIssue {
  /** Dotted path of the offending key, e.g. `concurrency.global_max_running`. */
  path: string
  /** Human-readable explanation. */
  message: string
}

/**
 * A plugin's configuration section schema.
 *
 * Typed as `unknown` because `ops-types` does not depend on the schema library:
 * the bundle narrows it at the call site. A plugin passes its own schemastery
 * object, which satisfies this structurally.
 */
export type ConfigSectionSchema = unknown

/**
 * The registry plugins contribute their configuration schemas to.
 *
 * Implemented by the bundle; consumed by every plugin that owns a section.
 */
export interface OpsConfigRegistry {
  /**
   * Contribute one top-level section schema.
   * @param name the section key in `ops.yaml`.
   * @param schema the section's schema.
   * @returns a disposer that removes the section again on unload.
   * @throws when another plugin already registered that section name.
   */
  extend(name: string, schema: ConfigSectionSchema): () => void
  /** The section names currently contributed, sorted. */
  readonly names: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The **raw** parsed `ops.yaml`, published before validation.
     *
     * A plugin that owns a self-contained section reads it from here and
     * validates only that slice. Reading {@link opsConfig} instead triggers the
     * bundle's full validation, including the unknown-key check — which fails
     * for a valid key whose owning plugin has not registered its section yet.
     */
    opsRawConfig: Record<string, unknown>
    /** The validated Argus Agent configuration, present once the bundle has loaded. */
    opsConfig: LoadedOpsConfig
    /** The section registry plugins contribute their schemas to. */
    opsConfigRegistry: OpsConfigRegistry
  }
}
