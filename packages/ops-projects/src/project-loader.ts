// == ARGUS AGENT PROJECT ==
/**
 * Loading `<config_dir>/projects/*.yaml` and syncing it into the store.
 *
 * The directory is the source of truth for configuration. Syncing is
 * idempotent and **never destructive**: a project removed from the directory
 * becomes `archived`, so its usage history and audit trail keep their subject.
 *
 * @module @argus-agent/projects/project-loader
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { OpsStore } from '@argus-agent/store'
import type { BudgetDefaults, ProjectConfig } from './project-config.js'
import { ProjectConfigError, parseProjectYaml } from './project-config.js'

/** What one sync did. */
export interface SyncReport {
  /** Projects created or updated from a file. */
  readonly synced: readonly string[]
  /** Projects present in the store but absent from the directory. */
  readonly archived: readonly string[]
  /** Projects that were `archived` and are back in the directory. */
  readonly restored: readonly string[]
  /** Files that failed to load, with their errors. */
  readonly errors: readonly { readonly path: string; readonly error: Error }[]
}

/**
 * A project file that exists but does not validate.
 *
 * The project is IGNORED, not archived: its history, budget and session stay as
 * they were, and it comes back as soon as a load validates the file again.
 */
export interface InvalidProject {
  /** The id the file name promises (`<id>.yaml`). */
  readonly id: string
  /** The file. */
  readonly path: string
  /** What is wrong, one issue per line, ready to show an operator. */
  readonly reason: string
}

/**
 * The invalid projects in a load result, one per file.
 *
 * @param errors the load's errors.
 * @returns the invalid projects, sorted by id.
 */
export function invalidProjectsOf(errors: LoadResult['errors']): InvalidProject[] {
  return errors
    .map(({ path, error }) => {
      const id = (path.split('/').pop() ?? path).replace(/\.ya?ml$/, '')
      const issues = (error as Partial<ProjectConfigError>).issues
      const reason =
        issues !== undefined && issues.length > 0
          ? issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')
          : error.message
      return { id, path, reason }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Options for {@link loadProjectConfigs}. */
export interface LoadOptions {
  /** The absolute `<config_dir>/projects` directory. */
  readonly projectsDir: string
  /** The absolute `<data_dir>/projects` directory the `cwd`s must live in. */
  readonly projectsRoot: string
  /** A project's budget when its file sets none: ops.yaml `budgets.default_*_usd`. */
  readonly budgetDefaults?: BudgetDefaults
  /**
   * Whether a malformed file is fatal.
   *
   * Defaults to `true`: a project whose configuration is wrong must not be
   * silently skipped, because the operator would then be talking to a project
   * that does not exist. `false` is for a caller that wants a partial load plus
   * the error list.
   */
  readonly strict?: boolean
}

/** The result of loading a directory. */
export interface LoadResult {
  readonly configs: readonly ProjectConfig[]
  readonly errors: readonly { readonly path: string; readonly error: Error }[]
}

/**
 * Read and validate every project file in a directory.
 *
 * A missing directory is not an error: a fresh deployment has no projects yet.
 *
 * @param options the directory and the projects root.
 * @returns the valid configurations and any errors.
 * @throws {ProjectConfigError} when `strict` and a file is invalid.
 */
export function loadProjectConfigs(options: LoadOptions): LoadResult {
  const { projectsDir, projectsRoot } = options
  let names: string[]
  try {
    names = readdirSync(projectsDir)
      .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { configs: [], errors: [] }
    throw new ProjectConfigError(`cannot read the projects directory ${projectsDir}`, [
      { path: projectsDir, message: (error as Error).message },
    ])
  }

  const configs: ProjectConfig[] = []
  const errors: { path: string; error: Error }[] = []

  for (const name of names) {
    const path = join(projectsDir, name)
    // A directory named `*.yaml` is not a project file; skip it rather than
    // failing the whole load on a stray directory.
    if (!statSync(path).isFile()) continue

    const expectedId = name.replace(/\.ya?ml$/, '')
    try {
      const text = readFileSync(path, 'utf8')
      configs.push(parseProjectYaml(text, { sourcePath: path, projectsRoot, expectedId, ...(options.budgetDefaults === undefined ? {} : { budgetDefaults: options.budgetDefaults }) }))
    } catch (error) {
      errors.push({ path, error: error as Error })
    }
  }

  if (errors.length > 0 && options.strict !== false) {
    const first = errors[0]!
    throw first.error
  }

  // Two files cannot declare one id: the `expectedId` check already enforces
  // file-name equality, but a `.yaml`/`.yml` pair would slip past it.
  const seen = new Map<string, string>()
  for (const config of configs) {
    const previous = seen.get(config.id)
    if (previous !== undefined) {
      const error = new ProjectConfigError(`two project files declare id ${JSON.stringify(config.id)}`, [
        { path: config.id, message: `${previous} and ${config.sourcePath}` },
      ])
      if (options.strict !== false) throw error
      errors.push({ path: config.sourcePath, error })
    }
    seen.set(config.id, config.sourcePath)
  }

  return { configs, errors }
}

/**
 * Sync the loaded configurations into the store.
 *
 * @param store the store.
 * @param configs the validated configurations.
 * @param now the current time, epoch ms.
 * @param keep ids whose file exists but is invalid: they are absent from
 *   `configs`, and must NOT be archived for it — a typo is not a deletion.
 * @returns what changed.
 */
export function syncProjects(
  store: OpsStore,
  configs: readonly ProjectConfig[],
  now: number,
  keep: ReadonlySet<string> = new Set(),
): SyncReport {
  const synced: string[] = []
  const archived: string[] = []
  const restored: string[] = []

  const run = store.transaction(() => {
    for (const config of configs) {
      const existing = store.projects.get(config.id)
      store.projects.upsert(
        {
          id: config.id,
          cwd: config.cwd,
          provider: config.provider,
          model: config.model,
          fallback_model: config.fallback_model,
          preset: config.preset,
          description: config.description,
        },
        now,
      )
      synced.push(config.id)
      // A project that comes back is un-archived; a paused one stays paused,
      // because pausing is a decision about budget, not about configuration.
      if (existing?.status === 'archived') {
        store.projects.setStatus(config.id, 'active', now)
        restored.push(config.id)
      }
    }

    const configured = new Set(configs.map((config) => config.id))
    for (const row of store.projects.list()) {
      if (configured.has(row.id) || keep.has(row.id) || row.status === 'archived') continue
      store.projects.setStatus(row.id, 'archived', now)
      archived.push(row.id)
    }
  })
  run()

  return { synced, archived, restored, errors: [] }
}

/**
 * Ensure a project's working directory exists.
 *
 * @param cwd the absolute directory.
 * @returns whether it was created.
 */
export function ensureProjectDirectory(cwd: string): boolean {
  const existed = statSync(cwd, { throwIfNoEntry: false })?.isDirectory() ?? false
  mkdirSync(cwd, { recursive: true })
  return !existed
}
