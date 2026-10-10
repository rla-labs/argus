// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/types/health` — the health contract every plugin's service reports.
 *
 * One shape, so the aggregator in `ops-health` does not have to know which plugin
 * it is asking. A plugin that reported an ad-hoc object would make the roll-up a
 * pile of special cases, and the first plugin nobody updated would silently report
 * nothing.
 *
 * @module @argus-agent/types/health
 */

/** How a subsystem is doing. */
export type HealthStatus =
  /** Working as intended. */
  | 'ok'
  /** Working, but something is wrong that an operator should look at. */
  | 'degraded'
  /** Not working. The subsystem cannot do its job. */
  | 'down'

/**
 * What a service reports about itself.
 *
 * `details` is deliberately `Record<string, unknown>`: each subsystem knows what is
 * worth saying about itself, and the aggregator's job is to carry that through
 * rather than to impose a schema on every one of them. The `/health` endpoint
 * returns it verbatim, which is what makes a failure diagnosable without reading
 * the plugin's source.
 */
export interface ServiceHealth {
  readonly status: HealthStatus
  readonly details: Record<string, unknown>
}

/** A convenience constructor for a healthy report. */
export function ok(details: Record<string, unknown> = {}): ServiceHealth {
  return { status: 'ok', details }
}

/** A convenience constructor for a degraded report. */
export function degraded(details: Record<string, unknown> = {}): ServiceHealth {
  return { status: 'degraded', details }
}

/** A convenience constructor for a down report. */
export function down(details: Record<string, unknown> = {}): ServiceHealth {
  return { status: 'down', details }
}

/**
 * The worst status in a set.
 *
 * `down` beats `degraded` beats `ok`. Written as a total order rather than a
 * boolean check at each call site, because "is anything worse than this" is the
 * only question the roll-up asks.
 *
 * @param statuses the statuses.
 * @returns the worst one, or `'ok'` for an empty list.
 */
export function worstOf(statuses: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = 'ok'
  for (const status of statuses) {
    if (status === 'down') return 'down'
    if (status === 'degraded') worst = 'degraded'
  }
  return worst
}

/**
 * The numeric rank of a status, for a caller that wants to compare.
 *
 * @param status the status.
 * @returns 0 for ok, 1 for degraded, 2 for down.
 */
export function rankOf(status: HealthStatus): number {
  switch (status) {
    case 'ok':
      return 0
    case 'degraded':
      return 1
    case 'down':
      return 2
  }
}

/**
 * One finding of `argus doctor`: something checked, whether it passed, and what to do
 * when it did not. A service that can tell whether it will actually work (a key the
 * provider accepts, a model with a price) exposes `doctor()` returning these; the
 * health plugin collects them on `GET /doctor`.
 */
export interface DoctorFinding {
  readonly ok: boolean
  /** What was checked, e.g. `deepseek: the API key`. */
  readonly check: string
  /** What was found, when it adds something to `check`. */
  readonly detail?: string
  /** What to do about a failure, as a step the operator can follow. */
  readonly fix?: string
  /** With `ok`: a setting that works but deserves a second look. */
  readonly warn?: boolean
}

/** A service that contributes to `argus doctor`. */
export interface DoctorSource {
  doctor(): Promise<readonly DoctorFinding[]> | readonly DoctorFinding[]
}
