// == ARGUS AGENT PROJECT ==
/**
 * send_mail's checks and sending: the project's settings, the account URL, the
 * attachments (inside the folder, no link, under the limit), the daily limit, the mail a
 * person approved and nothing else, and an audit that never holds the password.
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loopReason, mailSecretName, parseMailAccount, parseMailBlock, ProjectMailer, routeMail, transportOptions, type MailAccount, type MailerHooks, type MailOutboxRows, type OriginalMail, type OutboxEvent, type OutboxState, type ProjectMail } from '../../src/mail.js'

const PASSWORD = 'pa55-w0rd-SECRET'
const URL_TEXT = `smtps://office%40acme.ro:${PASSWORD}@mail.acme.ro:465`

describe('a project\'s mail block', () => {
  it('has safe defaults, and refuses what it cannot use', () => {
    expect(parseMailBlock(undefined)).toEqual({ mail: { from: null, allowed_recipients: [], max_per_day: 20, max_attachment_mb: 20, read_folders: ['INBOX'], trusted_recipients: {}, unattended_per_day: 10, on_limit: 'ask' }, issues: [] })
    expect(parseMailBlock({ trusted_recipients: { 'Romeo@Acme.ro': 2 }, unattended_per_day: 5, on_limit: 'block' }).mail).toMatchObject({ trusted_recipients: { 'romeo@acme.ro': 2 }, unattended_per_day: 5, on_limit: 'block' })
    // Never a domain, never a count of nothing.
    for (const trusted of [{ '@acme.ro': 2 }, { 'a@acme.ro': 0 }, ['a@acme.ro'], { 'a@acme.ro': 1.5 }]) {
      expect(parseMailBlock({ trusted_recipients: trusted }).issues.map((issue) => issue.path)).toEqual(['mail.trusted_recipients'])
    }
    expect(parseMailBlock({ on_limit: 'send' }).issues.map((issue) => issue.path)).toEqual(['mail.on_limit'])
    expect(parseMailBlock({ allowed_recipients: ['Ana@Acme.ro', '@client.com'], max_per_day: 5 }).mail).toMatchObject({ allowed_recipients: ['ana@acme.ro', '@client.com'], max_per_day: 5 })
    const bad = parseMailBlock({ allowed_recipients: ['nobody'], max_per_day: 0, from: 'x', smtp: 'y' })
    expect(bad.issues.map((issue) => issue.path).sort()).toEqual(['mail.allowed_recipients', 'mail.from', 'mail.max_per_day', 'mail.smtp'])
  })
})

describe('a mail account', () => {
  it('is an smtps or smtp URL with a user and a password, used over TLS with certificates checked', () => {
    const parsed = parseMailAccount(URL_TEXT)
    expect(parsed).toEqual({ ok: true, account: { secure: true, host: 'mail.acme.ro', port: 465, user: 'office@acme.ro', password: PASSWORD } })
    const options = transportOptions((parsed as { account: MailAccount }).account)
    expect(options).toMatchObject({ secure: true, requireTLS: false, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, connectionTimeout: 30_000 })
    const starttls = parseMailAccount('smtp://u:p@mail.example.com')
    expect(starttls).toMatchObject({ ok: true, account: { secure: false, port: 587 } })
    expect(transportOptions((starttls as { account: MailAccount }).account)).toMatchObject({ secure: false, requireTLS: true })
    for (const wrong of ['http://u:p@h', 'smtps://mail.acme.ro', 'smtps://u@h:465', 'not a url']) {
      const result = parseMailAccount(wrong)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(PASSWORD)
    }
  })

  it('is kept under a hashed name per project, and one default', () => {
    expect(mailSecretName(null)).toBe('ARGUS_MAIL_DEFAULT')
    expect(mailSecretName('site')).toMatch(/^ARGUS_MAIL_[0-9A-F]{24}$/)
    expect(mailSecretName('site')).not.toBe(mailSecretName('other'))
  })
})

/** An outbox over memory, its folders in a temporary one. */
function memoryOutbox() {
  const rows: Array<{ id: number; project_id: string; run_id: string | null; status: OutboxState; note: string | null; decided_by: string | null }> = []
  const events: OutboxEvent[] = []
  const store: MailOutboxRows = {
    insert: (input) => rows.push({ id: rows.length + 1, project_id: input.project_id, run_id: input.run_id, status: 'waiting', note: null, decided_by: null }),
    get: (id) => rows.find((row) => row.id === id),
    decide: (id, status, by, note) => {
      const row = rows.find((entry) => entry.id === id && entry.status === 'waiting')
      if (row === undefined) return false
      Object.assign(row, { status, decided_by: by, note })
      return true
    },
    waiting: () => rows.filter((row) => row.status === 'waiting'),
  }
  const root = mkdtempSync(join(tmpdir(), 'mail-state-'))
  return { rows, events, root, outbox: { rows: store, dir: (projectId: string) => join(root, projectId, 'outbox'), changed: (event: OutboxEvent) => void events.push(event) } }
}

