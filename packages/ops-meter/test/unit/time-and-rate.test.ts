// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for timezone-aware boundaries and the token rate window.
 *
 * The day boundary decides when a budget resets, so a DST mistake here is a
 * budget that resets an hour early or late — twice a year, in one timezone,
 * which is exactly the kind of bug that survives to production.
 */
import { describe, expect, it } from 'vitest'
import { daysBetween, TimezoneCalendar } from '../../src/time.js'
import { RateLimiter, TokenRateWindow, WINDOW_MS } from '../../src/rate-window.js'

const BUCHAREST = 'Europe/Bucharest'
/** Bucharest is UTC+3 in summer, UTC+2 in winter. */
const SUMMER = Date.parse('2026-07-15T12:00:00Z')
const WINTER = Date.parse('2026-01-15T12:00:00Z')

describe('TimezoneCalendar', () => {
  it('rejects an invalid timezone at construction', () => {
    // A typo must fail at boot, not at the first midnight.
    expect(() => new TimezoneCalendar('Not/AZone')).toThrow(RangeError)
  })

  it('reports the local calendar day', () => {
    const utc = new TimezoneCalendar('UTC')
    const bucharest = new TimezoneCalendar(BUCHAREST)
    // 22:00 UTC is already the next day in Bucharest (UTC+3 in July).
    const ts = Date.parse('2026-07-15T22:00:00Z')
    expect(utc.dayOf(ts)).toBe('2026-07-15')
    expect(bucharest.dayOf(ts)).toBe('2026-07-16')
  })

  it('handles the winter offset', () => {
    const bucharest = new TimezoneCalendar(BUCHAREST)
    // 21:00 UTC is 23:00 local in winter (UTC+2): same day.
    expect(bucharest.dayOf(Date.parse('2026-01-15T21:00:00Z'))).toBe('2026-01-15')
    // 22:00 UTC is midnight local: the next day.
    expect(bucharest.dayOf(Date.parse('2026-01-15T22:00:00Z'))).toBe('2026-01-16')
  })

  it('reports the month', () => {
    const utc = new TimezoneCalendar('UTC')
    expect(utc.monthOf(SUMMER)).toBe('2026-07')
    expect(utc.monthStart(SUMMER)).toBe('2026-07-01')
    expect(utc.monthEnd(SUMMER)).toBe('2026-07-31')
  })

  it('computes month ends, including February in a leap year', () => {
    const utc = new TimezoneCalendar('UTC')
    expect(utc.monthEnd(Date.parse('2024-02-10T00:00:00Z'))).toBe('2024-02-29')
    expect(utc.monthEnd(Date.parse('2026-02-10T00:00:00Z'))).toBe('2026-02-28')
    expect(utc.monthEnd(Date.parse('2000-02-10T00:00:00Z'))).toBe('2000-02-29')
    expect(utc.monthEnd(Date.parse('1900-02-10T00:00:00Z'))).toBe('1900-02-28')
  })

  it('computes a 30-day and a 31-day month end', () => {
    const utc = new TimezoneCalendar('UTC')
    expect(utc.monthEnd(Date.parse('2026-04-05T00:00:00Z'))).toBe('2026-04-30')
    expect(utc.monthEnd(Date.parse('2026-05-05T00:00:00Z'))).toBe('2026-05-31')
    expect(utc.monthEnd(Date.parse('2026-12-05T00:00:00Z'))).toBe('2026-12-31')
  })

  it('finds the next midnight', () => {
    const utc = new TimezoneCalendar('UTC')
    const ts = Date.parse('2026-07-15T12:00:00Z')
    const next = utc.nextMidnight(ts)
    expect(next).toBe(Date.parse('2026-07-16T00:00:00Z'))
    expect(utc.dayOf(next)).toBe('2026-07-16')
    // The instant before is still the previous day.
    expect(utc.dayOf(next - 1)).toBe('2026-07-15')
  })

  it('returns the next midnight when called exactly at midnight', () => {
    const utc = new TimezoneCalendar('UTC')
    const midnight = Date.parse('2026-07-16T00:00:00Z')
    expect(utc.nextMidnight(midnight)).toBe(Date.parse('2026-07-17T00:00:00Z'))
  })

  it('handles the 23-hour spring-forward day', () => {
    // Bucharest springs forward on 2026-03-29 at 03:00 local.
    const bucharest = new TimezoneCalendar(BUCHAREST)
    const midnight = Date.parse('2026-03-28T22:00:00Z') // 2026-03-29 00:00 local
    expect(bucharest.dayOf(midnight)).toBe('2026-03-29')

    const next = bucharest.nextMidnight(midnight)
    // The day is 23 hours long, not 24.
    expect((next - midnight) / 3_600_000).toBe(23)
    expect(bucharest.dayOf(next)).toBe('2026-03-30')
  })

  it('handles the 25-hour fall-back day', () => {
    // Bucharest falls back on 2026-10-25 at 04:00 local.
    const bucharest = new TimezoneCalendar(BUCHAREST)
    const midnight = Date.parse('2026-10-24T21:00:00Z') // 2026-10-25 00:00 local
    expect(bucharest.dayOf(midnight)).toBe('2026-10-25')

    const next = bucharest.nextMidnight(midnight)
    expect((next - midnight) / 3_600_000).toBe(25)
    expect(bucharest.dayOf(next)).toBe('2026-10-26')
  })

  it('finds the next month start', () => {
    const utc = new TimezoneCalendar('UTC')
    const next = utc.nextMonthStart(Date.parse('2026-07-15T12:00:00Z'))
    expect(utc.dayOf(next)).toBe('2026-08-01')
  })

  it('finds the next month start across a year boundary', () => {
    const utc = new TimezoneCalendar('UTC')
    const next = utc.nextMonthStart(Date.parse('2026-12-15T12:00:00Z'))
    expect(utc.dayOf(next)).toBe('2027-01-01')
  })

  it('finds the next month start in February', () => {
    const utc = new TimezoneCalendar('UTC')
    expect(utc.dayOf(utc.nextMonthStart(Date.parse('2026-02-15T12:00:00Z')))).toBe('2026-03-01')
    expect(utc.dayOf(utc.nextMonthStart(Date.parse('2024-02-15T12:00:00Z')))).toBe('2024-03-01')
  })

  it('never returns a time inside the same day', () => {
    const bucharest = new TimezoneCalendar(BUCHAREST)
    for (const ts of [SUMMER, WINTER, Date.parse('2026-03-29T00:30:00Z'), Date.parse('2026-10-25T00:30:00Z')]) {
      const next = bucharest.nextMidnight(ts)
      expect(next).toBeGreaterThan(ts)
      expect(bucharest.dayOf(next)).not.toBe(bucharest.dayOf(ts))
      expect(bucharest.dayOf(next - 1)).toBe(bucharest.dayOf(ts))
    }
  })
})

