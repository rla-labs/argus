// == ARGUS AGENT PROJECT ==
/**
 * The clock abstraction.
 *
 * Any logic whose behavior a test depends on takes time from a {@link Clock}
 * rather than calling `Date.now()` or `setTimeout` directly (AGENTS.md). That is
 * what makes budget rollover, cron firing, queue stalls and approval timeouts
 * testable without sleeping.
 *
 * @module @argus-agent/types/clock
 */

/** A source of time and timers. */
export interface Clock {
  /** Current time, UTC epoch milliseconds. */
  now(): number

  /**
   * Run a callback after a delay.
   * @param callback the callback.
   * @param delayMs the delay in milliseconds.
   * @returns a handle that cancels the timer.
   */
  setTimeout(callback: () => void, delayMs: number): TimerHandle

  /**
   * Run a callback repeatedly at an interval.
   * @param callback the callback.
   * @param intervalMs the interval in milliseconds.
   * @returns a handle that cancels the timer.
   */
  setInterval(callback: () => void, intervalMs: number): TimerHandle

  /** Cancel a timer created by this clock. */
  clearTimeout(handle: TimerHandle): void

  /** Cancel an interval created by this clock. */
  clearInterval(handle: TimerHandle): void
}

/**
 * An opaque timer handle, owned by the clock that created it.
 *
 * Branded so a handle from one clock cannot be passed to another: a fake clock
 * and the system clock are not interchangeable, and mixing them silently loses
 * or duplicates a timer.
 */
export interface TimerHandle {
  readonly __timerBrand: 'ops-timer'
  /** Identifies the creating clock instance, for the mismatch check below. */
  readonly __owner: string
}

/**
 * Assert that a timer handle belongs to the clock being asked to cancel it.
 * @param clock the clock that received the handle.
 * @param handle the handle.
 * @throws {TypeError} when the handle came from a different clock.
 */
export function assertOwnedTimer(clock: Clock, handle: TimerHandle): void {
  if (handle.__owner !== clockName(clock)) {
    throw new TypeError(
      `timer handle belongs to ${handle.__owner}, not to ${clockName(clock)}; ` +
        'a handle must be cleared by the clock that created it',
    )
  }
}

/**
 * A stable identity for a clock instance.
 *
 * The system clock is a module singleton with a fixed name; any other clock
 * (a test's fake) is identified by a per-instance tag its constructor assigns.
 *
 * @param clock the clock.
 * @returns its identity string.
 */
export function clockName(clock: Clock): string {
  return clock === systemClock ? 'system' : ((clock as { name?: string }).name ?? 'custom')
}

/** The real clock, backed by `Date` and the Node timer functions. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) =>
    ({ __timerBrand: 'ops-timer', __owner: 'system', native: setTimeout(callback, delayMs) }) as unknown as TimerHandle,
  setInterval: (callback, intervalMs) =>
    ({ __timerBrand: 'ops-timer', __owner: 'system', native: setInterval(callback, intervalMs) }) as unknown as TimerHandle,
  clearTimeout: (handle) => clearTimeout((handle as unknown as { native: NodeJS.Timeout }).native),
  clearInterval: (handle) => clearInterval((handle as unknown as { native: NodeJS.Timeout }).native),
}

/**
 * The largest delay `setTimeout` accepts reliably.
 *
 * A delay above 2^31-1 ms (about 24.8 days) overflows the 32-bit field Node
 * passes to the platform and fires immediately. A scheduler arming a timer for
 * a distant `next_run_at` must clamp to this and re-arm.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647
