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
import { Snapshots, snapshotsOf, snapshotsSchema } from './snapshots.js'
import { oauthClientsOf, oauthClientsSchema } from './oauth.js'
import { pathsOf } from '@argus-agent/argus-agent'
import { invalidProjectsOf, loadProjectConfigs, syncProjects, type InvalidProject, type SyncReport } from './project-loader.js'
import type { BudgetDefaults, ProjectConfig, ProjectLimits } from './project-config.js'
import { loadTemplates, templateIssues } from './templates.js'
import { Extensions } from './extensions.js'
import { mailboxTools } from './mailbox.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import './events.js'

export * from './project-config.js'
export * from './project-loader.js'
export * from './ownership.js'
export * from './capability.js'
export * from './service.js'
export * from './run-trail.js'
export * from './snapshots.js'
export * from './templates.js'
export * from './extensions.js'
export * from './git-remotes.js'
export * from './mail.js'
export * from './mailbox.js'
export * from './oauth.js'
export { EgressProxy, isPublicAddress } from './egress.js'

/** Stable Cordis plugin name. */
export const name = 'ops-projects'

/** How long a one-off task's session waits for a follow-up before it closes. */
export const SESSION_IDLE_MS = 24 * 3_600_000

/**
 * The services this plugin requires.
 *
 * `opsConfigRegistry` takes its one section, `snapshots`; the projects themselves
 * live in `projects/*.yaml`, not in `ops.yaml`.
 *
 * `agents`, `sessions` and `agentPresets` are what it drives: it creates and
 * resumes agents, reads session headers for the ownership walk, and mounts each
 * project's preset. Cordis requires every one of them to be declared before the
 * context hands it over.
 */
