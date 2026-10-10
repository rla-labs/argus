// == ARGUS AGENT PROJECT ==
// The smallest MCP server over stdio: one tool, `echo`, which answers with its text
// and the ECHO_SECRET it was started with. JSON-RPC, one message per line.
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } })
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [{ name: 'echo', description: 'Echo the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  } else if (method === 'tools/call') {
    send({ id, result: { content: [{ type: 'text', text: `${params.arguments.text} (${process.env.ECHO_SECRET ?? 'no secret'})` }] } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else {
    send({ id, error: { code: -32601, message: `no method ${method}` } })
  }
}
