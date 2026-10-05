// == ARGUS AGENT PROJECT ==
/**
 * Tests for the shared primitives.
 *
 * These are the types and constructors every other package depends on, so the
 * round-tripping and validation rules are asserted rather than assumed.
 */
import { describe, expect, it } from 'vitest'
import {
  addMicros,
  adhocOwner,
  addressesEqual,
  asPriority,
  BACKGROUND,
  decodeAddress,
  encodeAddress,
  formatModelRef,
  formatUsd,
  INTERACTIVE,
  isOwnerScope,
  micros,
  modelRefsEqual,
  ownersEqual,
  ownerKey,
  ownerLabel,
  parseModelRef,
  parseOwnerKey,
  parseScope,
  parseUsd,
  priorityName,
  projectIdOfScope,
  projectOwner,
  projectScope,
  SCHEDULED,
  scopeOfOwner,
  usd,
} from '../../src/index.js'

describe('scope', () => {
  it('builds and parses a project scope', () => {
    expect(projectScope('site-firma')).toBe('project:site-firma')
    expect(parseScope('project:site-firma')).toBe('project:site-firma')
    expect(projectIdOfScope('project:site-firma')).toBe('site-firma')
  })

  it('accepts the three fixed scopes', () => {
    expect(parseScope('global')).toBe('global')
    expect(parseScope('adhoc')).toBe('adhoc')
    expect(parseScope('orchestrator')).toBe('orchestrator')
  })

  it('rejects a malformed scope', () => {
    expect(parseScope('project:')).toBeUndefined()
    expect(parseScope('project')).toBeUndefined()
    expect(parseScope('project:a:b')).toBeUndefined()
    expect(parseScope('other:x')).toBeUndefined()
    expect(parseScope('')).toBeUndefined()
  })

  it('refuses to build a scope that would not parse back', () => {
    expect(() => projectScope('')).toThrow(TypeError)
    expect(() => projectScope('a:b')).toThrow(TypeError)
  })

  it('reports the project id only for project scopes', () => {
    expect(projectIdOfScope('global')).toBeUndefined()
    expect(projectIdOfScope('adhoc')).toBeUndefined()
  })

  it('separates the global scope from owner scopes', () => {
    // The distinction matters: a run is CHECKED against `global` but RECORDED
    // under its own scope. Conflating them would double-count in the rollups.
    expect(isOwnerScope('global')).toBe(false)
    expect(isOwnerScope('project:x')).toBe(true)
    expect(isOwnerScope('adhoc')).toBe(true)
    expect(isOwnerScope('orchestrator')).toBe(true)
  })
})

describe('owner', () => {
  it('maps each owner to its accounting scope', () => {
    expect(scopeOfOwner(projectOwner('a'))).toBe('project:a')
    expect(scopeOfOwner(adhocOwner('run-1'))).toBe('adhoc')
    expect(scopeOfOwner({ kind: 'orchestrator' })).toBe('orchestrator')
  })

  it('round-trips an owner through its key', () => {
    for (const owner of [projectOwner('a'), adhocOwner('run-1'), { kind: 'orchestrator' } as const]) {
      expect(parseOwnerKey(ownerKey(owner))).toEqual(owner)
    }
  })

  it('distinguishes two ad-hoc tasks, whose scope is shared', () => {
    const first = adhocOwner('run-1')
    const second = adhocOwner('run-2')
    expect(scopeOfOwner(first)).toBe(scopeOfOwner(second))
    expect(ownerKey(first)).not.toBe(ownerKey(second))
    expect(ownersEqual(first, second)).toBe(false)
  })

  it('rejects a malformed owner key', () => {
    expect(parseOwnerKey('project:')).toBeUndefined()
    expect(parseOwnerKey('adhoc:')).toBeUndefined()
    expect(parseOwnerKey('nonsense')).toBeUndefined()
    expect(parseOwnerKey('project:a:b')).toBeUndefined()
  })

  it('labels an owner for messages', () => {
    expect(ownerLabel(projectOwner('site'))).toBe('site')
    expect(ownerLabel(adhocOwner('r'))).toBe('task')
    expect(ownerLabel({ kind: 'orchestrator' })).toBe('orchestrator')
  })
})

