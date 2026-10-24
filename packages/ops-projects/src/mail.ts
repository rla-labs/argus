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
  /** The attachments of one mail, together, in MB; also the largest mail its mailbox reads. */
  readonly max_attachment_mb: number
  /** The mailbox's folders its tools may read. */
  readonly read_folders: readonly string[]
  /** Exact addresses a mail may go to unasked, each with the mails a day it may get so. */
  readonly trusted_recipients: Readonly<Record<string, number>>
  /** Unasked recipients in any 24 hours, all trusted addresses together. */
  readonly unattended_per_day: number
  /** A mail to trusted addresses past a limit, or while paused: asked about, or refused. */
  readonly on_limit: 'ask' | 'block'
}

export const MAIL_DEFAULTS: ProjectMail = { from: null, allowed_recipients: [], max_per_day: 20, max_attachment_mb: 20, read_folders: ['INBOX'], trusted_recipients: {}, unattended_per_day: 10, on_limit: 'ask' }

const MAIL_KEYS = ['from', 'allowed_recipients', 'max_per_day', 'max_attachment_mb', 'read_folders', 'trusted_recipients', 'unattended_per_day', 'on_limit']

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
  if (typeof value !== 'object' || Array.isArray(value)) return { mail: MAIL_DEFAULTS, issues: [{ path: 'mail', message: `must be a mapping: ${MAIL_KEYS.join(', ')}` }] }
  const block = value as Record<string, unknown>
  for (const key of Object.keys(block)) {
    if (!MAIL_KEYS.includes(key)) issues.push({ path: `mail.${key}`, message: `not a mail setting; use ${MAIL_KEYS.join(', ')}` })
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
  const folders = block['read_folders'] ?? MAIL_DEFAULTS.read_folders
  const folderList = Array.isArray(folders) && folders.length >= 1 && folders.length <= 20 && folders.every((entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 200 && ![...entry].some((char) => char.charCodeAt(0) < 0x20))
  if (!folderList) issues.push({ path: 'mail.read_folders', message: 'must list 1 to 20 folder names, e.g. [INBOX, Comenzi]' })
  const trusted = block['trusted_recipients'] ?? {}
  const trustedOk =
    typeof trusted === 'object' && trusted !== null && !Array.isArray(trusted) &&
    Object.entries(trusted).every(([address, perDay]) => ADDRESS.test(address) && typeof perDay === 'number' && Number.isInteger(perDay) && perDay >= 1 && perDay <= 100)
  if (!trustedOk) issues.push({ path: 'mail.trusted_recipients', message: 'must map exact addresses to the mails a day each may get unasked (1 to 100), e.g. {ana@example.com: 2}; never a domain' })
  const onLimit = block['on_limit'] ?? MAIL_DEFAULTS.on_limit
  if (onLimit !== 'ask' && onLimit !== 'block') issues.push({ path: 'mail.on_limit', message: 'must be ask or block' })
  return {
    mail: {
      from: typeof from === 'string' ? from : null,
      allowed_recipients: Array.isArray(recipients) ? recipients.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.toLowerCase()) : [],
      max_per_day: count('max_per_day', MAIL_DEFAULTS.max_per_day, 500),
      max_attachment_mb: count('max_attachment_mb', MAIL_DEFAULTS.max_attachment_mb, 50),
      read_folders: folderList ? (folders as string[]).map((entry) => entry.trim()) : MAIL_DEFAULTS.read_folders,
      trusted_recipients: trustedOk ? Object.fromEntries(Object.entries(trusted as Record<string, number>).map(([address, perDay]) => [address.toLowerCase(), perDay])) : {},
      unattended_per_day: count('unattended_per_day', MAIL_DEFAULTS.unattended_per_day, 500),
      on_limit: onLimit === 'block' ? 'block' : 'ask',
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
  /** The id of a mail in the project's mailbox this one answers (`INBOX:4521`). */
  readonly reply_to?: string
}

/** One attachment, as read for the question: its hash is checked again at sending. */
export interface MailAttachment {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly sha256: string
}

/** The mail a reply answers, as its headers say. */
export interface OriginalMail {
  /** Its sender's address, lower case: the only one a reply may go to. */
  readonly address: string
  readonly subject: string
  readonly messageId: string | null
  readonly references: readonly string[]
  /** The headers that tell an automatic mail, by lower-case name. */
  readonly headers: Readonly<Record<string, string>>
}

/** Senders whose mail is never answered: they take no replies. */
const NO_REPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+._-]|$)/i

