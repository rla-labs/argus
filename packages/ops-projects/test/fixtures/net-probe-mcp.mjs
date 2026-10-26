// == ARGUS AGENT PROJECT ==
// An extension's MCP server with `network: proxy`, for the egress test: its tool `net`
// reports the proxy it was given and what it can connect to: that proxy, and another port.
import { connect } from 'node:net'
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const reach = (port) => new Promise((resolve) => {
  const socket = connect(Number(port), '127.0.0.1')
  socket.on('connect', () => { socket.destroy(); resolve('ok') })
  socket.on('error', (error) => resolve(error.code))
})

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'net', version: '1.0.0' } } })
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [{ name: 'net', description: 'What the network allows', inputSchema: { type: 'object', properties: { other: { type: 'number' } } } }] } })
  } else if (method === 'tools/call') {
    const proxy = process.env.HTTPS_PROXY ?? ''
    const out = { proxy, proxyReach: proxy === '' ? 'none' : await reach(new URL(proxy).port), otherReach: await reach(params.arguments.other) }
    send({ id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else {
    send({ id, error: { code: -32601, message: `no method ${method}` } })
  }
}
