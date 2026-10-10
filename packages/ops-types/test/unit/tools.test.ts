// == ARGUS AGENT PROJECT ==
import { describe, expect, it } from 'vitest'
import { PROJECT_TOOL_DEFAULTS, hiddenTools, hostAllowed, taskToolPolicy, toolGroupOf } from '@argus-agent/types'

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
})
