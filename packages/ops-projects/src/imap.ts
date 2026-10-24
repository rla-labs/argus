// == ARGUS AGENT PROJECT ==
/**
 * The mailbox session over IMAP: imapflow to talk, mailparser to read a mail. TLS only,
 * the server's certificate checked, short timeouts; one connection per tool call.
 *
 * @module @argus-agent/projects/imap
 */
import { ImapFlow, type MessageAddressObject, type MessageStructureObject } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import type { MailboxAccount, MailboxConnect, MailboxSession, MailSummary } from './mailbox.js'

/** Fetching a mail's source never takes longer than this. */
const TIMEOUT_MS = 30_000

/** The addresses of an envelope field, as a line. */
function addresses(list: readonly MessageAddressObject[] | undefined): string {
  return (list ?? []).map((entry) => (entry.name !== undefined && entry.name !== '' ? `${entry.name} <${entry.address ?? ''}>` : entry.address ?? '')).join(', ')
}

/** A parsed address header, as a line. */
function parsedAddresses(value: AddressObject | AddressObject[] | undefined): string {
  if (value === undefined) return ''
  return (Array.isArray(value) ? value : [value]).map((entry) => entry.text).join(', ')
}

/** The attachments in a body structure: parts with a file name or an attachment disposition. */
export function countAttachments(node: MessageStructureObject | undefined): number {
  if (node === undefined) return 0
  if (node.childNodes !== undefined && node.childNodes.length > 0) return node.childNodes.reduce((sum, child) => sum + countAttachments(child), 0)
  const named = node.dispositionParameters?.['filename'] ?? node.parameters?.['name']
  return node.disposition === 'attachment' || (named !== undefined && node.disposition !== 'inline') ? 1 : 0
}

/** Open a session with imapflow. */
export const imapConnect: MailboxConnect = async (account: MailboxAccount): Promise<MailboxSession> => {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    servername: account.host,
    auth: { user: account.user, pass: account.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  })
  await client.connect()

  /** Do something with a folder open read-only, or read-write to change a flag. */
  const inFolder = async <T>(folder: string, write: boolean, work: () => Promise<T>): Promise<T> => {
    const lock = await client.getMailboxLock(folder, { readOnly: !write })
    try {
      return await work()
    } finally {
      lock.release()
    }
  }

  return {
    list: (folder, query) =>
      inFolder(folder, false, async () => {
        const found = await client.search(
          { ...(query.unreadOnly ? { seen: false } : { all: true }), ...(query.since === null ? {} : { since: query.since }), ...(query.from === null ? {} : { from: query.from }) },
          { uid: true },
        )
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, query.limit)
        if (uids.length === 0) return []
        const mails: MailSummary[] = []
        for await (const message of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true })) {
          const date = message.envelope?.date
          mails.push({
            uid: message.uid,
            date: date === undefined ? null : new Date(date),
            from: addresses(message.envelope?.from),
            subject: message.envelope?.subject ?? '',
            size: message.size ?? 0,
            seen: message.flags?.has('\\Seen') === true,
            attachments: countAttachments(message.bodyStructure),
          })
        }
        return mails.sort((a, b) => b.uid - a.uid)
      }),
    size: (folder, uid) =>
      inFolder(folder, false, async () => {
        const message = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true })
        return message === false ? undefined : (message.size ?? 0)
      }),
    read: (folder, uid) =>
      inFolder(folder, false, async () => {
        // Read-only and BODY.PEEK: reading a mail does not mark it as read.
        const message = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
        if (message === false || message.source === undefined) return undefined
        const parsed = await simpleParser(message.source, { skipImageLinks: true, skipTextLinks: true })
        return {
          from: parsedAddresses(parsed.from),
          to: parsedAddresses(parsed.to),
          cc: parsedAddresses(parsed.cc),
          date: parsed.date ?? null,
          subject: parsed.subject ?? '',
          text: parsed.text ?? '',
          attachments: parsed.attachments.filter((file) => !file.related).map((file) => ({ name: file.filename ?? '', type: file.contentType, content: file.content })),
        }
      }),
    markSeen: (folder, uid) => inFolder(folder, true, () => client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })),
    close: () => client.logout(),
  }
}
