// == ARGUS AGENT PROJECT ==
/**
 * Time boundaries.
 *
 * Every day and month boundary in the system is computed here, in the configured
 * timezone, and **nowhere else**. A second implementation would disagree at
 * midnight in some zone, and the disagreement would show up as a rollup that
 * fails to reconcile (see `ops-store`'s DECISIONS.md).
 *
 * The implementation uses `Intl.DateTimeFormat` rather than a date library: it
 * is in Node's standard library, it handles DST correctly through the IANA
 * database, and it needs no dependency.
 *
 * @module @argus-agent/meter/time
 */

/**
 * A timezone-aware calendar.
 *
 * Caches one `Intl.DateTimeFormat` per timezone, because constructing one is
 * comparatively expensive and a metering path calls this on every request.
 */
export class TimezoneCalendar {
  private readonly formatters = new Map<string, Intl.DateTimeFormat>()

  /**
   * @param timezone the IANA timezone name from `ops.yaml`.
   * @throws {RangeError} when the name is not a valid IANA zone, which a
   *   deployment must find out at boot rather than at the first midnight.
   */
  constructor(readonly timezone: string) {
    // The constructor validates eagerly, so a typo fails at startup.
    this.formatter(timezone)
  }

  private formatter(timezone: string): Intl.DateTimeFormat {
    const cached = this.formatters.get(timezone)
    if (cached !== undefined) return cached
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    this.formatters.set(timezone, formatter)
    return formatter
  }

  /**
   * The calendar day a timestamp falls in.
   * @param ts epoch milliseconds.
   * @returns `YYYY-MM-DD` in the configured timezone.
   */
  dayOf(ts: number): string {
    // `en-CA` formats as YYYY-MM-DD, which is exactly the storage format.
    return this.formatter(this.timezone).format(new Date(ts))
  }

  /**
   * The calendar month a timestamp falls in.
   * @param ts epoch milliseconds.
   * @returns `YYYY-MM`.
   */
  monthOf(ts: number): string {
    return this.dayOf(ts).slice(0, 7)
  }

  /**
   * The first day of the month a timestamp falls in.
   * @param ts epoch milliseconds.
   * @returns `YYYY-MM-01`.
   */
  monthStart(ts: number): string {
    return `${this.monthOf(ts)}-01`
  }

  /**
   * The last day of the month a timestamp falls in.
   *
   * Computed by asking the calendar for day 0 of the *next* month, which is the
   * previous month's last day — the standard trick, and one that handles
   * February and leap years without a table.
   *
   * @param ts epoch milliseconds.
   * @returns `YYYY-MM-DD`.
   */
  monthEnd(ts: number): string {
    const month = this.monthOf(ts)
    const [year, monthNumber] = month.split('-').map(Number) as [number, number]
    const nextYear = monthNumber === 12 ? year + 1 : year
    const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1
    // Day 0 of the next month, in UTC arithmetic on the calendar day — no
    // timezone conversion is involved because the result is a calendar date.
    const lastDay = new Date(Date.UTC(nextYear, nextMonth - 1, 0)).getUTCDate()
    return `${month}-${String(lastDay).padStart(2, '0')}`
  }

  /**
   * The next midnight after a timestamp.
   *
   * Found by binary search on the exact instant the calendar day changes, which
   * is what makes it correct across a DST transition — where "add 24 hours" is
   * off by an hour.
   *
   * @param ts epoch milliseconds.
   * @returns the epoch milliseconds of the next local midnight.
   */
  nextMidnight(ts: number): number {
    const day = this.dayOf(ts)
    // The boundary is within the next 25 hours: 24 plus at most one hour of a
    // DST shift. Search that window, then bisect to the millisecond.
    let low = ts
    let high = ts + 25 * 60 * 60 * 1000
    // Guard: if the window somehow still holds the same day (a zone with a
    // larger shift than an hour has never been observed), widen once.
    if (this.dayOf(high) === day) high = ts + 26 * 60 * 60 * 1000
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2)
      if (this.dayOf(mid) === day) low = mid
      else high = mid
    }
    return high
  }

  /**
   * The next month boundary after a timestamp.
   * @param ts epoch milliseconds.
   * @returns the epoch milliseconds of the next local month start.
   */
  nextMonthStart(ts: number): number {
    const month = this.monthOf(ts)
    let candidate = ts + 24 * 60 * 60 * 1000
    // At most 32 days ahead, plus slack for a DST shift.
    const limit = ts + 32 * 24 * 60 * 60 * 1000
    while (candidate < limit) {
      if (this.monthOf(candidate) !== month) break
      candidate = this.nextMidnight(candidate)
    }
    return candidate
  }
}

/**
 * The set of day strings in an inclusive range, capped.
 *
 * Used by a report that wants per-day totals. The cap exists because a range
 * from the epoch to now would allocate thousands of strings for no reason; a
 * caller asking for a year gets a year, and a caller asking for more gets a
 * clear error rather than a slow allocation.
 *
 * @param from the first day, `YYYY-MM-DD`.
 * @param to the last day, `YYYY-MM-DD`.
 * @param maxDays the cap.
 * @returns the day strings, oldest first.
 * @throws {RangeError} when the range exceeds the cap or is inverted.
 */
export function daysBetween(from: string, to: string, maxDays = 400): string[] {
  if (from > to) throw new RangeError(`daysBetween: ${from} is after ${to}`)
  const days: string[] = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10))
    if (days.length > maxDays) {
      throw new RangeError(`daysBetween: range exceeds ${maxDays} days`)
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}