/**
 * Why a mail must not be answered, so two automatic senders never write to each other
 * without end; `undefined` when it may be.
 *
 * @param original the mail.
 * @param own the project's own addresses (its sender, its accounts' users).
 * @returns the reason, or `undefined`.
 */
export function loopReason(original: OriginalMail, own: readonly string[]): string | undefined {
  const header = (name: string): string => (original.headers[name] ?? '').trim().toLowerCase()
  if (header('auto-submitted') !== '' && header('auto-submitted') !== 'no') return 'it was sent automatically (Auto-Submitted)'
  if (header('x-argus-project') !== '') return 'it was sent by Argus'
  if (header('list-id') !== '') return 'it came from a mailing list (List-Id)'
  if (['bulk', 'list', 'junk'].includes(header('precedence'))) return `it is ${header('precedence')} mail (Precedence)`
  if (NO_REPLY.test(original.address.split('@')[0] ?? '')) return 'its sender takes no replies'
  if (own.some((address) => address.toLowerCase() === original.address)) return 'it is from this project\'s own address'
  return undefined
}

/** A mail, checked and ready to show and send. */
export interface MailPlan {
  readonly from: string
  readonly args: MailArgs
  readonly attachments: readonly MailAttachment[]
  /** The mail it answers, for In-Reply-To and References. */
  readonly reply?: { readonly messageId: string; readonly references: readonly string[] }
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
    ...(typeof record['reply_to'] === 'string' && record['reply_to'].trim().length > 0 ? { reply_to: record['reply_to'].trim() } : {}),
  }
  if (args.reply_to !== undefined && (args.cc.length > 0 || args.bcc.length > 0)) return { ok: false, message: 'A reply goes only to the sender of the mail it answers: no cc or bcc.' }
  if (args.to.length === 0 && args.reply_to === undefined) return { ok: false, message: 'send_mail needs at least one address in to.' }
  const bad = [...args.to, ...args.cc, ...args.bcc].find((address) => !ADDRESS.test(address))
  if (bad !== undefined) return { ok: false, message: `"${bad}" is not an address: give plain addresses, like ana@example.com.` }
  if (args.subject.length === 0 && args.reply_to === undefined) return { ok: false, message: 'send_mail needs a subject.' }
  if (/[\r\n]/.test(args.subject)) return { ok: false, message: 'The subject is one line.' }
  if (args.text.trim().length === 0) return { ok: false, message: 'send_mail needs the text of the mail.' }
  return { ok: true, args }
}

/** Whether an address is one a project may write to. */
function allowed(address: string, settings: ProjectMail): boolean {
  const lower = address.toLowerCase()
  return settings.trusted_recipients[lower] !== undefined || settings.allowed_recipients.some((entry) => (entry.startsWith('@') ? lower.endsWith(entry) : lower === entry))
}

/** Everyone a mail goes to, lower case: each one counts. */
export function recipientsOf(args: MailArgs): string[] {
  return [...args.to, ...args.cc, ...args.bcc].map((address) => address.toLowerCase())
}

/** Recipients a project's mails reached in the last 24 hours. */
export interface MailCounts {
  /** Every recipient, asked or not: `max_per_day` counts these. */
  readonly total: number
  /** Recipients reached unasked: `unattended_per_day` counts these. */
  readonly unattended: number
  /** Mails each address got unasked: its own count in `trusted_recipients`. */
  readonly byAddress: ReadonlyMap<string, number>
}

/** How a mail goes: now and unasked, after a person's yes, or not at all. */
export type MailRoute = { kind: 'unasked' } | { kind: 'ask'; why: string | null } | { kind: 'refuse'; message: string }

