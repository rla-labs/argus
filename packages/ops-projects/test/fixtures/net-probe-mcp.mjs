// == ARGUS AGENT PROJECT ==
// An extension's MCP server with `network: proxy`, for the egress test: its tool `net`
// reports the proxy it was given and what it can connect to: that proxy, and another port;
// with a route, what a request on it answers, and whether any secret is in its environment.
import { request } from 'node:http'
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
    const route = process.env.ARGUS_ANTHROPIC_BASE_URL
    const routed = route === undefined ? 'none' : await new Promise((resolve) => {
      const req = request(`${route}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer argus-route', 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', (error) => resolve(error.code))
      req.end('{}')
    })
    const openai = process.env.ARGUS_OPENAI_BASE_URL
    const openaiRouted = openai === undefined ? 'none' : await new Promise((resolve) => {
      const req = request(`${openai}/responses`, { method: 'POST', headers: { authorization: 'Bearer dummy', 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', (error) => resolve(error.code))
      req.end(JSON.stringify({ model: 'gpt-x', stream: true }))
    })
    const secrets = Object.keys(process.env).filter((name) => /OAUTH|API_KEY|ARGUS_HOST_TOKEN/.test(name))
    const out = { proxy, proxyReach: proxy === '' ? 'none' : await reach(new URL(proxy).port), otherReach: await reach(params.arguments.other), routed, openaiRouted, secrets }
    send({ id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else {
    send({ id, error: { code: -32601, message: `no method ${method}` } })
  }
}
