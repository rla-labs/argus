// == ARGUS AGENT PROJECT ==
/**
 * Snapshots of a project's folder, for `/undo`.
 *
 * Before each run Argus records the folder in a git repository kept OUTSIDE it,
 * `<state>/<id>/snapshots.git`, with the folder as the work tree. Each snapshot is a
 * commit with no parent under `refs/runs/<runId>` (or `refs/undo/<time>` for the state an
 * undo replaced); git stores each file content once, so unchanged files cost nothing.
 * Expiry deletes old refs and lets `git gc` drop what nothing reaches.
 *
 * What is skipped: `node_modules`, `.venv`, `dist`, what the project's `.gitignore` and
 * `.argusignore` list, and files over the size limit. The project's own `.git` is never
 * read or touched: git does not track a `.git` folder.
 *
 * Git runs as Argus, never inside an agent's sandbox, with no system or user config.
 *
 * @module @argus-agent/projects/snapshots
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'

const run = promisify(execFile)

/** What is never snapshotted: large and rebuilt. */
const ALWAYS_SKIPPED = ['node_modules/', '.venv/', 'dist/']

/** The snapshot settings (`ops.yaml: snapshots`). */
export interface SnapshotSettings {
  readonly enabled: boolean
  readonly keep_days: number
  readonly max_file_mb: number
}

/** The `snapshots` schema. */
export const snapshotsSchema: z = z
  .object({
    enabled: z.boolean().default(true),
    keep_days: z.number().min(1).max(365).default(14),
    max_file_mb: z.number().min(1).max(1024).default(20),
  })
  .default({})

/**
 * Build the section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function snapshotsOf(raw: Record<string, unknown>): SnapshotSettings {
  const parse = snapshotsSchema as unknown as (value: unknown) => SnapshotSettings
  return parse(raw['snapshots'] ?? {})
}

/** One snapshot, as `/undo list` shows it. */
export interface SnapshotEntry {
  /** The run it was taken before, or the undo that replaced the state. */
  readonly kind: 'run' | 'undo'
  /** The run id, or the undo's time as an id. */
  readonly id: string
  readonly at: number
  /** What changed from this snapshot to the next one (or to the folder now). */
  readonly changes: { readonly files: number; readonly added: number; readonly removed: number }
}

/** The git repositories of every project's snapshots. */
export class Snapshots {
  /** One git operation at a time per project. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly stateDir: string,
    private readonly settings: () => SnapshotSettings,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 60_000,
  ) {}

  /** The repository of one project. */
  dirOf(projectId: string): string {
    return join(this.stateDir, projectId, 'snapshots.git')
  }

  /**
   * Record the folder before a run.
   *
   * @param projectId the project.
   * @param cwd its folder.
   * @param runId the run about to start.
   */
  async take(projectId: string, cwd: string, runId: string): Promise<void> {
    await this.locked(projectId, async () => {
      await this.commit(projectId, cwd, `refs/runs/${runId}`)
      await this.expire(projectId)
    })
  }

  /**
   * The newest snapshots, newest first.
   *
   * @param projectId the project.
   * @param cwd its folder.
   * @param limit how many.
   * @returns the snapshots; none when the project has none.
   */
  async list(projectId: string, cwd: string, limit = 20): Promise<SnapshotEntry[]> {
    if (!existsSync(this.dirOf(projectId))) return []
    return this.locked(projectId, async () => {
      const refs = await this.refs(projectId, limit)
      const now = await this.stage(projectId, cwd)
      const entries: SnapshotEntry[] = []
      for (const [index, ref] of refs.entries()) {
        const next = index === 0 ? now : (refs[index - 1] as Ref).commit
        entries.push({ kind: ref.kind, id: ref.id, at: ref.at, changes: await this.changes(projectId, ref.commit, next) })
      }
      return entries
    })
  }

