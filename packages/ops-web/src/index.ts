// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web` — the web interface.
 *
 * A dashboard (projects, spending, runs, approvals, schedules), settings and a chat,
 * on a private network. A person signs in as a user of Argus, with a password or a
 * `/web` link; the chat is a channel adapter like Telegram's. Reads come from the
 * services; every change is a command run as the signed-in user, with their role,
 * so the web has no rules of its own (AGENTS.md, rule 4).
 *
 * @module @argus-agent/web
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import type { DoctorFinding } from '@argus-agent/types'
import { pathsOf } from '@argus-agent/argus-agent'
import { ALWAYS, APPROVE, APPROVE_ALL, DENY } from '@argus-agent/approvals-bridge'
import { checkpointQuestionId, governorConfigOf } from '@argus-agent/governor'
import { describeSchema, type SchemaNode } from '@argus-agent/commands'
import { projectConfigSchema } from '@argus-agent/projects'
import { INVITE_TTL_MS, WebAuth } from './auth.js'
import { webOf, webSchema } from './config.js'
import { overview, projectDetail, projectList, requestText, runsAndCosts, scheduleList, settings, taskList, type FrontDeskPort, type InstructionsPort, type ProvidersPort, type SchedulePort } from './data.js'
import { startWebServer, type CommandOutcome } from './server.js'
import { DownloadLinks } from './files.js'
import { SETUP_TTL_MS, SetupGate } from './setup.js'
import { threadChat, WebChannelAdapter } from './web-channel.js'
import { Locales } from './locales.js'

export * from './auth.js'
export * from './config.js'
export * from './data.js'
export * from './files.js'
export * from './server.js'
export * from './setup.js'
export * from './totp.js'
export * from './web-channel.js'

/** Stable Cordis plugin name. */
export const name = 'ops-web'

export const inject = [
  'opsRawConfig',
  'opsConfigRegistry',
  'opsStore',
  'opsProjects',
  'opsMeter',
  'opsGovernor',
  'opsChannel',
  'opsCommands',
]

/** What the plugin offers the rest of the system: the `/web` link. */
export interface OpsWeb {
  /**
   * A one-time sign-in link for a user, valid ten minutes.
   *
   * @param userId the Argus user id.
   * @returns the link.
   */
  loginLink(userId: string): string
  /** Where the interface is opened, without a trailing slash. */
  readonly publicUrl: string
  /**
   * A one-time sign-in link valid 24 hours, for an invitation or a password reset.
   *
   * @param userId the Argus user id.
   * @returns the link.
   */
  inviteLink(userId: string): string
  /** The port the server listens on, once it does. */
  readonly port: number | undefined
  /** `argus doctor`: in public mode, HTTPS and the admin's second factor. */
  doctor(): DoctorFinding[]
  /**
   * A one-time link to download a file too big for a chat. It needs a web session,
   * works once and expires after `web.download_link_hours`.
   *
   * @param path the file. The caller has checked it is the agent's to send.
   * @param name the name it is saved as.
   * @param take move the file to the web's own folder (one made for this, such as a zip).
   * @returns the link, or `undefined` when the web is not serving.
   */
  downloadLink(path: string, name: string, take?: boolean): string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The web interface, once mounted. */
    opsWeb: OpsWeb
  }
}

/** Events after which the overview has something new. */
const OVERVIEW_EVENTS = [
  'ops/usage',
  'ops/run-started',
  'ops/run-stopped',
  'ops/checkpoint-waiting',
  'ops/agent-running',
  'ops/agent-idle',
  'ops/approval-requested',
  'ops/approval-decided',
  'ops/command-run',
  'ops/panic',
  'ops/resumed',
  'ops/schedule-fired',
  'ops/day-rollover',
]
/** Events after which the settings have something new. */
const SETTINGS_EVENTS = ['ops/command-run', 'ops/config-loaded']

/**
 * Mount the web interface.
 *
 * @param ctx the plugin's context.
 */
