// == ARGUS AGENT PROJECT ==
/**
 * Mail sent by Argus for a project: `send_mail`.
 *
 * The account (an `smtps://` or `smtp://` URL with its password) is a credential the
 * admin sets with `/mail`, per project or as the default for all; the agent never sees
 * it. A project's file says who may receive (`mail.allowed_recipients`), how many mails a
 * day, and how large the attachments. Every mail is shown to a person before it goes,
 * and what goes is what was shown: the attachments' contents are hashed at the question
 * and checked again when sending.
 *
 * @module @argus-agent/projects/mail
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { isInside } from '@argus-agent/types'

/** Mail accounts' credential names: only `/mail` reads or writes them. */
export const MAIL_SECRET_PREFIX = 'ARGUS_MAIL_'

/** A project's `mail:` block. */
export interface ProjectMail {
  /** The sender; the account's user when unset. */
  readonly from: string | null
  /** Who may receive: exact addresses, or `@domain` for anyone at it. Empty: nobody. */
  readonly allowed_recipients: readonly string[]
  /** Mails sent in any 24 hours. */
  readonly max_per_day: number
  /** The attachments of one mail, together, in MB. */
  readonly max_attachment_mb: number
}

export const MAIL_DEFAULTS: ProjectMail = { from: null, allowed_recipients: [], max_per_day: 20, max_attachment_mb: 20 }

/** Text over this is shown cut in the question; the mail itself is sent whole. */
const SHOWN_TEXT = 3000
const ADDRESS = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/
const DOMAIN = /^@[^@\s<>",;]+\.[^@\s<>",;]+$/

/** Whether a credential name is a mail account's, which nothing else may read or write. */
export function isMailSecretName(name: string): boolean {
  return name.startsWith(MAIL_SECRET_PREFIX)
}

/**
 * The credential a project's mail account is kept under; `ARGUS_MAIL_DEFAULT` for the
 * default. Hashed, like git tokens' names, so any project id fits.
 */
export function mailSecretName(projectId: string | null): string {
  return projectId === null ? `${MAIL_SECRET_PREFIX}DEFAULT` : `${MAIL_SECRET_PREFIX}${createHash('sha256').update(projectId).digest('hex').slice(0, 24).toUpperCase()}`
}

/**
 * A project's `mail:` block, with its defaults.
 * @param value the block, as written.
 * @returns the settings, and what is wrong with it.
 */
export function parseMailBlock(value: unknown): { mail: ProjectMail; issues: Array<{ path: string; message: string }> } {
  const issues: Array<{ path: string; message: string }> = []
  if (value === undefined || value === null) return { mail: MAIL_DEFAULTS, issues }
  if (typeof value !== 'object' || Array.isArray(value)) return { mail: MAIL_DEFAULTS, issues: [{ path: 'mail', message: 'must be a mapping: from, allowed_recipients, max_per_day, max_attachment_mb' }] }
  const block = value as Record<string, unknown>
  for (const key of Object.keys(block)) {
    if (!['from', 'allowed_recipients', 'max_per_day', 'max_attachment_mb'].includes(key)) issues.push({ path: `mail.${key}`, message: 'not a mail setting; use from, allowed_recipients, max_per_day or max_attachment_mb' })
  }
  const from = block['from'] ?? null
  if (from !== null && (typeof from !== 'string' || !ADDRESS.test(from))) issues.push({ path: 'mail.from', message: 'must be an address, e.g. office@example.com' })
  const recipients = block['allowed_recipients'] ?? []
  if (!Array.isArray(recipients) || recipients.some((entry) => typeof entry !== 'string' || !(ADDRESS.test(entry) || DOMAIN.test(entry)))) {
    issues.push({ path: 'mail.allowed_recipients', message: 'must list addresses (ana@example.com) or domains (@example.com)' })
  }
  const count = (key: string, fallback: number, max: number): number => {
    const raw = block[key] ?? fallback
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max) {
      issues.push({ path: `mail.${key}`, message: `must be a whole number from 1 to ${max}` })
      return fallback
    }
    return raw
  }
  return {
    mail: {
      from: typeof from === 'string' ? from : null,
      allowed_recipients: Array.isArray(recipients) ? recipients.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.toLowerCase()) : [],
      max_per_day: count('max_per_day', MAIL_DEFAULTS.max_per_day, 500),
      max_attachment_mb: count('max_attachment_mb', MAIL_DEFAULTS.max_attachment_mb, 50),
    },
    issues,
  }
}

