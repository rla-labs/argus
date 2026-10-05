// == ARGUS AGENT PROJECT ==
/**
 * A test harness for the store.
 *
 * Opens a real SQLite database in a temporary directory (or in memory) and
 * applies the real migrations, so every test exercises the schema that ships.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { OpsStore } from '../src/service.js'

/** Every store opened by a test, so they are all closed afterwards. */
const open: OpsStore[] = []
const dirs: string[] = []

afterEach(() => {
  for (const store of open.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Open a store on a temporary file database.
 *
 * A file rather than `:memory:` because WAL mode is a property of the file, and
 * several tests assert on it.
 *
 * @param options optional `now` for the migration records.
 * @returns the open store and the directory holding it.
 */
export function openStore(options: { now?: number } = {}): { store: OpsStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ops-store-test-'))
  const path = join(dir, 'ops.sqlite')
  const store = new OpsStore({ path, ...(options.now !== undefined ? { now: options.now } : {}) })
  open.push(store)
  dirs.push(dir)
  return { store, dir, path }
}

/**
 * Open a store on an in-memory database.
 *
 * Faster, and the right choice for a test that only exercises repository logic.
 * WAL is unavailable in memory, so a test asserting on pragmas must use
 * {@link openStore}.
 *
 * @returns the open store.
 */
export function openMemoryStore(): OpsStore {
  const store = new OpsStore({ path: ':memory:' })
  open.push(store)
  return store
}

/** A fixed timestamp for deterministic rows. */
export const T0 = Date.parse('2026-10-03T12:00:00Z')

/** A timestamp `ms` after {@link T0}. */
export function at(ms: number): number {
  return T0 + ms
}