export async function apply(ctx: Context): Promise<void> {
  const section = ctx.opsConfigRegistry.extend('web', webSchema)
  ctx.effect(() => section)
  const config = webOf(ctx.opsRawConfig)
  const logger = ctx.logger('ops-web')
  if (!config.enabled) {
    logger.info('the web interface is disabled (web.enabled: false)')
    return
  }

  // ── change notifications, coalesced ──────────────────────────────────────
  const listeners = new Set<(topic: string) => void>()
  const notify = (topic: string): void => {
    for (const listener of listeners) listener(topic)
  }
  // `ops/usage` fires per model request; a page needs at most one refresh a second.
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  const soon = (topic: string): void => {
    pending.add(topic)
    timer ??= setTimeout(() => {
      timer = undefined
      for (const each of pending) notify(each)
      pending.clear()
    }, 1_000)
  }
  ctx.effect(() => () => clearTimeout(timer))
  for (const event of OVERVIEW_EVENTS) ctx.on(event as never, (() => soon('overview')) as never)
  for (const event of SETTINGS_EVENTS) ctx.on(event as never, (() => soon('settings')) as never)

  // ── the chat channel ─────────────────────────────────────────────────────
  const chat = new WebChannelAdapter((chatId) => notify(`chat:${chatId}`), ctx.opsStore.webChat)
  const unregister = ctx.opsChannel.register(chat)
  ctx.effect(() => () => void unregister())

  // ── login ────────────────────────────────────────────────────────────────
  const auth = new WebAuth(ctx.opsStore, config.session_hours * 3_600_000, () => Date.now(), config.public ? config.idle_minutes * 60_000 : 0)
  const https = config.public_url.startsWith('https://')
  const links = new DownloadLinks(join(pathsOf(ctx.opsRawConfig).stateDir, 'web-downloads'), config.download_link_hours * 3_600_000)
  ctx.effect(() => {
    const timer = setInterval(() => links.expire(), 3_600_000)
    return () => clearInterval(timer)
  })
  const web: { -readonly [K in keyof OpsWeb]: OpsWeb[K] } = {
    loginLink: (userId: string) => `${config.public_url}/login?token=${auth.issueToken(userId)}`,
    publicUrl: config.public_url,
    inviteLink: (userId: string) => `${config.public_url}/login?token=${auth.issueToken(userId, INVITE_TTL_MS)}`,
    port: undefined,
    downloadLink: (path, name, take) => (web.port === undefined ? undefined : `${config.public_url}/f/${links.create(path, name, take)}`),
    doctor: () => publicDoctor(config.public, https, () => {
      const admin = ctx.opsStore.users.admin()
      return admin === undefined || auth.hasTotp(admin.id)
    }),
  }
  if (config.public && !https) logger.warn('web.public is on but web.public_url is not https://: run `argus doctor`')
  ctx.provide('opsWeb', web)

  // ── the first admin, or a lost one ───────────────────────────────────────
  const setup = new SetupGate(ctx.opsStore, auth, pathsOf(ctx.opsRawConfig).stateDir, config.public_url)
  const announce = (): void => {
    const written = setup.refresh()
    if (written === 'setup') logger.info('there is no admin yet: run `argus setup-link` on the server for the one-time setup link')
    else if (written === 'admin') logger.info('a sign-in link for the admin was asked for: run `argus setup-link` on the server to see it')
  }
  try {
    announce()
  } catch (error) {
    logger.warn('the setup link could not be written: %s', error instanceof Error ? error.message : String(error))
  }
  // A setup link lasts an hour; while nobody has used it, a new one replaces it.
  const renew = setInterval(() => {
    if (setup.open) announce()
  }, SETUP_TTL_MS)
  ctx.effect(() => () => clearInterval(renew))

  const sources = {
    store: ctx.opsStore,
    meter: ctx.opsMeter,
    governor: ctx.opsGovernor,
    projects: ctx.opsProjects,
    schedules: () => ctx.get('opsScheduler' as never) as unknown as SchedulePort | undefined,
    providers: () => ctx.get('opsProviders' as never) as unknown as ProvidersPort | undefined,
    frontDesk: () => ctx.get('opsOrchestrator' as never) as unknown as FrontDeskPort | undefined,
    memory: () => ctx.get('opsMemory' as never) as unknown as InstructionsPort | undefined,
    now: () => Date.now(),
  }

  // Shown by the setup page; they change in ops.yaml, with a restart.
  const { budgets } = governorConfigOf(ctx.opsRawConfig)
  const system = { timezone: pathsOf(ctx.opsRawConfig).timezone, dayUsd: budgets.default_day_usd, monthUsd: budgets.default_month_usd }

  const runCommand = async (line: string, session: { userId: string }): Promise<CommandOutcome> => {
    // A confirmation button comes back as its token; it is the `/confirm` command.
    const confirm = /^__confirm:([^:]+):(yes|no)$/.exec(line)
    // Read at every command: a role changed since the sign-in applies at once.
    const role = ctx.opsStore.users.get(session.userId)?.role ?? 'operator'
    const out = await ctx.opsCommands.runCommand(confirm === null ? line : `/confirm ${confirm[1]} ${confirm[2]}`, {
      address: { channel: 'web', chatId: session.userId },
      userId: session.userId,
      user: { id: session.userId, role },
      isAdmin: role === 'admin',
      now: Date.now(),
    })
    // A file a command produced (`/get`) goes to the user's chat, which serves it.
    const files =
      out.files === undefined || out.files.length === 0
        ? undefined
        : chat.offer(
            session.userId,
            out.text,
            out.files.map((file) => ('path' in file ? { name: file.name, path: file.path } : { name: file.name, bytes: new TextEncoder().encode(file.content), ...(file.contentType === undefined ? {} : { mimeType: file.contentType }) })),
          )
    return {
      text: out.text,
      error: out.error === true,
      buttons: (out.buttons ?? []).map((button) => ({ label: button.label, command: button.command })),
      ...(files === undefined ? {} : { files }),
    }
  }

  try {
    const server = await startWebServer({
      host: config.host,
      port: config.port,
      secure: https,
      public: config.public,
      auth,
      setup,
      sessionHours: config.session_hours,
      chat,
      me: (session) => {
        const user = ctx.opsStore.users.get(session.userId)
        const login = auth.loginOf(session.userId)
        return {
          userId: session.userId,
          name: user?.name ?? null,
          role: user?.role ?? 'operator',
          login: login ?? null,
          hasPassword: login !== undefined,
          mayResetPassword: auth.mayResetPassword(session),
          // Which buttons to show: what the role may not run is not offered.
          adminOnly: ctx.opsCommands.specs().filter((spec) => spec.adminOnly === true).map((spec) => spec.name),
          channels: ctx.opsStore.users.identities(session.userId).filter((identity) => identity.channel !== 'web').map((identity) => `${identity.channel}:${identity.external_id}`),
          language: user?.language ?? null,
          expiresAt: session.expiresAt,
        }
      },
      users: (session) => {
        if (ctx.opsStore.users.get(session.userId)?.role !== 'admin') return undefined
        return ctx.opsStore.users.list().map((user) => ({
          id: user.id,
          name: user.name,
          role: user.role,
          disabled: user.disabled_at !== null,
          login: auth.loginOf(user.id) ?? null,
          channels: ctx.opsStore.users.identities(user.id).filter((identity) => identity.channel !== 'web').map((identity) => `${identity.channel}:${identity.external_id}`),
          createdAt: user.created_at,
        }))
      },
      overview: () => overview(sources),
      projects: () => projectList(sources),
      project: (id) => projectDetail(sources, id),
      templates: () => ctx.opsCommands.templates(),
      tasks: () => taskList(sources),
      schedules: () => scheduleList(sources),
      runs: () => runsAndCosts(sources),
      settings: () => ({ ...settings(sources), system }),
      systemSettings: () => ctx.opsCommands.systemSettings(),
      projectSettings: (id) => projectSettings(ctx, id),
      locales: new Locales(fileURLToPath(new URL('../public/locales/', import.meta.url)), join(pathsOf(ctx.opsRawConfig).configDirAbs, 'locales')),
      setLanguage: (userId, code) => void ctx.opsStore.users.setLanguage(userId, code),
      secrets: () => secretsInventory(ctx),
      extensions: () => {
        const extensions = ctx.opsProjects.extensions
        const configs = ctx.opsProjects.configuredIds().flatMap((id) => {
          const config = ctx.opsProjects.configOf(id)
          return config === undefined ? [] : [config]
        })
        return (extensions?.installed() ?? []).map((entry) => {
          const manifest = extensions?.manifestOf(entry.name)
          return {
            name: entry.name,
            version: entry.version,
            source: entry.source,
            ref: entry.ref,
            commit: entry.commit.slice(0, 12),
            installedAt: entry.installed_at,
            summary: manifest?.summary ?? null,
            network: manifest?.requires.network ?? false,
            secrets: manifest?.requires.secrets ?? [],
            tools: Object.keys(manifest?.mcp ?? {}),
            skills: manifest?.skills ?? [],
            projects: configs.filter((config) => config.extensions.some((each) => each.name === entry.name)).map((config) => config.id),
          }
        })
      },
      models: () => {
        const providers = ctx.get('opsProviders' as never) as unknown as { models?: () => Array<{ provider: string; model: string; ready: boolean }> } | undefined
        return (providers?.models?.() ?? []).map((entry) => {
          const price = ctx.opsMeter.priceOf({ provider: entry.provider, model: entry.model })
          return { ...entry, ref: `${entry.provider}/${entry.model}`, price: price === undefined ? null : { input: price.input, output: price.output, source: price.source } }
        })
      },
      bindThread: (userId, projectId) => {
        if (ctx.opsProjects.configOf(projectId) === undefined) return false
        const chatId = threadChat(userId, `p:${projectId}`)
        if (chatId === undefined) return false
        if (ctx.opsStore.chatContext.get('web', chatId)?.active_project_id !== projectId) ctx.opsStore.chatContext.setActive('web', chatId, projectId, Date.now())
        return true
      },
      sessions: () =>
        ctx.opsProjects.sessions().map((session) => {
          const runs = ctx.opsStore.runs.bySession(session.sessionId, 50)
          const first = runs[runs.length - 1]
          return {
            ...session,
            text: first === undefined || first.inbound_id === null ? null : requestText(ctx.opsStore.inbound.get(first.inbound_id)?.payload),
            micros: runs.reduce((sum, run) => sum + Number(ctx.opsMeter.runTotals(run.id).costMicros), 0),
            model: first === undefined ? null : `${first.provider}/${first.model}`,
          }
        }),
      runCommand,
      answerApproval: (approvalId, value, session) =>
        [APPROVE, DENY, APPROVE_ALL, ALWAYS].includes(value) &&
        ctx.opsChannel.answerQuestion(`approval:${approvalId}`, value, { address: { channel: 'web', chatId: session.userId }, userId: session.userId }),
      answerCheckpoint: (runId, value, session) => {
        const waiting = ctx.opsGovernor.status().running.find((run) => run.runId === runId)?.checkpoint
        return (
          waiting !== undefined &&
          ['continue', 'stop'].includes(value) &&
          ctx.opsChannel.answerQuestion(checkpointQuestionId(runId, waiting.steps), value, { address: { channel: 'web', chatId: session.userId }, userId: session.userId })
        )
      },
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      projectDir: (id) => ctx.opsProjects.configOf(id)?.cwd,
      isAdmin: (session) => ctx.opsStore.users.get(session.userId)?.role === 'admin',
      oauth: ctx.opsProjects.oauth,
      publicUrl: config.public_url,
      maxUploadBytes: config.max_upload_mb * 1024 * 1024,
      confineZip: async (argv, root, reads) => {
        const sandbox = ctx.get('sandbox' as never) as unknown as { confineReading?(argv: readonly string[], policy: { mode: 'workspace-write'; workspaceRoot: string }, reads: readonly string[]): Promise<{ argv: readonly string[] }> } | undefined
        if (sandbox?.confineReading === undefined) throw new Error('the command sandbox is not available')
        return (await sandbox.confineReading(argv, { mode: 'workspace-write', workspaceRoot: root }, reads)).argv
      },
      zipScratch: join(pathsOf(ctx.opsRawConfig).stateDir, 'web-zips'),
      links,
      uploaded: (session, projectId, path, bytes) =>
        ctx.opsStore.audit.record({ actor: session.userId, action: 'web.upload', target: projectId, details: { path, bytes } }, Date.now()),
      log: (message) => logger.warn(message),
    })
    web.port = server.port
    ctx.effect(() => () => void server.close())
    logger.info('web interface on %s:%d (open it through %s)', config.host, server.port, config.public_url)
  } catch (error) {
    // A taken port must not take the rest of the system down.
    logger.warn('the web interface could not start on %s:%d: %s', config.host, config.port, error instanceof Error ? error.message : String(error))
  }
}

