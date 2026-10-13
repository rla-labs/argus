// == ARGUS AGENT PROJECT ==
/** Unit tests for users, identities and the seed from `ops.yaml`. */
import { describe, expect, it } from 'vitest'
import { openMemoryStore, T0 } from '../helpers.js'

const ids = (): (() => string) => {
  let next = 0
  return () => `u${(next += 1)}`
}

describe('UsersRepository', () => {
  it('keeps exactly one enabled admin: a new admin demotes the old one', () => {
    const store = openMemoryStore()
    store.users.create({ id: 'a', role: 'admin' }, T0)
    store.users.create({ id: 'b', role: 'admin' }, T0)
    expect(store.users.admin()?.id).toBe('b')
    expect(store.users.get('a')?.role).toBe('operator')
    store.users.setRole('a', 'admin')
    expect(store.users.admin()?.id).toBe('a')
    expect(store.users.get('b')?.role).toBe('operator')
  })

  it('refuses a second enabled admin written behind its back', () => {
    const store = openMemoryStore()
    store.users.create({ id: 'a', role: 'admin' }, T0)
    expect(() => store.db.prepare("INSERT INTO users (id, role, created_at) VALUES ('b', 'admin', 0)").run()).toThrow(/UNIQUE/)
  })

  it('resolves an identity on its channel, else a `*` one; never moves a linked one', () => {
    const store = openMemoryStore()
    store.users.create({ id: 'a', role: 'operator' }, T0)
    store.users.create({ id: 'b', role: 'operator' }, T0)
    expect(store.users.link({ channel: '*', external_id: '42', user_id: 'a' }, T0)).toBe(true)
    expect(store.users.resolve('telegram', '42')?.user_id).toBe('a')
    expect(store.users.link({ channel: 'telegram', external_id: '42', user_id: 'b' }, T0)).toBe(true)
    expect(store.users.resolve('telegram', '42')?.user_id).toBe('b')
    expect(store.users.link({ channel: 'telegram', external_id: '42', user_id: 'a' }, T0)).toBe(false)
    expect(store.users.resolve('telegram', '4')).toBeUndefined()
  })
})

describe('OpsStore.seedUsers', () => {
  const seed = {
    admin: { channel: 'telegram', externalId: '100', kind: 'user' as const },
    operators: [
      { channel: 'telegram', externalId: '100' },
      { channel: 'telegram', externalId: '200' },
      { channel: '*', externalId: '300' },
    ],
  }

  it('makes the admin and one operator per other identity, and is idempotent', () => {
    const store = openMemoryStore()
    expect(store.seedUsers(seed, T0, ids())).toEqual({ created: 3, adminChanged: true })
    expect(store.users.admin()?.id).toBe('u1')
    expect(store.users.identities('u1')).toMatchObject([{ channel: 'telegram', external_id: '100', kind: 'user' }])
    expect(store.users.resolve('telegram', '200')?.user_id).toBe('u2')
    expect(store.users.get('u2')?.role).toBe('operator')
    expect(store.users.resolve('telegram', '300')?.user_id).toBe('u3')

    expect(store.seedUsers(seed, T0 + 1, ids())).toEqual({ created: 0, adminChanged: false })
    expect(store.users.list()).toHaveLength(3)
  })

  it('leaves a user changed since alone', () => {
    const store = openMemoryStore()
    store.seedUsers(seed, T0, ids())
    store.users.disable('u2', T0 + 1)
    store.seedUsers(seed, T0 + 2, ids())
    expect(store.users.get('u2')?.disabled_at).toBe(T0 + 1)
  })

  it('a new access.admin becomes the admin; the old one stays, as an operator', () => {
    const store = openMemoryStore()
    store.seedUsers(seed, T0, ids())
    // An operator named admin: promoted.
    expect(store.seedUsers({ ...seed, admin: { channel: 'telegram', externalId: '200', kind: 'user' } }, T0, ids()).adminChanged).toBe(true)
    expect(store.users.admin()?.id).toBe('u2')
    expect(store.users.get('u1')?.role).toBe('operator')
    // An unknown identity named admin: a new admin user.
    const result = store.seedUsers({ admin: { channel: 'telegram', externalId: '-100999', kind: 'chat' }, operators: [] }, T0, () => 'g')
    expect(result).toEqual({ created: 1, adminChanged: true })
    expect(store.users.admin()?.id).toBe('g')
    expect(store.users.identities('g')[0]?.kind).toBe('chat')
  })
})
