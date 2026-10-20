// == ARGUS AGENT PROJECT ==
/**
 * A project's git remotes, and their tokens.
 *
 * A project names its remotes in its file (`git.remotes`), each an `https://` URL. Its
 * token is not in the file: the admin saves it with `/git token`, and it is kept in
 * dsh's credentials store under a name derived from the project and the remote, with
 * the reserved prefix {@link GIT_TOKEN_PREFIX}. Only this project's git operations
 * resolve it, and only for that remote's URL: `/key` and an MCP `${NAME}` refuse the
 * prefix, a template cannot carry one, and archiving the project forgets them.
 *
 * Every authenticated operation runs in Argus, against a bare mirror per remote kept
 * outside the project's folder (`<state>/<id>/remotes/<remote>.git`). The agent never
 * holds the token.
 *
 * @module @argus-agent/projects/git-remotes
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MCP_SERVER_PATTERN, OpsError } from '@argus-agent/types'

const run = promisify(execFile)

/** The credential names Argus keeps git tokens under; refused everywhere else. */
export const GIT_TOKEN_PREFIX = 'ARGUS_GIT_'

/** A remote's name: like an MCP server's. */
export const GIT_REMOTE_PATTERN = MCP_SERVER_PATTERN

/** The branches `git_push` refuses unless a remote lists its own. */
export const DEFAULT_PROTECTED = ['main', 'master'] as const

/** One remote of a project. */
export interface GitRemote {
  /** `https://host/path`, with no user, password, query or fragment. */
  readonly url: string
  /** Branches a push never goes to. */
  readonly protected: readonly string[]
}

/** The keys one remote may hold. */
const REMOTE_KEYS = ['url', 'protected']

/**
 * Why a URL cannot be a remote, or `undefined`.
 *
 * @param url the URL as written.
 * @returns the problem.
 */
export function remoteUrlProblem(url: unknown): string | undefined {
  if (typeof url !== 'string') return 'url: an https:// URL'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `url: "${url}" is not a URL`
  }
  if (parsed.protocol !== 'https:') return 'url: https:// only (the token goes in a header, never over plain http)'
  // A token in the URL would end up in the file, the log and the agent's view.
  if (parsed.username !== '' || parsed.password !== '') return 'url: no user or token in the URL; save the token with /git token'
  if (parsed.search !== '' || parsed.hash !== '') return 'url: no query or fragment'
  if (parsed.pathname.length <= 1) return 'url: the repository\'s path is missing'
  return undefined
}

/**
 * A project file's `git:` block, checked.
 *
 * @param git the block as written (`undefined` when absent).
 * @returns the remotes by name, and the problems found.
 */
export function parseGitBlock(git: unknown): { remotes: Record<string, GitRemote>; issues: Array<{ path: string; message: string }> } {
  const issues: Array<{ path: string; message: string }> = []
  const remotes: Record<string, GitRemote> = {}
  if (git === undefined || git === null) return { remotes, issues }
  if (typeof git !== 'object' || Array.isArray(git)) return { remotes, issues: [{ path: 'git', message: 'a mapping with remotes' }] }
  for (const key of Object.keys(git)) if (key !== 'remotes') issues.push({ path: `git.${key}`, message: 'unknown; use remotes' })
  const block = (git as Record<string, unknown>)['remotes']
  if (block === undefined || block === null) return { remotes, issues }
  if (typeof block !== 'object' || Array.isArray(block)) return { remotes, issues: [...issues, { path: 'git.remotes', message: 'must map remote names to remotes' }] }
  for (const [name, value] of Object.entries(block)) {
    const at = `git.remotes.${name}`
    if (!GIT_REMOTE_PATTERN.test(name)) issues.push({ path: at, message: `remote names must match ${GIT_REMOTE_PATTERN}` })
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ path: at, message: 'a mapping with url' })
      continue
    }
    const fields = value as Record<string, unknown>
    for (const key of Object.keys(fields)) if (!REMOTE_KEYS.includes(key)) issues.push({ path: `${at}.${key}`, message: `unknown; use ${REMOTE_KEYS.join(', ')}` })
    const problem = remoteUrlProblem(fields['url'])
    if (problem !== undefined) issues.push({ path: at, message: problem })
    const branches = fields['protected'] ?? [...DEFAULT_PROTECTED]
    if (!Array.isArray(branches) || branches.some((branch) => typeof branch !== 'string' || branch.length === 0)) {
      issues.push({ path: `${at}.protected`, message: 'a list of branch names ([] protects none)' })
      continue
    }
    if (problem === undefined) remotes[name] = { url: fields['url'] as string, protected: branches as string[] }
  }
  return { remotes, issues }
}