/** A mailer over memory: secrets, an audit log, an outbox, and a transport that records. */
function harness(settings: Partial<ProjectMail> = {}, hooks: MailerHooks = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mail-project-'))
  const box = memoryOutbox()
  const values = new Map<string, string>()
  const audit: Array<{ ts: number; action: string; target: string; details: Record<string, unknown> }> = []
  const sent: Array<Record<string, unknown>> = []
  let fail: Error | undefined
  const mailer = new ProjectMailer(
    () => ({
      set: async (ref, value) => void values.set(String(ref), value),
      unset: async (ref) => void values.delete(String(ref)),
      resolve: async (ref) => (values.has(String(ref)) ? { value: values.get(String(ref)) as string } : undefined),
    }),
    {
      record: (entry, ts) => void audit.push({ ...entry, ts }),
      byAction: (action, limit) =>
        audit
          .map((row, index) => ({ ...row, id: index + 1 }))
          .filter((row) => row.action === action)
          .slice(-limit)
          .reverse()
          .map((row) => ({ id: row.id, ts: row.ts, target: row.target, details_json: JSON.stringify(row.details) })),
    },
    () => ({
      sendMail: async (message) => {
        if (fail !== undefined) throw fail
        sent.push(message)
        return { messageId: `<m${sent.length}@acme.ro>` }
      },
    }),
    (name) => name,
    Date.now,
    { outbox: box.outbox, ...hooks },
  )
  const mail: ProjectMail = { from: null, allowed_recipients: ['ana@acme.ro', '@client.com'], max_per_day: 20, max_attachment_mb: 1, read_folders: ['INBOX'], trusted_recipients: {}, unattended_per_day: 10, on_limit: 'ask', ...settings }
  const ask = async (callId: string, args: Record<string, unknown>) => mailer.preview('site', callId, cwd, mail, args)
  const send = async (callId: string, args: Record<string, unknown>) => mailer.send('site', callId, cwd, mail, args, 'run-1')
  /** Asked, kept in the outbox, then approved by ana: what she is told. */
  const approve = async (callId: string, args: Record<string, unknown>) => {
    await ask(callId, args)
    await send(callId, args)
    return mailer.decideOutbox(box.rows.length, 'approve', 'ana', mail)
  }
  return { cwd, values, audit, sent, mailer, ask, send, approve, box, mail, failWith: (error: Error | undefined) => void (fail = error) }
}

const MAIL = { to: ['ana@acme.ro'], cc: ['bob@client.com'], subject: 'Raport Q3', text: 'Bună ziua,\nraportul e atașat.', attachments: ['out/report.pdf'] }

