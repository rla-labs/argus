// == ARGUS AGENT PROJECT ==
/**
 * The host channel's transport: the secret first, identity from the socket, messages
 * a server did not declare or cannot send refused, its limits, stop and close.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_MESSAGE_MAX_BYTES, HOST_MESSAGES_PER_SECOND, HostChannel, HostRefusal, type HostCall } from '../../src/host.js'

const roots: string[] = []
const channels: HostChannel[] = []

afterEach(() => {
  for (const channel of channels.splice(0)) channel.closeAll()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function channel(runs: Record<string, string> = { site: 'run-1' }): { host: HostChannel; warnings: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'h-'))
  roots.push(root)
  const warnings: string[] = []
  const host = new HostChannel(root, (projectId) => runs[projectId], (message) => warnings.push(message))
  channels.push(host)
  return { host, warnings }
}

/** A client that sends lines and collects the answers, one per line. */
async function client(socket: string): Promise<{ send(value: unknown): void; raw(text: string): void; next(): Promise<Record<string, unknown>>; closed: Promise<void>; socket: Socket }> {
  const conn = connect(socket)
  await new Promise<void>((resolve, reject) => conn.once('connect', resolve).once('error', reject))
  conn.setEncoding('utf8')
  const lines: Record<string, unknown>[] = []
  const waiting: ((value: Record<string, unknown>) => void)[] = []
  let buffer = ''
  conn.on('data', (chunk: string) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at !== -1) {
      const value = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
      const resolve = waiting.shift()
      if (resolve === undefined) lines.push(value)
      else resolve(value)
    }
  })
  const closed = new Promise<void>((resolve) => conn.once('close', () => resolve()))
  return {
    send: (value) => conn.write(`${JSON.stringify(value)}\n`),
    raw: (text) => conn.write(text),
    next: () => (lines.length > 0 ? Promise.resolve(lines.shift()!) : new Promise((resolve) => waiting.push(resolve))),
    closed,
    socket: conn,
  }
}

