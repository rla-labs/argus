// == ARGUS AGENT PROJECT ==
/**
 * Tests for the fake clock.
 *
 * The clock is what makes budget rollover, cron firing and approval timeouts
 * testable without sleeping, so its ordering and re-arming semantics must be
 * exact.
 */
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../src/fake-clock.js'

describe('FakeClock', () => {
  it('starts at the requested time and never consults the wall clock', () => {
    const clock = new FakeClock(new Date('2026-03-29T00:00:00Z'))
    expect(clock.now()).toBe(Date.parse('2026-03-29T00:00:00Z'))
    clock.advance(1000)
    expect(clock.now()).toBe(Date.parse('2026-03-29T00:00:01Z'))
  })

  it('defaults to the Unix epoch', () => {
    expect(new FakeClock().now()).toBe(0)
  })

  it('fires a timer exactly when its deadline is reached', () => {
    const clock = new FakeClock(0)
    const fired = vi.fn()
    clock.setTimeout(fired, 100)

    clock.advance(99)
    expect(fired).not.toHaveBeenCalled()
    clock.advance(1)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('fires timers in deadline order, not creation order', () => {
    const clock = new FakeClock(0)
    const order: string[] = []
    clock.setTimeout(() => order.push('late'), 300)
    clock.setTimeout(() => order.push('early'), 100)
    clock.setTimeout(() => order.push('middle'), 200)

    clock.advance(1000)
    expect(order).toEqual(['early', 'middle', 'late'])
  })

  it('fires a chain of timers scheduled by earlier timers', () => {
    const clock = new FakeClock(0)
    const order: number[] = []
    const step = (n: number): void => {
      order.push(n)
      if (n < 3) clock.setTimeout(() => step(n + 1), 10)
    }
    clock.setTimeout(() => step(1), 10)

    clock.advance(1000)
    expect(order).toEqual([1, 2, 3])
  })

  it('repeats an interval and counts every firing', () => {
    const clock = new FakeClock(0)
    let count = 0
    clock.setInterval(() => (count += 1), 100)

    clock.advance(1000)
    expect(count).toBe(10)
  })

  it('reproduces the plan\'s 24-hour 5-minute schedule count', () => {
    // The acceptance criterion for ops-scheduler: 24 simulated hours of a
    // 5-minute schedule produce exactly 288 firings.
    const clock = new FakeClock(0)
    let count = 0
    clock.setInterval(() => (count += 1), 5 * 60_000)

    clock.advance(24 * 60 * 60_000)
    expect(count).toBe(288)
  })

  it('stops a cleared timer and a cleared interval', () => {
    const clock = new FakeClock(0)
    const once = vi.fn()
    const every = vi.fn()
    const onceHandle = clock.setTimeout(once, 100)
    const everyHandle = clock.setInterval(every, 100)

    clock.advance(50)
    clock.clearTimeout(onceHandle)
    clock.clearInterval(everyHandle)
    clock.advance(1000)

    expect(once).not.toHaveBeenCalled()
    expect(every).not.toHaveBeenCalled()
    expect(clock.pendingTimers).toBe(0)
  })

  it('lets an interval callback clear itself', () => {
    const clock = new FakeClock(0)
    let count = 0
    const handle = clock.setInterval(() => {
      count += 1
      if (count === 3) clock.clearInterval(handle)
    }, 10)

    clock.advance(1000)
    expect(count).toBe(3)
    expect(clock.pendingTimers).toBe(0)
  })

  it('jumps time without firing, for a wall-clock correction', () => {
    const clock = new FakeClock(0)
    const fired = vi.fn()
    clock.setTimeout(fired, 100)

    clock.jump(10_000)
    expect(clock.now()).toBe(10_000)
    // The timer's deadline passed, but a jump must not fire it: a scheduler has
    // to notice the deadline itself rather than trust its armed timer.
    expect(fired).not.toHaveBeenCalled()
    expect(clock.pendingTimers).toBe(1)
  })

  it('rejects a negative advance and a non-positive interval', () => {
    const clock = new FakeClock(0)
    expect(() => clock.advance(-1)).toThrow(TypeError)
    expect(() => clock.setInterval(() => undefined, 0)).toThrow(TypeError)
  })

  it('guards against a zero-delay self-rescheduling timer', () => {
    const clock = new FakeClock(0)
    const spin = (): void => {
      clock.setTimeout(spin, 0)
    }
    clock.setTimeout(spin, 0)
    expect(() => clock.advance(1)).toThrow(/zero delay/)
  })

  it('treats a zero delay as due immediately', () => {
    const clock = new FakeClock(0)
    const fired = vi.fn()
    clock.setTimeout(fired, 0)
    clock.advance(0)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('reports and resets pending timers', () => {
    const clock = new FakeClock(0)
    clock.setTimeout(() => undefined, 100)
    clock.setTimeout(() => undefined, 200)
    expect(clock.pendingTimers).toBe(2)

    clock.reset()
    expect(clock.pendingTimers).toBe(0)
    clock.advance(1000)
  })

  it('exposes the current time as a Date', () => {
    const clock = new FakeClock(new Date('2026-10-03T12:00:00Z'))
    expect(clock.date().toISOString()).toBe('2026-10-03T12:00:00.000Z')
  })
})