/**
 * The credential name a project's remote keeps its token under.
 *
 * Hashed rather than spelt out: a project id and a remote name would not survive the
 * `NAME_LIKE_THIS` alphabet without collisions (`a-b` and `a_b`).
 *
 * @param projectId the project.
 * @param remote the remote's name.
 * @returns the name, with {@link GIT_TOKEN_PREFIX}.
 */
export function gitTokenName(projectId: string, remote: string): string {
  return `${GIT_TOKEN_PREFIX}${createHash('sha256').update(`${projectId}\0${remote}`).digest('hex').slice(0, 24).toUpperCase()}`
}

/** Whether a credential name is one of the git tokens', which nothing else may read or write. */
export function isGitTokenName(name: string): boolean {
  return name.startsWith(GIT_TOKEN_PREFIX)
}

/** The part of dsh's credentials service the tokens use. */
export interface TokenStore {
  set(ref: unknown, value: string): Promise<unknown>
  unset(ref: unknown): Promise<unknown>
  resolve(ref: unknown): Promise<{ value: string } | undefined>
}

/**
 * Wrap a command in the command sandbox: `root` read and write, `reads` read-only.
 *
 * @returns the wrapped command.
 * @throws {Error} without the sandbox.
 */
export type GitConfine = (argv: readonly string[], root: string, reads: readonly string[]) => Promise<readonly string[]>

/** A branch name git_push and git_pull take: plain, never an option or a range. */
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

/**
 * What every git process Argus runs on a mirror is given: no system or user config,
 * no hooks, no prompt, https only. Nothing in a mirror's config is the agent's, but
 * these hold whatever is there.
 */
const HARDENED = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'credential.helper=',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.file.allow=always',
  // A redirect could carry the token to another host: none is followed.
  '-c', 'http.followRedirects=false',
]

/** How long one network operation may take. */
const NETWORK_TIMEOUT_MS = 600_000

/** A push, prepared: exactly what will be sent, so what was approved is what goes. */
export interface PushPlan {
  readonly remote: string
  readonly branch: string
  /** The commit the remote branch will point to. */
  readonly sha: string
  /** Its commits the remote does not have, newest first (at most 20 shown). */
  readonly commits: readonly string[]
  readonly count: number
  /** `12 files changed, 240 insertions(+), 31 deletions(-)`, or empty. */
  readonly stat: string
  /** `github.com/acme/site`. */
  readonly where: string
  /** Whether the branch is new on the remote. */
  readonly created: boolean
}

/** A git operation that could not be done, in words for the agent and the person. */
export class GitError extends OpsError {
  constructor(message: string) {
    super('GIT_FAILED', message)
    this.name = 'GitError'
  }
}

/**
 * The user name a host takes with a token as its password: GitHub's and GitLab's
 * documented ones, Bitbucket's, and any other name elsewhere (Gitea and Forgejo
 * ignore it).
 */
function tokenUser(url: string): string {
  const host = new URL(url).hostname
  if (host === 'github.com' || host.endsWith('.ghe.com')) return 'x-access-token'
  if (host.includes('gitlab')) return 'oauth2'
  if (host === 'bitbucket.org') return 'x-token-auth'
  return 'git'
}

