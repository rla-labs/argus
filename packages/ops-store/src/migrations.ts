// == ARGUS AGENT PROJECT ==
/**
 * Schema migrations.
 *
 * Migrations are numbered SQL files under `src/migrations/`, applied in order
 * inside a transaction at startup and tracked in `schema_migrations`. The store
 * **refuses to start** when the database carries a migration newer than the code
 * knows: a silent downgrade would read a schema it does not understand, and the
 * damage would be discovered as corrupted data rather than as a startup error.
 *
 * @module @argus-agent/store/migrations
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { OpsError } from '@argus-agent/types'

/** One migration file. */
export interface Migration {
  /** The number parsed from the file name's leading digits. */
  readonly version: number
  /** The file's basename, for the `schema_migrations` record. */
  readonly name: string
  /** The SQL to run. */
  readonly sql: string
}

/** The row recorded in `schema_migrations`. */
export interface AppliedMigration {
  readonly version: number
  readonly name: string
  readonly applied_at: number
}

/** The directory holding the numbered SQL files. */
function migrationsDir(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), 'migrations')
}

/**
 * Read every migration file, sorted by version.
 *
 * @param dir the directory to read; defaults to the packaged `migrations/`.
 * @returns the migrations in application order.
 * @throws {OpsError} `MIGRATION_ERROR` when a file name is malformed or two
 *   files claim the same version.
 */
export function loadMigrations(dir: string = migrationsDir()): Migration[] {
  const names = readdirSync(dir).filter((name) => name.endsWith('.sql'))
  const migrations: Migration[] = []
  for (const name of names) {
    const match = /^(\d+)_/.exec(name)
    if (!match?.[1]) {
      throw new OpsError('MIGRATION_ERROR', `migration file "${name}" must start with digits and an underscore`, {
        file: name,
      })
    }
    migrations.push({ version: Number(match[1]), name, sql: readFileSync(join(dir, name), 'utf8') })
  }
  migrations.sort((a, b) => a.version - b.version)

  const seen = new Map<number, string>()
  for (const migration of migrations) {
    const previous = seen.get(migration.version)
    if (previous) {
      throw new OpsError(
        'MIGRATION_ERROR',
        `two migrations claim version ${migration.version}: "${previous}" and "${migration.name}"`,
        { version: migration.version },
      )
    }
    seen.set(migration.version, migration.name)
  }
  return migrations
}

/** Ensure the bookkeeping table exists. */
function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
}

/**
 * Read the applied migrations.
 * @param db the open database.
 * @returns the applied rows, in version order.
 */
export function appliedMigrations(db: Database): AppliedMigration[] {
  ensureMigrationsTable(db)
  return db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    .all() as AppliedMigration[]
}

/**
 * Apply every pending migration.
 *
 * Each migration runs inside its own transaction, so a failure rolls that
 * migration back completely and leaves earlier ones applied. The database is
 * therefore always at a known version, never half-migrated.
 *
 * @param db the open database.
 * @param options the migrations to apply and the current time.
 * @returns the versions applied by this call, in order.
 * @throws {OpsError} `MIGRATION_ERROR` when the database is newer than the code,
 *   or a migration fails.
 */
export function migrate(
  db: Database,
  options: { migrations?: Migration[]; now?: number } = {},
): number[] {
  const migrations = options.migrations ?? loadMigrations()
  const now = options.now ?? Date.now()
  const applied = appliedMigrations(db)
  const appliedVersions = new Set(applied.map((row) => row.version))
  const knownVersions = new Set(migrations.map((migration) => migration.version))

  // Refuse to run against a database written by newer code. Reading it would
  // silently misinterpret columns, which is worse than not starting.
  const unknown = applied.filter((row) => !knownVersions.has(row.version))
  if (unknown.length > 0) {
    throw new OpsError(
      'MIGRATION_ERROR',
      `database has ${unknown.length} migration(s) newer than this build: ` +
        unknown.map((row) => `${row.version} (${row.name})`).join(', ') +
        '. Upgrade Argus Agent, or restore a backup taken before the upgrade.',
      { newer: unknown.map((row) => row.version), known: [...knownVersions].sort((a, b) => a - b) },
    )
  }

  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version))
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
  const appliedNow: number[] = []

  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.sql)
      record.run(migration.version, migration.name, now)
    })
    try {
      run()
    } catch (error) {
      throw new OpsError(
        'MIGRATION_ERROR',
        `migration ${migration.version} (${migration.name}) failed and was rolled back: ` +
          (error as Error).message,
        { version: migration.version, file: migration.name },
      )
    }
    appliedNow.push(migration.version)
  }

  return appliedNow
}
