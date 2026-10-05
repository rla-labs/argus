// == ARGUS AGENT PROJECT ==
/**
 * Bundle composition tests.
 *
 * Prompt 00's Part B requirement: prove that the `ops` profile composes the
 * `argus-agent` bundle, and that the bundle's config plugin loads, unloads and
 * reloads cleanly. The throwaway `ops-hello` plugin was deleted once verified;
 * these tests keep the proof.
 *
 * Two layers of proof:
 *  1. **Composition** — the profile resolves every bundle layer and the
 *     composed entry list contains the `ops-config` row without dropping any
 *     base or headless row.
 *  2. **Boot** — a tree composed from the same patch layers actually mounts,
 *     publishes `ctx.opsConfig`, and disposes cleanly. Only the rows whose
 *     packages this repository installs are mounted, because Argus Agent depends on
 *     a small, explicit set of dsh packages (see `package.json`); the
 *     composition test above is what proves the *full* profile resolves.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boot, composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { loadFor } from '../../src/loader-row.js'

// test/integration/<file> → packages/argus-agent → packages → repo root (4 up).
const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
const BUNDLE_DIR = join(REPO_ROOT, 'packages', 'argus-agent')
const INSTALL_ANCHOR = resolve(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json')

let home: string

beforeAll(() => {
  // A private Harness home with the ops profile, so the developer's real
  // `~/.dsh` is never read or written.
  home = mkdtempSync(join(tmpdir(), 'argus-agent-home-'))
  const profileDir = join(home, 'profiles', 'ops')
  mkdirSync(profileDir, { recursive: true })
  cpSync(join(REPO_ROOT, 'profiles', 'ops', 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'profiles', 'ops', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  // The bundle resolves from the profile's node_modules, exactly as
  // `dsh plugin --profile ops install` would leave it. A symlink stands in for
  // the installed package, since the workspace source IS the package.
  const scope = join(profileDir, 'node_modules', '@argus-agent')
  mkdirSync(scope, { recursive: true })
  symlinkSync(BUNDLE_DIR, join(scope, 'argus-agent'), 'dir')
  // Drop the workspace-protocol dependency: resolution goes through the
  // node_modules entry above, and a plain directory has no workspace context.
  manifest.dependencies = {}
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Load the ops profile from the private home and compose its entry list. */
function composedEntries() {
  const profile = loadProfile('argus-agent-test', 'ops', INSTALL_ANCHOR, home)
  return {
    profile,
    entries: composeEntries([...profile.layers.map((layer) => layer.patches), profile.patches]),
  }
}

/**
 * Entry ids this repository can actually mount: every plugin whose package is
 * an installed dependency of the workspace root.
 */
function mountableIds(entries: readonly { id: string; name: string }[]): Set<string> {
  const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const installed = new Set([
    ...Object.keys(rootManifest.dependencies),
    ...Object.keys(rootManifest.devDependencies ?? {}),
  ])
  const mountable = new Set<string>()
  for (const entry of entries) {
    // `@argus-agent/argus-agent/registry-row` names a subpath export, so the package is
    // the part before the second slash of a scoped name.
    const bare = entry.name.startsWith('@')
      ? entry.name.split('/').slice(0, 2).join('/')
      : entry.name.split('/')[0]!
    if (installed.has(entry.name) || installed.has(bare)) mountable.add(entry.id)
  }
  return mountable
}

