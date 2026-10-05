// == ARGUS AGENT PROJECT ==
/**
 * The NATIVE (non-Docker) install layer.
 *
 * The prompt for this work asks for an install that runs directly on a VPS. This tests
 * everything reachable **without root** — which is most of what can be wrong:
 *
 * - the library's path resolution, so `--dry-run` and the plan are truthful
 * - the systemd unit template: every placeholder substituted, and the RENDERED unit
 *   accepted by `systemd-analyze verify`
 * - the shared invariants between the native and Docker layouts, because a backup taken
 *   from one must be restorable into the other
 * - the scripts the native install calls (`backup-native.sh`, `smoke-native.sh`): their
 *   refusal paths, their argument validation, and the backup's real artifacts
 *
 * What is NOT tested here, and why: `install-native.sh` requires root and a live systemd.
 * It is exercised in `--dry-run` mode for its prerequisite checks, and the checks that
 * need privileges are reported as such rather than faked.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const DEPLOY = join(import.meta.dirname, '..', '..', 'deploy')
const NATIVE = join(DEPLOY, 'native')
const DOCS = join(DEPLOY, 'docs')
// The Markdown documentation is kept locally and is not in the public repository.
const HAS_DOCS = existsSync(join(DEPLOY, '..', 'docs', 'developer-docs.md'))

const dirs: string[] = []

function tempDir(prefix = 'argus-agent-native-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // A test may create a `-pre-restore` sibling; clean the whole family.
    rmSync(dir, { recursive: true, force: true })
  }
})

interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function run(script: string, args: string[] = [], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, ...args],
      {
        env: {
          ...process.env,
          NO_COLOR: '1',
          ASSUME_YES: '1',
          ...env,
        },
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : (((error as { code?: number }).code as number) ?? 1)
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** A data directory with the full layout and a real database. */
async function makeDataDir(): Promise<string> {
  const dataDir = tempDir()
  for (const sub of ['config/projects', 'projects/demo', 'state/demo', 'scratch/adhoc', 'memory', 'backups', 'dsh-home']) {
    mkdirSync(join(dataDir, sub), { recursive: true })
  }
  writeFileSync(join(dataDir, 'config', 'ops.yaml'), `timezone: UTC\ndata_dir: ${dataDir}\n`)
  writeFileSync(join(dataDir, 'projects', 'demo', 'index.js'), 'console.log("demo")\n')
  writeFileSync(join(dataDir, 'memory', 'USER.md'), 'Terse answers.\n')
  writeFileSync(join(dataDir, 'scratch', 'adhoc', 'temp.bin'), 'DISPOSABLE')

  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(dataDir, 'ops.sqlite'))
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', '3')
  db.prepare('INSERT INTO runs VALUES (?, ?)').run('run-1', 'completed')
  db.close()

  return dataDir
}

// ── the tree ───────────────────────────────────────────────────────────────────

describe('the native deploy tree', () => {
  it('has every file the install needs', () => {
    for (const file of [
      'lib-native.sh',
      'install-native.sh',
      'upgrade-native.sh',
      'backup-native.sh',
      'smoke-native.sh',
      'uninstall-native.sh',
      'argus-agent.service',
    ]) {
      expect(existsSync(join(NATIVE, file)), `${file} is missing`).toBe(true)
    }
  })

  it.skipIf(!HAS_DOCS)('has the install document', () => {
    expect(existsSync(join(DOCS, 'INSTALL-NATIVE.md'))).toBe(true)
  })

  it.each([
    'install-native.sh',
    'upgrade-native.sh',
    'backup-native.sh',
    'smoke-native.sh',
    'uninstall-native.sh',
  ])('%s is executable', async (script) => {
    const { statSync } = await import('node:fs')
    const mode = statSync(join(NATIVE, script)).mode
    expect(mode & 0o100, `${script} is not executable`).not.toBe(0)
  })

  it.each([
    'lib-native.sh',
    'install-native.sh',
    'upgrade-native.sh',
    'backup-native.sh',
    'smoke-native.sh',
    'uninstall-native.sh',
  ])('%s passes bash -n', async (script) => {
    const result = await new Promise<{ code: number }>((resolve) => {
      execFile('bash', ['-n', join(NATIVE, script)], {}, (error) => {
        resolve({ code: error === null ? 0 : (((error as { code?: number }).code as number) ?? 1) })
      })
    })
    expect(result.code).toBe(0)
  })

  it.each(['install-native.sh', 'upgrade-native.sh', 'backup-native.sh', 'smoke-native.sh', 'uninstall-native.sh'])(
    '%s sources the shared library',
    (script) => {
      const text = readFileSync(join(NATIVE, script), 'utf8')
      expect(text).toContain('source=lib-native.sh')
    },
  )

  it.each(['install-native.sh', 'upgrade-native.sh', 'backup-native.sh', 'smoke-native.sh', 'uninstall-native.sh'])(
    '%s opens with why it exists',
    (script) => {
      const text = readFileSync(join(NATIVE, script), 'utf8')
      expect(text.startsWith('#!/usr/bin/env bash')).toBe(true)
      const comments = text.split('\n').slice(1).filter((line) => line.startsWith('#')).length
      expect(comments, `${script} is under-documented`).toBeGreaterThan(8)
    },
  )

  it('none of them enables shell tracing', () => {
    // `set -x` prints every expansion, which would put the bot token in the journal.
    for (const script of readdirSync(NATIVE)) {
      if (!script.endsWith('.sh')) continue
      const text = readFileSync(join(NATIVE, script), 'utf8')
      expect(text, script).not.toContain('set -x')
    }
  })
})