/** A mail account, from its URL. */
export interface MailAccount {
  /** `smtps`: TLS from the start (465); `smtp`: STARTTLS, required (587). */
  readonly secure: boolean
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
}

/**
 * Read an account URL: `smtps://user:password@host[:465]` or `smtp://user:password@host[:587]`.
 * @param text the URL.
 * @returns the account, or why it is not one (never with the password).
 */
export function parseMailAccount(text: string): { ok: true; account: MailAccount } | { ok: false; message: string } {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return { ok: false, message: 'Not a URL. Use smtps://user:password@host:465, or smtp://user:password@host:587 for STARTTLS.' }
  }
  if (url.protocol !== 'smtps:' && url.protocol !== 'smtp:') return { ok: false, message: 'Only smtps:// (TLS) and smtp:// (STARTTLS, required) accounts.' }
  if (url.username === '' || url.password === '') return { ok: false, message: 'The URL needs the user and the password: smtps://user:password@host:465 (a @ in the user is %40).' }
  if (url.hostname === '') return { ok: false, message: 'The URL needs the server\'s host.' }
  if (url.pathname !== '' && url.pathname !== '/') return { ok: false, message: 'The URL takes no path.' }
  const secure = url.protocol === 'smtps:'
  return {
    ok: true,
    account: {
      secure,
      host: url.hostname,
      port: url.port === '' ? (secure ? 465 : 587) : Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    },
  }
}

/** An account as the admin may see it: no password. */
export function describeAccount(account: MailAccount): string {
  return `${account.secure ? 'smtps' : 'smtp (STARTTLS)'}://${account.user}@${account.host}:${account.port}`
}

/**
 * What nodemailer is given for an account: TLS always, certificates checked, 30 s timeouts.
 * @param account the account.
 * @returns the transport options.
 */
export function transportOptions(account: MailAccount): Record<string, unknown> {
  return {
    host: account.host,
    port: account.port,
    secure: account.secure,
    requireTLS: !account.secure,
    auth: { user: account.user, pass: account.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: account.host },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  }
}

/** What `send_mail` is called with. */
export interface MailArgs {
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  readonly text: string
  readonly html?: string
  /** Files in the project's folder, relative to it. */
  readonly attachments: readonly string[]
}

/** One attachment, as read for the question: its hash is checked again at sending. */
export interface MailAttachment {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly sha256: string
}

/** A mail, checked and ready to show and send. */
export interface MailPlan {
  readonly from: string
  readonly args: MailArgs
  readonly attachments: readonly MailAttachment[]
  /** A hash of everything sent: the question pins it. */
  readonly digest: string
}

/** A list argument: an array of strings, or one string with commas. */
function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return items.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * Read `send_mail`'s arguments.
 * @param raw the call's arguments.
 * @returns the arguments, or what is wrong.
 */
export function parseMailArgs(raw: unknown): { ok: true; args: MailArgs } | { ok: false; message: string } {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const args: MailArgs = {
    to: list(record['to']),
    cc: list(record['cc']),
    bcc: list(record['bcc']),
    subject: typeof record['subject'] === 'string' ? record['subject'].trim() : '',
    text: typeof record['text'] === 'string' ? record['text'] : '',
    ...(typeof record['html'] === 'string' && record['html'].length > 0 ? { html: record['html'] } : {}),
    attachments: list(record['attachments']),
  }
  if (args.to.length === 0) return { ok: false, message: 'send_mail needs at least one address in to.' }
  const bad = [...args.to, ...args.cc, ...args.bcc].find((address) => !ADDRESS.test(address))
  if (bad !== undefined) return { ok: false, message: `"${bad}" is not an address: give plain addresses, like ana@example.com.` }
  if (args.subject.length === 0) return { ok: false, message: 'send_mail needs a subject.' }
  if (/[\r\n]/.test(args.subject)) return { ok: false, message: 'The subject is one line.' }
  if (args.text.trim().length === 0) return { ok: false, message: 'send_mail needs the text of the mail.' }
  return { ok: true, args }
}