describe('model refs', () => {
  it('round-trips provider/model', () => {
    const ref = { provider: 'anthropic', model: 'claude-sonnet-x' }
    expect(formatModelRef(ref)).toBe('anthropic/claude-sonnet-x')
    expect(parseModelRef('anthropic/claude-sonnet-x')).toEqual(ref)
  })

  it('splits on the first slash, so a slashed model id survives', () => {
    // A real case: OpenRouter-style ids carry a vendor prefix in the model name.
    expect(parseModelRef('openrouter/deepseek/deepseek-v4.1-flash')).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash',
    })
  })

  it('rejects a malformed reference', () => {
    expect(parseModelRef('noslash')).toBeUndefined()
    expect(parseModelRef('/model')).toBeUndefined()
    expect(parseModelRef('provider/')).toBeUndefined()
    expect(parseModelRef('')).toBeUndefined()
  })

  it('compares references', () => {
    expect(modelRefsEqual({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' })).toBe(true)
    expect(modelRefsEqual({ provider: 'a', model: 'b' }, { provider: 'a', model: 'c' })).toBe(false)
  })
})

describe('money', () => {
  it('converts dollars to integer micro-USD', () => {
    expect(usd(1)).toBe(1_000_000)
    expect(usd(2.5)).toBe(2_500_000)
    expect(usd(0.000001)).toBe(1)
    // Rounding is to the nearest micro-USD, not truncated.
    expect(usd(0.0000005)).toBe(1)
    expect(usd(0.0000004)).toBe(0)
  })

  it('admits only non-negative safe integers', () => {
    expect(micros(0)).toBe(0)
    expect(micros(1_000_000)).toBe(1_000_000)
    expect(() => micros(-1)).toThrow(TypeError)
    expect(() => micros(1.5)).toThrow(TypeError)
    expect(() => micros(Number.NaN)).toThrow(TypeError)
    expect(() => micros(Number.MAX_SAFE_INTEGER + 2)).toThrow(TypeError)
  })

  it('adds without losing precision', () => {
    // The reason money is integer micro-USD: 0.1 + 0.2 in floats is 0.30000000000000004.
    let total = micros(0)
    for (let index = 0; index < 10; index += 1) total = addMicros(total, usd(0.1))
    expect(total).toBe(1_000_000)
    expect(formatUsd(total)).toBe('$1.000000')
  })

  it('formats with six decimals so a sub-cent cost is never shown as zero', () => {
    expect(formatUsd(micros(1))).toBe('$0.000001')
    expect(formatUsd(micros(2_500_000))).toBe('$2.500000')
    expect(formatUsd(micros(2_500_000), { withSymbol: false })).toBe('2.500000')
    expect(formatUsd(micros(2_500_000), { decimals: 2 })).toBe('$2.50')
  })

  it('parses the amounts a person types in a command', () => {
    expect(parseUsd('2')).toBe(2_000_000)
    expect(parseUsd('2.5')).toBe(2_500_000)
    expect(parseUsd('$2')).toBe(2_000_000)
    expect(parseUsd('2 usd')).toBe(2_000_000)
    expect(parseUsd(' 3 ')).toBe(3_000_000)
  })

  it('rejects an unparseable amount rather than guessing', () => {
    expect(parseUsd('abc')).toBeUndefined()
    expect(parseUsd('-1')).toBeUndefined()
    expect(parseUsd('')).toBeUndefined()
    expect(parseUsd('1e6')).toBeUndefined()
  })
})

describe('channel addresses', () => {
  it('round-trips through storage', () => {
    const address = { channel: 'telegram', chatId: '123', threadId: '7' }
    expect(decodeAddress(encodeAddress(address))).toEqual(address)
  })

  it('omits an absent thread rather than storing null', () => {
    const address = { channel: 'telegram', chatId: '123' }
    expect(encodeAddress(address)).toBe('{"channel":"telegram","chatId":"123"}')
    expect(decodeAddress(encodeAddress(address))).toEqual(address)
  })

  it('rejects a malformed stored address', () => {
    expect(decodeAddress('not json')).toBeUndefined()
    expect(decodeAddress('{}')).toBeUndefined()
    expect(decodeAddress('{"channel":"","chatId":"1"}')).toBeUndefined()
    expect(decodeAddress('{"channel":"t"}')).toBeUndefined()
    expect(decodeAddress('{"channel":"t","chatId":"1","threadId":2}')).toBeUndefined()
    expect(decodeAddress('null')).toBeUndefined()
  })

  it('compares addresses, treating an absent thread as empty', () => {
    expect(addressesEqual({ channel: 't', chatId: '1' }, { channel: 't', chatId: '1' })).toBe(true)
    expect(addressesEqual({ channel: 't', chatId: '1' }, { channel: 't', chatId: '2' })).toBe(false)
    expect(addressesEqual({ channel: 't', chatId: '1' }, { channel: 't', chatId: '1', threadId: '2' })).toBe(false)
  })
})

describe('priority', () => {
  it('names the three levels', () => {
    expect(priorityName(INTERACTIVE)).toBe('interactive')
    expect(priorityName(SCHEDULED)).toBe('scheduled')
    expect(priorityName(BACKGROUND)).toBe('background')
  })

  it('admits only 0, 1 and 2', () => {
    expect(asPriority(0)).toBe(0)
    expect(asPriority(2)).toBe(2)
    expect(asPriority(3)).toBeUndefined()
    expect(asPriority(-1)).toBeUndefined()
    expect(asPriority(1.5)).toBeUndefined()
  })
})
