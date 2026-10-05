// == ARGUS AGENT PROJECT ==
/**
 * Fixtures.
 *
 * Helpers that write the files a governed deployment reads — `ops.yaml` and
 * `config/projects/*.yaml` — into a temporary directory, so a test can set up a
 * configuration without hand-writing YAML in every case.
 *
 * @module @argus-agent/testkit/fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'

/** The keys a test commonly overrides in `ops.yaml`. */
export interface OpsYamlFixture {
  readonly timezone?: string
  readonly data_dir?: string
  /** Any additional top-level sections, written verbatim. */
  readonly [section: string]: unknown
}

/**
 * Write an `ops.yaml` into a directory.
 *
 * @param dataDir the deployment's data directory; the file goes to
 *   `<dataDir>/config/ops.yaml`.
 * @param fixture the configuration; `timezone` defaults to `UTC` and `data_dir`
 *   to the given directory.
 * @returns the absolute path of the file written.
 */
export function writeOpsYaml(dataDir: string, fixture: OpsYamlFixture = {}): string {
  const configDir = join(dataDir, 'config')
  mkdirSync(configDir, { recursive: true })
  const document = {
    timezone: 'UTC',
    data_dir: dataDir,
    ...fixture,
  }
  const path = join(configDir, 'ops.yaml')
  writeFileSync(path, stringifyYaml(document))
  return path
}

/** The project configuration a test commonly overrides. */
export interface ProjectYamlFixture {
  readonly id: string
  readonly cwd?: string
  readonly provider?: string
  readonly model?: string
  readonly fallback_model?: string
  readonly preset?: string
  readonly description?: string
  readonly limits?: Record<string, number>
  readonly budget?: Record<string, number | string>
  readonly approvals?: Record<string, unknown>
  readonly memory?: Record<string, unknown>
  readonly progress?: boolean
}

/**
 * Write one project configuration file.
 *
 * @param dataDir the deployment's data directory.
 * @param fixture the project; `cwd` defaults to `<dataDir>/projects/<id>`.
 * @returns the absolute path of the file written.
 */
export function writeProjectYaml(dataDir: string, fixture: ProjectYamlFixture): string {
  const projectsDir = join(dataDir, 'config', 'projects')
  mkdirSync(projectsDir, { recursive: true })
  const document = {
    cwd: join(dataDir, 'projects', fixture.id),
    provider: 'fake',
    model: 'fake-model',
    ...fixture,
  }
  const path = join(projectsDir, `${fixture.id}.yaml`)
  writeFileSync(path, stringifyYaml(document))
  return path
}

/**
 * Write several project configuration files at once.
 * @param dataDir the deployment's data directory.
 * @param fixtures the projects.
 * @returns the absolute paths written, in order.
 */
export function writeProjectYamls(dataDir: string, fixtures: readonly ProjectYamlFixture[]): string[] {
  return fixtures.map((fixture) => writeProjectYaml(dataDir, fixture))
}

/**
 * Write an arbitrary file, creating parent directories.
 * @param root the directory the path is relative to.
 * @param relativePath the path to write, relative to `root`.
 * @param content the file contents.
 * @returns the absolute path written.
 */
export function writeFile(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/**
 * Build the standard directory layout a deployment expects under `data_dir`.
 *
 * @param dataDir the data directory.
 * @returns the absolute path of each directory created.
 */
export function writeDataLayout(dataDir: string): Record<string, string> {
  const dirs = {
    config: join(dataDir, 'config'),
    projects: join(dataDir, 'projects'),
    state: join(dataDir, 'state'),
    scratch: join(dataDir, 'scratch'),
    memory: join(dataDir, 'memory'),
    backups: join(dataDir, 'backups'),
    dshHome: join(dataDir, 'dsh-home'),
  }
  for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true })
  return dirs
}
