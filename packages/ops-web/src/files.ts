// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/files` — large files through the web: an upload streamed into a
 * project's `inbox/`, a project folder as a zip, and one-time download links for a
 * file too big for a chat.
 *
 * Argus writes and reads here with its own rights, in a folder the agent controls, so
 * every path is checked against the project's folder after symlinks are resolved: an
 * agent cannot turn `inbox` into a link to the data directory, or have a link it made
 * served. The zip runs confined, read-only.
 *
 * @module @argus-agent/web/files
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { isInside } from '@argus-agent/types'

/** What a project's zip leaves out: large and rebuilt, as the snapshots do. */
export const ZIP_SKIPPED = ['node_modules', '.venv', 'dist']

/** Disk left free after an upload, so the server does not fill up. */
const DISK_MARGIN = 512 * 1024 * 1024

/** Why a file operation was refused, for the browser. */
export class FileRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * A name a browser sent, made safe to write: its last component only, plain
 * characters, never hidden or empty.
 */
export function uploadName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/^[.\s]+/, '').slice(0, 120)
  return cleaned.length === 0 ? 'upload' : cleaned
}

/**
 * Stream a request's body into `<cwd>/inbox/<name>`.
 *
 * The body is written to a fresh, exclusive file (`O_EXCL | O_NOFOLLOW`) in the real
 * inbox, which must be inside the project's folder, then renamed; an existing name
 * gets ` (2)`, ` (3)`… Nothing is written when the declared length is over the limit
 * or over the free space, and a body that turns out longer is cut and removed.
 *
 * @param request the request.
 * @param cwd the project's folder.
 * @param name the file's name as the browser gave it.
 * @param maxBytes the largest upload.
 * @returns the saved file, relative to the project's folder, and its size.
 * @throws {FileRefusal} with the HTTP status to answer.
 */
export async function receiveUpload(request: IncomingMessage, cwd: string, name: string, maxBytes: number): Promise<{ path: string; bytes: number }> {
  const declared = Number(request.headers['content-length'])
  if (!Number.isFinite(declared) || declared < 0) throw new FileRefusal(411, 'the upload needs its length')
  if (declared > maxBytes) throw new FileRefusal(413, `larger than the ${Math.round(maxBytes / 1048576)} MB an upload may be (web.max_upload_mb)`)
  mkdirSync(cwd, { recursive: true })
  const inbox = join(cwd, 'inbox')
  if (!existsSync(inbox)) mkdirSync(inbox)
  if (lstatSync(inbox).isSymbolicLink() || !lstatSync(inbox).isDirectory() || !isInside(cwd, inbox)) throw new FileRefusal(409, 'the project\'s inbox is not a folder inside it')
  const real = realpathSync(inbox)
  const free = statfsSync(real)
  if (declared + DISK_MARGIN > free.bavail * free.bsize) throw new FileRefusal(507, 'not enough free disk for it')

  const temp = join(real, `.upload-${randomUUID()}.part`)
  // ponytail: the inbox is checked once, then written by its real path; an agent swapping
  // a parent folder for a link in the same instant could redirect it. An openat-style
  // directory handle would close that, and Node has none.
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  let bytes = 0
  try {
    for await (const chunk of request) {
      bytes += (chunk as Buffer).length
      if (bytes > declared || bytes > maxBytes) throw new FileRefusal(413, 'the upload is longer than it said')
      writeSync(fd, chunk as Buffer)
    }
    closeSync(fd)
    if (bytes !== declared) throw new FileRefusal(400, 'the upload was cut short')
  } catch (error) {
    try {
      closeSync(fd)
    } catch {
      // Already closed.
    }
    rmSync(temp, { force: true })
    throw error
  }
  const wanted = uploadName(name)
  const stem = wanted.slice(0, wanted.length - extname(wanted).length)
  let final = join(real, wanted)
  for (let n = 2; existsSync(final); n += 1) final = join(real, `${stem} (${n})${extname(wanted)}`)
  renameSync(temp, final)
  return { path: join('inbox', basename(final)), bytes }
}

/**
 * Send a folder of a project as a zip. zip runs confined: the project read-only, and
 * only a fresh folder of its own writable, where it writes the archive (some builds
 * refuse to write a stored entry, a symlink for one, to a pipe). Symlinks stay links
 * (`-y`), the skipped folders are left out, and the archive is deleted once sent.
 *
 * @param response the response, not yet written.
 * @param cwd the project's folder.
 * @param path the folder, relative to it (`.` for all of it).
 * @param confine the command sandbox: `root` writable, `reads` read-only.
 * @param fileName the archive's name.
 * @param scratch where the archive's folder is made.
 * @throws {FileRefusal} for a path outside the project or not a folder, or a zip that failed.
 */
