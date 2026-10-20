// == ARGUS AGENT PROJECT ==
/**
 * Extensions: skills and MCP tools the admin installs once, outside every project.
 *
 * An extension is a git repository with an `extension.yaml`. Installing it clones it,
 * pinned to a commit, into `<extensions>/.staging/`, runs its `install` commands in the
 * command sandbox (they write only in the extension's folder; they have the network),
 * then moves it to `<extensions>/<name>/<version>-<commit>/`, read-only, and records it
 * in `<extensions>/lock.yaml` with a sha-256 of the whole tree. At start every installed
 * tree is checked against its hash; a changed one is reported and not used.
 *
 * @module @argus-agent/projects/extensions
 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import { MCP_SERVER_PATTERN, OpsError, isInside } from '@argus-agent/types'

const run = promisify(execFile)

/** An extension's name: also its folder and the prefix of nothing else. */
export const EXTENSION_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/
/** The largest `instructions` an extension may add to a project's. */
const INSTRUCTIONS_MAX_BYTES = 8192
/** How long all of an extension's `install` commands may take. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** How long a clone may take. */
const FETCH_TIMEOUT_MS = 2 * 60_000

/** One MCP server an extension brings: always a local program, run from its folder. */
export interface ExtensionServer {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** The access the admin is asked to accept for its tools. */
  readonly access: 'deny' | 'ask' | 'allow'
  readonly timeout_s: number
}

/** A validated `extension.yaml`. */
export interface ExtensionManifest {
  readonly name: string
  readonly version: string
  readonly summary: string
  /** Shell command lines run once, at install, in the extension's folder. */
  readonly install: readonly string[]
  /** Folders inside the extension, each with a `SKILL.md`. */
  readonly skills: readonly string[]
  readonly mcp: Readonly<Record<string, ExtensionServer>>
  readonly requires: { readonly secrets: readonly string[]; readonly network: boolean }
  /** Added to the instructions of a project that enables it. */
  readonly instructions: string
  /** Programs inside the extension a project that enables it runs from its shell, by name. */
  readonly bin: readonly string[]
  /** Variables set for the commands of a project that enables it; never a secret. */
  readonly env: Readonly<Record<string, string>>
  /** Approval rules offered when a project enables it (`officecli *`); never applied by themselves. */
  readonly rules: readonly string[]
}

/** The folder of an installed extension that a project's PATH gets: links to its `bin`. */
export const BIN_DIR = '.argus-bin'

/** A variable name that would carry a secret: an extension's `env` may not set one. */
const SECRET_LIKE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i

/** An installed extension, as `lock.yaml` records it. */
export interface ExtensionLock {
  readonly name: string
  readonly version: string
  /** What `/ext install` was given: an `https://` URL or an absolute path to a repository. */
  readonly source: string
  /** The ref asked for (`@ref`), or null for the default branch. */
  readonly ref: string | null
  readonly commit: string
  /** sha-256 of the installed tree (`treeHash`). */
  readonly sha256: string
  /** The folder, relative to the extensions directory. */
  readonly path: string
  readonly installed_by: string
  readonly installed_at: number
}

/** A fetched extension waiting for the admin's confirmation. */
export interface StagedExtension {
  /** The staging id `/ext install-confirm` takes. */
  readonly id: string
  readonly source: string
  readonly ref: string | null
  readonly commit: string
  readonly manifest: ExtensionManifest
  /** What is installed under that name now, if anything: `update` shows the difference. */
  readonly installed: ExtensionLock | undefined
  /** Its manifest, when it can still be read. */
  readonly installedManifest: ExtensionManifest | undefined
}

/** An installed, intact extension, as a project uses it. */
export interface UsableExtension {
  readonly name: string
  /** Its installed folder, absolute. */
  readonly dir: string
  readonly manifest: ExtensionManifest
}

/** Wrap a command so it runs confined to one folder (the command sandbox). */
export type Confine = (argv: readonly string[], root: string) => Promise<readonly string[]>

/** An extension's folder inside a repository: relative, plain, never `..`. */
const FOLDER = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

