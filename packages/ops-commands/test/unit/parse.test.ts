// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the command parsers.
 *
 * Every case states the input and the expected outcome, including the exact
 * message for a failure — a parse error's whole job is to show the correct
 * syntax, so the message is part of the contract.
 */
import { describe, expect, it } from 'vitest'
import {
  formatAge,
  formatDuration,
  formatUsd,
  isValidProjectId,
  parseDuration,
  parseModelRef,
  parseMoney,
  parsePeriod,
  parseScope,
  renderTable,
  restAfter,
  tokenize,
  truncate,
} from '../../src/parse.js'

describe('tokenize', () => {
  const cases: Array<[string, string, string[]]> = [
    ['empty input', '', []],
    ['whitespace only', '   ', []],
    ['one token', 'site', ['site']],
    ['two tokens', 'site deepseek/flash', ['site', 'deepseek/flash']],
    ['extra whitespace', '  site   deepseek/flash  ', ['site', 'deepseek/flash']],
    ['tabs and newlines', 'a\tb\nc', ['a', 'b', 'c']],
    ['double quotes group', '"a b" c', ['a b', 'c']],
    ['single quotes group', "'a b' c", ['a b', 'c']],
    ['an empty quoted token', '"" x', ['', 'x']],
    ['quotes inside a token', 'a"b"c', ['abc']],
    ['an unterminated quote still yields the text', '"abc', ['abc']],
  ]

  it.each(cases)('%s', (_name, input, expected) => {
    expect(tokenize(input)).toEqual(expected)
  })
})

describe('restAfter', () => {
  it('returns the whole input when nothing is skipped', () => {
    expect(restAfter('hello world', 0)).toBe('hello world')
  })

  it('trims leading whitespace only', () => {
    expect(restAfter('   hello world  ', 0)).toBe('hello world  ')
  })

  it('skips leading tokens', () => {
    expect(restAfter('site do the thing', 1)).toBe('do the thing')
  })

  it('preserves the text exactly, including internal spacing', () => {
    // The reason `/task` uses this: a user who typed two spaces meant them.
    expect(restAfter('site a  b   c', 1)).toBe('a  b   c')
  })

  it('preserves newlines inside the text', () => {
    expect(restAfter('site line one\nline two', 1)).toBe('line one\nline two')
  })

  it('returns an empty string when there is nothing left', () => {
    expect(restAfter('site', 1)).toBe('')
    expect(restAfter('a b', 5)).toBe('')
  })

  it('skips several tokens', () => {
    expect(restAfter('a b c d', 3)).toBe('d')
  })
})

describe('parseDuration', () => {
  const okCases: Array<[string, number]> = [
    ['90s', 90_000],
    ['30m', 1_800_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['1w', 604_800_000],
    ['30', 1_800_000],
    ['1.5h', 5_400_000],
    ['2H', 7_200_000],
    [' 30m ', 1_800_000],
  ]

  it.each(okCases)('parses %s', (input, expected) => {
    const parsed = parseDuration(input)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.ms).toBe(expected)
  })

  const failCases: Array<[string, string]> = [
    ['', 'is not a duration'],
    ['soon', 'is not a duration'],
    ['30x', 'is not a duration'],
    ['-5m', 'is not a duration'],
    ['0m', 'greater than zero'],
    ['0', 'greater than zero'],
    ['400d', 'longer than a year'],
  ]

  it.each(failCases)('rejects %s', (input, fragment) => {
    const parsed = parseDuration(input)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain(fragment)
  })

  it('shows the accepted forms in the message', () => {
    const parsed = parseDuration('nope')
    expect(parsed.ok === false && parsed.message).toContain('90s, 30m, 2h, 1d')
  })
})

describe('parseMoney', () => {
  const okCases: Array<[string, number]> = [
    ['2', 2_000_000],
    ['2.5', 2_500_000],
    ['$2', 2_000_000],
    ['$2.50', 2_500_000],
    ['0', 0],
    ['0.000001', 1],
    ['100', 100_000_000],
  ]

  it.each(okCases)('parses %s', (input, expected) => {
    const parsed = parseMoney(input)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toBe(expected)
  })

  const failCases = ['', 'abc', '$-2', '-2', '2.1234567', '$', '2,5']

  it.each(failCases)('rejects %s', (input) => {
    expect(parseMoney(input).ok).toBe(false)
  })

  it('shows the accepted forms in the message', () => {
    const parsed = parseMoney('abc')
    expect(parsed.ok === false && parsed.message).toContain('2, 2.5 or $2.50')
  })

  it('is exact for a fractional cent', () => {
    let total = 0
    for (let index = 0; index < 1000; index += 1) {
      const parsed = parseMoney('0.001')
      if (parsed.ok) total += parsed.value
    }
    expect(total).toBe(1_000_000)
  })
})

describe('parseModelRef', () => {
  it('splits at the first slash', () => {
    const parsed = parseModelRef('anthropic/claude-sonnet-x')
    expect(parsed).toEqual({ ok: true, value: { provider: 'anthropic', model: 'claude-sonnet-x', text: 'anthropic/claude-sonnet-x' } })
  })

  it('keeps slashes inside the model id', () => {
    // OpenRouter-style ids contain slashes; splitting anywhere else would name
    // the wrong provider.
    const parsed = parseModelRef('openrouter/deepseek/deepseek-v4.1-flash')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.provider).toBe('openrouter')
      expect(parsed.value.model).toBe('deepseek/deepseek-v4.1-flash')
    }
  })

  const failCases = ['', 'noslash', '/model', 'provider/', 'a b/c', 'a/b c']

  it.each(failCases)('rejects %s', (input) => {
    expect(parseModelRef(input).ok).toBe(false)
  })

  it('shows the accepted form in the message', () => {
    const parsed = parseModelRef('bad')
    expect(parsed.ok === false && parsed.message).toContain('provider/model')
  })
})

