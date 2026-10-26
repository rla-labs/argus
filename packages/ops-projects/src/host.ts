// == ARGUS AGENT PROJECT ==
/**
 * The host channel: how an extension's MCP server speaks to Argus while it works.
 *
 * A server whose manifest declares `host: [approvals, steps, usage]` gets a Unix socket
 * of its own (`ARGUS_HOST_SOCKET`) and a secret (`ARGUS_HOST_TOKEN`). The socket's folder
 * has a random name, made afresh each time the server starts, and is the only one of its
 * kind the server's confinement may read; the secret is in the server's environment only,
 * which another confined process cannot read. The first message must be `hello` with that
 * secret, so a process that learns the socket's path (it is listed in /proc/net/unix)
 * still cannot speak on it.
 *
 * Who is speaking comes from the socket, never from a message (rule 6): a message on
 * `site`'s socket is `site`'s, and its run is `site`'s run in progress. Messages are one
 * JSON object per line, each with an `id` its answer carries back. This module owns only
 * the transport: what `ask`, `step` and `usage` do is registered by the plugins that own
 * those decisions ({@link HostChannel.handle}).
 *
 * @module @argus-agent/projects/host
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { HostCapability } from '@argus-agent/types'

/** The largest message, newline included. A longer line closes the connection. */
export const HOST_MESSAGE_MAX_BYTES = 64 * 1024
/** Messages one connection may send in a second; past it, each is refused. */
export const HOST_MESSAGES_PER_SECOND = 50
/** How long a new connection waits for the previous one to end before it is refused. */
const HANDOVER_MS = 1_000
/** A socket path the kernel accepts (`sun_path` is 108 bytes, with its terminator). */
const SOCKET_PATH_MAX = 107

/** The capability a message type needs; `hello` needs none. */
const NEEDS: Readonly<Record<string, HostCapability>> = { ask: 'approvals', step: 'steps', usage: 'usage' }

/** One message from a server, as a handler receives it. */
export interface HostCall {
  /** The project, from the socket. */
  readonly projectId: string
  /** The server's name in that project. */
  readonly server: string
  /** The project's run in progress. */
  readonly runId: string
  /** The message as sent; its `type` chose the handler. Never a source of identity. */
  readonly message: Readonly<Record<string, unknown>>
}

/** What a handler answers: fields added to `{ id, ok: true }`. */
export type HostHandler = (call: HostCall) => Promise<Record<string, unknown>> | Record<string, unknown>

/** An error a handler throws to answer `ok: false` with this code. */
export class HostRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Where a server's channel is, for its confinement and its environment. */
export interface HostEndpoint {
  /** The folder to grant (read only): it holds the socket and nothing else. */
  readonly dir: string
  /** `ARGUS_HOST_SOCKET`. */
  readonly socket: string
  /** `ARGUS_HOST_TOKEN`. */
  readonly token: string
}

interface Open {
  readonly projectId: string
  readonly server: string
  readonly host: readonly HostCapability[]
  readonly endpoint: HostEndpoint
  readonly listener: Server
  connection: Socket | undefined
}

/** The channels of every server that has one. */
export class HostChannel {
  private readonly handlers = new Map<string, HostHandler>()
  private readonly open = new Map<string, Open>()

  /**
   * @param root where the sockets' folders go (`state/h`).
   * @param runOf the project's run in progress, or undefined.
   * @param warn where a refused connection or a broken handler is logged.
   * @param greeting what `hello` answers besides who the server is: its limits.
   */
  constructor(
    private readonly root: string,
    private readonly runOf: (projectId: string) => string | undefined,
    private readonly warn: (message: string) => void = () => {},
    private readonly greeting: (projectId: string, server: string) => Record<string, unknown> = () => ({}),
  ) {}