/** A source's repository and, after `#`, the extension's folder in it (null: the root). */
export function splitFolder(source: string): { repository: string; folder: string | null } {
  const hash = source.indexOf('#')
  return hash === -1 ? { repository: source, folder: null } : { repository: source.slice(0, hash), folder: source.slice(hash + 1) }
}

/**
 * Split `/ext install`'s argument into a source and a ref: `<source>[#<folder>][@<ref>]`,
 * where the `@` comes after the last `/` (an `https://user@host/...` keeps its `@`).
 * `#<folder>` picks an extension in a folder of a repository that holds several.
 *
 * @param text the argument.
 * @returns the source and the ref, or why the source is not accepted.
 */
export function parseSource(text: string): { ok: true; source: string; ref: string | null } | { ok: false; message: string } {
  const at = text.lastIndexOf('@')
  const split = at > text.lastIndexOf('/')
  const source = split ? text.slice(0, at) : text
  const ref = split ? text.slice(at + 1) : null
  if (ref !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(ref)) return { ok: false, message: `"${ref}" is not a branch, tag or commit.` }
  const folder = splitFolder(source).folder
  if (folder !== null && !FOLDER.test(folder)) return { ok: false, message: `"${folder}" is not a folder of the repository (letters, digits, . _ - and /, never ..).` }
  if (/^https:\/\/[^\s]+$/.test(source)) return { ok: true, source, ref }
  if (isAbsolute(source) && !source.includes('\n')) return { ok: true, source: normalize(source), ref }
  return { ok: false, message: 'Give an https:// git URL or the absolute path of a git repository on the server.' }
}

/**
 * Validate an `extension.yaml`.
 *
 * @param raw the parsed file.
 * @returns the manifest.
 * @throws {OpsError} `EXTENSION_INVALID`, naming every problem.
 */
