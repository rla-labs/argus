// == ARGUS AGENT PROJECT ==
/**
 * A project's git remotes, end to end: Argus clones, pulls and pushes over HTTPS with
 * the remote's token, through the real command sandbox, and the token never reaches
 * the project's folder or a process the project's repository can steer.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ArgusSandbox from '@argus-agent/argus-agent/sandbox-row'
import { GitError, GitRemotes, type GitRemote, type TokenStore } from '../../src/git-remotes.js'
import { git, startGitHttps, type GitHttps } from '../fixtures/git-https.js'

const TOKEN = 'ghp_TEST_TOKEN_never_in_the_project'

let server: GitHttps
let data: string
let remotes: GitRemotes
let store: Map<string, string>

const sandbox = new ArgusSandbox(new Context())
const confine = async (argv: readonly string[], root: string, reads: readonly string[]) =>
  (await sandbox.confineReading(argv, { mode: 'workspace-write', workspaceRoot: root }, reads)).argv

beforeEach(async () => {
  server = await startGitHttps(TOKEN)
  data = mkdtempSync(join(tmpdir(), 'git-remotes-data-'))
  for (const dir of ['projects/site', 'projects/beta', 'state']) mkdirSync(join(data, dir), { recursive: true })
  store = new Map()
  const tokens: TokenStore = {
    set: async (ref, value) => void store.set(String(ref), value),
    unset: async (ref) => void store.delete(String(ref)),
    resolve: async (ref) => (store.has(String(ref)) ? { value: store.get(String(ref)) as string } : undefined),
  }
  remotes = new GitRemotes(join(data, 'state'), () => tokens, confine, server.caFile)
})

afterEach(async () => {
  await server.close()
  rmSync(data, { recursive: true, force: true })
  rmSync(server.root, { recursive: true, force: true })
})

const site = (): string => join(data, 'projects', 'site')
const origin = (name = 'site'): GitRemote => ({ url: `${server.base}/${name}.git`, protected: ['main', 'master'] })

/** Every file under a folder, as text, for "the token is nowhere here". */
function everything(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString('latin1'))
    .join('\n')
}

/** A commit in the project's clone, as the agent would make it (here, unconfined: the test is the agent). */
function commit(repo: string, file: string, text: string, message: string): void {
  writeFileSync(join(repo, file), text)
  git(['add', '-A'], repo)
  git(['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-q', '-m', message], repo)
}

describe('git_clone', () => {
  it('clones a private repository with the token, which stays out of the project', async () => {
    server.repo('site')
    await remotes.setToken('site', 'origin', TOKEN)
    const said = await remotes.clone('site', site(), 'origin', origin())
    expect(said).toMatch(/Cloned 127\.0\.0\.1:\d+\/site \(main\) into site/)
    const repo = join(site(), 'site')
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# site\n')
    expect(git(['remote', 'get-url', 'origin'], repo).trim()).toBe(origin().url)
    expect(everything(site())).not.toContain(TOKEN)
    expect(everything(site())).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'))
    expect(server.seen.some((request) => request.auth?.startsWith('Basic ') === true)).toBe(true)
  }, 60_000)

  it('is refused without the token, with how to set one, and with a wrong one', async () => {
    server.repo('site')
    await expect(remotes.clone('site', site(), 'origin', origin())).rejects.toThrow(/could not be read without a token.*\/git token site origin/)
    await remotes.setToken('site', 'origin', 'wrong')
    await expect(remotes.clone('site', site(), 'origin', origin())).rejects.toThrow(GitError)
    expect(readdirSync(site())).toEqual([])
  }, 60_000)

  it('refuses a folder outside the project or one already in use', async () => {
    server.repo('site')
    await remotes.setToken('site', 'origin', TOKEN)
    await expect(remotes.clone('site', site(), 'origin', origin(), { into: '../beta' })).rejects.toThrow(/inside the project/)
    await expect(remotes.clone('site', site(), 'origin', origin(), { into: '/tmp/x' })).rejects.toThrow(/inside the project/)
    mkdirSync(join(site(), 'site'))
    writeFileSync(join(site(), 'site', 'x'), 'x')
    await expect(remotes.clone('site', site(), 'origin', origin())).rejects.toThrow(/not empty/)
  }, 60_000)

  it('sends the token to the remote\'s host only: a redirect is not followed', async () => {
    server.repo('site')
    await remotes.setToken('site', 'origin', TOKEN)
    await expect(remotes.clone('site', site(), 'origin', { url: server.redirect('/site.git'), protected: [] })).rejects.toThrow(GitError)
    expect(server.seen.filter((request) => request.server === 'other')).toEqual([])
  }, 60_000)
})

