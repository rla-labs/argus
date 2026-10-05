// == ARGUS AGENT PROJECT ==
/**
 * A harness for `ops-projects` integration tests.
 *
 * Boots a real dsh tree with the bundle's config rows, the store and this
 * plugin, over a temporary data directory.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import {
  bootOps,
  renderEntries,
  BASE_ENTRIES,
  persistenceEntry,
  type BootOpsOptions,
  type OpsBoot,
} from '@argus-agent/testkit'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '../src/service.js'

/** The bundle's two configuration rows. */
export const REGISTRY_ENTRY = { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' }
export const LOADER_ENTRY = { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' }
export const STORE_ENTRY = { id: 'ops-store', name: '@argus-agent/store' }
export const PROJECTS_ENTRY = { id: 'ops-projects', name: '@argus-agent/projects' }

/** A booted tree with the store and the projects service. */
export interface ProjectsBoot {
  readonly boot: OpsBoot
  readonly ctx: OpsBoot['ctx']
  readonly store: OpsStore
  readonly projects: OpsProjects
  /** The temporary data directory. */
  readonly dataDir: string
  dispose(): Promise<void>
}

const open: ProjectsBoot[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const entry of open.splice(0)) await entry.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Options for {@link bootProjects}. */
export interface BootProjectsOptions {
  /** Project files to write, keyed by id. */
  readonly projects?: Readonly<Record<string, Record<string, unknown> | string>>
  /** Extra entries to mount. */
  readonly entries?: readonly { id: string; name: string; config?: unknown }[]
  /** Reuse a data directory, for restart tests. */
  readonly dataDir?: string
  /** A scripted fake adapter, or `false` to mount none. */
  readonly fake?: BootOpsOptions['fake']
  /** A `storage` section override. */
  readonly storage?: Record<string, unknown>
}

/**
 * Boot a tree with the projects plugin.
 * @param options what to mount and which projects to configure.
 * @returns the booted handles.
 */
export async function bootProjects(options: BootProjectsOptions = {}): Promise<ProjectsBoot> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ops-projects-'))
  if (options.dataDir === undefined) dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })

  // A `storage` override needs the section registered, which the store row does.
  const opsYaml = [
    'timezone: UTC',
    `data_dir: ${JSON.stringify(dataDir)}`,
    options.storage === undefined ? '' : `storage:\n${renderYaml(options.storage, 1)}`,
  ]
    .filter((line) => line !== '')
    .join('\n')

  for (const [id, project] of Object.entries(options.projects ?? {})) {
    const text = typeof project === 'string' ? project : projectDocument(dataDir, id, project)
    writeFileSync(join(dataDir, 'config', 'projects', `${id}.yaml`), `${text}\n`)
  }

  let boot: OpsBoot
  try {
    boot = await bootOps({
      files: { 'config/ops.yaml': `${opsYaml}\n` },
      entries: [...(options.entries ?? [])],
      bareModuleBaseUrl: import.meta.url,
      ...(options.fake !== undefined ? { fake: options.fake } : {}),
      replaceEntries: [
        ...BASE_ENTRIES,
        persistenceEntry(join(dataDir, 'sessions')),
        // `ops-projects` requires the preset registry, because a project's preset
        // decides its tool set.
        { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'default' } },
        REGISTRY_ENTRY,
        STORE_ENTRY,
        PROJECTS_ENTRY,
        LOADER_ENTRY,
      ],
    })
  } catch (error) {
    // A boot that rejects may have left a partially-activated tree whose
    // `configRegistry` contributions are still registered. A test that EXPECTS a
    // boot failure would otherwise poison every later boot in the process with a
    // duplicate-section error — a failure in an unrelated test, which is the
    // worst kind of test pollution.
    rmSync(dataDir, { recursive: true, force: true })
    throw error
  }

  const entry: ProjectsBoot = {
    boot,
    ctx: boot.ctx,
    store: (boot.ctx as unknown as { opsStore: OpsStore }).opsStore,
    projects: (boot.ctx as unknown as { opsProjects: OpsProjects }).opsProjects,
    dataDir,
    dispose: async () => {
      await boot.dispose()
    },
  }
  open.push(entry)
  return entry
}

/**
 * Build a project document.
 *
 * The caller's keys are merged over the defaults, so an override such as
 * `model` replaces the default rather than producing a duplicate key — which
 * YAML rejects outright.
 */
function projectDocument(dataDir: string, id: string, project: Record<string, unknown>): string {
  const fields: Record<string, unknown> = {
    id,
    cwd: join(dataDir, 'projects', id),
    provider: 'fake',
    model: 'fake-model',
    ...project,
  }
  return Object.entries(fields)
    .map(([key, value]) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? `${key}:\n${renderYaml(value, 1)}`
        : `${key}: ${JSON.stringify(value)}`,
    )
    .join('\n')
}

/** Render a nested object as indented YAML. */
function renderYaml(value: unknown, depth: number): string {
  const pad = '  '.repeat(depth)
  if (value === null || typeof value !== 'object') return `${pad}${JSON.stringify(value)}`
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? `${pad}${key}:\n${renderYaml(item, depth + 1)}`
        : `${pad}${key}: ${JSON.stringify(item)}`,
    )
    .join('\n')
}

/** Write a project file into a booted deployment. */
export function writeProject(
  dataDir: string,
  id: string,
  project: Record<string, unknown> = {},
): string {
  const path = join(dataDir, 'config', 'projects', `${id}.yaml`)
  writeFileSync(path, `${projectDocument(dataDir, id, project)}\n`)
  return path
}

/** The raw entry list a boot mounts, for a test that needs to inspect it. */
export { renderEntries }