/** `github.com/acme/site`, from a remote's URL. */
function whereOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.host}${parsed.pathname.replace(/\.git$/, '')}`
}

/** Tokens and mirrors of every project's remotes. */
export class GitRemotes {
  /**
   * @param stateDir `<data_dir>/state`: a project's mirrors live in `<state>/<id>/remotes/`.
   * @param store dsh's credentials service, read when needed (it may mount later).
   * @param confine the command sandbox, for every git process that touches a project's folder.
   * @param caFile a CA bundle the remotes' certificates are checked against, for a server with a private CA.
   */
  constructor(
    private readonly stateDir: string,
    private readonly store: () => TokenStore | undefined,
    private readonly confine?: GitConfine,
    private readonly caFile?: string,
  ) {}

  /** The bare mirror of one remote. */
  mirrorOf(projectId: string, remote: string): string {
    return join(this.stateDir, projectId, 'remotes', `${remote}.git`)
  }

  /** The credentials service, or an error saying tokens cannot be kept here. */
  private required(): TokenStore {
    const store = this.store()
    if (store === undefined) throw new Error('git tokens cannot be kept: the credentials store is not loaded')
    return store
  }

  /** Whether a remote has a token. */
  async hasToken(projectId: string, remote: string): Promise<boolean> {
    return (await this.token(projectId, remote)) !== undefined
  }

  /**
   * A remote's token, for Argus's own git process only.
   *
   * @returns the token, or `undefined` when none is saved.
   */
  async token(projectId: string, remote: string): Promise<string | undefined> {
    const value = (await this.store()?.resolve(credentialRef(gitTokenName(projectId, remote))))?.value
    return value === undefined || value.length === 0 ? undefined : value
  }

  /** Save a remote's token, replacing any. */
  async setToken(projectId: string, remote: string, token: string): Promise<void> {
    await this.required().set(credentialRef(gitTokenName(projectId, remote)), token)
  }

  /**
   * Forget a remote's token.
   *
   * @returns whether there was one.
   */
  async forget(projectId: string, remote: string): Promise<boolean> {
    const had = await this.hasToken(projectId, remote)
    if (had) await this.required().unset(credentialRef(gitTokenName(projectId, remote)))
    return had
  }

  /** Forget a remote's token and delete its mirror. */
  async remove(projectId: string, remote: string): Promise<void> {
    await this.forget(projectId, remote)
    rmSync(this.mirrorOf(projectId, remote), { recursive: true, force: true })
  }

  /** Forget every token of a project's remotes and delete its mirrors: at archive. */
  async removeAll(projectId: string, remotes: readonly string[]): Promise<void> {
    for (const remote of remotes) await this.forget(projectId, remote)
    rmSync(join(this.stateDir, projectId, 'remotes'), { recursive: true, force: true })
  }

  // ── the operations ───────────────────────────────────────────────────────
  //
  // Only bundles cross between a mirror and a project. Argus never opens the
  // project's repository: its config, hooks, attributes, alternates and gitfiles
  // reach only confined processes, where Landlock holds them. The token is used only
  // by git on the mirror, whose config is Argus's own.

  /**
   * Clone a remote into the project's folder.
   *
   * @param projectId the project.
   * @param cwd its folder.
   * @param name the remote's name.
   * @param remote the remote.
   * @param options the branch (default: the remote's) and the folder (default: the repository's name).
   * @returns what happened, for the agent.
   */
  async clone(projectId: string, cwd: string, name: string, remote: GitRemote, options: { branch?: string; into?: string } = {}): Promise<string> {
    const into = options.into ?? (remote.url.split('/').pop() ?? 'repo').replace(/\.git$/, '')
    const target = this.inside(cwd, into)
    if (existsSync(target) && readdirSync(target).length > 0) throw new GitError(`${into} already exists and is not empty: clone into another folder (into), or pull with git_pull.`)
    const fallback = await this.refresh(projectId, name, remote)
    const branch = this.branch(options.branch ?? fallback)
    return this.staged(projectId, async (staging) => {
      const bundle = join(staging, 'clone.bundle')
      await this.mirrorGit(projectId, name, ['bundle', 'create', bundle, '--branches'])
      await this.confined(['git', 'clone', '-q', '--origin', name, '-b', branch, bundle, target], cwd, [staging], cwd)
      await this.confined(['git', '-C', target, 'remote', 'set-url', name, remote.url], cwd, [], cwd)
      return `Cloned ${whereOf(remote.url)} (${branch}) into ${into}. Get new commits with git_pull and send yours with git_push; git push and git pull of your own have no access to ${name}.`
    })
  }

  /**
   * Fetch a remote's branches into the project's repository, as `refs/remotes/<name>/*`.
   *
   * @param projectId the project.
   * @param cwd its folder.
   * @param name the remote's name.
   * @param remote the remote.
   * @param path the repository, relative to the folder (default: the folder itself).
   * @returns what happened, for the agent.
   */
  async pull(projectId: string, cwd: string, name: string, remote: GitRemote, path = '.'): Promise<string> {
    const repo = this.repository(cwd, path)
    await this.refresh(projectId, name, remote)
    return this.staged(projectId, async (staging) => {
      const bundle = join(staging, 'pull.bundle')
      await this.mirrorGit(projectId, name, ['bundle', 'create', bundle, '--branches'])
      await this.confined(['git', '-C', repo, 'fetch', '-q', '--prune', bundle, `+refs/heads/*:refs/remotes/${name}/*`], cwd, [staging], cwd)
      const heads = (await this.mirrorGit(projectId, name, ['for-each-ref', '--format=%(refname:short) %(objectname:short) %(subject)', 'refs/heads/'])).trim()
      return `Fetched ${whereOf(remote.url)} into ${path === '.' ? '' : `${path}: `}refs/remotes/${name}/:\n${heads}\nMerge or rebase yourself, e.g. git merge ${name}/<branch>.`
    })
  }

  /**
   * Prepare a push: the branch is taken from the project's repository into the mirror,
   * and what it would send is described. Nothing leaves the server.
   *
   * @param projectId the project.
   * @param cwd its folder.
   * @param name the remote's name.
   * @param remote the remote.
   * @param branch the branch.
   * @param path the repository, relative to the folder.
   * @returns the plan.
   * @throws {GitError} for a protected branch, no token, nothing to push, or a push that is not a fast-forward.
   */
  async preparePush(projectId: string, cwd: string, name: string, remote: GitRemote, branch: string, path = '.'): Promise<PushPlan> {
    this.branch(branch)
    if (remote.protected.includes(branch)) throw new GitError(`${branch} is protected on ${name}: push to another branch and open a pull request, or the admin lifts it (git.remotes.${name}.protected).`)
    if (!(await this.hasToken(projectId, name))) throw new GitError(`${name} has no token, so nothing can be pushed. The admin saves one with /git token ${projectId} ${name} <token>.`)
    const repo = this.repository(cwd, path)
    await this.refresh(projectId, name, remote)
    const pending = `refs/argus/push/${branch}`
    await this.staged(projectId, async (staging) => {
      const bundle = join(staging, 'push.bundle')
      // The project's repository is read confined, with the project READ-ONLY: only the
      // staging folder is writable, and only the bundle comes out.
      await this.confined(['git', '-C', repo, 'bundle', 'create', bundle, `refs/heads/${branch}`], staging, [cwd], repo)
      await this.mirrorGit(projectId, name, ['fetch', '-q', '--no-tags', bundle, `+refs/heads/${branch}:${pending}`])
    })
    const sha = (await this.mirrorGit(projectId, name, ['rev-parse', pending])).trim()
    const base = (await this.mirrorGit(projectId, name, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).catch(() => '')).trim()
    if (base === sha) throw new GitError(`Nothing to push: ${name}/${branch} is already at ${sha.slice(0, 7)}.`)
    if (base !== '' && !(await this.mirrorGit(projectId, name, ['merge-base', '--is-ancestor', base, sha]).then(() => true, () => false))) {
      throw new GitError(`${name}/${branch} has commits your branch does not: git_pull, then merge or rebase ${name}/${branch}, and push again. Force pushes are not done.`)
    }
    const range = base === '' ? [sha, '--not', '--branches'] : [`${base}..${sha}`]
    const count = Number((await this.mirrorGit(projectId, name, ['rev-list', '--count', ...range])).trim())
    const commits = (await this.mirrorGit(projectId, name, ['log', '-n', '20', '--format=%h %s', ...range])).trim().split('\n').filter((line) => line.length > 0)
    const from = base !== '' ? base : (await this.mirrorGit(projectId, name, ['merge-base', 'HEAD', sha]).catch(() => '')).trim()
    const stat = from === '' ? '' : (await this.mirrorGit(projectId, name, ['diff', '--shortstat', from, sha])).trim()
    return { remote: name, branch, sha, commits, count, stat, where: whereOf(remote.url), created: base === '' }
  }

  /**
   * Push what a plan prepared: the commit it named, and nothing else.
   *
   * @param projectId the project.
   * @param remote the remote.
   * @param plan from {@link preparePush}.
   * @returns what happened, for the agent.
   */
  async push(projectId: string, remote: GitRemote, plan: PushPlan): Promise<string> {
    const token = await this.token(projectId, plan.remote)
    if (token === undefined) throw new GitError(`${plan.remote} has no token.`)
    await this.mirrorGit(projectId, plan.remote, ['push', '-q', remote.url, `${plan.sha}:refs/heads/${plan.branch}`], { token, url: remote.url })
    await this.mirrorGit(projectId, plan.remote, ['update-ref', `refs/heads/${plan.branch}`, plan.sha])
    return `Pushed ${plan.count} commit(s) to ${plan.remote}/${plan.branch} (${plan.where}), now at ${plan.sha.slice(0, 7)}.`
  }

  /** One line describing a plan, for the person approving it. */
  static describe(plan: PushPlan): string {
    const shown = plan.commits.slice(0, 5).join(' · ')
    const more = plan.count > 5 ? ` · and ${plan.count - 5} more` : ''
    return `push ${plan.count} commit(s) to ${plan.remote}/${plan.branch}${plan.created ? ' (a new branch)' : ''} on ${plan.where}: ${shown}${more}${plan.stat === '' ? '' : `; ${plan.stat}`}`
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Fetch a remote into its mirror, creating the mirror first.
   *
   * @returns the remote's default branch.
   */
  private async refresh(projectId: string, name: string, remote: GitRemote): Promise<string> {
    const mirror = this.mirrorOf(projectId, name)
    if (!existsSync(join(mirror, 'HEAD'))) {
      mkdirSync(mirror, { recursive: true })
      await this.git(['init', '-q', '--bare', mirror])
    }
    const token = await this.token(projectId, name)
    const auth = token === undefined ? {} : { token, url: remote.url }
    try {
      const head = await this.mirrorGit(projectId, name, ['ls-remote', '--symref', remote.url, 'HEAD'], auth)
      await this.mirrorGit(projectId, name, ['fetch', '-q', '--prune', '--no-tags', remote.url, '+refs/heads/*:refs/heads/*'], auth)
      const fallback = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head)?.[1] ?? 'main'
      await this.mirrorGit(projectId, name, ['symbolic-ref', 'HEAD', `refs/heads/${fallback}`])
      return fallback
    } catch (error) {
      if (token === undefined) throw new GitError(`${whereOf(remote.url)} could not be read without a token (${(error as Error).message}). The admin saves one with /git token ${projectId} ${name} <token>.`)
      throw error
    }
  }

  /** Git on one remote's mirror. */
  private mirrorGit(projectId: string, name: string, args: readonly string[], auth: { token?: string; url?: string } = {}): Promise<string> {
    return this.git(['--git-dir', this.mirrorOf(projectId, name), ...args], auth)
  }

  /**
   * Argus's own git: never in a project's folder, with no system or user config, and
   * the token, when one is given, only as a header in this one process's environment.
   */
  private async git(args: readonly string[], auth: { token?: string; url?: string } = {}): Promise<string> {
    const home = join(this.stateDir, '.git-home')
    mkdirSync(home, { recursive: true })
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' }
    // A server with a private CA: given here, or as the service's own GIT_SSL_CAINFO.
    const ca = this.caFile ?? process.env['GIT_SSL_CAINFO']
    if (ca !== undefined) env['GIT_SSL_CAINFO'] = ca
    if (auth.token !== undefined && auth.url !== undefined) {
      const basic = Buffer.from(`${tokenUser(auth.url)}:${auth.token}`).toString('base64')
      env['GIT_CONFIG_PARAMETERS'] = `'http.extraHeader'='Authorization: Basic ${basic}'`
    }
    try {
      return (await run('git', [...HARDENED, ...args], { env, timeout: NETWORK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout
    } catch (error) {
      throw new GitError(failure(error))
    }
  }

  /** A git command in the project's sandbox. */
  private async confined(argv: readonly string[], root: string, reads: readonly string[], cwd: string): Promise<void> {
    if (this.confine === undefined) throw new GitError('git operations need the command sandbox, which is not available')
    const wrapped = await this.confine(argv, root, reads)
    try {
      await run(wrapped[0] as string, wrapped.slice(1), { cwd, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C', GIT_TERMINAL_PROMPT: '0' }, timeout: NETWORK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
    } catch (error) {
      throw new GitError(failure(error))
    }
  }

  /** Run with a fresh staging folder of Argus's own, removed afterwards. */
  private async staged<T>(projectId: string, work: (staging: string) => Promise<T>): Promise<T> {
    const staging = join(this.stateDir, projectId, 'staging', randomUUID())
    mkdirSync(staging, { recursive: true })
    try {
      return await work(staging)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** A folder inside the project's, from a relative path the agent gave. */
  private inside(cwd: string, path: string): string {
    if (isAbsolute(path) || normalize(path).split(sep).includes('..')) throw new GitError(`${path} must be a folder inside the project's, written relative to it.`)
    return resolve(cwd, path)
  }

  /** A repository inside the project's folder. */
  private repository(cwd: string, path: string): string {
    const repo = this.inside(cwd, path)
    if (!existsSync(join(repo, '.git'))) throw new GitError(`${path} is not a git repository: clone one first with git_clone.`)
    return repo
  }

  /** A branch name, checked. */
  private branch(branch: string): string {
    if (!BRANCH.test(branch)) throw new GitError(`"${branch}" is not a branch name.`)
    return branch
  }
}

/** A failed git command, in a few lines and never with a header in them. */
function failure(error: unknown): string {
  const detail = error as { stderr?: string; message?: string; killed?: boolean }
  if (detail.killed === true) return 'git took too long and was stopped'
  const text = (detail.stderr ?? detail.message ?? String(error)).replace(/Authorization:[^\n]*/gi, 'Authorization: …')
  return text.trim().split('\n').filter((line) => line.trim().length > 0).slice(-3).join(' ').slice(0, 400)
}