describe('git_pull and git_push', () => {
  beforeEach(async () => {
    server.repo('site')
    await remotes.setToken('site', 'origin', TOKEN)
    await remotes.clone('site', site(), 'origin', origin())
  })
  const repo = (): string => join(site(), 'site')

  it('pulls the remote\'s new commits into refs/remotes/origin', async () => {
    const other = mkdtempSync(join(tmpdir(), 'git-other-'))
    git(['clone', '-q', join(server.root, 'site.git'), other])
    commit(other, 'news.md', 'news\n', 'from elsewhere')
    git(['push', '-q', 'origin', 'main'], other)
    const said = await remotes.pull('site', site(), 'origin', origin(), 'site')
    expect(said).toContain('main')
    expect(git(['log', '-1', '--format=%s', 'origin/main'], repo()).trim()).toBe('from elsewhere')
    rmSync(other, { recursive: true, force: true })
  }, 60_000)

  it('pushes a branch exactly as prepared, and describes it first', async () => {
    git(['checkout', '-q', '-b', 'feature-contact'], repo())
    commit(repo(), 'contact.html', '<form></form>\n', 'Fix the contact form')
    const plan = await remotes.preparePush('site', site(), 'origin', origin(), 'feature-contact', 'site')
    expect(plan).toMatchObject({ branch: 'feature-contact', count: 1, created: true })
    expect(GitRemotes.describe(plan)).toMatch(/push 1 commit\(s\) to origin\/feature-contact \(a new branch\) on 127\.0\.0\.1:\d+\/site: \w{7} Fix the contact form; 1 file changed, 1 insertion/)
    // Prepared, nothing has left yet.
    expect(git(['branch', '--list'], join(server.root, 'site.git'))).not.toContain('feature-contact')
    expect(await remotes.push('site', origin(), plan)).toContain('Pushed 1 commit(s) to origin/feature-contact')
    expect(git(['rev-parse', 'feature-contact'], join(server.root, 'site.git')).trim()).toBe(plan.sha)
  }, 60_000)

  it('refuses a protected branch, a push with nothing new, one that is not a fast-forward, and one without a token', async () => {
    commit(repo(), 'a.md', 'a\n', 'on main')
    await expect(remotes.preparePush('site', site(), 'origin', origin(), 'main', 'site')).rejects.toThrow(/main is protected on origin/)
    const open = { ...origin(), protected: [] }
    git(['checkout', '-q', '-b', 'same', 'origin/main'], repo())
    const first = await remotes.preparePush('site', site(), 'origin', open, 'same', 'site')
    await remotes.push('site', open, first)
    await expect(remotes.preparePush('site', site(), 'origin', open, 'same', 'site')).rejects.toThrow(/Nothing to push/)
    // Someone else moves the branch on.
    const other = mkdtempSync(join(tmpdir(), 'git-other-'))
    git(['clone', '-q', '-b', 'same', join(server.root, 'site.git'), other])
    commit(other, 'b.md', 'b\n', 'elsewhere')
    git(['push', '-q', 'origin', 'same'], other)
    commit(repo(), 'c.md', 'c\n', 'here')
    await expect(remotes.preparePush('site', site(), 'origin', open, 'same', 'site')).rejects.toThrow(/has commits your branch does not/)
    await remotes.forget('site', 'origin')
    await expect(remotes.preparePush('site', site(), 'origin', open, 'same', 'site')).rejects.toThrow(/has no token/)
    rmSync(other, { recursive: true, force: true })
  }, 60_000)

  it('runs nothing the project\'s repository names with Argus\'s rights, and reads no other project', async () => {
    // A marker anywhere outside the project means something ran unconfined.
    const marker = join(data, 'PWNED')
    const hook = `#!/bin/sh\ntouch ${marker} || true\n`
    for (const name of ['pre-push', 'post-update', 'reference-transaction', 'post-checkout', 'post-merge', 'pre-receive', 'post-receive', 'update', 'pre-auto-gc', 'push-to-checkout']) {
      writeFileSync(join(repo(), '.git', 'hooks', name), hook)
      chmodSync(join(repo(), '.git', 'hooks', name), 0o755)
    }
    for (const [key, value] of [
      ['core.fsmonitor', `touch ${marker} #`],
      ['uploadpack.packObjectsHook', `touch ${marker} #`],
      ['core.sshCommand', `touch ${marker} #`],
      ['filter.evil.clean', `touch ${marker}; cat`],
      ['filter.evil.smudge', `touch ${marker}; cat`],
      [`url.${join(data, 'projects', 'beta')}.insteadOf`, origin().url],
    ] as const) git(['config', key, value], repo())
    // Beta's secret commit, reachable only through planted alternates.
    git(['init', '-q', '-b', 'main', join(data, 'projects', 'beta')])
    commit(join(data, 'projects', 'beta'), 's.txt', 'BETA-SECRET\n', 'secret')
    const betaHead = git(['rev-parse', 'HEAD'], join(data, 'projects', 'beta')).trim()
    writeFileSync(join(repo(), '.git', 'objects', 'info', 'alternates'), `${join(data, 'projects', 'beta', '.git', 'objects')}\n`)

    git(['checkout', '-q', '-b', 'feature'], repo())
    writeFileSync(join(repo(), '.gitattributes'), '* filter=evil\n')
    commit(repo(), 'x.md', 'x\n', 'with attributes')
    rmSync(marker, { force: true })

    const plan = await remotes.preparePush('site', site(), 'origin', origin(), 'feature', 'site')
    await remotes.push('site', origin(), plan)
    await remotes.pull('site', site(), 'origin', origin(), 'site')
    expect(existsSync(marker)).toBe(false)
    // The project's own hooks ran only confined, and beta's commit never left.
    expect(() => git(['cat-file', '-e', betaHead], join(server.root, 'site.git'))).toThrow()
    expect(statSync(join(server.root, 'site.git')).isDirectory()).toBe(true)
  }, 60_000)
})

