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
export type ToolGroup = 'read' | 'write' | 'shell' | 'web' | 'agents' | 'git' | 'mail' | 'mail_read' | 'other'

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
  /** `git_clone`, `git_pull` and `git_push` on the project's declared remotes, done by Argus. */
  readonly git: ToolAccess
  /** `send_mail`, done by Argus with the project's mail account. Never `allow`: every mail is asked about. */
  readonly mail: Exclude<ToolAccess, 'allow'>
  /**
   * `mail_list`, `mail_read`, `mail_save_attachment`, `mail_mark_read`, done by Argus with
   * the project's mailbox. Shown only to a project that has one.
   */
  readonly mail_read: ToolAccess
  /** Any tool not in a group: one a later dsh adds, or an integration's. Never `off`. */
  readonly other: Exclude<ToolAccess, 'off'>
  /** Hosts `web_fetch` reaches unasked under `web: ask`; a host covers its subdomains. */
  readonly web_hosts: readonly string[]
  /** One tool's access, by name, over its group's (and over the always-allowed ones). */
  readonly exceptions: Readonly<Record<string, ToolAccess>>
}

/**
 * The tools of each group, as dsh 0.2.0-rc.2 names them.
 *
 * `run_code` is dsh's programmatic tool-calling transport: it runs code, so it is a
 * shell. A name in no group follows `other`.
 */
export const TOOL_GROUPS: Readonly<Record<Exclude<ToolGroup, 'other'>, readonly string[]>> = {
  // The MCP resource tools only list and read what a configured server offers.
  read: ['read', 'read_image', 'glob', 'grep', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
  write: ['write', 'edit'],
  shell: ['bash', 'pwsh', 'run_code'],
  web: ['web_fetch', 'web_search'],
  agents: ['subagent', 'workflow', 'ralph', 'send_message', 'interrupt_agent', 'list_agents', 'list_subagent_models', 'ask_project'],
  git: ['git_clone', 'git_pull', 'git_push'],
  mail: ['send_mail'],
  mail_read: ['mail_list', 'mail_read', 'mail_save_attachment', 'mail_mark_read'],
}

/**
 * Tools no setting, rule or run grant lets run unasked: each call is shown to a person.
 * A mail is the easiest way to send data out, so it stays asked about until reading
 * mail and access per tool exist.
 */
export const NEVER_UNASKED: ReadonlySet<string> = new Set(['send_mail'])

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
  git: 'ask',
  mail: 'ask',
  mail_read: 'allow',
  other: 'ask',
  web_hosts: [],
  exceptions: {},
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
  return { read: 'allow', write: risky, shell: risky, web: 'allow', agents: 'off', git: 'off', mail: 'off', mail_read: 'off', other: risky, web_hosts: [], exceptions: {} }
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
  const byGroup = Object.entries(TOOL_GROUPS).flatMap(([group, names]) => (policy[group as ToolGroup] === 'off' ? [...names] : []))
  const exceptions = Object.entries(policy.exceptions)
  // An exception wins both ways: it hides one tool of a visible group, and shows one of a hidden group.
  return [...byGroup.filter((name) => (policy.exceptions[name] ?? 'off') === 'off'), ...exceptions.filter(([name, access]) => access === 'off' && !byGroup.includes(name)).map(([name]) => name)]
}

/**
 * Whether a URL's host is one a policy lets `web_fetch` reach unasked.
 *
 * @param url the URL the call names.
 * @param hosts the allowed hosts: `example.com` covers it and its subdomains,
 *   `*.example.com` its subdomains only.
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
    const trimmed = entry.trim().toLowerCase()
    const subdomainsOnly = trimmed.startsWith('*.')
    const allowed = subdomainsOnly ? trimmed.slice(2) : trimmed
    return allowed.length > 0 && ((!subdomainsOnly && host === allowed) || host.endsWith(`.${allowed}`))
  })
}

/** An MCP server a project connects to (its `mcp:` block). */
export interface McpServer {
  /** A local program, spoken to over stdio. */
  readonly command: string | null
  readonly args: readonly string[]
  /** Values may hold `${NAME}`, resolved from the credentials store when the agent starts. */
  readonly env: Readonly<Record<string, string>>
  /** A remote server, over Streamable HTTP. */
  readonly url: string | null
  readonly headers: Readonly<Record<string, string>>
  /** A remote server that signs in with OAuth: Argus holds the grant (`/mcp connect`). */
  readonly oauth: { readonly client: string | null; readonly scopes: readonly string[] } | null
  /** Whether its tools run unasked, ask, or are refused, unless `tools` says otherwise. */
  readonly access: Exclude<ToolAccess, 'off'>
  /** Per tool: a name or a glob (`*`, `?`) to its access; see {@link mcpToolAccess}. */
  readonly tools: Readonly<Record<string, Exclude<ToolAccess, 'off'>>>
  readonly timeout_s: number
  /**
   * Set when an enabled extension brings it: it then runs confined, reading that folder.
   * `host` and `network` come from the extension's manifest only, never from a project's file.
   */
  readonly extension?: { readonly name: string; readonly dir: string; readonly host: readonly HostCapability[]; readonly network: ServerNetwork; readonly route: ServerRoute | null }
}

