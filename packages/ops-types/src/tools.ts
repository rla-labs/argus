// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/types/tools` — which tools a project or task agent may use.
 *
 * One table, read by `ops-projects` (which tools the model sees at all) and by
 * `ops-approvals-bridge` (whether a visible tool runs, asks or is refused), so the
 * two layers cannot disagree about what a group holds.
 *
 * @module @argus-agent/types/tools
 */

/** A group of tools a project names in its `tools:` block. */
export type ToolGroup = 'read' | 'write' | 'shell' | 'web' | 'agents' | 'other'

/**
 * What a project allows for a group.
 *
 * `off` hides the tools from the model; `deny` refuses a call; `ask` asks a person;
 * `allow` runs it unasked.
 */
export type ToolAccess = 'off' | 'deny' | 'ask' | 'allow'

/** A project's `tools:` block. */
export interface ToolPolicy {
  readonly read: ToolAccess
  readonly write: ToolAccess
  readonly shell: ToolAccess
  readonly web: ToolAccess
  readonly agents: ToolAccess
  /** Any tool not in a group: one a later dsh adds, or an integration's. Never `off`. */
  readonly other: Exclude<ToolAccess, 'off'>
  /** Hosts `web_fetch` reaches unasked under `web: ask`; a host covers its subdomains. */
  readonly web_hosts: readonly string[]
}

/**
 * The tools of each group, as dsh 0.2.0-rc.2 names them.
 *
 * `run_code` is dsh's programmatic tool-calling transport: it runs code, so it is a
 * shell. A name in no group follows `other`.
 */
export const TOOL_GROUPS: Readonly<Record<Exclude<ToolGroup, 'other'>, readonly string[]>> = {
  read: ['read', 'read_image', 'glob', 'grep'],
  write: ['write', 'edit'],
  shell: ['bash', 'pwsh', 'run_code'],
  web: ['web_fetch', 'web_search'],
  agents: ['subagent', 'workflow', 'ralph', 'send_message', 'interrupt_agent', 'list_agents', 'list_subagent_models'],
}

/**
 * Tools that only keep the agent's own books (its todo list, goals, background
 * jobs, skills) or show it something, and `send_file`, which sends from the
 * agent's own folder and refuses any other path itself. Always allowed.
 */
export const QUIET_TOOLS: ReadonlySet<string> = new Set([
  'todo_write',
  'present',
  'create_goal',
  'get_goal',
  'update_goal',
  'job_list',
  'job_output',
  'job_kill',
  'skill',
  'send_file',
])

/** A project's policy when its file names none: today's behaviour, delegation hidden. */
export const PROJECT_TOOL_DEFAULTS: ToolPolicy = {
  read: 'allow',
  write: 'ask',
  shell: 'ask',
  web: 'ask',
  agents: 'off',
  other: 'ask',
  web_hosts: [],
}

/**
 * A one-off task's policy. It has no file to declare one in, so it reads and
 * searches the web ("what is X?" needs it) and nothing riskier: what would ask is
 * refused when `approvals_adhoc` is `deny`, and asks otherwise.
 *
 * @param adhoc the ad-hoc approval mode.
 * @returns the policy.
 */
export function taskToolPolicy(adhoc: 'auto' | 'ask' | 'deny'): ToolPolicy {
  const risky = adhoc === 'deny' ? 'deny' : 'ask'
  return { read: 'allow', write: risky, shell: risky, web: 'allow', agents: 'off', other: risky, web_hosts: [] }
}

/**
 * The group a tool belongs to.
 *
 * @param name the tool's name.
 * @returns its group, `quiet` for the always-allowed ones, `other` for an unknown name.
 */
export function toolGroupOf(name: string): ToolGroup | 'quiet' {
  if (QUIET_TOOLS.has(name)) return 'quiet'
  for (const [group, names] of Object.entries(TOOL_GROUPS)) {
    if (names.includes(name)) return group as ToolGroup
  }
  return 'other'
}

/**
 * The tool names a policy hides from the model.
 *
 * @param policy the policy.
 * @returns every name in a group set to `off`.
 */
export function hiddenTools(policy: ToolPolicy): string[] {
  return Object.entries(TOOL_GROUPS).flatMap(([group, names]) => (policy[group as ToolGroup] === 'off' ? [...names] : []))
}

/**
 * Whether a URL's host is one a policy lets `web_fetch` reach unasked.
 *
 * @param url the URL the call names.
 * @param hosts the allowed hosts; each covers its subdomains.
 * @returns whether it matches.
 */
export function hostAllowed(url: string, hosts: readonly string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return hosts.some((entry) => {
    const allowed = entry.trim().toLowerCase().replace(/^\*\./, '')
    return allowed.length > 0 && (host === allowed || host.endsWith(`.${allowed}`))
  })
}
