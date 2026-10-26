// == ARGUS AGENT PROJECT ==
/**
 * `ctx.opsProjects` — the agent lifecycle and ownership service.
 *
 * It creates, resumes and disposes every dsh agent in the system, answers "who
 * owns this session?", and emits the lifecycle events the governor and the
 * channel consume.
 *
 * @module @argus-agent/projects/service
 */
import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { hiddenTools, taskToolPolicy, TOOL_GROUPS, type DoctorFinding, type McpServer, type ModelCheck, type ModelProblem, type ModelRef, type ServiceHealth } from '@argus-agent/types'
// Type-only: brings in the `ctx.agentPresets` augmentation.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { RUN_TRAIL_ACTION, runAnswer, runTrail } from './run-trail.js'
import {
  OpsError,
  ownerKey,
  projectOwner,
  adhocOwner,
  orchestratorOwner,
  type ContentBlockLike,
  type Owner,
} from '@argus-agent/types'
import type { MailOutboxRow, OpsStore } from '@argus-agent/store'
import { CapabilityIssuer, type Capability } from './capability.js'
import { OwnershipMap } from './ownership.js'
import type { ProjectConfig } from './project-config.js'
import type { InvalidProject } from './project-loader.js'
import { projectModelRef } from './project-config.js'
import type { SnapshotEntry, Snapshots, SnapshotSettings } from './snapshots.js'
import type { Extensions } from './extensions.js'
import { GitError, GitRemotes, isGitTokenName, type GitRemote, type PushPlan, type TokenStore } from './git-remotes.js'
import { createTransport } from 'nodemailer'
import { isMailSecretName, ProjectMailer, transportOptions, type MailSecrets, type MailTransport } from './mail.js'
import { ProjectMailbox, type MailboxConnect } from './mailbox.js'
import { imapConnect } from './imap.js'
import { EgressProxy } from './egress.js'
import { HostChannel, type HostHandler } from './host.js'
import { McpOAuth, OAuthProxy, isOAuthSecretName, type OAuthClientSettings, type OAuthSecrets } from './oauth.js'

/** What a delivery targets. */
export type AgentTarget =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'adhoc'; readonly runId: string }
  | { readonly kind: 'orchestrator' }

/** A live agent plus what it is. */
interface LiveAgent {
  readonly target: AgentTarget
  readonly owner: Owner
  readonly handle: AgentHandle
  /** Set while a run is open. */
  runId: string | undefined
  /** Session events appended since the run opened, for output extraction. */
  runEvents: SessionEvent[]
  /** Whether the run's turn has produced an assistant message. */
  producing: boolean
  /** A project agent's configuration when it was built: a different one rebuilds it between runs. */
  config?: ProjectConfig
  /** Its project's OAuth grants when it was built: a grant made or lost rebuilds it too. */
  authEpoch?: number
  /** The mailboxes when it was built: one set or removed rebuilds it, to show or hide its tools. */
  mailboxEpoch?: number
  /** When it was created or last given work: a session idle too long is closed. */
  lastActive: number
}

/** A one-off task a person started: its agent and folder stay for follow-ups, as a session. */
export const SESSION_PREFIX = 'task-'

/** A one-off task's session: alive, with when it was last given work. */
export interface TaskSession {
  readonly id: string
  /** The agent's session: every run of the task carries it. */
  readonly sessionId: string
  readonly lastActive: number
  readonly running: boolean
}

/** The name an MCP server's `env` uses for the egress proxy's address. */
export const EGRESS_PROXY_NAME = 'ARGUS_EGRESS_PROXY'

/** Options for creating an ephemeral agent. */
export interface EphemeralOptions {
  readonly kind: 'adhoc' | 'orchestrator'
  readonly runId: string
  readonly model: { readonly provider: string; readonly model: string }
  /** The working directory. Defaults to `<scratch>/<runId>` or `<scratch>/orchestrator`. */
  readonly cwd?: string
  /** A preset to mount. */
  readonly preset?: string | null
  /** Extra setup, run inside the agent's scope before publication. */
  readonly setup?: (agentCtx: Context, agent: Agent) => void | Promise<void>
}

/** The result of a delivery. */
export interface DeliverResult {
  /** Whether the target agent was running already, so the message queued. */
  readonly queued: boolean
  readonly sessionId: string
}

/** Where the extensions' section goes in the system prompt: after the project's instructions (10_100). */
const EXTENSIONS_ORDER = 10_200

/**
 * The projects service.
 *
 * Exposed as `ctx.opsProjects`.
 */
export class OpsProjects {
  /** The session ownership map. Public so the meter can resolve owners. */
  readonly ownership = new OwnershipMap()

  private readonly issuer = new CapabilityIssuer()
  private readonly live = new Map<string, LiveAgent>()
  /** Single-flight guards, so two concurrent `ensureAgent` calls share one creation. */
  private readonly pending = new Map<string, Promise<AgentHandle>>()
  private readonly configs = new Map<string, ProjectConfig>()
  private readonly invalid = new Map<string, InvalidProject>()
  private readonly modelChecks = new Set<ModelCheck>()
  /** Re-run the load, so a project is re-checked when a check comes or goes. */
  private reloader: (() => void) | undefined
  private templateProblems: readonly string[] = []
  private readonly store: OpsStore
  private readonly ctx: Context
  private readonly scratchDir: string
  /** Sessions closed by this process, so a follow-up to one is told it ended. */
  private readonly closedSessions = new Set<string>()
  private readonly stateDir: string | undefined
  /** Where per-project state goes: `stateDir`, or `state/` next to the scratch folder. */
  private readonly stateRoot: string
  /** The extension servers' host channels (`host:` in their manifest). */
  private readonly host: HostChannel
  /** Grants for MCP servers that sign in with OAuth. */
  readonly oauth: McpOAuth
  /** The loopback proxy those servers are reached through, with a fresh token. */
  private readonly oauthProxy: OAuthProxy
  /** The forward proxy a project's browser reaches the public internet through (`${ARGUS_EGRESS_PROXY}`). */
  private readonly egress = new EgressProxy()
  /** Bumped per project when one of its grants changes. */
  private readonly authEpochs = new Map<string, number>()
  /** Bumped when any mailbox is set or removed. */
  private mailboxEpoch = 0
  private readonly projectsRoot: string
  private readonly snapshots: Snapshots | undefined
  /** The installed extensions (`/ext`); undefined in a bare composition. */
  readonly extensions: Extensions | undefined
  /** The projects' git remotes: tokens and mirrors. */
  readonly git: GitRemotes
  /** The projects' mail: accounts, the question's preview, the sending. */
  readonly mail: ProjectMailer
  /** The projects' mailboxes: accounts, and reading. */
  readonly mailbox: ProjectMailbox
  private readonly snapshotSettings: () => SnapshotSettings
  private gitPresent: boolean | undefined
  private disposed = false

