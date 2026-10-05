// == ARGUS AGENT PROJECT ==
/**
 * Loading `ops.yaml` from disk.
 *
 * Responsibilities: resolve the config path (env override, then the data
 * directory), read and parse the YAML, interpolate `${ENV_VAR}` references,
 * validate against the assembled schema, and resolve the paths a deployment
 * derives from `data_dir`.
 *
 * @module @argus-agent/argus-agent/loader
 */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { OpsConfigError, type ConfigRegistry } from './config.js'
import type { LoadedOpsConfig } from '@argus-agent/types'

/** Environment variable naming an alternative config file. */
export const CONFIG_PATH_ENV = 'ARGUS_AGENT_CONFIG'

// The validated-configuration shape is the shared contract from
// `@argus-agent/types`, so every plugin names the same type.
export type { LoadedOpsConfig }

/** Pattern matching a `${NAME}` environment reference. */
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Interpolate `${NAME}` references from the environment.
 *
 * An unresolvable reference is an error, not an empty string: silently
 * substituting `''` for a missing `TELEGRAM_BOT_TOKEN` would boot a bot that
 * cannot authenticate and report the failure far from its cause.
 *
 * @param text the raw file contents.
 * @param env environment to read; defaults to `process.env`.
 * @param source file path for error messages.
 * @returns the interpolated text.
 * @throws {OpsConfigError} naming every missing variable.
 */
export function interpolateEnv(
  text: string,
  env: Record<string, string | undefined> = process.env,
  source = 'ops.yaml',
): string {
  const missing = new Set<string>()
  const result = text.replace(ENV_REFERENCE, (match, name: string) => {
    const value = env[name]
    if (value === undefined) {
      missing.add(name)
      return match
    }
    return value
  })
  if (missing.size > 0) {
    throw new OpsConfigError(
      `unresolved environment references in ${source}`,
      [...missing].sort().map((name) => ({
        path: `\${${name}}`,
        message: 'environment variable is not set',
      })),
    )
  }
  return result
}

/**
 * Resolve a configuration path that may be relative to the data directory.
 * @param value the configured value.
 * @param dataDir absolute data directory.
 * @returns the absolute path.
 */
export function resolveUnderDataDir(value: string, dataDir: string): string {
  return isAbsolute(value) ? value : resolve(dataDir, value)
}

/**
 * Locate the configuration file.
 *
 * Precedence: `${ARGUS_AGENT_CONFIG}` if set, otherwise `<data_dir>/config/ops.yaml`
 * where `data_dir` comes from the environment (`ARGUS_AGENT_DATA_DIR`) or `/data`.
 * The pre-rename names `DSH_OPS_CONFIG` / `DSH_OPS_DATA_DIR` are still read as a
 * fallback, so a deployment installed as Argus Agent keeps booting after an upgrade.
 *
 * @param env environment to read.
 * @returns the absolute candidate path, which may not exist.
 */
export function resolveConfigPath(env: Record<string, string | undefined> = process.env): string {
  // ponytail: DSH_OPS_* fallback for deployments from before the rename; drop it once none remain.
  const explicit = env[CONFIG_PATH_ENV] || env['DSH_OPS_CONFIG']
  if (explicit) return resolve(explicit)
  const dataDir = env['ARGUS_AGENT_DATA_DIR'] ?? env['DSH_OPS_DATA_DIR'] ?? '/data'
  return join(resolve(dataDir), 'config', 'ops.yaml')
}

/**
 * Read, interpolate and parse `ops.yaml` **without** validating it.
 *
 * Published as `ctx.opsRawConfig` so a plugin can validate its own section
 * without triggering the cross-section unknown-key check. That matters for
 * ordering: the first plugin to read `ctx.opsConfig` triggers full validation,
 * and if it reads before a later plugin has registered its section, a perfectly
 * valid key is reported as unknown.
 *
 * @param path the file to read.
 * @param env environment to interpolate from.
 * @returns the parsed document.
 * @throws {OpsConfigError} when the file is missing or malformed.
 */
