// == ARGUS AGENT PROJECT ==
/**
 * The project configuration file: `<config_dir>/projects/<id>.yaml`.
 *
 * YAML is the source of truth for **configuration**; the `projects` table holds
 * runtime state (the current session, the status). This module validates the
 * file strictly and resolves its paths, so a mistake fails at load rather than
 * as a surprising agent behavior later.
 *
 * @module @argus-agent/projects/project-config
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import z from '@deepseek-ai/schemastery'
import { MCP_SERVER_PATTERN, OpsError, PROJECT_TOOL_DEFAULTS, parseModelRef, type McpServer, type ModelRef, type ToolPolicy } from '@argus-agent/types'

/**
 * A project slug.
 *
 * Anchored at both ends and bounded, so a file name cannot escape the projects
 * directory and a generated path stays readable.
 */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/

/** Per-run limits. */
export interface ProjectLimits {
  readonly max_steps_per_run: number
  readonly max_wallclock_min: number
  readonly max_tokens_per_request: number
  readonly max_subagent_depth: number
  readonly loop_repeat_threshold: number
}

/** A project's budget. */
export interface ProjectBudget {
  readonly day_usd: number
  readonly month_usd: number
  readonly info_pct: number
  readonly soft_pct: number
  readonly soft_action: 'warn' | 'downgrade'
  readonly hard_action: 'pause' | 'reject_new'
}

/** A project's approval policy. */
export interface ProjectApprovals {
  /**
   * `auto` allows the `auto_allow` prefixes and asks for everything else;
   * `ask` asks for everything; `deny` refuses without asking.
   *
   * Note that dsh itself has only `ask` and `never` (see SPIKES.md deviation 1).
   * This three-valued policy is implemented by `ops-approvals-bridge` on top of
   * them, not by dsh.
   */
  readonly mode: 'auto' | 'ask' | 'deny'
  /** Command prefixes allowed without asking under `auto`. Matched on argv tokens. */
  readonly auto_allow: readonly string[]
  readonly timeout_minutes: number
}

/** A project's memory settings. */
export interface ProjectMemory {
  /** Inject the global `USER.md` into this project's agents. */
  readonly user_profile: boolean
}

/** A validated project configuration. */
export interface ProjectConfig {
  readonly id: string
  /** The absolute, validated working directory. */
  readonly cwd: string
  readonly provider: string
  readonly model: string
  readonly fallback_model: string | null
  readonly preset: string | null
  readonly description: string | null
  readonly limits: ProjectLimits
  readonly budget: ProjectBudget
  readonly approvals: ProjectApprovals
  readonly memory: ProjectMemory
  /** Which tools the agent sees, and which run unasked. */
  readonly tools: ToolPolicy
  /** The MCP servers its agent connects to, by name. */
  readonly mcp: Readonly<Record<string, McpServer>>
  readonly progress: boolean
  /** The file this was read from. */
  readonly sourcePath: string
}

/** One group's access, with its default. */
function toolAccess(fallback: string) {
  return z.union([z.const('off'), z.const('deny'), z.const('ask'), z.const('allow')]).default(fallback as 'ask')
}

/** The keys a `tools:` block may hold: a misspelt group would otherwise be ignored. */
const TOOL_KEYS = ['read', 'write', 'shell', 'web', 'agents', 'other', 'web_hosts', 'exceptions']

/** What one tool's exception may be. */
const ACCESS_VALUES = ['off', 'deny', 'ask', 'allow']

/** The keys one `mcp:` server may hold. */
const MCP_KEYS = ['command', 'args', 'env', 'url', 'headers', 'access', 'timeout_s']

/** The `mcp:` block: server names to servers, each a local program (`command`) or a remote one (`url`). */
const mcpSchema = z.dict(z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  url: z.string(),
  headers: z.dict(z.string()).default({}),
  access: z.union([z.const('deny'), z.const('ask'), z.const('allow')]).default('ask'),
  timeout_s: z.number().min(1).default(60),
}))

/**
 * Problems in an `mcp:` block that the schema cannot word well.
 *
 * @param mcp the block as written.
 * @returns one issue per problem.
 */