/**
 * Decide how a mail goes, in code: unasked only when every recipient is trusted and every
 * count still has room; past a limit, `on_limit` asks or refuses; `max_per_day` refuses
 * whatever it says.
 *
 * @param settings the project's `mail:` block.
 * @param recipients everyone the mail goes to, lower case (checked as allowed).
 * @param counts what the last 24 hours used.
 * @param paused whether unasked sending is paused.
 * @returns the route.
 */
export function routeMail(settings: ProjectMail, recipients: readonly string[], counts: MailCounts, paused: boolean): MailRoute {
  if (counts.total + recipients.length > settings.max_per_day) {
    return { kind: 'refuse', message: `This project's mails reached ${counts.total} recipient(s) in the last 24 hours; ${recipients.length} more would pass its limit of ${settings.max_per_day} (mail.max_per_day). Nothing was sent.` }
  }
  const untrusted = recipients.filter((address) => settings.trusted_recipients[address] === undefined)
  if (untrusted.length > 0) return { kind: 'ask', why: null }
  const full = recipients.find((address) => (counts.byAddress.get(address) ?? 0) + recipients.filter((other) => other === address).length > (settings.trusted_recipients[address] ?? 0))
  const why = paused
    ? 'unasked mail is paused for this project (/mail resume)'
    : full !== undefined
      ? `${full} already got ${counts.byAddress.get(full) ?? 0} unasked mail(s) in the last 24 hours, its limit (mail.trusted_recipients)`
      : counts.unattended + recipients.length > settings.unattended_per_day
        ? `unasked mails reached ${counts.unattended} recipient(s) in the last 24 hours; ${recipients.length} more would pass ${settings.unattended_per_day} (mail.unattended_per_day)`
        : null
  if (why === null) return { kind: 'unasked' }
  return settings.on_limit === 'block' ? { kind: 'refuse', message: `Not sent: ${why}. mail.on_limit is block, so nobody is asked. Nothing was sent.` } : { kind: 'ask', why }
}

/**
 * Check a mail's recipients against the project's settings and read its attachments.
 * The limits are {@link routeMail}'s.
 *
 * @param cwd the project's folder.
 * @param settings its `mail:` block.
 * @param account the account it sends with.
 * @param args the call's arguments.
 * @param original the mail it answers, for a reply.
 * @returns the plan, or why it cannot be sent.
 */
