// == ARGUS AGENT PROJECT ==
/**
 * The token rate window.
 *
 * A provider rate limit is expressed in tokens per minute. The window is a
 * **sliding 60-second** one: a fixed window would allow a burst at a boundary
 * (60 seconds' worth at :59 and another at :00), which is exactly the burst a
 * provider's limiter rejects.
 *
 * @module @argus-agent/meter/rate-window
 */

/** The window length in milliseconds. */
export const WINDOW_MS = 60_000

/** One recorded request. */
interface Sample {
  readonly at: number
  readonly tokens: number
}

/**
 * A sliding token-rate window.
 *
 * Samples expire by timestamp, not by a timer: nothing to schedule, nothing to
 * leak, and a process that was idle for an hour costs one prune rather than a
 * thousand empty ticks.
 */
export class TokenRateWindow {
  private samples: Sample[] = []
  private totalTokens = 0

  /**
   * @param limitTokens the ceiling in the window; `undefined` disables the check.
   */
  constructor(readonly limitTokens: number | undefined) {}

  /**
   * Drop samples that have fallen out of the window.
   * @param now the current time, epoch ms.
   */
  private prune(now: number): void {
    if (this.samples.length === 0) return
    // The window is the closed interval [now - WINDOW_MS, now]: a sample
    // recorded exactly one window ago STILL counts, because "1000 tokens per
    // minute" is a statement about a 60-second span that includes both ends.
    // A sample frees its capacity one millisecond later.
    const cutoff = now - WINDOW_MS
    let index = 0
    while (index < this.samples.length && this.samples[index]!.at < cutoff) {
      this.totalTokens -= this.samples[index]!.tokens
      index += 1
    }
    if (index > 0) this.samples = this.samples.slice(index)
  }

  /**
   * The tokens recorded in the window.
   * @param now the current time.
   * @returns the token count.
   */
  used(now: number): number {
    this.prune(now)
    return this.totalTokens
  }

  /**
   * Whether a request of this size would exceed the limit.
   *
   * @param tokens the tokens the request is expected to use.
   * @param now the current time.
   * @returns whether it fits; always true when no limit is configured.
   */
  allows(tokens: number, now: number): boolean {
    if (this.limitTokens === undefined) return true
    return this.used(now) + tokens <= this.limitTokens
  }

  /**
   * How long until enough capacity is free.
   *
   * Returns 0 when the request fits now. Otherwise it returns the time until the
   * oldest samples expire — the earliest moment capacity can return, which is
   * what a caller wants for a "retry in N seconds" message.
   *
   * @param tokens the tokens the request needs.
   * @param now the current time.
   * @returns milliseconds to wait, or 0.
   */
  waitFor(tokens: number, now: number): number {
    if (this.limitTokens === undefined) return 0
    this.prune(now)
    if (this.totalTokens + tokens <= this.limitTokens) return 0

    // Samples are ordered oldest first, so capacity returns in that order. A
    // sample contributes to the total until it leaves the window, so the check
    // happens AFTER subtracting it: the moment it expires is the moment its
    // tokens stop counting.
    let remaining = this.totalTokens
    for (const sample of this.samples) {
      remaining -= sample.tokens
      if (remaining + tokens <= this.limitTokens) {
        // The sample leaves the window one millisecond after `at + WINDOW_MS`,
        // matching `prune`'s closed-interval test.
        return Math.max(0, sample.at + WINDOW_MS + 1 - now)
      }
    }
    // Even an empty window cannot fit the request: it is larger than the limit,
    // so no wait helps. Report the full window rather than a misleading 0.
    return WINDOW_MS
  }

  /**
   * Record a request's actual usage.
   *
   * @param tokens the tokens used. A zero-token request is not recorded, because
   *   it consumes no capacity.
   * @param now the current time.
   */
  record(tokens: number, now: number): void {
    if (tokens <= 0) return
    this.samples.push({ at: now, tokens })
    this.totalTokens += tokens
    this.prune(now)
  }

  /** How many samples are retained. For diagnostics. */
  get size(): number {
    return this.samples.length
  }
}

/** Per-provider rate windows, built from configuration. */
export class RateLimiter {
  private readonly windows = new Map<string, TokenRateWindow>()

  /**
   * @param limits tokens-per-minute by provider name.
   */
  constructor(limits: Readonly<Record<string, number>>) {
    for (const [provider, limit] of Object.entries(limits)) {
      this.windows.set(provider, new TokenRateWindow(limit))
    }
  }

  /**
   * The window for a provider.
   * @param provider the provider route.
   * @returns the window; an unlimited one when the provider has no configured limit.
   */
  for(provider: string): TokenRateWindow {
    const existing = this.windows.get(provider)
    if (existing !== undefined) return existing
    // Cache the unlimited window, so the common case is a map hit rather than a
    // fresh allocation on every request.
    const unlimited = new TokenRateWindow(undefined)
    this.windows.set(provider, unlimited)
    return unlimited
  }

  /** Whether any provider has a configured limit. */
  get isEnabled(): boolean {
    for (const window of this.windows.values()) {
      if (window.limitTokens !== undefined) return true
    }
    return false
  }

  /** The configured providers, sorted. */
  providers(): string[] {
    return [...this.windows.keys()].sort()
  }

  /** Drop every sample. */
  clear(): void {
    this.windows.clear()
  }
}
