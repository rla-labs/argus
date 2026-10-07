// == ARGUS AGENT PROJECT ==
/**
 * `backup.sh` → `restore.sh`, a real round trip.
 *
 * The prompt requires "a `backup.sh` then `restore.sh` round trip with data
 * verification". This does it against real files and a real SQLite database, using the
 * shipped scripts — not a reimplementation of them.
 *
 * The properties that matter, and why each is asserted:
 *
 * - **Consistency.** The database artifact must be a readable SQLite file with the same
 *   rows, because a torn copy passes `-s` and fails on restore.
 * - **Completeness.** The archive must carry the sessions, the workspaces and the
 *   config — the things a restore is actually for.
 * - **Exclusions.** `scratch/` must not be in the archive, and the database must not be
 *   duplicated into it.
 * - **Non-destructiveness.** A file in the backup directory that the script did not
 *   create must survive rotation.
 * - **Reversibility.** The restore must move the previous data aside rather than delete
 *   it, so a mistaken restore is recoverable.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const DEPLOY = join(import.meta.dirname, '..', '..', 'deploy')
const BACKUP_SH = join(DEPLOY, 'scripts', 'backup.sh')
const RESTORE_SH = join(DEPLOY, 'scripts', 'restore.sh')

const dirs: string[] = []

// A reachable `docker` that knows no container. The scripts refuse to touch a data
// directory other than the one a running argus-agent container serves; with the real
// docker, a deployment running on the developer's machine would fail these tests.
const NO_DOCKER = mkdtempSync(join(tmpdir(), 'argus-agent-nodocker-'))
writeFileSync(
  join(NO_DOCKER, 'docker'),
  '#!/bin/sh\ncase "$1" in info|compose) exit 0 ;; *) echo "No such container" >&2; exit 1 ;; esac\n',
  { mode: 0o755 },
)

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // The restore creates `<data>-pre-restore-*` beside the data directory.
    for (const entry of readdirSync(tmpdir()).filter((name) => name.startsWith('argus-agent-br-'))) {
      const full = join(tmpdir(), entry)
      if (dir.startsWith(full) || full.startsWith(dir)) rmSync(full, { recursive: true, force: true })
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run a deploy script with the data directory pointed at a fixture. */
function run(script: string, dataDir: string, args: string[] = [], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, ...args],
      {
        env: {
          ...process.env,
          PATH: `${NO_DOCKER}:${process.env['PATH'] ?? ''}`,
          ARGUS_AGENT_DATA_PATH: dataDir,
          ASSUME_YES: '1',
          NO_COLOR: '1',
          ...env,
        },
        timeout: 60_000,
        // A generous buffer: the scripts print a lot of progress on purpose.
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : (((error as { code?: number }).code as number) ?? 1)
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** A data directory with something worth backing up. */
async function makeFixture(): Promise<{ dataDir: string; db: import('better-sqlite3').Database }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'argus-agent-br-'))
  dirs.push(dataDir)

  for (const sub of ['config/projects', 'projects/demo', 'state/demo', 'scratch/adhoc-1', 'memory', 'backups', 'sessions', 'dsh-home']) {
    mkdirSync(join(dataDir, sub), { recursive: true })
  }

  // A real SQLite database, with the tables a backup must carry.
  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(dataDir, 'ops.sqlite'))
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE inbound (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', '3')
  db.prepare('INSERT INTO runs VALUES (?, ?)').run('run-1', 'completed')
  db.prepare('INSERT INTO runs VALUES (?, ?)').run('run-2', 'interrupted')
  db.prepare('INSERT INTO inbound VALUES (?, ?)').run('req-1', 'done')

  // The files a restore is actually for.
  writeFileSync(join(dataDir, 'config', 'ops.yaml'), 'timezone: Europe/Bucharest\ndata_dir: /data\n')
  writeFileSync(join(dataDir, 'config', 'projects', 'demo.yaml'), 'id: demo\ncwd: /data/projects/demo\n')
  writeFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'console.log("the project code")\n')
  writeFileSync(join(dataDir, 'state', 'demo', 'MEMORY.md'), '## Facts\nThe deployment uses Postgres.\n')
  writeFileSync(join(dataDir, 'memory', 'USER.md'), 'Prefers terse answers.\n')
  writeFileSync(join(dataDir, 'sessions', 'session-1.jsonl'), '{"turn":1}\n')
  // The thing that must NOT be backed up.
  writeFileSync(join(dataDir, 'scratch', 'adhoc-1', 'downloaded.zip'), 'BIG TEMPORARY THING')

  return { dataDir, db }
}