  /**
   * Answer one message type. The plugin that owns the decision registers it, as an
   * effect of its own, so it goes when that plugin unloads.
   *
   * @param type `ask`, `step` or `usage`.
   * @param handler what answers it.
   * @returns what removes it.
   * @throws {Error} for an unknown type, or one already answered.
   */
  handle(type: string, handler: HostHandler): () => void {
    if (!(type in NEEDS)) throw new Error(`no host message type ${type}`)
    if (this.handlers.has(type)) throw new Error(`host messages of type ${type} are already answered`)
    this.handlers.set(type, handler)
    return () => {
      if (this.handlers.get(type) === handler) this.handlers.delete(type)
    }
  }

  /**
   * Open a server's channel: a fresh folder with a random name, its socket, a secret.
   * Opening it again closes the previous one first.
   *
   * @param projectId the project.
   * @param server the server's name.
   * @param host what it declared in `host:`.
   * @returns where it is.
   * @throws {Error} when the socket cannot be made (its path too long, the folder not writable).
   */
  async start(projectId: string, server: string, host: readonly HostCapability[]): Promise<HostEndpoint> {
    this.close(projectId, server)
    const dir = join(this.root, randomBytes(12).toString('hex'))
    const socket = join(dir, 's')
    if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) throw new Error(`the host socket's path is too long (${socket})`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const endpoint: HostEndpoint = { dir, socket, token: randomBytes(24).toString('hex') }
    const listener = createServer()
    const entry: Open = { projectId, server, host: [...host], endpoint, listener, connection: undefined }
    listener.on('connection', (connection) => this.accept(entry, connection))
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(socket, () => {
        listener.off('error', reject)
        resolve()
      })
    })
    chmodSync(socket, 0o600)
    this.open.set(keyOf(projectId, server), entry)
    return endpoint
  }

  /**
   * Close a server's channel and remove its folder.
   *
   * @param projectId the project.
   * @param server the server's name.
   */
  close(projectId: string, server: string): void {
    const entry = this.open.get(keyOf(projectId, server))
    if (entry === undefined) return
    this.open.delete(keyOf(projectId, server))
    entry.connection?.destroy()
    entry.listener.close()
    rmSync(entry.endpoint.dir, { recursive: true, force: true })
  }

  /** Close every channel: the plugin unloads. */
  closeAll(): void {
    for (const entry of this.open.values()) this.close(entry.projectId, entry.server)
  }

  /**
   * Tell every connected server of a project to stop what it is doing (cancel, a limit,
   * a loop, the run's end).
   *
   * @param projectId the project.
   * @param reason why, as the server will report it.
   * @returns how many servers were told.
   */
  stop(projectId: string, reason: string): number {
    let told = 0
    for (const entry of this.open.values()) {
      if (entry.projectId !== projectId || entry.connection === undefined) continue
      entry.connection.write(`${JSON.stringify({ type: 'stop', reason })}\n`)
      told += 1
    }
    return told
  }

  /** The endpoint of an open channel, for tests and `/mcp` status. */
  endpointOf(projectId: string, server: string): HostEndpoint | undefined {
    return this.open.get(keyOf(projectId, server))?.endpoint
  }

  private accept(entry: Open, connection: Socket): void {
    // One connection at a time: a second one is refused while the first keeps going. A
    // server that hangs up and reconnects at once may be seen before its hang-up is: the
    // new one waits a moment for the old one to end.
    const previous = entry.connection
    if (previous !== undefined && !previous.destroyed && !previous.readableEnded) {
      const timer = setTimeout(() => {
        previous.off('end', retry)
        previous.off('close', retry)
        connection.end(`${JSON.stringify({ ok: false, error: { code: 'HOST_MESSAGE_REFUSED', message: 'this channel already has a connection' } })}\n`)
      }, HANDOVER_MS)
      const retry = (): void => {
        clearTimeout(timer)
        previous.off('end', retry)
        previous.off('close', retry)
        if (entry.connection === previous) entry.connection = undefined
        if (!connection.destroyed) this.accept(entry, connection)
      }
      previous.once('end', retry)
      previous.once('close', retry)
      return
    }
    entry.connection = connection
    let greeted = false
    let buffer = ''
    let second = 0
    let inSecond = 0
    const answer = (value: Record<string, unknown>): void => {
      if (!connection.destroyed) connection.write(`${JSON.stringify(value)}\n`)
    }
    const refuse = (id: unknown, code: string, message: string): void => answer({ ...(id === undefined ? {} : { id }), ok: false, error: { code, message } })
    connection.setEncoding('utf8')
    // The place is free as soon as the server hangs up ('end'), not only once the socket
    // is torn down ('close'): a server that reconnects at once is not refused.
    const release = (): void => {
      if (entry.connection === connection) entry.connection = undefined
    }
    connection.on('end', release)
    connection.on('close', release)
    connection.on('error', () => {})
    connection.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      if (newline === -1 && Buffer.byteLength(buffer) > HOST_MESSAGE_MAX_BYTES) {
        refuse(undefined, 'HOST_MESSAGE_REFUSED', `a message is at most ${HOST_MESSAGE_MAX_BYTES} bytes`)
        connection.destroy()
        return
      }
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim() === '') continue
        const now = Math.floor(Date.now() / 1000)
        if (now !== second) {
          second = now
          inSecond = 0
        }
        inSecond += 1
        let message: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(line)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
          message = parsed as Record<string, unknown>
        } catch {
          refuse(undefined, 'HOST_MESSAGE_REFUSED', 'each line is one JSON object')
          continue
        }
        const id = message['id']
        if (Buffer.byteLength(line) + 1 > HOST_MESSAGE_MAX_BYTES) {
          refuse(id, 'HOST_MESSAGE_REFUSED', `a message is at most ${HOST_MESSAGE_MAX_BYTES} bytes`)
          continue
        }
        if (inSecond > HOST_MESSAGES_PER_SECOND) {
          refuse(id, 'HOST_MESSAGE_REFUSED', `at most ${HOST_MESSAGES_PER_SECOND} messages a second`)
          continue
        }
        if (!greeted) {
          if (message['type'] !== 'hello' || !sameSecret(message['token'], entry.endpoint.token)) {
            refuse(id, 'HOST_MESSAGE_REFUSED', 'the first message is hello, with ARGUS_HOST_TOKEN')
            this.warn(`project ${entry.projectId}: a connection to the host channel of ${entry.server} did not present its secret; closed`)
            connection.destroy()
            return
          }
          greeted = true
          answer({ ...this.greeting(entry.projectId, entry.server), ...(id === undefined ? {} : { id }), ok: true, project: entry.projectId, server: entry.server, host: entry.host })
          continue
        }
        void this.dispatch(entry, id, message).then(answer)
      }
    })
  }

  private async dispatch(entry: Open, id: unknown, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const head = id === undefined ? {} : { id }
    const refused = (code: string, text: string): Record<string, unknown> => ({ ...head, ok: false, error: { code, message: text } })
    const type = message['type']
    if (type === 'hello') return { ...this.greeting(entry.projectId, entry.server), ...head, ok: true, project: entry.projectId, server: entry.server, host: entry.host }
    const needs = typeof type === 'string' ? NEEDS[type] : undefined
    if (needs === undefined) return refused('HOST_MESSAGE_REFUSED', `unknown message type ${String(type)}`)
    if (!entry.host.includes(needs)) return refused('HOST_MESSAGE_REFUSED', `${String(type)} needs host: [${needs}], which ${entry.server} did not declare`)
    const handler = this.handlers.get(type as string)
    if (handler === undefined) return refused('HOST_MESSAGE_REFUSED', `${String(type)} is not available`)
    const runId = this.runOf(entry.projectId)
    if (runId === undefined) return refused('HOST_NO_RUN', `${entry.projectId} has no run in progress`)
    try {
      return { ...(await handler({ projectId: entry.projectId, server: entry.server, runId, message })), ...head, ok: true }
    } catch (error) {
      if (error instanceof HostRefusal) return refused(error.code, error.message)
      this.warn(`project ${entry.projectId}: the host message ${String(type)} from ${entry.server} failed: ${(error as Error).message}`)
      return refused('INTERNAL', 'Argus could not answer this message')
    }
  }
}

function keyOf(projectId: string, server: string): string {
  return `${projectId}\u0000${server}`
}

function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
