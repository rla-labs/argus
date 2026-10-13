// == ARGUS AGENT PROJECT ==
/** Unit tests for the web chat's history. */
import { describe, expect, it } from 'vitest'
import { openMemoryStore, T0 } from '../helpers.js'

const entry = (id: string, sender: 'you' | 'argus' = 'argus', extra: Record<string, unknown> = {}) => ({ id, chat_id: 'u1', at: T0, sender, text: id, ...extra })

describe('WebChatRepository', () => {
  it('keeps a chat in order with its files, and drops the oldest past the cap, files included', () => {
    const store = openMemoryStore()
    store.webChat.append(entry('e1'), [{ id: 'f1', name: 'a.txt', mime_type: null, path: null, bytes: new Uint8Array([104, 105]) }], 2)
    store.webChat.append(entry('e2', 'you'), [], 2)
    expect(store.webChat.history('u1').map(({ row, files }) => [row.id, files.map((file) => file.name)])).toEqual([['e1', ['a.txt']], ['e2', []]])
    expect(Buffer.from(store.webChat.file('u1', 'f1')?.bytes ?? []).toString()).toBe('hi')
    // A file is only its own chat's.
    expect(store.webChat.file('u2', 'f1')).toBeUndefined()

    store.webChat.append(entry('e3'), [], 2)
    expect(store.webChat.history('u1').map(({ row }) => row.id)).toEqual(['e2', 'e3'])
    expect(store.webChat.file('u1', 'f1')).toBeUndefined()
  })

  it('updates, deletes, and closes the questions left open', () => {
    const store = openMemoryStore()
    store.webChat.append(entry('q', 'argus', { buttons_json: '[]', question_id: 'q1' }), [], 10)
    store.webChat.append(entry('done', 'argus', { buttons_json: '[]', question_id: 'q2' }), [], 10)
    store.webChat.update('done', { answered: 'approve' })
    store.webChat.update('q', { text: 'edited' })
    expect(store.webChat.entry('q')).toMatchObject({ text: 'edited', answered: null })
    expect(store.webChat.expireOpenQuestions()).toBe(1)
    expect(store.webChat.entry('q')?.answered).toBe('timeout')
    expect(store.webChat.entry('done')?.answered).toBe('approve')
    store.webChat.delete('q')
    expect(store.webChat.entry('q')).toBeUndefined()
  })

  it('counts what Argus said and the user has not seen', () => {
    const store = openMemoryStore()
    store.webChat.append(entry('a1'), [], 10)
    store.webChat.append(entry('y1', 'you'), [], 10)
    store.webChat.append(entry('a2'), [], 10)
    expect(store.webChat.unread('u1')).toBe(2)
    expect(store.webChat.markRead('u1', T0 + 1)).toBe(2)
    expect(store.webChat.unread('u1')).toBe(0)
  })
})
