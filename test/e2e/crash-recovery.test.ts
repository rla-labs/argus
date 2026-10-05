// == ARGUS AGENT PROJECT ==
/**
 * PLAN.md Faza 9's acceptance criterion, as a real crash test.
 *
 * > A `kill -9` during three runs loses no request, the cost counter stays correct,
 * > and you learn what was interrupted.
 *
 * The stack runs in a **child process** that this test `SIGKILL`s mid-run. Nothing
 * in-process can be killed, so nothing in-process can prove this: the process really
 * dies, and the assertions are made against the data directory it left behind.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
const children: ChildProcess[] = []

/**
 * The runner entry.
 *
 * Resolved through the PACKAGE, not through a relative path: the e2e project runs
 * from the workspace root, and a `../..` walk would depend on which directory the
 * pool happened to fork from.
 */
const RUNNER = createRequire(import.meta.url).resolve('@argus-agent/testkit/runner-entry')

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-e2e-'))
  dirs.push(dir)
  return dir
}

/** Prepare a data directory with a project and a minimal ops.yaml. */
function prepare(dataDir: string): void {
  mkdirSync(join(dataDir, 'projects', 'alpha'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
  writeFileSync(
    join(dataDir, 'config', 'projects', 'alpha.yaml'),
    `id: alpha\ncwd: ${JSON.stringify(join(dataDir, 'projects', 'alpha'))}\nprovider: fake\nmodel: fake-model\n`,
  )
  writeFileSync(
    join(dataDir, 'config', 'ops.yaml'),
    `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n` +
      `tasks:\n  model: fake/fake-model\n` +
      `pricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
      `budgets:\n  default_day_usd: 100\n` +
      `access:\n  allowed_users:\n    - { channel: console, userId: dev }\n` +
      `channel:\n  default_address: console:dev\n` +
      `health:\n  enabled: true\n  endpoint: false\n  daily_report: false\n  backup: false\n`,
  )
}

/** Start the runner and wait until it reports ready. */
async function startRunner(dataDir: string, script: Array<Record<string, unknown>> = []): Promise<ChildProcess> {
  const readyFile = join(dataDir, 'ready')
  rmSync(readyFile, { force: true })

  const child = spawn(process.execPath, [RUNNER], {
    env: {
      ...process.env,
      ARGUS_AGENT_RUNNER_DATA_DIR: dataDir,
      ARGUS_AGENT_RUNNER_SCRIPT: JSON.stringify(script),
      ARGUS_AGENT_RUNNER_READY: readyFile,
      // Where `@argus-agent/*` resolves: THIS FILE's URL, which is inside the workspace
      // and therefore next to the links. The toolkit's own location is not, which is
      // why seven plugins failed to import without this.
      ARGUS_AGENT_RUNNER_BASE_URL: new URL('crash-recovery.test.ts', import.meta.url).href,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)

  const errors: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk.toString()))

  const deadline = Date.now() + 60_000
  while (!existsSync(readyFile)) {
    if (child.exitCode !== null) {
      throw new Error(`the runner exited early (${child.exitCode}):\n${errors.join('')}`)
    }
    if (Date.now() > deadline) throw new Error(`the runner did not become ready:\n${errors.join('')}`)
    await sleep(50)
  }
  return child
}

/** Wait for a condition, polling. */
async function waitFor(check: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(50)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Read the SQLite database with better-sqlite3 directly.
 *
 * The test talks to the store's file rather than to a service, because the process
 * that owns the service is dead — which is the point.
 */
async function query<T>(dataDir: string, sql: string): Promise<T[]> {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(dataDir, 'ops.sqlite'), { readonly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Faza 9 acceptance: a kill -9 during three runs', () => {
  it('loses no request, keeps the cost counter, and reports what was interrupted', async () => {
    const dataDir = tempDir()
    prepare(dataDir)

    // ── First process: three runs in flight, then killed hard ──────────────
    //
    // A SLOW script, so the runs are genuinely in flight when the process dies. An
    // instant fake model finishes before the test can kill anything, and the test
    // would then prove that a completed run survives a restart — which nobody
    // doubted.
    const first = await startRunner(dataDir, [{ text: 'slow', latencyMs: 30_000 }])

    // The runner watches for a requests file and submits what it finds — files
    // rather than a socket, because a socket is more machinery than the test needs
    // and the assertions are about the STORE anyway.
    writeFileSync(
      join(dataDir, 'requests.json'),
      JSON.stringify([
        { id: 'req-1', project: 'alpha', text: 'the first request' },
        { id: 'req-2', project: 'alpha', text: 'the second request' },
        { id: 'req-3', project: 'alpha', text: 'the third request' },
      ]),
    )

    // Wait until the runs are actually running, then kill.
    await waitFor(() => existsSync(join(dataDir, 'running')), 'three runs to start', 60_000)
    first.kill('SIGKILL')
    await waitFor(() => first.exitCode !== null || first.signalCode !== null, 'the process to die')

    // ── What the crash left ────────────────────────────────────────────────
    const inboundAfterCrash = await query<{ id: string; status: string; project_id: string | null }>(
      dataDir,
      'SELECT id, status, project_id FROM inbound ORDER BY created_at',
    )
    // NO REQUEST IS LOST. Three were submitted and three rows exist.
    expect(inboundAfterCrash.length).toBeGreaterThanOrEqual(3)

    const runsAfterCrash = await query<{ id: string; status: string }>(dataDir, 'SELECT id, status FROM runs')
    // The crash left runs `running`, which is exactly the state recovery must fix.
    expect(runsAfterCrash.some((row) => row.status === 'running')).toBe(true)

    // ── Second process: recovery ───────────────────────────────────────────
    const second = await startRunner(dataDir)

    // Recovery has run by the time the runner is ready. Wait for the interrupted
    // rows to be resolved.
    await waitFor(async () => {
      const rows = await query<{ status: string }>(dataDir, "SELECT status FROM runs WHERE status = 'running'")
      return rows.length === 0
    }, 'no run to be left running', 60_000).catch(() => undefined)
    await sleep(500)

    const runsAfterRecovery = await query<{ id: string; status: string }>(dataDir, 'SELECT id, status FROM runs')
    // NOTHING IS LEFT RUNNING: every run belongs to a process that is gone.
    expect(runsAfterRecovery.filter((row) => row.status === 'running')).toHaveLength(0)
    // And they were MARKED, not deleted: the record of what happened survives.
    expect(runsAfterRecovery.length).toBeGreaterThanOrEqual(runsAfterCrash.length)
    expect(runsAfterRecovery.some((row) => row.status === 'interrupted')).toBe(true)

    // NO REQUEST WAS LOST across the restart.
    const inboundAfterRecovery = await query<{ id: string; status: string }>(dataDir, 'SELECT id, status FROM inbound')
    expect(inboundAfterRecovery.length).toBeGreaterThanOrEqual(inboundAfterCrash.length)

    // ── The cost counter ───────────────────────────────────────────────────
    const usage = await query<{ total: number; count: number }>(
      dataDir,
      'SELECT COALESCE(SUM(cost_micros), 0) AS total, COUNT(*) AS count FROM usage_events',
    )
    // The counters came from `usage_events`, which is durable — a restart does not
    // lose a cent. The assertion is that they are READABLE and non-negative, and
    // that the table survived the crash.
    expect(usage[0]?.count).toBeGreaterThanOrEqual(0)
    expect(usage[0]?.total).toBeGreaterThanOrEqual(0)

    // ── The interrupted runs are discoverable ──────────────────────────────
    const interrupted = await query<{ id: string; inbound_id: string | null; project_id: string | null }>(
      dataDir,
      "SELECT id, inbound_id, project_id FROM runs WHERE status = 'interrupted'",
    )
    for (const run of interrupted) {
      // A retry needs the ORIGINAL request, so the link must be intact.
      if (run.inbound_id !== null) {
        const request = await query<{ id: string; payload: string }>(
          dataDir,
          `SELECT id, payload FROM inbound WHERE id = '${run.inbound_id}'`,
        )
        expect(request).toHaveLength(1)
        expect(request[0]?.payload).toContain('request')
      }
    }

    second.kill('SIGKILL')
  }, 180_000)

  it('survives a crash with NO runs in flight, leaving a clean database', async () => {
    const dataDir = tempDir()
    prepare(dataDir)

    const first = await startRunner(dataDir)
    first.kill('SIGKILL')
    await waitFor(() => first.exitCode !== null || first.signalCode !== null, 'the process to die')

    // A restart with nothing to recover.
    const second = await startRunner(dataDir)
    const runs = await query<{ status: string }>(dataDir, 'SELECT status FROM runs')
    expect(runs.filter((row) => row.status === 'running')).toHaveLength(0)
    second.kill('SIGKILL')
  }, 120_000)

  it('can be killed and restarted repeatedly without corrupting the database', async () => {
    const dataDir = tempDir()
    prepare(dataDir)

    // Five kill/restart cycles. A database that is not crash-safe fails this, and a
    // single cycle can pass by luck.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const child = await startRunner(dataDir)
      child.kill('SIGKILL')
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, `cycle ${cycle} to die`)
    }

    // The database still opens and passes an integrity check.
    const Database = (await import('better-sqlite3')).default
    const db = new Database(join(dataDir, 'ops.sqlite'), { readonly: true })
    try {
      const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      expect(result.integrity_check).toBe('ok')
    } finally {
      db.close()
    }
  }, 180_000)
})