/** Whether an address is one a project may write to. */
function allowed(address: string, list: readonly string[]): boolean {
  const lower = address.toLowerCase()
  return list.some((entry) => (entry.startsWith('@') ? lower.endsWith(entry) : lower === entry))
}

/**
 * Check a mail against the project's settings and read its attachments.
 *
 * @param cwd the project's folder.
 * @param settings its `mail:` block.
 * @param account the account it sends with.
 * @param args the call's arguments.
 * @param sentToday mails it sent in the last 24 hours.
 * @returns the plan, or why it cannot be sent.
 */
export function planMail(cwd: string, settings: ProjectMail, account: MailAccount, args: MailArgs, sentToday: number): { ok: true; plan: MailPlan } | { ok: false; message: string } {
  if (settings.allowed_recipients.length === 0) return { ok: false, message: 'This project may not send mail to anyone yet: the admin lists who in mail.allowed_recipients of its file (/set <project> mail.allowed_recipients [ana@example.com, @example.com]).' }
  const refused = [...args.to, ...args.cc, ...args.bcc].filter((address) => !allowed(address, settings.allowed_recipients))
  if (refused.length > 0) return { ok: false, message: `Not in mail.allowed_recipients of this project: ${refused.join(', ')}. Nothing was sent; do not try another way to reach them.` }
  if (sentToday >= settings.max_per_day) return { ok: false, message: `This project sent ${sentToday} mail(s) in the last 24 hours, its limit (mail.max_per_day). Nothing was sent.` }

  const root = realpathSync(cwd)
  const attachments: MailAttachment[] = []
  let total = 0
  for (const path of args.attachments) {
    const full = isAbsolute(path) ? path : join(cwd, path)
    let real: string
    try {
      if (lstatSync(full).isSymbolicLink()) return { ok: false, message: `${path} is a link: attach the file itself.` }
      real = realpathSync(full)
    } catch {
      return { ok: false, message: `${path}: no such file in your folder.` }
    }
    if (!isInside(root, real)) return { ok: false, message: `${path} is outside your folder: only files in it can be attached.` }
    const stat = lstatSync(real)
    if (!stat.isFile()) return { ok: false, message: `${path} is not a file.` }
    total += stat.size
    if (total > settings.max_attachment_mb * 1024 * 1024) return { ok: false, message: `The attachments come to more than ${settings.max_attachment_mb} MB (mail.max_attachment_mb). Nothing was sent.` }
    attachments.push({ path: real, name: basename(real), size: stat.size, sha256: createHash('sha256').update(readFileSync(real)).digest('hex') })
  }
  const from = settings.from ?? account.user
  const digest = createHash('sha256').update(JSON.stringify({ from, args, attachments: attachments.map((file) => [file.name, file.sha256]) })).digest('hex')
  return { ok: true, plan: { from, args, attachments, digest } }
}

/** A size for a person. */
function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The mail as the person asked sees it: who, what, and the text.
 * @param plan the plan.
 * @param account the account.
 * @returns the lines.
 */
export function describeMail(plan: MailPlan, account: MailAccount): string {
  const { args } = plan
  const lines = [
    `from: ${plan.from} (via ${account.host})`,
    `to: ${args.to.join(', ')}`,
    ...(args.cc.length > 0 ? [`cc: ${args.cc.join(', ')}`] : []),
    ...(args.bcc.length > 0 ? [`bcc: ${args.bcc.join(', ')}`] : []),
    `subject: ${args.subject}`,
    ...(plan.attachments.length > 0 ? [`attachments: ${plan.attachments.map((file) => `${file.name} (${size(file.size)})`).join(', ')}`] : []),
    ...(args.html === undefined ? [] : ['(also an HTML version of the same text)']),
    '',
    args.text.length > SHOWN_TEXT ? `${args.text.slice(0, SHOWN_TEXT)}\n… (${args.text.length - SHOWN_TEXT} more characters, sent too)` : args.text,
  ]
  return lines.join('\n')
}

