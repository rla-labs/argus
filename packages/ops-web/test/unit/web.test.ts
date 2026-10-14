// == ARGUS AGENT PROJECT ==
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpsStore } from '@argus-agent/store'
import { ADMIN_LINK_REQUEST, base32, codeAt, hashPassword, matchStep, publicDoctor, SETUP_LINK_FILE, SETUP_TTL_MS, SetupGate, stepAt, verifyPassword, WebAuth, WebChannelAdapter, webOf } from '@argus-agent/web'

function storeWith(): OpsStore {
  const store = new OpsStore({ path: ':memory:' })
  stores.push(store)
  store.users.create({ id: 'u1', role: 'admin' }, 0)
  store.users.create({ id: 'u2', role: 'operator' }, 0)
  return store
}
const stores: OpsStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/** Sign in with a link and return the cookie value. */
function linkSession(auth: WebAuth, userId = 'u1'): string {
  const login = auth.login(auth.issueToken(userId), 'a')
  if (!login.ok) throw new Error('link refused')
  return login.sessionId
}

describe('WebAuth', () => {
  it('trades a token for a session once, and only before it expires', () => {
    let now = 1_000
    const store = storeWith()
    const auth = new WebAuth(store, 60_000, () => now)
    const token = auth.issueToken('u1')
    const first = auth.login(token, 'a')
    expect(first.ok).toBe(true)
    expect(auth.login(token, 'a')).toEqual({ ok: false, reason: 'invalid' })
    const session = first.ok ? first.sessionId : ''
    expect(auth.session(session)).toMatchObject({ userId: 'u1', via: 'link' })
    // Signing in makes the web one of the user's channels.
    expect(store.users.identity('web', 'u1')?.user_id).toBe('u1')
    now += 61_000
    expect(auth.session(session)).toBeUndefined()

    const late = auth.issueToken('u1')
    now += 11 * 60_000
    expect(auth.login(late, 'b').ok).toBe(false)
  })

  it('stops an address after five failed sign-ins', () => {
    const auth = new WebAuth(storeWith(), 60_000)
    for (let i = 0; i < 5; i++) expect(auth.login(`wrong-${i}`, 'x')).toEqual({ ok: false, reason: 'invalid' })
    const token = auth.issueToken('u1')
    expect(auth.login(token, 'x')).toEqual({ ok: false, reason: 'limited' })
    expect(auth.login(token, 'elsewhere').ok).toBe(true)
  })

  it('keeps sessions in the store: a new instance knows them, the store never holds the cookie', () => {
    const store = storeWith()
    const id = linkSession(new WebAuth(store, 60_000))
    const restarted = new WebAuth(store, 60_000)
    expect(restarted.session(id)?.userId).toBe('u1')
    expect(JSON.stringify(store.db.prepare('SELECT * FROM web_sessions').all())).not.toContain(id)
    restarted.logout(id)
    expect(restarted.session(id)).toBeUndefined()
  })

  it('refuses a disabled user\'s link and session', () => {
    const store = storeWith()
    const auth = new WebAuth(store, 60_000)
    const id = linkSession(auth, 'u2')
    const token = auth.issueToken('u2')
    store.users.disable('u2', 1)
    expect(auth.session(id)).toBeUndefined()
    expect(auth.login(token, 'a').ok).toBe(false)
  })

  it('sets a first password from a link, then signs in with it, any case of the name', async () => {
    const auth = new WebAuth(storeWith(), 60_000)
    const id = linkSession(auth)
    expect(await auth.setPassword(id, { login: 'Ana', password: 'short' })).toEqual({ ok: false, reason: 'short' })
    expect(await auth.setPassword(id, { login: 'a b', password: 'long enough pw' })).toEqual({ ok: false, reason: 'login' })
    expect(await auth.setPassword(id, { login: 'Ana', password: 'long enough pw' })).toEqual({ ok: true })
    expect(auth.loginOf('u1')).toBe('Ana')
    expect((await auth.loginWithPassword('ana', 'long enough pw', 'a')).ok).toBe(true)
    expect(await auth.loginWithPassword('ana', 'wrong password', 'a')).toEqual({ ok: false, reason: 'invalid' })
    // An unknown name gets the same answer as a wrong password.
    expect(await auth.loginWithPassword('nobody', 'long enough pw', 'a')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a login name another user has', async () => {
    const auth = new WebAuth(storeWith(), 60_000)
    expect(await auth.setPassword(linkSession(auth, 'u1'), { login: 'ana', password: 'long enough pw' })).toEqual({ ok: true })
    expect(await auth.setPassword(linkSession(auth, 'u2'), { login: 'ANA', password: 'long enough pw' })).toEqual({ ok: false, reason: 'taken' })
  })

  it('locks a user for a quarter of an hour after five wrong passwords', async () => {
    let now = 0
    const auth = new WebAuth(storeWith(), 3_600_000, () => now)
    await auth.setPassword(linkSession(auth), { login: 'ana', password: 'long enough pw' })
    // Five addresses, so only the per-user rule applies.
    for (let i = 0; i < 5; i++) expect((await auth.loginWithPassword('ana', 'wrong password', `x${i}`)).ok).toBe(false)
    expect(await auth.loginWithPassword('ana', 'long enough pw', 'y')).toEqual({ ok: false, reason: 'limited' })
    now += 15 * 60_000 + 1
    expect((await auth.loginWithPassword('ana', 'long enough pw', 'y')).ok).toBe(true)
  })

  it('changes a password with the current one, or without it only within ten minutes of a link; others are signed out', async () => {
    let now = 0
    const auth = new WebAuth(storeWith(), 3_600_000, () => now)
    const link = linkSession(auth)
    await auth.setPassword(link, { login: 'ana', password: 'first password' })
    const viaPassword = await auth.loginWithPassword('ana', 'first password', 'a')
    const other = viaPassword.ok ? viaPassword.sessionId : ''
    const session = auth.session(other)!
    expect(auth.mayResetPassword(session)).toBe(false)
    expect(await auth.setPassword(other, { password: 'second password' })).toEqual({ ok: false, reason: 'wrong' })
    expect(await auth.setPassword(other, { password: 'second password', current: 'nope' })).toEqual({ ok: false, reason: 'wrong' })
    expect(await auth.setPassword(other, { password: 'second password', current: 'first password' })).toEqual({ ok: true })
    // The link session was another session: it is gone.
    expect(auth.session(link)).toBeUndefined()
    expect(auth.session(other)).toBeDefined()

    // A fresh link resets a forgotten password, but only for ten minutes.
    const reset = linkSession(auth)
    expect(await auth.setPassword(reset, { password: 'third password' })).toEqual({ ok: true })
    now += 11 * 60_000
    expect(await auth.setPassword(reset, { password: 'fourth password' })).toEqual({ ok: false, reason: 'wrong' })
    expect((await auth.loginWithPassword('ana', 'third password', 'b')).ok).toBe(true)
  })
})

describe('TOTP', () => {
  // RFC 6238, appendix B, SHA-1, the last six of eight digits.
  const secret = base32(Buffer.from('12345678901234567890'))
  it('matches the RFC test vectors', () => {
    expect(codeAt(secret, stepAt(59_000))).toBe('287082')
    expect(codeAt(secret, stepAt(1_111_111_109_000))).toBe('081804')
    expect(codeAt(secret, stepAt(1_234_567_890_000))).toBe('005924')
    expect(codeAt(secret, stepAt(20_000_000_000_000))).toBe('353130')
  })
  it('accepts one step either side, and nothing else', () => {
    const now = 1_234_567_890_000
    const step = stepAt(now)
    expect(matchStep(secret, codeAt(secret, step - 1), now)).toBe(step - 1)
    expect(matchStep(secret, ` ${codeAt(secret, step + 1).slice(0, 3)} ${codeAt(secret, step + 1).slice(3)} `, now)).toBe(step + 1)
    expect(matchStep(secret, codeAt(secret, step + 2), now)).toBeUndefined()
    expect(matchStep(secret, 'abcdef', now)).toBeUndefined()
  })
})

describe('WebAuth with a second factor', () => {
  async function enrolled(now: { value: number }, idleMs = 0): Promise<{ auth: WebAuth; store: OpsStore; secret: string; recovery: string[] }> {
    const store = storeWith()
    const auth = new WebAuth(store, 3_600_000, () => now.value, idleMs)
    const { secret, uri } = auth.startTotp('u1')
    expect(uri).toMatch(/^otpauth:\/\/totp\/Argus%3Au1\?secret=/)
    expect(auth.confirmTotp('u1', 'nope')).toBeUndefined()
    const recovery = auth.confirmTotp('u1', codeAt(secret, stepAt(now.value))) ?? []
    expect(recovery).toHaveLength(10)
    return { auth, store, secret, recovery }
  }

  it('asks a link and a password for the code, which works once per step', async () => {
    const now = { value: 1_700_000_000_000 }
    const { auth, store, secret } = await enrolled(now)
    const first = auth.login(auth.issueToken('u1'), 'a')
    expect(first).toMatchObject({ ok: false, reason: 'totp' })
    const ticket = first.ok || first.reason !== 'totp' ? '' : first.ticket
    // The setup spent this step's code.
    expect(auth.verifyTicket(ticket, codeAt(secret, stepAt(now.value)), 'a').ok).toBe(false)
    now.value += 30_000
    expect(auth.verifyTicket(ticket, codeAt(secret, stepAt(now.value)), 'a')).toMatchObject({ ok: true, session: { via: 'link' } })
    // A ticket works once.
    expect(auth.verifyTicket(ticket, codeAt(secret, stepAt(now.value)), 'a').ok).toBe(false)

    store.webAuth.setLogin({ userId: 'u1', login: 'ana', passwordHash: await hashPassword('a long password') }, now.value)
    const byPassword = await auth.loginWithPassword('ana', 'a long password', 'b')
    expect(byPassword).toMatchObject({ ok: false, reason: 'totp' })
  })

  it('takes each recovery code once, drops a ticket after five wrong codes, and ends an idle session', async () => {
    const now = { value: 1_700_000_000_000 }
    const { auth, recovery } = await enrolled(now, 30 * 60_000)
    const ticketOf = (): string => {
      const outcome = auth.login(auth.issueToken('u1'), 'a')
      return outcome.ok || outcome.reason !== 'totp' ? '' : outcome.ticket
    }
    const ticket = ticketOf()
    for (let i = 0; i < 4; i += 1) expect(auth.verifyTicket(ticket, '000000', `x${i}`).ok).toBe(false)
    expect(auth.verifyTicket(ticket, recovery[0] ?? '', 'y').ok).toBe(true)
    const used = ticketOf()
    expect(auth.verifyTicket(used, recovery[0] ?? '', 'z').ok).toBe(false)
    const spent = ticketOf()
    for (let i = 0; i < 5; i += 1) auth.verifyTicket(spent, '000000', `w${i}`)
    expect(auth.verifyTicket(spent, (recovery[1] ?? '').toUpperCase(), 'v').ok).toBe(false)
    const fresh = auth.verifyTicket(ticketOf(), (recovery[1] ?? '').toUpperCase().replace('-', ' '), 'v')
    expect(fresh.ok).toBe(true)
    const sessionId = fresh.ok ? fresh.sessionId : ''
    now.value += 29 * 60_000
    expect(auth.session(sessionId)).toBeDefined()
    now.value += 31 * 60_000
    expect(auth.session(sessionId)).toBeUndefined()
  })

  it('removes it with a code, and the admin recovery link removes it with none', async () => {
    const now = { value: 1_700_000_000_000 }
    const { auth, recovery } = await enrolled(now)
    expect(auth.disableTotp('u1', 'wrong')).toBe(false)
    expect(auth.disableTotp('u1', recovery[2] ?? '')).toBe(true)
    expect(auth.hasTotp('u1')).toBe(false)
    const again = await enrolled(now)
    expect(again.auth.login(again.auth.issueToken('u1', 60_000, true), 'a').ok).toBe(true)
    expect(again.auth.hasTotp('u1')).toBe(false)
  })
})

describe('publicDoctor', () => {
  it('says nothing in private mode, and fails without https or the admin\'s code', () => {
    expect(publicDoctor(false, false, () => false)).toEqual([])
    expect(publicDoctor(true, true, () => true).every((finding) => finding.ok)).toBe(true)
    const failing = publicDoctor(true, false, () => false)
    expect(failing.map((finding) => finding.ok)).toEqual([false, false])
    expect(failing[0]?.fix).toContain('https://')
  })
})

describe('passwords', () => {
  it('hash with a salt and verify', async () => {
    const one = await hashPassword('long enough pw')
    expect(one).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(await hashPassword('long enough pw')).not.toBe(one)
    expect(await verifyPassword('long enough pw', one)).toBe(true)
    expect(await verifyPassword('long enough pX', one)).toBe(false)
    expect(await verifyPassword('long enough pw', 'garbage')).toBe(false)
  })
})

describe('the languages', () => {
  it('give every language exactly the English keys', () => {
    const load = (code: string): Record<string, string> => JSON.parse(readFileSync(new URL(`../../public/locales/${code}.json`, import.meta.url), 'utf8')) as Record<string, string>
    const english = Object.keys(load('en')).sort()
    for (const code of ['ro']) expect(Object.keys(load(code)).sort(), code).toEqual(english)
  })
})

describe('webOf', () => {
  it('defaults to loopback and a local link, and trims a trailing slash', () => {
    expect(webOf({})).toMatchObject({ enabled: true, port: 3091, public_url: 'http://127.0.0.1:3091' })
    expect(webOf({ web: { public_url: 'https://argus.tail1234.ts.net/' } }).public_url).toBe('https://argus.tail1234.ts.net')
  })
})

describe('WebChannelAdapter', () => {
  it('keeps a person\'s conversation, answers its own question by a press, and serves only their files', async () => {
    const changed: string[] = []
    const chat = new WebChannelAdapter((id) => changed.push(id), storeWith().webChat)
    const received: string[] = []
    const buttons: string[] = []
    await chat.start((message) => received.push(message.text), (answer) => buttons.push(answer.value))

    chat.receive('42', '/status')
    expect(received).toEqual(['/status'])
    await chat.send({ channel: 'web', chatId: '42' }, { text: 'here', files: [{ name: 'a.zip', bytes: new Uint8Array([1]) }] })
    const asked = chat.ask({ channel: 'web', chatId: '42' }, { id: 'q1', text: 'Run it?', buttons: [{ value: 'approve', label: 'Approve' }] })
    const question = chat.history('42').at(-1)
    expect(chat.press('42', question?.id ?? '', 'nope')).toBe(false)
    expect(chat.press('42', question?.id ?? '', 'approve')).toBe(true)
    expect(await asked).toEqual({ kind: 'button', value: 'approve' })
    expect(buttons).toEqual(['approve'])
    expect(chat.history('42').at(-1)?.answered).toBe('approve')

    const fileId = chat.history('42')[1]?.files?.[0]?.id ?? ''
    expect(chat.file('42', fileId)?.name).toBe('a.zip')
    expect(chat.file('7', fileId)).toBeUndefined()
    expect(chat.history('7')).toEqual([])
    expect(new Set(changed)).toEqual(new Set(['42']))
  })

  it('answers timeout when nobody presses in time', async () => {
    const chat = new WebChannelAdapter(() => undefined, storeWith().webChat)
    await chat.start(() => undefined, () => undefined)
    expect(await chat.ask({ channel: 'web', chatId: '42' }, { id: 'q', text: '?', buttons: [{ value: 'a', label: 'A' }], timeoutMs: 10 })).toBe('timeout')
    expect(chat.history('42')[0]?.answered).toBe('timeout')
  })

  it('closes a question answered on another channel: no buttons, a note, no press', async () => {
    const chat = new WebChannelAdapter(() => undefined, storeWith().webChat)
    await chat.start(() => undefined, () => undefined)
    const question = { id: 'q', text: '?', buttons: [{ value: 'a', label: 'A' }], timeoutMs: 60_000 }
    const asked = chat.ask({ channel: 'web', chatId: '42' }, question)
    await chat.closeQuestion(question, 'Answered by 7 on telegram: A')
    expect(await asked).toBe('timeout')
    const entry = chat.history('42')[0]
    expect(entry?.note).toBe('Answered by 7 on telegram: A')
    expect(chat.press('42', entry?.id ?? '', 'a')).toBe(false)
  })

  it('keeps the conversation and its files across a restart, and closes the questions left open', async () => {
    const store = storeWith()
    const first = new WebChannelAdapter(() => undefined, store.webChat)
    await first.start(() => undefined, () => undefined)
    await first.send({ channel: 'web', chatId: 'u1' }, { text: 'report', files: [{ name: 'r.txt', bytes: new TextEncoder().encode('hi') }] })
    void first.ask({ channel: 'web', chatId: 'u1' }, { id: 'q', text: 'Run it?', buttons: [{ value: 'a', label: 'A' }] })

    const second = new WebChannelAdapter(() => undefined, store.webChat)
    await second.start(() => undefined, () => undefined)
    const [report, question] = second.history('u1')
    expect(report?.text).toBe('report')
    expect(Buffer.from(second.file('u1', report?.files?.[0]?.id ?? '')?.bytes ?? []).toString()).toBe('hi')
    expect(question).toMatchObject({ text: 'Run it?', answered: 'timeout', buttons: [{ value: 'a', label: 'A' }] })
    expect(second.press('u1', question?.id ?? '', 'a')).toBe(false)
  })

  it('counts what Argus said that the person has not seen', async () => {
    const changed: string[] = []
    const chat = new WebChannelAdapter((id) => changed.push(id), storeWith().webChat)
    await chat.start(() => undefined, () => undefined)
    chat.receive('u1', 'hello')
    await chat.send({ channel: 'web', chatId: 'u1' }, { text: 'one' })
    await chat.send({ channel: 'web', chatId: 'u1' }, { text: 'two' })
    expect(chat.unread('u1')).toBe(2)
    changed.length = 0
    chat.markRead('u1')
    expect(chat.unread('u1')).toBe(0)
    expect(changed).toEqual(['u1'])
    // Nothing new: no change to announce, so an open page does not loop.
    chat.markRead('u1')
    expect(changed).toEqual(['u1'])
  })
})

describe('SetupGate', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const stateDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-web-setup-'))
    dirs.push(dir)
    return join(dir, 'state')
  }
  const tokenIn = (dir: string): string => /token=([\w-]+)/.exec(readFileSync(join(dir, SETUP_LINK_FILE), 'utf8'))?.[1] ?? ''
  const admin = { name: 'Ana', login: 'ana', password: 'a long password' }

  it('with no admin, writes a one-time link (mode 600) that creates the admin once', async () => {
    const store = new OpsStore({ path: ':memory:' })
    stores.push(store)
    const dir = stateDir()
    const gate = new SetupGate(store, new WebAuth(store, 60_000), dir, 'http://x')
    expect(gate.refresh()).toBe('setup')
    expect(statSync(join(dir, SETUP_LINK_FILE)).mode & 0o777).toBe(0o600)
    const token = tokenIn(dir)
    expect(gate.valid(token)).toBe(true)
    expect(gate.valid('nope')).toBe(false)
    expect(await gate.complete(token, { ...admin, password: 'short' })).toEqual({ ok: false, reason: 'short' })
    expect(await gate.complete(token, { ...admin, login: 'a b' })).toEqual({ ok: false, reason: 'login' })
    const done = await gate.complete(token, admin)
    expect(done.ok).toBe(true)
    const created = store.users.admin()
    expect(created?.name).toBe('Ana')
    expect(store.webAuth.loginByName('ana')?.user_id).toBe(created?.id)
    expect(existsSync(join(dir, SETUP_LINK_FILE))).toBe(false)
    // Spent, and closed: there is an admin now.
    expect(gate.open).toBe(false)
    expect(await gate.complete(token, { ...admin, login: 'eve' })).toEqual({ ok: false, reason: 'invalid' })
    expect(gate.refresh()).toBeUndefined()
  })

  it('expires after an hour, and a refresh replaces the link', () => {
    let now = 0
    const store = new OpsStore({ path: ':memory:' })
    stores.push(store)
    const dir = stateDir()
    const gate = new SetupGate(store, new WebAuth(store, 60_000, () => now), dir, 'http://x', () => now)
    gate.refresh()
    const first = tokenIn(dir)
    now = SETUP_TTL_MS + 1
    expect(gate.valid(first)).toBe(false)
    gate.refresh()
    expect(tokenIn(dir)).not.toBe(first)
    expect(gate.valid(tokenIn(dir))).toBe(true)
  })

  it('with an admin, writes the admin a sign-in link only when one was asked for', () => {
    const store = storeWith()
    const dir = stateDir()
    const auth = new WebAuth(store, 60_000)
    const gate = new SetupGate(store, auth, dir, 'http://x')
    expect(gate.refresh()).toBeUndefined()
    expect(existsSync(join(dir, SETUP_LINK_FILE))).toBe(false)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ADMIN_LINK_REQUEST), '')
    expect(gate.refresh()).toBe('admin')
    expect(existsSync(join(dir, ADMIN_LINK_REQUEST))).toBe(false)
    expect(readFileSync(join(dir, SETUP_LINK_FILE), 'utf8')).toMatch(/^http:\/\/x\/login\?token=/)
    const login = auth.login(tokenIn(dir), 'a')
    expect(login.ok && login.session.userId).toBe('u1')
    // A link session may set a new password without the old one.
    expect(login.ok && auth.mayResetPassword(login.session)).toBe(true)
    // The next start removes the spent link.
    expect(gate.refresh()).toBeUndefined()
    expect(existsSync(join(dir, SETUP_LINK_FILE))).toBe(false)
  })
})