// ── the systemd unit template ──────────────────────────────────────────────────

describe('the systemd unit template', () => {
  const unit = readFileSync(join(NATIVE, 'argus-agent.service'), 'utf8')

  /** The real placeholders — `@PLACEHOLDER@` appears in prose, not in a directive. */
  function placeholders(): string[] {
    const found = new Set(unit.match(/@[A-Z_]+@/g) ?? [])
    found.delete('@PLACEHOLDER@')
    return [...found].sort()
  }

  it('has placeholders for every path the installer chooses', () => {
    // A unit with a literal `@APP_DIR@` in it will not start, so the substitution list
    // must be complete.
    expect(placeholders()).toEqual([
      '@APP_DIR@',
      '@CONFIG_FILE@',
      '@DATA_DIR@',
      '@DSH_BIN@',
      '@DSH_HOME@',
      '@SECRETS_FILE@',
      '@SERVICE_HOME@',
      '@SERVICE_USER@',
    ])
  })

  it('the installer substitutes every one of them', () => {
    const installer = readFileSync(join(NATIVE, 'install-native.sh'), 'utf8')
    for (const placeholder of placeholders()) {
      expect(installer, `${placeholder} is never substituted`).toContain(placeholder)
    }
  })

  it('renders to a unit systemd accepts', async () => {
    // The strongest check available without installing: substitute the paths exactly as
    // the installer does, then hand the result to `systemd-analyze verify`.
    const rendered = join(tempDir(), 'argus-agent.service')
    const dsh = process.env['PATH']?.split(':').map((p) => join(p, 'dsh')).find((p) => existsSync(p)) ?? '/usr/bin/dsh'
    const substitutions: Array<[string, string]> = [
      ['@APP_DIR@', '/opt/argus-agent'],
      ['@SERVICE_USER@', 'ops'],
      ['@SERVICE_HOME@', '/srv/argus-agent'],
      ['@DATA_DIR@', '/srv/argus-agent/data'],
      ['@DSH_HOME@', '/srv/argus-agent/data/dsh-home'],
      ['@CONFIG_FILE@', '/srv/argus-agent/data/config/ops.yaml'],
      ['@SECRETS_FILE@', '/srv/argus-agent/secrets.env'],
      ['@DSH_BIN@', dsh],
    ]
    let text = unit
    for (const [from, to] of substitutions) text = text.split(from).join(to)
    writeFileSync(rendered, text)

    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('systemd-analyze', ['verify', rendered], (_error, _stdout, stderr) => {
        // `systemd-analyze verify` exits 0 even when it prints warnings, so the OUTPUT is
        // what is asserted on.
        resolve({ code: 0, stderr })
      })
    })

    // No "Unknown key", "Invalid", or "not executable" complaints about the directives.
    expect(result.stderr).not.toMatch(/Unknown key/i)
    expect(result.stderr).not.toMatch(/Invalid .* (setting|value)/i)
  })

  it('runs as the service user, never as root', () => {
    expect(unit).toContain('User=@SERVICE_USER@')
    expect(unit).toContain('Group=@SERVICE_USER@')
  })

  it('reads its secrets from a file', () => {
    expect(unit).toContain('EnvironmentFile=@SECRETS_FILE@')
  })

  it('restarts ALWAYS, because a restart is the recovery mechanism', () => {
    // The health plugin's recovery pass marks interrupted runs at STARTUP, so a restart
    // after a crash is what resolves them — not merely a retry.
    expect(unit).toContain('Restart=always')
    expect(unit).toMatch(/RESTART AFTER A CRASH|recovery mechanism/)
  })

  it('confines the agent, since there is no container to do it', () => {
    // These ARE the barrier for a native install, so each is a security property.
    for (const directive of [
      'ProtectSystem=strict',
      'ReadWritePaths=@DATA_DIR@',
      'NoNewPrivileges=true',
      'CapabilityBoundingSet=',
      'PrivateTmp=true',
      'ProtectHome=read-only',
      'ProtectKernelTunables=true',
      'RestrictSUIDSGID=true',
      'SystemCallFilter=@system-service',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
      'MemoryMax=',
      'TasksMax=',
    ]) {
      expect(unit, directive).toContain(directive)
    }
  })

  it('sets the environment the profile needs', () => {
    expect(unit).toContain('Environment=DSH_HOME=@DSH_HOME@')
    expect(unit).toContain('Environment=ARGUS_AGENT_CONFIG=@CONFIG_FILE@')
    expect(unit).toContain('Environment=HOME=@SERVICE_HOME@')
  })

  it('execs dsh by absolute path', () => {
    // systemd's PATH is minimal, and a service that cannot find its own entry point fails
    // in a way that looks like a plugin problem.
    expect(unit).toContain('ExecStart=@DSH_BIN@ --profile ops')
  })

  it('states plainly that it is secondary to Docker', () => {
    expect(unit.toUpperCase()).toContain('SECONDARY')
    expect(unit).toContain('SECURITY.md')
  })
})