/** What a mail account's credential is kept in: dsh's credentials service. */
export interface MailSecrets {
  set(ref: unknown, value: string): Promise<unknown>
  unset(ref: unknown): Promise<unknown>
  resolve(ref: unknown): Promise<{ value: string } | undefined>
}

/** The audit log, as far as mail needs it. */
export interface MailAudit {
  record(entry: { actor: string; action: string; target: string; details: Record<string, unknown> }, ts: number): void
  byAction(action: string, limit: number): ReadonlyArray<{ ts: number; target: string | null; details_json: string | null }>
}

/** Sends one message; nodemailer's transport in production, a fake in a test. */
export type MailTransport = (account: MailAccount) => { sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }> }

/**
 * The mail of every project: accounts, the question's preview, and the sending.
 */
export class ProjectMailer {
  /** The mail each question showed, by project and call: the send must match it. */
  private readonly shown = new Map<string, MailPlan>()

  constructor(
    private readonly secrets: () => MailSecrets | undefined,
    private readonly audit: MailAudit,
    private readonly transport: MailTransport,
    private readonly ref: (name: string) => unknown,
    private readonly now: () => number = Date.now,
  ) {}

  /** Save an account for a project, or the default (`null`). */
  async setAccount(projectId: string | null, url: string): Promise<{ ok: boolean; message: string }> {
    const parsed = parseMailAccount(url)
    if (!parsed.ok) return parsed
    const secrets = this.secrets()
    if (secrets === undefined) return { ok: false, message: 'The credentials store is not available.' }
    await secrets.set(this.ref(mailSecretName(projectId)), url.trim())
    return { ok: true, message: `${projectId ?? 'The default'} mail account: ${describeAccount(parsed.account)}. The password is kept in the credentials store; no project can read it.` }
  }

  /** Forget a project's account, or the default. */
  async removeAccount(projectId: string | null): Promise<boolean> {
    const secrets = this.secrets()
    if (secrets === undefined || (await secrets.resolve(this.ref(mailSecretName(projectId)))) === undefined) return false
    await secrets.unset(this.ref(mailSecretName(projectId)))
    return true
  }

  /** The account a project sends with: its own, else the default. */
  async accountOf(projectId: string | null): Promise<{ account: MailAccount; own: boolean } | undefined> {
    const secrets = this.secrets()
    if (secrets === undefined) return undefined
    for (const [name, own] of [...(projectId === null ? [] : [[mailSecretName(projectId), true] as const]), [mailSecretName(null), false] as const]) {
      const value = (await secrets.resolve(this.ref(name)))?.value
      if (value === undefined) continue
      const parsed = parseMailAccount(value)
      if (parsed.ok) return { account: parsed.account, own: projectId !== null && own }
    }
    return undefined
  }

  /** Mails a project sent in the last 24 hours. */
  sentToday(projectId: string): number {
    const since = this.now() - 24 * 60 * 60 * 1000
    return this.audit.byAction('mail.send', 5000).filter((row) => row.target === projectId && row.ts >= since && (row.details_json ?? '').includes('"ok":true')).length
  }

  /** Check a mail and read its attachments. */
  private async plan(projectId: string, cwd: string, settings: ProjectMail, raw: unknown): Promise<{ ok: true; plan: MailPlan; account: MailAccount } | { ok: false; message: string }> {
    const args = parseMailArgs(raw)
    if (!args.ok) return args
    const found = await this.accountOf(projectId)
    if (found === undefined) return { ok: false, message: 'This project has no mail account: the admin sets one with /mail. Nothing was sent.' }
    const planned = planMail(cwd, settings, found.account, args.args, this.sentToday(projectId))
    return planned.ok ? { ok: true, plan: planned.plan, account: found.account } : planned
  }

  /**
   * The mail as a person is asked about it. Remembered: the send that follows sends this
   * mail, with these attachments, or nothing.
   *
   * @returns the text, or why it cannot be sent (no question is then asked).
   */
  async preview(projectId: string, callId: string, cwd: string, settings: ProjectMail, raw: unknown): Promise<{ ok: boolean; text: string }> {
    const planned = await this.plan(projectId, cwd, settings, raw)
    if (!planned.ok) return { ok: false, text: planned.message }
    this.shown.set(`${projectId}\0${callId}`, planned.plan)
    return { ok: true, text: describeMail(planned.plan, planned.account) }
  }

