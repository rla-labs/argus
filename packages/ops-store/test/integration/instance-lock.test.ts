// == ARGUS AGENT PROJECT ==
/**
 * One Argus Agent per data directory: the instance lock.
 *
 * The lock exists for a SECOND PROCESS, so the decisive tests use real child
 * processes — including one killed with SIGKILL, whose lock the operating system
 * must release without any cleanup code running.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { OpsError } from '@argus-agent/types'
import { InstanceLock } from '../../src/instance-lock.js'

const dirs: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-lock-'))
  dirs.push(dir)
  return dir
}

/** A child that takes the lock, prints the outcome, and then holds it until killed. */
function lockingChild(lockPath: string): Promise<{ child: ChildProcess; outcome: string }> {
  // Inside the repository, so the child's imports resolve (see crash-safety.test.ts).
  const scriptDir = mkdtempSync(join(import.meta.dirname, '.child-'))
  dirs.push(scriptDir)
  const script = join(scriptDir, 'lock.mts')
  writeFileSync(
    script,
    `import { InstanceLock } from ${JSON.stringify(fileURLToPath(new URL('../../src/instance-lock.ts', import.meta.url)))}
try {
  InstanceLock.acquire(process.argv[2])
  console.log('ACQUIRED')
  setInterval(() => {}, 1000)
} catch (error) {
  console.log((error as { code?: string }).code ?? 'ERROR')
  process.exit(0)
}
`,
  )
  const child = spawn(process.execPath, ['--import', 'tsx', script, lockPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const line = out.split('\n')[0]?.trim()
      if (line) resolve({ child, outcome: line })
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error(`child said nothing: ${out}`)), 20_000)
  })
}

describe('the instance lock', () => {
  it('refuses a second holder in the same process, with an actionable message', () => {
    const path = join(tempDir(), 'instance.lock')
    const first = InstanceLock.acquire(path)
    let error: unknown
    try {
      InstanceLock.acquire(path)
    } catch (caught) {
      error = caught
    }
    expect(OpsError.hasCode(error, 'INSTANCE_LOCKED')).toBe(true)
    expect((error as Error).message).toContain('systemctl stop argus-agent')
    first.release()
    InstanceLock.acquire(path).release()
  })

  it('refuses another PROCESS while held, and lets it in once released', async () => {
    const path = join(tempDir(), 'instance.lock')
    const held = InstanceLock.acquire(path)
    expect((await lockingChild(path)).outcome).toBe('INSTANCE_LOCKED')
    held.release()
    expect((await lockingChild(path)).outcome).toBe('ACQUIRED')
  }, 60_000)

  it('is released by the operating system when the holder is SIGKILLed — no stale lock', async () => {
    const path = join(tempDir(), 'instance.lock')
    const { child, outcome } = await lockingChild(path)
    expect(outcome).toBe('ACQUIRED')
    expect(() => InstanceLock.acquire(path)).toThrow(/already using/)

    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
    InstanceLock.acquire(path).release()
  }, 60_000)
})
