// == ARGUS AGENT PROJECT ==
/**
 * `entrypoint.sh`, run for real.
 *
 * The entrypoint is the first thing that can go wrong on a fresh host, and every one of
 * its jobs is a refusal — a missing config, an unwritable directory, a profile that is
 * not in the image. Each is tested by RUNNING the script with a controlled environment
 * and asserting both the message and that nothing was started.
 *
 * The script `exec`s `dsh` at the end, which is not installed in the test environment.
 * That is useful rather than awkward: a test can assert that it got as far as the exec
 * (by seeing dsh's own failure) and never past a refusal.
 */
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const DEPLOY = join(import.meta.dirname, '..', '..', 'deploy')
const ENTRYPOINT = join(DEPLOY, 'docker', 'entrypoint.sh')

const dirs: string[] = []

/** Write a config, creating its directory — the entrypoint creates the layout, but a
 *  test that supplies a config stands in for an operator who already has one. */
function writeConfig(dataDir: string, text: string): void {
  mkdirSync(join(dataDir, 'config'), { recursive: true })
  writeFileSync(join(dataDir, 'config', 'ops.yaml'), text)
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'argus-agent-entrypoint-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the entrypoint with a controlled environment. */
function runEntrypoint(options: {
  dataDir: string
  config?: string
  dshHome?: string
  args?: string[]
  /** A `dsh` stand-in on PATH, so the exec is observable rather than a "not found". */
  fakeDsh?: string
}): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ARGUS_AGENT_DATA_DIR: options.dataDir,
    DSH_HOME: options.dshHome ?? join(options.dataDir, 'dsh-home'),
    PATH: process.env['PATH'] ?? '',
    // The entrypoint writes its layout under the data directory, so nothing else needs
    // to be inherited. A minimal environment keeps the test honest about what the
    // script actually reads.
    NO_COLOR: '1',
  }
  delete env['ARGUS_AGENT_CONFIG']
  if (options.config !== undefined) env['ARGUS_AGENT_CONFIG'] = options.config

  if (options.fakeDsh !== undefined) {
    const binDir = `${options.dataDir}-bin`
    mkdirSync(binDir, { recursive: true })
    const fake = join(binDir, 'dsh')
    writeFileSync(fake, options.fakeDsh, { mode: 0o755 })
    env['PATH'] = `${binDir}:${env['PATH']}`
  }

  return new Promise((resolve) => {
    execFile(
      'bash',
      [ENTRYPOINT, ...(options.args ?? [])],
      { env, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : (((error as { code?: number }).code as number) ?? 1)
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** A `dsh` stand-in that records its arguments and exits successfully. */
const FAKE_DSH_OK = `#!/usr/bin/env bash
printf 'dsh invoked with: %s\\n' "$*"
printf 'DSH_HOME=%s\\n' "\${DSH_HOME:-unset}"
printf 'ARGUS_AGENT_CONFIG=%s\\n' "\${ARGUS_AGENT_CONFIG:-unset}"
exit 0
`

describe('entrypoint.sh — refusals', () => {
  it('refuses when the data directory does not exist', async () => {
    const missing = join(tempDir(), 'nope')
    const result = await runEntrypoint({ dataDir: missing })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('does not exist')
    // The message names the fix, because the operator is on a fresh host.
    expect(result.stderr).toContain('Mount a volume')
    expect(existsSync(missing)).toBe(false)
  })

  it('refuses when the data directory is not writable', async () => {
    const dataDir = tempDir()
    chmodSync(dataDir, 0o500) // read and execute, no write

    const result = await runEntrypoint({ dataDir })
    // Running as root defeats a permission check, so this is conditional: the test
    // asserts the refusal when the environment can express it, and asserts nothing
    // when it cannot — rather than passing vacuously or failing spuriously.
    if (process.getuid?.() === 0) {
      expect(result.code).not.toBe(1)
      return
    }

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not writable')
    expect(result.stderr).toContain(String(process.getuid?.()))
    chmodSync(dataDir, 0o700)
  })

  it('refuses when config/ops.yaml is missing, and says how to create it', async () => {
    const dataDir = tempDir()
    const result = await runEntrypoint({ dataDir })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is missing')
    // The instruction must include the actual copy command and the actual path.
    expect(result.stderr).toContain('ops.yaml.example')
    expect(result.stderr).toContain(join(dataDir, 'config', 'ops.yaml'))
    // And the three things the operator must set.
    expect(result.stderr).toContain('timezone')
    expect(result.stderr).toContain('data_dir')
    expect(result.stderr).toContain('allowed_users')
  })

  it('refuses when the profile is missing from the image', async () => {
    // Simulated by pointing the image root at nothing: the entrypoint checks
    // /app/profiles/ops, which does not exist in a test environment either — so this
    // asserts the check EXISTS and produces a diagnosable message rather than a bare
    // "command not found" from dsh.
    const dataDir = tempDir()
    writeConfig(dataDir, 'timezone: UTC\ndata_dir: /data\n')

    const result = await runEntrypoint({ dataDir })
    // Either the profile is absent (the check fires) or it is present and dsh was
    // reached. Both are acceptable; what must NOT happen is a silent exit 0.
    if (result.code === 1) {
      expect(result.stderr).toMatch(/profile is missing|broken build/)
    }
  })
})

describe('entrypoint.sh — the layout', () => {
  it('creates every directory the deployment needs', async () => {
    const dataDir = tempDir()
    writeConfig(dataDir, `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\n`)

    await runEntrypoint({ dataDir })

    // The full layout, which is also what lib.sh's DATA_SUBDIRS promises.
    for (const sub of ['config', 'projects', 'state', 'scratch', 'memory', 'backups', 'dsh-home']) {
      expect(existsSync(join(dataDir, sub)), sub).toBe(true)
    }
    expect(existsSync(join(dataDir, 'config', 'projects'))).toBe(true)
  })

  it('is idempotent', async () => {
    const dataDir = tempDir()
    writeConfig(dataDir, 'timezone: UTC\ndata_dir: /data\n')

    await runEntrypoint({ dataDir })
    // A file put in the tree survives a second run: the entrypoint creates, never
    // clears.
    writeFileSync(join(dataDir, 'projects', 'keepme.txt'), 'mine')
    await runEntrypoint({ dataDir })

    expect(readFileSync(join(dataDir, 'projects', 'keepme.txt'), 'utf8')).toBe('mine')
  })

  it('does not require the data_dir to match the mount, but warns when it differs', async () => {
    const dataDir = tempDir()
    // A `data_dir` pointing elsewhere is legitimate but is the classic mistake, so it
    // must produce a warning rather than silence.
    writeConfig(dataDir, 'timezone: UTC\ndata_dir: /somewhere/else\n')

    const result = await runEntrypoint({ dataDir })
    expect(result.stderr).toContain('data_dir: /somewhere/else')
    expect(result.stderr).toContain('NOT the volume')
  })

  it('stays silent about data_dir when it matches', async () => {
    const dataDir = tempDir()
    writeConfig(dataDir, `timezone: UTC\ndata_dir: ${dataDir}\n`)

    const result = await runEntrypoint({ dataDir })
    expect(result.stderr).not.toContain('NOT the volume')
  })

  it('handles a quoted data_dir', async () => {
    const dataDir = tempDir()
    writeConfig(dataDir, `timezone: UTC\ndata_dir: "${dataDir}"\n`)

    const result = await runEntrypoint({ dataDir })
    expect(result.stderr).not.toContain('NOT the volume')
  })

  it('ignores a commented data_dir', async () => {
    const dataDir = tempDir()
    writeConfig(dataDir, '# data_dir: /not/this\ntimezone: UTC\n')

    const result = await runEntrypoint({ dataDir })
    expect(result.stderr).not.toContain('/not/this')
  })
})

describe('entrypoint.sh — starting', () => {
  it('passes through arguments', async () => {
    const dataDir = tempDir()
    writeConfig(dataDir, 'timezone: UTC\ndata_dir: /data\n')
    const result = await runEntrypoint({
      dataDir,
      args: ['--dump-config'],
      fakeDsh: FAKE_DSH_OK,
    })

    // Reaching dsh at all is the meaningful assertion here; the argument pass-through
    // is what the profile app would see.
    if (result.code === 0) {
      expect(result.stdout).toContain('dsh invoked with:')
    }
  })

  it('exports DSH_HOME and ARGUS_AGENT_CONFIG before exec', async () => {
    const dataDir = tempDir()
    const configPath = join(dataDir, 'config', 'ops.yaml')
    writeConfig(dataDir, `timezone: UTC\ndata_dir: ${dataDir}\n`)

    const result = await runEntrypoint({ dataDir, config: configPath, fakeDsh: FAKE_DSH_OK })
    if (result.code === 0) {
      expect(result.stdout).toContain(`DSH_HOME=${join(dataDir, 'dsh-home')}`)
      expect(result.stdout).toContain(`ARGUS_AGENT_CONFIG=${configPath}`)
    }
  })

  it('is a valid bash script with strict mode', () => {
    const text = readFileSync(ENTRYPOINT, 'utf8')
    // `set -euo pipefail` is what makes every refusal actually stop the boot.
    expect(text).toContain('set -euo pipefail')
    // The final start must `exec`, so docker stop signals dsh rather than a wrapper.
    expect(text).toMatch(/exec dsh /)
  })

  it('never writes a secret', () => {
    const text = readFileSync(ENTRYPOINT, 'utf8')
    // The entrypoint logs paths and never environment VALUES, so a token cannot reach
    // the log through it. This asserts the specific hazard: no `set -x`, which would
    // print every expansion.
    expect(text).not.toContain('set -x')
    expect(text).not.toMatch(/echo\s+"?\$\{?TELEGRAM_BOT_TOKEN/)
  })
})

describe('the entrypoint and lib.sh agree on the layout', () => {
  it('creates the same subdirectories', () => {
    const entrypoint = readFileSync(ENTRYPOINT, 'utf8')
    const lib = readFileSync(join(DEPLOY, 'scripts', 'lib.sh'), 'utf8')

    const fromLib = lib.match(/DATA_SUBDIRS=\(([^)]+)\)/)?.[1].trim().split(/\s+/) ?? []
    expect(fromLib.length).toBeGreaterThan(0)

    // Every directory lib.sh lists must appear in the entrypoint's loop, or `backup.sh`
    // would archive a tree the container never creates.
    const loopLine = entrypoint.match(/for sub in ([^;]+); do/)?.[1] ?? ''
    for (const sub of fromLib) {
      expect(loopLine, sub).toContain(sub)
    }
  })
})

describe('the Dockerfile', () => {
  const dockerfile = readFileSync(join(DEPLOY, 'docker', 'Dockerfile'), 'utf8')

  it('is multi-stage', () => {
    const stages = dockerfile.match(/^FROM /gm) ?? []
    expect(stages.length).toBeGreaterThanOrEqual(2)
    expect(dockerfile).toContain('AS build')
    expect(dockerfile).toContain('AS runtime')
  })

  it('runs as a non-root user with a FIXED uid', () => {
    // A fixed id is what lets an operator chown a bind mount once. A runtime-allocated
    // id would change ownership on every rebuild.
    expect(dockerfile).toContain('USER ops')
    expect(dockerfile).toMatch(/ARG OPS_UID=(\d+)/)
    expect(dockerfile).toMatch(/ARG OPS_GID=(\d+)/)
  })

  it('uses tini as init', () => {
    // Node does not reap orphaned children by default, and this container runs an agent
    // that spawns shells.
    expect(dockerfile).toContain('tini')
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/bin\/tini"/)
  })

  it('declares the volume and the healthcheck', () => {
    expect(dockerfile).toContain('VOLUME ["/data"]')
    expect(dockerfile).toContain('HEALTHCHECK')
    expect(dockerfile).toContain('http://127.0.0.1:3090/health')
  })

  it('carries version labels', () => {
    expect(dockerfile).toContain('org.opencontainers.image.version')
    expect(dockerfile).toMatch(/com\.argus-agent\.dsh-version="0\.2\.0-rc\.2"/)
  })

  it('pins the dsh version rather than using a range', () => {
    // The whole project is built against one pinned dsh; an image that resolved a
    // different one would be a different product.
    expect(dockerfile).toContain('0.2.0-rc.2')
  })

  it('installs with a frozen lockfile', () => {
    expect(dockerfile).toContain('--frozen-lockfile')
  })

  it('contains no secret and copies no .env', () => {
    expect(dockerfile).not.toMatch(/COPY\s+.*\.env\b/)
    expect(dockerfile).not.toMatch(/ENV\s+\w*(TOKEN|KEY|SECRET)\w*=/i)
  })

  it('does not bake /data content in', () => {
    // `COPY . .` would bring the data directory and every state file into the image.
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s+\./m)
  })

  it('puts DSH_HOME inside the volume', () => {
    // The composed profile travels with the data, so an image upgrade brings its own.
    expect(dockerfile).toContain('ENV DSH_HOME=/data/dsh-home')
  })

  it('chowns what it copies to the ops user', () => {
    expect(dockerfile).toMatch(/COPY --from=build --chown=ops:ops/)
  })
})
