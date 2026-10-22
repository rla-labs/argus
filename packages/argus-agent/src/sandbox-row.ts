// == ARGUS AGENT PROJECT ==
/**
 * The sandbox row: `ctx.sandbox`, confining what an agent's shell may READ as well as write.
 *
 * dsh's own provider (`dsh-sandbox-local`) confines writes only: its Landlock profile
 * grants read on `/`. An agent's `bash` could then read the database, every other
 * project's folder, every conversation and the credential store. This provider
 * implements the same seam with the same launcher, granting instead:
 *
 * - read: the system roots and the Node install;
 * - read (and write, under `workspace-write`): the session's workspace;
 * - a private home and temp folder per workspace, outside it;
 * - `/dev/null`.
 *
 * Nothing else: not the data directory, not the application. The row replaces the
 * base bundle's `sandbox` row. Without Landlock it fails closed, as dsh's does.
 *
 * @module @argus-agent/argus-agent/sandbox-row
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError, canonicalPath, type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LAUNCHER_BIN, LAUNCHER_FAILURE_EXIT, grantArgs, launcherPath, probe, type LandlockEnforcement } from '@deepseek-ai/node-addon-system/landlock-run'
import type { DoctorFinding } from '@argus-agent/types'

/**
 * What every confined command may read: the programs, their libraries and settings, and
 * the kernel's views. `/proc` is safe to grant: Landlock refuses a confined process
 * another process's `environ`, so the service's keys stay out of reach.
 */
const SYSTEM_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt', '/proc', '/sys', '/dev']

/**
 * The read and write grants for one confined call.
 *
 * @param policy the call's policy; its workspace is already canonical.
 * @param own the workspace's private home and temp folder.
 * @param node the Node install's prefix, so `node` and `npm` run.
 * @returns the launcher's grants.
 */
export function grantsFor(policy: SandboxPolicy, own: string, node: string, reads: readonly string[] = []): { readOnly: string[]; readWrite: string[] } {
  // A root that does not exist makes the launcher refuse to start.
  const present = (paths: string[]): string[] => [...new Set(paths)].filter((path) => existsSync(path))
  const writable = policy.mode === 'workspace-write'
  return {
    readOnly: present([...SYSTEM_ROOTS, node, ...reads, ...(writable ? [] : [policy.workspaceRoot, own])]),
    readWrite: present(['/dev/null', ...(writable ? [policy.workspaceRoot, own] : [])]),
  }
}

/** Landlock's error for a denied file effect. */
const DENIAL_SIGNATURES = ['permission denied']

/** The launcher's own failures, so a broken sandbox is not mistaken for a denied command. */
const RUNNER_FAILURE_RULES = [
  {
    allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
    fatalSignatures: [`${LAUNCHER_BIN}: `],
    informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`],
  },
]

/**
 * What a workspace's commands get beyond the defaults: the folders of the extensions
 * its project enabled (read and run), their programs on PATH, their variables.
 */
export interface WorkspaceExtras {
  readonly reads: readonly string[]
  readonly path: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** `ctx.sandbox`, with read confinement. */
export default class ArgusSandbox extends SandboxProvider {
  private extrasOf: ((workspaceRoot: string) => WorkspaceExtras | undefined) | undefined

  /**
   * Who says what a workspace's commands get beyond the defaults: `ops-projects`, from
   * the project's enabled extensions.
   *
   * @returns the undo.
   */
  setWorkspaceExtras(extras: (workspaceRoot: string) => WorkspaceExtras | undefined): () => void {
    this.extrasOf = extras
    return () => {
      if (this.extrasOf === extras) this.extrasOf = undefined
    }
  }

  private readonly launcher = launcherPath()
  private verdict: LandlockEnforcement | undefined
  private readonly node = dirname(dirname(process.execPath))

  constructor(ctx: Context) {
    super(ctx)
  }

  /** Probed once, on first use: what this kernel enforces. */
  private enforcement(): LandlockEnforcement {
    this.verdict ??= probe(this.launcher, { timeoutMs: 5_000 })
    return this.verdict
  }

  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    return this.confineReading(argv, policy, [])
  }

  /**
   * `confine`, with more folders to read: an extension's MCP server reads its own
   * install, and works in the project's folder.
   *
   * @param argv the command.
   * @param policy the mode and the workspace (read and write under `workspace-write`).
   * @param reads more folders it may read.
   * @param home a home of its own, outside the workspace, instead of the one every
   *   command of that workspace shares: an MCP server keeps its logins and caches there,
   *   where the agent's shell cannot read them. Created `0700`; the XDG folders point
   *   into it.
   * @returns the wrapped command.
   * @throws {SandboxUnavailableError} without Landlock.
   */
  async confineReading(argv: readonly string[], policy: SandboxPolicy, reads: readonly string[], home?: string): Promise<ConfinedArgv> {
    const enforcement = this.enforcement()
    if (enforcement === 'unusable') throw new SandboxUnavailableError(policy.mode, 'Landlock is not available on this kernel')
    const resolved = { ...policy, workspaceRoot: canonicalPath(policy.workspaceRoot) }
    // Per workspace, never inside it: a project's caches and temp files are its own,
    // and another project's command cannot read them.
    const own = home ?? join(tmpdir(), 'argus-sandbox', createHash('sha256').update(resolved.workspaceRoot).digest('hex').slice(0, 16))
    mkdirSync(own, { recursive: true, mode: 0o700 })
    const xdg = home === undefined ? [] : [`XDG_CONFIG_HOME=${own}/.config`, `XDG_DATA_HOME=${own}/.local/share`, `XDG_STATE_HOME=${own}/.local/state`, `XDG_CACHE_HOME=${own}/.cache`]
    const extras = this.extrasOf?.(resolved.workspaceRoot)
    // An extension's programs go before the inherited PATH, which only the shell knows.
    const path = extras === undefined || extras.path.length === 0 ? [] : [`ARGUS_EXTENSION_PATH=${extras.path.join(':')}`, 'sh', '-c', 'export PATH="$ARGUS_EXTENSION_PATH:$PATH"; exec "$@"', 'argus']
    const env = Object.entries(extras?.env ?? {}).map(([key, value]) => `${key}=${value}`)
    return {
      argv: [this.launcher, ...grantArgs(grantsFor(resolved, own, this.node, [...reads, ...(extras?.reads ?? [])])), '--', 'env', ...env, `HOME=${own}`, `TMPDIR=${own}`, ...xdg, ...path, ...argv],
      enforcement,
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }

  /**
   * `argus doctor`: whether commands run confined.
   *
   * @returns one finding.
   */
  doctor(): DoctorFinding[] {
    const check = 'the command sandbox'
    switch (this.enforcement()) {
      case 'full':
        return [{ ok: true, check, detail: 'Landlock: a project reads and writes only its own folder' }]
      case 'partial':
        return [{ ok: true, check, detail: 'Landlock (older kernel): partly enforced', warn: true }]
      default:
        return [{ ok: false, check, detail: 'Landlock is not available: agents cannot run commands', fix: 'use a kernel 5.13 or newer with Landlock enabled (lsm=…,landlock)' }]
    }
  }
}
