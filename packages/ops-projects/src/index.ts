// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/projects` — the agent lifecycle plugin.
 *
 * Owns every dsh agent in the system: project agents, ad-hoc task agents and the
 * orchestrator. Publishes `ctx.opsProjects` and emits the lifecycle events the
 * governor and the channel consume.
 *
 * @module @argus-agent/projects
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseModelRef, type ModelRef, type Owner } from '@argus-agent/types'
// Type-only: brings in the `ops/config-loaded` event declaration.
import type {} from '@argus-agent/argus-agent'
import { OpsProjects } from './service.js'
import { pathsOf } from '@argus-agent/argus-agent'
import { invalidProjectsOf, loadProjectConfigs, syncProjects, type InvalidProject, type SyncReport } from './project-loader.js'
import type { ProjectConfig } from './project-config.js'
import './events.js'

export * from './project-config.js'
export * from './project-loader.js'
export * from './ownership.js'
export * from './capability.js'
export * from './service.js'

/** Stable Cordis plugin name. */
export const name = 'ops-projects'

/**
 * The services this plugin requires.
 *
 * `opsConfig` is read lazily by the bundle's loader, so declaring it here is
 * safe: this plugin registers no config section of its own — project
 * configuration lives in `projects/*.yaml`, not in `ops.yaml`.
 *
 * `agents`, `sessions` and `agentPresets` are what it drives: it creates and
 * resumes agents, reads session headers for the ownership walk, and mounts each
 * project's preset. Cordis requires every one of them to be declared before the
 * context hands it over.
 */
export const inject = ['opsRawConfig', 'opsStore', 'agents', 'sessions', 'agentPresets']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Argus Agent agent lifecycle service. */
    opsProjects: OpsProjects
  }
}

/**
 * Mount the projects plugin.
 *
 * @param ctx the plugin's context.
 */
export function apply(ctx: Context): void {
  // Paths come from the raw document: reading `ctx.opsConfig` would trigger the
  // bundle's cross-section validation, and this row activates before the plugins
  // that own later sections have registered theirs.
  const paths = pathsOf(ctx.opsRawConfig)
  const projectsRoot = join(paths.dataDirAbs, 'projects')

  const service = new OpsProjects(ctx, ctx.opsStore, {
    scratchDir: paths.scratchDir,
    projectsRoot,
  })

  // Load and sync synchronously. Tolerant: an invalid file marks THAT project
  // invalid and ignored; every other project, and the whole system, keeps running.
  loadAndSync(ctx, service)
  service.setReloader(() => void loadAndSync(ctx, service))

  ctx.provide('opsProjects', service)
  // The providers row's check (a route, an API key, a known model), when it is up.
  ctx.inject(['opsProviders'], (child) => {
    child.effect(() => service.addModelCheck((ref) => child.opsProviders.check(ref)))
  })
  ctx.effect(() => () => {
    void service.disposeAll()
  })

  // ── session events: run-output extraction ────────────────────────────────
  ctx.on('session/event', (session, event) => {
    service.observe(session.id as string, event)
  })

  // ── agent lifecycle: slots, run boundaries, subagent links ───────────────
  ctx.on('agent/created', ({ agent }) => {
    const parent = agent.session.header.parentSession
    if (parent !== undefined) {
      // An in-process subagent: link it so `ownerOf` resolves without reading a
      // header, and so its usage is attributed to the parent's run.
      service.linkSubagent(agent.id as string, parent as string)
    }
    // `agent/created` is a serial event; its listener must return undefined or a
    // promise, never a bare void from a branch.
    return undefined
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = agent.id as string
    const owner = service.ownerOf(sessionId)
    if (owner === undefined) return

    if (status === 'running') {
      ctx.emit('ops/agent-running', { owner, sessionId })
      return
    }

    // Idle: close the run first, so a listener that reads the run sees it
    // finished, then announce the slot release.
    const runId = service.runOf(sessionId)
    service.finishRun(sessionId)
    ctx.emit('ops/agent-idle', { owner, sessionId, runId })
  })

  ctx.on('ops/config-loaded', () => {
    reload(ctx, service)
  })
}

/**
 * Reload project configuration.
 *
 * Exported so a command (`/new`) can trigger it after writing a file.
 *
 * @param ctx the plugin's context.
 * @param service the service to update; defaults to `ctx.opsProjects`.
 * @returns what changed.
 */
export function reload(ctx: Context, service: OpsProjects = ctx.opsProjects): ReloadReport {
  return loadAndSync(ctx, service)
}

/** What a load did, including the files it had to ignore. */
export interface ReloadReport extends SyncReport {
  /** Project files that do not validate, now ignored until fixed. */
  readonly invalid: readonly InvalidProject[]
  /** Projects that were invalid and validate again. */
  readonly fixed: readonly string[]
}

/**
 * Load every project file and sync the store, tolerating invalid files.
 *
 * An invalid file is logged, recorded on the service, and kept out of the
 * archive pass — a typo is not a deletion. When the set of invalid projects
 * changes, `ops/projects-invalid` tells the channel.
 *
 * @param ctx the plugin's context.
 * @param service the service to update.
 * @returns what changed.
 */
function loadAndSync(ctx: Context, service: OpsProjects): ReloadReport {
  const paths = pathsOf(ctx.opsRawConfig)
  const projectsRoot = join(paths.dataDirAbs, 'projects')
  const files = loadProjectConfigs({ projectsDir: paths.projectsDir, projectsRoot, strict: false })
  // A file that validates can still name a model that cannot run: no key, no price.
  const failing = files.configs.flatMap((config) => {
    const models: Array<[string, ModelRef | undefined]> = [
      ['model', { provider: config.provider, model: config.model }],
      ['fallback_model', config.fallback_model === null ? undefined : parseModelRef(config.fallback_model)],
    ]
    const problems = models.flatMap(([key, ref]) => {
      const problem = ref === undefined ? undefined : service.checkModel(ref)
      return problem === undefined ? [] : [`${key}: ${problem.message}`]
    })
    return problems.length === 0 ? [] : [{ id: config.id, path: config.sourcePath, reason: problems.join('\n') }]
  })
  const loaded = { configs: files.configs.filter((config) => !failing.some((f) => f.id === config.id)) }
  const invalid = [...invalidProjectsOf(files.errors), ...failing].sort((a, b) => a.id.localeCompare(b.id))
  const before = service.invalidProjects()

  service.setConfigs(loaded.configs)
  service.setInvalid(invalid)
  const report = syncProjects(ctx.opsStore, loaded.configs, Date.now(), new Set(invalid.map((p) => p.id)))

  const logger = ctx.logger('ops-projects')
  logger.info(
    'loaded %d project(s): %d synced, %d archived, %d restored, %d invalid',
    loaded.configs.length,
    report.synced.length,
    report.archived.length,
    report.restored.length,
    invalid.length,
  )
  for (const project of invalid) {
    logger.warn('project %s is ignored: %s does not validate\n%s', project.id, project.path, project.reason)
  }

  const configured = new Set(loaded.configs.map((config) => config.id))
  const fixed = before.filter((p) => configured.has(p.id)).map((p) => p.id)
  const changed =
    fixed.length > 0 ||
    invalid.length !== before.length ||
    invalid.some((p) => before.find((b) => b.id === p.id)?.reason !== p.reason)
  if (changed) ctx.emit('ops/projects-invalid', { invalid, fixed })

  return { ...report, invalid, fixed }
}

/** The owner type, re-exported for convenience. */
export type { InvalidProject, Owner, ProjectConfig }
