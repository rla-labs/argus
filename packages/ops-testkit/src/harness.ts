// == ARGUS AGENT PROJECT ==
/**
 * The boot harness.
 *
 * `bootOps` mounts a minimal dsh composition in a temporary directory with the
 * fake adapter available, so an integration test exercises real dsh code paths
 * (agent creation, the session log, event dispatch) without a provider or a
 * network. `dispose()` unwinds the whole tree and deletes the directory.
 *
 * The entry list is deliberately small: only the rows a governed agent actually
 * needs. See `docs/developer-docs.md#verified-dsh-facts` for why each is required.
 *
 * @module @argus-agent/testkit/harness
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { FakeLlmAdapter, type FakeLlmAdapterOptions } from './fake-llm.js'

/** The environment variable the bundle reads to locate `ops.yaml`. */
const OPS_CONFIG_ENV = 'ARGUS_AGENT_CONFIG'

/** One entry row in the composed tree. */
export interface OpsEntry {
  readonly id: string
  readonly name: string
  readonly config?: unknown
  readonly disabled?: boolean
}

/**
 * The minimal entry list every harness boot starts from.
 *
 * `agent-loop` registers the creation factory on `ctx.agents`; `tools` requires
 * `systemPrompt`; `agent-loop` requires `tools`, `systemPrompt` and
 * `sessionProjections`. Without all of them, `ctx.agents.create()` rejects.
 */