export function parseRawConfig(
  path?: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const configPath = path !== undefined ? resolve(path) : resolveConfigPath(env)
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (error) {
    throw new OpsConfigError(
      `cannot read ops.yaml at ${configPath}: ${(error as Error).message}\n` +
        `Create it, or point ${CONFIG_PATH_ENV} at an existing file.`,
    )
  }
  const interpolated = interpolateEnv(text, env, configPath)
  let parsed: unknown
  try {
    parsed = parseYaml(interpolated)
  } catch (error) {
    throw new OpsConfigError(`ops.yaml at ${configPath} is not valid YAML`, [
      { path: '(root)', message: (error as Error).message },
    ])
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OpsConfigError('ops.yaml must contain a mapping at the top level', [
      { path: '(root)', message: `found ${Array.isArray(parsed) ? 'a list' : typeof parsed}` },
    ])
  }
  return parsed as Record<string, unknown>
}

/**
 * Derive every path a deployment uses, from the raw document.
 *
 * A plugin reads these instead of `ctx.opsConfig` when it needs only paths,
 * because reading the validated view triggers the cross-section check — which
 * fails for a key whose owning plugin has not registered yet.
 *
 * @param raw the raw parsed document.
 * @returns the absolute paths, with the loader's defaults applied.
 */
export function pathsOf(raw: Record<string, unknown>): {
  timezone: string
  dataDirAbs: string
  configDirAbs: string
  projectsDir: string
  dshHomeAbs: string
  databasePath: string
  scratchDir: string
  stateDir: string
  backupsDir: string
} {
  const dataDirAbs = resolve(typeof raw['data_dir'] === 'string' ? raw['data_dir'] : '/data')
  const configDirAbs = resolveUnderDataDir(
    typeof raw['config_dir'] === 'string' ? raw['config_dir'] : 'config',
    dataDirAbs,
  )
  return {
    timezone: typeof raw['timezone'] === 'string' ? raw['timezone'] : 'UTC',
    dataDirAbs,
    configDirAbs,
    projectsDir: join(configDirAbs, 'projects'),
    dshHomeAbs: resolveUnderDataDir(
      typeof raw['dsh_home'] === 'string' ? raw['dsh_home'] : 'dsh-home',
      dataDirAbs,
    ),
    databasePath: join(dataDirAbs, 'ops.sqlite'),
    scratchDir: join(dataDirAbs, 'scratch'),
    stateDir: join(dataDirAbs, 'state'),
    backupsDir: join(dataDirAbs, 'backups'),
  }
}

/**
 * Read, interpolate, parse and validate `ops.yaml`.
 *
 * @param registry the assembled section registry.
 * @param options path and environment overrides.
 * @returns the validated configuration with derived absolute paths.
 * @throws {OpsConfigError} when the file is missing, malformed, or invalid.
 */
export function loadOpsConfig(
  registry: ConfigRegistry,
  options: { path?: string; env?: Record<string, string | undefined> } = {},
): LoadedOpsConfig {
  const env = options.env ?? process.env
  const configPath = options.path ? resolve(options.path) : resolveConfigPath(env)
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (error) {
    throw new OpsConfigError(
      `cannot read ops.yaml at ${configPath}: ${(error as Error).message}\n` +
        `Create it, or point ${CONFIG_PATH_ENV} at an existing file.`,
    )
  }
  const interpolated = interpolateEnv(text, env, configPath)
  let parsed: unknown
  try {
    parsed = parseYaml(interpolated)
  } catch (error) {
    throw new OpsConfigError(`ops.yaml at ${configPath} is not valid YAML`, [
      { path: '(root)', message: (error as Error).message },
    ])
  }
  const raw = registry.validate(parsed)
  const dataDirAbs = resolve(raw.data_dir)
  const dshHomeAbs = resolveUnderDataDir(raw.dsh_home, dataDirAbs)
  const configDirAbs = resolveUnderDataDir(raw.config_dir, dataDirAbs)
  return {
    ...raw,
    configPath,
    dataDirAbs,
    projectsDir: join(configDirAbs, 'projects'),
    dshHomeAbs,
    databasePath: join(dataDirAbs, 'ops.sqlite'),
    scratchDir: join(dataDirAbs, 'scratch'),
    stateDir: join(dataDirAbs, 'state'),
    backupsDir: join(dataDirAbs, 'backups'),
    raw,
  }
}

/** The directory holding a configuration file, for diagnostics. */
export function configDirOf(configPath: string): string {
  return dirname(configPath)
}