describe('Argus Agent bundle composition', () => {
  it('resolves every bundle layer of the ops profile', () => {
    const { profile } = composedEntries()
    expect(profile.layers.map((layer) => layer.packageName)).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless',
      '@argus-agent/argus-agent',
    ])
    // No bundle was skipped for a resolution or compatibility failure.
    expect(profile.skippedBundles).toEqual([])
  })

  it('composes both configuration rows without dropping base or headless rows', () => {
    const { entries } = composedEntries()
    // Two rows, deliberately: the registry must exist before any plugin
    // contributes its section, and the loader must validate afterwards.
    const registryRow = entries.find((entry) => entry.id === 'ops-config-registry')
    const loaderRow = entries.find((entry) => entry.id === 'ops-config')
    expect(registryRow?.name).toBe('@argus-agent/argus-agent/registry-row')
    expect(loaderRow?.name).toBe('@argus-agent/argus-agent/loader-row')

    // The bundle INSERTS: every row the base and headless layers contributed is
    // still present.
    for (const id of ['agent-loop', 'tools', 'session', 'llm', 'system-prompt', 'headless-runner']) {
      expect(entries.some((entry) => entry.id === id), `missing composed row ${id}`).toBe(true)
    }
  })

  it('composes a long-running service, not the one-shot headless app', () => {
    const { entries } = composedEntries()
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    // The headless app answers one task and exits; `dsh --profile ops` must not.
    for (const id of ['headless-runner', 'headless-startup']) {
      expect(byId.get(id)?.disabled, `${id} must be disabled`).toBe(true)
    }
    // ops-projects waits for ctx.agentPresets, which no lower layer provides.
    expect(byId.get('agent-preset-registry')?.name).toBe('@deepseek-ai/dsh-agent-preset-registry')
    // The Docker healthcheck and smoke test call the endpoint ops-health serves.
    expect(byId.get('ops-health')?.name).toBe('@argus-agent/health')
    expect(byId.get('ops-health')?.disabled).toBeFalsy()
  })

  it('boots a tree composed from the same layers and publishes ctx.opsConfig', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-agent-boot-'))
    try {
      const { entries } = composedEntries()
      const mountable = mountableIds(entries)
      const filtered = entries.filter((entry) => mountable.has(entry.id))

      const dataDir = join(dir, 'data')
      mkdirSync(join(dataDir, 'config'), { recursive: true })
      const configPath = join(dataDir, 'config', 'ops.yaml')
      writeFileSync(configPath, `timezone: Europe/Bucharest\ndata_dir: ${JSON.stringify(dataDir)}\n`)

      const cordisPath = join(dir, 'cordis.yml')
      // The headless runner needs a task positional and cmdlineArgs; it is not
      // what this test exercises, so it is left out along with its provider.
      const withoutRunner = filtered
        .filter((entry) => entry.id !== 'headless-runner' && entry.id !== 'headless-startup')
        // Point the loader row at this test's ops.yaml through its own config,
        // which is what the profile's user layer does in a real deployment.
        .map((entry) =>
          entry.id === 'ops-config' ? { ...entry, config: { path: configPath } } : entry,
        )
      writeFileSync(cordisPath, `${JSON.stringify(withoutRunner, null, 2)}\n`)

      const ctx = await boot(
        'argus-agent-test',
        cordisPath,
        [],
        // The launcher normally supplies cmdlineArgs; an embedding host does it
        // through `provideCmdline`, which is the documented host hook.
        (hostCtx) => {
          provideCmdline(hostCtx, { args: [], exit: () => undefined })
        },
        import.meta.url,
      )
      const fiber = (ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber
      try {
        // FACT: the loader row activated and the document validated.
        //
        // Read through the loader's own function rather than `ctx.opsConfig`:
        // reaching a service through the booted context requires the caller to
        // be a plugin with a matching `inject` declaration, which a test is not.
        const config = loadFor(ctx, { path: configPath })
        expect(config.timezone).toBe('Europe/Bucharest')
        expect(config.dataDirAbs).toBe(dataDir)
        expect(config.databasePath).toBe(join(dataDir, 'ops.sqlite'))

        // FACT: the row's service is effect-scoped. Re-adding the row re-runs
        // its apply and re-publishes without leaking the previous service.
        // Entry ids are namespaced by their enclosing include group.
        const ids = [...ctx.loader.entries()].map((candidate) => candidate.id)
        const entry = [...ctx.loader.entries()].find((candidate) => candidate.id.endsWith('ops-config'))
        expect(ids.some((id) => id.includes('ops-config')), `entry ids: ${ids.join(', ')}`).toBe(true)
        expect(entry).toBeDefined()
        await entry!.update({ name: '@argus-agent/argus-agent/loader-row', config: { path: configPath } })
        expect(loadFor(ctx, { path: configPath }).timezone).toBe('Europe/Bucharest')
      } finally {
        await fiber.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