describe('the host channel', () => {
  it('takes hello with the secret first, then answers from the socket’s project and run, whatever the message claims', async () => {
    const { host } = channel()
    const calls: HostCall[] = []
    host.handle('ask', (call) => {
      calls.push(call)
      return { decision: 'allow' }
    })
    const endpoint = await host.start('site', 'cc', ['approvals'])
    expect(endpoint.socket.length).toBeLessThan(108)
    const c = await client(endpoint.socket)
    c.send({ id: 1, type: 'hello', token: endpoint.token })
    expect(await c.next()).toEqual({ id: 1, ok: true, project: 'site', server: 'cc', host: ['approvals'] })
    c.send({ id: 2, type: 'ask', project: 'beta', run: 'run-9', tool: 'Bash' })
    expect(await c.next()).toEqual({ id: 2, ok: true, decision: 'allow' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ projectId: 'site', server: 'cc', runId: 'run-1' })
    expect(calls[0]?.message['project']).toBe('beta')
  })

  it('closes a connection whose first message is not hello with the secret', async () => {
    const { host, warnings } = channel()
    const endpoint = await host.start('site', 'cc', ['approvals'])
    for (const first of [{ id: 1, type: 'ask' }, { id: 1, type: 'hello', token: 'guess' }, { id: 1, type: 'hello' }]) {
      const c = await client(endpoint.socket)
      c.send(first)
      expect(await c.next()).toMatchObject({ ok: false, error: { code: 'HOST_MESSAGE_REFUSED' } })
      await c.closed
    }
    expect(warnings.join('\n')).toContain('did not present its secret')
  })

  it('refuses a type the server did not declare, an unknown type, one nobody answers, and anything outside a run', async () => {
    const runs: Record<string, string> = {}
    const { host } = channel(runs)
    host.handle('ask', () => ({ decision: 'allow' }))
    const endpoint = await host.start('site', 'cc', ['approvals', 'steps'])
    const c = await client(endpoint.socket)
    c.send({ id: 0, type: 'hello', token: endpoint.token })
    await c.next()
    c.send({ id: 1, type: 'usage' })
    expect(await c.next()).toMatchObject({ id: 1, ok: false, error: { code: 'HOST_MESSAGE_REFUSED', message: expect.stringContaining('host: [usage]') } })
    c.send({ id: 2, type: 'format-disk' })
    expect(await c.next()).toMatchObject({ id: 2, ok: false, error: { code: 'HOST_MESSAGE_REFUSED', message: expect.stringContaining('unknown') } })
    c.send({ id: 3, type: 'step' })
    expect(await c.next()).toMatchObject({ id: 3, ok: false, error: { code: 'HOST_MESSAGE_REFUSED', message: expect.stringContaining('not available') } })
    c.send({ id: 4, type: 'ask' })
    expect(await c.next()).toMatchObject({ id: 4, ok: false, error: { code: 'HOST_NO_RUN' } })
    runs['site'] = 'run-2'
    c.send({ id: 5, type: 'ask' })
    expect(await c.next()).toEqual({ id: 5, ok: true, decision: 'allow' })
  })

  it('answers a handler’s refusal with its code, and a broken handler with INTERNAL, logged', async () => {
    const { host, warnings } = channel()
    host.handle('ask', () => {
      throw new HostRefusal('DELEGATED_LIMIT', 'the day’s turns are used up')
    })
    host.handle('step', () => {
      throw new Error('boom')
    })
    const endpoint = await host.start('site', 'cc', ['approvals', 'steps'])
    const c = await client(endpoint.socket)
    c.send({ id: 0, type: 'hello', token: endpoint.token })
    await c.next()
    c.send({ id: 1, type: 'ask' })
    expect(await c.next()).toEqual({ id: 1, ok: false, error: { code: 'DELEGATED_LIMIT', message: 'the day’s turns are used up' } })
    c.send({ id: 2, type: 'step' })
    expect(await c.next()).toMatchObject({ id: 2, ok: false, error: { code: 'INTERNAL' } })
    expect(warnings.join('\n')).toContain('boom')
  })

  it('refuses a line that is not a JSON object, over the rate, and closes on one too long', async () => {
    const { host } = channel()
    host.handle('ask', () => ({}))
    const endpoint = await host.start('site', 'cc', ['approvals'])
    const c = await client(endpoint.socket)
    c.send({ id: 0, type: 'hello', token: endpoint.token })
    await c.next()
    c.raw('[1,2]\n')
    expect(await c.next()).toMatchObject({ ok: false, error: { message: expect.stringContaining('JSON object') } })
    for (let i = 0; i < HOST_MESSAGES_PER_SECOND + 5; i++) c.send({ id: i, type: 'ask' })
    const answers = await Promise.all(Array.from({ length: HOST_MESSAGES_PER_SECOND + 5 }, () => c.next()))
    // The second may turn while they arrive: at least the five over the limit, most often.
    expect(answers.filter((a) => a['ok'] === false).length).toBeGreaterThan(0)
    c.raw('x'.repeat(HOST_MESSAGE_MAX_BYTES + 10))
    expect(await c.next()).toMatchObject({ ok: false, error: { message: expect.stringContaining('at most') } })
    await c.closed
  })

  it('takes one connection at a time', async () => {
    const { host } = channel()
    const endpoint = await host.start('site', 'cc', [])
    const first = await client(endpoint.socket)
    first.send({ id: 0, type: 'hello', token: endpoint.token })
    expect(await first.next()).toMatchObject({ ok: true })
    const second = await client(endpoint.socket)
    expect(await second.next()).toMatchObject({ ok: false, error: { message: expect.stringContaining('already') } })
    await second.closed
    first.send({ id: 1, type: 'hello', token: endpoint.token })
    expect(await first.next()).toMatchObject({ id: 1, ok: true })
  })

  it('takes a new connection as soon as the previous one hung up', async () => {
    const { host } = channel()
    const endpoint = await host.start('site', 'cc', [])
    for (let round = 0; round < 20; round++) {
      const c = await client(endpoint.socket)
      c.send({ id: round, type: 'hello', token: endpoint.token })
      expect(await c.next()).toMatchObject({ id: round, ok: true })
      c.socket.end()
    }
  })

  it('tells a project’s connected servers to stop, and closing removes the folder; a restart gets a new place and secret', async () => {
    const { host } = channel()
    const site = await host.start('site', 'cc', [])
    const other = await host.start('other', 'cc', [])
    const a = await client(site.socket)
    a.send({ type: 'hello', token: site.token })
    await a.next()
    const b = await client(other.socket)
    b.send({ type: 'hello', token: other.token })
    await b.next()
    expect(host.stop('site', 'cancelled')).toBe(1)
    expect(await a.next()).toEqual({ type: 'stop', reason: 'cancelled' })
    const again = await host.start('site', 'cc', [])
    expect(existsSync(site.dir)).toBe(false)
    expect(again.dir).not.toBe(site.dir)
    expect(again.token).not.toBe(site.token)
    await a.closed
    host.close('site', 'cc')
    expect(existsSync(again.dir)).toBe(false)
  })

  it('answers hello with what the greeting adds: the limits the server enforces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'h-'))
    roots.push(root)
    const host = new HostChannel(root, () => undefined, () => {}, (projectId, server) => ({ limits: { max_turns: 7 }, for: `${projectId}/${server}`, project: 'forged' }))
    channels.push(host)
    const endpoint = await host.start('site', 'cc', [])
    const c = await client(endpoint.socket)
    c.send({ id: 1, type: 'hello', token: endpoint.token })
    // The greeting cannot change who the server is.
    expect(await c.next()).toEqual({ id: 1, ok: true, project: 'site', server: 'cc', host: [], limits: { max_turns: 7 }, for: 'site/cc' })
  })

  it('lets one handler answer each type, until it is removed', () => {
    const { host } = channel()
    const remove = host.handle('ask', () => ({}))
    expect(() => host.handle('ask', () => ({}))).toThrow(/already/)
    expect(() => host.handle('hello', () => ({}))).toThrow(/no host message type/)
    remove()
    expect(() => host.handle('ask', () => ({}))).not.toThrow()
  })
})