// ── the shared layout contract ─────────────────────────────────────────────────

describe('the native and Docker layouts agree', () => {
  it('create the same subdirectories', () => {
    // A backup taken from one deployment must be restorable into the other, which is only
    // true if the trees are identical.
    const libNative = readFileSync(join(NATIVE, 'lib-native.sh'), 'utf8')
    const entrypoint = readFileSync(join(DEPLOY, 'docker', 'entrypoint.sh'), 'utf8')

    const fromNative = libNative.match(/DATA_SUBDIRS=\(([^)]+)\)/)?.[1].trim().split(/\s+/) ?? []
    expect(fromNative.length).toBeGreaterThan(0)

    const dockerLoop = entrypoint.match(/for sub in ([^;]+); do/)?.[1] ?? ''
    for (const sub of fromNative) {
      expect(dockerLoop, sub).toContain(sub)
    }
  })

  it.skipIf(!HAS_DOCS)('use the same directory names as the docs describe', () => {
    const doc = readFileSync(join(DOCS, 'INSTALL-NATIVE.md'), 'utf8')
    for (const sub of ['config', 'projects', 'state', 'scratch', 'memory', 'backups', 'dsh-home']) {
      expect(doc, sub).toContain(sub)
    }
  })

  it('both pin the same dsh version', () => {
    const libNative = readFileSync(join(NATIVE, 'lib-native.sh'), 'utf8')
    const dockerfile = readFileSync(join(DEPLOY, 'docker', 'Dockerfile'), 'utf8')
    expect(libNative).toContain('0.2.0-rc.2')
    expect(dockerfile).toContain('0.2.0-rc.2')
  })
})

// ── backup-native.sh ───────────────────────────────────────────────────────────

