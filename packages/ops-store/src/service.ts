// == ARGUS AGENT PROJECT ==
/**
 * The `opsStore` service.
 *
 * The single point of access to `ops.sqlite` (ADR 0003). It owns the connection,
 * the migrations, the repositories and the operations that span more than one
 * table.
 *
 * @module @argus-agent/store/service
 */
import { OpsError } from '@argus-agent/types'
import { integrityCheck, openDatabase, type DatabaseHandle, type OpenOptions } from './connection.js'
import { appliedMigrations, migrate, type AppliedMigration, type Migration } from './migrations.js'
import { ApprovalsRepository } from './repositories/approvals.js'
import { AuditRepository } from './repositories/audit.js'
import { BudgetsRepository } from './repositories/budgets.js'
import { ChatContextRepository } from './repositories/chat-context.js'
import { InboundRepository, type InboundInput } from './repositories/inbound.js'
import { ProjectsRepository } from './repositories/projects.js'
import { RunsRepository, type RunInput } from './repositories/runs.js'
import { RuntimeStateRepository } from './repositories/runtime-state.js'
import { SchedulesRepository } from './repositories/schedules.js'
import { UsageRepository } from './repositories/usage.js'
import type { RunRow } from './types.js'

/** Options for constructing the store. */
export interface StoreOptions extends OpenOptions {
  /** Migrations to apply; defaults to the packaged set. */
  readonly migrations?: Migration[]
  /** The current time, for the migration records. */
  readonly now?: number
}

/**
 * One admitted request's bookkeeping, created atomically.
 *
 * `admission` is the store's reason to have a transaction helper at all: the
 * `inbound` update and the `runs` insert must both happen or neither. A crash
 * between them would either lose a request that was already promised a slot, or
 * create a run for a request still marked pending — which the dispatcher would
 * then admit a second time.
 */
export interface AdmissionInput {
  /** The request being admitted. */
  readonly inboundId: string
  /** The run to create for it. */
  readonly run: RunInput
  /** The current time. */
  readonly now: number
}

/** The result of an admission attempt. */
export interface AdmissionResult {
  /** Whether the request was still pending and is now admitted. */
  readonly admitted: boolean
  /** The run row, present when admitted. */
  readonly run?: RunRow
}

/**
 * The store.
 *
 * A plain class rather than a Cordis `Service` subclass: it owns a database
 * handle and repositories, and it needs no context to do so. The plugin
 * registers the instance as `ctx.opsStore` and closes it on unload, which is
 * what makes it context-scoped without making it context-dependent.
 *
 * Every repository is a public readonly property, so a consumer reads
 * `ctx.opsStore.projects.get(id)` rather than receiving SQL.
 */
export class OpsStore {
  /** The open database handle. */
  readonly db: DatabaseHandle

  /** The `projects` repository. */
  readonly projects: ProjectsRepository
  /** The `inbound` repository. */
  readonly inbound: InboundRepository
  /** The `runs` repository. */
  readonly runs: RunsRepository
  /** The `usage_events` / `usage_daily` repository. */
  readonly usage: UsageRepository
  /** The `budgets` repository. */
  readonly budgets: BudgetsRepository
  /** The `schedules` repository. */
  readonly schedules: SchedulesRepository
  /** The `chat_context` repository. */
  readonly chatContext: ChatContextRepository
  /** The `audit_log` repository. */
  readonly audit: AuditRepository
  /** The `approvals` repository. */
  readonly approvals: ApprovalsRepository
  /** The `runtime_state` repository. */
  readonly runtimeState: RuntimeStateRepository

  /** The migrations applied by this process at open time. */
  readonly migrationsApplied: readonly number[]

  private closed = false

