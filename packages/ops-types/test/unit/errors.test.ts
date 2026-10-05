// == ARGUS AGENT PROJECT ==
/**
 * Tests for the error hierarchy.
 *
 * Codes are the machine-readable contract every caller branches on, so the
 * guard helpers and the normalization boundary are asserted directly.
 */
import { describe, expect, it } from 'vitest'
import { opsAssert, opsError, OpsError } from '../../src/index.js'

describe('OpsError', () => {
  it('carries a stable code, a message and frozen details', () => {
    const error = new OpsError('BUDGET_EXCEEDED', 'daily budget spent', { scope: 'project:a', limit: 5 })
    expect(error.code).toBe('BUDGET_EXCEEDED')
    expect(error.message).toBe('daily budget spent')
    expect(error.details).toEqual({ scope: 'project:a', limit: 5 })
    expect(Object.isFrozen(error.details)).toBe(true)
    expect(error.name).toBe('OpsError')
    expect(error).toBeInstanceOf(Error)
  })

  it('defaults details to an empty object', () => {
    expect(new OpsError('INTERNAL', 'boom').details).toEqual({})
  })

  it('does not leak the caller\'s mutable details object', () => {
    const details = { a: 1 }
    const error = new OpsError('INTERNAL', 'x', details)
    details.a = 2
    expect(error.details['a']).toBe(1)
  })

  it('matches one exact code with hasCode', () => {
    const error = new OpsError('PROJECT_NOT_FOUND', 'nope')
    expect(OpsError.hasCode(error, 'PROJECT_NOT_FOUND')).toBe(true)
    expect(OpsError.hasCode(error, 'PROJECT_NOT_ACTIVE')).toBe(false)
    expect(OpsError.hasCode(new Error('x'), 'PROJECT_NOT_FOUND')).toBe(false)
    expect(OpsError.hasCode(undefined, 'PROJECT_NOT_FOUND')).toBe(false)
  })

  it('narrows with is()', () => {
    expect(OpsError.is(new OpsError('INTERNAL', 'x'))).toBe(true)
    expect(OpsError.is(new Error('x'))).toBe(false)
    expect(OpsError.is('x')).toBe(false)
  })

  it('returns the original from from()', () => {
    const original = new OpsError('BUDGET_EXCEEDED', 'spent')
    expect(OpsError.from(original)).toBe(original)
  })

  it('normalizes a plain Error, preserving its message and name', () => {
    const error = OpsError.from(new TypeError('bad input'))
    expect(error.code).toBe('INTERNAL')
    expect(error.message).toBe('bad input')
    expect(error.details['cause']).toBe('TypeError')
  })

  it('normalizes a non-Error throw', () => {
    const error = OpsError.from('something went wrong')
    expect(error.code).toBe('INTERNAL')
    expect(error.message).toBe('something went wrong')
  })

  it('accepts a fallback code for a non-OpsError', () => {
    expect(OpsError.from(new Error('x'), 'STORE_ERROR').code).toBe('STORE_ERROR')
  })

  it('serializes to a structured log line', () => {
    const json = new OpsError('UNPRICED_MODEL', 'no price', { model: 'x/y' }).toJSON()
    expect(json).toEqual({ code: 'UNPRICED_MODEL', message: 'no price', details: { model: 'x/y' } })
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })
})

describe('opsError', () => {
  it('throws an OpsError with the given code', () => {
    expect(() => opsError('COMMAND_USAGE', 'usage: /p <id>')).toThrow(OpsError)
    try {
      opsError('COMMAND_USAGE', 'usage: /p <id>', { command: '/p' })
    } catch (error) {
      expect(OpsError.hasCode(error, 'COMMAND_USAGE')).toBe(true)
      expect((error as OpsError).details).toEqual({ command: '/p' })
    }
  })
})

describe('opsAssert', () => {
  it('passes a truthy condition through', () => {
    expect(() => opsAssert(true, 'INTERNAL', 'unreachable')).not.toThrow()
    const value: unknown = 'text'
    opsAssert(typeof value === 'string', 'INTERNAL', 'expected a string')
    // The assertion narrowed the type, so this compiles without a cast.
    expect(value.toUpperCase()).toBe('TEXT')
  })

  it('throws the requested code for a falsy condition', () => {
    try {
      opsAssert(false, 'ACCESS_DENIED', 'not allowed', { userId: 'u1' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(OpsError.hasCode(error, 'ACCESS_DENIED')).toBe(true)
      expect((error as OpsError).details).toEqual({ userId: 'u1' })
    }
  })

  it('treats an empty string and zero as falsy', () => {
    expect(() => opsAssert('', 'INTERNAL', 'empty')).toThrow()
    expect(() => opsAssert(0, 'INTERNAL', 'zero')).toThrow()
  })
})