/**
 * What an extension's server may do through Argus's host channel (`mcp.<server>.host`):
 * ask for approvals of what it does, report its steps, report its usage.
 */
export const HOST_CAPABILITIES = ['approvals', 'steps', 'usage'] as const
export type HostCapability = (typeof HOST_CAPABILITIES)[number]

/** An extension server's network (`mcp.<server>.network`): any host, or only through Argus's egress proxy. */
export type ServerNetwork = 'open' | 'proxy'

/**
 * A model provider an extension server's agent reaches through Argus (`mcp.<server>.route`),
 * which adds the project's credential: the key never reaches the server or its agent.
 */
export type ServerRoute = 'anthropic' | 'openai'

/** A server name: what its tools are prefixed with. No underscore, so the prefix is unambiguous. */
export const MCP_SERVER_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** A key of a server's `tools`: a tool's name, or a glob of `*` and `?`. No dot: `/set` paths are dotted. */
export const MCP_TOOL_PATTERN = /^[A-Za-z0-9_*?-]{1,128}$/

const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const

/**
 * What decides one tool of an MCP server.
 *
 * The most specific key of `tools` that matches wins: the tool's exact name, then the
 * glob with the most literal characters, then, on a tie, the stricter access. So it does
 * not matter in which order an extension's defaults and the project's file list them.
 *
 * @param server the server's `access` and `tools`.
 * @param tool the tool's own name, without `mcp__<server>__`.
 * @returns the access, and the key that decided it (`null`: the server's `access`).
 */
export function mcpToolAccess(server: Pick<McpServer, 'access' | 'tools'>, tool: string): { access: Exclude<ToolAccess, 'off'>; pattern: string | null } {
  let best: { access: Exclude<ToolAccess, 'off'>; pattern: string; rank: number } | undefined
  for (const [pattern, access] of Object.entries(server.tools)) {
    const exact = !/[*?]/.test(pattern)
    if (exact ? pattern !== tool : !globMatches(pattern, tool)) continue
    const rank = exact ? Number.MAX_SAFE_INTEGER : pattern.replace(/[*?]/g, '').length
    if (best === undefined || rank > best.rank || (rank === best.rank && STRICTNESS[access] > STRICTNESS[best.access])) best = { access, pattern, rank }
  }
  return best === undefined ? { access: server.access, pattern: null } : { access: best.access, pattern: best.pattern }
}

/** Whether a glob of `*` (any run) and `?` (one character) matches the whole name. */
function globMatches(glob: string, name: string): boolean {
  const source = glob.replace(/[.+^${}()|[\]\\-]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${source}$`).test(name)
}

/**
 * A tool's own name on its MCP server.
 *
 * @param name the tool's name, `mcp__<server>__<tool>`.
 * @returns what follows the prefix, or `undefined` for any other tool.
 */
export function mcpToolOf(name: string): string | undefined {
  return /^mcp__[a-z0-9][a-z0-9-]{0,31}__(.+)$/.exec(name)?.[1]
}

/**
 * The server an MCP tool comes from.
 *
 * @param name the tool's name, `mcp__<server>__<tool>`.
 * @returns the server's name, or `undefined` for any other tool.
 */
export function mcpServerOf(name: string): string | undefined {
  return /^mcp__([a-z0-9][a-z0-9-]{0,31})__/.exec(name)?.[1]
}
