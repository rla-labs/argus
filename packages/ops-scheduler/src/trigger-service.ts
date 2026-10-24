// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/scheduler/trigger-service` — `ctx.opsScheduler.triggers`.
 *
 * Every minute, the triggers whose check is due are checked, one after another. A mail
 * trigger signs in to the project's mailbox, asks for what came after its cursor, filters
 * on the headers, and signs out; for each match it moves its cursor first, then submits
 * a run to the governor, as a scheduled run. A crash between the two loses that mail
 * rather than running it twice.
 *
 * @module @argus-agent/scheduler/trigger-service
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { decodeAddress, encodeAddress, type ChannelAddress, type TimerHandle } from '@argus-agent/types'
import type { OpsStore, TriggerRow } from '@argus-agent/store'
import type { MailCursor, MailSummary, OpsProjects } from '@argus-agent/projects'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import type { CommandContext, CommandResult } from '@argus-agent/commands'
import { mailMatches, nextCheck, parseMailTrigger, runsThisHour, triggerPrompt, type MailEvent, type MailTriggerConfig } from './triggers.js'

/** What the trigger service needs. */
export interface TriggerOptions {
  readonly store: OpsStore
  readonly projects: OpsProjects
  readonly governor: OpsGovernor
  readonly channel: OpsChannel
  readonly now: () => number
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle
  readonly clearTimeout: (handle: TimerHandle) => void
}

/** What a check found, or would start. */
export interface CheckResult {
  readonly ok: boolean
  /** The runs started, or (for a dry check) that would start. */
  readonly started: readonly MailEvent[]
  /** Matches left for the next hour by `max_runs_per_hour`. */
  readonly waiting: number
  readonly error?: string
}

/** Mails one check reads at most. */
const PER_CHECK = 50
/** Failures in a row before the trigger's chat is told. */
const FAILURES_TO_TELL = 3

/** The triggers. */
export class OpsTriggers {
  private timer: TimerHandle | undefined
  private stopped = false
  private running = false
  /** Triggers that were told their hour's runs were used, until the hour passes. */
  private readonly toldLimit = new Map<string, number>()

  constructor(
    private readonly ctx: Context,
    private readonly options: TriggerOptions,
  ) {}

