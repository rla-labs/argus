// == ARGUS AGENT PROJECT ==
// The smallest MCP server over stdio: `echo` answers with its text and the ECHO_SECRET it
// was started with; `home` keeps a token in its HOME and says where. JSON-RPC, one
// message per line.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } })
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [{ name: 'echo', description: 'Echo the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, { name: 'home', description: 'Keep a token at home', inputSchema: { type: 'object' } }] } })
  } else if (method === 'tools/call' && params.name === 'home') {
    writeFileSync(`${process.env.HOME}/token`, 'TOKEN-IN-HOME')
    send({ id, result: { content: [{ type: 'text', text: `home: ${process.env.HOME}; config: ${process.env.XDG_CONFIG_HOME}` }] } })
  } else if (method === 'tools/call') {
    send({ id, result: { content: [{ type: 'text', text: `${params.arguments.text} (${process.env.ECHO_SECRET ?? 'no secret'})` }] } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else {
    send({ id, error: { code: -32601, message: `no method ${method}` } })
  }
}