function mcpIssues(mcp: unknown): ProjectConfigIssue[] {
  if (mcp === undefined || mcp === null) return []
  if (typeof mcp !== 'object' || Array.isArray(mcp)) return [{ path: 'mcp', message: 'must map server names to servers' }]
  const issues: ProjectConfigIssue[] = []
  for (const [name, server] of Object.entries(mcp)) {
    if (!MCP_SERVER_PATTERN.test(name)) issues.push({ path: `mcp.${name}`, message: `server names must match ${MCP_SERVER_PATTERN}` })
    if (server === null || typeof server !== 'object' || Array.isArray(server)) {
      issues.push({ path: `mcp.${name}`, message: 'must be a mapping with command or url' })
      continue
    }
    const fields = server as Record<string, unknown>
    for (const key of Object.keys(fields)) {
      if (!MCP_KEYS.includes(key)) issues.push({ path: `mcp.${name}.${key}`, message: `unknown; use one of ${MCP_KEYS.join(', ')}` })
    }
    if ((typeof fields['command'] === 'string') === (typeof fields['url'] === 'string')) {
      issues.push({ path: `mcp.${name}`, message: 'needs exactly one of command (a local program) or url (a remote server)' })
    }
  }
  return issues
}

/** The schemastery schema for one project file. */
export const projectConfigSchema = z.object({
  id: z.string().required().description('Slug; must match the file name'),
  cwd: z.string().required().description('Absolute working directory inside <data_dir>/projects/'),
  description: z.string().description('One line the orchestrator routes on'),
  provider: z.string().required(),
  model: z.string().required(),
  fallback_model: z.string().description('Used at the soft budget threshold with action downgrade'),
  preset: z.string().description('The dsh agent preset mounted into this project scope'),
  limits: z
    .object({
      max_steps_per_run: z.number().default(60),
      max_wallclock_min: z.number().default(45),
      max_tokens_per_request: z.number().default(8000),
      max_subagent_depth: z.number().default(1),
      loop_repeat_threshold: z.number().default(5),
    })
    .default({}),
  budget: z
    .object({
      day_usd: z.number().default(3),
      month_usd: z.number().default(40),
      info_pct: z.number().default(50),
      soft_pct: z.number().default(80),
      soft_action: z.union([z.const('warn'), z.const('downgrade')]).default('warn'),
      hard_action: z.union([z.const('pause'), z.const('reject_new')]).default('pause'),
    })
    .default({}),
  approvals: z
    .object({
      mode: z.union([z.const('auto'), z.const('ask'), z.const('deny')]).default('ask'),
      auto_allow: z.array(z.string()).default([]),
      timeout_minutes: z.number().default(30),
    })
    .default({}),
  memory: z
    .object({
      user_profile: z.boolean().default(true),
    })
    .default({}),
  tools: z
    .object({
      read: toolAccess(PROJECT_TOOL_DEFAULTS.read),
      write: toolAccess(PROJECT_TOOL_DEFAULTS.write),
      shell: toolAccess(PROJECT_TOOL_DEFAULTS.shell),
      web: toolAccess(PROJECT_TOOL_DEFAULTS.web),
      agents: toolAccess(PROJECT_TOOL_DEFAULTS.agents),
      other: z.union([z.const('deny'), z.const('ask'), z.const('allow')]).default(PROJECT_TOOL_DEFAULTS.other),
      web_hosts: z.array(z.string()).default([]),
    })
    .default({}),
  progress: z.boolean().default(false),
})

/** One problem found while validating a project file. */
export interface ProjectConfigIssue {
  readonly path: string
  readonly message: string
}

/**
 * Thrown when a project file is missing, unparseable, or invalid.
 *
 * Carries `PROJECT_CONFIG_INVALID` so a caller branches on the code rather than
 * on the message.
 */
export class ProjectConfigError extends OpsError {
  readonly issues: readonly ProjectConfigIssue[]

  constructor(message: string, issues: readonly ProjectConfigIssue[] = [], details: Record<string, unknown> = {}) {
    const detail = issues.length
      ? `\n${issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n')}`
      : ''
    super('PROJECT_CONFIG_INVALID', `${message}${detail}`, details)
    this.name = 'ProjectConfigError'
    this.issues = issues
  }
}

/**
 * Treat an empty string as absent.
 * @param value the parsed value.
 * @returns the string, or null when it is absent or empty.
 */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Verify that a project's `cwd` resolves inside the projects root.
 *
 * A project must not be able to point at `/`, at another project's folder, or
 * anywhere else outside `<data_dir>/projects/`. The check is on the **resolved**
 * path, so `..` segments are already collapsed; a symlink that escapes is
 * caught separately by `ops-projects` after the directory exists, because
 * `realpath` requires it to exist.
 *
 * @param cwd the configured directory.
 * @param projectsRoot the absolute `<data_dir>/projects` directory.
 * @returns the resolved absolute path.
 * @throws {ProjectConfigError} when the path escapes the root.
 */