describe('without the command sandbox', () => {
  it('does nothing in a project\'s folder', async () => {
    server.repo('site')
    const bare = new GitRemotes(join(data, 'state'), () => undefined, undefined, server.caFile)
    await expect(bare.clone('site', site(), 'origin', origin())).rejects.toThrow()
    expect(readdirSync(site())).toEqual([])
  }, 60_000)
})

describe('the project\'s git tools, through the service', () => {
  it('push only the commit a person saw, and audit every operation', async () => {
    const { bootProjects } = await import('../helpers.js')
    server.repo('site')
    process.env['GIT_SSL_CAINFO'] = server.caFile
    try {
      const booted = await bootProjects({
        projects: { site: { git: { remotes: { origin: { url: origin().url } } } }, other: {} },
        entries: [{ id: 'sandbox', name: '@argus-agent/argus-agent/sandbox-row' }],
      })
      const tokens = new Map<string, string>()
      ;(booted.ctx as unknown as { provide(name: string, value: unknown): void }).provide('credentials', {
        set: async (ref: unknown, value: string) => void tokens.set(String(ref), value),
        unset: async (ref: unknown) => void tokens.delete(String(ref)),
        resolve: async (ref: unknown) => (tokens.has(String(ref)) ? { value: tokens.get(String(ref)) } : undefined),
      })
      const projects = booted.projects
      await projects.git.setToken('site', 'origin', TOKEN)
      const cwd = projects.configOf('site')!.cwd
      mkdirSync(cwd, { recursive: true })

      expect(await projects.gitClone('other', {})).toContain('other has no git remote')
      expect(await projects.gitClone('site', { remote: 'nope' })).toContain('No remote "nope". site has origin.')
      expect(await projects.gitClone('site', { into: '.' })).toContain('Cloned')
      git(['checkout', '-q', '-b', 'feature'], cwd)
      commit(cwd, 'a.md', 'a\n', 'First change')

      const preview = await projects.gitPushPreview('site', { branch: 'feature' })
      expect(preview).toMatchObject({ ok: true })
      expect(preview.text).toMatch(/push 1 commit\(s\) to origin\/feature .*First change/)
      // The branch moves while the person reads the question: nothing goes.
      commit(cwd, 'b.md', 'b\n', 'Sneaked in')
      expect(await projects.gitPush('site', { branch: 'feature' })).toMatch(/feature changed after the push was approved .* nothing was pushed/)
      expect(() => git(['rev-parse', '--verify', 'feature'], join(server.root, 'site.git'))).toThrow()

      expect((await projects.gitPushPreview('site', { branch: 'feature' })).text).toContain('Sneaked in')
      expect(await projects.gitPush('site', { branch: 'feature' })).toContain('Pushed 2 commit(s) to origin/feature')
      expect(await projects.gitPush('site', { branch: 'main' })).toContain('main is protected')
      expect((await projects.gitPushPreview('site', { branch: 'main' })).ok).toBe(false)

      const audit = booted.store.audit.recent(20).filter((row) => row.action.startsWith('git.'))
      expect(audit.map((row) => row.action).sort()).toEqual(['git.clone', 'git.clone', 'git.clone', 'git.push', 'git.push', 'git.push'])
      const pushed = audit.find((row) => row.action === 'git.push' && row.details_json?.includes('"ok":true'))
      expect(pushed?.details_json).toMatch(/"commits":2/)
      expect(JSON.stringify(audit)).not.toContain(TOKEN)
      expect(everything(cwd)).not.toContain(TOKEN)
    } finally {
      delete process.env['GIT_SSL_CAINFO']
    }
  }, 90_000)
})