describe('daysBetween', () => {
  it('lists an inclusive range', () => {
    expect(daysBetween('2026-07-15', '2026-07-18')).toEqual([
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
    ])
  })

  it('lists a single day', () => {
    expect(daysBetween('2026-07-15', '2026-07-15')).toEqual(['2026-07-15'])
  })

  it('crosses a month boundary', () => {
    expect(daysBetween('2026-07-30', '2026-08-02')).toEqual([
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ])
  })

  it('rejects an inverted range', () => {
    expect(() => daysBetween('2026-07-18', '2026-07-15')).toThrow(RangeError)
  })

  it('refuses an unbounded range rather than allocating', () => {
    expect(() => daysBetween('1970-01-01', '2026-01-01')).toThrow(/exceeds/)
  })

  it('honours a custom cap', () => {
    expect(() => daysBetween('2026-07-01', '2026-07-10', 5)).toThrow(RangeError)
    expect(daysBetween('2026-07-01', '2026-07-05', 5)).toHaveLength(5)
  })
})

describe('TokenRateWindow', () => {
  it('allows everything when no limit is configured', () => {
    const window = new TokenRateWindow(undefined)
    expect(window.allows(1_000_000_000, 0)).toBe(true)
    expect(window.waitFor(1_000_000_000, 0)).toBe(0)
  })

  it('counts recorded usage', () => {
    const window = new TokenRateWindow(1000)
    window.record(400, 0)
    expect(window.used(0)).toBe(400)
  })

  it('allows a request that fits and refuses one that does not', () => {
    const window = new TokenRateWindow(1000)
    window.record(600, 0)
    expect(window.allows(400, 0)).toBe(true)
    expect(window.allows(401, 0)).toBe(false)
  })

  it('expires samples after the window', () => {
    const window = new TokenRateWindow(1000)
    window.record(900, 0)
    expect(window.used(WINDOW_MS)).toBe(900)
    // At exactly the window's end the sample is out (the boundary is exclusive).
    expect(window.used(WINDOW_MS + 1)).toBe(0)
    expect(window.allows(1000, WINDOW_MS + 1)).toBe(true)
  })

  it('is a sliding window, not a fixed one', () => {
    // The reason: a fixed window lets a burst straddle the boundary — 1000
    // tokens at :59 and another 1000 at :00 — which is what a provider's
    // limiter rejects.
    const window = new TokenRateWindow(1000)
    window.record(1000, 0)
    expect(window.allows(1000, 59_000)).toBe(false)
    // One millisecond past the first sample's window, the capacity is back.
    expect(window.allows(1000, WINDOW_MS + 1)).toBe(true)
  })

  it('reports how long to wait', () => {
    const window = new TokenRateWindow(1000)
    window.record(1000, 0)
    window.record(1000, 10_000)

    // At t=20 000 the window holds 2000 tokens against a 1000 limit, so a
    // 500-token request must wait. The first sample expiring at t=60 000 leaves
    // 1000 in the window — still not enough for 1000 + 500 — so capacity returns
    // only when the SECOND sample expires at t=70 000.
    expect(window.waitFor(500, 20_000)).toBe(50_001)

    // A larger limit frees sooner. With 2000 used against a 2500 limit, a
    // 600-token request needs only the first sample to leave:
    // 2000 - 1000 = 1000, and 1000 + 600 <= 2500.
    const roomy = new TokenRateWindow(2500)
    roomy.record(1000, 0)
    roomy.record(1000, 10_000)
    expect(roomy.waitFor(600, 20_000)).toBe(40_001)
    // A 1500-token request does NOT fit after one sample leaves — 1000 + 1500 >
    // 2500 — so it waits for the second.
    expect(roomy.waitFor(1500, 20_000)).toBe(40_001)
  })

  it('reports no wait when the request fits', () => {
    const window = new TokenRateWindow(1000)
    window.record(100, 0)
    expect(window.waitFor(500, 1000)).toBe(0)
  })

  it('reports a full window when the request can never fit', () => {
    const window = new TokenRateWindow(100)
    // A single request larger than the limit: no wait helps.
    expect(window.waitFor(200, 0)).toBe(WINDOW_MS)
  })

  it('ignores a zero-token record', () => {
    const window = new TokenRateWindow(1000)
    window.record(0, 0)
    expect(window.size).toBe(0)
    expect(window.used(0)).toBe(0)
  })

  it('prunes expired samples on record', () => {
    const window = new TokenRateWindow(1000)
    window.record(100, 0)
    window.record(100, WINDOW_MS + 1)
    // The first sample expired when the second was recorded.
    expect(window.size).toBe(1)
    expect(window.used(WINDOW_MS + 1)).toBe(100)
  })

  it('keeps a running total that matches its samples', () => {
    const window = new TokenRateWindow(10_000)
    for (let index = 0; index < 100; index += 1) window.record(10, index * 100)
    // 100 samples over 10 seconds, all inside the window at t=9900.
    expect(window.used(9900)).toBe(1000)
    // At t=60_100, the samples before t=100 have expired: 99 remain.
    expect(window.used(60_100)).toBe(990)
  })
})

describe('RateLimiter', () => {
  it('builds a window per configured provider', () => {
    const limiter = new RateLimiter({ anthropic: 1000, ollama: 100 })
    expect(limiter.providers()).toEqual(['anthropic', 'ollama'])
    expect(limiter.isEnabled).toBe(true)
    expect(limiter.for('anthropic').limitTokens).toBe(1000)
  })

  it('gives an unconfigured provider an unlimited window', () => {
    const limiter = new RateLimiter({ anthropic: 1000 })
    const window = limiter.for('openai')
    expect(window.limitTokens).toBeUndefined()
    expect(window.allows(1_000_000_000, 0)).toBe(true)
    // It is cached, so the common case is a map hit rather than an allocation.
    expect(limiter.for('openai')).toBe(window)
  })

  it('reports disabled when nothing is configured', () => {
    expect(new RateLimiter({}).isEnabled).toBe(false)
  })

  it('clears every window', () => {
    const limiter = new RateLimiter({ anthropic: 1000 })
    limiter.for('anthropic').record(500, 0)
    limiter.clear()
    expect(limiter.providers()).toEqual([])
  })
})
