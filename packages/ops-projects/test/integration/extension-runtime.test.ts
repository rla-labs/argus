// == ARGUS AGENT PROJECT ==
/**
 * An enabled extension in a project: its MCP server runs confined (it works in the
 * project's folder and cannot read /data), its skills and instructions reach that
 * project's agent only, and a project's own file may change its servers' access.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import ArgusSandbox from '@argus-agent/argus-agent/sandbox-row'
import { Extensions, parseProjectConfig, type UsableExtension } from '../../src/index.js'
import { userMessage } from '@argus-agent/testkit'
import { bootProjects, writeProject } from '../helpers.js'

const probe = fileURLToPath(new URL('../fixtures/probe-mcp.mjs', import.meta.url))
const MANIFEST = [
  'name: notes',
  'version: 1.0.0',
  'summary: Note tools',
  'skills: [skills/note-taking]',
  'mcp:',
  '  probe: {command: node, args: ["${EXTENSION_DIR}/probe-mcp.mjs"], access: allow}',
  'requires: {secrets: [PROBE_KEY]}',
  'instructions: Keep notes in notes/.',
].join('\n')

afterEach(() => {
  delete process.env['PROBE_KEY']
})

/** Install the `notes` extension into `<dataDir>/extensions`, as /ext install would. */
async function installNotes(dataDir: string): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'ext-notes-'))
  mkdirSync(join(repo, 'skills', 'note-taking'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'note-taking', 'SKILL.md'), '---\nname: note-taking\ndescription: How to keep notes.\n---\nOne file per day.\n')
  writeFileSync(join(repo, 'extension.yaml'), MANIFEST)
  copyFileSync(probe, join(repo, 'probe-mcp.mjs'))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'x']]) execFileSync('git', args, { cwd: repo, env })
  const extensions = new Extensions(join(dataDir, 'extensions'), async (argv) => argv)
  await extensions.install((await extensions.fetch(repo, null)).id, 'admin')
}