  constructor(options: StoreOptions) {
    this.db = openDatabase(options)
    try {
      this.migrationsApplied = migrate(this.db, {
        ...(options.migrations !== undefined ? { migrations: options.migrations } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      })
    } catch (error) {
      this.db.close()
      throw error
    }

    this.projects = new ProjectsRepository(this.db)
    this.inbound = new InboundRepository(this.db)
    this.runs = new RunsRepository(this.db)
    this.usage = new UsageRepository(this.db)
    this.budgets = new BudgetsRepository(this.db)
    this.schedules = new SchedulesRepository(this.db)
    this.chatContext = new ChatContextRepository(this.db)
    this.audit = new AuditRepository(this.db)
    this.approvals = new ApprovalsRepository(this.db)
    this.runtimeState = new RuntimeStateRepository(this.db)
  }

  /**
   * Admit a request: update `inbound` and create its `runs` row atomically.
   *
   * The `inbound` update is guarded by `status = 'pending'`, so two dispatcher
   * passes racing on the same request produce one admission and one no-op —
   * rather than two runs for one message.
   *
   * @param input the request and its run.
   * @returns whether the request was admitted, and the run row when it was.
   */
  admit(input: AdmissionInput): AdmissionResult {
    const run = this.db.transaction((): AdmissionResult => {
      if (!this.inbound.markAdmitted(input.inboundId, input.run.id, input.now)) {
        return { admitted: false }
      }
      this.runs.start(input.run, input.now)
      return { admitted: true, run: this.runs.get(input.run.id) }
    })
    return run()
  }

  /**
   * Write a request and, in the same transaction, record that it was received.
   *
   * A thin convenience over {@link InboundRepository.insert} so a caller cannot
   * forget the ordering rule. The insert is the durability boundary: after it
   * returns, a crash cannot lose the request.
   *
   * @param input the request.
   * @param now the current time.
   */
  receive(input: InboundInput, now: number): void {
    this.db.transaction(() => this.inbound.insert(input, now))()
  }

  /**
   * Recover after a crash: mark every running run interrupted.
   *
   * Returns the affected runs so the caller can report exactly what was lost,
   * rather than a count a human cannot act on.
   *
   * @param now the current time.
   * @returns the runs that were marked interrupted.
   */
  recoverInterruptedRuns(now: number): RunRow[] {
    const mark = this.db.transaction(() => this.runs.markRunningInterrupted(now))
    return mark()
  }

  /**
   * Mark stale pending approvals timed out.
   * @param olderThan the cutoff, epoch ms.
   * @param now the current time.
   * @returns the number of approvals expired.
   */
  expireStaleApprovals(olderThan: number, now: number): number {
    const expire = this.db.transaction(() => this.approvals.expirePending(olderThan, now))
    return expire()
  }

  /**
   * Back up the database using SQLite's online backup API.
   *
   * Safe while the database is in use: the API takes a read lock per page rather
   * than stopping writers, so a backup does not block a running agent.
   *
   * @param destPath the file to write.
   * @returns after the backup completes.
   * @throws {OpsError} `STORE_ERROR` when the backup fails.
   */
  async backup(destPath: string): Promise<void> {
    this.assertOpen()
    try {
      await this.db.backup(destPath)
    } catch (error) {
      throw new OpsError('STORE_ERROR', `backup to ${destPath} failed: ${(error as Error).message}`, {
        destPath,
      })
    }
  }

  /**
   * The database's structural integrity.
   * @returns `'ok'`, or the reported problem.
   */
  integrity(): string {
    this.assertOpen()
    return integrityCheck(this.db)
  }

  /**
   * The migrations recorded in the database.
   * @returns the rows, in version order.
   */
  appliedMigrations(): AppliedMigration[] {
    this.assertOpen()
    return appliedMigrations(this.db)
  }

  /**
   * Delete old rows.
   *
   * `usage_daily` and `audit_log` are deliberately **not** prunable: the first is
   * the reconciliation target, the second is the record of who did what.
   *
   * @param options the cutoffs, in days before `now`.
   * @param now the current time, epoch ms.
   * @returns what was deleted.
   */
  prune(
    options: { usageEventsOlderThanDays?: number; inboundDoneOlderThanDays?: number },
    now: number,
  ): { usageEvents: number; inbound: number } {
    this.assertOpen()
    const day = 24 * 60 * 60 * 1000
    const run = this.db.transaction(() => ({
      usageEvents:
        options.usageEventsOlderThanDays === undefined
          ? 0
          : this.usage.pruneEvents(now - options.usageEventsOlderThanDays * day),
      inbound:
        options.inboundDoneOlderThanDays === undefined
          ? 0
          : this.inbound.prune(now - options.inboundDoneOlderThanDays * day),
    }))
    return run()
  }

  /**
   * Run a function inside a transaction.
   *
   * Exposed so a caller that must touch two repositories atomically can, without
   * opening a second connection or writing SQL.
   *
   * @param fn the work to run.
   * @returns a function that runs `fn` transactionally.
   */
  transaction<T>(fn: () => T): () => T {
    this.assertOpen()
    return this.db.transaction(fn)
  }

  /** Whether the database handle is still open. */
  get isOpen(): boolean {
    return !this.closed && this.db.open
  }

  /**
   * Close the database.
   *
   * Called by the plugin's disposer. Idempotent, so a double unload is safe.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // A close failure on an already-broken handle is not actionable.
    }
  }

  /**
   * A health summary for `ops-health`.
   * @returns the status and details.
   */
  health(): { status: 'ok' | 'degraded' | 'down'; details: Record<string, unknown> } {
    if (!this.isOpen) return { status: 'down', details: { reason: 'database closed' } }
    try {
      const integrity = this.integrity()
      const pending = this.inbound.pendingCount()
      const active = this.runs.active().length
      return {
        status: integrity === 'ok' ? 'ok' : 'degraded',
        details: { integrity, pending, active, migrations: this.appliedMigrations().length },
      }
    } catch (error) {
      return { status: 'down', details: { reason: (error as Error).message } }
    }
  }

  private assertOpen(): void {
    if (!this.isOpen) {
      throw new OpsError('STORE_ERROR', 'the store is closed', {})
    }
  }
}

export default OpsStore
