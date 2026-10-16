// == ARGUS AGENT PROJECT ==
/**
 * Extensions: fetched from a git repository, pinned; installed read-only with a hash the
 * start checks; `install` run through the sandbox, or not at all.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ArgusSandbox from '@argus-agent/argus-agent/sandbox-row'
import { Extensions, parseManifest, parseSource, treeHash, type Confine } from '../../src/index.js'

const unconfined: Confine = async (argv) => argv

const MANIFEST = [
  'name: office',
  'version: 1.0.0',
  'summary: Word, Excel and PowerPoint files',
  'install: ["echo built > built.txt"]',
  'skills: [skills/office-docs]',
  'mcp:',
  '  office: {command: node, args: [server.js], access: allow}',
  'requires: {secrets: [OFFICE_KEY], network: false}',
  'instructions: Use the office tools for .docx files.',
].join('\n')

/** A git repository with an extension in it; returns its path and a way to commit more. */
function repository(manifest = MANIFEST): { path: string; commit(files: Record<string, string>): string } {
  const path = mkdtempSync(join(tmpdir(), 'ext-repo-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim()
  const commit = (files: Record<string, string>): string => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(path, name, '..'), { recursive: true })
      writeFileSync(join(path, name), text)
    }
    git('add', '-A')
    git('commit', '-q', '-m', 'x')
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q', '-b', 'main')
  commit({ 'extension.yaml': manifest, 'server.js': 'console.log(1)\n', 'skills/office-docs/SKILL.md': '---\nname: office-docs\ndescription: Office files.\n---\nUse the tools.\n' })
  return { path, commit }
}

const store = (confine: Confine = unconfined) => new Extensions(mkdtempSync(join(tmpdir(), 'ext-data-')), confine)