describe('send_mail', () => {
  it('shows the mail, then sends exactly that mail with the account the agent never sees', async () => {
    const h = harness()
    await h.mailer.setAccount('site', URL_TEXT)
    mkdirSync(join(h.cwd, 'out'))
    writeFileSync(join(h.cwd, 'out', 'report.pdf'), 'PDF-1')

    const preview = await h.ask('c1', MAIL)
    expect(preview.ok).toBe(true)
    expect(preview.text).toContain('from: office@acme.ro (via mail.acme.ro)')
    expect(preview.text).toContain('to: ana@acme.ro\ncc: bob@client.com\nsubject: Raport Q3\nattachments: report.pdf (5 B)')
    expect(preview.text).toContain('raportul e atașat.')
    expect(preview.text).not.toContain(PASSWORD)

    expect(preview.queued).toBe(true)
    expect(await h.send('c1', MAIL)).toBe('This mail needs a person\'s approval: it waits in the outbox as #1, and Argus sends it when someone approves it, or drops it if nobody does in time. Do not send it again; carry on.')
    expect(h.sent).toHaveLength(0)
    expect(h.box.events).toEqual([{ projectId: 'site', id: 1, runId: 'run-1', state: 'waiting', text: preview.text }])
    // The project's file changes after the question: what goes is the copy that was shown.
    writeFileSync(join(h.cwd, 'out', 'report.pdf'), 'PDF-2, swapped')
    expect(await h.mailer.decideOutbox(1, 'approve', 'ana', h.mail)).toBe('Mail #1 of site was sent to ana@acme.ro, bob@client.com.')
    expect(await h.mailer.decideOutbox(1, 'deny', 'bob', h.mail)).toBe('Mail #1 was already sent.')
    expect(existsSync(join(h.box.root, 'site', 'outbox', '1'))).toBe(false)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ from: 'office@acme.ro', to: ['ana@acme.ro'], cc: ['bob@client.com'], subject: 'Raport Q3', text: MAIL.text, headers: { 'Auto-Submitted': 'auto-generated', 'X-Argus-Project': 'site' } })
    expect(String((h.sent[0]!['attachments'] as Array<{ content: Buffer }>)[0]!.content)).toBe('PDF-1')
    expect(h.audit.filter((row) => row.action === 'mail.send')).toEqual([expect.objectContaining({ target: 'site', details: expect.objectContaining({ ok: true, path: 'approved', outbox: 1, approved_by: 'ana', recipients: 2, addresses: ['ana@acme.ro', 'bob@client.com'], attachments: [{ name: 'report.pdf', size: 5 }] }) })])
    expect(JSON.stringify(h.audit)).not.toContain(PASSWORD)
    expect(JSON.stringify(h.audit)).not.toContain('Raport Q3')
    expect(JSON.stringify(h.audit)).not.toContain('raportul')
  })

  it('keeps nothing nobody checked, nor a mail whose attachment changed after the check; denied or expired, nothing goes', async () => {
    const h = harness()
    await h.mailer.setAccount(null, URL_TEXT)
    mkdirSync(join(h.cwd, 'out'))
    writeFileSync(join(h.cwd, 'out', 'report.pdf'), 'PDF-1')
    expect(await h.send('c0', MAIL)).toContain('runs only for trusted recipients within their limits, or through the outbox')
    expect((await h.ask('c1', MAIL)).ok).toBe(true)
    writeFileSync(join(h.cwd, 'out', 'report.pdf'), 'PDF-2, swapped')
    expect(await h.send('c1', MAIL)).toContain('changed after it was checked (report.pdf): nothing was sent')
    // The check is used once.
    expect(await h.send('c1', MAIL)).toContain('runs only for trusted recipients')
    await h.ask('c2', MAIL)
    await h.send('c2', MAIL)
    await h.ask('c3', MAIL)
    await h.send('c3', MAIL)
    expect(await h.mailer.decideOutbox(1, 'deny', 'ana', h.mail)).toBe('Mail #1 of site was denied: nothing was sent.')
    expect(await h.mailer.expireWaiting('Argus restarted')).toBe(1)
    expect(h.box.rows.map((row) => [row.status, row.note])).toEqual([['refused', null], ['expired', 'Argus restarted']])
    expect(h.box.events.map((event) => event.state)).toEqual(['waiting', 'waiting', 'refused', 'expired'])
    expect(h.sent).toHaveLength(0)
  })

  it('checks the project\'s file again when approved: a recipient removed since is not written to', async () => {
    const h = harness()
    await h.mailer.setAccount('site', URL_TEXT)
    const one = { to: ['bob@client.com'], subject: 's', text: 't' }
    await h.ask('a', one)
    await h.send('a', one)
    expect(await h.mailer.decideOutbox(1, 'approve', 'ana', { ...h.mail, allowed_recipients: ['ana@acme.ro'] })).toBe('Mail #1 of site was not sent: bob@client.com may no longer receive its mail')
    expect(h.sent).toHaveLength(0)
  })

  it('refuses before any question a recipient not allowed, an attachment outside the folder, a link, too large, and no account', async () => {
    const h = harness()
    expect((await h.ask('c1', { ...MAIL, attachments: [] })).text).toContain('no mail account')
    await h.mailer.setAccount('site', URL_TEXT)
    expect((await h.ask('c2', { ...MAIL, attachments: [], to: ['eve@evil.com'] })).text).toContain('Not in mail.allowed_recipients or mail.trusted_recipients of this project: eve@evil.com')
    expect((await h.ask('c3', { ...MAIL, attachments: [], bcc: ['eve@evil.com'] })).ok).toBe(false)
    const outside = join(mkdtempSync(join(tmpdir(), 'mail-outside-')), 'secret.txt')
    writeFileSync(outside, 'SECRET')
    expect((await h.ask('c4', { ...MAIL, attachments: [outside] })).text).toContain('is outside your folder')
    expect((await h.ask('c5', { ...MAIL, attachments: ['../../etc/passwd'] })).text).toMatch(/outside your folder|no such file/)
    symlinkSync(outside, join(h.cwd, 'link.txt'))
    expect((await h.ask('c6', { ...MAIL, attachments: ['link.txt'] })).text).toContain('is a link')
    writeFileSync(join(h.cwd, 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
    expect((await h.ask('c7', { ...MAIL, attachments: ['big.bin'] })).text).toContain('more than 1 MB')
    expect((await h.ask('c8', { to: [], subject: 's', text: 't' })).text).toContain('at least one address')
    expect((await h.ask('c9', { to: ['ana@acme.ro'], subject: 'a\nBcc: eve@evil.com', text: 't' })).text).toContain('one line')
    expect((await h.ask('c10', { to: ['Ana <ana@acme.ro>'], subject: 's', text: 't' })).ok).toBe(false)
    const nobody = harness({ allowed_recipients: [] })
    await nobody.mailer.setAccount('site', URL_TEXT)
    expect((await nobody.ask('c1', { ...MAIL, attachments: [] })).text).toContain('may not send mail to anyone yet')
  })

  it('holds the daily limit in recipients, counting only mails that went', async () => {
    const h = harness({ max_per_day: 4 })
    await h.mailer.setAccount('site', URL_TEXT)
    const two = { ...MAIL, attachments: [] }
    h.failWith(new Error('421 try later'))
    expect(await h.approve('x', two)).toContain('the mail server refused it: 421 try later')
    h.failWith(undefined)
    for (const id of ['a', 'b']) expect(await h.approve(id, two)).toContain('was sent to')
    expect((await h.ask('c', { ...two, cc: [] })).text).toContain('reached 4 recipient(s) in the last 24 hours; 1 more would pass its limit of 4')
    expect(h.mailer.sentToday('site')).toBe(2)
    expect(h.mailer.counts('site').total).toBe(4)
  })

  it('reports a server\'s refusal without the password', async () => {
    const h = harness()
    await h.mailer.setAccount('site', URL_TEXT)
    h.failWith(new Error(`535 Authentication failed for office@acme.ro:${PASSWORD}`))
    const one = { ...MAIL, attachments: [] }
    const said = await h.approve('c1', one)
    expect(said).toContain('535 Authentication failed')
    expect(said).not.toContain(PASSWORD)
    expect(JSON.stringify(h.audit)).not.toContain(PASSWORD)
    expect(h.audit.find((row) => row.action === 'mail.send')!.details['ok']).toBe(false)
    expect(h.box.rows[0]!.status).toBe('failed')
  })

  it('keeps the account in the credentials store only, and says which one a project uses', async () => {
    const h = harness()
    expect(await h.mailer.accountOf('site')).toBeUndefined()
    expect((await h.mailer.setAccount(null, URL_TEXT)).message).toBe('The default mail account: smtps://office@acme.ro@mail.acme.ro:465. The password is kept in the credentials store; no project can read it.')
    expect(await h.mailer.accountOf('site')).toMatchObject({ own: false })
    await h.mailer.setAccount('site', 'smtp://me:pw@other.ro:587')
    expect(await h.mailer.accountOf('site')).toMatchObject({ own: true, account: { host: 'other.ro' } })
    expect([...h.values.keys()].sort()).toEqual([mailSecretName('site'), 'ARGUS_MAIL_DEFAULT'].sort())
    expect(await h.mailer.removeAccount('site')).toBe(true)
    expect(await h.mailer.accountOf('site')).toMatchObject({ own: false })
    expect((await h.mailer.setAccount('site', 'smtps://nouser@h')).ok).toBe(false)
  })
})

