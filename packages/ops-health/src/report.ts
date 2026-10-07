// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/health/report` — the daily report and the startup report.
 *
 * Both are pure functions of a snapshot, so their content is testable without a
 * clock, a store or a timer. That matters more than usual here: a report nobody can
 * test is a report whose arithmetic is wrong for months before anyone notices.
 *
 * @module @argus-agent/health/report
 */
/** A sum of micro-USD, which is a plain number rather than a branded value. */
type Micros = number

/** One project's line in the daily report. */
export interface ProjectSpend {
  readonly projectId: string
  readonly costMicros: Micros
  readonly runs: number
}

/** Everything the daily report needs. */
export interface DailySnapshot {
  /** The local date the report covers, `YYYY-MM-DD`. */
  readonly day: string
  /** Spend per project, for the day. */
  readonly projects: readonly ProjectSpend[]
  /** Spend with no project — ad-hoc tasks and the orchestrator. */
  readonly unscopedMicros: Micros
  /** Runs by status, for the day. */
  readonly runsByStatus: Readonly<Record<string, number>>
  /** Budget states worth mentioning: scopes at or past a threshold. */
  readonly budgets: readonly {
    readonly scope: string
    readonly level: string
    readonly pct: number | undefined
    readonly spentMicros: Micros
    readonly limitMicros: Micros | undefined
  }[]
  /** Schedules skipped, by reason. */
  readonly skips: Readonly<Record<string, number>>
  /** Errors seen, by kind. */
  readonly errors: Readonly<Record<string, number>>
  /** Disk usage of the data directory. */
  readonly disk: { readonly usedPct: number; readonly freeBytes: number } | undefined
}

/**
 * Build the daily report.
 *
 * **Short on a quiet day, complete on a busy one.** A section with something in it
 * gets its own lines; the checks that found nothing share one "All clear" line,
 * so an empty check still reads as "I looked" rather than being dropped — but a
 * quiet day is four lines, not twenty, and the one that matters stands out.
 *
 * @param snapshot what happened today.
 * @returns the report text.
 */
export function dailyReport(snapshot: DailySnapshot): string {
  const lines: string[] = [`Daily report — ${snapshot.day}`, '']
  const clear: string[] = []

  const total: number = snapshot.projects.reduce((sum, project) => sum + project.costMicros, 0) + snapshot.unscopedMicros
  const statuses = Object.entries(snapshot.runsByStatus).sort(([a], [b]) => a.localeCompare(b))
  if (total === 0 && statuses.length === 0) {
    lines.push('Nothing ran and nothing was spent.')
  } else {
    lines.push(`Cost today: ${formatUsd(total)}`)
    for (const project of [...snapshot.projects].sort((a, b) => b.costMicros - a.costMicros)) {
      lines.push(`  ${project.projectId.padEnd(16)} ${formatUsd(project.costMicros).padStart(10)}  ${project.runs} run(s)`)
    }
    if (snapshot.unscopedMicros > 0) {
      lines.push(`  ${'(tasks and the front desk)'.padEnd(16)} ${formatUsd(snapshot.unscopedMicros).padStart(10)}`)
    }
    if (statuses.length > 0) lines.push(`Runs: ${statuses.map(([status, count]) => `${count} ${status}`).join(', ')}`)
  }

  const tight = snapshot.budgets.filter((budget) => budget.level !== 'ok')
  if (tight.length === 0) clear.push('budgets within their limits')
  else {
    lines.push('', 'Budgets')
    for (const budget of tight) {
      const pct = budget.pct === undefined ? '—' : `${Math.round(budget.pct)}%`
      const limit = budget.limitMicros === undefined ? 'no limit' : formatUsd(budget.limitMicros)
      lines.push(`  ${budget.scope.padEnd(20)} ${budget.level.padEnd(8)} ${pct.padStart(4)} of ${limit}`)
    }
  }

  const skips = Object.entries(snapshot.skips).sort(([a], [b]) => a.localeCompare(b))
  if (skips.length === 0) clear.push('no schedule skipped')
  else {
    lines.push('', 'Schedules')
    for (const [reason, count] of skips) lines.push(`  ${reason.padEnd(14)} ${count} skipped`)
  }

  const errors = Object.entries(snapshot.errors).sort(([a], [b]) => a.localeCompare(b))
  if (errors.length === 0) clear.push('no errors')
  else {
    lines.push('', 'Errors')
    for (const [kind, count] of errors) lines.push(`  ${kind.padEnd(20)} ${count}`)
  }

  lines.push('')
  if (clear.length > 0) lines.push(`All clear: ${clear.join(', ')}.`)
  lines.push(
    snapshot.disk === undefined
      ? 'Disk: unknown'
      : `Disk: ${Math.round(snapshot.disk.usedPct)}% used, ${formatBytes(snapshot.disk.freeBytes)} free`,
  )

  return lines.join('\n')
}