/** Read a value from a database file. */
async function readFrom(path: string, sql: string): Promise<unknown[]> {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(path, { readonly: true })
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

/** The artifact paths a backup printed on stdout. */
function artifacts(result: RunResult): { db: string; data: string } {
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  return {
    db: lines.find((line) => line.endsWith('.sqlite')) ?? '',
    data: lines.find((line) => line.endsWith('.tar.gz')) ?? '',
  }
}

describe('backup.sh → restore.sh round trip', () => {
  it('produces a consistent database and a complete archive', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const backup = await run(BACKUP_SH, dataDir)
    expect(backup.code).toBe(0)

    const { db: dbArtifact, data: dataArtifact } = artifacts(backup)
    expect(dbArtifact).not.toBe('')
    expect(dataArtifact).not.toBe('')
    expect(existsSync(dbArtifact)).toBe(true)
    expect(existsSync(dataArtifact)).toBe(true)

    // CONSISTENCY: a real SQLite database, with the same rows.
    expect(readFileSync(dbArtifact).subarray(0, 15).toString()).toBe('SQLite format 3')
    const runs = (await readFrom(dbArtifact, 'SELECT id FROM runs ORDER BY id')) as Array<{ id: string }>
    expect(runs.map((row) => row.id)).toEqual(['run-1', 'run-2'])

    // The script verifies its own artifact, so its output must say so.
    expect(backup.stderr).toContain('integrity ok')
  }, 90_000)

  it('excludes scratch/ and does not duplicate the database', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const backup = await run(BACKUP_SH, dataDir)
    const { data: dataArtifact } = artifacts(backup)

    const listing = await new Promise<string>((resolve) => {
      execFile('tar', ['tzf', dataArtifact], { maxBuffer: 10 * 1024 * 1024 }, (_e, stdout) => resolve(stdout))
    })

    // The archive carries what a restore is for.
    expect(listing).toContain('./projects/demo/index.js')
    expect(listing).toContain('./state/demo/MEMORY.md')
    expect(listing).toContain('./memory/USER.md')
    expect(listing).toContain('./config/ops.yaml')
    expect(listing).toContain('./sessions/session-1.jsonl')

    // EXCLUSIONS. `scratch/` is disposable, and the database is backed up on its own —
    // a tar of a live SQLite file is exactly the torn read the online backup avoids.
    expect(listing).not.toContain('scratch')
    expect(listing).not.toContain('downloaded.zip')
    expect(listing).not.toContain('ops.sqlite')
    expect(listing).not.toContain('backups/')
  }, 90_000)

  it('restores everything the backup captured', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const backup = await run(BACKUP_SH, dataDir)
    const { db: dbArtifact, data: dataArtifact } = artifacts(backup)

    // CHANGE EVERYTHING, so a restore that did nothing would be caught.
    const Database = (await import('better-sqlite3')).default
    const live = new Database(join(dataDir, 'ops.sqlite'))
    live.prepare('INSERT INTO runs VALUES (?, ?)').run('run-AFTER-BACKUP', 'completed')
    live.prepare('DELETE FROM runs WHERE id = ?').run('run-1')
    live.close()

    writeFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'MODIFIED AFTER THE BACKUP\n')
    writeFileSync(join(dataDir, 'state', 'demo', 'MEMORY.md'), 'MODIFIED\n')
    rmSync(join(dataDir, 'memory', 'USER.md'))
    writeFileSync(join(dataDir, 'scratch', 'adhoc-1', 'downloaded.zip'), 'STILL HERE')

    const restore = await run(RESTORE_SH, dataDir, ['--db', dbArtifact, '--data', dataArtifact])
    expect(restore.code).toBe(0)

    // THE DATABASE: the post-backup row is gone, the deleted row is back.
    const runs = (await readFrom(join(dataDir, 'ops.sqlite'), 'SELECT id FROM runs ORDER BY id')) as Array<{ id: string }>
    expect(runs.map((row) => row.id)).toEqual(['run-1', 'run-2'])

    // THE FILES: the modified ones are the originals again, and the deleted one is back.
    expect(readFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'utf8')).toBe('console.log("the project code")\n')
    expect(readFileSync(join(dataDir, 'state', 'demo', 'MEMORY.md'), 'utf8')).toContain('Postgres')
    expect(existsSync(join(dataDir, 'memory', 'USER.md'))).toBe(true)
    expect(readFileSync(join(dataDir, 'config', 'ops.yaml'), 'utf8')).toContain('Europe/Bucharest')

    // SCRATCH IS UNTOUCHED — it was not in the archive, so the restore must not have
    // emptied the directory.
    expect(readFileSync(join(dataDir, 'scratch', 'adhoc-1', 'downloaded.zip'), 'utf8')).toBe('STILL HERE')

    // THE PREVIOUS DATA IS PRESERVED, not deleted.
    const siblings = readdirSync(tmpdir()).filter((name) => name.startsWith(`${dataDir.split('/').pop() ?? ''}-pre-restore-`))
    expect(siblings.length).toBeGreaterThanOrEqual(1)
    const safety = join(tmpdir(), siblings[0] as string)
    // The modified file is in the preserved copy, which is what makes a mistaken
    // restore recoverable.
    expect(existsSync(join(safety, 'projects', 'demo', 'index.js'))).toBe(true)

    expect(restore.stderr).toContain('previous data')
  }, 90_000)

  it('refuses a corrupt database artifact BEFORE destroying anything', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const backup = await run(BACKUP_SH, dataDir)
    const { db: dbArtifact, data: dataArtifact } = artifacts(backup)

    // TRUNCATE the artifact. This matters, and the first version of this test got it
    // wrong: zeroing a few hundred bytes inside a 12 KB page left SQLite reporting `ok`,
    // because the bytes happened to be unused space — the file was not actually corrupt.
    // A truncated file loses real pages, which is the case a header check passes and a
    // restore ruins.
    const bytes = readFileSync(dbArtifact)
    writeFileSync(dbArtifact, bytes.subarray(0, Math.floor(bytes.length / 2)))

    const before = readFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'utf8')

    const restore = await run(RESTORE_SH, dataDir, ['--db', dbArtifact, '--data', dataArtifact])
    expect(restore.code).toBe(1)
    // Either a full integrity check ran (sqlite3 or the container) and refused, or only
    // a header check was possible and the confirmation was declined because there is no
    // terminal. Both are refusals; the test asserts the artifact was NOT restored.
    expect(restore.stderr).toMatch(/integrity|corrupt|malformed|header check|aborted/i)

    // NOTHING WAS DESTROYED: the live data is untouched.
    expect(readFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'utf8')).toBe(before)

    await readFrom(join(dataDir, 'ops.sqlite'), 'SELECT 1')
  }, 90_000)

  it('refuses a file that is not a SQLite database', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const backup = await run(BACKUP_SH, dataDir)
    const { data: dataArtifact } = artifacts(backup)

    const bogus = join(dataDir, 'bogus.sqlite')
    writeFileSync(bogus, 'this is not a database')

    const restore = await run(RESTORE_SH, dataDir, ['--db', bogus, '--data', dataArtifact])
    expect(restore.code).toBe(1)
    expect(restore.stderr).toMatch(/not a SQLite database|integrity/i)
  }, 90_000)

  it('refuses an unreadable archive', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const backup = await run(BACKUP_SH, dataDir)
    const { db: dbArtifact } = artifacts(backup)

    const bogus = join(dataDir, 'corrupt.tar.gz')
    writeFileSync(bogus, 'not a tarball')

    const restore = await run(RESTORE_SH, dataDir, ['--db', dbArtifact, '--data', bogus])
    expect(restore.code).toBe(1)
    expect(restore.stderr).toMatch(/not readable/i)
  }, 90_000)
})