  constructor(
    ctx: Context,
    store: OpsStore,
    options: { scratchDir: string; projectsRoot: string; stateDir?: string; snapshots?: Snapshots; snapshotSettings?: () => SnapshotSettings; extensions?: Extensions; mailTransport?: MailTransport; mailboxConnect?: MailboxConnect; oauthClients?: () => Readonly<Record<string, OAuthClientSettings>>; oauthFetch?: typeof fetch },
  ) {
    this.ctx = ctx
    this.store = store
    this.scratchDir = options.scratchDir
    this.stateDir = options.stateDir
    this.stateRoot = options.stateDir ?? join(options.scratchDir, '..', 'state')
    this.projectsRoot = options.projectsRoot
    this.snapshots = options.snapshots
    this.extensions = options.extensions
    this.git = new GitRemotes(
      this.stateRoot,
      () => ctx.get('credentials' as never) as unknown as TokenStore | undefined,
      async (argv, root, reads) => {
        const sandbox = this.ctx.get('sandbox' as never) as unknown as { confineReading?(argv: readonly string[], policy: { mode: 'workspace-write'; workspaceRoot: string }, reads: readonly string[]): Promise<{ argv: readonly string[] }> } | undefined
        if (sandbox?.confineReading === undefined) throw new Error('the command sandbox is not available')
        return (await sandbox.confineReading(argv, { mode: 'workspace-write', workspaceRoot: root }, reads)).argv
      },
    )
    this.mail = new ProjectMailer(
      () => ctx.get('credentials' as never) as unknown as MailSecrets | undefined,
      { record: (entry, ts) => store.audit.record(entry, ts), byAction: (action, limit) => store.audit.byAction(action, limit) },
      options.mailTransport ?? nodemailerTransport,
      (name) => credentialRef(name),
      Date.now,
      {
        original: (projectId, settings, id) => this.mailbox.original(projectId, settings, id),
        paused: (projectId, why) => ctx.emit('ops/mail-paused', { projectId, why }),
        outbox: {
          rows: store.mailOutbox,
          dir: (projectId) => join(this.stateRoot, projectId, 'outbox'),
          changed: (event) => ctx.emit('ops/mail-outbox', event),
        },
      },
    )
    this.mailbox = new ProjectMailbox(
      () => ctx.get('credentials' as never) as unknown as MailSecrets | undefined,
      { record: (entry, ts) => store.audit.record(entry, ts), byAction: (action, limit) => store.audit.byAction(action, limit) },
      options.mailboxConnect ?? imapConnect,
      (name) => credentialRef(name),
      (projectId, cwd, relative, content) => this.placeFile(projectId, cwd, relative, content),
      () => {
        this.mailboxEpoch += 1
      },
    )
    this.snapshotSettings = options.snapshotSettings ?? (() => ({ enabled: false, keep_days: 14, max_file_mb: 20 }))
    this.oauthProxy = new OAuthProxy(options.oauthFetch)
    this.host = new HostChannel(
      join(this.stateRoot, 'h'),
      (projectId) => this.live.get(projectId)?.runId,
      (message) => ctx.logger('ops-projects').warn(message),
      // What the server enforces itself, read when it says hello: a call's turns and minutes,
      // and how long a question may wait, so its own timeouts sit above it.
      (projectId) => {
        const config = this.configs.get(projectId)
        return config === undefined ? {} : { limits: { max_turns: config.delegate.max_turns, max_minutes: config.delegate.max_minutes }, approval_timeout_s: config.approvals.timeout_minutes * 60 }
      },
    )
    this.oauth = new McpOAuth({
      secrets: () => ctx.get('credentials' as never) as unknown as OAuthSecrets | undefined,
      ref: (name) => credentialRef(name),
      clients: options.oauthClients ?? (() => ({})),
      serverOf: (projectId, server) => this.configs.get(projectId)?.mcp[server],
      expand: async (value) => (await this.expand({ value }))['value'] as string,
      audit: (action, projectId, details) => store.audit.record({ actor: 'admin', action, target: projectId, details }, Date.now()),
      changed: (projectId, server, state, reason) => {
        this.authEpochs.set(projectId, (this.authEpochs.get(projectId) ?? 0) + 1)
        ctx.emit('ops/mcp-auth', { projectId, server, state, ...(reason === undefined ? {} : { reason }) })
      },
      ...(options.oauthFetch === undefined ? {} : { fetch: options.oauthFetch }),
    })
  }

  /** Stop the loopback proxies; the plugin's unload calls it. */
  async closeProxies(): Promise<void> {
    await Promise.all([this.oauthProxy.close(), this.egress.close()])
  }

  // ── mail ─────────────────────────────────────────────────────────────────

  /**
   * How a `send_mail` goes: `unasked` when its recipients are trusted and within their
   * counts, `queued` when it waits in the outbox for a person, or refused. Remembered:
   * the send that follows sends or keeps that mail, or nothing.
   *
   * @returns the description, or why it cannot be sent.
   */
  mailPreview(projectId: string, callId: string, args: unknown): Promise<{ ok: boolean; text: string; unasked?: boolean; queued?: boolean }> {
    const config = this.requireConfig(projectId)
    return this.mail.preview(projectId, callId, config.cwd, config.mail, args)
  }

  /**
   * `send_mail`: a trusted mail now, or an asked one into the outbox.
   *
   * @param runId the run that sends it, for the question's address.
   * @returns what happened, for the agent.
   */
  sendMail(projectId: string, callId: string, args: unknown, runId: string | null = null): Promise<string> {
    const config = this.requireConfig(projectId)
    return this.mail.send(projectId, callId, config.cwd, config.mail, args, runId)
  }

  /** A project's outbox: what waits, and what was decided lately, newest first. */
  outboxOf(projectId: string, limit = 10): MailOutboxRow[] {
    return this.store.mailOutbox.byProject(projectId, limit)
  }

  /**
   * Decide a mail in the outbox, with the project's settings as they are now.
   * @returns what happened, for the person.
   */
  decideOutbox(id: number, decision: 'approve' | 'deny' | 'expire', by: string | null, note: string | null = null): Promise<string> {
    const row = this.store.mailOutbox.get(id)
    return this.mail.decideOutbox(id, decision, by, row === undefined ? undefined : this.configOf(row.project_id)?.mail, note)
  }

  /**
   * One of the mailbox's tools, for a project.
   *
   * @param tool the tool's name.
   * @param args its arguments.
   * @returns the answer for the agent.
   */
  mailboxTool(projectId: string, tool: 'mail_list' | 'mail_read' | 'mail_save_attachment' | 'mail_mark_read', args: Record<string, unknown>): Promise<string> {
    const config = this.requireConfig(projectId)
    const str = (key: string): string | undefined => (typeof args[key] === 'string' && (args[key] as string).length > 0 ? (args[key] as string) : undefined)
    switch (tool) {
      case 'mail_list': {
        const folder = str('folder')
        const since = str('since')
        const from = str('from')
        return this.mailbox.list(projectId, config.mail, {
          ...(folder === undefined ? {} : { folder }),
          ...(since === undefined ? {} : { since }),
          ...(from === undefined ? {} : { from }),
          unread_only: args['unread_only'] === true,
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        })
      }
      case 'mail_read':
        return this.mailbox.read(projectId, config.mail, { id: args['id'] })
      case 'mail_save_attachment':
        return this.mailbox.saveAttachment(projectId, config.cwd, config.mail, { id: args['id'], name: args['name'] })
      case 'mail_mark_read':
        return this.mailbox.markRead(projectId, config.mail, { id: args['id'] })
    }
  }