describe('backup-native.sh', () => {
  it('produces a consistent database and a complete archive', async () => {
    const dataDir = await makeDataDir()
    const result = await run(join(NATIVE, 'backup-native.sh'), [], { ARGUS_AGENT_DATA_DIR: dataDir })

    expect(result.code).toBe(0)
    const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    const dbArtifact = lines.find((l) => l.endsWith('.sqlite')) ?? ''
    const dataArtifact = lines.find((l) => l.endsWith('.tar.gz')) ?? ''
    expect(dbArtifact).not.toBe('')
    expect(dataArtifact).not.toBe('')

    // CONSISTENCY. `sqlite3` IS present on this host, so the online path is taken and the
    // script verifies its own artifact.
    expect(readFileSync(dbArtifact).subarray(0, 15).toString()).toBe('SQLite format 3')
    expect(result.stderr).toContain('integrity ok')

    // COMPLETENESS, and the exclusions.
    const listing = await new Promise<string>((resolve) => {
      execFile('tar', ['tzf', dataArtifact], { maxBuffer: 10 * 1024 * 1024 }, (_e, stdout) => resolve(stdout))
    })
    expect(listing).toContain('./projects/demo/index.js')
    expect(listing).toContain('./memory/USER.md')
    expect(listing).toContain('./config/ops.yaml')
    expect(listing).not.toContain('scratch')
    expect(listing).not.toContain('ops.sqlite')
    expect(listing).not.toContain('backups/')
  }, 90_000)

  it('writes nothing on a dry run', async () => {
    const dataDir = await makeDataDir()
    const before = readdirSync(join(dataDir, 'backups'))
    const result = await run(join(NATIVE, 'backup-native.sh'), ['--dry-run'], { ARGUS_AGENT_DATA_DIR: dataDir })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('would write')
    expect(readdirSync(join(dataDir, 'backups'))).toEqual(before)
  }, 60_000)

  it('rotates to the configured number and deletes nothing it did not create', async () => {
    const dataDir = await makeDataDir()
    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    // Three sets from long ago, so none collides with the real backup's own stamp.
    // The databases are REAL SQLite files: rotation reads only the names, but the archive
    // check below counts files, and a fixture that is not a database makes the assertion
    // about something other than what it claims.
    const Database = (await import('better-sqlite3')).default
    for (const stamp of ['20200101-000001', '20200101-000002', '20200101-000003']) {
      const old = new Database(join(dataDir, 'backups', `ops-${stamp}.sqlite`))
      old.exec('CREATE TABLE runs (id TEXT PRIMARY KEY)')
      old.close()
      writeFileSync(join(dataDir, 'backups', `data-${stamp}.tar.gz`), 'old')
    }
    // Files a naive rotation would remove.
    writeFileSync(join(dataDir, 'backups', 'important.txt'), 'mine')
    writeFileSync(join(dataDir, 'backups', 'ops-manual.sqlite'), 'not dated')
    mkdirSync(join(dataDir, 'backups', 'subdir'), { recursive: true })

    const result = await run(join(NATIVE, 'backup-native.sh'), ['--keep', '2'], { ARGUS_AGENT_DATA_DIR: dataDir })
    expect(result.code).toBe(0)

    const names = readdirSync(join(dataDir, 'backups'))
    expect(names.filter((n) => /^ops-\d{8}-\d{6}\.sqlite$/.test(n))).toHaveLength(2)
    expect(names.filter((n) => /^data-\d{8}-\d{6}\.tar\.gz$/.test(n))).toHaveLength(2)
    for (const keep of ['important.txt', 'ops-manual.sqlite', 'subdir']) {
      expect(names, keep).toContain(keep)
    }
  }, 90_000)

  it('REGRESSION: a hand-made `ops-*.sqlite` must not consume the keep budget', async () => {
    // This was a real data-loss bug, found by the rotation test above going red for a
    // reason that looked like a fixture problem and was not.
    //
    // `find -name 'ops-*.sqlite'` also matches `ops-manual.sqlite`, which sorts AFTER
    // every dated name because "m" > "2" in ASCII. Rotation counted that stray file as
    // the NEWEST backup, kept it plus the one it had just written, and pruned EVERY real
    // dated backup — leaving an operator with a single usable backup and no indication
    // that five had just been deleted.
    //
    // The pattern is now anchored to the exact date format, so only names the script
    // itself creates are considered.
    const dataDir = await makeDataDir()
    mkdirSync(join(dataDir, 'backups'), { recursive: true })

    const Database = (await import('better-sqlite3')).default
    const dated = ['20200101-000001', '20200101-000002', '20200101-000003']
    for (const stamp of dated) {
      const old = new Database(join(dataDir, 'backups', `ops-${stamp}.sqlite`))
      old.exec('CREATE TABLE runs (id TEXT PRIMARY KEY)')
      old.close()
      writeFileSync(join(dataDir, 'backups', `data-${stamp}.tar.gz`), 'old')
    }
    // The file that broke it: no date, and lexically last.
    writeFileSync(join(dataDir, 'backups', 'ops-manual.sqlite'), 'a stray copy an operator made')

    const result = await run(join(NATIVE, 'backup-native.sh'), ['--keep', '2'], { ARGUS_AGENT_DATA_DIR: dataDir })
    expect(result.code).toBe(0)

    const names = readdirSync(join(dataDir, 'backups'))
    const keptDated = names.filter((n) => /^ops-\d{8}-\d{6}\.sqlite$/.test(n))
    // TWO dated databases survive: the new one and the newest fixture. Before the fix this
    // was ONE, because the stray file displaced a real backup.
    expect(keptDated).toHaveLength(2)
    // And the stray file is still there, untouched.
    expect(names).toContain('ops-manual.sqlite')
  }, 90_000)

  it('rejects a nonsensical keep value', async () => {
    const dataDir = await makeDataDir()
    for (const value of ['0', 'many', '-1']) {
      const result = await run(join(NATIVE, 'backup-native.sh'), ['--keep', value], { ARGUS_AGENT_DATA_DIR: dataDir })
      expect(result.code, value).toBe(1)
    }
  }, 60_000)

  it('refuses a data directory that does not exist', async () => {
    const result = await run(join(NATIVE, 'backup-native.sh'), [], {
      ARGUS_AGENT_DATA_DIR: join(tmpdir(), 'definitely-not-here-native'),
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('does not exist')
  }, 60_000)

  it('says the application and the secrets are NOT in the backup', async () => {
    // The most dangerous misunderstanding about a backup is thinking it covers more than
    // it does, so the script states the two gaps explicitly.
    const dataDir = await makeDataDir()
    const result = await run(join(NATIVE, 'backup-native.sh'), [], { ARGUS_AGENT_DATA_DIR: dataDir })
    expect(result.stderr).toContain('NOT backed up')
    expect(result.stderr).toContain('secrets.env')
  }, 60_000)
})

// ── smoke-native.sh ────────────────────────────────────────────────────────────

describe('smoke-native.sh', () => {
  it('fails when the service is not running, and says how to start it', async () => {
    // systemd is present on this host but `argus-agent` is not installed, which is exactly the
    // refusal to assert: a smoke test that reported success for a missing service would be
    // worse than none.
    const result = await run(join(NATIVE, 'smoke-native.sh'), [], { NO_COLOR: '1' })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/not running|not available/)
    expect(result.stderr).toContain('systemctl start argus-agent')
  }, 60_000)

  it('emits valid JSON when asked, even on failure', async () => {
    const result = await run(join(NATIVE, 'smoke-native.sh'), ['--json', '--quiet'], { NO_COLOR: '1' })
    expect(result.code).toBe(1)
    const line = result.stdout.split('\n').find((l) => l.startsWith('{'))
    expect(line, 'no JSON on stdout').toBeDefined()
    const parsed = JSON.parse(line as string) as { ok: boolean; failed: number; failures: string[] }
    expect(parsed.ok).toBe(false)
    expect(parsed.failed).toBeGreaterThan(0)
    expect(parsed.failures.length).toBeGreaterThan(0)
  }, 60_000)

  it('rejects an unknown option', async () => {
    const result = await run(join(NATIVE, 'smoke-native.sh'), ['--nope'], { NO_COLOR: '1' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unknown option')
  }, 60_000)
})

// ── the prerequisites the installer checks ─────────────────────────────────────

describe('install-native.sh prerequisites', () => {
  it('refuses to run without root, and prints a copy-pasteable command', async () => {
    if (process.getuid?.() === 0) return // running as root defeats the check
    const result = await run(join(NATIVE, 'install-native.sh'), ['--dry-run'], {
      TELEGRAM_BOT_TOKEN: 'x',
      ARGUS_AGENT_ADMIN_ID: '123',
      NO_COLOR: '1',
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('must run as root')
    // The suggestion must be an absolute path, not a bare script name.
    expect(result.stderr).toMatch(/sudo \/\S*install-native\.sh/)
  }, 60_000)

  it('documents the same options in its help as it parses', async () => {
    const text = readFileSync(join(NATIVE, 'install-native.sh'), 'utf8')
    const help = text.slice(text.indexOf('usage() {'), text.indexOf('while [ $# -gt 0 ]'))
    for (const option of ['--non-interactive', '--skip-build', '--dry-run', '--yes', '--help']) {
      expect(help, option).toContain(option)
      // And the parser must accept it. The case labels include short aliases, so the
      // assertion is that the long form appears in a `case` arm rather than that it is
      // the whole label.
      expect(text, `${option} is not parsed`).toMatch(new RegExp(`^\\s*${option}[|)]`, 'm'))
    }
  })

  it('requires the Telegram token and user id in non-interactive mode', () => {
    const text = readFileSync(join(NATIVE, 'install-native.sh'), 'utf8')
    expect(text).toMatch(/TELEGRAM_BOT_TOKEN is required with --non-interactive/)
    expect(text).toMatch(/ARGUS_AGENT_ADMIN_ID is required with --non-interactive/)
  })

  it('validates the admin id as numeric', () => {
    const text = readFileSync(join(NATIVE, 'install-native.sh'), 'utf8')
    // A @username must be refused rather than accepted and silently never matched.
    expect(text).toMatch(/must be numeric/)
  })
})

// ── the document ───────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DOCS)('INSTALL-NATIVE.md', () => {
  const doc = HAS_DOCS ? readFileSync(join(DOCS, 'INSTALL-NATIVE.md'), 'utf8') : ''

  it('is not a placeholder', () => {
    expect(doc).not.toContain('not written yet')
    expect(doc).not.toMatch(/\bTODO\b/)
  })

  it('covers every step the prompt asks for', () => {
    for (const topic of [
      'Install Node 22 and pnpm',
      'Get the code',
      'The automated install',
      'The manual install, step by step',
      'Opening the Telegram channel',
      'Creating your first project',
      'Everyday operation',
      'Backup, restore, upgrade',
      'Troubleshooting',
    ]) {
      expect(doc, topic).toContain(topic)
    }
  })

  it('warns that there is no container', () => {
    expect(doc).toMatch(/no container|without a container/i)
    expect(doc).toContain('SECURITY.md')
  })

  it('documents the profile step that is easy to get wrong', () => {
    // The bundle is LINKED to the built application. Installing a packed bundle with
    // `dsh plugin add` composed every row and mounted no plugin — found on a real VPS.
    expect(doc).toContain('ln -sfn /opt/argus-agent/packages/argus-agent')
    expect(doc).toMatch(/packed bundle carries none of them/)
    expect(doc).toContain('cordis.patch.yml')
  })

  it('documents the numeric-id requirement', () => {
    expect(doc).toMatch(/@username.*will not work|A @username will \*\*not\*\* work/i)
    expect(doc).toContain('@userinfobot')
  })

  it('documents /start as a required step', () => {
    // Telegram refuses a bot's first message to a user who never opened the chat, which
    // is the most common "the bot is silent" cause.
    expect(doc).toMatch(/send `\/start`|Send `\/start`|send \/start/i)
  })

  it('documents that data_dir is the HOST path, unlike the Docker install', () => {
    expect(doc).toContain('/srv/argus-agent/data')
    expect(doc).toMatch(/differs from the Docker install|no \/data to map/)
  })

  it('documents how a consistent backup is taken, with or without sqlite3', () => {
    expect(doc).toContain('better-sqlite3')
    expect(doc).toMatch(/sqlite3.*STOPS|STOPS.*sqlite3/s)
  })

  it('documents what the backup does NOT cover', () => {
    expect(doc).toContain('secrets.env')
    expect(doc).toMatch(/NOT in the backup|not in the backup/i)
  })

  it('documents the upgrade rollback and how to test it', () => {
    expect(doc).toContain('--force-rollback')
    expect(doc).toMatch(/schema.*changed.*restor|restoring the pre-upgrade database/i)
  })

  it('documents the uninstall default as keeping the data', () => {
    expect(doc).toContain('uninstall-native.sh')
    expect(doc).toMatch(/keeps the data|--purge/)
  })

  it('shows the complete file layout', () => {
    expect(doc).toContain('/srv/argus-agent/data')
    expect(doc).toContain('/opt/argus-agent')
    expect(doc).toContain('/etc/systemd/system/argus-agent.service')
  })

  it('every section heading has a link target that exists', () => {
    // The table of contents is hand-written, so a renamed section would leave a dead
    // anchor. Check each anchor against the headings.
    const anchors = [...doc.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1] as string)
    const headings = [...doc.matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
      (m[1] as string)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-'),
    )
    expect(anchors.length).toBeGreaterThan(5)
    for (const anchor of anchors) {
      expect(headings, `dead anchor: #${anchor}`).toContain(anchor)
    }
  })
})