  /**
   * `send_mail`: the mail a person approved, or nothing.
   *
   * @returns what happened, for the agent.
   */
  async send(projectId: string, callId: string, cwd: string, settings: ProjectMail, raw: unknown): Promise<string> {
    const key = `${projectId}\0${callId}`
    const shown = this.shown.get(key)
    this.shown.delete(key)
    const planned = await this.plan(projectId, cwd, settings, raw)
    const details: Record<string, unknown> = planned.ok
      ? { recipients: planned.plan.args.to.length + planned.plan.args.cc.length + planned.plan.args.bcc.length, subject_sha256: createHash('sha256').update(planned.plan.args.subject).digest('hex').slice(0, 16), attachments: planned.plan.attachments.map((file) => ({ name: file.name, size: file.size })) }
      : {}
    const done = (ok: boolean, message: string, more: Record<string, unknown> = {}): string => {
      this.audit.record({ actor: `project:${projectId}`, action: 'mail.send', target: projectId, details: { ...details, ...more, ok } }, this.now())
      return message
    }
    if (!planned.ok) return done(false, planned.message, { error: planned.message })
    // Never unasked: a send nobody was shown is refused.
    if (shown === undefined) return done(false, 'send_mail runs only after a person approved the mail. Nothing was sent.', { error: 'not approved' })
    // Read once, checked against what was shown, and that is what goes.
    const contents = planned.plan.attachments.map((file) => readFileSync(file.path))
    const changed = shown.attachments.find((file, index) => planned.plan.attachments[index]?.path !== file.path || createHash('sha256').update(contents[index] ?? '').digest('hex') !== file.sha256)
    if (changed !== undefined || shown.digest !== planned.plan.digest) {
      return done(false, `The mail changed after it was approved${changed === undefined ? '' : ` (${changed.name})`}: nothing was sent. Send it again to be asked about it.`, { error: 'changed after approval' })
    }
    const { args } = planned.plan
    try {
      const info = await this.transport(planned.account).sendMail({
        from: planned.plan.from,
        to: [...args.to],
        ...(args.cc.length > 0 ? { cc: [...args.cc] } : {}),
        ...(args.bcc.length > 0 ? { bcc: [...args.bcc] } : {}),
        subject: args.subject,
        text: args.text,
        ...(args.html === undefined ? {} : { html: args.html }),
        attachments: planned.plan.attachments.map((file, index) => ({ filename: file.name, content: contents[index] })),
      })
      return done(true, `Sent to ${[...args.to, ...args.cc, ...args.bcc].join(', ')}${info.messageId === undefined ? '' : ` (${info.messageId})`}.`, { message_id: info.messageId ?? null })
    } catch (error) {
      // The server's own words, never the password: nodemailer's errors carry no credentials.
      const why = (error as Error).message.split(planned.account.password).join('…')
      return done(false, `The mail server refused or could not be reached: ${why}. Nothing was sent.`, { error: why })
    }
  }

  /** A test mail from an account, to an address the admin gives. */
  async test(projectId: string | null, to: string): Promise<{ ok: boolean; message: string }> {
    if (!ADDRESS.test(to)) return { ok: false, message: `"${to}" is not an address.` }
    const found = await this.accountOf(projectId)
    if (found === undefined) return { ok: false, message: `${projectId ?? 'Argus'} has no mail account.` }
    try {
      await this.transport(found.account).sendMail({ from: found.account.user, to, subject: 'Argus: test mail', text: `This is a test of the mail account ${describeAccount(found.account)}${projectId === null ? '' : ` of the project ${projectId}`}.` })
      return { ok: true, message: `Sent a test mail to ${to} with ${describeAccount(found.account)}.` }
    } catch (error) {
      return { ok: false, message: `The test mail failed: ${(error as Error).message.split(found.account.password).join('…')}` }
    }
  }
}