  /**
   * Write a file into a project's folder, its folders made, through the command sandbox:
   * the copy can write only inside the folder, so a link the agent planted cannot lead it
   * out. Staged in Argus's own state first.
   */
  async placeFile(projectId: string, cwd: string, relative: string, content: Buffer): Promise<void> {
    const sandbox = this.ctx.get('sandbox' as never) as unknown as { confineReading?(argv: readonly string[], policy: { mode: 'workspace-write'; workspaceRoot: string }, reads: readonly string[]): Promise<{ argv: readonly string[] }> } | undefined
    if (sandbox?.confineReading === undefined) throw new Error('saving into the folder needs the command sandbox, which is not available')
    const staging = join(this.stateRoot, projectId, 'staging', randomUUID())
    mkdirSync(staging, { recursive: true })
    try {
      const source = join(staging, 'file')
      writeFileSync(source, content, { mode: 0o640 })
      const target = join(cwd, relative)
      const { argv } = await sandbox.confineReading(['/bin/sh', '-c', 'mkdir -p -- "$1" && cp -f -- "$2" "$3"', 'sh', dirname(target), source, target], { mode: 'workspace-write', workspaceRoot: cwd }, [staging])
      await promisify(execFile)(argv[0] as string, argv.slice(1), { cwd, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C' }, timeout: 30_000 })
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  // ── extensions in the project's shell ────────────────────────────────────

  /**
   * What a workspace's commands get from the extensions its project enabled: their
   * folders to read and run from, their programs on PATH, their variables. The command
   * sandbox asks for every confined command.
   *
   * @param workspaceRoot the command's workspace, canonical.
   * @returns the extras, or `undefined` for a folder that is no project's or one with none.
   */
  workspaceExtras(workspaceRoot: string): { reads: string[]; path: string[]; env: Record<string, string> } | undefined {
    const config = [...this.configs.values()].find((candidate) => {
      try {
        return realpathSync(candidate.cwd) === workspaceRoot
      } catch {
        return candidate.cwd === workspaceRoot
      }
    })
    const used = config?.extensions.filter((extension) => extension.binDir !== null || Object.keys(extension.env).length > 0) ?? []
    if (used.length === 0) return undefined
    return {
      reads: used.map((extension) => extension.dir),
      path: used.flatMap((extension) => (extension.binDir === null ? [] : [extension.binDir])),
      env: Object.assign({}, ...used.map((extension) => extension.env)) as Record<string, string>,
    }
  }

  // ── git remotes ──────────────────────────────────────────────────────────

  /** Pushes a person approved, by project, remote and branch: the commit they saw. */
  private readonly approvedPushes = new Map<string, string>()

  /**
   * The remote a git tool names, or the project's only one, or `origin`.
   *
   * @throws {GitError} naming the remotes there are, or how to add one.
   */
  private remoteFor(projectId: string, asked: string | undefined): { config: ProjectConfig; name: string; remote: GitRemote } {
    const config = this.requireConfig(projectId)
    const names = Object.keys(config.git.remotes)
    if (names.length === 0) throw new GitError(`${projectId} has no git remote. The admin adds one with /git remote ${projectId} origin <https-url>.`)
    const name = asked ?? (names.length === 1 ? (names[0] as string) : names.includes('origin') ? 'origin' : undefined)
    const remote = name === undefined ? undefined : config.git.remotes[name]
    if (name === undefined || remote === undefined) throw new GitError(`${asked === undefined ? 'Which remote?' : `No remote "${asked}".`} ${projectId} has ${names.join(', ')}.`)
    return { config, name, remote }
  }

  /** Audit a git operation and give back its text. */
  private async gitAudited(projectId: string, action: string, details: Record<string, unknown>, work: (more: Record<string, unknown>) => Promise<string>): Promise<string> {
    const more: Record<string, unknown> = {}
    try {
      const text = await work(more)
      this.store.audit.record({ actor: `project:${projectId}`, action: `git.${action}`, target: projectId, details: { ...details, ...more, ok: true } }, Date.now())
      return text
    } catch (error) {
      const message = error instanceof GitError ? error.message : `${action} failed: ${(error as Error).message}`
      this.store.audit.record({ actor: `project:${projectId}`, action: `git.${action}`, target: projectId, details: { ...details, ok: false, error: message } }, Date.now())
      return message
    }
  }

  /**
   * `git_clone`: a project's remote into its folder.
   *
   * @returns what happened, for the agent.
   */
  gitClone(projectId: string, args: { remote?: string; branch?: string; into?: string }): Promise<string> {
    return this.gitAudited(projectId, 'clone', { remote: args.remote ?? null, branch: args.branch ?? null }, async () => {
      const { config, name, remote } = this.remoteFor(projectId, args.remote)
      return this.git.clone(projectId, config.cwd, name, remote, { ...(args.branch === undefined ? {} : { branch: args.branch }), ...(args.into === undefined ? {} : { into: args.into }) })
    })
  }

  /**
   * `git_pull`: a project's remote fetched into its repository.
   *
   * @returns what happened, for the agent.
   */
  gitPull(projectId: string, args: { remote?: string; path?: string }): Promise<string> {
    return this.gitAudited(projectId, 'pull', { remote: args.remote ?? null }, async () => {
      const { config, name, remote } = this.remoteFor(projectId, args.remote)
      return this.git.pull(projectId, config.cwd, name, remote, args.path)
    })
  }

  /**
   * What a `git_push` would send, for the person asked to approve it. The commit is
   * remembered: the push that follows sends that commit or nothing.
   *
   * @returns the one-line description, or why it cannot be pushed.
   */
  async gitPushPreview(projectId: string, args: { remote?: string; branch?: string; path?: string }): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
    try {
      const plan = await this.planPush(projectId, args)
      this.approvedPushes.set(`${projectId}\0${plan.remote}\0${plan.branch}`, plan.sha)
      return { ok: true, text: GitRemotes.describe(plan) }
    } catch (error) {
      return { ok: false, text: error instanceof GitError ? error.message : (error as Error).message }
    }
  }

  /**
   * `git_push`: a branch of the project's repository to its remote. When a person was
   * asked, only the commit they saw goes.
   *
   * @returns what happened, for the agent.
   */
  gitPush(projectId: string, args: { remote?: string; branch?: string; path?: string }): Promise<string> {
    return this.gitAudited(projectId, 'push', { remote: args.remote ?? null, branch: args.branch ?? null }, async (more) => {
      const plan = await this.planPush(projectId, args)
      const key = `${projectId}\0${plan.remote}\0${plan.branch}`
      const approved = this.approvedPushes.get(key)
      this.approvedPushes.delete(key)
      if (approved !== undefined && approved !== plan.sha) throw new GitError(`${plan.branch} changed after the push was approved (${approved.slice(0, 7)} then, ${plan.sha.slice(0, 7)} now): nothing was pushed. Push again to be asked about it.`)
      const { remote } = this.remoteFor(projectId, plan.remote)
      Object.assign(more, { remote: plan.remote, sha: plan.sha, commits: plan.count })
      return this.git.push(projectId, remote, plan)
    })
  }

  /** A push, prepared. */
  private async planPush(projectId: string, args: { remote?: string; branch?: string; path?: string }): Promise<PushPlan> {
    if (args.branch === undefined || args.branch.length === 0) throw new GitError('git_push needs the branch to push.')
    const { config, name, remote } = this.remoteFor(projectId, args.remote)
    return this.git.preparePush(projectId, config.cwd, name, remote, args.branch, args.path)
  }

  // ── snapshots and undo ───────────────────────────────────────────────────

  /**
   * Record a project's folder before a run, so `/undo` can put it back. Called by the
   * governor before the run's first delivery. A snapshot that fails is logged and the
   * run goes ahead without one: the work is not held up for its undo point.
   *
   * @param projectId the project.
   * @param runId the run about to start.
   */
  async snapshotBeforeRun(projectId: string, runId: string): Promise<void> {
    const config = this.configs.get(projectId)
    if (this.snapshots === undefined || config === undefined || !this.undoAvailable()) return
    try {
      await this.snapshots.take(projectId, config.cwd, runId)
    } catch (error) {
      this.ctx.logger('ops-projects').warn('project %s: no undo point before run %s: %s', projectId, runId, (error as Error).message)
    }
  }

  /**
   * A project's newest snapshots, newest first.
   *
   * @param projectId the project.
   * @returns the snapshots.
   * @throws {OpsError} `PROJECT_NOT_FOUND`, or `UNDO_UNAVAILABLE` when snapshots are off or git is missing.
   */
  async undoList(projectId: string): Promise<SnapshotEntry[]> {
    return this.requireSnapshots().list(projectId, this.requireConfig(projectId).cwd)
  }

  /**
   * Put a project's folder back as it was before a run (the newest when omitted).
   *
   * @param projectId the project.
   * @param id the run, or an undo's id from {@link undoList}.
   * @returns what was restored, or `undefined` when there is no such snapshot.
   * @throws {OpsError} `PROJECT_NOT_FOUND`, or `UNDO_UNAVAILABLE`.
   */
  async undo(projectId: string, id?: string): Promise<{ readonly kind: 'run' | 'undo'; readonly id: string; readonly at: number } | undefined> {
    return this.requireSnapshots().restore(projectId, this.requireConfig(projectId).cwd, id)
  }

  /** Drop the snapshots older than `snapshots.keep_days`, for every project. */
  async expireSnapshots(): Promise<void> {
    if (this.snapshots !== undefined && this.undoAvailable()) await this.snapshots.expireAll()
  }

  /** The disk the snapshots take, in bytes; 0 when there are none. */
  snapshotBytes(): number {
    return this.snapshots?.sizeBytes() ?? 0
  }

  /** Whether snapshots are on and git is there. */
  private undoAvailable(): boolean {
    if (!this.snapshotSettings().enabled) return false
    if (this.gitPresent === undefined) {
      try {
        execFileSync('git', ['--version'], { stdio: 'ignore' })
        this.gitPresent = true
      } catch {
        this.gitPresent = false
      }
    }
    return this.gitPresent
  }

  private requireSnapshots(): Snapshots {
    if (this.snapshots === undefined || !this.undoAvailable()) {
      const why = this.snapshotSettings().enabled ? 'git is not installed' : 'snapshots.enabled is false in ops.yaml'
      throw new OpsError('UNDO_UNAVAILABLE', `Undo is off: ${why}.`)
    }
    return this.snapshots
  }

  private requireConfig(projectId: string): ProjectConfig {
    const config = this.configs.get(projectId)
    if (config === undefined) throw new OpsError('PROJECT_NOT_FOUND', `No project ${projectId}.`)
    return config
  }

  // ── configuration ────────────────────────────────────────────────────────

  /**
   * Replace the in-memory project configuration.
   *
   * Called after a load or a reload. A project no longer present keeps its live
   * agent until the agent is disposed; only its configuration disappears.
   *
   * @param configs the validated configurations.
   */
  setConfigs(configs: readonly ProjectConfig[]): void {
    this.configs.clear()
    for (const config of configs) this.configs.set(config.id, config)
  }

  /**
   * One project's configuration.
   * @param projectId the slug.
   * @returns the configuration, or `undefined`.
   */
  configOf(projectId: string): ProjectConfig | undefined {
    return this.configs.get(projectId)
  }

  /**
   * Replace the set of project files that fail to validate.
   *
   * Those projects are ignored until a load validates them again: no agent is
   * created for them, and a request for one is refused with the reason.
   *
   * @param invalid the invalid projects from the latest load.
   */
  setInvalid(invalid: readonly InvalidProject[]): void {
    this.invalid.clear()
    for (const project of invalid) this.invalid.set(project.id, project)
  }

  /** Every project whose file does not validate, sorted by id. */
  invalidProjects(): InvalidProject[] {
    return [...this.invalid.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Why a project is invalid.
   * @param projectId the slug.
   * @returns the invalid project, or `undefined` when its file is valid or absent.
   */
  invalidOf(projectId: string): InvalidProject | undefined {
    return this.invalid.get(projectId)
  }

  // ── model checks ─────────────────────────────────────────────────────────

  /**
   * Add a configuration-time check every project model must pass: an API key
   * (the providers row), a price (`ops-meter`). A project whose model fails is
   * invalid, with the check's message; the governor refuses any request whose
   * model fails. The projects are re-checked at once and when the check goes.
   *
   * @param check the check.
   * @returns a disposer, for `ctx.effect`.
   */
  addModelCheck(check: ModelCheck): () => void {
    this.modelChecks.add(check)
    this.reload()
    return () => {
      this.modelChecks.delete(check)
      this.reload()
    }
  }

  /**
   * Why a model cannot run, from every registered check, or `undefined`.
   * @param model the model.
   * @returns the first problem.
   */
  checkModel(model: ModelRef): ModelProblem | undefined {
    for (const check of this.modelChecks) {
      const problem = check(model)
      if (problem !== undefined) return problem
    }
    return undefined
  }

  /**
   * `argus doctor`: every project file that does not validate, including a model that
   * cannot run (no key, no price), with the file to fix.
   *
   * @returns the findings.
   */
  async doctor(): Promise<DoctorFinding[]> {
    // A page the agent reads can steer the commands it runs, unasked.
    const risky: DoctorFinding[] = this.configuredIds().flatMap((id) => {
      const tools = this.configOf(id)?.tools
      return tools?.web === 'allow' && tools.shell === 'allow'
        ? [{ ok: true, warn: true, check: `project ${id}`, detail: 'tools.web and tools.shell are both allow: a web page it reads can steer the commands it runs', fix: `if that is not intended: /set ${id} tools.shell ask` }]
        : []
    })
    for (const { name, problem } of this.extensions?.verify() ?? []) {
      risky.push({ ok: false, check: `extension ${name}`, detail: `${problem}; it is not used`, fix: `reinstall it: /ext update ${name}, or /ext remove ${name}` })
    }
    for (const id of this.configuredIds()) {
      const missing = this.configOf(id)?.extensionsMissing ?? []
      if (missing.length > 0) risky.push({ ok: true, warn: true, check: `project ${id}`, detail: `extensions not installed, or changed, left out: ${missing.join(', ')}`, fix: '/ext lists what is installed; /ext install or /ext update it, or /ext disable it here' })
    }
    for (const problem of this.templateProblems) {
      risky.push({ ok: true, warn: true, check: 'the templates', detail: problem, fix: 'fix the template file, then send /reload' })
    }
    // A server that signs in, not signed in: the project runs without its tools.
    for (const id of this.configuredIds()) {
      for (const [name, server] of Object.entries(this.configOf(id)?.mcp ?? {})) {
        if (server.oauth === null) continue
        const status = await this.oauth.status(id, name)
        if (status.state !== 'connected') risky.push({ ok: true, warn: true, check: `project ${id}`, detail: `the MCP server ${name} is ${status.state === 'failed' ? `signed out: its provider refused the grant (${status.reason ?? ''})` : 'not connected'}; it is left out`, fix: `/mcp connect ${id} ${name}` })
      }
    }
    if (this.snapshotSettings().enabled && !this.undoAvailable()) {
      risky.push({ ok: true, warn: true, check: 'undo', detail: 'git is not installed: no snapshots are taken, /undo is off', fix: 'apt-get install git (or your distribution\'s equivalent)' })
    }
    const invalid = this.invalidProjects()
    if (invalid.length === 0) {
      return [{ ok: true, check: 'the project files', detail: `${this.configuredIds().length} valid` }, ...risky]
    }
    return [
      ...invalid.map((project) => ({
        ok: false,
        check: `project ${project.id}`,
        detail: project.reason,
        fix: `edit ${project.path}, then send /reload`,
      })),
      ...risky,
    ]
  }

  /** Re-check every project's model: something a check reads changed (a price arrived). */
  recheckModels(): void {
    this.reload()
  }

  /** @internal Set by the plugin at each load: what is wrong with the templates. */
  setTemplateProblems(problems: readonly string[]): void {
    this.templateProblems = problems
  }

  /** @internal Set by the plugin: how to reload the project files. */
  setReloader(reloader: () => void): void {
    this.reloader = reloader
  }

  private reload(): void {
    if (this.disposed) return
    try {
      this.reloader?.()
    } catch {
      // A reload failure is reported by the load itself; a check change must not throw.
    }
  }

  /** Every configured project id, sorted. */
  configuredIds(): string[] {
    return [...this.configs.keys()].sort()
  }

  // ── capability ───────────────────────────────────────────────────────────

  /**
   * Claim the delivery capability.
   *
   * `ops-governor` calls this at load. Only one holder may exist per process.
   *
   * @param holder the plugin name.
   * @returns the token to pass to {@link deliver}.
   */
  claimDelivery(holder: string): Capability {
    return this.issuer.issue(holder)
  }

  // ── agent lifecycle ──────────────────────────────────────────────────────

  /**
   * Return the live agent for a project, creating or resuming it as needed.
   *
   * Single-flight: concurrent calls for one project share a creation, so two
   * dispatcher passes cannot produce two agents for one project.
   *
   * @param projectId the slug.
   * @returns the agent.
   * @throws {OpsError} `PROJECT_INVALID` when the project's file does not validate.
   * @throws {OpsError} `PROJECT_NOT_FOUND` when the project is not configured.
   */
  async ensureAgent(projectId: string): Promise<Agent> {
    const invalid = this.invalid.get(projectId)
    if (invalid !== undefined) {
      throw new OpsError('PROJECT_INVALID', invalidMessage(invalid), { projectId, path: invalid.path })
    }
    const config = this.configs.get(projectId)
    if (config === undefined) {
      throw new OpsError('PROJECT_NOT_FOUND', `no project ${JSON.stringify(projectId)} is configured`, {
        projectId,
      })
    }

    const existing = this.live.get(projectId)
    const regranted = existing !== undefined && (existing.authEpoch ?? 0) !== (this.authEpochs.get(projectId) ?? 0)
    const remailed = existing !== undefined && (existing.mailboxEpoch ?? 0) !== this.mailboxEpoch
    const changed = existing === undefined ? [] : [...changedKeys(existing.config, config), ...(regranted ? ['mcp.oauth'] : []), ...(remailed ? ['mail.mailbox'] : [])]
    // A changed setting reaches the agent between runs: the same session, resumed by an
    // agent built from the new settings. One in a run keeps its agent until the run ends.
    if (existing !== undefined && (changed.length === 0 || existing.runId !== undefined || existing.handle.agent.status === 'running')) {
      return existing.handle.agent
    }

    const inFlight = this.pending.get(projectId)
    if (inFlight !== undefined) return (await inFlight).agent

    const creation = existing === undefined ? this.createProjectAgent(config) : this.refreshProjectAgent(existing, config, changed)
    this.pending.set(projectId, creation)
    try {
      const handle = await creation
      return handle.agent
    } finally {
      this.pending.delete(projectId)
    }
  }

  /** Replace a project's idle agent by one built from its new settings, in the same session. */
  private async refreshProjectAgent(existing: LiveAgent, config: ProjectConfig, changed: readonly string[]): Promise<AgentHandle> {
    await existing.handle.dispose()
    this.store.audit.record({ actor: 'system', action: 'project.agent-refreshed', target: config.id, details: { changed } }, Date.now())
    return this.createProjectAgent(config)
  }

  /** Create or resume one project's agent. */
  private async createProjectAgent(config: ProjectConfig): Promise<AgentHandle> {
    const row = this.store.projects.get(config.id)
    const owner = projectOwner(config.id)
    const setup = this.projectSetup(config)

    // Resume when a session is recorded, create otherwise. A resume that fails
    // because the log is gone is not fatal: the project starts a fresh session
    // and the old id is archived in the audit log, so the loss is recorded.
    if (row?.session_id !== null && row?.session_id !== undefined) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: row.session_id as SessionId,
          agentOptions: this.agentOptions(config),
          setup,
        })
        this.adopt(config.id, { kind: 'project', projectId: config.id }, owner, handle, config)
        return handle
      } catch (error) {
        this.ctx.logger('ops-projects').warn(
          'could not resume session %s for project %s, starting fresh: %s',
          row.session_id,
          config.id,
          (error as Error).message,
        )
        this.store.audit.record(
          {
            actor: 'system',
            action: 'session.resume-failed',
            target: config.id,
            details: { sessionId: row.session_id, error: (error as Error).message },
          },
          Date.now(),
        )
        this.store.projects.setSession(config.id, null, Date.now())
      }
    }

    mkdirSync(config.cwd, { recursive: true })
    const handle = await this.ctx.agents.create({
      sessionId: randomUUID() as SessionId,
      meta: { cwd: config.cwd, ...(config.preset !== null ? { agentPreset: config.preset } : {}) },
      agentOptions: this.agentOptions(config),
      setup,
    })
    this.store.projects.setSession(config.id, handle.agent.id as string, Date.now())
    this.adopt(config.id, { kind: 'project', projectId: config.id }, owner, handle, config)
    return handle
  }

  /** The `setup` callback a project agent is composed with. */
  private projectSetup(config: ProjectConfig) {
    return async (agentCtx: Context, agent: Agent): Promise<void> => {
      if (config.preset !== null) {
        // The preset decides the tool set; it must be mounted before the agent
        // is published, or its first turn would run without its tools.
        await this.ctx.agentPresets.mount(agentCtx, config.preset)
      }
      // The mailbox's tools are for a project that has one.
      const mailbox = (await this.mailbox.accountOf(config.id).catch(() => undefined)) !== undefined
      hideTools(agentCtx, [...hiddenTools(config.tools), ...(mailbox ? [] : TOOL_GROUPS.mail_read)])
      await this.mountMcp(agentCtx, config)
      await this.mountSkills(agentCtx, config)
      this.addExtensionInstructions(agentCtx, config)
      // The agent's context goes with the event: a listener that must register a
      // scoped tool needs it, and the session id alone is not enough to reach the
      // scope. Emitted here because this callback is the last moment before the
      // agent is published.
      this.ctx.emit('ops/agent-composed', {
        owner: projectOwner(config.id),
        sessionId: agent.id as string,
        agentCtx,
        agent,
      })
    }
  }

  /**
   * A project folder's tree id now, or at the start of a run: the governor's check that
   * a run which keeps getting the same results has not changed any file either.
   *
   * @param projectId the project.
   * @param runId the run whose starting snapshot is wanted, or none for now.
   * @returns the tree id, or undefined without snapshots (off, git missing, none taken).
   */
  async folderTree(projectId: string, runId?: string): Promise<string | undefined> {
    const config = this.configOf(projectId)
    if (this.snapshots === undefined || config === undefined || !this.undoAvailable()) return undefined
    try {
      return await this.snapshots.tree(projectId, config.cwd, runId === undefined ? undefined : `refs/runs/${runId}`)
    } catch {
      return undefined
    }
  }

  /**
   * What changed in a project's folder since a run started, from its snapshot.
   *
   * @param projectId the project.
   * @param runId the run.
   * @returns files changed and lines added and removed, or undefined without snapshots.
   */
  async folderChanges(projectId: string, runId: string): Promise<{ readonly files: number; readonly added: number; readonly removed: number } | undefined> {
    const config = this.configOf(projectId)
    if (this.snapshots === undefined || config === undefined || !this.undoAvailable()) return undefined
    return this.snapshots.changesSince(projectId, config.cwd, `refs/runs/${runId}`)
  }

  /**
   * A project's skills folder: `<state>/<id>/skills`, outside the project's folder, so
   * its agent cannot write itself a skill. `undefined` without a state directory.
   *
   * @param projectId the project.
   * @returns the folder.
   */
  skillsDirOf(projectId: string): string | undefined {
    return this.stateDir === undefined ? undefined : join(this.stateDir, projectId, 'skills')
  }

  /**
   * Give a project's agent its own skills, from its skills folder: a provider in the
   * agent's scope, which no other agent sees. The base's provider, which read the
   * project folder, is off (the bundle's patch).
   *
   * @param agentCtx the agent's context, inside its `setup`.
   * @param projectId the project.
   */
  private async mountSkills(agentCtx: Context, config: ProjectConfig): Promise<void> {
    const own = this.skillsDirOf(config.id)
    // Without the skill registry (a bare composition) there is nothing to register with.
    if (this.ctx.get('skills' as never) === undefined) return
    // A root holds skill folders, and an extension names the folders: each is read through
    // its parent (a skill beside it in the same parent is read too).
    const dirs = [...(own === undefined ? [] : [own]), ...new Set(config.extensions.flatMap((extension) => extension.skills.map((path) => dirname(path))))]
    if (dirs.length === 0) return
    try {
      // Watched, so a skill /skill adds or removes reaches the agent at its next step.
      await agentCtx.plugin(skillFilesystem, { providerName: `argus-${config.id}`, includeDefaultRoots: false, customSkillDirs: dirs, watch: true })
    } catch (error) {
      this.ctx.logger('ops-projects').warn('project %s: its skills are left out: %s', config.id, (error as Error).message)
    }
  }

  /**
   * The enabled extensions' instructions, in the agent's system prompt after the
   * project's own.
   *
   * @param agentCtx the agent's context, inside its `setup`.
   * @param config the project.
   */
  private addExtensionInstructions(agentCtx: Context, config: ProjectConfig): void {
    const parts = config.extensions.filter((extension) => extension.instructions.length > 0)
    const prompt = (agentCtx as { systemPrompt?: { section(section: { name: string; order: number; interpolate: boolean; text: () => string }): () => void } }).systemPrompt
    if (parts.length === 0 || prompt === undefined) return
    const text = `# Extensions\n\nTools and skills the admin installed for this project, and how to use them.\n\n${parts.map((extension) => `## ${extension.name}\n\n${extension.instructions}`).join('\n\n')}`
    agentCtx.effect(() => prompt.section({ name: 'argus:extensions', order: EXTENSIONS_ORDER, interpolate: false, text: () => text }))
  }

  /**
   * Connect a project's agent to its MCP servers, inside the agent's scope: the
   * servers' processes and tools are this agent's alone, and go with it.
   *
   * A server that cannot start (a secret not set, a program missing, a remote
   * down) is logged and left out; the project runs without it.
   *
   * @param agentCtx the agent's context, inside its `setup`.
   * @param config the project.
   */
  private async mountMcp(agentCtx: Context, config: ProjectConfig): Promise<void> {
    const logger = this.ctx.logger('ops-projects')
    for (const [name, server] of Object.entries(config.mcp)) {
      try {
        const common = { serverName: name, toolCallTimeoutMs: server.timeout_s * 1000 }
        // A local server runs confined, or not at all: it reads the system and, for an
        // extension's, its install; it works in the project's folder; it keeps what it
        // stores in a home of its own, which the agent's shell cannot read.
        // A server that declared `host:` gets its channel: a socket in a folder of its own,
        // read-only to it, and the secret its first message must present. Both go with
        // the agent.
        const host = server.command !== null && server.extension !== undefined && server.extension.host.length > 0 ? await this.host.start(config.id, name, server.extension.host) : undefined
        if (host !== undefined) agentCtx.effect(() => () => this.host.close(config.id, name))
        // `network: proxy`: its connections only to the egress proxy, which it is pointed at.
        const proxy = server.command !== null && server.extension?.network === 'proxy' ? await this.egress.url() : undefined
        const argv = server.command === null ? [] : await this.confineServer(config, name, server, [server.command, ...server.args], host === undefined ? [] : [host.dir], proxy === undefined ? undefined : Number(new URL(proxy).port))
        let options
        if (server.command !== null) {
          const env = {
            ...(await this.expand(server.env)),
            ...(host === undefined ? {} : { ARGUS_HOST_SOCKET: host.socket, ARGUS_HOST_TOKEN: host.token }),
            ...(proxy === undefined ? {} : { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '', no_proxy: '' }),
          }
          options = { ...common, transport: 'stdio' as const, command: argv[0] as string, args: argv.slice(1), env, cwd: config.cwd }
        } else if (server.oauth !== null) {
          // Through the loopback proxy, which adds a fresh token: dsh never holds one.
          const status = await this.oauth.status(config.id, name)
          if (status.state !== 'connected') throw new Error(status.state === 'failed' ? `its sign-in was refused (${status.reason ?? ''}): /mcp connect ${config.id} ${name}` : `it is not connected: /mcp connect ${config.id} ${name}`)
          const route = await this.oauthProxy.add(server.url ?? '', (force) => this.oauth.accessToken(config.id, name, force))
          agentCtx.effect(() => route.remove)
          options = { ...common, transport: 'streamable-http' as const, url: route.url, headers: await this.expand(server.headers) }
        } else {
          options = { ...common, transport: 'streamable-http' as const, url: server.url ?? '', headers: await this.expand(server.headers) }
        }
        await agentCtx.plugin(mcpClient, options)
      } catch (error) {
        logger.warn('project %s: MCP server %s is left out: %s', config.id, name, (error as Error).message)
      }
    }
  }

  /**
   * Wrap a local server in the command sandbox: read the system and its extension's
   * folder, read and write the project's folder and its own home.
   *
   * @param config the project.
   * @param name the server's name.
   * @param server the server.
   * @param argv the server's command.
   * @param reads more folders it reads: its host channel's.
   * @param proxyPort `network: proxy`: its TCP connections only to this port. Where that
   *   cannot be enforced, it runs with the network, warned about (`argus doctor` says why).
   * @returns the wrapped command.
   * @throws {Error} without the sandbox: the server is then left out.
   */
  private async confineServer(config: ProjectConfig, name: string, server: McpServer, argv: readonly string[], reads: readonly string[] = [], proxyPort?: number): Promise<readonly string[]> {
    const sandbox = this.ctx.get('sandbox' as never) as unknown as
      | { confineReading?(argv: readonly string[], policy: { mode: 'workspace-write'; workspaceRoot: string }, reads: readonly string[], home?: string, options?: { proxyPort?: number }): Promise<{ argv: readonly string[] }>; canLockNetwork?(): boolean }
      | undefined
    if (sandbox?.confineReading === undefined) throw new Error('the command sandbox is not available, and a local MCP server runs only confined')
    const locked = proxyPort !== undefined && sandbox.canLockNetwork?.() === true
    if (proxyPort !== undefined && !locked) this.ctx.logger('ops-projects').warn('project %s: %s declares network: proxy, which cannot be enforced here; it runs with the network (argus doctor)', config.id, name)
    return (await sandbox.confineReading(argv, { mode: 'workspace-write', workspaceRoot: config.cwd }, [...(server.extension === undefined ? [] : [server.extension.dir]), ...reads], this.mcpHomeOf(config.id, name), locked ? { proxyPort } : {})).argv
  }

  /**
   * Empty a local MCP server's home: a login gone wrong, a broken cache. An idle agent is
   * let go first, so the server is not running; the project's next message starts it
   * afresh, in the same conversation.
   *
   * @param projectId the project.
   * @param server the server's name.
   * @returns `busy` while the project is in a run: nothing is touched.
   */
  async resetMcpHome(projectId: string, server: string): Promise<'reset' | 'busy'> {
    const existing = this.live.get(projectId)
    if (existing !== undefined) {
      if (existing.runId !== undefined || existing.handle.agent.status === 'running') return 'busy'
      await existing.handle.dispose()
    }
    rmSync(this.mcpHomeOf(projectId, server), { recursive: true, force: true })
    this.store.audit.record({ actor: 'admin', action: 'mcp.reset', target: projectId, details: { server } }, Date.now())
    return 'reset'
  }

  /**
   * A local MCP server's own home: `state/<project>/mcp/<server>/`, outside the project's
   * folder, so the agent's shell cannot read the logins and caches it keeps there.
   *
   * @param projectId the project.
   * @param server the server's name.
   * @returns the folder (made when the server starts).
   */
  mcpHomeOf(projectId: string, server: string): string {
    return join(this.stateRoot, projectId, 'mcp', server)
  }

  /**
   * Replace each `${NAME}` in the values with the credential of that name: the
   * environment, a key saved with `/key NAME value`, or a `.env` file.
   *
   * @param values the values as configured.
   * @returns the values with every reference filled in.
   * @throws {Error} naming a reference that is not set, so no server starts with half a secret.
   */
  private async expand(values: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    const credentials = this.ctx.get('credentials' as never) as unknown as { resolve(ref: unknown): Promise<{ value: string } | undefined> } | undefined
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      let filled = value
      for (const [reference, name] of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        // A git token is for Argus's own git, on its own remote: never handed to a server.
        if (isGitTokenName(name as string)) throw new Error(`\${${name}} is a git token, which only Argus's git operations may use`)
        if (isMailSecretName(name as string)) throw new Error(`\${${name}} is a mail account, which only Argus's send_mail may use`)
        if (isOAuthSecretName(name as string)) throw new Error(`\${${name}} is an OAuth grant, which only Argus's proxy may use`)
        // Not a secret: the egress proxy's address, for a browser's --proxy-server.
        if (name === EGRESS_PROXY_NAME) {
          filled = filled.replace(reference, await this.egress.url())
          continue
        }
        // Without the credentials service (a bare composition) only the environment is read.
        const secret =
          credentials === undefined
            ? process.env[name as string]
            : isCredentialRefName(name as string)
              ? (await credentials.resolve(credentialRef(name as string)))?.value
              : undefined
        if (secret === undefined) throw new Error(`\${${name}} is not set (send /key ${name} <value>, or set it in the environment)`)
        filled = filled.replace(reference, () => secret)
      }
      out[key] = filled
    }
    return out
  }