export function parseManifest(raw: unknown): ExtensionManifest {
  const problems: string[] = []
  const doc = isMapping(raw) ? raw : (problems.push('extension.yaml must be a mapping'), {} as Record<string, unknown>)
  const known = ['name', 'version', 'summary', 'install', 'skills', 'mcp', 'requires', 'instructions', 'bin', 'env', 'rules']
  for (const key of Object.keys(doc)) if (!known.includes(key)) problems.push(`${key}: not an extension key; use ${known.join(', ')}`)
  const text = (key: string, pattern: RegExp, what: string): string => {
    const value = doc[key]
    if (typeof value !== 'string' || !pattern.test(value)) problems.push(`${key}: ${what}`)
    return typeof value === 'string' ? value : ''
  }
  const strings = (value: unknown, key: string): string[] => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
      problems.push(`${key}: a list of strings`)
      return []
    }
    return value as string[]
  }
  const name = text('name', EXTENSION_NAME, 'lowercase letters, digits and dashes, 2 to 41')
  const version = text('version', /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/, 'a version such as 1.2.0')
  const summary = text('summary', /^[^\n]{1,200}$/, 'one line, up to 200 characters')
  const install = strings(doc['install'], 'install')
  const skills = strings(doc['skills'], 'skills')
  for (const path of skills) {
    if (isAbsolute(path) || normalize(path).split(sep).includes('..')) problems.push(`skills: ${path} must be a folder inside the extension`)
  }
  const mcp: Record<string, ExtensionServer> = {}
  const servers = doc['mcp'] ?? {}
  if (!isMapping(servers)) problems.push('mcp: must map server names to servers')
  else {
    for (const [server, value] of Object.entries(servers)) {
      const where = `mcp.${server}`
      if (!MCP_SERVER_PATTERN.test(server)) problems.push(`${where}: server names must match ${MCP_SERVER_PATTERN}`)
      if (!isMapping(value)) {
        problems.push(`${where}: must be a mapping with a command`)
        continue
      }
      for (const key of Object.keys(value)) {
        if (!['command', 'args', 'env', 'access', 'timeout_s'].includes(key)) problems.push(`${where}.${key}: not a server key; use command, args, env, access, timeout_s`)
      }
      const env = value['env'] ?? {}
      const access = value['access'] ?? 'ask'
      const timeout = value['timeout_s'] ?? 60
      if (typeof value['command'] !== 'string' || value['command'].length === 0) problems.push(`${where}.command: the program to run`)
      if (!isMapping(env) || Object.values(env).some((item) => typeof item !== 'string')) problems.push(`${where}.env: names to strings`)
      if (access !== 'deny' && access !== 'ask' && access !== 'allow') problems.push(`${where}.access: deny, ask or allow`)
      if (typeof timeout !== 'number' || timeout < 1) problems.push(`${where}.timeout_s: a number of seconds`)
      mcp[server] = {
        command: String(value['command'] ?? ''),
        args: strings(value['args'], `${where}.args`),
        env: (isMapping(env) ? env : {}) as Record<string, string>,
        access: access as ExtensionServer['access'],
        timeout_s: Number(timeout),
      }
    }
  }
  const requires = doc['requires'] ?? {}
  if (!isMapping(requires)) problems.push('requires: a mapping with secrets and network')
  const needs = isMapping(requires) ? requires : {}
  const secrets = strings(needs['secrets'], 'requires.secrets')
  for (const secret of secrets) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(secret)) problems.push(`requires.secrets: ${secret} is not a NAME_LIKE_THIS`)
    else if (secret.startsWith('ARGUS_GIT_')) problems.push(`requires.secrets: ${secret}: ARGUS_GIT_ names are reserved for git tokens`)
  }
  const network = needs['network'] ?? false
  if (typeof network !== 'boolean') problems.push('requires.network: true or false')
  const bin = strings(doc['bin'], 'bin')
  for (const path of bin) {
    if (isAbsolute(path) || normalize(path).split(sep).includes('..')) problems.push(`bin: ${path} must be a file inside the extension`)
  }
  const env = doc['env'] ?? {}
  if (!isMapping(env) || Object.values(env).some((value) => typeof value !== 'string')) problems.push('env: names to strings')
  for (const name of Object.keys(isMapping(env) ? env : {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) problems.push(`env: ${name} is not a NAME_LIKE_THIS`)
    else if (SECRET_LIKE.test(name) || ['PATH', 'HOME', 'TMPDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(name)) problems.push(`env: ${name} cannot be set by an extension (a secret goes in requires.secrets; PATH comes from bin)`)
  }
  const rules = strings(doc['rules'], 'rules')
  for (const rule of rules) {
    if (!/^[\w./:=@+-]+( [\w./:=@+-]+)*( \*)?$/.test(rule) || rule.length > 120) problems.push(`rules: "${rule}" is not a command rule ("officecli *")`)
  }
  const instructions = doc['instructions'] ?? ''
  if (typeof instructions !== 'string') problems.push('instructions: text')
  else if (Buffer.byteLength(instructions) > INSTRUCTIONS_MAX_BYTES) problems.push(`instructions: at most ${INSTRUCTIONS_MAX_BYTES / 1024} KB`)
  if (problems.length > 0) throw new OpsError('EXTENSION_INVALID', `extension.yaml is not valid:\n${problems.map((line) => `  - ${line}`).join('\n')}`)
  return {
    name,
    version,
    summary,
    install,
    skills,
    mcp,
    requires: { secrets, network: network as boolean },
    instructions: (instructions as string).trim(),
    bin,
    env: (isMapping(env) ? env : {}) as Record<string, string>,
    rules,
  }
}

/**
 * A sha-256 of a folder: every entry's path, kind, mode and content (a link's target,
 * not what it points to), in a fixed order.
 *
 * @param root the folder.
 * @returns the hex digest.
 */
export function treeHash(root: string): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const rel = relative(root, path)
      if (stat.isSymbolicLink()) hash.update(`l ${rel} ${readlinkSync(path)}\n`)
      else if (stat.isDirectory()) {
        hash.update(`d ${rel}\n`)
        walk(path)
      } else if (stat.isFile()) hash.update(`f ${rel} ${stat.mode & 0o111 ? 'x' : '-'} ${createHash('sha256').update(readFileSync(path)).digest('hex')}\n`)
    }
  }
  walk(root)
  return hash.digest('hex')
}

/**
 * The installed extensions and the ones being installed.
 */