describe('backup.sh retention', () => {
  it('keeps the configured number of sets', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    // Three backups, which the second-resolution stamp distinguishes only if they are
    // separated — so the fixture uses pre-seeded names instead of sleeping.
    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    for (const stamp of ['20200101-000001', '20200101-000002', '20200101-000003']) {
      writeFileSync(join(dataDir, 'backups', `ops-${stamp}.sqlite`), 'old')
      writeFileSync(join(dataDir, 'backups', `data-${stamp}.tar.gz`), 'old')
    }

    const backup = await run(BACKUP_SH, dataDir, ['--keep', '2'])
    expect(backup.code).toBe(0)

    const databases = readdirSync(join(dataDir, 'backups')).filter((name) => /^ops-.*\.sqlite$/.test(name))
    const archives = readdirSync(join(dataDir, 'backups')).filter((name) => /^data-.*\.tar\.gz$/.test(name))

    // Two of each: the new one plus the newest fixture.
    expect(databases).toHaveLength(2)
    expect(archives).toHaveLength(2)
  }, 90_000)

  it('NEVER deletes a file it did not create', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    // Four files that a naive rotation would remove, each for a different reason.
    writeFileSync(join(dataDir, 'backups', 'important.txt'), 'my own notes')
    writeFileSync(join(dataDir, 'backups', 'ops-manual-copy.sqlite'), 'not a dated name')
    writeFileSync(join(dataDir, 'backups', 'notes.sqlite'), 'not our prefix')
    mkdirSync(join(dataDir, 'backups', 'subdir'), { recursive: true })

    await run(BACKUP_SH, dataDir, ['--keep', '1'])

    for (const name of ['important.txt', 'ops-manual-copy.sqlite', 'notes.sqlite']) {
      expect(existsSync(join(dataDir, 'backups', name)), name).toBe(true)
    }
    expect(existsSync(join(dataDir, 'backups', 'subdir'))).toBe(true)
  }, 90_000)

  it('REGRESSION: a hand-made `ops-*.sqlite` must not consume the keep budget', async () => {
    // The same bug as the native script had: `-name 'ops-*.sqlite'` matches a stray
    // `ops-manual.sqlite`, which sorts after every dated name, so rotation treated it as
    // the newest backup and pruned the real ones. Both scripts are fixed and both are
    // asserted, because they share the defect and do not share the code.
    const { dataDir, db } = await makeFixture()
    db.close()
    mkdirSync(join(dataDir, 'backups'), { recursive: true })

    const Database = (await import('better-sqlite3')).default
    for (const stamp of ['20200101-000001', '20200101-000002', '20200101-000003']) {
      const old = new Database(join(dataDir, 'backups', `ops-${stamp}.sqlite`))
      old.exec('CREATE TABLE runs (id TEXT PRIMARY KEY)')
      old.close()
      writeFileSync(join(dataDir, 'backups', `data-${stamp}.tar.gz`), 'old')
    }
    writeFileSync(join(dataDir, 'backups', 'ops-manual.sqlite'), 'a stray copy')

    const result = await run(BACKUP_SH, dataDir, ['--keep', '2'])
    expect(result.code).toBe(0)

    const names = readdirSync(join(dataDir, 'backups'))
    expect(names.filter((n) => /^ops-\d{8}-\d{6}\.sqlite$/.test(n))).toHaveLength(2)
    expect(names).toContain('ops-manual.sqlite')
  }, 90_000)

  it('rejects a nonsensical keep value', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const zero = await run(BACKUP_SH, dataDir, ['--keep', '0'])
    expect(zero.code).toBe(1)
    expect(zero.stderr).toMatch(/at least 1|positive integer/)

    const text = await run(BACKUP_SH, dataDir, ['--keep', 'many'])
    expect(text.code).toBe(1)
    expect(text.stderr).toMatch(/positive integer/)
  }, 90_000)

  it('writes nothing on a dry run', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const before = readdirSync(join(dataDir, 'backups'))
    const result = await run(BACKUP_SH, dataDir, ['--dry-run'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('would write')
    expect(readdirSync(join(dataDir, 'backups'))).toEqual(before)
  }, 90_000)
})