  /**
   * Put the folder back as it was before a run. The current state is recorded first,
   * so the undo can itself be undone.
   *
   * @param projectId the project.
   * @param cwd its folder.
   * @param id the run (or undo) to go back to; the newest run when omitted.
   * @returns the snapshot restored, or `undefined` when there is none to restore.
   */
  async restore(projectId: string, cwd: string, id?: string): Promise<{ readonly kind: 'run' | 'undo'; readonly id: string; readonly at: number } | undefined> {
    if (!existsSync(this.dirOf(projectId))) return undefined
    return this.locked(projectId, async () => {
      const refs = await this.refs(projectId, 1_000)
      const target = id === undefined ? refs.find((ref) => ref.kind === 'run') : refs.find((ref) => ref.id === id)
      if (target === undefined) return undefined
      const at = this.now()
      await this.commit(projectId, cwd, `refs/undo/${at}`)
      // `--reset -u`: files the snapshot has are written, files only the current state
      // has are removed. What was skipped is in neither, so it is left alone.
      await this.git(projectId, cwd, ['read-tree', '--reset', '-u', target.commit])
      return { kind: target.kind, id: target.id, at: target.at }
    })
  }

  /**
   * Drop every project's snapshots older than `keep_days`.
   */
  async expireAll(): Promise<void> {
    if (!existsSync(this.stateDir)) return
    for (const projectId of readdirSync(this.stateDir)) {
      if (existsSync(this.dirOf(projectId))) await this.locked(projectId, () => this.expire(projectId))
    }
  }

