// == ARGUS AGENT PROJECT ==
/**
 * A controllable clock.
 *
 * `FakeClock` implements {@link Clock} and never consults the wall clock. Time
 * only moves when a test calls {@link FakeClock.advance}, which fires every
 * timer whose deadline falls inside the advanced window **in deadline order**,
 * so a chain of timers scheduled by earlier timers behaves as it would in real
 * time.
 *
 * @module @argus-agent/testkit/fake-clock
 */
import type { Clock, TimerHandle } from '@argus-agent/types'

/** One scheduled timer. */
interface ScheduledTimer {
  readonly id: number
  /** Absolute deadline in fake-clock milliseconds. */
  readonly deadline: number
  readonly callback: () => void
  readonly intervalMs: number | undefined
  cancelled: boolean
}

/**
 * A clock whose time is set explicitly by the test.
 *
 * @example
 * ```ts
 * const clock = new FakeClock(new Date('2026-03-29T00:00:00Z'))
 * clock.setInterval(() => runs++, 5 * 60_000)
 * clock.advance(24 * 60 * 60_000)   // one simulated day
 * expect(runs).toBe(288)            // a 5-minute schedule fired 288 times
 * ```
 */
export class FakeClock implements Clock {
  /** Stable identity, so a mismatched `clearTimeout` is caught. */
  readonly name = 'fake'

  private current: number
  private nextId = 1
  private readonly timers = new Map<number, ScheduledTimer>()

  /**
   * @param start the initial fake time. Defaults to the Unix epoch, so tests
   *   that only care about deltas do not need to pick a date.
   */
  constructor(start: Date | number = 0) {
    this.current = typeof start === 'number' ? start : start.getTime()
  }

  /** Current fake time, UTC epoch milliseconds. */
  now(): number {
    return this.current
  }

  /** The current fake time as a `Date`. */
  date(): Date {
    return new Date(this.current)
  }

  /**
   * Advance time, firing every timer whose deadline is reached.
   *
   * Timers fire in deadline order. A timer scheduled by a firing callback is
   * also fired when its own deadline falls inside the window, which is what
   * makes a self-rearming scheduler observable.
   *
   * @param ms milliseconds to advance.
   * @throws {TypeError} when `ms` is negative.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new TypeError(`FakeClock.advance: expected a non-negative finite number, got ${String(ms)}`)
    }
    const target = this.current + ms
    // Bounded by the number of timers created so far, so a timer that
    // reschedules itself at zero delay cannot spin forever.
    let guard = 0
    const maxIterations = 1_000_000
    for (;;) {
      if (guard++ > maxIterations) {
        throw new Error('FakeClock.advance: too many timer firings; is a timer rescheduling itself at zero delay?')
      }
      const next = this.nextDue(target)
      if (next === undefined) break
      this.current = next.deadline
      if (next.intervalMs === undefined) {
        next.cancelled = true
        this.timers.delete(next.id)
      } else {
        // Reschedule before invoking, so a callback that clears its own
        // interval observes the timer as live.
        this.timers.set(next.id, { ...next, deadline: next.deadline + next.intervalMs })
      }
      next.callback()
    }
    this.current = target
  }

  /** The earliest live timer at or before `target`, or `undefined`. */
  private nextDue(target: number): ScheduledTimer | undefined {
    let best: ScheduledTimer | undefined
    for (const timer of this.timers.values()) {
      if (timer.cancelled || timer.deadline > target) continue
      if (best === undefined || timer.deadline < best.deadline || (timer.deadline === best.deadline && timer.id < best.id)) {
        best = timer
      }
    }
    return best
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return this.schedule(callback, delayMs, undefined)
  }

  setInterval(callback: () => void, intervalMs: number): TimerHandle {
    if (!(intervalMs > 0)) {
      throw new TypeError(`FakeClock.setInterval: interval must be positive, got ${String(intervalMs)}`)
    }
    return this.schedule(callback, intervalMs, intervalMs)
  }

  private schedule(callback: () => void, delayMs: number, intervalMs: number | undefined): TimerHandle {
    const id = this.nextId++
    this.timers.set(id, {
      id,
      deadline: this.current + Math.max(0, delayMs),
      callback,
      intervalMs,
      cancelled: false,
    })
    return { __timerBrand: 'ops-timer', __owner: this.name, id } as unknown as TimerHandle
  }

  clearTimeout(handle: TimerHandle): void {
    this.cancel(handle)
  }

  clearInterval(handle: TimerHandle): void {
    this.cancel(handle)
  }

  private cancel(handle: TimerHandle): void {
    const id = (handle as unknown as { id?: number }).id
    if (typeof id !== 'number') return
    const timer = this.timers.get(id)
    if (timer) {
      timer.cancelled = true
      this.timers.delete(id)
    }
  }

  /** How many timers are currently scheduled. Tests assert on this to catch leaks. */
  get pendingTimers(): number {
    return this.timers.size
  }

  /** Cancel every pending timer, so a torn-down test leaves nothing behind. */
  reset(): void {
    this.timers.clear()
  }

  /**
   * Jump time without firing timers.
   *
   * Used to simulate a wall-clock jump (an NTP correction, a suspended laptop):
   * a scheduler must notice the deadline passed rather than believing its timer
   * is still armed.
   *
   * @param ms milliseconds to jump.
   */
  jump(ms: number): void {
    this.current += ms
  }
}