export function assertCwdInsideProjectsRoot(cwd: string, projectsRoot: string): string {
  if (!isAbsolute(cwd)) {
    throw new ProjectConfigError(`project cwd must be absolute, got ${JSON.stringify(cwd)}`, [
      { path: 'cwd', message: 'must be an absolute path' },
    ])
  }
  const resolvedRoot = resolve(projectsRoot)
  const resolvedCwd = resolve(cwd)
  const rel = relative(resolvedRoot, resolvedCwd)
  if (rel === '') {
    throw new ProjectConfigError('project cwd must be a subdirectory of the projects root', [
      { path: 'cwd', message: `must not be the projects root itself (${resolvedRoot})` },
    ])
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ProjectConfigError(`project cwd escapes the projects root`, [
      {
        path: 'cwd',
        message: `${resolvedCwd} is not inside ${resolvedRoot}`,
      },
    ])
  }
  return resolvedCwd
}

/**
 * The default `cwd` for a project that omits one.
 * @param projectId the slug.
 * @param projectsRoot the absolute `<data_dir>/projects` directory.
 * @returns the absolute path.
 */
export function defaultProjectCwd(projectId: string, projectsRoot: string): string {
  return join(projectsRoot, projectId)
}

/**
 * Parse and validate one project document.
 *
 * @param raw the parsed YAML value.
 * @param options the file it came from and the projects root.
 * @returns the validated configuration.
 * @throws {ProjectConfigError} naming every problem found.
 */
