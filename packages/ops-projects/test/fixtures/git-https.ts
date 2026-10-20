// == ARGUS AGENT PROJECT ==
/**
 * A git server over HTTPS for tests: `git http-backend` behind Node, with a
 * self-signed certificate, Basic authentication, and a record of every request's
 * host and `Authorization` header. A path under `/redirect/` answers with a redirect
 * to a second server, which records what reaches it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttps, type Server } from 'node:https'
import { createServer as createHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What a test needs from the server. */
export interface GitHttps {
  /** `https://127.0.0.1:<port>`. */
  readonly base: string
  /** The CA file git must trust. */
  readonly caFile: string
  /** The folder the repositories live in (bare, `<name>.git`). */
  readonly root: string
  /** Every request: which server, which path, which Authorization header. */
  readonly seen: Array<{ server: 'git' | 'other'; path: string; auth: string | null }>
  /** The URL of a path that redirects to the other server. */
  redirect(path: string): string
  /** Make a bare repository with one commit on main. */
  repo(name: string): string
  close(): Promise<void>
}

/** git, with no user or system config. */
export function git(args: readonly string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

/**
 * Start the server.
 *
 * @param token the token it accepts, as the password of any user.
 */
export async function startGitHttps(token: string): Promise<GitHttps> {
  const root = mkdtempSync(join(tmpdir(), 'git-https-'))
  const key = join(root, 'key.pem')
  const cert = join(root, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  const backend = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  const seen: GitHttps['seen'] = []

  const other = createHttp((req, res) => {
    seen.push({ server: 'other', path: req.url ?? '', auth: req.headers.authorization ?? null })
    res.writeHead(404).end()
  })
  await new Promise<void>((ok) => other.listen(0, '127.0.0.1', ok))
  const otherPort = (other.address() as { port: number }).port

  const server: Server = createHttps({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://x')
    const auth = req.headers.authorization ?? null
    seen.push({ server: 'git', path: url.pathname, auth })
    if (url.pathname.startsWith('/redirect/')) {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}${url.pathname.replace('/redirect', '')}${url.search}` }).end()
      return
    }
    const password = auth?.startsWith('Basic ') === true ? Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':') : undefined
    if (password !== token) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end()
      return
    }
    // CGI: the request in the environment and on stdin, the answer's headers then body on stdout.
    const cgi = spawn(join(backend, 'git-http-backend'), [], {
      env: {
        PATH: process.env['PATH'] ?? '',
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        REMOTE_USER: 'test',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['content-encoding'] === undefined ? {} : { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) }),
        ...(req.headers['git-protocol'] === undefined ? {} : { GIT_PROTOCOL: String(req.headers['git-protocol']) }),
      },
    })
    req.pipe(cgi.stdin)
    let head = Buffer.alloc(0)
    let started = false
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (started) return void res.write(chunk)
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      started = true
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':')
        const name = line.slice(0, colon).trim()
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
        else headers[name] = value
      }
      res.writeHead(status, headers)
      res.write(head.subarray(end + 4))
    })
    cgi.stdout.on('end', () => res.end())
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const base = `https://127.0.0.1:${(server.address() as { port: number }).port}`

  return {
    base,
    caFile: cert,
    root,
    seen,
    redirect: (path) => `${base}/redirect${path}`,
    repo(name) {
      const bare = join(root, `${name}.git`)
      git(['init', '-q', '--bare', '-b', 'main', bare])
      git(['config', 'http.receivepack', 'true'], bare)
      const work = mkdtempSync(join(tmpdir(), 'git-seed-'))
      git(['init', '-q', '-b', 'main', work])
      writeFileSync(join(work, 'README.md'), '# site\n')
      git(['add', '-A'], work)
      git(['commit', '-q', '-m', 'first'], work)
      git(['push', '-q', bare, 'main'], work)
      return bare
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise((ok) => server.close(ok))
      await new Promise((ok) => other.close(ok))
    },
  }
}