/** What the startup report needs. */
export interface StartupSnapshot {
  readonly version: string
  /** Runs that were left `running` and are now `interrupted`. */
  readonly interrupted: readonly {
    readonly runId: string
    readonly projectId: string | null
    /** The inbound request, so a retry can resubmit it. */
    readonly requestId: string | null
    readonly startedAt: number
  }[]
  /** Requests still waiting. */
  readonly pending: number
  /** Requests that will never run: no project, or no agent. */
  readonly orphaned: readonly { readonly requestId: string; readonly reason: string }[]
  /** Project files that do not validate: those projects are ignored until fixed. */
  readonly invalid?: readonly { readonly id: string; readonly path: string; readonly reason: string }[]
}

/**
 * Build the startup report.
 *
 * Sent **after** recovery has run, so what it says is what the system is about to do
 * — not what it found before deciding. A report that arrived first would describe a
 * state the operator is about to see change.
 *
 * @param snapshot what recovery found.
 * @param formatAge how to render how long ago something started.
 * @returns the text.
 */
export function startupReport(
  snapshot: StartupSnapshot,
  formatAge: (ms: number) => string = (ms) => `${Math.round(ms / 60_000)}m`,
  now = Date.now(),
): string {
  const lines: string[] = [`Argus Agent ${snapshot.version} started`, '']

  if (snapshot.interrupted.length > 0) {
    lines.push(`${snapshot.interrupted.length} run(s) were interrupted by a restart:`)
    for (const run of snapshot.interrupted) {
      const where = run.projectId ?? 'a one-off task'
      lines.push(`  ${where.padEnd(16)} started ${formatAge(now - run.startedAt)} ago`)
    }
    lines.push('', 'Press Retry to resubmit the original request, or ignore this to leave it stopped.')
  } else {
    lines.push('No run was interrupted.')
  }

  lines.push('', `Queue: ${snapshot.pending} request(s) waiting.`)

  if (snapshot.orphaned.length > 0) {
    lines.push('', `${snapshot.orphaned.length} request(s) cannot run:`)
    for (const orphan of snapshot.orphaned) lines.push(`  ${orphan.requestId} — ${orphan.reason}`)
  }

  const invalid = snapshot.invalid ?? []
  if (invalid.length > 0) {
    lines.push('', `⚠️ ${invalid.length} project file(s) do not validate; those projects are ignored:`)
    for (const project of invalid) {
      lines.push(`  ${project.id} — ${project.path}`)
      for (const issue of project.reason.split('\n')) lines.push(`    ${issue}`)
    }
    lines.push('Everything else is running. Fix the file(s), then send /reload.')
  }

  return lines.join('\n')
}

/** The button value that resubmits an interrupted run's request. */
export function retryValue(requestId: string): string {
  return `__retry:${requestId}`
}

/**
 * The buttons for the startup report.
 *
 * One Retry per interrupted run, because "retry all" on a report about runs that
 * were killed mid-flight is an invitation to reproduce the crash.
 *
 * @param requestIds the requests to offer.
 * @param limit the most buttons a message may carry.
 * @returns the buttons.
 */
export function startupButtons(
  requestIds: readonly string[],
  limit = 5,
): Array<{ readonly value: string; readonly label: string }> {
  return requestIds.slice(0, limit).map((requestId, index) => ({
    value: retryValue(requestId),
    label: `Retry ${index + 1}`,
  }))
}

/**
 * Read a retry button's value.
 *
 * @param value the button value.
 * @returns the request id, or `undefined` when it is not a retry.
 */
export function parseRetry(value: string): string | undefined {
  return value.startsWith('__retry:') ? value.slice('__retry:'.length) : undefined
}

/** Render micro-USD as dollars. */
export function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`
}

/** Render bytes as a human size. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
