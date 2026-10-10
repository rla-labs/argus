// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web` — the web interface.
 *
 * A dashboard (projects, spending, runs, approvals, schedules), settings and a chat,
 * for one admin on a private network. In 0.3.0 a login comes from Telegram (`/web`),
 * and the chat is a channel adapter whose users are Telegram's. Reads come from the
 * services; every change is a command run as the logged-in person, so the web has
 * no rules of its own (AGENTS.md, rule 4).
 *
 * @module @argus-agent/web
 */
import type { Context } from '@deepseek-ai/cordis'
import { APPROVE, APPROVE_ALL, DENY } from '@argus-agent/approvals-bridge'
import { WebAuth } from './auth.js'
import { webOf, webSchema } from './config.js'
import { overview, settings, type FrontDeskPort, type ProvidersPort, type SchedulePort } from './data.js'
import { startWebServer, type CommandOutcome } from './server.js'
import { WebChannelAdapter } from './web-channel.js'

export * from './auth.js'
export * from './config.js'
export * from './data.js'
export * from './server.js'
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
   * A one-time login link for a person, valid ten minutes.
   *
   * @param userId the person, as Telegram knows them.
   * @returns the link.
   */
  loginLink(userId: string): string
  /** The port the server listens on, once it does. */
  readonly port: number | undefined
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
  const chat = new WebChannelAdapter((chatId) => notify(`chat:${chatId}`))
  const unregister = ctx.opsChannel.register(chat)
  ctx.effect(() => () => void unregister())

  // ── login ────────────────────────────────────────────────────────────────
  const auth = new WebAuth(config.session_hours * 3_600_000)
  const web: { -readonly [K in keyof OpsWeb]: OpsWeb[K] } = {
    loginLink: (userId: string) => `${config.public_url}/login?token=${auth.issueToken(userId)}`,
    port: undefined,
  }
  ctx.provide('opsWeb', web)

  const sources = {
    store: ctx.opsStore,
    meter: ctx.opsMeter,
    governor: ctx.opsGovernor,
    projects: ctx.opsProjects,
    schedules: () => ctx.get('opsScheduler' as never) as unknown as SchedulePort | undefined,
    providers: () => ctx.get('opsProviders' as never) as unknown as ProvidersPort | undefined,
    frontDesk: () => ctx.get('opsOrchestrator' as never) as unknown as FrontDeskPort | undefined,
    now: () => Date.now(),
  }

  const runCommand = async (line: string, session: { userId: string }): Promise<CommandOutcome> => {
    // A confirmation button comes back as its token; it is the `/confirm` command.
    const confirm = /^__confirm:([^:]+):(yes|no)$/.exec(line)
    const out = await ctx.opsCommands.runCommand(confirm === null ? line : `/confirm ${confirm[1]} ${confirm[2]}`, {
      address: { channel: 'web', chatId: session.userId },
      userId: session.userId,
      // Only the admin is given a link (`/web` is admin-only).
      isAdmin: true,
      now: Date.now(),
    })
    return {
      text: out.text,
      error: out.error === true,
      buttons: (out.buttons ?? []).map((button) => ({ label: button.label, command: button.command })),
    }
  }

  try {
    const server = await startWebServer({
      host: config.host,
      port: config.port,
      secure: config.public_url.startsWith('https://'),
      auth,
      sessionHours: config.session_hours,
      chat,
      overview: () => overview(sources),
      settings: () => settings(sources),
      runCommand,
      answerApproval: (approvalId, value, session) =>
        [APPROVE, DENY, APPROVE_ALL].includes(value) &&
        ctx.opsChannel.answerQuestion(`approval:${approvalId}`, value, { address: { channel: 'web', chatId: session.userId }, userId: session.userId }),
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
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
