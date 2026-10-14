// == ARGUS AGENT PROJECT ==
/** Unit tests for the web logins and sessions. */
import { describe, expect, it } from 'vitest'
import { openMemoryStore, T0 } from '../helpers.js'

const session = (id: string, userId: string, expiresAt: number) => ({
  id_hash: id,
  user_id: userId,
  via: 'link' as const,
  created_at: T0,
  expires_at: expiresAt,
  last_seen_at: T0,
  user_agent: null,
})

describe('WebAuthRepository', () => {
  it('keeps one login name per user, unique without regard to case', () => {
    const store = openMemoryStore()
    store.users.create({ id: 'a', role: 'admin' }, T0)
    store.users.create({ id: 'b', role: 'operator' }, T0)
    expect(store.webAuth.setLogin({ userId: 'a', login: 'Ana', passwordHash: 'h1' }, T0)).toBe(true)
    expect(store.webAuth.setLogin({ userId: 'b', login: 'ana', passwordHash: 'h2' }, T0)).toBe(false)
    expect(store.webAuth.loginByName('ANA')?.user_id).toBe('a')

    store.webAuth.setFailures('a', 5, T0 + 1)
    expect(store.webAuth.login('a')).toMatchObject({ failed_count: 5, locked_until: T0 + 1 })
    // A new password clears the failures.
    expect(store.webAuth.setLogin({ userId: 'a', login: 'ana', passwordHash: 'h3' }, T0 + 2)).toBe(true)
    expect(store.webAuth.login('a')).toMatchObject({ login: 'ana', password_hash: 'h3', failed_count: 0, locked_until: null })
    expect(store.webAuth.deleteLogin('a')).toBe(true)
    expect(store.webAuth.login('a')).toBeUndefined()
  })

  it('keeps a second factor: a step works once, a recovery code once', () => {
    const store = openMemoryStore()
    store.users.create({ id: 'a', role: 'admin' }, T0)
    expect(store.webAuth.totp('a')).toBeUndefined()
    store.webAuth.setTotp({ user_id: 'a', secret: 'S', recovery: '["r1","r2"]', last_step: 0, enabled_at: T0 })
    expect(store.webAuth.useTotpStep('a', 10)).toBe(true)
    expect(store.webAuth.useTotpStep('a', 10)).toBe(false)
    expect(store.webAuth.useTotpStep('a', 9)).toBe(false)
    expect(store.webAuth.replaceRecovery('a', '["r1","r2"]', '["r2"]')).toBe(true)
    expect(store.webAuth.replaceRecovery('a', '["r1","r2"]', '["r2"]')).toBe(false)
    expect(store.webAuth.totp('a')).toMatchObject({ secret: 'S', recovery: '["r2"]', last_step: 10 })
    expect(store.webAuth.deleteTotp('a')).toBe(true)
    expect(store.webAuth.totp('a')).toBeUndefined()
  })

  it('stores sessions, ends all of a user\'s but one, and prunes the expired', () => {
    const store = openMemoryStore()
    store.users.create({ id: 'a', role: 'admin' }, T0)
    for (const id of ['s1', 's2', 's3']) store.webAuth.createSession(session(id, 'a', T0 + 10))
    store.webAuth.touchSession('s1', T0 + 5)
    expect(store.webAuth.session('s1')?.last_seen_at).toBe(T0 + 5)
    expect(store.webAuth.deleteUserSessions('a', 's1')).toBe(2)
    expect(store.webAuth.session('s2')).toBeUndefined()
    expect(store.webAuth.pruneSessions(T0 + 11)).toBe(1)
    expect(store.webAuth.session('s1')).toBeUndefined()
  })
})