describe('extensions', () => {
  it('installs from a local repository, pinned, read-only, with the hash in the lock', async () => {
    const repo = repository()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path }).toString().trim()
    const extensions = store()
    const staged = await extensions.fetch(repo.path, null)
    expect(staged.commit).toBe(head)
    expect(staged.manifest.mcp['office']).toMatchObject({ command: 'node', access: 'allow' })
    const entry = await extensions.install(staged.id, 'admin')
    const dir = join(extensions.dir, entry.path)
    expect(entry).toMatchObject({ name: 'office', version: '1.0.0', commit: head, source: repo.path, installed_by: 'admin' })
    expect(readFileSync(join(dir, 'built.txt'), 'utf8')).toBe('built\n')
    expect(existsSync(join(dir, '.git'))).toBe(false)
    expect(statSync(join(dir, 'server.js')).mode & 0o222).toBe(0)
    expect(entry.sha256).toBe(treeHash(dir))
    expect(readFileSync(join(extensions.dir, 'lock.yaml'), 'utf8')).toContain(head)
    expect(extensions.verify()).toEqual([])
    expect(existsSync(join(extensions.dir, '.staging', staged.id))).toBe(false)
  })

  it('reports a tree that changed after install', async () => {
    const extensions = store()
    const entry = await extensions.install((await extensions.fetch(repository().path, null)).id, 'admin')
    const file = join(extensions.dir, entry.path, 'server.js')
    chmodSync(join(extensions.dir, entry.path), 0o755)
    chmodSync(file, 0o644)
    writeFileSync(file, 'steal()\n')
    expect(extensions.verify()).toEqual([{ name: 'office', problem: expect.stringContaining('changed since it was installed') }])
  })

  it('updates to a later commit, pinned to a ref, and drops the old folder', async () => {
    const repo = repository()
    const extensions = store()
    const first = await extensions.install((await extensions.fetch(repo.path, null)).id, 'admin')
    const later = repo.commit({ 'extension.yaml': MANIFEST.replace('1.0.0', '1.1.0').replace('access: allow', 'access: ask') })
    const staged = await extensions.fetch(repo.path, 'main')
    expect(staged.installed?.version).toBe('1.0.0')
    expect(staged.installedManifest?.mcp['office']?.access).toBe('allow')
    const second = await extensions.install(staged.id, 'admin')
    expect(second).toMatchObject({ version: '1.1.0', commit: later, ref: 'main' })
    expect(existsSync(join(extensions.dir, first.path))).toBe(false)
    expect(extensions.installed()).toHaveLength(1)
    expect(extensions.remove('office')).toBe(true)
    expect(extensions.installed()).toEqual([])
    expect(existsSync(join(extensions.dir, 'office'))).toBe(false)
  })

  it('installs nothing when install fails, when there is no sandbox, or when a skill is missing', async () => {
    const failing = store()
    const bad = repository(MANIFEST.replace('echo built > built.txt', 'echo nope >&2; exit 3'))
    await expect(failing.install((await failing.fetch(bad.path, null)).id, 'admin')).rejects.toMatchObject({ code: 'EXTENSION_INSTALL_FAILED', message: expect.stringMatching(/failed \(3\)[\s\S]*nope/) })
    expect(failing.installed()).toEqual([])

    const nowhere = store(async () => {
      throw new Error('no ctx.sandbox')
    })
    await expect(nowhere.install((await nowhere.fetch(repository().path, null)).id, 'admin')).rejects.toMatchObject({ code: 'EXTENSION_INSTALL_FAILED', message: expect.stringContaining('only confined') })

    const noSkill = store()
    const missing = repository(MANIFEST.replace('skills/office-docs', 'skills/other'))
    await expect(noSkill.install((await noSkill.fetch(missing.path, null)).id, 'admin')).rejects.toMatchObject({ message: expect.stringContaining('No SKILL.md in skills/other') })
  })

  it('refuses a folder that is not a repository, and a bad manifest', async () => {
    const extensions = store()
    await expect(extensions.fetch(mkdtempSync(join(tmpdir(), 'not-a-repo-')), null)).rejects.toMatchObject({ code: 'EXTENSION_INVALID' })
    await expect(extensions.fetch(repository(MANIFEST.replace('skills/office-docs', '../../etc')).path, null)).rejects.toMatchObject({ message: expect.stringContaining('must be a folder inside the extension') })
    let message = ''
    try {
      parseManifest({ name: 'X', version: '1', summary: 's', mcp: { o: { url: 'https://x' } }, extra: 1 })
    } catch (error) {
      message = (error as Error).message
    }
    for (const problem of ['extra: not an extension key', 'name: lowercase', 'mcp.o.url: not a server key', 'mcp.o.command: the program']) expect(message).toContain(problem)
  })

  it('reads a source and its ref', () => {
    expect(parseSource('https://github.com/a/b@v1.2')).toEqual({ ok: true, source: 'https://github.com/a/b', ref: 'v1.2' })
    expect(parseSource('https://me@host.com/a/b')).toEqual({ ok: true, source: 'https://me@host.com/a/b', ref: null })
    expect(parseSource('/srv/ext/office@main')).toEqual({ ok: true, source: '/srv/ext/office', ref: 'main' })
    expect(parseSource('git://host/a').ok).toBe(false)
    expect(parseSource('ext/office').ok).toBe(false)
    expect(parseSource('/srv/x@--upload-pack=evil').ok).toBe(false)
  })

  const sandbox = new ArgusSandbox(new Context())
  it.skipIf(sandbox.doctor()[0]?.ok !== true)('runs install in the sandbox: it writes in its folder and nowhere else', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ext-outside-'))
    const confined = store(async (argv, root) => (await sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: root })).argv)
    const ok = await confined.install((await confined.fetch(repository().path, null)).id, 'admin')
    expect(readFileSync(join(confined.dir, ok.path, 'built.txt'), 'utf8')).toBe('built\n')
    const escape = repository(MANIFEST.replace('echo built > built.txt', `echo x > ${join(outside, 'pwned')}`))
    await expect(confined.install((await confined.fetch(escape.path, null)).id, 'admin')).rejects.toMatchObject({ code: 'EXTENSION_INSTALL_FAILED' })
    expect(existsSync(join(outside, 'pwned'))).toBe(false)
  })
})
