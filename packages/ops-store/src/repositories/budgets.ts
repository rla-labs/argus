// == ARGUS AGENT PROJECT ==
/**
 * The `budgets` repository.
 *
 * A budget is a limit plus two thresholds and two actions. An **override** is a
 * temporary increase or an unlock window: `override_micros` raises the limit and
 * `override_until` suspends the hard action, both recorded in `audit_log` by the
 * caller.
 *
 * @module @argus-agent/store/repositories/budgets
 */
import type { DatabaseHandle } from '../connection.js'
import type { BudgetRow } from '../types.js'

/** A budget's configurable fields. */
export interface BudgetInput {
  readonly scope: BudgetRow['scope']
  readonly period: BudgetRow['period']
  readonly limit_micros: number
  readonly info_pct?: number
  readonly soft_pct?: number
  readonly action_soft?: BudgetRow['action_soft']
  readonly action_hard?: BudgetRow['action_hard']
}

/** The `budgets` repository. */
export class BudgetsRepository {
  private readonly upsertStmt
  private readonly getStmt
  private readonly forScopesStmt
  private readonly listStmt
  private readonly setOverrideStmt
  private readonly clearOverrideStmt
  private readonly deleteStmt

  constructor(private readonly db: DatabaseHandle) {
    // An upsert from configuration must NOT clear an active override: the
    // operator granted it deliberately, and a config reload is not a revocation.
    this.upsertStmt = db.prepare(`
      INSERT INTO budgets (scope, period, limit_micros, info_pct, soft_pct, action_soft, action_hard)
      VALUES (@scope, @period, @limit_micros, @info_pct, @soft_pct, @action_soft, @action_hard)
      ON CONFLICT(scope, period) DO UPDATE SET
        limit_micros = excluded.limit_micros,
        info_pct     = excluded.info_pct,
        soft_pct     = excluded.soft_pct,
        action_soft  = excluded.action_soft,
        action_hard  = excluded.action_hard
    `)
    this.getStmt = db.prepare('SELECT * FROM budgets WHERE scope = ? AND period = ?')
    this.forScopesStmt = db.prepare(
      `SELECT * FROM budgets WHERE period = ? AND scope IN (SELECT value FROM json_each(?))`,
    )
    this.listStmt = db.prepare('SELECT * FROM budgets ORDER BY scope, period')
    this.setOverrideStmt = db.prepare(`
      UPDATE budgets SET override_until = ?, override_micros = ?
      WHERE scope = ? AND period = ?
    `)
    this.clearOverrideStmt = db.prepare(`
      UPDATE budgets SET override_until = NULL, override_micros = 0
      WHERE scope = ? AND period = ?
    `)
    this.deleteStmt = db.prepare('DELETE FROM budgets WHERE scope = ? AND period = ?')
  }

  /**
   * Create or update a budget from configuration.
   * @param input the limit and thresholds.
   */
  upsert(input: BudgetInput): void {
    this.upsertStmt.run({
      scope: input.scope,
      period: input.period,
      limit_micros: input.limit_micros,
      info_pct: input.info_pct ?? 50,
      soft_pct: input.soft_pct ?? 80,
      action_soft: input.action_soft ?? 'warn',
      action_hard: input.action_hard ?? 'pause',
    })
  }

  /**
   * Read one budget.
   * @param scope the scope.
   * @param period the period.
   * @returns the row, or `undefined`.
   */
  get(scope: BudgetRow['scope'], period: BudgetRow['period']): BudgetRow | undefined {
    return this.getStmt.get(scope, period) as BudgetRow | undefined
  }

  /**
   * Read the budgets that apply to one run.
   *
   * Every run is checked against `global` plus its own scope, which is why this
   * takes a list rather than one scope.
   *
   * @param scopes the applicable scopes.
   * @param period the period.
   * @returns the rows, in the order the scopes were given where present.
   */
  forScopes(scopes: readonly string[], period: BudgetRow['period']): BudgetRow[] {
    if (scopes.length === 0) return []
    const rows = this.forScopesStmt.all(period, JSON.stringify(scopes)) as BudgetRow[]
    const order = new Map(scopes.map((scope, index) => [scope, index]))
    return rows.sort((a, b) => (order.get(a.scope) ?? 0) - (order.get(b.scope) ?? 0))
  }

  /**
   * Every configured budget.
   * @returns the rows.
   */
  list(): BudgetRow[] {
    return this.listStmt.all() as BudgetRow[]
  }

  /**
   * Grant a temporary override.
   * @param scope the scope.
   * @param period the period.
   * @param override the added micro-USD and the expiry, or `null` for no expiry.
   * @returns whether a row was updated.
   */
  setOverride(
    scope: BudgetRow['scope'],
    period: BudgetRow['period'],
    override: { addMicros?: number; untilMs?: number | null },
  ): boolean {
    const current = this.get(scope, period)
    if (!current) return false
    return (
      this.setOverrideStmt.run(
        override.untilMs ?? null,
        override.addMicros !== undefined ? current.override_micros + override.addMicros : current.override_micros,
        scope,
        period,
      ).changes > 0
    )
  }

  /**
   * Clear an override.
   * @param scope the scope.
   * @param period the period.
   * @returns whether a row was updated.
   */
  clearOverride(scope: BudgetRow['scope'], period: BudgetRow['period']): boolean {
    return this.clearOverrideStmt.run(scope, period).changes > 0
  }

  /**
   * Delete a budget.
   * @param scope the scope.
   * @param period the period.
   * @returns whether a row was deleted.
   */
  delete(scope: BudgetRow['scope'], period: BudgetRow['period']): boolean {
    return this.deleteStmt.run(scope, period).changes > 0
  }

  /**
   * The effective limit, including any active override.
   *
   * An expired override contributes nothing, so a forgotten unlock does not
   * silently raise a limit forever.
   *
   * @param budget the row.
   * @param now the current time, epoch ms.
   * @returns the limit in micro-USD.
   */
  static effectiveLimit(budget: BudgetRow, now: number): number {
    const active = budget.override_until === null || budget.override_until > now
    return budget.limit_micros + (active ? budget.override_micros : 0)
  }

  /**
   * Whether the hard action is currently suspended by an override.
   * @param budget the row.
   * @param now the current time.
   * @returns whether an unlock window is active.
   */
  static isUnlocked(budget: BudgetRow, now: number): boolean {
    return budget.override_until !== null && budget.override_until > now
  }
}
