// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the ownership map and the delivery capability.
 *
 * `ownerOf` is what every attribution question resolves through, so the parent
 * walk and the unknown-session behavior are asserted directly.
 */
import { describe, expect, it } from 'vitest'
import { adhocOwner, OpsError, projectOwner } from '@argus-agent/types'
import { OwnershipMap } from '../../src/ownership.js'
import { CapabilityIssuer, GOVERNOR_PLUGIN } from '../../src/capability.js'

describe('OwnershipMap', () => {
  it('resolves a directly registered session', () => {
    const map = new OwnershipMap()
    map.register('s1', projectOwner('a'))
    expect(map.ownerOf('s1')).toEqual({ kind: 'project', projectId: 'a' })
    expect(map.resolve('s1')).toEqual({ owner: { kind: 'project', projectId: 'a' }, runId: undefined })
  })

  it('returns undefined for an unknown session rather than throwing', () => {
    const map = new OwnershipMap()
    expect(map.ownerOf('nope')).toBeUndefined()
    expect(map.resolve('nope')).toBeUndefined()
    expect(map.rootOf('nope')).toBeUndefined()
    expect(map.runOf('nope')).toBeUndefined()
  })

  it('resolves a child through an explicit parent link', () => {
    const map = new OwnershipMap()
    map.register('parent', projectOwner('a'))
    map.linkChild('child', 'parent')
    expect(map.ownerOf('child')).toEqual({ kind: 'project', projectId: 'a' })
  })

  it('resolves a child through a session-header lookup', () => {
    const map = new OwnershipMap()
    map.register('root', projectOwner('a'))
    // The header path is what makes the walk survive a restart: the child was
    // never registered in this process.
    const headers: Record<string, string | undefined> = { grandchild: 'child', child: 'root' }
    expect(map.ownerOf('grandchild')).toBeUndefined()
    expect(map.resolve('grandchild', (id) => headers[id])?.owner).toEqual({
      kind: 'project',
      projectId: 'a',
    })
  })

  it('walks a deep chain', () => {
    const map = new OwnershipMap()
    map.register('root', adhocOwner('run-1'))
    const headers: Record<string, string> = { a: 'b', b: 'c', c: 'root' }
    expect(map.resolve('a', (id) => headers[id])?.owner).toEqual({ kind: 'adhoc', runId: 'run-1' })
  })

  it('stops on a cycle instead of hanging', () => {
    const map = new OwnershipMap()
    const headers: Record<string, string> = { a: 'b', b: 'a' }
    expect(map.resolve('a', (id) => headers[id])).toBeUndefined()
  })

  it('returns undefined when the chain is broken', () => {
    const map = new OwnershipMap()
    // The child's parent exists in the header but is not registered here.
    expect(map.resolve('child', (id) => (id === 'child' ? 'absent' : undefined))).toBeUndefined()
  })

  it('attributes a child to its root run', () => {
    const map = new OwnershipMap()
    map.register('root', projectOwner('a'), 'run-1')
    map.linkChild('child', 'root')
    // A subagent's usage belongs to the parent's run.
    expect(map.runOf('child')).toBe('run-1')
    expect(map.runOf('root')).toBe('run-1')
  })

  it('records a run for a session whose owner is not registered yet', () => {
    const map = new OwnershipMap()
    // A meter can see usage before the agent is registered.
    map.setRun('late', 'run-9')
    expect(map.runOf('late')).toBe('run-9')
    expect(map.resolve('late')?.runId).toBe('run-9')
  })

  it('clears a run', () => {
    const map = new OwnershipMap()
    map.register('s1', projectOwner('a'), 'run-1')
    map.clearRun('s1')
    expect(map.runOf('s1')).toBeUndefined()
    expect(map.ownerOf('s1')).toEqual({ kind: 'project', projectId: 'a' })
  })

  it('keeps the parent link when a session is unregistered', () => {
    const map = new OwnershipMap()
    map.register('parent', projectOwner('a'))
    map.linkChild('child', 'parent')
    map.unregister('parent')
    // The parent's owner is gone, so the child no longer resolves — but the walk
    // terminates rather than throwing.
    expect(map.ownerOf('child')).toBeUndefined()
  })

  it('invalidates a cached child resolution when the root registers', () => {
    const map = new OwnershipMap()
    map.linkChild('child', 'root')
    expect(map.ownerOf('child')).toBeUndefined()
    // A walk performed before the root existed must not be cached forever.
    map.register('root', projectOwner('a'))
    expect(map.ownerOf('child')).toEqual({ kind: 'project', projectId: 'a' })
  })

  it('lists entries and reports its size', () => {
    const map = new OwnershipMap()
    map.register('s1', projectOwner('a'), 'run-1')
    map.register('s2', adhocOwner('run-2'))
    expect(map.size).toBe(2)
    expect(map.entries().map((entry) => entry.ownerKey).sort()).toEqual(['adhoc:run-2', 'project:a'])
  })

  it('clears everything', () => {
    const map = new OwnershipMap()
    map.register('s1', projectOwner('a'))
    map.linkChild('c', 's1')
    map.setRun('x', 'run')
    map.clear()
    expect(map.size).toBe(0)
    expect(map.ownerOf('s1')).toBeUndefined()
    expect(map.runOf('x')).toBeUndefined()
  })

  it('keys two ad-hoc tasks separately', () => {
    const map = new OwnershipMap()
    map.register('s1', adhocOwner('run-1'))
    map.register('s2', adhocOwner('run-2'))
    expect(map.ownerOf('s1')).toEqual({ kind: 'adhoc', runId: 'run-1' })
    expect(map.ownerOf('s2')).toEqual({ kind: 'adhoc', runId: 'run-2' })
  })
})