/**
 * The public-mode findings: nothing when the web is private.
 *
 * @param isPublic `web.public`.
 * @param https whether `web.public_url` is `https://`.
 * @param adminHasTotp whether the admin (when there is one) has a second factor.
 * @returns the findings.
 */
export function publicDoctor(isPublic: boolean, https: boolean, adminHasTotp: () => boolean): DoctorFinding[] {
  if (!isPublic) return []
  return [
    https
      ? { ok: true, check: 'the public web: HTTPS', detail: 'web.public_url is https://' }
      : { ok: false, check: 'the public web: HTTPS', detail: 'web.public is on but web.public_url is not https://', fix: 'put the web behind the Caddy overlay (docs/user/web.md#public-mode) and set web.public_url to https://<your domain>, then restart' },
    adminHasTotp()
      ? { ok: true, check: "the public web: the admin's second factor", detail: 'set' }
      : { ok: false, check: "the public web: the admin's second factor", detail: 'the admin has no authenticator code yet', fix: 'sign in on the web: it asks for the code to be set up before anything else' },
  ]
}

/**
 * A project's settings, for its Settings tab: every key of its file described, which of
 * them the project sets itself, and what its MCP servers, extensions, remotes, mail,
 * memory and undo points are.
 *
 * @param ctx the plugin's context.
 * @param id the project.
 * @returns the settings, or `undefined` when there is no such project.
 */
