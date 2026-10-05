// == ARGUS AGENT PROJECT ==
/**
 * The `projects` repository.
 *
 * The table holds runtime state only: configuration comes from
 * `<config_dir>/projects/<id>.yaml` and is synced in by `ops-projects`. A
 * project removed from YAML becomes `archived`, never deleted, so its usage
 * history and audit trail keep their subject.
 *
 * @module @argus-agent/store/repositories/projects
 */
import type { DatabaseHandle } from '../connection.js'
import type { ProjectRow, ProjectStatus } from '../types.js'

/** The fields a caller supplies when creating or updating a project. */
export interface ProjectInput {
  readonly id: string
  readonly cwd: string
  readonly provider: string
  readonly model: string
  readonly fallback_model?: string | null
  readonly preset?: string | null
  readonly description?: string | null
}

/** The `projects` repository. */
export class ProjectsRepository {
  private readonly getStmt
  private readonly listStmt
  private readonly listAllStmt
  private readonly upsertStmt
  private readonly setSessionStmt
  private readonly setStatusStmt
  private readonly setModelStmt
  private readonly setCwdStmt
  private readonly deleteStmt

  constructor(private readonly db: DatabaseHandle) {
    this.getStmt = db.prepare('SELECT * FROM projects WHERE id = ?')
    this.listStmt = db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY id')
    this.listAllStmt = db.prepare('SELECT * FROM projects ORDER BY id')
    // Upsert preserves created_at and session_id: a config reload must not
    // discard the running conversation.
    this.upsertStmt = db.prepare(`
      INSERT INTO projects (id, cwd, provider, model, fallback_model, preset, description, created_at, updated_at)
      VALUES (@id, @cwd, @provider, @model, @fallback_model, @preset, @description, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        cwd            = excluded.cwd,
        provider       = excluded.provider,
        model          = excluded.model,
        fallback_model = excluded.fallback_model,
        preset         = excluded.preset,
        description    = excluded.description,
        updated_at     = excluded.updated_at
    `)
    this.setSessionStmt = db.prepare('UPDATE projects SET session_id = ?, updated_at = ? WHERE id = ?')
    this.setStatusStmt = db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?')
    this.setModelStmt = db.prepare('UPDATE projects SET model = ?, updated_at = ? WHERE id = ?')
    this.setCwdStmt = db.prepare('UPDATE projects SET cwd = ?, updated_at = ? WHERE id = ?')
    this.deleteStmt = db.prepare('DELETE FROM projects WHERE id = ?')
  }

  /**
   * Read one project.
   * @param id the project slug.
   * @returns the row, or `undefined` when it does not exist.
   */
  get(id: string): ProjectRow | undefined {
    return this.getStmt.get(id) as ProjectRow | undefined
  }

  /**
   * List projects.
   * @param filter optional status filter.
   * @returns the rows, ordered by id.
   */
  list(filter?: { status?: ProjectStatus }): ProjectRow[] {
    return (filter?.status !== undefined
      ? this.listStmt.all(filter.status)
      : this.listAllStmt.all()) as ProjectRow[]
  }

  /**
   * Create or update a project from configuration.
   *
   * Never touches `session_id`, `status` or `created_at`: a reload must not
   * archive a project or drop its conversation.
   *
   * @param input the configured fields.
   * @param now the current time, epoch ms.
   */
  upsert(input: ProjectInput, now: number): void {
    this.upsertStmt.run({
      id: input.id,
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      fallback_model: input.fallback_model ?? null,
      preset: input.preset ?? null,
      description: input.description ?? null,
      now,
    })
  }

  /**
   * Record the project's current dsh session.
   * @param id the project slug.
   * @param sessionId the session id, or null to clear it.
   * @param now the current time.
   * @returns whether a row was updated.
   */
  setSession(id: string, sessionId: string | null, now: number): boolean {
    return this.setSessionStmt.run(sessionId, now, id).changes > 0
  }

  /**
   * Change a project's status.
   * @param id the project slug.
   * @param status the new status.
   * @param now the current time.
   * @returns whether a row was updated.
   */
  setStatus(id: string, status: ProjectStatus, now: number): boolean {
    return this.setStatusStmt.run(status, now, id).changes > 0
  }

  /**
   * Change a project's model without touching its YAML.
   *
   * The override is runtime state, so a config reload reverts it. That
   * precedence is deliberate and documented in `ops-projects`.
   *
   * @param id the project slug.
   * @param model the new model id.
   * @param now the current time.
   * @returns whether a row was updated.
   */
  setModel(id: string, model: string, now: number): boolean {
    return this.setModelStmt.run(model, now, id).changes > 0
  }

  /**
   * Change a project's working directory.
   *
   * Used when a project is renamed in YAML and the operator chooses to keep the
   * old folder, rather than treating it as a new project.
   *
   * @param id the project slug.
   * @param cwd the new absolute path.
   * @param now the current time.
   * @returns whether a row was updated.
   */
  setCwd(id: string, cwd: string, now: number): boolean {
    return this.setCwdStmt.run(cwd, now, id).changes > 0
  }

  /**
   * Delete a project row.
   *
   * Only for tests and for a deliberate purge. Normal removal archives.
   *
   * @param id the project slug.
   * @returns whether a row was deleted.
   */
  delete(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0
  }
}