const TRUSTED = { trusted_recipients: { 'romeo@acme.ro': 2, 'contabil@acme.ro': 1 }, unattended_per_day: 3 }
const REPORT = { to: ['romeo@acme.ro'], subject: 'Raport zilnic', text: 'Totul e în regulă.' }

describe('unasked mail to trusted recipients', () => {
  it('goes at once while every count has room, then asks, counting recipients', async () => {
    const h = harness(TRUSTED)
    await h.mailer.setAccount('site', URL_TEXT)
    expect(await h.ask('a', REPORT)).toMatchObject({ ok: true, unasked: true })
    expect(await h.send('a', REPORT)).toBe('Sent unasked (trusted recipients) to romeo@acme.ro (<m1@acme.ro>).')
    expect(h.audit[0]!.details).toMatchObject({ ok: true, path: 'unasked', addresses: ['romeo@acme.ro'] })
    // One mail to two people uses two of the total.
    const both = { ...REPORT, to: ['romeo@acme.ro', 'contabil@acme.ro'] }
    expect((await h.ask('b', both)).unasked).toBe(true)
    await h.send('b', both)
    expect(h.mailer.counts('site')).toEqual({ total: 3, unattended: 3, byAddress: new Map([['romeo@acme.ro', 2], ['contabil@acme.ro', 1]]) })
    // romeo's own count is used: asked, and said why.
    const third = await h.ask('c', REPORT)
    expect(third.unasked).toBeUndefined()
    expect(third.text).toContain('Asked because romeo@acme.ro already got 2 unasked mail(s) in the last 24 hours, its limit')
    // An approved mail does not use a trusted count, but the total ceiling holds.
    await h.send('c', REPORT)
    expect(await h.mailer.decideOutbox(1, 'approve', 'ana', h.mail)).toBe('Mail #1 of site was sent to romeo@acme.ro.')
    expect(h.mailer.counts('site').unattended).toBe(3)
  })

  it('asks for a mail with any recipient not trusted, and refuses past a limit with on_limit block', async () => {
    const h = harness({ ...TRUSTED, on_limit: 'block' })
    await h.mailer.setAccount('site', URL_TEXT)
    const mixed = await h.ask('a', { ...REPORT, cc: ['ana@acme.ro'] })
    expect(mixed).toMatchObject({ ok: true })
    expect(mixed.unasked).toBeUndefined()
    expect(mixed.text.startsWith('from:')).toBe(true)
    await h.ask('b', REPORT)
    await h.send('b', REPORT)
    await h.ask('c', REPORT)
    await h.send('c', REPORT)
    expect(await h.ask('d', REPORT)).toEqual({ ok: false, text: expect.stringContaining('mail.on_limit is block, so nobody is asked') })
  })

  it('checks the counts again when sending: two calls checked together cannot both pass', async () => {
    const h = harness({ trusted_recipients: { 'romeo@acme.ro': 1 } })
    await h.mailer.setAccount('site', URL_TEXT)
    expect((await h.ask('a', REPORT)).unasked).toBe(true)
    expect((await h.ask('b', REPORT)).unasked).toBe(true)
    expect(await h.send('a', REPORT)).toContain('Sent unasked')
    expect(await h.send('b', REPORT)).toContain('since it was checked. Send it again to be asked about it.')
    expect(h.sent).toHaveLength(1)
  })

  it('pauses and resumes, for a project or all, and pauses itself after 3 failures in a row', async () => {
    const told: string[] = []
    const h = harness(TRUSTED, { paused: (projectId, why) => void told.push(`${projectId}: ${why}`) })
    await h.mailer.setAccount('site', URL_TEXT)
    h.mailer.pause('site', 'admin')
    expect((await h.ask('a', REPORT)).text).toContain('Asked because unasked mail is paused')
    h.mailer.resume(null, 'admin')
    expect((await h.ask('b', REPORT)).unasked).toBe(true)
    h.mailer.pause(null, 'admin')
    expect(h.mailer.pausedOf('site')).toEqual({ paused: true, auto: false })
    h.mailer.resume('site', 'admin')
    expect(h.mailer.pausedOf('site').paused).toBe(false)

    h.failWith(new Error('454 relay refused'))
    const big = harness({ trusted_recipients: { 'romeo@acme.ro': 10 } }, { paused: (projectId, why) => void told.push(`${projectId}: ${why}`) })
    await big.mailer.setAccount('site', URL_TEXT)
    big.failWith(new Error('454 relay refused'))
    for (const id of ['1', '2', '3']) {
      expect((await big.ask(id, REPORT)).unasked).toBe(true)
      expect(await big.send(id, REPORT)).toContain('454 relay refused')
    }
    expect(big.mailer.pausedOf('site')).toEqual({ paused: true, auto: true })
    expect(told).toEqual(['site: its last 3 unasked mails failed at the mail server'])
    expect((await big.ask('4', REPORT)).unasked).toBeUndefined()
    // Resumed, the count starts again: one more failure does not pause it.
    big.mailer.resume('site', 'admin')
    await big.ask('5', REPORT)
    await big.send('5', REPORT)
    expect(big.mailer.pausedOf('site').paused).toBe(false)
  })
})