export const inject = ['opsRawConfig', 'opsConfigRegistry', 'opsStore', 'agents', 'sessions', 'agentPresets']

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

  const section = ctx.opsConfigRegistry.extend('snapshots', snapshotsSchema)
  ctx.effect(() => section)
  const clients = ctx.opsConfigRegistry.extend('oauth_clients', oauthClientsSchema)
  ctx.effect(() => clients)
  const settings = () => snapshotsOf(ctx.opsRawConfig)
  // `install` runs in the command sandbox, or not at all.
  const extensions = new Extensions(join(paths.dataDirAbs, 'extensions'), async (argv, root) => {
    const sandbox = ctx.get('sandbox' as never) as unknown as { confine(argv: readonly string[], policy: { mode: 'workspace-write'; workspaceRoot: string }): Promise<{ argv: readonly string[] }> } | undefined
    if (sandbox === undefined) throw new Error('no ctx.sandbox')
    return (await sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: root })).argv
  })
  extensions.clearStaging()
  for (const { name, problem } of extensions.verify()) ctx.logger('ops-projects').warn('extension %s is not used: %s', name, problem)
  const service = new OpsProjects(ctx, ctx.opsStore, {
    scratchDir: paths.scratchDir,
    projectsRoot,
    stateDir: paths.stateDir,
    extensions,
    snapshots: new Snapshots(paths.stateDir, settings),
    snapshotSettings: settings,
    oauthClients: () => oauthClientsOf(ctx.opsRawConfig),
  })
  // A one-off task's session waits a day for a follow-up; then its agent and folder go.
  ctx.effect(() => {
    const sweep = () => void service.closeIdleSessions(SESSION_IDLE_MS).catch((error: Error) => ctx.logger('ops-projects').warn('closing idle sessions failed: %s', error.message))
    const timer = setInterval(sweep, 10 * 60_000)
    const first = setTimeout(sweep, 60_000)
    return () => {
      clearInterval(timer)
      clearTimeout(first)
    }
  })
  // Expiry also runs at each snapshot; daily covers a project that no longer runs.
  // ponytail: a waiting mail's question lives in this process only, so a restart expires it; re-asking needs the address kept with it.
  ctx.effect(() => {
    void service.mail.expireWaiting('Argus restarted before anyone answered').catch((error: Error) => ctx.logger('ops-projects').warn('expiring the outbox failed: %s', error.message))
    return () => undefined
  })

  ctx.effect(() => {
    const expire = () => void service.expireSnapshots().catch((error: Error) => ctx.logger('ops-projects').warn('snapshot expiry failed: %s', error.message))
    const first = setTimeout(expire, 60_000)
    const daily = setInterval(expire, 86_400_000)
    return () => {
      clearTimeout(first)
      clearInterval(daily)
    }
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
    void service.closeProxies()
  })

  // ── extensions in the project's shell ────────────────────────────────────
  // The command sandbox asks, for each confined command, what its workspace's
  // extensions add: their programs on PATH, their folders to run from, their variables.
  ctx.inject(['sandbox'], (child) => {
    const sandbox = child.get('sandbox' as never) as unknown as { setWorkspaceExtras?(extras: (root: string) => ReturnType<OpsProjects['workspaceExtras']>): () => void }
    if (sandbox.setWorkspaceExtras !== undefined) child.effect(() => sandbox.setWorkspaceExtras!((root) => service.workspaceExtras(root)))
  })

  // ── git and mail tools ─────────────────────────────────────────────────────────
  // Global, like send_file; the project comes from the calling agent (rule 6), never
  // from an argument. Argus does the remote work: the agent never holds the token.
  ctx.inject(['tools'], (child) => {
    const text = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const
    const projectOf = (exec: { agent?: { id: unknown } }): string | undefined => {
      const owner = exec.agent === undefined ? undefined : service.ownerOf(exec.agent.id as string)
      return owner?.kind === 'project' ? owner.projectId : undefined
    }
    const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)
    const remote = { type: 'string', description: 'The remote, by its name in the project (default: its only one, or origin).' } as const
    const path = { type: 'string', description: 'The repository, relative to your folder (default: your folder itself).' } as const
    const tools = [
      defineTool({
        name: 'git_clone',
        description: 'Clone one of the project\'s git remotes into your folder. Argus does it with the remote\'s token; you never see or need one.',
        parameters: {
          remote,
          branch: { type: 'string', description: 'The branch to check out (default: the remote\'s).' },
          into: { type: 'string', description: 'The folder to clone into, relative to yours (default: the repository\'s name).' },
        },
        output: text,
        execute: async (args, exec) => {
          const projectId = projectOf(exec)
          if (projectId === undefined) return 'git_clone works only in a project.'
          const input = args as Record<string, unknown>
          return service.gitClone(projectId, { ...(str(input['remote']) === undefined ? {} : { remote: str(input['remote']) }), ...(str(input['branch']) === undefined ? {} : { branch: str(input['branch']) }), ...(str(input['into']) === undefined ? {} : { into: str(input['into']) }) })
        },
      }),
      defineTool({
        name: 'git_pull',
        description: 'Fetch the remote\'s branches into your repository as refs/remotes/<remote>/*. Then merge or rebase them yourself. Your own git pull or fetch cannot reach a private remote.',
        parameters: { remote, path },
        output: text,
        execute: async (args, exec) => {
          const projectId = projectOf(exec)
          if (projectId === undefined) return 'git_pull works only in a project.'
          const input = args as Record<string, unknown>
          return service.gitPull(projectId, { ...(str(input['remote']) === undefined ? {} : { remote: str(input['remote']) }), ...(str(input['path']) === undefined ? {} : { path: str(input['path']) }) })
        },
      }),
      defineTool({
        name: 'git_push',
        description: 'Push a branch of your repository to the remote, as a fast-forward. Commit first. Protected branches (main, master unless the project says otherwise) are refused: push another branch. A person may be asked first, and is shown the commits.',
        parameters: { remote, path, branch: { type: 'string', description: 'The branch to push.', required: true } },
        output: text,
        execute: async (args, exec) => {
          const projectId = projectOf(exec)
          if (projectId === undefined) return 'git_push works only in a project.'
          const input = args as Record<string, unknown>
          return service.gitPush(projectId, { ...(str(input['remote']) === undefined ? {} : { remote: str(input['remote']) }), ...(str(input['path']) === undefined ? {} : { path: str(input['path']) }), ...(str(input['branch']) === undefined ? {} : { branch: str(input['branch']) }) })
        },
      }),
      defineTool({
        name: 'send_mail',
        description: 'Send an e-mail from the project\'s mail account, which Argus holds; you never see it. To the project\'s trusted recipients, within their daily counts, it goes at once; otherwise a person is shown the mail and approves it first. Recipients must be in the project\'s mail.allowed_recipients or mail.trusted_recipients. Attachments are files in your folder. To answer a mail from the mailbox, give its id in reply_to: the reply goes only to its sender.',
        parameters: {
          to: { type: 'array', items: { type: 'string' }, description: 'Addresses, like ana@example.com. Required unless reply_to is given.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'Addresses in copy.' },
          bcc: { type: 'array', items: { type: 'string' }, description: 'Addresses in hidden copy.' },
          subject: { type: 'string', description: 'One line. Required unless reply_to is given.' },
          text: { type: 'string', description: 'The mail, as plain text.', required: true },
          html: { type: 'string', description: 'The same mail as HTML, when it needs formatting.' },
          attachments: { type: 'array', items: { type: 'string' }, description: 'Files in your folder, relative to it.' },
          reply_to: { type: 'string', description: 'The id of the mail this answers, as mail_list shows it (INBOX:4521). to is then its sender; the subject defaults to Re: its subject.' },
        },
        output: text,
        execute: async (args, exec) => {
          const projectId = projectOf(exec)
          if (projectId === undefined) return 'send_mail works only in a project.'
          const agentId = (exec as { agent?: { id: unknown } }).agent?.id
          return service.sendMail(projectId, String((exec as { callId: unknown }).callId), args, agentId === undefined ? null : (service.runOf(String(agentId)) ?? null))
        },
      }),
      ...mailboxTools.map(({ name, description, parameters }) =>
        defineTool({
          name,
          description,
          parameters,
          output: text,
          execute: async (args, exec) => {
            const projectId = projectOf(exec)
            if (projectId === undefined) return `${name} works only in a project.`
            return service.mailboxTool(projectId, name, args as Record<string, unknown>)
          },
        }),
      ),
    ]
    for (const tool of tools) child.effect(() => (child as unknown as { tools: { register(tool: unknown): () => void } }).tools.register(tool))
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
  // Read on every load, so an edited template reaches the projects that follow it at /reload.
  const { templates, problems } = loadTemplates(join(paths.configDirAbs, 'templates'))
  service.setTemplateProblems([...problems.map((line) => `templates/${line}`), ...templateIssues(templates)])
  const files = loadProjectConfigs({ projectsDir: paths.projectsDir, projectsRoot, strict: false, budgetDefaults: budgetDefaultsOf(ctx.opsRawConfig), limitsDefaults: limitsDefaultsOf(ctx.opsRawConfig), templates, ...(service.extensions === undefined ? {} : { extensions: service.extensions.usable() }) })
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
/**
 * ops.yaml `budgets.default_day_usd` / `default_month_usd`: a project's budget when its
 * file sets none. Absent keys keep the project schema's own defaults ($3 / $40, the same
 * as the governor's).
 */
function limitsDefaultsOf(raw: Record<string, unknown>): Partial<ProjectLimits> {
  const limits = raw['limits']
  if (limits === null || typeof limits !== 'object') return {}
  return Object.fromEntries(
    Object.entries(limits as Record<string, unknown>).filter(([key, value]) => (['max_steps_total', 'loop_repeat_threshold', 'stall_steps', 'max_tokens_per_request', 'loop_check_steps'].includes(key) ? typeof value === 'number' : key === 'on_loop' && ['stop', 'notify', 'ask'].includes(value as string))),
  )
}

function budgetDefaultsOf(raw: Record<string, unknown>): BudgetDefaults | undefined {
  const budgets = raw['budgets']
  if (budgets === null || typeof budgets !== 'object') return undefined
  const day = (budgets as Record<string, unknown>)['default_day_usd']
  const month = (budgets as Record<string, unknown>)['default_month_usd']
  if (typeof day !== 'number' && typeof month !== 'number') return undefined
  return { day_usd: typeof day === 'number' ? day : 3, month_usd: typeof month === 'number' ? month : 40 }
}

export type { InvalidProject, Owner, ProjectConfig }