describe('parsePeriod', () => {
  const cases: Array<[string, 'day' | 'month' | undefined]> = [
    ['day', 'day'],
    ['today', 'day'],
    ['d', 'day'],
    ['DAY', 'day'],
    ['month', 'month'],
    ['m', 'month'],
    [' year ', undefined],
    ['', undefined],
  ]

  it.each(cases)('parses %s', (input, expected) => {
    expect(parsePeriod(input)).toBe(expected)
  })
})

describe('isValidProjectId', () => {
  it('accepts a valid id', () => {
    expect(isValidProjectId('site')).toBe(true)
    expect(isValidProjectId('site-firma')).toBe(true)
    expect(isValidProjectId('a1')).toBe(true)
  })

  it('rejects what the loader would reject', () => {
    // Kept in step with ops-projects: a command that accepted an id the loader
    // refuses would write a file that fails the next reload.
    for (const bad of ['', 'a', 'Site', '-x', 'x_y', '../etc', 'x'.repeat(42)]) {
      expect(isValidProjectId(bad), bad).toBe(false)
    }
  })
})

describe('parseScope', () => {
  it('parses global', () => {
    const parsed = parseScope('global')
    expect(parsed).toEqual({ ok: true, value: { scope: 'global', global: true, adhoc: false, projectId: undefined } })
  })

  it('accepts aliases for global', () => {
    for (const alias of ['global', 'all', 'GLOBAL']) {
      const parsed = parseScope(alias)
      expect(parsed.ok, alias).toBe(true)
      if (parsed.ok) expect(parsed.value.scope).toBe('global')
    }
  })

  it('parses adhoc', () => {
    for (const alias of ['adhoc', 'task', 'tasks']) {
      const parsed = parseScope(alias)
      expect(parsed.ok, alias).toBe(true)
      if (parsed.ok) expect(parsed.value.scope).toBe('adhoc')
    }
  })

  it('parses a bare project id', () => {
    const parsed = parseScope('site-firma')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.scope).toBe('project:site-firma')
      expect(parsed.value.projectId).toBe('site-firma')
    }
  })

  it('accepts the explicit project: form', () => {
    // So an operator can copy a scope out of `/budget`'s output and paste it back.
    const parsed = parseScope('project:site-firma')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.scope).toBe('project:site-firma')
  })

  it('falls back to the active project', () => {
    const parsed = parseScope('', 'site-firma')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.scope).toBe('project:site-firma')
  })

  it('fails with no scope and no active project', () => {
    const parsed = parseScope('')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.message).toContain('/p <id>')
  })

  it('rejects an invalid scope', () => {
    const parsed = parseScope('BAD_SCOPE')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.message).toContain('global, adhoc')
  })
})

describe('formatUsd', () => {
  const cases: Array<[number, string]> = [
    [0, '0'],
    [1_000_000, '1.00'],
    [2_500_000, '2.50'],
    [10_000, '0.01'],
    [1_500, '0.0015'],
    [100, '0.0001'],
    [1, '0.000001'],
  ]

  it.each(cases)('formats %s micro-USD as %s', (micros, expected) => {
    expect(formatUsd(micros)).toBe(expected)
  })

  it('does not round a small amount to zero', () => {
    // A metered deployment deals in fractions of a cent; `$0.00` is useless.
    expect(formatUsd(1)).not.toBe('0.00')
  })
})

describe('formatDuration', () => {
  const cases: Array<[number, string]> = [
    [0, '0s'],
    [30_000, '30s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [90_000, '1m'],
    [3_600_000, '1h'],
    [5_400_000, '1h 30m'],
    [86_400_000, '1d'],
    [93_600_000, '1d 2h'],
    [-5, '0s'],
  ]

  it.each(cases)('formats %s ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe('formatAge', () => {
  it('renders an age', () => {
    expect(formatAge(0, 90_000)).toBe('1m ago')
  })

  it('never renders a negative age', () => {
    // A clock skew must not produce "-5s ago".
    expect(formatAge(1_000, 0)).toBe('0s ago')
  })
})

describe('renderTable', () => {
  it('pads every column but the last', () => {
    const lines = renderTable([
      ['A', 'B'],
      ['longer', 'x'],
    ])
    expect(lines).toEqual(['A       B', 'longer  x'])
  })

  it('handles an empty table', () => {
    expect(renderTable([])).toEqual([])
  })

  it('handles rows of differing length', () => {
    const lines = renderTable([['A', 'B', 'C'], ['x']])
    expect(lines).toHaveLength(2)
  })

  it('trims trailing whitespace', () => {
    const lines = renderTable([['A', 'B'], ['x', '']])
    expect(lines[1]).toBe('x')
  })
})

describe('truncate', () => {
  it('leaves a short string alone', () => {
    expect(truncate('abc', 5)).toBe('abc')
  })

  it('truncates with an ellipsis', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…')
  })

  it('never exceeds the maximum', () => {
    for (const max of [1, 2, 5, 10]) {
      expect(truncate('x'.repeat(100), max).length).toBeLessThanOrEqual(max)
    }
  })
})
