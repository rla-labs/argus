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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  exec) case "$*" in
    *cat*) [ -n "\${FAKE_LINK:-}" ] || exit 1; echo "$FAKE_LINK" ;;
    *touch*) echo "asked" >&2 ;;
    *) ${HEALTH} ;;
  esac ;;
  *) echo "docker $*" ;;
esac`)
stub(join(bin, 'systemctl'), 'echo "${FAKE_STATE:-inactive}"')
stub(join(bin, 'curl'), HEALTH)
stub(join(bin, 'journalctl'), 'echo "journalctl $*"')
stub(join(bin, 'sudo'), 'exec "$@"')
// A native unit naming its data directory.
const unit = join(root, 'argus-agent.service')
const nativeData = join(root, 'native-data')
mkdirSync(join(nativeData, 'state'), { recursive: true })
writeFileSync(unit, `[Service]\nEnvironment=ARGUS_AGENT_DATA_DIR=${nativeData}\n`)


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
    ['init', 'install.sh', 'install-native.sh', ''],
    // doctor is the smoke test plus the service's own checks.
    ['doctor', 'smoke.sh', 'smoke-native.sh', ' --doctor'],
    ['backup', 'backup.sh', 'backup-native.sh', ''],
    ['upgrade', 'upgrade.sh', 'upgrade-native.sh', ''],
  ])('%s runs %s on Docker and %s on native, with the arguments', async (command, docker, native, added) => {
    expect((await argus([command, '--x', 'a b'])).out.trim()).toBe(`docker:${docker}${added} --x a b`)
    expect((await argus([command, '--x'], {}, true)).out.trim()).toBe(`native:${native}${added} --x`)
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

  it('setup-link shows the link the service wrote, or says there is none', async () => {
    const docker = await argus(['setup-link'], { FAKE_LINK: 'http://127.0.0.1:3091/setup?token=abc' })
    expect(docker.code).toBe(0)
    expect(docker.out).toContain('/setup?token=abc')
    const none = await argus(['setup-link'])
    expect(none.code).toBe(1)
    expect(none.out).toContain('argus setup-link --admin')

    writeFileSync(join(nativeData, 'state', 'setup-link'), 'http://127.0.0.1:3091/setup?token=native\n')
    const native = await argus(['setup-link'], { ARGUS_AGENT_UNIT_PATH: unit })
    expect(native.out).toContain('/setup?token=native')
  })

  it('setup-link --admin asks for the admin link, restarts, and shows it', async () => {
    const docker = await argus(['setup-link', '--admin'], { FAKE_LINK: 'http://x/login?token=adm' })
    expect(docker.code).toBe(0)
    expect(docker.out).toContain('asked')
    expect(docker.out).toContain('/login?token=adm')

    // Native: the request file is left in the state directory before the restart.
    rmSync(join(nativeData, 'state', 'setup-link'), { force: true })
    stub(join(bin, 'systemctl'), `echo "$*" > ${JSON.stringify(join(root, 'restarted'))}; echo 'http://x/login?token=n' > ${JSON.stringify(join(nativeData, 'state', 'setup-link'))}`)
    const native = await argus(['setup-link', '--admin'], { ARGUS_AGENT_UNIT_PATH: unit })
    stub(join(bin, 'systemctl'), 'echo "${FAKE_STATE:-inactive}"')
    expect(native.code).toBe(0)
    expect(existsSync(join(nativeData, 'state', 'admin-link.request'))).toBe(true)
    expect(readFileSync(join(root, 'restarted'), 'utf8').trim()).toBe('restart argus-agent')
    expect(native.out).toContain('/login?token=n')
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
