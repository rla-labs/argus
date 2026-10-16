// == ARGUS AGENT PROJECT ==
// An extension's MCP server, for the confinement test: `probe` writes a file in its
// working directory (the project's folder) and tries to read the path it is given.
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const attempt = (fn) => {
  try {
    return String(fn())
  } catch (error) {
    return `refused (${error.code ?? error.message})`
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } } })
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [{ name: 'probe', description: 'Write here, read there', inputSchema: { type: 'object', properties: { read: { type: 'string' } }, required: ['read'] } }] } })
  } else if (method === 'tools/call') {
    const wrote = attempt(() => (writeFileSync('made-by-extension.txt', 'ok'), 'wrote'))
    const read = attempt(() => readFileSync(params.arguments.read, 'utf8'))
    send({ id, result: { content: [{ type: 'text', text: `${wrote}; read: ${read}; secret: ${process.env.PROBE_KEY ?? 'none'}` }] } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else {
    send({ id, error: { code: -32601, message: `no method ${method}` } })
  }
}
