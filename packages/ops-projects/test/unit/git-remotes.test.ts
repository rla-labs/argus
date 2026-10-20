// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for a project's git remotes: what a remote may be, and where its token is
 * kept. The token is the security-relevant part: it is per project and per remote, and
 * its name is one nothing else may use.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitRemotes, gitTokenName, isGitTokenName, parseGitBlock, type TokenStore } from '../../src/git-remotes.js'
import { parseProjectConfig } from '../../src/project-config.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** dsh's credentials service, in memory. */
function memoryStore(): TokenStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    set: async (ref, value) => void values.set(String(ref), value),
    unset: async (ref) => void values.delete(String(ref)),
    resolve: async (ref) => (values.has(String(ref)) ? { value: values.get(String(ref)) as string } : undefined),
  }
}

describe('a project file\'s git block', () => {
  it('takes https remotes, with main and master protected unless a remote says otherwise', () => {
    const { remotes, issues } = parseGitBlock({ remotes: { origin: { url: 'https://github.com/acme/site.git' }, mirror: { url: 'https://gitlab.com/acme/site.git', protected: [] } } })
    expect(issues).toEqual([])
    expect(remotes).toEqual({
      origin: { url: 'https://github.com/acme/site.git', protected: ['main', 'master'] },
      mirror: { url: 'https://gitlab.com/acme/site.git', protected: [] },
    })
  })

  it('refuses plain http, ssh, a token or a user in the URL, a bad name and unknown keys', () => {
    const { remotes, issues } = parseGitBlock({
      remotes: {
        plain: { url: 'http://github.com/a/b.git' },
        ssh: { url: 'git@github.com:a/b.git' },
        token: { url: 'https://x-access-token:ghp_secret@github.com/a/b.git' },
        user: { url: 'https://someone@github.com/a/b.git' },
        Bad_Name: { url: 'https://github.com/a/b.git' },
        extra: { url: 'https://github.com/a/b.git', token: 'ghp_secret' },
        bare: { url: 'https://github.com' },
      },
      other: true,
    })
    expect(Object.keys(remotes)).toEqual(['Bad_Name', 'extra'])
    const said = issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')
    expect(said).toContain('git.other: unknown')
    expect(said).toMatch(/git\.remotes\.plain: url: https:\/\/ only/)
    expect(said).toMatch(/git\.remotes\.ssh: url: .* is not a URL|git\.remotes\.ssh: url: https:\/\/ only/)
    expect(said).toMatch(/git\.remotes\.token: url: no user or token in the URL/)
    expect(said).toMatch(/git\.remotes\.user: url: no user or token in the URL/)
    expect(said).toMatch(/git\.remotes\.Bad_Name: remote names must match/)
    expect(said).toMatch(/git\.remotes\.extra\.token: unknown/)
    expect(said).toMatch(/git\.remotes\.bare: url: the repository's path is missing/)
  })

  it('makes a project invalid when it is wrong, and is empty when absent', () => {
    const base = { id: 'site', cwd: '/data/projects/site', provider: 'fake', model: 'fake-model' }
    const options = { sourcePath: '/data/config/projects/site.yaml', projectsRoot: '/data/projects', expectedId: 'site' }
    expect(parseProjectConfig(base, options).git).toEqual({ remotes: {} })
    expect(parseProjectConfig({ ...base, git: { remotes: { origin: { url: 'https://github.com/a/b.git' } } } }, options).git.remotes['origin']?.url).toBe('https://github.com/a/b.git')
    expect(() => parseProjectConfig({ ...base, git: { remotes: { origin: { url: 'http://github.com/a/b.git' } } } }, options)).toThrow(/git\.remotes\.origin: url: https:\/\/ only/)
  })
})

describe('a remote\'s token', () => {
  it('is kept under a reserved name of its own project and remote', () => {
    const name = gitTokenName('site', 'origin')
    expect(name).toMatch(/^ARGUS_GIT_[0-9A-F]{24}$/)
    expect(isGitTokenName(name)).toBe(true)
    expect(isGitTokenName('GITHUB_TOKEN')).toBe(false)
    expect(gitTokenName('site', 'origin')).toBe(name)
    expect(new Set([name, gitTokenName('site', 'mirror'), gitTokenName('blog', 'origin'), gitTokenName('a-b', 'c'), gitTokenName('a', 'b-c')]).size).toBe(5)
  })

  it('is saved, read, forgotten and removed with the mirrors, project by project', async () => {
    const state = mkdtempSync(join(tmpdir(), 'git-remotes-'))
    dirs.push(state)
    const store = memoryStore()
    const git = new GitRemotes(state, () => store)
    await git.setToken('site', 'origin', 'tok-site')
    await git.setToken('blog', 'origin', 'tok-blog')
    expect(await git.token('site', 'origin')).toBe('tok-site')
    expect(await git.token('blog', 'origin')).toBe('tok-blog')
    expect(await git.hasToken('site', 'mirror')).toBe(false)
    // Nothing in the store is named after the project or holds it in clear.
    expect([...store.values.keys()].every((key) => isGitTokenName(key) && !key.includes('SITE'))).toBe(true)

    expect(await git.forget('site', 'origin')).toBe(true)
    expect(await git.forget('site', 'origin')).toBe(false)
    expect(await git.token('blog', 'origin')).toBe('tok-blog')

    await git.setToken('site', 'origin', 'tok-site')
    mkdirSync(git.mirrorOf('site', 'origin'), { recursive: true })
    await git.removeAll('site', ['origin'])
    expect(await git.hasToken('site', 'origin')).toBe(false)
    expect(existsSync(join(state, 'site', 'remotes'))).toBe(false)
    expect(await git.token('blog', 'origin')).toBe('tok-blog')
  })

  it('cannot be saved without the credentials store', async () => {
    const git = new GitRemotes('/nonexistent', () => undefined)
    await expect(git.setToken('site', 'origin', 'x')).rejects.toThrow(/credentials store is not loaded/)
    expect(await git.hasToken('site', 'origin')).toBe(false)
  })
})
