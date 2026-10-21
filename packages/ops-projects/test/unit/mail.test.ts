// == ARGUS AGENT PROJECT ==
/**
 * send_mail's checks and sending: the project's settings, the account URL, the
 * attachments (inside the folder, no link, under the limit), the daily limit, the mail a
 * person approved and nothing else, and an audit that never holds the password.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mailSecretName, parseMailAccount, parseMailBlock, ProjectMailer, transportOptions, type MailAccount, type ProjectMail } from '../../src/mail.js'

const PASSWORD = 'pa55-w0rd-SECRET'
const URL_TEXT = `smtps://office%40acme.ro:${PASSWORD}@mail.acme.ro:465`

describe('a project\'s mail block', () => {
  it('has safe defaults, and refuses what it cannot use', () => {
    expect(parseMailBlock(undefined)).toEqual({ mail: { from: null, allowed_recipients: [], max_per_day: 20, max_attachment_mb: 20 }, issues: [] })
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

/** A mailer over memory: secrets, an audit log, and a transport that records. */
function harness(settings: Partial<ProjectMail> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mail-project-'))
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
      byAction: (action, limit) => audit.filter((row) => row.action === action).slice(-limit).map((row) => ({ ts: row.ts, target: row.target, details_json: JSON.stringify(row.details) })),
    },
    () => ({
      sendMail: async (message) => {
        if (fail !== undefined) throw fail
        sent.push(message)
        return { messageId: `<m${sent.length}@acme.ro>` }
      },
    }),
    (name) => name,
  )
  const mail: ProjectMail = { from: null, allowed_recipients: ['ana@acme.ro', '@client.com'], max_per_day: 20, max_attachment_mb: 1, ...settings }
  const ask = async (callId: string, args: Record<string, unknown>) => mailer.preview('site', callId, cwd, mail, args)
  const send = async (callId: string, args: Record<string, unknown>) => mailer.send('site', callId, cwd, mail, args)
  return { cwd, values, audit, sent, mailer, ask, send, failWith: (error: Error) => void (fail = error) }
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

    expect(await h.send('c1', MAIL)).toBe('Sent to ana@acme.ro, bob@client.com (<m1@acme.ro>).')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ from: 'office@acme.ro', to: ['ana@acme.ro'], cc: ['bob@client.com'], subject: 'Raport Q3', text: MAIL.text })
    expect(String((h.sent[0]!['attachments'] as Array<{ content: Buffer }>)[0]!.content)).toBe('PDF-1')
    expect(h.audit).toEqual([expect.objectContaining({ action: 'mail.send', target: 'site', details: expect.objectContaining({ ok: true, recipients: 2, attachments: [{ name: 'report.pdf', size: 5 }] }) })])
    expect(JSON.stringify(h.audit)).not.toContain(PASSWORD)
    expect(JSON.stringify(h.audit)).not.toContain('Raport Q3')
    expect(JSON.stringify(h.audit)).not.toContain('raportul')
  })

  it('sends nothing nobody was shown, nor a mail whose attachment changed after it was shown', async () => {
    const h = harness()
    await h.mailer.setAccount(null, URL_TEXT)
    mkdirSync(join(h.cwd, 'out'))
    writeFileSync(join(h.cwd, 'out', 'report.pdf'), 'PDF-1')
    expect(await h.send('c0', MAIL)).toContain('only after a person approved the mail')
    expect((await h.ask('c1', MAIL)).ok).toBe(true)
    writeFileSync(join(h.cwd, 'out', 'report.pdf'), 'PDF-2, swapped')
    expect(await h.send('c1', MAIL)).toContain('changed after it was approved (report.pdf): nothing was sent')
    // The approval is used once.
    expect(await h.send('c1', MAIL)).toContain('only after a person approved')
    expect(h.sent).toHaveLength(0)
  })

  it('refuses before any question a recipient not allowed, an attachment outside the folder, a link, too large, and no account', async () => {
    const h = harness()
    expect((await h.ask('c1', { ...MAIL, attachments: [] })).text).toContain('no mail account')
    await h.mailer.setAccount('site', URL_TEXT)
    expect((await h.ask('c2', { ...MAIL, attachments: [], to: ['eve@evil.com'] })).text).toContain('Not in mail.allowed_recipients of this project: eve@evil.com')
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

  it('holds the daily limit, counting only mails that went', async () => {
    const h = harness({ max_per_day: 2 })
    await h.mailer.setAccount('site', URL_TEXT)
    const one = { ...MAIL, attachments: [] }
    for (const id of ['a', 'b']) {
      await h.ask(id, one)
      expect(await h.send(id, one)).toContain('Sent to')
    }
    expect((await h.ask('c', one)).text).toContain('sent 2 mail(s) in the last 24 hours, its limit')
    expect(h.mailer.sentToday('site')).toBe(2)
  })

  it('reports a server\'s refusal without the password', async () => {
    const h = harness()
    await h.mailer.setAccount('site', URL_TEXT)
    h.failWith(new Error(`535 Authentication failed for office@acme.ro:${PASSWORD}`))
    const one = { ...MAIL, attachments: [] }
    await h.ask('c1', one)
    const said = await h.send('c1', one)
    expect(said).toContain('535 Authentication failed')
    expect(said).not.toContain(PASSWORD)
    expect(JSON.stringify(h.audit)).not.toContain(PASSWORD)
    expect(h.audit[0]!.details['ok']).toBe(false)
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