export async function sendZip(
  response: ServerResponse,
  cwd: string,
  path: string,
  confine: (argv: readonly string[], root: string, reads: readonly string[]) => Promise<readonly string[]>,
  fileName: string,
  scratch: string,
): Promise<void> {
  if (isAbsolute(path) || normalize(path).split(sep).includes('..')) throw new FileRefusal(400, 'a folder inside the project, relative to it')
  const target = resolve(cwd, path)
  if (!existsSync(target) || !statSync(target).isDirectory() || !isInside(cwd, target)) throw new FileRefusal(404, 'no such folder in the project')
  const member = path === '.' || path === '' ? '.' : `./${normalize(path)}`
  const excluded = ZIP_SKIPPED.flatMap((name) => [`${name}/*`, `*/${name}/*`])
  const dir = join(scratch, randomUUID())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const archive = join(dir, 'archive.zip')
  try {
    const argv = await confine(['zip', '-r', '-q', '-y', archive, member, '-x', ...excluded], dir, [cwd])
    const errors = await new Promise<string | undefined>((done) => {
      const child = spawn(argv[0] as string, argv.slice(1), { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
      let text = ''
      child.stderr.on('data', (chunk: Buffer) => {
        text = `${text}${chunk.toString()}`.slice(-2000)
      })
      child.on('error', (error) => done(error.message))
      child.on('close', (code) => done(code === 0 ? undefined : text.trim() || `zip exited ${code}`))
    })
    if (errors !== undefined || !existsSync(archive)) throw new FileRefusal(500, `the zip could not be made: ${errors ?? 'no archive'}`)
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(statSync(archive).size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'cache-control': 'no-store',
    })
    await new Promise<void>((done) => {
      const stream = createReadStream(archive)
      stream.on('close', () => done())
      stream.pipe(response)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A file waiting at a one-time link. */
interface Pending {
  readonly path: string
  readonly name: string
  /** Made for the link (a zip), so deleted when taken or expired. */
  readonly owned: boolean
  readonly expires: number
}

/**
 * One-time download links. A link needs a web session to open, works once, and
 * expires; a file made for it lives in `dir` until then.
 */
export class DownloadLinks {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    // Files a previous run made for links it can no longer serve.
    rmSync(dir, { recursive: true, force: true })
  }

  /**
   * Make a link for a file.
   *
   * @param path the file: a project's (served if it is still the same regular file), or one to take over.
   * @param name the name the browser saves it as.
   * @param take move the file here (a zip made for this), rather than serve it in place.
   * @returns the token.
   */
  create(path: string, name: string, take = false): string {
    this.expire()
    const token = randomBytes(24).toString('base64url')
    let served = realpathSync(path)
    if (take) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      served = join(this.dir, `${token}${extname(name)}`)
      renameSync(path, served)
    }
    this.pending.set(token, { path: served, name, owned: take, expires: this.now() + this.ttlMs })
    return token
  }

  /**
   * Use a link: the file, once.
   *
   * @returns the file and its name, or `undefined` for an unknown, used or expired link.
   */
  take(token: string): { path: string; name: string; owned: boolean } | undefined {
    this.expire()
    const entry = this.pending.get(token)
    if (entry === undefined) return undefined
    this.pending.delete(token)
    // A project's file must still be a regular file, not swapped for a link.
    if (!existsSync(entry.path) || lstatSync(entry.path).isSymbolicLink() || !lstatSync(entry.path).isFile()) return undefined
    return entry
  }

  /** Serve a taken link's file, deleting it afterwards when it was made for the link. */
  serve(response: ServerResponse, file: { path: string; name: string; owned: boolean }): void {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(statSync(file.path).size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'no-store',
    })
    const stream = createReadStream(file.path)
    stream.pipe(response)
    stream.on('close', () => {
      if (file.owned) rmSync(file.path, { force: true })
    })
  }

  /** Drop expired links and their files. */
  expire(): void {
    const now = this.now()
    for (const [token, entry] of this.pending) {
      if (entry.expires > now) continue
      this.pending.delete(token)
      if (entry.owned) rmSync(entry.path, { force: true })
    }
  }
}