async function projectSettings(ctx: Context, id: string): Promise<unknown> {
  const config = ctx.opsProjects.configOf(id)
  if (config === undefined) return undefined
  const schema = projectConfigSchema as unknown as SchemaNode
  let raw: unknown = {}
  try {
    raw = parseYaml(readFileSync(config.sourcePath, 'utf8')) ?? {}
  } catch {
    // Unreadable now: nothing is marked as the project's own.
  }
  const own = new Set(describeSchema(schema, raw, () => 'next-message').filter((field) => field.set).map((field) => field.key))
  const inherited = (key: string): boolean => config.fromTemplate.some((each) => each === key || key.startsWith(`${each}.`))
  const fields = describeSchema(schema, config, () => 'next-message')
    .filter((field) => !['id', 'cwd', 'provider', 'preset'].includes(field.key))
    .map((field) => ({ ...field, own: own.has(field.key), inherited: inherited(field.key) }))
  const extensions = ctx.opsProjects.extensions
  const enabled = new Set(config.extensions.map((extension) => extension.name))
  const memory = ctx.get('opsMemory' as never) as unknown as { sections?: (projectId: string) => Array<{ name: string; chars: number }> } | undefined
  const undo = await ctx.opsProjects.undoList(id).catch(() => [])
  const account = await ctx.opsProjects.mail.accountOf(id).catch(() => undefined)
  return {
    id,
    template: config.template,
    model: `${config.provider}/${config.model}`,
    fields,
    mcp: await Promise.all(
      Object.entries(config.mcp).map(async ([name, server]) => ({
        name,
        kind: server.url === null ? 'local' : 'remote',
        target: server.url ?? [server.command, ...server.args].join(' '),
        access: server.access,
        tools: server.tools,
        oauth: server.oauth !== null,
        state: server.oauth === null ? null : (await ctx.opsProjects.oauth.status(id, name)).state,
        extension: server.extension?.name ?? null,
      })),
    ),
    extensions: (extensions?.installed() ?? []).map((entry) => {
      const manifest = extensions?.manifestOf(entry.name)
      return { name: entry.name, version: manifest?.version ?? null, summary: manifest?.summary ?? null, enabled: enabled.has(entry.name), network: manifest?.requires.network ?? false }
    }),
    git: await Promise.all(Object.entries(config.git.remotes).map(async ([name, remote]) => ({ name, url: remote.url, protected: remote.protected, token: await ctx.opsProjects.git.hasToken(id, name) }))),
    mail: { ...config.mail, account: account === undefined ? null : { own: account.own, host: account.account.host, user: account.account.user } },
    memory: memory?.sections?.(id) ?? [],
    undo: undo.slice(0, 10),
  }
}

