// == ARGUS AGENT PROJECT ==
/** Snapshots and undo, against the real git. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Snapshots, type SnapshotSettings } from '../../src/snapshots.js'

let root: string
let cwd: string
let clock: number
let settings: SnapshotSettings
let snapshots: Snapshots

const read = (path: string) => readFileSync(join(cwd, path), 'utf8')
const write = (path: string, text: string) => {
  mkdirSync(join(cwd, path, '..'), { recursive: true })
  writeFileSync(join(cwd, path), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'argus-snapshots-'))
  cwd = join(root, 'projects', 'alpha')
  mkdirSync(cwd, { recursive: true })
  clock = Date.UTC(2026, 9, 16, 12)
  settings = { enabled: true, keep_days: 14, max_file_mb: 1 }
  snapshots = new Snapshots(join(root, 'state'), () => settings, () => clock)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('snapshots', () => {
  it('undoes a run exactly: edits, new files and deletions', async () => {
    write('a.txt', 'one\n')
    write('src/b.txt', 'bee\n')
    await snapshots.take('alpha', cwd, 'run-1')
    // The run.
    write('a.txt', 'changed\n')
    write('new/c.txt', 'sea\n')
    rmSync(join(cwd, 'src', 'b.txt'))

    const restored = await snapshots.restore('alpha', cwd)
    expect(restored?.id).toBe('run-1')
    expect(read('a.txt')).toBe('one\n')
    expect(read('src/b.txt')).toBe('bee\n')
    expect(existsSync(join(cwd, 'new', 'c.txt'))).toBe(false)
  })

  it('an undo can be undone', async () => {
    write('a.txt', 'before\n')
    await snapshots.take('alpha', cwd, 'run-1')
    write('a.txt', 'after\n')
    await snapshots.restore('alpha', cwd)
    expect(read('a.txt')).toBe('before\n')

    const list = await snapshots.list('alpha', cwd)
    const undo = list.find((entry) => entry.kind === 'undo')
    expect(undo).toBeDefined()
    await snapshots.restore('alpha', cwd, undo?.id)
    expect(read('a.txt')).toBe('after\n')
  })

  it("never touches the project's own .git, and skips what is large or ignored", async () => {
    execFileSync('git', ['init', '-q'], { cwd })
    const head = read('.git/HEAD')
    write('node_modules/x/index.js', 'module\n')
    write('.gitignore', 'secret.env\n')
    write('secret.env', 'KEY=1\n')
    write('.argusignore', 'cache/\n')
    write('cache/blob', 'cached\n')
    write('big.bin', 'x'.repeat(2 * 1024 * 1024))
    write('a.txt', 'one\n')
    await snapshots.take('alpha', cwd, 'run-1')

    write('a.txt', 'two\n')
    write('node_modules/x/index.js', 'changed module\n')
    write('secret.env', 'KEY=2\n')
    write('big.bin', 'y'.repeat(2 * 1024 * 1024))
    await snapshots.restore('alpha', cwd)

    expect(read('a.txt')).toBe('one\n')
    // Skipped: neither saved nor removed nor put back.
    expect(read('node_modules/x/index.js')).toBe('changed module\n')
    expect(read('secret.env')).toBe('KEY=2\n')
    expect(read('cache/blob')).toBe('cached\n')
    expect(read('big.bin').startsWith('y')).toBe(true)
    // The project's repository is its own.
    expect(read('.git/HEAD')).toBe(head)
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'refs/runs/run-1'], { env: { ...process.env, GIT_DIR: snapshots.dirOf('alpha') }, encoding: 'utf8' })
    expect(tracked.split('\n').filter(Boolean).sort()).toEqual(['.argusignore', '.gitignore', 'a.txt'])
  })

  it('drops a file from the snapshots once it grows over the limit', async () => {
    write('log.txt', 'small\n')
    await snapshots.take('alpha', cwd, 'run-1')
    write('log.txt', 'z'.repeat(2 * 1024 * 1024))
    await snapshots.take('alpha', cwd, 'run-2')
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'refs/runs/run-2'], { env: { ...process.env, GIT_DIR: snapshots.dirOf('alpha') }, encoding: 'utf8' })
    expect(tracked).toBe('')
  })

  it('lists the newest first, with what each run changed', async () => {
    write('a.txt', 'one\n')
    await snapshots.take('alpha', cwd, 'run-1')
    clock += 60_000
    write('a.txt', 'one\ntwo\n')
    write('b.txt', 'bee\n')
    await snapshots.take('alpha', cwd, 'run-2')
    clock += 60_000
    rmSync(join(cwd, 'b.txt'))

    const list = await snapshots.list('alpha', cwd)
    expect(list.map((entry) => entry.id)).toEqual(['run-2', 'run-1'])
    // run-1 added a line and a file; run-2 (to now) removed the file.
    expect(list[1]?.changes).toEqual({ files: 2, added: 2, removed: 0 })
    expect(list[0]?.changes).toEqual({ files: 1, added: 0, removed: 1 })
    expect(await snapshots.list('beta', cwd)).toEqual([])
  })

  it('restores a given run, and says when there is none', async () => {
    expect(await snapshots.restore('alpha', cwd)).toBeUndefined()
    write('a.txt', '1\n')
    await snapshots.take('alpha', cwd, 'run-1')
    write('a.txt', '2\n')
    await snapshots.take('alpha', cwd, 'run-2')
    write('a.txt', '3\n')
    await snapshots.restore('alpha', cwd, 'run-1')
    expect(read('a.txt')).toBe('1\n')
    expect(await snapshots.restore('alpha', cwd, 'run-9')).toBeUndefined()
  })

  it('expires snapshots older than keep_days', async () => {
    write('a.txt', '1\n')
    await snapshots.take('alpha', cwd, 'run-old')
    clock += 15 * 86_400_000
    write('a.txt', '2\n')
    await snapshots.take('alpha', cwd, 'run-new')
    expect((await snapshots.list('alpha', cwd)).map((entry) => entry.id)).toEqual(['run-new'])
    clock += 15 * 86_400_000
    await snapshots.expireAll()
    expect(await snapshots.list('alpha', cwd)).toEqual([])
    expect(snapshots.sizeBytes()).toBeGreaterThan(0)
  })
})