  /** The agent options a project runs with. */
  private agentOptions(config: ProjectConfig): { provider: string; model: string; maxTokens?: number } {
    const ref = projectModelRef(config)
    return {
      provider: ref.provider,
      model: ref.model,
      maxTokens: config.limits.max_tokens_per_request,
    }
  }

  /**
   * A health report.
   *
   * `degraded` when an agent is live but its project has no session recorded, which
   * means the store and the live map have diverged — a state that would make a
   * restart lose track of a running project.
   *
   * @returns the report.
   */
  health(): ServiceHealth {
    // Only a project's session is recorded; the front desk and tasks have none.
    const all = this.listLive()
    const live = all.filter((entry) => entry.target.kind === 'project')
    const recorded = new Set(this.store.projects.list().map((row) => row.session_id).filter((id): id is string => id !== null))
    const unrecorded = live.filter((entry) => !recorded.has(entry.sessionId)).map((entry) => entry.sessionId)
    const details: Record<string, unknown> = {
      liveAgents: all.length,
      running: all.filter((entry) => entry.status === 'running').length,
      projects: this.configuredIds().length,
    }
    if (unrecorded.length > 0) {
      return { status: 'degraded', details: { ...details, reason: 'a live agent has no recorded session', unrecorded } }
    }
    const invalid = this.invalidProjects()
    if (invalid.length > 0) {
      // Degraded, not down: every other project still runs.
      return {
        status: 'degraded',
        details: {
          ...details,
          reason: `${invalid.length} project file(s) invalid and ignored: ${invalid.map((p) => p.id).join(', ')}`,
          invalid,
        },
      }
    }
    return { status: 'ok', details }
  }