describe('an extension enabled in a project', () => {
  it('layers its servers under the project’s mcp block, which may set who runs their tools only', () => {
    const notes: UsableExtension = {
      name: 'notes',
      dir: '/data/extensions/notes/1.0.0-abc',
      manifest: { name: 'notes', version: '1', summary: 's', install: [], skills: ['skills/a'], mcp: { probe: { command: 'node', args: ['${EXTENSION_DIR}/p.mjs'], env: {}, access: 'allow', tools: { 'write_*': 'ask', erase: 'deny' }, timeout_s: 60 } }, requires: { secrets: ['PROBE_KEY'], network: false }, instructions: 'Be neat.', bin: [], env: {}, rules: [] },
    }
    const parse = (own: Record<string, unknown>) =>
      parseProjectConfig({ id: 'site', cwd: '/data/projects/site', provider: 'p', model: 'm', ...own }, { sourcePath: 's', projectsRoot: '/data/projects', extensions: new Map([['notes', notes]]) })
    const config = parse({ extensions: ['notes', 'gone'] })
    expect(config.mcp['probe']).toMatchObject({ command: 'node', args: ['/data/extensions/notes/1.0.0-abc/p.mjs'], env: { PROBE_KEY: '${PROBE_KEY}' }, access: 'allow', extension: { name: 'notes', dir: notes.dir } })
    expect(config.extensions).toEqual([{ name: 'notes', dir: notes.dir, skills: [`${notes.dir}/skills/a`], instructions: 'Be neat.', binDir: null, env: {} }])
    expect(config.extensionsMissing).toEqual(['gone'])
    expect(parse({ extensions: ['notes'], mcp: { probe: { access: 'ask' } } }).mcp['probe']?.access).toBe('ask')
    // Its tool defaults, under the project's own: a key the project sets replaces the same key.
    expect(config.mcp['probe']?.tools).toEqual({ 'write_*': 'ask', erase: 'deny' })
    expect(parse({ extensions: ['notes'], mcp: { probe: { tools: { erase: 'ask', 'read_*': 'allow' } } } }).mcp['probe']?.tools).toEqual({ 'write_*': 'ask', erase: 'ask', 'read_*': 'allow' })
    expect(() => parse({ extensions: ['notes'], mcp: { probe: { command: 'sh' } } })).toThrow(/comes from the extension notes: only its access, tools, timeout_s/)
    expect(parse({}).mcp['probe']).toBeUndefined()
    // Its access left in a project's file after the extension is gone: dropped, the project loads.
    const orphan = parseProjectConfig({ id: 'site', cwd: '/data/projects/site', provider: 'p', model: 'm', extensions: ['notes'], mcp: { probe: { access: 'ask', tools: { erase: 'ask' } } } }, { sourcePath: 's', projectsRoot: '/data/projects' })
    expect(orphan.mcp['probe']).toBeUndefined()
    expect(orphan.extensionsMissing).toEqual(['notes'])
  })

  const sandbox = new ArgusSandbox(new Context())
  const landlock = sandbox.doctor()[0]?.ok === true

  it.skipIf(!landlock)('runs its server confined: it writes in the project and cannot read /data; skills and instructions reach that project only', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-projects-ext-'))
    await installNotes(dataDir)
    writeFileSync(join(dataDir, 'secret.txt'), 'SECRET')
    process.env['PROBE_KEY'] = 'the-key'
    const { projects, ctx } = await bootProjects({
      dataDir,
      projects: { site: { extensions: ['notes'] }, other: {} },
      entries: [{ id: 'skill', name: '@deepseek-ai/dsh-skill' }, { id: 'sandbox', name: '@argus-agent/argus-agent/sandbox-row' }],
    })
    const agent = await projects.ensureAgent('site')
    const tools = (agent as unknown as { ctx: { tools: { get(name: string, scope: unknown): { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined } } }).ctx
    const tool = tools.tools.get('mcp__probe__probe', scopeOf(tools as never))
    expect(tool).toBeDefined()
    const out = JSON.stringify(await tool?.execute({ read: join(dataDir, 'secret.txt') }, { signal: new AbortController().signal }))
    expect(out).toContain('wrote; read: refused')
    expect(out).not.toContain('SECRET')
    expect(out).toContain('secret: the-key')
    expect(readFileSync(join(dataDir, 'projects', 'site', 'made-by-extension.txt'), 'utf8')).toBe('ok')

    const skills = (ctx as unknown as { skills: { list(options: { cwd: string; scope: unknown }): Promise<{ name: string }[]> } }).skills
    const names = async (id: string) => {
      const a = await projects.ensureAgent(id)
      return (await skills.list({ cwd: projects.configOf(id)!.cwd, scope: scopeOf(a.ctx) })).map((skill) => skill.name)
    }
    expect(await names('site')).toEqual(['note-taking'])
    expect(await names('other')).toEqual([])

    const section = async (id: string) => {
      const a = (await projects.ensureAgent(id)) as unknown as { ctx: { systemPrompt?: { assemble(context: unknown): Promise<{ sections: Array<{ name: string; text: string }> }> } } }
      const assembly = await a.ctx.systemPrompt?.assemble({ scope: scopeOf(a.ctx as never) })
      return assembly?.sections.find((s) => s.name === 'argus:extensions')?.text
    }
    expect(await section('site')).toContain('Keep notes in notes/.')
    expect(await section('other')).toBeUndefined()
    expect(existsSync(join(dataDir, 'projects', 'other', 'made-by-extension.txt'))).toBe(false)
  }, 60_000)

  it('leaves its server out when there is no sandbox, and the project still runs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-projects-ext-'))
    await installNotes(dataDir)
    const { projects } = await bootProjects({ dataDir, projects: { site: { extensions: ['notes'] } } })
    const agent = await projects.ensureAgent('site')
    const ctx = (agent as unknown as { ctx: { tools: { get(name: string, scope: unknown): unknown } } }).ctx
    expect(ctx.tools.get('mcp__probe__probe', scopeOf(ctx as never))).toBeUndefined()
  }, 60_000)

  it('reaches a live project at its next message, in the same conversation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-projects-ext-'))
    await installNotes(dataDir)
    const { projects, ctx } = await bootProjects({
      dataDir,
      projects: { site: {} },
      fake: { script: [{ text: 'ok' }], repeatLast: true },
      entries: [{ id: 'skill', name: '@deepseek-ai/dsh-skill' }],
    })
    const before = await projects.ensureAgent('site')
    before.followup(userMessage('m-1', 'remember banana'))
    await before.whenIdle()

    writeProject(dataDir, 'site', { extensions: ['notes'] })
    const { reload } = await import('../../src/index.js')
    reload(projects['ctx'] as never, projects)

    const after = await projects.ensureAgent('site')
    expect(after.id).toBe(before.id)
    expect(JSON.stringify(after.session.snapshotEvents())).toContain('banana')
    const a = after as unknown as { ctx: { systemPrompt?: { assemble(context: unknown): Promise<{ sections: Array<{ name: string; text: string }> }> } } }
    const assembly = await a.ctx.systemPrompt?.assemble({ scope: scopeOf(a.ctx as never) })
    expect(assembly?.sections.find((s) => s.name === 'argus:extensions')?.text).toContain('Keep notes in notes/.')
    const skills = (ctx as unknown as { skills: { list(options: { cwd: string; scope: unknown }): Promise<{ name: string }[]> } }).skills
    expect((await skills.list({ cwd: projects.configOf('site')!.cwd, scope: scopeOf(after.ctx) })).map((skill) => skill.name)).toEqual(['note-taking'])
  }, 60_000)

  it.skipIf(!landlock)('puts its programs on the shell PATH of a project that enables it, with its variables, and nowhere else', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ops-projects-bin-'))
    const repo = mkdtempSync(join(tmpdir(), 'ext-tools-'))
    mkdirSync(join(repo, 'bin'))
    writeFileSync(join(repo, 'bin', 'hello'), '#!/bin/sh\necho "hello from $TOOLS_MODE"\necho made > made-by-hello.txt\n', { mode: 0o755 })
    writeFileSync(join(repo, 'bin', 'helper'), '#!/bin/sh\necho not named\n', { mode: 0o755 })
    writeFileSync(join(repo, 'extension.yaml'), 'name: tools\nversion: 1.0.0\nsummary: A tool\nbin: [bin/hello]\nenv: {TOOLS_MODE: quiet}\nrules: ["hello *"]\n')
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'x']]) execFileSync('git', args, { cwd: repo, env })
    const extensions = new Extensions(join(dataDir, 'extensions'), async (argv) => argv)
    const installed = await extensions.install((await extensions.fetch(repo, null)).id, 'admin')
    expect(extensions.verify()).toEqual([])

    const { projects, ctx } = await bootProjects({
      dataDir,
      projects: { site: { extensions: ['tools'] }, other: {} },
      entries: [{ id: 'sandbox', name: '@argus-agent/argus-agent/sandbox-row' }],
    })
    const sandbox = (ctx as unknown as { sandbox: ArgusSandbox }).sandbox
    const shell = async (id: string, command: string) => {
      const cwd = projects.configOf(id)!.cwd
      mkdirSync(cwd, { recursive: true })
      const { argv } = await sandbox.confine(['sh', '-c', command], { mode: 'workspace-write', workspaceRoot: cwd })
      try {
        return execFileSync(argv[0] as string, argv.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        return `failed: ${(error as { stderr?: string }).stderr ?? ''}`
      }
    }
    expect(await shell('site', 'hello')).toBe('hello from quiet\n')
    expect(readFileSync(join(projects.configOf('site')!.cwd, 'made-by-hello.txt'), 'utf8')).toBe('made\n')
    // Only the programs it names.
    expect(await shell('site', 'helper')).toMatch(/failed: .*not found/)
    // Not in a project that did not enable it, not even by its path.
    expect(await shell('other', 'hello')).toMatch(/failed: .*not found/)
    expect(await shell('other', `${join(dataDir, 'extensions', installed.path, 'bin', 'hello')}`)).toMatch(/failed: .*Permission denied/)
    expect(await shell('other', 'echo "[$TOOLS_MODE]"')).toBe('[]\n')
  }, 60_000)
})