/** One secret in the inventory: never its value. */
interface SecretRow {
  readonly name: string
  readonly used: string
  /** `set` here, from the server's `env`, or `missing`. */
  readonly state: 'set' | 'env' | 'missing'
  /** The command that sets it, without the value. */
  readonly set: string | null
  /** The command that removes it. */
  readonly remove: string | null
}

/**
 * Every secret something needs, grouped: the model providers', the search provider's,
 * Telegram's, the `${NAME}`s of MCP servers and extensions, git tokens, mail accounts and
 * OAuth grants. The store cannot list what nothing needs, so that is not here.
 *
 * @param ctx the plugin's context.
 * @returns the groups.
 */
async function secretsInventory(ctx: Context): Promise<Array<{ group: string; secrets: SecretRow[] }>> {
  const providers = ctx.get('opsProviders' as never) as unknown as
    | { keyStatus(): Array<{ provider: string; name: string; configured: boolean; writable: boolean; source?: string }>; secretInfo?(name: string): { configured: boolean; writable: boolean } }
    | undefined
  const state = (info: { configured: boolean; writable: boolean } | undefined): SecretRow['state'] => (info?.configured !== true ? 'missing' : info.writable ? 'set' : 'env')
  const status = providers?.keyStatus() ?? []
  const ids = ctx.opsProjects.configuredIds()
  const configs = ids.flatMap((id) => {
    const config = ctx.opsProjects.configOf(id)
    return config === undefined ? [] : [config]
  })
  const used = new Set(configs.map((config) => config.provider))
  const search = ((ctx.opsRawConfig['web_search'] as { provider?: string } | undefined)?.provider ?? 'deepseek').toLowerCase()
  const SEARCH = ['tavily', 'brave', 'serper']
  const models = status
    .filter((entry) => entry.provider !== 'telegram' && !SEARCH.includes(entry.provider) && (entry.configured || used.has(entry.provider)))
    .map((entry): SecretRow => ({ name: entry.name, used: `${entry.provider}${used.has(entry.provider) ? ` · ${configs.filter((config) => config.provider === entry.provider).map((config) => config.id).join(', ')}` : ''}`, state: state(entry), set: `/key ${entry.provider}`, remove: `/key remove ${entry.provider}` }))
  const searchKeys = status
    .filter((entry) => SEARCH.includes(entry.provider) && (entry.configured || entry.provider === search))
    .map((entry): SecretRow => ({ name: entry.name, used: `web_search: ${entry.provider}${entry.provider === search ? ' (in use)' : ''}`, state: state(entry), set: `/key ${entry.provider}`, remove: `/key remove ${entry.provider}` }))
  const telegram = status.filter((entry) => entry.provider === 'telegram').map((entry): SecretRow => ({ name: entry.name, used: 'Telegram', state: state(entry), set: '/key telegram', remove: '/key remove telegram' }))
  // ${NAME} in a project's MCP servers, and what extensions declare.
  const named = new Map<string, Set<string>>()
  const note = (name: string, user: string): void => void (named.get(name) ?? named.set(name, new Set()).get(name))?.add(user)
  for (const config of configs) {
    for (const [server, entry] of Object.entries(config.mcp)) {
      for (const text of [...Object.values(entry.env), ...Object.values(entry.headers)]) for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) if (match[1] !== 'EXTENSION_DIR' && match[1] !== 'ARGUS_EGRESS_PROXY') note(match[1] as string, `${config.id} · ${server}`)
    }
  }
  const extensions = ctx.opsProjects.extensions
  for (const entry of extensions?.installed() ?? []) for (const name of extensions?.manifestOf(entry.name)?.requires.secrets ?? []) note(name, `extension ${entry.name}`)
  const mcp = [...named.entries()].map(([name, users]): SecretRow => ({ name, used: [...users].join('; '), state: state(providers?.secretInfo?.(name)), set: `/key ${name}`, remove: `/key remove ${name}` }))
  const git: SecretRow[] = []
  const mail: SecretRow[] = []
  const oauth: SecretRow[] = []
  for (const config of configs) {
    for (const [remote, entry] of Object.entries(config.git.remotes)) {
      git.push({ name: `${config.id} · ${remote}`, used: entry.url, state: (await ctx.opsProjects.git.hasToken(config.id, remote)) ? 'set' : 'missing', set: `/git token ${config.id} ${remote}`, remove: `/git forget ${config.id} ${remote}` })
    }
    const account = await ctx.opsProjects.mail.accountOf(config.id).catch(() => undefined)
    if (account?.own === true) mail.push({ name: `${config.id}`, used: `${account.account.user} @ ${account.account.host}`, state: 'set', set: `/mail set ${config.id}`, remove: `/mail remove ${config.id}` })
    for (const [server, entry] of Object.entries(config.mcp)) {
      if (entry.oauth === null) continue
      const grant = await ctx.opsProjects.oauth.status(config.id, server)
      oauth.push({ name: `${config.id} · ${server}`, used: entry.url ?? '', state: grant.state === 'connected' ? 'set' : 'missing', set: `/mcp connect ${config.id} ${server}`, remove: grant.state === 'connected' ? `/mcp disconnect ${config.id} ${server}` : null })
    }
  }
  const shared = await ctx.opsProjects.mail.accountOf(null).catch(() => undefined)
  if (shared !== undefined) mail.unshift({ name: 'default', used: `${shared.account.user} @ ${shared.account.host}`, state: 'set', set: '/mail set default', remove: '/mail remove default' })
  return [
    { group: 'models', secrets: models },
    { group: 'search', secrets: searchKeys },
    { group: 'channels', secrets: telegram },
    { group: 'mcp', secrets: mcp },
    { group: 'git', secrets: git },
    { group: 'mail', secrets: mail },
    { group: 'oauth', secrets: oauth },
  ].filter((group) => group.secrets.length > 0)
}
