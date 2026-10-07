// == ARGUS AGENT PROJECT ==
/**
 * The crash-safety test.
 *
 * `kill -9` during a batch insert must leave no partial batch after restart, and
 * the database must pass `PRAGMA integrity_check`. This is the test that proves
 * the transaction boundaries are real rather than nominal.
 *
 * The kill is delivered to a **separate process**, because a `SIGKILL` cannot be
 * caught: the only honest way to test it is to lose a process.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/connection.js'
import { OpsStore } from '../../src/service.js'
import { projectScope, usd } from '@argus-agent/types'

const dirs: string[] = []
const closers: Array<() => void> = []

/**
 * A directory for a child script, INSIDE the repository: the script imports
 * workspace packages by name, and Node resolves those only from a directory with
 * the repository's node_modules above it — never from the system temp directory.
 */
function scriptDir(): string {
  const dir = mkdtempSync(join(import.meta.dirname, '.child-'))
  dirs.push(dir)
  return dir
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-crash-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The child's program: append events forever, reporting each committed batch. */
const CHILD_SCRIPT = `
import { OpsStore } from ${JSON.stringify(fileURLToPath(new URL('../../src/service.ts', import.meta.url)))}
import { projectScope, usd } from '@argus-agent/types'

const path = process.argv[2]
const store = new OpsStore({ path })
const day = () => '2026-10-03'
let batch = 0
// Append a batch, then report it committed. A SIGKILL between the report and
// the next append leaves a database whose last batch is complete.
for (;;) {
  const events = Array.from({ length: 20 }, (_, index) => ({
    ts: 1000 + batch * 20 + index,
    run_id: 'run-1',
    project_id: 'a',
    scope: projectScope('a'),
    root_session: 's1',
    session_id: 's1',
    provider: 'fake',
    model: 'm',
    input_tokens: 1,
    cached_tokens: 0,
    output_tokens: 1,
    cost_micros: usd(0.000001),
  }))
  store.usage.appendBatch(events, day)
  batch += 1
  process.stdout.write('BATCH ' + batch + '\\n')
  // A little work between batches, so the kill lands inside or between them
  // rather than always at the same point.
  for (let i = 0; i < 2000; i += 1) Math.sqrt(i)
}
`

describe('crash safety', () => {
  it('survives SIGKILL during batch inserts with no partial batch and no corruption', async () => {
    const dir = tempDir()
    const path = join(dir, 'ops.sqlite')
    const scriptPath = join(scriptDir(), 'child.mts')
    writeFileSync(scriptPath, CHILD_SCRIPT)

    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, path], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))

    // Wait until several batches have committed, then kill without warning.
    const deadline = Date.now() + 60_000
    while (!/BATCH [5-9]\d*\n/.test(stdout) && Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`child exited early with ${child.exitCode}: ${stderr.slice(-800)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(stdout, `child never committed enough batches; stderr: ${stderr.slice(-500)}`).toMatch(
      /BATCH \d+/,
    )

    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))

    // The process is gone with no cleanup, no close, no flush.
    const committedBatches = (stdout.match(/BATCH /g) ?? []).length
    expect(committedBatches).toBeGreaterThan(0)

    // Reopen and verify.
    const db = openDatabase({ path })
    closers.push(() => db.close())

    // FACT: the file is structurally sound after an abrupt kill.
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('foreign_key_check')).toEqual([])

    // FACT: every committed batch is complete. Each batch appends exactly 20
    // events, so the total is a multiple of 20 — a partial batch would leave a
    // remainder. The child may have committed more batches than the last one it
    // reported (the report follows the commit), so this is a lower bound that
    // must still be exact.
    const count = (db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n
    expect(count % 20).toBe(0)
    expect(count).toBeGreaterThanOrEqual(committedBatches * 20)

    // FACT: the rollup matches the raw events exactly, which is the invariant a
    // torn batch would break. This is the reconciliation test run against a
    // crashed database.
    const raw = db
      .prepare(
        `SELECT scope, COUNT(*) AS n,
                COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_micros), 0)   AS cost_micros
         FROM usage_events GROUP BY scope`,
      )
      .all() as Array<{
      scope: string
      n: number
      input_tokens: number
      cached_tokens: number
      output_tokens: number
      cost_micros: number
    }>
    const daily = db.prepare('SELECT * FROM usage_daily WHERE day = ?').all('2026-10-03') as Array<{
      scope: string
      input_tokens: number
      cached_tokens: number
      output_tokens: number
      cost_micros: number
    }>

    expect(daily).toHaveLength(raw.length)
    for (const row of raw) {
      const rolled = daily.find((entry) => entry.scope === row.scope)
      expect(rolled, `no rollup for ${row.scope}`).toBeDefined()
      expect({
        input_tokens: rolled?.input_tokens,
        cached_tokens: rolled?.cached_tokens,
        output_tokens: rolled?.output_tokens,
        cost_micros: rolled?.cost_micros,
      }).toEqual({
        input_tokens: row.input_tokens,
        cached_tokens: row.cached_tokens,
        output_tokens: row.output_tokens,
        cost_micros: row.cost_micros,
      })
    }

    // FACT: the WAL was recovered — the database is usable and writable.
    const store = new OpsStore({ path })
    closers.push(() => store.close())
    expect(store.usage.appendBatch([], () => '2026-10-03')).toBe(0)
    expect(store.health().status).toBe('ok')
  }, 120_000)

  it('recovers interrupted runs after a crash', async () => {
    const dir = tempDir()
    const path = join(dir, 'ops.sqlite')

    // A run started but never finished, as a crash leaves it.
    const first = new OpsStore({ path })
    first.inbound.insert({ id: 'req-1', source: 'channel', project_id: 'a', payload: '[]', priority: 0 }, 1000)
    first.runs.start(
      {
        id: 'run-1',
        inbound_id: 'req-1',
        project_id: 'a',
        owner_key: 'project:a',
        session_id: 's1',
        provider: 'fake',
        model: 'm',
      },
      2000,
    )
    first.runs.start(
      {
        id: 'run-2',
        inbound_id: 'req-1',
        project_id: 'a',
        owner_key: 'project:a',
        session_id: 's1',
        provider: 'fake',
        model: 'm',
      },
      3000,
    )
    first.runs.finish('run-2', 'completed', 4000)
    first.close()

    // A new process recovers.
    const second = new OpsStore({ path })
    closers.push(() => second.close())

    const affected = second.recoverInterruptedRuns(5000)
    // Only the genuinely interrupted run is reported, so the notification names
    // what was lost rather than counting everything.
    expect(affected.map((row) => row.id)).toEqual(['run-1'])
    expect(second.runs.get('run-1')).toMatchObject({
      status: 'interrupted',
      stop_reason: 'crash',
      ended_at: 5000,
    })
    expect(second.runs.get('run-2')?.status).toBe('completed')
    expect(second.runs.active()).toHaveLength(0)
  })

  it('keeps a pending request across a reopen', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.sqlite')

    const first = new OpsStore({ path })
    first.inbound.insert(
      { id: 'req-pending', source: 'channel', project_id: 'a', payload: '[]', priority: 0 },
      1000,
    )
    first.close()

    // The request was written before anything ran, so a crash cannot lose it.
    const second = new OpsStore({ path })
    closers.push(() => second.close())
    expect(second.inbound.get('req-pending')).toMatchObject({ status: 'pending' })
    expect(second.inbound.nextPending(10).map((row) => row.id)).toEqual(['req-pending'])
  })

  it('does not lose a committed transaction when the process is killed', async () => {
    // A narrower, faster case: commit one batch, report it, then hang. The kill
    // must not undo the commit.
    const dir = tempDir()
    const path = join(dir, 'ops.sqlite')
    const scriptPath = join(scriptDir(), 'commit-then-hang.mts')
    writeFileSync(
      scriptPath,
      `
import { OpsStore } from ${JSON.stringify(fileURLToPath(new URL('../../src/service.ts', import.meta.url)))}
import { projectScope, usd } from '@argus-agent/types'
const store = new OpsStore({ path: process.argv[2] })
store.usage.appendBatch([{
  ts: 5000, run_id: 'run-1', project_id: 'a', scope: projectScope('a'),
  root_session: 's1', session_id: 's1', provider: 'fake', model: 'm',
  input_tokens: 42, cached_tokens: 0, output_tokens: 7, cost_micros: usd(0.5),
}], () => '2026-10-03')
process.stdout.write('COMMITTED\\n')
await new Promise((resolve) => setTimeout(resolve, 600000))
`,
    )

    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, path], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))

    const deadline = Date.now() + 60_000
    while (!stdout.includes('COMMITTED') && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`child exited early: ${stderr.slice(-500)}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(stdout).toContain('COMMITTED')
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))

    const store = new OpsStore({ path })
    closers.push(() => store.close())
    const daily = store.usage.daily(projectScope('a'), '2026-10-03')
    expect(daily).toMatchObject({ input_tokens: 42, output_tokens: 7, cost_micros: usd(0.5) })
    expect(store.usage.eventsBetween(0, 10_000)).toHaveLength(1)
  }, 120_000)

  it('recovers a database left with a hot WAL journal', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.sqlite')

    // Write without a clean close, leaving the WAL beside the database.
    const first = new OpsStore({ path })
    first.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, 1000)
    // Deliberately no `close()`: the WAL file remains.

    const second = new OpsStore({ path })
    closers.push(() => second.close())
    // SQLite replays the WAL on open; the row is visible and the database sound.
    expect(second.projects.get('a')).toMatchObject({ id: 'a' })
    expect(second.integrity()).toBe('ok')
  })
})