export function planMail(cwd: string, settings: ProjectMail, account: MailAccount, args: MailArgs, original?: OriginalMail): { ok: true; plan: MailPlan } | { ok: false; message: string } {
  if (original !== undefined) {
    const loop = loopReason(original, [account.user, ...(settings.from === null ? [] : [settings.from])])
    if (loop !== undefined) return { ok: false, message: `${args.reply_to ?? 'That mail'} is not answered: ${loop}. Nothing was sent; do not write to its sender another way.` }
    if (args.to.some((address) => address.toLowerCase() !== original.address)) return { ok: false, message: `A reply goes only to the sender of the mail it answers, ${original.address}.` }
    args = { ...args, to: [original.address], subject: args.subject.length > 0 ? args.subject : /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}` }
  }
  if (settings.allowed_recipients.length === 0 && Object.keys(settings.trusted_recipients).length === 0) {
    return { ok: false, message: 'This project may not send mail to anyone yet: the admin lists who in mail.allowed_recipients or mail.trusted_recipients of its file (/set <project> mail.allowed_recipients [ana@example.com, @example.com]).' }
  }
  const refused = recipientsOf(args).filter((address) => !allowed(address, settings))
  if (refused.length > 0) return { ok: false, message: `Not in mail.allowed_recipients or mail.trusted_recipients of this project: ${refused.join(', ')}. Nothing was sent; do not try another way to reach them.` }

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
  const reply = original?.messageId == null ? undefined : { messageId: original.messageId, references: [...original.references, original.messageId] }
  const digest = createHash('sha256').update(JSON.stringify({ from, args, reply, attachments: attachments.map((file) => [file.name, file.sha256]) })).digest('hex')
  return { ok: true, plan: { from, args, attachments, digest, ...(reply === undefined ? {} : { reply }) } }
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
    ...(args.reply_to === undefined ? [] : [`a reply to ${args.reply_to}`]),
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
  /** Newest first. */
  byAction(action: string, limit: number): ReadonlyArray<{ id?: number; ts: number; target: string | null; details_json: string | null }>
}

/** Sends one message; nodemailer's transport in production, a fake in a test. */
export type MailTransport = (account: MailAccount) => { sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }> }

/** What the mailer is told and asks beyond its accounts. */
export interface MailerHooks {
  /** The mail a reply answers, from the project's mailbox, or why it cannot be read. */
  readonly original?: (projectId: string, settings: ProjectMail, id: string) => Promise<OriginalMail | string>
  /** Unasked sending paused itself after failures: the admin is told. */
  readonly paused?: (projectId: string, why: string) => void
}

/** Unasked mails that fail in a row before unasked sending pauses itself. */
const FAILURES_TO_PAUSE = 3
const DAY_MS = 24 * 60 * 60 * 1000

/** A `mail.send` row's details, as far as counting needs them. */
interface SentDetails {
  ok?: boolean
  path?: string
  addresses?: string[]
  recipients?: number
  smtp?: boolean
}

/**
 * The mail of every project: accounts, the route each mail takes, the question's
 * preview, and the sending.
 */
export class ProjectMailer {
  /** The mail each question showed, by project and call: the send must match it. */
  private readonly shown = new Map<string, MailPlan>()
  /** The mail each unasked call was checked as: the send must match it, and still fit. */
  private readonly unasked = new Map<string, MailPlan>()
  /** Recipients of mails being sent now, which the audit does not hold yet. */
  private readonly sending = new Set<{ projectId: string; addresses: readonly string[]; unasked: boolean }>()

  constructor(
    private readonly secrets: () => MailSecrets | undefined,
    private readonly audit: MailAudit,
    private readonly transport: MailTransport,
    private readonly ref: (name: string) => unknown,
    private readonly now: () => number = Date.now,
    private readonly hooks: MailerHooks = {},
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

  /** A project's `mail.send` rows since a time, newest first, with their details read. */
  private sent(projectId: string, since: number): Array<{ ts: number; details: SentDetails }> {
    return this.audit
      .byAction('mail.send', 5000)
      .filter((row) => row.target === projectId && row.ts >= since)
      .map((row) => {
        try {
          return { ts: row.ts, details: JSON.parse(row.details_json ?? '{}') as SentDetails }
        } catch {
          return { ts: row.ts, details: {} }
        }
      })
  }

  /** Recipients a project's mails reached in the last 24 hours, the ones being sent now included. */
  counts(projectId: string): MailCounts {
    let total = 0
    let unattended = 0
    const byAddress = new Map<string, number>()
    const add = (addresses: readonly string[] | undefined, count: number, unasked: boolean): void => {
      total += count
      if (!unasked) return
      unattended += count
      for (const address of addresses ?? []) byAddress.set(address, (byAddress.get(address) ?? 0) + 1)
    }
    for (const { details } of this.sent(projectId, this.now() - DAY_MS)) {
      if (details.ok === true) add(details.addresses, details.addresses?.length ?? details.recipients ?? 1, details.path === 'unasked')
    }
    for (const mail of this.sending) if (mail.projectId === projectId) add(mail.addresses, mail.addresses.length, mail.unasked)
    return { total, unattended, byAddress }
  }

  /** Mails a project sent in the last 24 hours. */
  sentToday(projectId: string): number {
    return this.sent(projectId, this.now() - DAY_MS).filter((row) => row.details.ok === true).length
  }

  /** The newest pause or resume that applies to a project: its own, or one for all (`*`). */
  private lastSwitch(projectId: string): { ts: number; paused: boolean; details: string | null } | undefined {
    const rows = [
      ...this.audit.byAction('mail.pause', 1000).map((row) => ({ ...row, paused: true })),
      ...this.audit.byAction('mail.resume', 1000).map((row) => ({ ...row, paused: false })),
    ].filter((row) => row.target === projectId || row.target === '*')
    const newest = rows.sort((a, b) => b.ts - a.ts || (b.id ?? 0) - (a.id ?? 0))[0]
    return newest === undefined ? undefined : { ts: newest.ts, paused: newest.paused, details: newest.details_json }
  }

  /** Whether a project's unasked mail is paused, and why. */
  pausedOf(projectId: string): { paused: boolean; auto: boolean } {
    const last = this.lastSwitch(projectId)
    return { paused: last?.paused === true, auto: last?.paused === true && (last.details ?? '').includes('"auto":true') }
  }

  /** Pause unasked mail for a project, or for all (`null`): it asks, or is refused, until resumed. */
  pause(projectId: string | null, actor: string, details: Record<string, unknown> = {}): void {
    this.audit.record({ actor, action: 'mail.pause', target: projectId ?? '*', details }, this.now())
  }

  /** Resume unasked mail for a project, or for all (`null`). */
  resume(projectId: string | null, actor: string): void {
    this.audit.record({ actor, action: 'mail.resume', target: projectId ?? '*', details: {} }, this.now())
  }

  /** After an unasked mail failed: pause, when the last few since the last resume all failed. */
  private checkFailures(projectId: string): void {
    const since = this.lastSwitch(projectId)?.ts ?? 0
    const unasked = this.sent(projectId, since + 1).filter((row) => row.details.path === 'unasked').slice(0, FAILURES_TO_PAUSE)
    if (unasked.length < FAILURES_TO_PAUSE || !unasked.every((row) => row.details.ok === false && row.details.smtp === true)) return
    const why = `its last ${FAILURES_TO_PAUSE} unasked mails failed at the mail server`
    this.pause(projectId, 'argus', { auto: true, why })
    this.hooks.paused?.(projectId, why)
  }

  /** Check a mail and read its attachments; a reply's original from the mailbox. */
  private async plan(projectId: string, cwd: string, settings: ProjectMail, raw: unknown): Promise<{ ok: true; plan: MailPlan; account: MailAccount } | { ok: false; message: string }> {
    const args = parseMailArgs(raw)
    if (!args.ok) return args
    const found = await this.accountOf(projectId)
    if (found === undefined) return { ok: false, message: 'This project has no mail account: the admin sets one with /mail. Nothing was sent.' }
    let original: OriginalMail | undefined
    if (args.args.reply_to !== undefined) {
      if (this.hooks.original === undefined) return { ok: false, message: 'Replies need the project\'s mailbox, which is not available. Nothing was sent.' }
      const read = await this.hooks.original(projectId, settings, args.args.reply_to)
      if (typeof read === 'string') return { ok: false, message: `${read} Nothing was sent.` }
      original = read
    }
    const planned = planMail(cwd, settings, found.account, args.args, original)
    return planned.ok ? { ok: true, plan: planned.plan, account: found.account } : planned
  }

  /**
   * A `send_mail` before it runs: refused, sent unasked (every recipient trusted and
   * within its counts), or shown to a person. Remembered: the send that follows sends
   * this mail, with these attachments, or nothing.
   *
   * @returns the question's text, `unasked` when nobody is asked, or why it cannot be sent.
   */
  async preview(projectId: string, callId: string, cwd: string, settings: ProjectMail, raw: unknown): Promise<{ ok: boolean; text: string; unasked?: boolean }> {
    const planned = await this.plan(projectId, cwd, settings, raw)
    if (!planned.ok) return { ok: false, text: planned.message }
    const route = routeMail(settings, recipientsOf(planned.plan.args), this.counts(projectId), this.pausedOf(projectId).paused)
    if (route.kind === 'refuse') return { ok: false, text: route.message }
    const key = `${projectId}\0${callId}`
    if (route.kind === 'unasked') {
      this.unasked.set(key, planned.plan)
      return { ok: true, text: describeMail(planned.plan, planned.account), unasked: true }
    }
    this.shown.set(key, planned.plan)
    return { ok: true, text: `${route.why === null ? '' : `Asked because ${route.why}.\n`}${describeMail(planned.plan, planned.account)}` }
  }

  /**
   * `send_mail`: the mail a person approved, or one checked as unasked that still fits
   * its counts, or nothing.
   *
   * @returns what happened, for the agent.
   */
  async send(projectId: string, callId: string, cwd: string, settings: ProjectMail, raw: unknown): Promise<string> {
    const key = `${projectId}\0${callId}`
    const approved = this.shown.get(key)
    const unasked = this.unasked.get(key)
    this.shown.delete(key)
    this.unasked.delete(key)
    const planned = await this.plan(projectId, cwd, settings, raw)
    const addresses = planned.ok ? recipientsOf(planned.plan.args) : []
    const details: Record<string, unknown> = planned.ok
      ? {
          path: unasked !== undefined ? 'unasked' : 'approved',
          recipients: addresses.length,
          addresses,
          subject_sha256: createHash('sha256').update(planned.plan.args.subject).digest('hex').slice(0, 16),
          attachments: planned.plan.attachments.map((file) => ({ name: file.name, size: file.size })),
          ...(planned.plan.args.reply_to === undefined ? {} : { reply_to: planned.plan.args.reply_to }),
        }
      : {}
    const done = (ok: boolean, message: string, more: Record<string, unknown> = {}): string => {
      this.audit.record({ actor: `project:${projectId}`, action: 'mail.send', target: projectId, details: { ...details, ...more, ok } }, this.now())
      return message
    }
    if (!planned.ok) return done(false, planned.message, { error: planned.message })
    const checked = approved ?? unasked
    // Never unasked unless checked as such: a send nobody was shown, and no trusted route, is refused.
    if (checked === undefined) return done(false, 'send_mail runs only after a person approved the mail, or for trusted recipients within their limits. Nothing was sent.', { error: 'not approved' })
    // Read once, checked against what was shown, and that is what goes.
    const contents = planned.plan.attachments.map((file) => readFileSync(file.path))
    const changed = checked.attachments.find((file, index) => planned.plan.attachments[index]?.path !== file.path || createHash('sha256').update(contents[index] ?? '').digest('hex') !== file.sha256)
    if (changed !== undefined || checked.digest !== planned.plan.digest) {
      return done(false, `The mail changed after it was ${unasked === undefined ? 'approved' : 'checked'}${changed === undefined ? '' : ` (${changed.name})`}: nothing was sent. Send it again.`, { error: 'changed after approval' })
    }
    // The counts again, now: another mail may have used them since the check.
    const route = routeMail(settings, addresses, this.counts(projectId), this.pausedOf(projectId).paused)
    if (route.kind === 'refuse') return done(false, route.message, { error: 'limit' })
    if (unasked !== undefined && route.kind !== 'unasked') return done(false, `Not sent: ${route.why ?? 'a limit was reached'} since it was checked. Send it again to be asked about it.`, { error: 'limit' })

    const { args } = planned.plan
    const mail = { projectId, addresses, unasked: unasked !== undefined }
    this.sending.add(mail)
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
        // Marked as automatic, so an auto-responder does not answer it, and as ours, so we never answer it.
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Argus-Project': projectId },
        ...(planned.plan.reply === undefined ? {} : { inReplyTo: planned.plan.reply.messageId, references: [...planned.plan.reply.references] }),
      })
      return done(true, `Sent${unasked === undefined ? '' : ' unasked (trusted recipients)'} to ${addresses.join(', ')}${info.messageId === undefined ? '' : ` (${info.messageId})`}.`, { message_id: info.messageId ?? null })
    } catch (error) {
      // The server's own words, never the password: nodemailer's errors carry no credentials.
      const why = (error as Error).message.split(planned.account.password).join('…')
      const message = done(false, `The mail server refused or could not be reached: ${why}. Nothing was sent.`, { error: why, smtp: true })
      if (unasked !== undefined) this.checkFailures(projectId)
      return message
    } finally {
      this.sending.delete(mail)
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