  /**
   * Create an ephemeral agent for a one-off task or the orchestrator.
   *
   * @param options what to create.
   * @returns the agent.
   */
  /**
   * The working directory of a one-off task: `<scratch>/<runId>`. Known before the task
   * runs, so a file sent with it can be put where the task will find it.
   *
   * @param runId the task's run id (`adhoc.runId`).
   * @returns the directory.
   */
  taskDirOf(runId: string): string {
    return join(this.scratchDir, runId)
  }

  /**
   * The one-off tasks a person started whose agent is alive: each takes a follow-up in
   * the same conversation, until it is closed or idle for a day, or Argus restarts.
   *
   * @returns the sessions, most recently active first.
   */
  sessions(): TaskSession[] {
    return [...this.live.values()]
      .filter((entry) => entry.owner.kind === 'adhoc' && entry.owner.runId.startsWith(SESSION_PREFIX))
      .map((entry) => ({ id: (entry.owner as { runId: string }).runId, sessionId: entry.handle.agent.id as string, lastActive: entry.lastActive, running: entry.handle.agent.status === 'running' }))
      .sort((a, b) => b.lastActive - a.lastActive)
  }

  /**
   * Close a session: its agent goes, and its folder with the files it made.
   *
   * @param id the session (the task's run id).
   * @param actor who asked.
   * @returns whether there was such a session, or its folder.
   */
  async closeSession(id: string, actor = 'system'): Promise<boolean> {
    if (!id.startsWith(SESSION_PREFIX) || id.includes('/') || id.includes('..')) return false
    const key = ownerKey(adhocOwner(id))
    const entry = this.live.get(key)
    if (entry !== undefined) await entry.handle.dispose()
    const dir = this.taskDirOf(id)
    const existed = entry !== undefined || existsSync(dir)
    rmSync(dir, { recursive: true, force: true })
    this.closedSessions.add(id)
    if (existed) this.store.audit.record({ actor, action: 'session.closed', target: id, details: {} }, Date.now())
    return existed
  }