  /** The disk the snapshots take, in bytes. */
  sizeBytes(): number {
    if (!existsSync(this.stateDir)) return 0
    const size = (path: string): number => {
      const stat = statSync(path, { throwIfNoEntry: false })
      if (stat === undefined) return 0
      return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0) : stat.size
    }
    return readdirSync(this.stateDir).reduce((sum, projectId) => sum + size(this.dirOf(projectId)), 0)
  }

  // ── git ──────────────────────────────────────────────────────────────────

  private async locked<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const before = this.locks.get(projectId) ?? Promise.resolve()
    const next = before.then(work, work)
    this.locks.set(projectId, next.catch(() => undefined))
    return next
  }

  /** Run git on a project's repository; `cwd` is the work tree, or `undefined` for none. */
  private async git(projectId: string, cwd: string | undefined, args: string[], stdin?: string): Promise<string> {
    const at = `@${Math.floor(this.now() / 1000)} +0000`
    const child = run('git', args, {
      cwd: cwd ?? this.stateDir,
      timeout: this.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        GIT_DIR: this.dirOf(projectId),
        ...(cwd === undefined ? {} : { GIT_WORK_TREE: cwd }),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Argus',
        GIT_AUTHOR_EMAIL: 'argus@localhost',
        GIT_COMMITTER_NAME: 'Argus',
        GIT_COMMITTER_EMAIL: 'argus@localhost',
        GIT_AUTHOR_DATE: at,
        GIT_COMMITTER_DATE: at,
      },
    })
    if (stdin !== undefined) child.child.stdin?.end(stdin)
    return (await child).stdout
  }

  /** Create the repository on first use. */
  private async init(projectId: string): Promise<void> {
    const dir = this.dirOf(projectId)
    if (existsSync(join(dir, 'HEAD'))) return
    mkdirSync(dir, { recursive: true })
    await this.git(projectId, undefined, ['init', '--quiet', '--bare'])
    // Not bare after all: the work tree is the project's folder, named on every call.
    await this.git(projectId, undefined, ['config', 'core.bare', 'false'])
    // No reflog: an expired snapshot must not stay reachable through one.
    await this.git(projectId, undefined, ['config', 'core.logAllRefUpdates', 'false'])
    await this.git(projectId, undefined, ['config', 'gc.auto', '0'])
    // Bytes in, the same bytes out: a `.gitattributes` in the folder cannot turn on a
    // line-ending conversion or a filter. `info/attributes` wins over it.
    mkdirSync(join(dir, 'info'), { recursive: true })
    writeFileSync(join(dir, 'info', 'attributes'), '* -text -filter -ident\n')
  }

  /**
   * Bring the index to the folder as it is now and return its tree.
   *
   * The skip list is written to `info/exclude` first. When it changed, the index is
   * started over: a file excluded now (it grew too large, or `.argusignore` names it)
   * would otherwise stay in from an earlier snapshot.
   */
  private async stage(projectId: string, cwd: string): Promise<string> {
    await this.init(projectId)
    const dir = this.dirOf(projectId)
    const excludePath = join(dir, 'info', 'exclude')
    const before = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    const base = [...ALWAYS_SKIPPED, ...readLines(join(cwd, '.argusignore'))]
    writeExclude(dir, base)
    const limit = this.settings().max_file_mb * 1024 * 1024
    const candidates = (await this.git(projectId, cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    const large = candidates.filter((path) => (statSync(join(cwd, path), { throwIfNoEntry: false })?.size ?? 0) > limit)
    writeExclude(dir, [...base, ...large.map((path) => `/${path.replace(/[*?[\\]/g, '\\$&')}`)])
    if (readFileSync(excludePath, 'utf8') !== before) rmSync(join(dir, 'index'), { force: true })
    await this.git(projectId, cwd, ['add', '--all'])
    return (await this.git(projectId, cwd, ['write-tree'])).trim()
  }

  /** Commit the folder under `ref`. The message is the time in milliseconds: git's own dates are in seconds. */
  private async commit(projectId: string, cwd: string, ref: string): Promise<void> {
    const tree = await this.stage(projectId, cwd)
    const commit = (await this.git(projectId, cwd, ['commit-tree', tree, '-m', String(this.now())])).trim()
    await this.git(projectId, cwd, ['update-ref', ref, commit])
  }

  private async refs(projectId: string, limit: number): Promise<Ref[]> {
    const out = await this.git(projectId, undefined, ['for-each-ref', '--format=%(refname)%09%(contents:subject)%09%(objectname)', 'refs/runs', 'refs/undo'])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [refname = '', at = '0', commit = ''] = line.split('\t')
        const [, kind, id] = refname.split('/') as [string, string, string]
        return { kind: kind === 'undo' ? 'undo' : 'run', id, at: Number(at), commit } as Ref
      })
      // Newest first; at the same millisecond, the undo (it was taken after the run).
      .sort((a, b) => b.at - a.at || (a.kind === 'undo' ? -1 : 1))
      .slice(0, limit)
  }

  private async changes(projectId: string, from: string, to: string): Promise<SnapshotEntry['changes']> {
    const out = await this.git(projectId, undefined, ['diff', '--numstat', '-z', from, to])
    const lines = out.split('\0').filter((line) => /^(\d+|-)\t(\d+|-)\t/.test(line))
    const sum = (index: number) => lines.reduce((total, line) => total + (Number(line.split('\t')[index]) || 0), 0)
    return { files: lines.length, added: sum(0), removed: sum(1) }
  }

  private async expire(projectId: string): Promise<void> {
    const cutoff = this.now() - this.settings().keep_days * 86_400_000
    const old = (await this.refs(projectId, 100_000)).filter((ref) => ref.at < cutoff)
    if (old.length === 0) return
    await this.git(projectId, undefined, ['update-ref', '--stdin'], old.map((ref) => `delete refs/${ref.kind === 'undo' ? 'undo' : 'runs'}/${ref.id}\n`).join(''))
    await this.git(projectId, undefined, ['gc', '--quiet', '--prune=now'])
  }
}

interface Ref {
  readonly kind: 'run' | 'undo'
  readonly id: string
  readonly at: number
  readonly commit: string
}

/** The non-empty, non-comment lines of a file, or none. */
function readLines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** Write `info/exclude`. */
function writeExclude(dir: string, patterns: readonly string[]): void {
  mkdirSync(join(dir, 'info'), { recursive: true })
  writeFileSync(join(dir, 'info', 'exclude'), patterns.join('\n') + '\n')
}
