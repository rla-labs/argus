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
export function grantsFor(policy: SandboxPolicy, own: string, node: string): { readOnly: string[]; readWrite: string[] } {
  // A root that does not exist makes the launcher refuse to start.
  const present = (paths: string[]): string[] => [...new Set(paths)].filter((path) => existsSync(path))
  const writable = policy.mode === 'workspace-write'
  return {
    readOnly: present([...SYSTEM_ROOTS, node, ...(writable ? [] : [policy.workspaceRoot, own])]),
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

/** `ctx.sandbox`, with read confinement. */
export default class ArgusSandbox extends SandboxProvider {
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
    const enforcement = this.enforcement()
    if (enforcement === 'unusable') throw new SandboxUnavailableError(policy.mode, 'Landlock is not available on this kernel')
    const resolved = { ...policy, workspaceRoot: canonicalPath(policy.workspaceRoot) }
    // Per workspace, never inside it: a project's caches and temp files are its own,
    // and another project's command cannot read them.
    const own = join(tmpdir(), 'argus-sandbox', createHash('sha256').update(resolved.workspaceRoot).digest('hex').slice(0, 16))
    mkdirSync(own, { recursive: true, mode: 0o700 })
    return {
      argv: [this.launcher, ...grantArgs(grantsFor(resolved, own, this.node)), '--', 'env', `HOME=${own}`, `TMPDIR=${own}`, ...argv],
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
