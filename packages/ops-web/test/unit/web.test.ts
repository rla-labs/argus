// == ARGUS AGENT PROJECT ==
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { OpsStore } from '@argus-agent/store'
import { hashPassword, verifyPassword, WebAuth, WebChannelAdapter, webOf } from '@argus-agent/web'

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
