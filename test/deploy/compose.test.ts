// == ARGUS AGENT PROJECT ==
/**
 * The compose files and the shared shell library.
 *
 * Compose is YAML, so a typo in a key name is not a syntax error — it is a directive
 * Docker silently ignores. That is the failure this catches: `read_only` misspelled
 * means a writable container, and nothing says so.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const DEPLOY = join(import.meta.dirname, '..', '..', 'deploy')
const COMPOSE = join(DEPLOY, 'compose')

function readCompose(name: string): Record<string, unknown> {
  return parse(readFileSync(join(COMPOSE, name), 'utf8')) as Record<string, unknown>
}

const base = readCompose('docker-compose.yml')
const ollama = readCompose('docker-compose.ollama.yml')

/** The `ops` service from a compose document. */
function opsService(doc: Record<string, unknown>): Record<string, unknown> {
  const services = doc['services'] as Record<string, Record<string, unknown>>
  return services['ops'] as Record<string, unknown>
}

describe('docker-compose.yml', () => {
  it('is valid YAML with one service', () => {
    const services = base['services'] as Record<string, unknown>
    expect(Object.keys(services)).toEqual(['ops'])
  })

  it('restarts unless stopped', () => {
    // `always` would restart a deliberately stopped container; `unless-stopped` is what
    // an operator expects from `docker compose stop`.
    expect(opsService(base)['restart']).toBe('unless-stopped')
  })

  it('reads an env_file', () => {
    expect(opsService(base)['env_file']).toEqual(['.env'])
  })

  it('mounts the data directory at /data', () => {
    const volumes = opsService(base)['volumes'] as string[]
    expect(volumes.some((v) => v.includes(':/data'))).toBe(true)
  })

  it('mounts only /data as persistent state', () => {
    const volumes = opsService(base)['volumes'] as string[]
    const mounts = volumes.filter((v) => !v.startsWith('#'))
    // One mount. A second persistent path is a second thing to back up, and
    // `backup.sh` archives /data.
    expect(mounts).toHaveLength(1)
  })

  it('publishes only the web interface, and only on the host\'s loopback', () => {
    // The health endpoint is unauthenticated and stays inside the container. The web
    // interface has its own sign-in and is meant for `tailscale serve`, a VPN or a
    // tunnel: a public bind would put it on the internet.
    const ports = opsService(base)['ports'] as string[]
    expect(ports).toHaveLength(1)
    expect(ports[0]).toMatch(/^127\.0\.0\.1:.*:3091$/)
    expect(JSON.stringify(ports)).not.toContain('3090')
  })

  it('declares a healthcheck against the ops endpoint', () => {
    const healthcheck = opsService(base)['healthcheck'] as { test: string[] }
    expect(healthcheck).toBeDefined()
    expect(healthcheck.test.join(' ')).toContain('127.0.0.1:3090/health')
    // `--start-period` covers the first boot, when migrations run.
    expect(JSON.stringify(healthcheck)).toContain('start_period')
  })

  it('caps the log, which an agent can otherwise fill a disk with', () => {
    const logging = opsService(base)['logging'] as { driver: string; options: Record<string, string> }
    expect(logging.driver).toBe('json-file')
    expect(logging.options['max-size']).toBeDefined()
    expect(logging.options['max-file']).toBeDefined()
  })

  it('drops capabilities and refuses new privileges', () => {
    const service = opsService(base)
    expect(service['cap_drop']).toEqual(['ALL'])
    expect(service['security_opt']).toContain('no-new-privileges:true')
  })

  it('runs read-only with a writable tmpfs', () => {
    const service = opsService(base)
    expect(service['read_only']).toBe(true)
    // /tmp must be writable: an agent's tools need a scratch space.
    expect(JSON.stringify(service['tmpfs'])).toContain('/tmp')
    // ...and executable: dsh loads its native addons from $TMPDIR, and a `noexec`
    // tmpfs (Docker's default) kills the service at boot.
    expect(JSON.stringify(service['tmpfs'])).toMatch(/\/tmp:[^"]*\bexec\b/)
  })

  it('limits processes and allows a real shutdown', () => {
    const service = opsService(base)
    expect(service['pids_limit']).toBeGreaterThan(0)
    // A run may need to be cancelled, so the grace period is not the default 10s.
    expect(service['stop_grace_period']).toBeDefined()
  })
})

describe('docker-compose.ollama.yml', () => {
  it('adds an ollama service', () => {
    const services = ollama['services'] as Record<string, unknown>
    expect(Object.keys(services)).toContain('ollama')
    expect(Object.keys(services)).toContain('ops')
  })

  it('puts ollama on an INTERNAL network', () => {
    // A local model server has no authentication; it is safe only because nothing else
    // can route to it.
    const networks = ollama['networks'] as Record<string, { internal?: boolean }>
    expect(networks['internal']).toBeDefined()
    expect(networks['internal']?.internal).toBe(true)
  })

  it('does NOT publish ollama', () => {
    const services = ollama['services'] as Record<string, Record<string, unknown>>
    expect(services['ollama']?.['ports']).toBeUndefined()
  })

  it('keeps ops reachable from the outside as well', () => {
    // Replacing the networks instead of adding one would cut Telegram off and the bot
    // would go silent, with nothing in the log to say why.
    expect(opsService(ollama)['networks']).toContain('internal')
    expect(opsService(ollama)['networks']).toContain('default')
  })

  it('tells ops where ollama is', () => {
    const environment = opsService(ollama)['environment'] as Record<string, string>
    expect(environment['OLLAMA_BASE_URL']).toContain('ollama')
  })

  it('persists the models', () => {
    const services = ollama['services'] as Record<string, Record<string, unknown>>
    const volumes = services['ollama']?.['volumes'] as string[]
    expect(volumes.some((v) => v.includes('.ollama'))).toBe(true)
  })

  it('still restarts and caps its log', () => {
    const services = ollama['services'] as Record<string, Record<string, unknown>>
    expect(services['ollama']?.['restart']).toBe('unless-stopped')
    expect(services['ollama']?.['logging']).toBeDefined()
  })
})

describe('the compose files compose', () => {
  it('merge without conflicting service definitions', async () => {
    // `docker compose config` is the only real validator, and it needs the Docker CLI.
    // Without it, the structural check is that the overlay's `ops` service adds keys
    // rather than redefining the base ones.
    const merged = opsService(ollama)
    const original = opsService(base)
    for (const key of ['image', 'restart', 'volumes', 'healthcheck', 'read_only']) {
      // Not overridden: the overlay must not silently loosen the base hardening.
      expect(merged[key], `${key} was overridden by the overlay`).toBeUndefined()
    }
    expect(original['read_only']).toBe(true)
  })
})

describe('scripts/lib.sh', () => {
  const lib = readFileSync(join(DEPLOY, 'scripts', 'lib.sh'), 'utf8')

  it('is sourced, never executed', () => {
    // Executing it would run `set -euo pipefail` in a fresh shell and exit.
    expect(lib).toContain('Sourced, never executed')
  })

  it('uses strict mode', () => {
    expect(lib).toContain('set -euo pipefail')
  })

  it('resolves its own location rather than the cwd', () => {
    // The scripts are run from anywhere; a `./` relative path breaks the moment an
    // operator is not in the deploy directory.
    expect(lib).toContain('BASH_SOURCE[0]')
  })

  it('defaults to a confirmation of NO when there is no terminal', () => {
    const confirm = lib.match(/^confirm\(\) \{[\s\S]*?^\}/m)?.[0] ?? ''
    expect(confirm).not.toBe('')
    // A script that proceeds destructively because nobody was there to say no is the
    // worst possible default.
    expect(confirm).toContain('ASSUME_YES')
    expect(confirm).toContain('not a terminal')
  })

  it('reads health from INSIDE the container', () => {
    // The endpoint is loopback-only and not published, so a host-side curl would test
    // port forwarding rather than the system.
    expect(lib).toContain('docker exec')
    expect(lib).toContain('127.0.0.1:3090/health')
  })

  it('treats degraded as up', () => {
    const wait = lib.match(/^wait_for_health\(\) \{[\s\S]*?^\}/m)?.[0] ?? ''
    expect(wait).toContain('degraded')
    // Degraded means running with something to look at, not a failed install.
    expect(wait).not.toMatch(/degraded\)\s*return\s+1/)
  })

  it('reads the running image from the container, not the config', () => {
    // After a rollback they differ, and the container is what must be restored.
    expect(lib).toContain('running_image')
    expect(lib).toMatch(/docker inspect --format '\{\{\.Config\.Image\}\}'/)
  })

  it('exposes the data layout so backup can tell empty from populated', () => {
    expect(lib).toMatch(/DATA_SUBDIRS=\(/)
    expect(lib).toContain('data_is_initialized')
  })

  it('every script sources it rather than duplicating', () => {
    for (const script of ['backup.sh', 'restore.sh', 'install.sh', 'upgrade.sh', 'uninstall.sh', 'smoke.sh']) {
      const text = readFileSync(join(DEPLOY, 'scripts', script), 'utf8')
      expect(text, script).toContain('source=lib.sh')
    }
  })
})

describe('every script is well formed', () => {
  const scripts = ['backup.sh', 'restore.sh', 'install.sh', 'upgrade.sh', 'uninstall.sh', 'smoke.sh', 'lib.sh']

  it.each(scripts)('%s passes bash -n', async (script) => {
    const result = await new Promise<{ code: number }>((resolve) => {
      execFile('bash', ['-n', join(DEPLOY, 'scripts', script)], {}, (error) => {
        resolve({ code: error === null ? 0 : (((error as { code?: number }).code as number) ?? 1) })
      })
    })
    expect(result.code).toBe(0)
  })

  it.each(scripts)('%s has a shebang and an explanation', (script) => {
    const text = readFileSync(join(DEPLOY, 'scripts', script), 'utf8')
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true)
    // Every script opens with why it exists, not merely what it does.
    const commentLines = text.split('\n').slice(1).filter((line) => line.startsWith('#')).length
    expect(commentLines, `${script} is under-documented`).toBeGreaterThan(5)
  })

  it.each(['backup.sh', 'restore.sh', 'install.sh', 'upgrade.sh', 'uninstall.sh', 'smoke.sh'])(
    '%s is executable',
    (script) => {
      const { statSync } = require('node:fs') as typeof import('node:fs')
      const mode = statSync(join(DEPLOY, 'scripts', script)).mode
      // Owner-execute at minimum.
      expect(mode & 0o100, `${script} is not executable`).not.toBe(0)
    },
  )

  it('none of them prints a secret', () => {
    for (const script of scripts) {
      const text = readFileSync(join(DEPLOY, 'scripts', script), 'utf8')
      // `set -x` would print every expansion, including a token.
      expect(text, script).not.toContain('set -x')
      // Echoing the token itself.
      expect(text, script).not.toMatch(/echo\s+.*\$\{?TELEGRAM_BOT_TOKEN/)
    }
  })

  it('install.sh --data-path is honoured (lib.sh makes DATA_PATH readonly)', async () => {
    const { promisify } = await import('node:util')
    const { stdout, stderr } = await promisify(execFile)(
      'bash',
      [join(DEPLOY, 'scripts', 'install.sh'), '--non-interactive', '--dry-run', '--data-path', '/nonexistent/argus-x'],
      { env: { ...process.env, TELEGRAM_BOT_TOKEN: 'x', ARGUS_AGENT_ADMIN_ID: '1', NO_COLOR: '1' } },
    ).catch((error: { stdout: string; stderr: string }) => error)
    expect(`${stdout}${stderr}`).toMatch(/data directory\s+\/nonexistent\/argus-x/)
  })

  it('the Dockerfile entrypoint does not use set -x either', () => {
    const text = readFileSync(join(DEPLOY, 'docker', 'entrypoint.sh'), 'utf8')
    expect(text).not.toContain('set -x')
  })
})
