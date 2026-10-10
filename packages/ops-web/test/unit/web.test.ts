// == ARGUS AGENT PROJECT ==
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WebAuth, WebChannelAdapter, webOf } from '@argus-agent/web'

describe('WebAuth', () => {
  it('trades a token for a session once, and only before it expires', () => {
    let now = 1_000
    const auth = new WebAuth(60_000, () => now)
    const token = auth.issueToken('42')
    const first = auth.login(token, 'a')
    expect(first.ok).toBe(true)
    expect(auth.login(token, 'a')).toEqual({ ok: false, reason: 'invalid' })
    const session = first.ok ? first.sessionId : ''
    expect(auth.session(session)?.userId).toBe('42')
    now += 61_000
    expect(auth.session(session)).toBeUndefined()

    const late = auth.issueToken('42')
    now += 11 * 60_000
    expect(auth.login(late, 'b').ok).toBe(false)
  })

  it('stops an address after five failed logins', () => {
    const auth = new WebAuth(60_000)
    for (let i = 0; i < 5; i++) expect(auth.login(`wrong-${i}`, 'x')).toEqual({ ok: false, reason: 'invalid' })
    const token = auth.issueToken('42')
    expect(auth.login(token, 'x')).toEqual({ ok: false, reason: 'limited' })
    expect(auth.login(token, 'elsewhere').ok).toBe(true)
  })

  it('ends a session on logout', () => {
    const auth = new WebAuth(60_000)
    const login = auth.login(auth.issueToken('42'), 'a')
    const id = login.ok ? login.sessionId : ''
    auth.logout(id)
    expect(auth.session(id)).toBeUndefined()
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
    const chat = new WebChannelAdapter((id) => changed.push(id))
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
    const chat = new WebChannelAdapter(() => undefined)
    await chat.start(() => undefined, () => undefined)
    expect(await chat.ask({ channel: 'web', chatId: '42' }, { id: 'q', text: '?', buttons: [{ value: 'a', label: 'A' }], timeoutMs: 10 })).toBe('timeout')
    expect(chat.history('42')[0]?.answered).toBe('timeout')
  })
})