describe('concurrent access', () => {
  it('allows a reader while a writer holds the database', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.sqlite')

    const writer = new OpsStore({ path })
    closers.push(() => writer.close())
    writer.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, 1000)

    // A second connection can read. WAL is what makes this true: with the
    // default rollback journal the reader would block on the writer.
    const reader = new OpsStore({ path })
    closers.push(() => reader.close())
    expect(reader.projects.get('a')).toMatchObject({ id: 'a' })
    expect(reader.db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('reports a clear error when the database is locked beyond the timeout', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.sqlite')

    // A real store, so the schema exists and the only obstacle is the lock.
    const holder = new OpsStore({ path })
    closers.push(() => holder.close())

    // Hold an exclusive transaction, then try to write from a second connection
    // with a tiny busy timeout.
    holder.db.exec('BEGIN EXCLUSIVE')
    const blocked = openDatabase({ path, busyTimeoutMs: 50 })
    closers.push(() => blocked.close())

    let error: unknown
    try {
      blocked
        .prepare('INSERT INTO projects (id, cwd, provider, model, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('x', '/p/x', 'fake', 'm', 1, 1)
    } catch (caught) {
      error = caught
    }
    // A lock beyond the timeout surfaces as SQLITE_BUSY with a usable message,
    // rather than hanging or silently dropping the write.
    expect(error).toBeDefined()
    expect(String((error as Error).message)).toMatch(/locked|busy/i)

    holder.db.exec('ROLLBACK')
  })
})