export const BASE_ENTRIES: readonly OpsEntry[] = [
  { id: 'llm', name: '@deepseek-ai/dsh-llm' },
  { id: 'session', name: '@deepseek-ai/dsh-session' },
  { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
  { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: '' } },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  { id: 'agent', name: '@deepseek-ai/dsh-agent' },
  {
    id: 'agent-default-model',
    name: '@deepseek-ai/dsh-agent-default-model',
    config: { provider: 'fake', model: 'fake-model' },
  },
  { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
]

/** The optional rows a test opts into. */
export const OPTIONAL_ENTRIES = {
  subagent: { id: 'subagent', name: '@deepseek-ai/dsh-subagent' },
  approval: { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval' },
  commands: { id: 'commands', name: '@deepseek-ai/dsh-commands' },
  /** The agent-preset registry, which `ops-projects` requires to mount a preset. */
  agentPresets: { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'default' } },
  sandbox: { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox' },
} as const satisfies Record<string, OpsEntry>

/**
 * The session-persistence backend row.
 *
 * `@deepseek-ai/dsh-session-persistence` is the **abstract service definition**
 * and must not be mounted: doing so collides with the concrete backend
 * (`service "sessionPersistence" has been registered`). Only the JSONL backend
 * is mounted, with its root pointed into the harness's temporary directory.
 *
 * @param sessionsDir the absolute directory for stored sessions.
 * @returns the entry row.
 */
export function persistenceEntry(sessionsDir: string): OpsEntry {
  return {
    id: 'session-persistence-jsonl',
    name: '@deepseek-ai/dsh-session-persistence-jsonl',
    config: { root: sessionsDir },
  }
}

/** Options for {@link bootOps}. */
export interface BootOpsOptions {
  /** Extra entry rows to mount after the base list. */
  readonly entries?: readonly OpsEntry[]
  /**
   * Replace the whole entry list.
   *
   * Used when a test needs the persistence root somewhere specific, or wants to
   * mount a plugin the default list omits.
   */
  readonly replaceEntries?: readonly OpsEntry[]
  /** Files to write into the temporary directory, keyed by relative path. */
  readonly files?: Readonly<Record<string, string>>
  /**
   * Write a minimal `config/ops.yaml` when the caller supplied none.
   *
   * The bundle row fails the boot when the file is missing, which is correct in
   * production and useless in a test. Defaults to `true`, so mounting
   * `@argus-agent/argus-agent` works without every test restating the file; set it to
   * `false` to test the missing-config failure itself.
   */
  readonly defaultOpsYaml?: boolean
  /**
   * Session-persistence root.
   *
   * Defaults to a fresh `sessions/` inside the temporary directory. Pass an
   * explicit path to resume a session written by an earlier boot — this is how
   * a crash-recovery test shares a log between two processes.
   */
  readonly sessionsRoot?: string
  /**
   * Register a fake LLM adapter on the booted tree.
   *
   * `false` mounts the LLM service with no adapter, which is the fixture for a
   * test asserting that an unpriced or unroutable model is refused.
   */
  readonly fake?: FakeLlmAdapterOptions | false
  /**
   * Base URL for resolving BARE plugin specifiers in the entry list.
   *
   * Defaults to this module's own location, which resolves the dsh packages the
   * toolkit depends on. A test that mounts one of its own package's plugins must
   * pass its own `import.meta.url`, because a package is never linked into its
   * own `node_modules` — so `@argus-agent/<name>` does not resolve from here.
   */
  readonly bareModuleBaseUrl?: string
  /**
   * The **data directory** the boot should use, instead of a fresh temporary one.
   *
   * The config file and the `cordis.yml` still go to a temporary directory, so a
   * boot stays hermetic; only `data_dir` — the database, the sessions, the project
   * workspaces and the state tree — is pointed elsewhere.
   *
   * This exists for crash-recovery tests: a test must restart against the SAME data
   * directory the killed process used, and a boot that silently created a fresh one
   * would make the test pass while proving nothing.
   */
  readonly dataDir?: string
  /**
   * Use the `ops.yaml` **already present** in `dataDir` instead of writing one.
   *
   * The config file lives in the data directory in a real deployment, and a crash
   * test must restart against the same configuration the killed process used. A
   * boot that wrote its own minimal file would silently drop the pricing table, and
   * every request would be refused as `UNPRICED_MODEL` — which is exactly the wrong
   * failure to debug from a crash test.
   *
   * Implies `defaultOpsYaml: false`.
   */
  readonly useExistingOpsYaml?: boolean
}

/** A booted composition and its cleanup. */
export interface OpsBoot {
  /** The root Cordis context. */
  ctx: Context
  /** Absolute temporary directory: the workspace root and data dir for this boot. */
  dir: string
  /** Absolute session-persistence root. */
  sessionsRoot: string
  /** The registered fake adapter, when one was requested. */
  fake: FakeLlmAdapter | undefined
  /** Stop the tree and delete the temporary directory. */
  dispose(): Promise<void>
}

/**
 * Boot a minimal dsh composition in a fresh temporary directory.
 *
 * @param options what to mount and where.
 * @returns the booted context, its directories, the fake adapter, and cleanup.
 */
export async function bootOps(options: BootOpsOptions = {}): Promise<OpsBoot> {
  const dir = mkdtempSync(join(tmpdir(), 'argus-agent-test-'))
  // Where state lives. Defaults to the temporary directory, so an ordinary test is
  // hermetic; a crash test passes the directory the previous process used.
  const dataDir = options.dataDir ?? dir
  mkdirSync(dataDir, { recursive: true })
  const sessionsRoot = options.sessionsRoot ?? join(dataDir, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })

  const files: Record<string, string> = { ...options.files }
  // `ARGUS_AGENT_CONFIG` can point straight at the caller's file, which is what a
  // restart needs: the same configuration, not a regenerated one.
  const existingConfig =
    options.useExistingOpsYaml === true ? join(dataDir, 'config', 'ops.yaml') : undefined
  if (existingConfig !== undefined) {
    files['config/ops.yaml'] = readFileSync(existingConfig, 'utf8')
  } else if (options.defaultOpsYaml !== false && files['config/ops.yaml'] === undefined) {
    // A minimal valid configuration, so the bundle row can activate. `data_dir`
    // points at the data directory, which is the temporary one unless a caller
    // supplied another.
    files['config/ops.yaml'] = `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n`
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }

  const entries =
    options.replaceEntries ??
    [...BASE_ENTRIES, persistenceEntry(sessionsRoot), ...(options.entries ?? [])]

  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, renderEntries(entries))

  // Point the bundle's config row at the file this boot provisioned. The
  // `ops.yaml` path cannot come from `data_dir` inside the file it is reading:
  // the file is what declares `data_dir`. `ARGUS_AGENT_CONFIG` is the documented
  // override and the only one available at this point.
  const previousConfigEnv = process.env[OPS_CONFIG_ENV]
  if (files['config/ops.yaml'] !== undefined) {
    process.env[OPS_CONFIG_ENV] = join(dir, 'config', 'ops.yaml')
  }

  let ctx: Context | undefined
  try {
    ctx = await boot(
      'argus-agent-test',
      configPath,
      [],
      undefined,
      options.bareModuleBaseUrl ?? import.meta.url,
    )
  } catch (error) {
    // A boot that rejects must still restore the environment and remove its
    // directory. Leaving `ARGUS_AGENT_CONFIG` pointing at a deleted file would make
    // the NEXT boot in the same process resolve a config that no longer exists —
    // a test-pollution bug whose symptom appears in an unrelated test.
    if (previousConfigEnv === undefined) delete process.env[OPS_CONFIG_ENV]
    else process.env[OPS_CONFIG_ENV] = previousConfigEnv
    // A rejected boot can leave a partially-activated tree whose plugin
    // registrations (a config section, a listener) are still live. `boot()`
    // disposes the partial context itself on a startup failure, but a failure
    // during a LATER row's activation leaves the published ones running; the
    // module-level state they touched would then poison the next boot in this
    // process. A best-effort dispatch of the root fiber is the cleanup.
    await disposeBootedTree(ctx)
    rmSync(dir, { recursive: true, force: true })
    throw error
  }

  let fake: FakeLlmAdapter | undefined
  if (options.fake !== false) {
    fake = new FakeLlmAdapter(options.fake ?? { script: [{ text: 'ok' }], repeatLast: true })
    ctx.llm.registerAdapter(['fake'], fake)
  }

  return {
    ctx: ctx as Context,
    dir,
    sessionsRoot,
    fake,
    async dispose() {
      if (previousConfigEnv === undefined) delete process.env[OPS_CONFIG_ENV]
      else process.env[OPS_CONFIG_ENV] = previousConfigEnv
      // `boot()` mounts the whole tree as one root fiber; disposing that fiber
      // unwinds every entry, which is the HMR-safe teardown contract AGENTS.md
      // requires. A failure here must not prevent the directory cleanup.
      try {
        await (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose()
      } catch {
        // A teardown failure is reported by the boot's own diagnostics.
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Dispose a booted tree, best-effort.
 *
 * `boot()` mounts the whole tree as one root fiber, so disposing that fiber
 * unwinds every entry — the HMR-safe teardown contract AGENTS.md requires. A
 * teardown failure is contained: dsh's own diagnostics already reported it, and
 * letting it mask the original error would hide the cause.
 *
 * @param ctx the booted context, or `undefined` when the boot rejected before
 *   producing one.
 */
async function disposeBootedTree(ctx: Context | undefined): Promise<void> {
  if (ctx === undefined) return
  try {
    await (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose()
  } catch {
    // Contained: see the doc comment.
  }
}

/**
 * Render an entry list as the Cordis include's YAML dialect.
 *
 * Plugin specifiers start with `@`, which YAML reserves, so names are always
 * quoted.
 *
 * @param entries the rows to render.
 * @returns the YAML document.
 */
export function renderEntries(entries: readonly OpsEntry[]): string {
  return `${entries.map(renderEntry).join('\n')}\n`
}

function renderEntry(entry: OpsEntry): string {
  const lines = [`- id: ${entry.id}`, `  name: ${JSON.stringify(entry.name)}`]
  if (entry.disabled !== undefined) lines.push(`  disabled: ${JSON.stringify(entry.disabled)}`)
  if (entry.config !== undefined) {
    lines.push('  config:')
    for (const line of renderValue(entry.config, 2)) lines.push(`    ${line}`)
  }
  return lines.join('\n')
}

function renderValue(value: unknown, depth: number): string[] {
  const pad = '  '.repeat(depth)
  if (value === null) return ['null']
  if (typeof value !== 'object') return [JSON.stringify(value)]
  if (Array.isArray(value)) {
    if (value.length === 0) return ['[]']
    return value.flatMap((item) => {
      const rendered = renderValue(item, depth + 1)
      return [`- ${rendered[0] ?? ''}`, ...rendered.slice(1).map((line) => `${pad}${line}`)]
    })
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return ['{}']
  return entries.flatMap(([key, item]) => {
    const rendered = renderValue(item, depth + 1)
    if (rendered.length === 1 && !rendered[0]?.startsWith('-')) return [`${key}: ${rendered[0]}`]
    return [`${key}:`, ...rendered.map((line) => `${pad}${line}`)]
  })
}
