// == ARGUS AGENT PROJECT ==
import { describe, expect, it } from 'vitest'
import { PROJECT_TOOL_DEFAULTS, hiddenTools, hostAllowed, mcpToolAccess, mcpToolOf, taskToolPolicy, toolGroupOf } from '@argus-agent/types'

describe('tool groups', () => {
  it('puts every tool dsh 0.2.0-rc.2 registers in a group or among the quiet ones', () => {
    // The names the pinned dsh tool plugins register. A dsh upgrade that adds one
    // shows up here as `other`, and the gate warns about it at runtime too.
    const dsh = [
      'bash', 'pwsh', 'run_code', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'web_search',
      'subagent', 'workflow', 'ralph', 'send_message', 'interrupt_agent', 'list_agents', 'list_subagent_models',
      'todo_write', 'present', 'create_goal', 'get_goal', 'update_goal', 'job_list', 'job_output', 'job_kill', 'skill',
    ]
    expect(dsh.filter((name) => toolGroupOf(name) === 'other')).toEqual([])
    expect(toolGroupOf('send_file')).toBe('quiet')
    expect(toolGroupOf('some_mcp_tool')).toBe('other')
  })

  it('hides only the groups set to off', () => {
    expect(hiddenTools(PROJECT_TOOL_DEFAULTS)).toContain('subagent')
    expect(hiddenTools(PROJECT_TOOL_DEFAULTS)).not.toContain('bash')
    expect(hiddenTools({ ...PROJECT_TOOL_DEFAULTS, agents: 'ask', web: 'off' })).toEqual(['web_fetch', 'web_search'])
    // An exception wins both ways.
    expect(hiddenTools({ ...PROJECT_TOOL_DEFAULTS, agents: 'ask', web: 'off', exceptions: { web_search: 'allow', edit: 'off' } })).toEqual(['web_fetch', 'edit'])
  })

  it('gives a task the web and refuses the rest unless ad-hoc approvals ask', () => {
    expect(taskToolPolicy('deny')).toMatchObject({ read: 'allow', web: 'allow', shell: 'deny', write: 'deny', agents: 'off' })
    expect(taskToolPolicy('ask').shell).toBe('ask')
  })
})

describe('hostAllowed', () => {
  it('matches a host and its subdomains, nothing else', () => {
    const hosts = ['ycombinator.com', '*.substack.com']
    expect(hostAllowed('https://news.ycombinator.com/item?id=1', hosts)).toBe(true)
    expect(hostAllowed('https://ycombinator.com', hosts)).toBe(true)
    expect(hostAllowed('https://x.substack.com/p/a', hosts)).toBe(true)
    expect(hostAllowed('https://evilycombinator.com', hosts)).toBe(false)
    expect(hostAllowed('https://ycombinator.com.evil.io', hosts)).toBe(false)
    expect(hostAllowed('not a url', hosts)).toBe(false)
    expect(hostAllowed('https://ycombinator.com', [])).toBe(false)
  })

  it('*.example.com covers the subdomains only', () => {
    const hosts = ['*.example.com']
    expect(hostAllowed('https://a.example.com', hosts)).toBe(true)
    expect(hostAllowed('https://a.b.example.com', hosts)).toBe(true)
    expect(hostAllowed('https://example.com', hosts)).toBe(false)
    expect(hostAllowed('https://badexample.com', hosts)).toBe(false)
  })
})

describe('an MCP server\'s tools', () => {
  const server = { access: 'ask' as const, tools: { 'read_*': 'allow' as const, 'delete_*': 'deny' as const, read_secret: 'deny' as const, '*_doc': 'ask' as const, 'browser_?ab*': 'allow' as const } }

  it('follow the most specific key, then the server\'s access', () => {
    expect(mcpToolAccess(server, 'read_doc')).toEqual({ access: 'allow', pattern: 'read_*' })
    expect(mcpToolAccess(server, 'read_secret')).toEqual({ access: 'deny', pattern: 'read_secret' })
    expect(mcpToolAccess(server, 'delete_page')).toEqual({ access: 'deny', pattern: 'delete_*' })
    expect(mcpToolAccess(server, 'update_doc')).toEqual({ access: 'ask', pattern: '*_doc' })
    expect(mcpToolAccess(server, 'browser_tabs')).toEqual({ access: 'allow', pattern: 'browser_?ab*' })
    expect(mcpToolAccess(server, 'share')).toEqual({ access: 'ask', pattern: null })
  })

  it('on a tie, the stricter wins, whatever the order', () => {
    expect(mcpToolAccess({ access: 'allow', tools: { 'a*': 'allow', '*a': 'deny' } }, 'aa').access).toBe('deny')
    expect(mcpToolAccess({ access: 'allow', tools: { '*a': 'deny', 'a*': 'allow' } }, 'aa').access).toBe('deny')
  })

  it('match the whole name, - and _ literally', () => {
    expect(mcpToolAccess({ access: 'deny', tools: { 'get-x': 'allow' } }, 'get-xy').access).toBe('deny')
    expect(mcpToolAccess({ access: 'deny', tools: { 'get_*': 'allow' } }, 'get_x').access).toBe('allow')
    expect(mcpToolAccess({ access: 'deny', tools: { 'get_*': 'allow' } }, 'xget_x').access).toBe('deny')
  })

  it('are named by what follows mcp__<server>__', () => {
    expect(mcpToolOf('mcp__gdocs__read_doc')).toBe('read_doc')
    expect(mcpToolOf('read')).toBeUndefined()
  })
})
