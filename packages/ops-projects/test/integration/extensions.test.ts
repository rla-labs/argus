// == ARGUS AGENT PROJECT ==
/**
 * Extensions: fetched from a git repository, pinned; installed read-only with a hash the
 * start checks; `install` run through the sandbox, or not at all.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('installs one folder of a repository that holds several, and only that folder', async () => {
    const repo = repository()
    const commit = repo.commit({ 'media/extension.yaml': MANIFEST.replace('name: office', 'name: media'), 'media/server.js': '1\n', 'media/skills/office-docs/SKILL.md': '---\nname: x\ndescription: x.\n---\nx\n' })
    const extensions = store()
    const entry = await extensions.install((await extensions.fetch(`${repo.path}#media`, null)).id, 'admin')
    expect(entry).toMatchObject({ name: 'media', commit, source: `${repo.path}#media` })
    const dir = join(extensions.dir, entry.path)
    expect(readFileSync(join(dir, 'built.txt'), 'utf8')).toBe('built\n')
    expect(existsSync(join(dir, 'media'))).toBe(false)
    expect(readdirSync(join(extensions.dir, '.staging'))).toEqual([])
    await expect(extensions.fetch(`${repo.path}#nothing`, null)).rejects.toThrow('no folder nothing')
    repo.commit({ 'out/extension.yaml': 'x' })
    symlinkSync(tmpdir(), join(repo.path, 'escape'))
    repo.commit({})
    await expect(extensions.fetch(`${repo.path}#escape`, null)).rejects.toThrow('no folder escape')
    await expect(extensions.fetch(`${repo.path}#../x`, null)).rejects.toThrow('not a folder')
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
    try {
      parseManifest({ name: 'tools', version: '1', summary: 's', bin: ['../outside', '/abs'], env: { API_TOKEN: 'x', PATH: '/evil', lower: 'x' }, rules: ['rm -rf / ; x', 'ok *'] })
      message = ''
    } catch (error) {
      message = (error as Error).message
    }
    for (const problem of ['bin: ../outside must be a file inside', 'bin: /abs must be a file inside', 'env: API_TOKEN cannot be set', 'env: PATH cannot be set', 'env: lower is not a NAME_LIKE_THIS', 'rules: "rm -rf / ; x" is not a command rule']) expect(message).toContain(problem)
    expect(message).not.toContain('"ok *"')
  })

  it('installs only programs that are its own executable files, linked from .argus-bin', async () => {
    const plain = store()
    const notExecutable = repository(`${MANIFEST}\nbin: [tool.sh]\n`)
    notExecutable.commit({ 'tool.sh': '#!/bin/sh\necho x\n' })
    await expect(plain.install((await plain.fetch(notExecutable.path, null)).id, 'admin')).rejects.toMatchObject({ message: expect.stringContaining('Not an executable file of the extension: tool.sh') })
    const missing = store()
    await expect(missing.install((await missing.fetch(repository(`${MANIFEST}\nbin: [nope]\n`).path, null)).id, 'admin')).rejects.toMatchObject({ message: expect.stringContaining('Not an executable file of the extension: nope') })

    const good = store()
    const tool = repository(`${MANIFEST}\nbin: [bin/tool.sh]\ninstall: ["mkdir -p bin && printf '#!/bin/sh\\necho x\\n' > bin/tool.sh && chmod +x bin/tool.sh", "mkdir -p skills/office-docs && echo '# s' > skills/office-docs/SKILL.md"]\n`.replace('install: ["echo built > built.txt"]\n', ''))
    const entry = await good.install((await good.fetch(tool.path, null)).id, 'admin')
    const link = join(good.dir, entry.path, '.argus-bin', 'tool.sh')
    expect(execFileSync(link, { encoding: 'utf8' })).toBe('x\n')
    expect(good.verify()).toEqual([])
  })

  it('reads a source and its ref', () => {
    expect(parseSource('https://github.com/a/b@v1.2')).toEqual({ ok: true, source: 'https://github.com/a/b', ref: 'v1.2' })
    expect(parseSource('https://me@host.com/a/b')).toEqual({ ok: true, source: 'https://me@host.com/a/b', ref: null })
    expect(parseSource('/srv/ext/office@main')).toEqual({ ok: true, source: '/srv/ext/office', ref: 'main' })
    expect(parseSource('git://host/a').ok).toBe(false)
    expect(parseSource('ext/office').ok).toBe(false)
    expect(parseSource('/srv/x@--upload-pack=evil').ok).toBe(false)
    expect(parseSource('https://github.com/a/b#office@v1')).toEqual({ ok: true, source: 'https://github.com/a/b#office', ref: 'v1' })
    expect(parseSource('https://github.com/a/b#tools/office')).toEqual({ ok: true, source: 'https://github.com/a/b#tools/office', ref: null })
    expect(parseSource('https://github.com/a/b#../x').ok).toBe(false)
    expect(parseSource('https://github.com/a/b#/etc').ok).toBe(false)
    expect(parseSource('/srv/ext#a/./b').ok).toBe(false)
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