describe('a reply', () => {
  const ORIGINAL: OriginalMail = { address: 'ana@client.com', subject: 'Comanda 17', messageId: '<c17@client.com>', references: ['<c16@client.com>'], headers: {} }
  const replying = (original: OriginalMail | string) => harness({}, { original: async (_projectId, _settings, id) => (id === 'INBOX:7' ? original : 'No mail.') })

  it('goes to the sender only, with Re: and the thread\'s headers', async () => {
    const h = replying(ORIGINAL)
    await h.mailer.setAccount('site', URL_TEXT)
    const reply = { reply_to: 'INBOX:7', text: 'Am primit comanda.' }
    const asked = await h.ask('a', reply)
    expect(asked.text).toContain('to: ana@client.com\nsubject: Re: Comanda 17\na reply to INBOX:7')
    await h.approve('a', reply)
    expect(h.sent[0]).toMatchObject({ to: ['ana@client.com'], subject: 'Re: Comanda 17', inReplyTo: '<c17@client.com>', references: ['<c16@client.com>', '<c17@client.com>'] })
    expect((await h.ask('b', { ...reply, to: ['eve@client.com'] })).text).toContain('goes only to the sender of the mail it answers, ana@client.com')
    expect((await h.ask('c', { ...reply, cc: ['bob@client.com'] })).text).toContain('no cc or bcc')
    expect((await h.ask('d', { ...reply, reply_to: 'INBOX:8' })).text).toBe('No mail. Nothing was sent.')
  })

  it('is refused to an automatic mail, so two machines never answer each other', async () => {
    const h = replying({ ...ORIGINAL, headers: { 'auto-submitted': 'auto-replied' } })
    await h.mailer.setAccount('site', URL_TEXT)
    expect((await h.ask('a', { reply_to: 'INBOX:7', text: 'x' })).text).toContain('is not answered: it was sent automatically')
  })
})

