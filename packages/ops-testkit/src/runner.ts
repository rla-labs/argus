// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/testkit/runner` — boot the ops stack in a process of its own.
 *
 * An in-process boot cannot be killed, so a crash-recovery test has nothing to
 * crash. This entry point boots the same tree the harness does and then **stays
 * alive**, which gives a test a real process it can `SIGKILL` mid-run — the only
 * honest way to reproduce "the process died while three runs were in flight".
 *
 * It is driven by environment variables, so a test supplies them without a
 * temporary script or an argument parser:
 *
 * | Variable | Meaning |
 * |---|---|
 * | `ARGUS_AGENT_RUNNER_DATA_DIR` | The data directory to use. Required. |
 * | `ARGUS_AGENT_RUNNER_SCRIPT` | JSON array for the fake model's script. |
 * | `ARGUS_AGENT_RUNNER_READY` | A file to touch once booted, so the test can wait. |
 *
 * @module @argus-agent/testkit/runner
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootOps, BASE_ENTRIES, OPTIONAL_ENTRIES, persistenceEntry, type OpsBoot } from './harness.js'

/** The environment variable naming the data directory. */
export const RUNNER_DATA_DIR = 'ARGUS_AGENT_RUNNER_DATA_DIR'
/** The environment variable carrying the fake script. */
export const RUNNER_SCRIPT = 'ARGUS_AGENT_RUNNER_SCRIPT'
/** The environment variable naming the ready marker file. */
export const RUNNER_READY = 'ARGUS_AGENT_RUNNER_READY'
/** The environment variable carrying the module-resolution base URL. */
export const RUNNER_BASE_URL = 'ARGUS_AGENT_RUNNER_BASE_URL'

/** What the runner booted, for the caller that started it in-process. */
export interface RunnerHandle {
  readonly boot: OpsBoot
  readonly dataDir: string
  stop(): Promise<void>
}

/**
 * Boot the full stack against a data directory, and keep it alive.
 *
 * @returns the booted tree.
 * @throws when the data directory is not set, rather than silently using a
 *   temporary one: a crash test that restarted against a DIFFERENT directory would
 *   pass while proving nothing.
 */
export async function run(options: { readonly bareModuleBaseUrl?: string } = {}): Promise<RunnerHandle> {
  const dataDir = process.env[RUNNER_DATA_DIR]
  if (dataDir === undefined || dataDir.length === 0) {
    throw new Error(`${RUNNER_DATA_DIR} must be set: the runner uses a caller-supplied data directory`)
  }

  mkdirSync(join(dataDir, 'projects'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })

  const script = process.env[RUNNER_SCRIPT]
  const fake = {
    script: (script === undefined ? [{ text: 'runner output' }] : JSON.parse(script)) as never,
    repeatLast: true,
  }

  const boot = await bootOps({
    dataDir,
    // Bare specifiers resolve from HERE. `import.meta.url` inside the toolkit does
    // not work: a workspace package is not linked into its own `node_modules`, so
    // `@argus-agent/*` cannot resolve from it and seven plugins fail to import. The
    // caller passes its own base — the runner's entry is in the consuming workspace,
    // which is where those specifiers DO resolve.
    ...(options.bareModuleBaseUrl === undefined ? {} : { bareModuleBaseUrl: options.bareModuleBaseUrl }),
    // The configuration is the CALLER's, not a generated minimal one: a test that
    // restarts must see the same pricing, budgets and access rules the killed
    // process had. A regenerated file drops the pricing table, and every request
    // then fails as `UNPRICED_MODEL` — a failure that looks like a crash-recovery
    // bug and is a test-harness bug.
    useExistingOpsYaml: true,
    // The whole chain, with `replaceEntries` rather than `entries`: the list must be
    // exact, because a partially-activated tree is what a crash test must not have.
    replaceEntries: [
      ...BASE_ENTRIES,
      persistenceEntry(join(dataDir, 'sessions')),
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'default' } },
      { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
      { id: 'ops-store', name: '@argus-agent/store' },
      { id: 'ops-projects', name: '@argus-agent/projects' },
      { id: 'ops-meter', name: '@argus-agent/meter' },
      { id: 'ops-governor', name: '@argus-agent/governor' },
      OPTIONAL_ENTRIES.commands,
      { id: 'ops-commands', name: '@argus-agent/commands' },
      { id: 'ops-channel', name: '@argus-agent/channel' },
      { id: 'ops-memory', name: '@argus-agent/memory' },
      { id: 'ops-health', name: '@argus-agent/health' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
    ],
    fake,
  })

  const ready = process.env[RUNNER_READY]
  if (ready !== undefined && ready.length > 0) {
    writeFileSync(ready, String(process.pid))
  }

  return {
    boot,
    dataDir,
    async stop(): Promise<void> {
      await boot.dispose()
    },
  }
}

/**
 * Run the stack until the process is killed.
 *
 * The returned promise never resolves on its own: the test kills the process, and
 * that is the point. A rejection exits non-zero, so a test can tell a boot failure
 * from a successful run.
 *
 * @returns a promise that only settles if booting failed.
 */
export async function runUntilKilled(): Promise<void> {
  const handle = await run()
  // Kept referenced so nothing is garbage-collected while the process waits.
  process.on('SIGTERM', () => {
    void handle.stop().finally(() => process.exit(0))
  })
  await new Promise<void>(() => {
    /* the process is killed from outside */
  })
}