  /**
   * Whether a session existed and is gone: closed, idle for a day, or left by an earlier
   * process (its folder is there, its agent is not). What it remembered is gone with it.
   *
   * @param id the session.
   */
  sessionEnded(id: string): boolean {
    if (this.live.has(ownerKey(adhocOwner(id)))) return false
    return this.closedSessions.has(id) || (id.startsWith(SESSION_PREFIX) && !id.includes('/') && existsSync(this.taskDirOf(id)))
  }

  /**
   * Close the sessions idle longer than `idleMs`, and remove what earlier processes left
   * of theirs (a folder whose agent is gone).
   *
   * @param idleMs how long a session may wait for a follow-up.
   * @param now the current time.
   * @returns how many were closed.
   */
  async closeIdleSessions(idleMs: number, now = Date.now()): Promise<number> {
    let closed = 0
    for (const session of this.sessions()) {
      if (!session.running && now - session.lastActive > idleMs && (await this.closeSession(session.id))) closed++
    }
    const live = new Set(this.sessions().map((session) => session.id))
    let names: string[] = []
    try {
      names = readdirSync(this.scratchDir)
    } catch {
      return closed
    }
    for (const name of names.filter((each) => each.startsWith(SESSION_PREFIX) && !live.has(each))) {
      try {
        if (now - statSync(join(this.scratchDir, name)).mtimeMs > idleMs && (await this.closeSession(name))) closed++
      } catch {
        // Gone meanwhile.
      }
    }
    return closed
  }