describe('the route and the loop checks', () => {
  it('refuse past max_per_day whatever on_limit says', () => {
    const settings = parseMailBlock({ trusted_recipients: { 'a@x.ro': 5 }, max_per_day: 2 }).mail
    expect(routeMail(settings, ['a@x.ro'], { total: 2, unattended: 0, byAddress: new Map() }, false).kind).toBe('refuse')
    expect(routeMail(settings, ['a@x.ro'], { total: 1, unattended: 0, byAddress: new Map() }, false).kind).toBe('unasked')
  })

  it('tell an automatic, list, bulk, no-reply, Argus or own mail', () => {
    const mail = (address: string, headers: Record<string, string> = {}): OriginalMail => ({ address, subject: '', messageId: null, references: [], headers })
    const own = ['office@acme.ro']
    expect(loopReason(mail('ana@client.com'), own)).toBeUndefined()
    expect(loopReason(mail('ana@client.com', { 'auto-submitted': 'no' }), own)).toBeUndefined()
    expect(loopReason(mail('ana@client.com', { 'list-id': '<x.lists>' }), own)).toContain('mailing list')
    expect(loopReason(mail('ana@client.com', { precedence: 'Bulk' }), own)).toContain('bulk')
    expect(loopReason(mail('ana@client.com', { 'x-argus-project': 'other' }), own)).toContain('by Argus')
    for (const sender of ['noreply@x.ro', 'no-reply@x.ro', 'MAILER-DAEMON@x.ro', 'bounces+abc@x.ro']) expect(loopReason(mail(sender.toLowerCase()), own)).toContain('no replies')
    expect(loopReason(mail('office@acme.ro'), own)).toContain('own address')
  })
})