describe('restore.sh selection', () => {
  it('lists what is available without restoring', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()
    await run(BACKUP_SH, dataDir)

    const before = readFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'utf8')
    const result = await run(RESTORE_SH, dataDir, ['--list'])

    expect(result.code).toBe(0)
    // The listing names the actual files, which is what makes `--list` usable for
    // choosing one to restore.
    const inBackups = readdirSync(join(dataDir, 'backups'))
    expect(inBackups.some((name) => name.endsWith('.sqlite'))).toBe(true)
    expect(result.stderr).toContain('.sqlite')
    expect(result.stderr).toContain('.tar.gz')
    // Nothing changed.
    expect(readFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'utf8')).toBe(before)
  }, 90_000)

  it('uses the newest pair when none is named', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()
    await run(BACKUP_SH, dataDir)

    const restore = await run(RESTORE_SH, dataDir)
    expect(restore.code).toBe(0)
    expect(restore.stderr).toContain('restore complete')
  }, 90_000)

  it('fails clearly when there is nothing to restore from', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()
    rmSync(join(dataDir, 'backups'), { recursive: true, force: true })

    const restore = await run(RESTORE_SH, dataDir)
    expect(restore.code).toBe(1)
    expect(restore.stderr).toMatch(/no database artifact|does not exist/)
  }, 90_000)

  it('refuses a named artifact that does not exist', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()

    const restore = await run(RESTORE_SH, dataDir, ['--db', '/nope/ops.sqlite', '--data', '/nope/data.tar.gz'])
    expect(restore.code).toBe(1)
    expect(restore.stderr).toMatch(/does not exist/)
  }, 90_000)

  it('does nothing on a dry run', async () => {
    const { dataDir, db } = await makeFixture()
    db.close()
    const backup = await run(BACKUP_SH, dataDir)
    const { db: dbArtifact, data: dataArtifact } = artifacts(backup)

    writeFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'CHANGED\n')
    const result = await run(RESTORE_SH, dataDir, ['--db', dbArtifact, '--data', dataArtifact, '--dry-run'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('nothing was changed')
    // The change survives a dry run, which is the whole point.
    expect(readFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'utf8')).toBe('CHANGED\n')
  }, 90_000)
})

describe('backup.sh without a database', () => {
  it('archives the files and says there is no database', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'argus-agent-br-nodb-'))
    dirs.push(dataDir)
    mkdirSync(join(dataDir, 'config'), { recursive: true })
    mkdirSync(join(dataDir, 'projects'), { recursive: true })
    writeFileSync(join(dataDir, 'config', 'ops.yaml'), 'timezone: UTC\ndata_dir: /data\n')
    writeFileSync(join(dataDir, 'projects', 'x.txt'), 'x')

    const result = await run(BACKUP_SH, dataDir)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('no database')

    // The archive is still produced: a deployment with no database yet still has a
    // configuration worth keeping.
    const { data: dataArtifact } = artifacts(result)
    expect(existsSync(dataArtifact)).toBe(true)
  }, 90_000)

  it('refuses a data directory that does not exist', async () => {
    const result = await run(BACKUP_SH, join(tmpdir(), 'definitely-not-here'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('does not exist')
  }, 60_000)
})
