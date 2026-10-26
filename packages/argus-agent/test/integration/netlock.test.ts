// == ARGUS AGENT PROJECT ==
/**
 * `network: proxy`: a command confined with a proxy port reaches that port only over TCP,
 * opens no UDP socket, and still reads and writes as the filesystem rules allow.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ArgusSandbox from '../../src/sandbox-row.js'

const sandbox = new ArgusSandbox(new Context())
const dirs: string[] = []
const servers: Server[] = []
afterAll(() => {
  for (const server of servers) server.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function listening(): Promise<number> {
  const server = createServer((socket) => socket.end('hi'))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

/** What a confined Node sees: each port's connect, and a UDP socket. */
const PROBE = `
const net = require('net'), dgram = require('dgram')
const tryc = (p) => new Promise((r) => { const s = net.connect(Number(p), '127.0.0.1'); s.on('connect', () => { s.destroy(); r('ok') }); s.on('error', (e) => r(e.code)) })
;(async () => {
  const out = {}
  for (const p of process.argv.slice(1)) out[p] = await tryc(p)
  const u = dgram.createSocket('udp4')
  out.udp = await new Promise((r) => { u.on('error', (e) => r(e.code)); u.bind(0, () => r('bound')) })
  console.log(JSON.stringify(out)); process.exit(0)
})()`

describe.skipIf(!sandbox.canLockNetwork())('network: proxy', () => {
  it('lets a confined command connect to the proxy’s port only, and open no UDP socket', async () => {
    const proxy = await listening()
    const other = await listening()
    const root = mkdtempSync(join(tmpdir(), 'netlock-'))
    dirs.push(root)
    const locked = await sandbox.confineReading([process.execPath, '-e', PROBE, String(proxy), String(other)], { mode: 'workspace-write', workspaceRoot: root }, [], undefined, { proxyPort: proxy })
    expect(JSON.parse(execFileSync(locked.argv[0] as string, locked.argv.slice(1), { cwd: root, encoding: 'utf8' }))).toEqual({ [proxy]: 'ok', [other]: 'EACCES', udp: 'EACCES' })
    // Without it, the same command has the network.
    const open = await sandbox.confineReading([process.execPath, '-e', PROBE, String(proxy), String(other)], { mode: 'workspace-write', workspaceRoot: root }, [])
    expect(JSON.parse(execFileSync(open.argv[0] as string, open.argv.slice(1), { cwd: root, encoding: 'utf8' }))).toEqual({ [proxy]: 'ok', [other]: 'ok', udp: 'bound' })
    expect(sandbox.doctor()).toContainEqual(expect.objectContaining({ check: 'network: proxy', ok: true }))
  })
})
