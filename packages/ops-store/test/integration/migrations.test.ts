// == ARGUS AGENT PROJECT ==
/**
 * Migration tests.
 *
 * A migration that half-applies, or a build that runs against a newer database,
 * is a data-loss event. These tests cover the empty database, a database at
 * every earlier version, a failing migration, and the downgrade refusal.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpsError } from '@argus-agent/types'
import { appliedMigrations, loadMigrations, migrate } from '../../src/migrations.js'
import { openDatabase } from '../../src/connection.js'
import { OpsStore } from '../../src/service.js'

const dirs: string[] = []
const closers: Array<() => void> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-migrate-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('loadMigrations', () => {
  it('loads the packaged migrations in version order', () => {
    const migrations = loadMigrations()
    expect(migrations.length).toBeGreaterThanOrEqual(1)
    expect(migrations[0]?.version).toBe(1)
    expect(migrations[0]?.name).toBe('0001_init.sql')
    for (let index = 1; index < migrations.length; index += 1) {
      expect(migrations[index]!.version).toBeGreaterThan(migrations[index - 1]!.version)
    }
  })

  it('rejects a file name without a numeric prefix', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'init.sql'), 'SELECT 1')
    expect(() => loadMigrations(dir)).toThrow(OpsError)
    try {
      loadMigrations(dir)
    } catch (error) {
      expect(OpsError.hasCode(error, 'MIGRATION_ERROR')).toBe(true)
    }
  })

  it('rejects two files claiming one version', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1')
    writeFileSync(join(dir, '0001_b.sql'), 'SELECT 1')
    expect(() => loadMigrations(dir)).toThrow(/two migrations claim version 1/)
  })

  it('sorts numerically, not lexically', () => {
    const dir = tempDir()
    // A lexical sort would put 0010 before 0002.
    writeFileSync(join(dir, '0010_ten.sql'), 'SELECT 1')
    writeFileSync(join(dir, '0002_two.sql'), 'SELECT 1')
    expect(loadMigrations(dir).map((migration) => migration.version)).toEqual([2, 10])
  })
})

describe('migrate', () => {
  it('applies every migration to an empty database', () => {
    const db = openDatabase({ path: join(tempDir(), 'ops.sqlite') })
    closers.push(() => db.close())

    const applied = migrate(db)
    expect(applied).toEqual([1])
    expect(appliedMigrations(db).map((row) => row.version)).toEqual([1])
    expect(appliedMigrations(db)[0]?.name).toBe('0001_init.sql')

    // Every table the schema promises exists.
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    for (const table of [
      'approvals',
      'audit_log',
      'budgets',
      'chat_context',
      'inbound',
      'projects',
      'runs',
      'runtime_state',
      'schedules',
      'schema_migrations',
      'usage_daily',
      'usage_events',
    ]) {
      expect(tables, `missing table ${table}`).toContain(table)
    }
  })

  it('is idempotent on an already-migrated database', () => {
    const db = openDatabase({ path: join(tempDir(), 'ops.sqlite') })
    closers.push(() => db.close())

    expect(migrate(db)).toEqual([1])
    // Re-running applies nothing and does not fail: every process start calls it.
    expect(migrate(db)).toEqual([])
    expect(appliedMigrations(db)).toHaveLength(1)
  })

  it('applies only the pending migrations', () => {
    const db = openDatabase({ path: join(tempDir(), 'ops.sqlite') })
    closers.push(() => db.close())

    // Simulate a database already at version 1, with version 2 now available.
    const real = loadMigrations()
    migrate(db, { migrations: real })

    const extended = [
      ...real,
      { version: 2, name: '0002_add.sql', sql: 'CREATE TABLE added (id TEXT PRIMARY KEY)' },
    ]
    expect(migrate(db, { migrations: extended })).toEqual([2])
    expect(appliedMigrations(db).map((row) => row.version)).toEqual([1, 2])
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'added'").get(),
    ).toBeDefined()
  })

  it('rolls a failing migration back completely', () => {
    const db = openDatabase({ path: join(tempDir(), 'ops.sqlite') })
    closers.push(() => db.close())

    const migrations = [
      { version: 1, name: '0001_ok.sql', sql: 'CREATE TABLE ok (id TEXT PRIMARY KEY)' },
      {
        version: 2,
        name: '0002_bad.sql',
        // The first statement succeeds; the second is invalid. The whole
        // migration must roll back, leaving no partial table.
        sql: 'CREATE TABLE partial (id TEXT PRIMARY KEY); CREATE TABLE (broken',
      },
    ]

    let error: unknown
    try {
      migrate(db, { migrations })
    } catch (caught) {
      error = caught
    }
    expect(OpsError.hasCode(error, 'MIGRATION_ERROR')).toBe(true)
    expect((error as OpsError).details['version']).toBe(2)

    // Version 1 is applied; version 2 left nothing behind.
    expect(appliedMigrations(db).map((row) => row.version)).toEqual([1])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get()).toBeUndefined()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeDefined()
  })

  it('leaves the database usable after a failed migration', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.sqlite')

    const bad = [
      { version: 1, name: '0001_ok.sql', sql: 'CREATE TABLE ok (id TEXT PRIMARY KEY)' },
      { version: 2, name: '0002_bad.sql', sql: 'THIS IS NOT SQL' },
    ]
    const db1 = openDatabase({ path })
    expect(() => migrate(db1, { migrations: bad })).toThrow()
    db1.close()

    // Reopening with the corrected set applies the rest.
    const db2 = openDatabase({ path })
    closers.push(() => db2.close())
    const fixed = [
      { version: 1, name: '0001_ok.sql', sql: 'CREATE TABLE ok (id TEXT PRIMARY KEY)' },
      { version: 2, name: '0002_good.sql', sql: 'CREATE TABLE good (id TEXT PRIMARY KEY)' },
    ]
    expect(migrate(db2, { migrations: fixed })).toEqual([2])
    expect(appliedMigrations(db2).map((row) => row.version)).toEqual([1, 2])
  })

  it('refuses to run against a database newer than the code', () => {
    const db = openDatabase({ path: join(tempDir(), 'ops.sqlite') })
    closers.push(() => db.close())

    // A database written by a newer build.
    const future = [
      { version: 1, name: '0001_a.sql', sql: 'CREATE TABLE a (id TEXT)' },
      { version: 99, name: '0099_future.sql', sql: 'CREATE TABLE future (id TEXT)' },
    ]
    migrate(db, { migrations: future })

    // This build only knows version 1.
    let error: unknown
    try {
      migrate(db, { migrations: [{ version: 1, name: '0001_a.sql', sql: 'CREATE TABLE a (id TEXT)' }] })
    } catch (caught) {
      error = caught
    }
    expect(OpsError.hasCode(error, 'MIGRATION_ERROR')).toBe(true)
    expect((error as OpsError).message).toContain('newer than this build')
    expect((error as OpsError).details['newer']).toEqual([99])
  })

  it('creates the bookkeeping table when it is missing', () => {
    const db = openDatabase({ path: join(tempDir(), 'ops.sqlite') })
    closers.push(() => db.close())
    // Reading before any migration must not fail.
    expect(appliedMigrations(db)).toEqual([])
  })
})

describe('OpsStore startup', () => {
  it('creates the database and applies migrations when the file is absent', () => {
    const dir = tempDir()
    const path = join(dir, 'nested', 'ops.sqlite')
    const store = new OpsStore({ path })
    closers.push(() => store.close())

    expect(store.isOpen).toBe(true)
    expect(store.migrationsApplied).toEqual([1])
    expect(store.appliedMigrations()).toHaveLength(1)
    // A project can be written immediately, so the schema is really there.
    store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, 0)
    expect(store.projects.get('a')).toBeDefined()
  })

  it('enables WAL and the other required pragmas', () => {
    const store = new OpsStore({ path: join(tempDir(), 'ops.sqlite') })
    closers.push(() => store.close())

    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(store.db.pragma('synchronous', { simple: true })).toBe(1)
    expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(store.db.pragma('busy_timeout', { simple: true })).toBe(5000)
  })

  it('closes idempotently', () => {
    const store = new OpsStore({ path: join(tempDir(), 'ops.sqlite') })
    expect(store.isOpen).toBe(true)
    store.close()
    expect(store.isOpen).toBe(false)
    expect(() => store.close()).not.toThrow()
  })

  it('reports closed state as a health failure rather than throwing', () => {
    const store = new OpsStore({ path: join(tempDir(), 'ops.sqlite') })
    expect(store.health().status).toBe('ok')
    store.close()
    expect(store.health()).toMatchObject({ status: 'down' })
  })

  it('refuses a repository call after close', () => {
    const store = new OpsStore({ path: join(tempDir(), 'ops.sqlite') })
    store.close()
    expect(() => store.prune({}, 0)).toThrow(OpsError)
    expect(() => store.integrity()).toThrow(OpsError)
  })

  it('reports an integrity check of ok on a fresh database', () => {
    const store = new OpsStore({ path: join(tempDir(), 'ops.sqlite') })
    closers.push(() => store.close())
    expect(store.integrity()).toBe('ok')
  })

  it('surfaces a clear error for an unopenable path', () => {
    // A path whose parent is a file, not a directory.
    const dir = tempDir()
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    expect(() => new OpsStore({ path: join(file, 'ops.sqlite') })).toThrow(OpsError)
  })
})