export function parseProjectConfig(
  raw: unknown,
  options: { sourcePath: string; projectsRoot: string; expectedId?: string; budgetDefaults?: BudgetDefaults },
): ProjectConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProjectConfigError(`${options.sourcePath} must contain a mapping at the top level`, [
      { path: '(root)', message: `found ${Array.isArray(raw) ? 'a list' : typeof raw}` },
    ])
  }
  const document = raw as Record<string, unknown>
  const issues: ProjectConfigIssue[] = []

  const id = document['id']
  if (typeof id !== 'string' || !PROJECT_ID_PATTERN.test(id)) {
    issues.push({
      path: 'id',
      message: `must match ${PROJECT_ID_PATTERN} (lowercase letters, digits and dashes, 2-41 chars)`,
    })
  } else if (options.expectedId !== undefined && id !== options.expectedId) {
    // The file name is the project's identity everywhere else, so a mismatch
    // would make `/p <id>` address a project whose file says something else.
    issues.push({
      path: 'id',
      message: `must match the file name: the file is ${options.expectedId}.yaml but declares ${JSON.stringify(id)}`,
    })
  }

  for (const key of ['provider', 'model'] as const) {
    const value = document[key]
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({ path: key, message: 'is required and must be a non-empty string' })
    }
  }

  const cwd = document['cwd']
  let resolvedCwd = ''
  if (typeof cwd !== 'string') {
    issues.push({ path: 'cwd', message: 'is required and must be a string' })
  } else {
    try {
      resolvedCwd = assertCwdInsideProjectsRoot(cwd, options.projectsRoot)
    } catch (error) {
      for (const issue of (error as ProjectConfigError).issues) issues.push(issue)
    }
  }

  if (typeof document['fallback_model'] === 'string' && document['fallback_model'].length > 0) {
    if (parseModelRef(document['fallback_model']) === undefined) {
      issues.push({
        path: 'fallback_model',
        message: `must be "provider/model", got ${JSON.stringify(document['fallback_model'])}`,
      })
    }
  }

  const tools = document['tools']
  let exceptions: Record<string, string> = {}
  if (tools !== null && typeof tools === 'object' && !Array.isArray(tools)) {
    for (const key of Object.keys(tools)) {
      if (!TOOL_KEYS.includes(key)) issues.push({ path: `tools.${key}`, message: `not a tool group; use one of ${TOOL_KEYS.join(', ')}` })
    }
    const named = (tools as Record<string, unknown>)['exceptions']
    if (named !== undefined && named !== null) {
      if (typeof named !== 'object' || Array.isArray(named)) issues.push({ path: 'tools.exceptions', message: 'must map tool names to off, deny, ask or allow' })
      else {
        exceptions = named as Record<string, string>
        for (const [name, access] of Object.entries(exceptions)) {
          if (!ACCESS_VALUES.includes(access)) issues.push({ path: `tools.exceptions.${name}`, message: `must be one of ${ACCESS_VALUES.join(', ')}` })
        }
      }
    }
  }

  issues.push(...mcpIssues(document['mcp']))

  if (issues.length > 0) {
    throw new ProjectConfigError(`${options.sourcePath} is not a valid project`, issues, {
      sourcePath: options.sourcePath,
    })
  }

  // A budget the file does not set comes from ops.yaml (`budgets.default_*_usd`), which is
  // what the installer asks for as "per project"; the file's own value always wins.
  const budget = document['budget']
  const withDefaults =
    options.budgetDefaults === undefined || (budget !== undefined && (budget === null || typeof budget !== 'object'))
      ? document
      : { ...document, budget: { ...options.budgetDefaults, ...(budget as Record<string, unknown> | undefined) } }

  let validated: Record<string, unknown>
  let mcp: Record<string, Record<string, unknown>>
  try {
    // The exceptions are checked above; the schema knows only the groups.
    const written = (withDefaults as Record<string, unknown>)['tools']
    const groups = written !== null && typeof written === 'object' && !Array.isArray(written) ? Object.fromEntries(Object.entries(written).filter(([key]) => key !== 'exceptions')) : written
    validated = projectConfigSchema({ ...withDefaults, tools: groups } as never) as unknown as Record<string, unknown>
    mcp = mcpSchema((document['mcp'] ?? {}) as never) as Record<string, Record<string, unknown>>
  } catch (error) {
    throw new ProjectConfigError(`${options.sourcePath} failed validation`, [
      { path: '(root)', message: (error as Error).message },
    ])
  }

  return {
    id: validated['id'] as string,
    cwd: resolvedCwd,
    provider: validated['provider'] as string,
    model: validated['model'] as string,
    // An empty string is a present key with no value. Normalizing it to null
    // here keeps every consumer from having to treat `''` and `null` alike.
    fallback_model: nonEmpty(validated['fallback_model']),
    preset: nonEmpty(validated['preset']),
    description: nonEmpty(validated['description']),
    limits: validated['limits'] as ProjectLimits,
    budget: validated['budget'] as ProjectBudget,
    approvals: validated['approvals'] as ProjectApprovals,
    memory: validated['memory'] as ProjectMemory,
    tools: { ...(validated['tools'] as Omit<ToolPolicy, 'exceptions'>), exceptions: exceptions as ToolPolicy['exceptions'] },
    mcp: Object.fromEntries(
      Object.entries(mcp).map(([name, server]) => [
        name,
        { ...server, command: nonEmpty(server['command']), url: nonEmpty(server['url']) } as McpServer,
      ]),
    ),
    progress: validated['progress'] as boolean,
    sourcePath: options.sourcePath,
  }
}

/** `budgets.default_day_usd` / `default_month_usd` from ops.yaml, as a project's budget defaults. */
export interface BudgetDefaults {
  readonly day_usd: number
  readonly month_usd: number
}

/**
 * Parse a project document from YAML text.
 *
 * @param text the file contents.
 * @param options the file it came from and the projects root.
 * @returns the validated configuration.
 * @throws {ProjectConfigError} when the YAML is malformed or the document invalid.
 */
export function parseProjectYaml(
  text: string,
  options: { sourcePath: string; projectsRoot: string; expectedId?: string; budgetDefaults?: BudgetDefaults },
): ProjectConfig {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    throw new ProjectConfigError(`${options.sourcePath} is not valid YAML`, [
      { path: '(root)', message: (error as Error).message },
    ])
  }
  return parseProjectConfig(parsed, options)
}

/**
 * The model reference a project runs on.
 * @param config the project configuration.
 * @returns the provider and model.
 */
export function projectModelRef(config: ProjectConfig): ModelRef {
  return { provider: config.provider, model: config.model }
}

/**
 * The model reference to downgrade to, when one is configured.
 * @param config the project configuration.
 * @returns the fallback reference, or `undefined`.
 */
export function projectFallbackRef(config: ProjectConfig): ModelRef | undefined {
  return config.fallback_model === null ? undefined : (parseModelRef(config.fallback_model) ?? undefined)
}

/** The path separator used in a project's source path, for diagnostics. */
export const PATH_SEP = sep