export class Extensions {
  private readonly staged = new Map<string, StagedExtension & { readonly at: number }>()
  /** The names whose tree failed the last `verify()`: not used until reinstalled. */
  private broken = new Set<string>()

  /**
   * @param dir the extensions directory (`<data_dir>/extensions`).
   * @param confine wraps a command in the command sandbox, or throws when there is none.
   * @param now the clock.
   */
  constructor(
    readonly dir: string,
    private readonly confine: Confine,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every installed extension, by name. */
  installed(): ExtensionLock[] {
    const file = join(this.dir, 'lock.yaml')
    if (!existsSync(file)) return []
    const doc = parseYaml(readFileSync(file, 'utf8')) as { extensions?: Record<string, Omit<ExtensionLock, 'name'>> } | null
    return Object.entries(doc?.extensions ?? {})
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** One installed extension. */
  get(name: string): ExtensionLock | undefined {
    return this.installed().find((entry) => entry.name === name)
  }

  /** An installed extension's manifest, read from its folder. */
  manifestOf(name: string): ExtensionManifest | undefined {
    const entry = this.get(name)
    return entry === undefined ? undefined : parseManifest(parseYaml(readFileSync(join(this.dir, entry.path, 'extension.yaml'), 'utf8')))
  }

  /**
   * The installed trees that are missing or no longer match their hash.
   *
   * @returns the name and the problem of each.
   */
  verify(): Array<{ name: string; problem: string }> {
    const problems = this.installed().flatMap((entry) => {
      const path = join(this.dir, entry.path)
      if (!existsSync(path)) return [{ name: entry.name, problem: `its folder ${path} is missing` }]
      return treeHash(path) === entry.sha256 ? [] : [{ name: entry.name, problem: `its files in ${path} changed since it was installed` }]
    })
    this.broken = new Set(problems.map((problem) => problem.name))
    return problems
  }

  /**
   * The extensions a project may use: installed, and intact at the last `verify()`
   * (the plugin runs one at start; an install or update clears its name).
   *
   * @returns them by name.
   */
  usable(): Map<string, UsableExtension> {
    const usable = new Map<string, UsableExtension>()
    for (const entry of this.installed()) {
      if (this.broken.has(entry.name)) continue
      try {
        const manifest = this.manifestOf(entry.name)
        if (manifest !== undefined) usable.set(entry.name, { name: entry.name, dir: join(this.dir, entry.path), manifest })
      } catch {
        // A manifest that no longer reads is a tree that changed; verify() names it.
      }
    }
    return usable
  }

  /**
   * Clone an extension, pinned, and read its manifest. Nothing runs yet.
   *
   * @param source an `https://` URL or an absolute path to a repository.
   * @param ref a branch, tag or commit, or null for the default branch.
   * @returns the staged extension, waiting for `install`.
   * @throws {OpsError} `EXTENSION_INVALID` for a repository that cannot be read or a bad manifest.
   */
  async fetch(source: string, ref: string | null): Promise<StagedExtension> {
    // A fetch nobody confirmed within the hour is dropped.
    for (const [old, staged] of this.staged) if (staged.at < this.now() - 3_600_000) this.discard(old)
    const id = randomBytes(6).toString('hex')
    const dir = this.stagingOf(id)
    mkdirSync(join(this.dir, '.staging'), { recursive: true })
    try {
      const { repository, folder } = splitFolder(source)
      if (folder !== null && !FOLDER.test(folder)) throw new OpsError('EXTENSION_INVALID', `"${folder}" is not a folder of the repository.`)
      await this.git(['clone', '--quiet', '--no-checkout', '--', repository, dir])
      await this.git(['-C', dir, 'checkout', '--quiet', '--detach', ref ?? 'HEAD'])
      const commit = (await this.git(['-C', dir, 'rev-parse', 'HEAD'])).trim()
      // The tree is what was reviewed; its history and git's own files are not part of it.
      rmSync(join(dir, '.git'), { recursive: true, force: true })
      if (folder !== null) {
        // Only the extension's folder is kept: what is reviewed, run, hashed and installed.
        const inner = join(dir, folder)
        if (!existsSync(inner) || lstatSync(inner).isSymbolicLink() || !lstatSync(inner).isDirectory() || !isInside(dir, inner)) {
          throw new OpsError('EXTENSION_INVALID', `The repository has no folder ${folder}.`)
        }
        const whole = `${dir}.repository`
        renameSync(dir, whole)
        try {
          renameSync(join(whole, folder), dir)
        } finally {
          rmSync(whole, { recursive: true, force: true })
        }
      }
      const file = join(dir, 'extension.yaml')
      if (!existsSync(file)) throw new OpsError('EXTENSION_INVALID', `The repository has no extension.yaml ${folder === null ? 'at its root' : `in ${folder}`}.`)
      const manifest = parseManifest(parseYaml(readFileSync(file, 'utf8')))
      let installedManifest: ExtensionManifest | undefined
      try {
        installedManifest = this.manifestOf(manifest.name)
      } catch {
        installedManifest = undefined
      }
      const staged = { id, source, ref, commit, manifest, installed: this.get(manifest.name), installedManifest }
      this.staged.set(id, { ...staged, at: this.now() })
      return staged
    } catch (error) {
      rmSync(dir, { recursive: true, force: true })
      if (error instanceof OpsError) throw error
      const message = ((error as { stderr?: string }).stderr || (error as Error).message).trim().split('\n').slice(-3).join('\n')
      throw new OpsError('EXTENSION_INVALID', `Could not fetch ${source}${ref === null ? '' : `@${ref}`}: ${message}`)
    }
  }

  /** A staged extension, by its id. */
  stagedOf(id: string): StagedExtension | undefined {
    return this.staged.get(id)
  }

  /**
   * Run a staged extension's `install` commands confined to its folder, then install it:
   * read-only, recorded in the lock with its hash. An earlier version is removed.
   *
   * @param id the staging id.
   * @param by who confirmed it.
   * @returns the lock entry.
   * @throws {OpsError} `EXTENSION_NOT_FOUND` for an unknown id, `EXTENSION_INSTALL_FAILED`.
   */
  async install(id: string, by: string): Promise<ExtensionLock> {
    const staged = this.staged.get(id)
    if (staged === undefined) throw new OpsError('EXTENSION_NOT_FOUND', 'Nothing is waiting to be installed under that id; fetch it again with /ext install.')
    this.staged.delete(id)
    const dir = this.stagingOf(id)
    const { manifest } = staged
    try {
      const deadline = this.now() + INSTALL_TIMEOUT_MS
      for (const line of manifest.install) await this.runConfined(line, dir, deadline)
      const missing = manifest.skills.filter((path) => !existsSync(join(dir, path, 'SKILL.md')))
      if (missing.length > 0) throw new OpsError('EXTENSION_INSTALL_FAILED', `No SKILL.md in ${missing.join(', ')}.`)
      // A program it names must be a plain executable file of its own, not a link out.
      const programs = manifest.bin.filter((path) => {
        const full = join(dir, path)
        return !existsSync(full) || lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile() || (lstatSync(full).mode & 0o111) === 0
      })
      if (programs.length > 0) throw new OpsError('EXTENSION_INSTALL_FAILED', `Not an executable file of the extension: ${programs.join(', ')}.`)
      const names = manifest.bin.map((path) => path.split('/').pop() as string)
      if (new Set(names).size !== names.length) throw new OpsError('EXTENSION_INSTALL_FAILED', `Two programs in bin have the same name: ${manifest.bin.join(', ')}.`)
      // The folder a project's PATH gets: a link per program it names, and nothing else.
      if (manifest.bin.length > 0) {
        mkdirSync(join(dir, BIN_DIR))
        for (const path of manifest.bin) symlinkSync(join('..', path), join(dir, BIN_DIR, path.split('/').pop() as string))
      }
      const path = join(manifest.name, `${manifest.version}-${staged.commit.slice(0, 7)}`)
      const target = join(this.dir, path)
      if (existsSync(target)) throw new OpsError('EXTENSION_INSTALL_FAILED', `${manifest.name} ${manifest.version} at ${staged.commit.slice(0, 7)} is already installed.`)
      mkdirSync(join(this.dir, manifest.name), { recursive: true })
      // Moved first: moving a folder needs its write bit.
      renameSync(dir, target)
      readOnly(target)
      const entry: ExtensionLock = {
        name: manifest.name,
        version: manifest.version,
        source: staged.source,
        ref: staged.ref,
        commit: staged.commit,
        sha256: treeHash(target),
        path,
        installed_by: by,
        installed_at: this.now(),
      }
      const previous = this.get(manifest.name)
      this.broken.delete(manifest.name)
      this.writeLock([...this.installed().filter((other) => other.name !== manifest.name), entry])
      if (previous !== undefined && previous.path !== path) removeTree(join(this.dir, previous.path))
      return entry
    } finally {
      removeTree(dir)
    }
  }

  /** At start: what was being fetched or installed when the process stopped is dropped. */
  clearStaging(): void {
    removeTree(join(this.dir, '.staging'))
  }

  /** Drop a staged extension the admin did not confirm. */
  discard(id: string): void {
    this.staged.delete(id)
    removeTree(this.stagingOf(id))
  }

  /**
   * Uninstall an extension: its folder and its lock entry.
   *
   * @param name the extension.
   * @returns whether it was installed.
   */
  remove(name: string): boolean {
    const entry = this.get(name)
    if (entry === undefined) return false
    this.writeLock(this.installed().filter((other) => other.name !== name))
    removeTree(join(this.dir, name))
    return true
  }

  private stagingOf(id: string): string {
    return join(this.dir, '.staging', id)
  }

  private writeLock(entries: readonly ExtensionLock[]): void {
    mkdirSync(this.dir, { recursive: true })
    const file = join(this.dir, 'lock.yaml')
    const doc = { extensions: Object.fromEntries(entries.map(({ name, ...entry }) => [name, entry])) }
    writeFileSync(`${file}.tmp`, `# Written by Argus at /ext install, update and remove. Do not edit.\n${toYaml(doc)}`)
    renameSync(`${file}.tmp`, file)
  }

  /** git with no system or user configuration, and only https and local repositories. */
  private async git(args: string[]): Promise<string> {
    const { stdout } = await run('git', args, {
      cwd: this.dir,
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'https:file',
      },
    })
    return stdout
  }

  /** One `install` line, in the sandbox: it writes only in `dir`; the network is open. */
  private async runConfined(line: string, dir: string, deadline: number): Promise<void> {
    let argv: readonly string[]
    try {
      argv = await this.confine(['/bin/sh', '-c', line], dir)
    } catch (error) {
      throw new OpsError('EXTENSION_INSTALL_FAILED', `Not installed: the command sandbox is not available (${(error as Error).message}). Extensions install only confined.`)
    }
    const [command, ...args] = argv as [string, ...string[]]
    const out: string[] = []
    const code = await new Promise<number | string>((resolve) => {
      const child = spawn(command, args, { cwd: dir, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
      const keep = (chunk: Buffer): void => {
        out.push(chunk.toString())
        if (out.length > 200) out.splice(0, out.length - 200)
      }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(0, deadline - this.now()))
      child.on('error', (error) => resolve(error.message))
      child.on('close', (status, signal) => {
        clearTimeout(timer)
        resolve(status ?? signal ?? 'killed')
      })
    })
    if (code !== 0) {
      const tail = out.join('').trim().split('\n').slice(-8).join('\n')
      throw new OpsError('EXTENSION_INSTALL_FAILED', `Not installed: "${line}" failed (${code}).${tail.length > 0 ? `\n${tail}` : ''}`)
    }
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Take the write bit off every file and folder (not links: chmod would follow them). */
function readOnly(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) readOnly(path)
    chmodSync(path, stat.mode & ~0o222)
  }
  chmodSync(root, lstatSync(root).mode & ~0o222)
}

/** Remove a tree made read-only: its folders need their write bit back first. */
function removeTree(root: string): void {
  if (!existsSync(root)) return
  const writable = (dir: string): void => {
    chmodSync(dir, 0o755)
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (lstatSync(path).isDirectory()) writable(path)
    }
  }
  if (lstatSync(root).isDirectory()) writable(root)
  rmSync(root, { recursive: true, force: true })
}