describe('CapabilityIssuer', () => {
  it('issues one token and accepts it', () => {
    const issuer = new CapabilityIssuer()
    const token = issuer.claim()
    expect(() => issuer.assertCapability(token, GOVERNOR_PLUGIN)).not.toThrow()
  })

  it('refuses a second claim', () => {
    const issuer = new CapabilityIssuer()
    issuer.claim()
    // Only one governor may exist per process; a second is a configuration bug.
    expect(() => issuer.claim('another')).toThrow(OpsError)
    try {
      issuer.claim('another')
    } catch (error) {
      expect(OpsError.hasCode(error, 'INVALID_CAPABILITY')).toBe(true)
    }
  })

  it('rejects a forged or absent token', () => {
    const issuer = new CapabilityIssuer()
    issuer.claim()

    for (const candidate of [undefined, null, {}, { scope: 'deliver' }, Symbol('x')]) {
      try {
        issuer.assertCapability(candidate, 'ops-telegram')
        throw new Error('expected a throw')
      } catch (error) {
        expect(OpsError.hasCode(error, 'GOVERNOR_REQUIRED')).toBe(true)
      }
    }
  })

  it('names the caller in the rejection', () => {
    const issuer = new CapabilityIssuer()
    issuer.claim()
    try {
      issuer.assertCapability({}, 'ops-telegram')
    } catch (error) {
      expect((error as OpsError).message).toContain('ops-telegram')
      expect((error as OpsError).message).toContain('opsGovernor.submit()')
      expect((error as OpsError).details['caller']).toBe('ops-telegram')
    }
  })

  it('rejects a token from a previous issuer', () => {
    const first = new CapabilityIssuer()
    const stale = first.claim()
    // A new instance is what an HMR reload produces; a stale holder must not be
    // able to deliver through the new service.
    const second = new CapabilityIssuer()
    second.claim()
    expect(() => second.assertCapability(stale, GOVERNOR_PLUGIN)).toThrow(OpsError)
  })

  it('rejects every token after revokeAll', () => {
    const issuer = new CapabilityIssuer()
    const token = issuer.claim()
    issuer.revokeAll()
    expect(() => issuer.assertCapability(token, GOVERNOR_PLUGIN)).toThrow(OpsError)
  })

  it('rejects any token when nothing was ever issued', () => {
    const issuer = new CapabilityIssuer()
    try {
      issuer.assertCapability(undefined, 'ops-channel')
    } catch (error) {
      expect(OpsError.hasCode(error, 'GOVERNOR_REQUIRED')).toBe(true)
      expect((error as OpsError).message).toContain('must claim it at load')
    }
  })
})
