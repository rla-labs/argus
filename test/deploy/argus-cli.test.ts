// == ARGUS AGENT PROJECT ==
/**
 * `argus`, the entry point over the deploy scripts.
 *
 * It only dispatches, so the tests check the dispatch: each command reaches the right
 * script for the install type, with its arguments, through the /usr/local/bin link. The
 * scripts and the host tools (docker, systemctl, curl, journalctl) are stubs that print
 * how they were called.
 */
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ARGUS = join(import.meta.dirname, '..', '..', 'deploy', 'argus.sh')
const root = mkdtempSync(join(tmpdir(), 'argus-cli-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function stub(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
}

// A deploy tree: argus.sh, and every script it may call, each printing its name.
const deploy = join(root, 'deploy')
for (const dir of ['scripts', 'native']) mkdirSync(join(deploy, dir), { recursive: true })
copyFileSync(ARGUS, join(deploy, 'argus.sh'))
for (const name of ['install.sh', 'smoke.sh', 'backup.sh', 'restore.sh', 'upgrade.sh']) stub(join(deploy, 'scripts', name), `echo "docker:${name} $*"`)
for (const name of ['install-native.sh', 'smoke-native.sh', 'backup-native.sh', 'upgrade-native.sh']) stub(join(deploy, 'native', name), `echo "native:${name} $*"`)

// The host tools, and the link the installers create.
const bin = join(root, 'bin')
mkdirSync(bin)
symlinkSync(join(deploy, 'argus.sh'), join(bin, 'argus'))
const HEALTH = `echo "{\\"status\\":\\"\${FAKE_HEALTH:-ok}\\"}"`
stub(join(bin, 'docker'), `case "$1" in
  inspect) [ -n "\${FAKE_STATE:-}" ] || exit 1; case "$*" in *Image*) echo argus:test ;; *) echo "$FAKE_STATE" ;; esac ;;
  exec) ${HEALTH} ;;
  *) echo "docker $*" ;;
esac`)
stub(join(bin, 'systemctl'), 'echo "${FAKE_STATE:-inactive}"')
stub(join(bin, 'curl'), HEALTH)
stub(join(bin, 'journalctl'), 'echo "journalctl $*"')


function argus(args: string[], env: Record<string, string> = {}, native = false): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      join(bin, 'argus'),
      args,
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ARGUS_AGENT_UNIT_PATH: native ? ARGUS /* any file that exists */ : join(root, 'none'), ...env } },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), out: stdout + stderr }),
    )
  })
}

describe('argus', () => {
  it.each([
    ['init', 'install.sh', 'install-native.sh'],
    ['doctor', 'smoke.sh', 'smoke-native.sh'],
    ['backup', 'backup.sh', 'backup-native.sh'],
    ['upgrade', 'upgrade.sh', 'upgrade-native.sh'],
  ])('%s runs %s on Docker and %s on native, with the arguments', async (command, docker, native) => {
    expect((await argus([command, '--x', 'a b'])).out.trim()).toBe(`docker:${docker} --x a b`)
    expect((await argus([command, '--x'], {}, true)).out.trim()).toBe(`native:${native} --x`)
  })

  it('picks the install type from the unit, and a flag overrides it', async () => {
    expect((await argus(['--native', 'init'])).out.trim()).toBe('native:install-native.sh')
    expect((await argus(['--docker', 'init'], {}, true)).out.trim()).toBe('docker:install.sh')
  })

  it('restore runs restore.sh on Docker, and points to the manual steps on native', async () => {
    expect((await argus(['restore', '--list'])).out.trim()).toBe('docker:restore.sh --list')
    const native = await argus(['restore'], {}, true)
    expect(native.code).toBe(1)
    expect(native.out).toContain('docs/user/install-native.md#restoring')
  })

  it('logs reads the container log, or the journal', async () => {
    expect((await argus(['logs', '-f'])).out.trim()).toBe('docker logs --tail 100 -f argus-agent')
    expect((await argus(['logs', '-f'], {}, true)).out.trim()).toBe('journalctl -u argus-agent -n 100 -f')
  })

  it('status reports the service and its health, and fails when it is not healthy', async () => {
    const ok = await argus(['status'], { FAKE_STATE: 'running' })
    expect(ok.code).toBe(0)
    expect(ok.out).toMatch(/container running/)
    expect(ok.out).toMatch(/image\s+argus:test/)
    expect(ok.out).toMatch(/health\s+ok/)

    const missing = await argus(['status'])
    expect(missing.code).toBe(1)
    expect(missing.out).toMatch(/container not found/)
    expect(missing.out).toMatch(/health\s+no answer/)

    const native = await argus(['status'], { FAKE_STATE: 'active', FAKE_HEALTH: 'degraded' }, true)
    expect(native.code).toBe(0)
    expect(native.out).toMatch(/service\s+active/)
    expect(native.out).toContain("argus doctor")
  })

  it('an unknown or missing command fails, with the usage', async () => {
    for (const args of [['frobnicate'], []]) {
      const result = await argus(args)
      expect(result.code).toBe(1)
      expect(result.out).toContain('Usage: argus')
    }
    expect((await argus(['help'])).code).toBe(0)
  })
})