  async createEphemeral(options: EphemeralOptions): Promise<Agent> {
    const owner = options.kind === 'adhoc' ? adhocOwner(options.runId) : orchestratorOwner()
    const key = ownerKey(owner)
    const existing = this.live.get(key)
    if (existing !== undefined) return existing.handle.agent

    const cwd = options.cwd ?? (options.kind === 'adhoc' ? this.taskDirOf(options.runId) : join(this.scratchDir, 'orchestrator'))
    mkdirSync(cwd, { recursive: true })

    const handle = await this.ctx.agents.create({
      sessionId: randomUUID() as SessionId,
      meta: { cwd, ...(options.preset !== null && options.preset !== undefined ? { agentPreset: options.preset } : {}) },
      agentOptions: { provider: options.model.provider, model: options.model.model },
      setup: async (agentCtx, agent) => {
        if (options.preset !== null && options.preset !== undefined) {
          await this.ctx.agentPresets.mount(agentCtx, options.preset)
        }
        if (options.kind === 'adhoc') hideTools(agentCtx, hiddenTools(taskToolPolicy('deny')))
        await options.setup?.(agentCtx, agent)
      },
    })

    this.adopt(key, this.targetOf(owner), owner, handle)
    return handle.agent
  }

  /** The target descriptor for an owner. */
  private targetOf(owner: Owner): AgentTarget {
    switch (owner.kind) {
      case 'project':
        return { kind: 'project', projectId: owner.projectId }
      case 'adhoc':
        return { kind: 'adhoc', runId: owner.runId }
      case 'orchestrator':
        return { kind: 'orchestrator' }
    }
  }