  /** Check what is due every minute. */
  start(): void {
    this.stopped = false
    const loop = (): void => {
      if (this.stopped) return
      this.timer = this.options.setTimeout(() => {
        void this.tick().finally(loop)
      }, 60_000)
    }
    loop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.options.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Check every due trigger, one after another. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const row of this.options.store.triggers.due(this.options.now())) await this.check(row)
    } finally {
      this.running = false
    }
  }

  list(projectId?: string): TriggerRow[] {
    return this.options.store.triggers.list().filter((row) => projectId === undefined || row.project_id === projectId)
  }

  get(id: string): TriggerRow | undefined {
    return this.options.store.triggers.get(id)
  }

  /**
   * Add a mail trigger to a project.
   * @returns its id, or what is wrong.
   */
  add(projectId: string, input: Record<string, unknown>, replyTo: ChannelAddress, id?: string): { ok: true; id: string } | { ok: false; message: string } {
    const project = this.options.projects.configOf(projectId)
    if (project === undefined) return { ok: false, message: `No project "${projectId}".` }
    const parsed = parseMailTrigger(input)
    if (!parsed.ok) return parsed
    if (!project.mail.read_folders.includes(parsed.config.folder)) return { ok: false, message: `${projectId} reads only ${project.mail.read_folders.join(', ')} (mail.read_folders), not "${parsed.config.folder}".` }
    const triggerId = id ?? `trig-${randomUUID().slice(0, 8)}`
    if (this.options.store.triggers.get(triggerId) !== undefined) return { ok: false, message: `A trigger "${triggerId}" already exists.` }
    // The first check comes at once: it only sets where "new" starts.
    this.options.store.triggers.insert({ id: triggerId, project_id: projectId, source: 'mail', config_json: JSON.stringify(parsed.config), reply_chat: encodeAddress(replyTo), next_check_at: this.options.now() }, this.options.now())
    this.ctx.logger('ops-scheduler').info('trigger %s added to %s: mail from %s in %s', triggerId, projectId, parsed.config.from.join(','), parsed.config.folder)
    return { ok: true, id: triggerId }
  }

  remove(id: string): boolean {
    return this.options.store.triggers.delete(id)
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return this.options.store.triggers.setEnabled(id, enabled, this.options.now())
  }

  /** A trigger's settings. */
  configOf(row: TriggerRow): MailTriggerConfig {
    return JSON.parse(row.config_json) as MailTriggerConfig
  }

  /**
   * Check one trigger: start a run for each new matching mail, within its hour's limit.
   * @param dry only say what would start: nothing moves, nothing starts.
   */
  async check(row: TriggerRow, dry = false): Promise<CheckResult> {
    const now = this.options.now()
    const config = this.configOf(row)
    const failed = (error: string): CheckResult => {
      if (dry) return { ok: false, started: [], waiting: 0, error }
      const failures = row.failures + 1
      this.options.store.triggers.checked(row.id, now, nextCheck(config.every_minutes, failures, now), error, failures, null)
      this.ctx.logger('ops-scheduler').warn('trigger %s: %s', row.id, error)
      if (failures === FAILURES_TO_TELL) this.tell(row, `Trigger ${row.id} of ${row.project_id} failed ${failures} times in a row: ${error}. It keeps trying, less often. /trigger list`)
      return { ok: false, started: [], waiting: 0, error }
    }
    const project = this.options.projects.configOf(row.project_id)
    if (project === undefined) return failed('the project is gone')
    if (!project.mail.read_folders.includes(config.folder)) return failed(`the project no longer reads ${config.folder} (mail.read_folders)`)

    const cursor = row.cursor_json === null ? null : (JSON.parse(row.cursor_json) as MailCursor)
    const read = await this.options.projects.mailbox.newMail(row.project_id, config.folder, cursor, PER_CHECK)
    if (!read.ok) return failed(read.message)

    let { recent, room } = runsThisHour(JSON.parse(row.runs_json) as number[], config.max_runs_per_hour, now)
    let last = read.cursor.lastUid
    const started: MailEvent[] = []
    let waiting = 0
    let error: string | null = null
    for (const summary of read.mails) {
      const mail = eventOf(config.folder, summary)
      if (!mailMatches(config, mail)) {
        last = mail.uid
        continue
      }
      if (room === 0) {
        // Left for the next hour: the cursor stays before it.
        waiting = read.mails.filter((entry) => entry.uid >= mail.uid && mailMatches(config, eventOf(config.folder, entry))).length
        break
      }
      if (dry) {
        started.push(mail)
        room -= 1
        last = mail.uid
        continue
      }
      // The cursor moves first: a crash now loses this mail rather than running it twice.
      const before = { cursor: JSON.stringify({ ...read.cursor, lastUid: last }), runs: JSON.stringify(recent) }
      recent = [...recent, now]
      this.options.store.triggers.setCursor(row.id, JSON.stringify({ ...read.cursor, lastUid: mail.uid }), JSON.stringify(recent))
      try {
        this.options.governor.submit({
          source: 'scheduler',
          target: { projectId: row.project_id },
          content: [{ type: 'text', text: triggerPrompt(config, mail) }],
          priority: 1,
          ...(safeDecode(row.reply_chat) === undefined ? {} : { replyTo: safeDecode(row.reply_chat) }),
        })
      } catch (refused) {
        // Paused, over budget: the mail waits for a check that can start it.
        this.options.store.triggers.setCursor(row.id, before.cursor, before.runs)
        error = `a run could not start: ${(refused as Error).message}`
        break
      }
      started.push(mail)
      room -= 1
      last = mail.uid
    }
    if (dry) return { ok: true, started, waiting }

    if (error === null) this.options.store.triggers.setCursor(row.id, JSON.stringify({ ...read.cursor, lastUid: last }), JSON.stringify(recent))
    this.options.store.triggers.checked(row.id, now, nextCheck(config.every_minutes, 0, now), error, 0, started.length > 0 ? now : null)
    for (const mail of started) this.ctx.logger('ops-scheduler').info('trigger %s started a run in %s for mail %s', row.id, row.project_id, mail.id)
    if (waiting > 0 && (this.toldLimit.get(row.id) ?? 0) < now - 60 * 60 * 1000) {
      this.toldLimit.set(row.id, now)
      this.tell(row, `Trigger ${row.id} of ${row.project_id} started its ${config.max_runs_per_hour} run(s) for this hour; ${waiting} matching mail(s) wait for the next one.`)
    }
    return { ok: error === null, started, waiting, ...(error === null ? {} : { error }) }
  }

  // ── `/trigger` ───────────────────────────────────────────────────────────

  /** The `/trigger` command. */
  async run(line: string, context: CommandContext): Promise<CommandResult> {
    const [verb = 'list', ...rest] = line.trim().split(/\s+/).filter((part) => part.length > 0)
    const id = rest[0]
    switch (verb.toLowerCase()) {
      case 'list':
        return this.listText(id)
      case 'add': {
        const parsed = parseTriggerAdd(line.trim().slice(3))
        if (!parsed.ok) return { error: true, text: parsed.message }
        const added = this.add(parsed.projectId, parsed.input, context.address)
        if (!added.ok) return { error: true, text: added.message }
        return { text: `Trigger ${added.id} added to ${parsed.projectId}. Its first check starts from now: mail that is already there does not count.` }
      }
      case 'remove':
      case 'enable':
      case 'disable':
      case 'check': {
        const row = id === undefined ? undefined : this.get(id)
        if (row === undefined) return { error: true, text: id === undefined ? `Which trigger? /trigger ${verb} <id>` : `No trigger "${id}". /trigger list` }
        if (verb === 'remove') return this.remove(row.id) ? { text: `Removed ${row.id}.` } : { error: true, text: `No trigger "${row.id}".` }
        if (verb !== 'check') {
          this.setEnabled(row.id, verb === 'enable')
          return { text: `${verb === 'enable' ? 'Enabled' : 'Disabled'} ${row.id}.` }
        }
        if (row.cursor_json === null) return { text: `${row.id} has not checked yet: its first check sets where new mail starts.` }
        const result = await this.check(row, true)
        if (!result.ok) return { error: true, text: `${row.id} cannot check: ${result.error ?? 'unknown'}` }
        return {
          text:
            result.started.length === 0
              ? `${row.id}: no new matching mail; nothing would start.`
              : `${row.id} would start ${result.started.length} run(s), for:\n${result.started.map((mail) => `${mail.id}  ${mail.from}  ${JSON.stringify(mail.subject)}`).join('\n')}${result.waiting > 0 ? `\n${result.waiting} more would wait for the next hour.` : ''}`,
        }
      }
      default:
        return { error: true, text: `Unknown /trigger subcommand "${verb}". Try: /trigger list | add | remove | enable | disable | check` }
    }
  }

  /** `/trigger list [project]`. */
  private listText(projectId?: string): CommandResult {
    const rows = this.list(projectId)
    if (rows.length === 0) return { text: `No triggers${projectId === undefined ? '' : ` in ${projectId}`}. Add one: /trigger add <project> mail from:<address> "<prompt>"` }
    const now = this.options.now()
    const when = (ms: number | null) => (ms === null ? '-' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`)
    return {
      text: rows
        .map((row) => {
          const config = this.configOf(row)
          const runs = runsThisHour(JSON.parse(row.runs_json) as number[], config.max_runs_per_hour, now).recent.length
          return [
            `${row.id}  ${row.project_id}  ${row.enabled ? 'on' : 'off'}  mail from ${config.from.join(',')}${config.subject === null ? '' : ` subject ~ ${JSON.stringify(config.subject)}`} in ${config.folder}, every ${config.every_minutes} min`,
            `  last check ${when(row.last_check_at)}, last match ${when(row.last_match_at)}, runs this hour ${runs}/${config.max_runs_per_hour}${row.last_error === null ? '' : `, failing (${row.failures}x): ${row.last_error}`}`,
          ].join('\n')
        })
        .join('\n'),
    }
  }

  /** Tell the trigger's chat something. */
  private tell(row: TriggerRow, text: string): void {
    const address = safeDecode(row.reply_chat)
    if (address === undefined) return
    void this.options.channel.send(address, { text }).catch(() => undefined)
  }
}

/** A mail summary as a trigger's event. */
function eventOf(folder: string, mail: MailSummary): MailEvent {
  return { id: `${folder}:${mail.uid}`, uid: mail.uid, address: mail.address, from: mail.from, subject: mail.subject, date: mail.date }
}

function safeDecode(value: string): ChannelAddress | undefined {
  try {
    return decodeAddress(value)
  } catch {
    return undefined
  }
}

/**
 * Parse `/trigger add <project> mail from:<a>[,<b>] [subject:<text>|"<text>"] [folder:<f>]
 * [every:<min>] [per_hour:<n>] "<prompt>"`.
 */
export function parseTriggerAdd(rest: string): { ok: true; projectId: string; input: Record<string, unknown> } | { ok: false; message: string } {
  const usage = 'Usage: /trigger add <project> mail from:<address>[,<address>] [subject:<text>] [folder:<folder>] [every:<minutes>] [per_hour:<n>] "<prompt>"'
  const match = /^(\S+)\s+mail\s+([\s\S]*?)"([^"]+)"\s*$/.exec(rest.trim())
  if (match === null) return { ok: false, message: `${usage}\nThe prompt goes last, in quotes. Only mail triggers exist for now.` }
  const input: Record<string, unknown> = { prompt: match[3] }
  const options = match[2] as string
  for (const option of options.matchAll(/(\w+):(?:'([^']*)'|(\S+))/g)) {
    const [, key, quoted, plain] = option
    const value = quoted ?? plain ?? ''
    if (key === 'from' || key === 'subject' || key === 'folder') input[key] = value
    else if (key === 'every') input['every_minutes'] = Number(value)
    else if (key === 'per_hour') input['max_runs_per_hour'] = Number(value)
    else return { ok: false, message: `Unknown option "${key}". ${usage}` }
  }
  return { ok: true, projectId: match[1] as string, input }
}