  /** Register a live agent and wire its events. */
  private adopt(key: string, _target: AgentTarget, owner: Owner, handle: AgentHandle, config?: ProjectConfig): void {
    const sessionId = handle.agent.id as string
    const entry: LiveAgent = {
      target: this.targetOf(owner),
      owner,
      handle,
      runId: undefined,
      runEvents: [],
      producing: false,
      ...(config === undefined ? {} : { config, authEpoch: this.authEpochs.get(config.id) ?? 0, mailboxEpoch: this.mailboxEpoch }),
      lastActive: Date.now(),
    }
    this.live.set(key, entry)
    this.entryBySession.set(sessionId, entry)
    this.ownership.register(sessionId, owner)
    // A session registered with a run that arrived before it (a meter that saw
    // usage first) picks it up now.
    const pendingRun = this.ownership.get(sessionId)?.runId
    if (pendingRun !== undefined) entry.runId = pendingRun

    const dispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
      this.live.delete(key)
      this.entryBySession.delete(sessionId)
      this.ownership.unregister(sessionId)
      await dispose()
    }
  }

  // ── delivery (governor only) ─────────────────────────────────────────────

  /**
   * Deliver content to an agent and open a run.
   *
   * **Governor only.** Requires the capability token from
   * {@link claimDelivery}; any other caller gets `GOVERNOR_REQUIRED`.
   *
   * @param capability the governor's token.
   * @param target what to deliver to.
   * @param content the content blocks, forwarded verbatim.
   * @param options the run id and the message source.
   * @returns whether the message queued behind a running turn.
   * @throws {OpsError} `GOVERNOR_REQUIRED` without the token.
   */
  async deliver(
    capability: Capability,
    target: AgentTarget,
    content: readonly ContentBlockLike[],
    options: { runId: string; source?: 'channel' | 'scheduler' | 'orchestrator' },
  ): Promise<DeliverResult> {
    this.issuer.assertCapability(capability, 'ops-projects.deliver')

    const key = this.keyOf(target)
    const entry = this.live.get(key)
    if (entry === undefined) {
      throw new OpsError('PROJECT_NOT_FOUND', `no live agent for ${key}`, { target: key })
    }

    const agent = entry.handle.agent
    const wasRunning = agent.status === 'running'

    // Open the run before the message lands, so a status transition that races
    // the delivery still finds a run to close.
    entry.lastActive = Date.now()
    if (entry.runId === undefined) {
      entry.runId = options.runId
      entry.runEvents = []
      entry.producing = false
      this.ownership.setRun(agent.id as string, options.runId)
    }

    agent.followup({
      id: randomUUID() as never,
      role: 'user',
      content: content as never,
      source: { kind: options.source ?? 'channel' } as never,
    })

    return { queued: wasRunning, sessionId: agent.id as string }
  }

  /**
   * Cancel a session's current turn, by session id.
   *
   * The governor holds session ids, not targets, so this is the entry point its
   * kill switch and its `stop()` use. A subagent's id resolves to its root, so
   * cancelling a child cancels the project turn it belongs to.
   *
   * @param sessionId the session.
   * @returns whether a live agent was found and cancelled.
   */
  cancelSession(sessionId: string): boolean {
    const root = this.ownership.rootOf(sessionId, (id) => this.parentSessionOf(id)) ?? sessionId
    const entry = this.entryBySession.get(root)
    if (entry === undefined) return false
    entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    if (entry.owner.kind === 'project') this.host.stop(entry.owner.projectId, 'cancelled')
    return true
  }

  /**
   * Cancel an agent's current turn.
   *
   * `keepInbox: true` preserves queued work, so a cancel stops the turn without
   * discarding messages that have not started.
   *
   * @param target what to cancel.
   * @returns whether a live agent was cancelled.
   */
  cancel(target: AgentTarget): boolean {
    const entry = this.live.get(this.keyOf(target))
    if (entry === undefined) return false
    entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    if (target.kind === 'project') this.host.stop(target.projectId, 'cancelled')
    return true
  }

  /**
   * Dispose a project's agent and start a fresh session next time.
   *
   * The old session id is archived in the audit log, so a reset is visible
   * rather than a silent loss.
   *
   * @param projectId the slug.
   * @param actor who asked.
   */
  async reset(projectId: string, actor = 'system'): Promise<void> {
    const entry = this.live.get(projectId)
    const previous = this.store.projects.get(projectId)?.session_id ?? null
    if (entry !== undefined) {
      this.live.delete(projectId)
      this.entryBySession.delete(entry.handle.agent.id as string)
      await entry.handle.dispose()
    }
    this.store.projects.setSession(projectId, null, Date.now())
    this.store.audit.record(
      { actor, action: 'project.reset', target: projectId, details: { previousSession: previous } },
      Date.now(),
    )
  }

  // ── run tracking ─────────────────────────────────────────────────────────

  /**
   * Whether a target's agent is running.
   * @param target the target.
   * @returns whether it is live and running.
   */
  isRunning(target: AgentTarget): boolean {
    const entry = this.live.get(this.keyOf(target))
    return entry !== undefined && entry.handle.agent.status === 'running'
  }

  /**
   * The owner of a session, walking parents for a subagent.
   *
   * @param sessionId the session.
   * @returns the owner, or `undefined` when the session is unknown.
   */
  ownerOf(sessionId: string): Owner | undefined {
    return this.ownership.resolve(sessionId, (id) => this.parentSessionOf(id))?.owner
  }

  /**
   * The root session a session resolves to.
   *
   * The meter records usage under the ROOT session, so a subagent's requests are
   * attributed to the project rather than appearing to come from nowhere. The
   * fallback to the session's own id means a session with no registered root —
   * one from another plugin — is still metered, under itself.
   *
   * @param sessionId the session.
   * @returns the root session id.
   */
  rootSessionOf(sessionId: string): string {
    return this.ownership.rootOf(sessionId, (id) => this.parentSessionOf(id)) ?? sessionId
  }

  /**
   * The run a session's usage belongs to.
   * @param sessionId the session.
   * @returns the run id, or `undefined`.
   */
  runOf(sessionId: string): string | undefined {
    return this.ownership.resolve(sessionId, (id) => this.parentSessionOf(id))?.runId
  }

  /** Read a session's durable parent header, when the session is live. */
  private parentSessionOf(sessionId: string): string | undefined {
    const session = this.ctx.sessions.get(sessionId as SessionId)
    return session?.header.parentSession as string | undefined
  }

  /**
   * Record a parent link for an in-process subagent.
   *
   * Called from the `agent/created` listener when a child appears with an owner.
   *
   * @param childSessionId the child session.
   * @param parentSessionId the parent session.
   */
  linkSubagent(childSessionId: string, parentSessionId: string): void {
    this.ownership.linkChild(childSessionId, parentSessionId)
  }

  /**
   * The live agent for a target.
   * @param target the target.
   * @returns the agent, or `undefined`.
   */
  agentFor(target: AgentTarget): Agent | undefined {
    return this.live.get(this.keyOf(target))?.handle.agent
  }

  /** Every live agent's target and status, for diagnostics. */
  listLive(): Array<{ target: AgentTarget; sessionId: string; status: string; runId: string | undefined }> {
    return [...this.live.values()].map((entry) => ({
      target: entry.target,
      sessionId: entry.handle.agent.id as string,
      status: entry.handle.agent.status,
      runId: entry.runId,
    }))
  }

  // ── run output ───────────────────────────────────────────────────────────

  /**
   * Observe one session event, for run-output extraction.
   *
   * Called by the plugin's `session/event` listener. It accumulates the events a
   * run produced so that, when the run ends, the final assistant content can be
   * extracted without re-reading the whole log.
   *
   * @param sessionId the session the event came from.
   * @param event the event.
   */
  observe(sessionId: string, event: SessionEvent): void {
    const entry = this.entryForSession(sessionId)
    if (entry === undefined || entry.runId === undefined) return
    entry.runEvents.push(event)
    if (event.type === 'assistant/message') entry.producing = true
  }

  /**
   * Find the live entry a session belongs to.
   *
   * `live` is keyed by the TARGET (a project id, an owner key), not by session
   * id, so the lookup goes through the ownership map: resolve the session to its
   * root, then map that root session back to its entry. The index is what makes
   * this O(1) rather than a scan of every live agent.
   */
  private entryForSession(sessionId: string): LiveAgent | undefined {
    const bySession = this.entryBySession.get(sessionId)
    if (bySession !== undefined) return bySession

    // A subagent is not in the index; walk to the root session, which is.
    const root = this.ownership.rootOf(sessionId, (id) => this.parentSessionOf(id))
    return root === undefined ? undefined : this.entryBySession.get(root)
  }

  /** Live entries indexed by their root session id. */
  private readonly entryBySession = new Map<string, LiveAgent>()

  /**
   * Close a run and emit its output.
   *
   * @param sessionId the session that went idle. The live map is keyed by the
   *   target, so the entry is found by walking to the session's root — the same
   *   path `ownerOf` takes.
   * @returns whether a run was closed.
   */
  finishRun(sessionId: string): boolean {
    const entry = this.entryForSession(sessionId)
    if (entry === undefined || entry.runId === undefined) return false

    const runId = entry.runId
    const events = entry.runEvents
    const answer = runAnswer(events)
    // ponytail: the joined answer is text only, so an image in those messages is dropped; keep blocks if agents send images.
    const content = answer === undefined ? (finalAssistantOutput(events) ?? []) : [{ type: 'text', text: answer }]
    const owner = entry.owner
    const rootSession = entry.handle.agent.id as string
    entry.runId = undefined
    entry.runEvents = []
    entry.producing = false
    this.ownership.clearRun(rootSession)
    // A delegated agent still working for the run stops with it.
    if (owner.kind === 'project') this.host.stop(owner.projectId, 'the run ended')

    // What the run did, for /log. A trail is a convenience: failing to write it must
    // not lose the run's output.
    try {
      const reply = (content as ReadonlyArray<{ type?: string; text?: string }>)
        .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
        .join('\n')
      this.store.audit.record({ actor: 'agent', action: RUN_TRAIL_ACTION, target: `run:${runId}`, details: { ...runTrail(events, reply) } }, Date.now())
    } catch (error) {
      this.ctx.logger('ops-projects').warn('could not record the trail of run %s: %s', runId, error instanceof Error ? error.message : String(error))
    }

    this.ctx.emit('ops/run-output', {
      owner,
      sessionId: rootSession,
      runId,
      content: content as unknown as readonly ContentBlockLike[],
    })
    return true
  }

  // ── teardown ─────────────────────────────────────────────────────────────

  /** Dispose every live agent. */
  async disposeAll(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.issuer.revokeAll()
    const handles = [...this.live.values()].map((entry) => entry.handle)
    this.live.clear()
    this.entryBySession.clear()
    this.ownership.clear()
    await Promise.allSettled(handles.map((handle) => handle.dispose()))
    this.host.closeAll()
  }

  /**
   * Answer one type of host-channel message (`ask`, `step`, `usage`) from the extension
   * servers that declared it. The plugin that owns the decision calls it, as an effect.
   *
   * @param type the message type.
   * @param handler what answers it; it learns the project and run from the socket.
   * @returns what removes it.
   */
  hostHandle(type: string, handler: HostHandler): () => void {
    return this.host.handle(type, handler)
  }

  /**
   * Tell a project's connected extension servers to stop what they are doing.
   *
   * @param projectId the project.
   * @param reason why (cancel, a limit, a loop, the run's end).
   * @returns how many were told.
   */
  hostStop(projectId: string, reason: string): number {
    return this.host.stop(projectId, reason)
  }

  /** A server's open host channel, or undefined: for tests. */
  hostEndpointOf(projectId: string, server: string): { readonly dir: string; readonly socket: string } | undefined {
    const endpoint = this.host.endpointOf(projectId, server)
    return endpoint === undefined ? undefined : { dir: endpoint.dir, socket: endpoint.socket }
  }

  private keyOf(target: AgentTarget): string {
    switch (target.kind) {
      case 'project':
        return target.projectId
      case 'adhoc':
        return ownerKey(adhocOwner(target.runId))
      case 'orchestrator':
        return 'orchestrator'
    }
  }
}

/**
 * The message a request for an invalid project is refused with.
 *
 * @param project the invalid project.
 * @returns the message: which file, what is wrong, how to bring it back.
 */
export function invalidMessage(project: InvalidProject): string {
  return (
    `project "${project.id}" is ignored: ${project.path} does not validate.\n` +
    `${project.reason}\n` +
    'Fix the file, then send /reload.'
  )
}

/**
 * Take tools out of what an agent's model is offered.
 *
 * Only names registered globally are passed: `restrict()` throws on a name it does
 * not know, and a composition without, say, the web plugin has no `web_fetch` to
 * hide. A scope's own registrations are exempt, which no group names.
 *
 * @param agentCtx the agent's context, inside its `setup`.
 * @param names the tools to hide.
 */
function hideTools(agentCtx: Context, names: readonly string[]): void {
  const present = names.filter((name) => agentCtx.tools.get(name) !== undefined)
  if (present.length === 0) return
  const lift = agentCtx.tools.restrict({ deny: present })
  agentCtx.effect(() => lift)
}

/**
 * What a project's agent is built from: its model, preset, hidden tools, MCP servers,
 * extensions and memory. The rest (approvals, budget, web hosts, a tool's exception) is
 * read at each use, so a change to it leaves the live agent alone.
 */
function builtFrom(config: ProjectConfig): Record<string, unknown> {
  return {
    cwd: config.cwd,
    model: `${config.provider}/${config.model}`,
    max_tokens: config.limits.max_tokens_per_request,
    preset: config.preset,
    tools: hiddenTools(config.tools),
    mcp: config.mcp,
    extensions: config.extensions,
    memory: config.memory,
  }
}

/**
 * What a project's agent was built from that changed since.
 * @param before the configuration it was built from, if known.
 * @param after the current one.
 * @returns the changed keys of {@link builtFrom}, sorted.
 */
function changedKeys(before: ProjectConfig | undefined, after: ProjectConfig): string[] {
  if (before === undefined) return []
  const [was, now] = [builtFrom(before), builtFrom(after)]
  return Object.keys(now).filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key])).sort()
}

/** nodemailer, for a real account. */
const nodemailerTransport: MailTransport = (account) => createTransport(transportOptions(account) as never) as unknown as ReturnType<MailTransport>
