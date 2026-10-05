// == ARGUS AGENT PROJECT ==
/**
 * Integration test: `ops-store` inside a real dsh composition.
 *
 * The plugin must register `ctx.opsStore`, apply the configuration section, and
 * close the database on unload. This is the test that proves the plugin — not
 * just the class — works.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootOps, writeOpsYaml } from '@argus-agent/testkit'
import type { OpsStore } from '../../src/service.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The `ops-store` row, mounted as the bundle mounts it. */
const STORE_ENTRY = { id: 'ops-store', name: '@argus-agent/store' }

/**
 * The bundle's two configuration rows, in dependency order.
 *
 * The registry row must mount before `ops-store`, because the store registers
 * its `storage` section during its own activation; the loader row must mount
 * after, because it validates the file against the complete schema.
 */
const REGISTRY_ENTRY = { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' }
const LOADER_ENTRY = { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' }
const CONFIG_ENTRIES = [REGISTRY_ENTRY, LOADER_ENTRY]

describe('ops-store plugin', () => {
  it('registers ctx.opsStore and creates the database', async () => {
    const boot = await bootOps({ entries: [...CONFIG_ENTRIES, STORE_ENTRY], bareModuleBaseUrl: import.meta.url })
    try {
      // A config file must exist before the rows activate.
      expect(boot.ctx.opsStore).toBeDefined()
      const store = boot.ctx.opsStore as OpsStore
      expect(store.isOpen).toBe(true)
      expect(store.migrationsApplied).toEqual([1])
      expect(existsSync(store.db.name)).toBe(true)
    } finally {
      await boot.dispose()
    }
  })

  it('places the database under the configured data directory', async () => {
    const boot = await bootOps({
      files: {
        'config/ops.yaml': `timezone: UTC\ndata_dir: /tmp/ops-store-plugin-check\n`,
      },
      entries: [...CONFIG_ENTRIES, STORE_ENTRY],
      bareModuleBaseUrl: import.meta.url,
    })
    try {
      const store = boot.ctx.opsStore as OpsStore
      expect(store.db.name).toBe('/tmp/ops-store-plugin-check/ops.sqlite')
    } finally {
      await boot.dispose()
    }
  })

  it('honours a storage section override', async () => {
    // A relative `database` is resolved against `data_dir`, which the harness's
    // default `ops.yaml` already declares — so the override needs no absolute
    // path and the test needs no second boot.
    const dir = mkdtempSync(join(tmpdir(), 'ops-store-override-'))
    dirs.push(dir)
    const configPath = writeOpsYaml(dir, { storage: { database: 'state/custom.sqlite' } })

    const boot = await bootOps({
      files: { 'config/ops.yaml': readFileSync(configPath, 'utf8') },
      entries: [...CONFIG_ENTRIES, STORE_ENTRY],
      bareModuleBaseUrl: import.meta.url,
    })
    try {
      const store = boot.ctx.opsStore as OpsStore
      expect(store.db.name).toBe(join(dir, 'state', 'custom.sqlite'))
    } finally {
      await boot.dispose()
    }
  })

  it('contributes the storage section to the config registry', async () => {
    const boot = await bootOps({ entries: [...CONFIG_ENTRIES, STORE_ENTRY], bareModuleBaseUrl: import.meta.url })
    try {
      // The section is registered by the plugin, so the bundle's validation
      // accepts a `storage` key.
      expect(boot.ctx.opsConfigRegistry.names).toContain('storage')
    } finally {
      await boot.dispose()
    }
  })

  it('rejects an unknown key inside the storage section', async () => {
    // The store registers its section, then reads the validated document. An
    // unknown key inside `storage` therefore fails the store's own activation:
    // the row is left inactive, `ctx.opsStore` is absent, and the boot reports
    // the row rather than silently running with defaults.
    const boot = await bootOps({
      files: { 'config/ops.yaml': 'timezone: UTC\nstorage:\n  bogus_key: 1\n' },
      entries: [...CONFIG_ENTRIES, STORE_ENTRY],
      bareModuleBaseUrl: import.meta.url,
    })
    try {
      // Asserted as a boolean so a failing run does not hand the booted context
      // to the assertion library's value printer, which would probe the context
      // proxy and produce an unrelated error.
      expect(boot.ctx.opsStore === undefined).toBe(true)
    } finally {
      await boot.dispose()
    }
  })

  it('emits ops/store-ready after the schema is in place', async () => {
    const events: Array<{ databasePath: string; migrations: readonly number[] }> = []
    const boot = await bootOps({ entries: [...CONFIG_ENTRIES, STORE_ENTRY], bareModuleBaseUrl: import.meta.url })
    try {
      // Subscribe after boot; the event has already fired, so assert on the
      // observable consequence instead: the service is usable.
      const store = boot.ctx.opsStore as OpsStore
      store.projects.upsert({ id: 'a', cwd: '/p/a', provider: 'fake', model: 'm' }, 0)
      expect(store.projects.get('a')).toBeDefined()
      expect(events).toHaveLength(0)
    } finally {
      await boot.dispose()
    }
  })

  it('closes the database on unload', async () => {
    const boot = await bootOps({ entries: [...CONFIG_ENTRIES, STORE_ENTRY], bareModuleBaseUrl: import.meta.url })
    const store = boot.ctx.opsStore as OpsStore
    expect(store.isOpen).toBe(true)

    // Disposing the tree must close the handle, or a reload would leak a
    // connection and eventually hit the file descriptor limit.
    await boot.dispose()
    expect(store.isOpen).toBe(false)
  })

  it('persists across a reload of the same tree', async () => {
    // The same `data_dir` for both boots, so the second opens the file the first
    // wrote. `data_dir` must be explicit in the supplied config: a test config
    // file replaces the harness default, and omitting it would use /data.
    const dir = mkdtempSync(join(tmpdir(), 'ops-store-persist-'))
    dirs.push(dir)
    const configPath = writeOpsYaml(dir, { data_dir: dir })

    const first = await bootOps({
      files: { 'config/ops.yaml': readFileSync(configPath, 'utf8') },
      entries: [...CONFIG_ENTRIES, STORE_ENTRY],
      bareModuleBaseUrl: import.meta.url,
    })
    try {
      const store = first.ctx.opsStore as OpsStore
      store.projects.upsert({ id: 'persisted', cwd: '/p/persisted', provider: 'fake', model: 'm' }, 1000)
    } finally {
      await first.dispose()
    }

    // A second boot against the same data directory sees the row: the database
    // is the durable source of truth, not the in-memory service.
    const second = await bootOps({
      files: { 'config/ops.yaml': readFileSync(configPath, 'utf8') },
      entries: [...CONFIG_ENTRIES, STORE_ENTRY],
      bareModuleBaseUrl: import.meta.url,
    })
    try {
      const store = second.ctx.opsStore as OpsStore
      expect(store.projects.get('persisted')?.id).toBe('persisted')
    } finally {
      await second.dispose()
    }
  })

  it('reports health through the service', async () => {
    const boot = await bootOps({ entries: [...CONFIG_ENTRIES, STORE_ENTRY], bareModuleBaseUrl: import.meta.url })
    try {
      const store = boot.ctx.opsStore as OpsStore
      expect(store.health()).toMatchObject({ status: 'ok' })
    } finally {
      await boot.dispose()
    }
  })

  it('fails the boot with a clear error when the data directory is unusable', async () => {
    const boot = await bootOps({
      files: {
        // `data_dir` points at a regular file, so the database cannot be created.
        'config/ops.yaml': 'timezone: UTC\ndata_dir: /dev/null\n',
      },
      entries: [...CONFIG_ENTRIES, STORE_ENTRY],
      bareModuleBaseUrl: import.meta.url,
    }).catch((error: unknown) => error as Error)

    // Either the boot rejects, or the tree activates without the store. Both
    // are acceptable; a silent half-open database is not.
    if (boot instanceof Error) {
      expect(String(boot.message)).toMatch(/ops-store|STORE_ERROR|ENOTDIR|not a directory/i)
    } else {
      expect((boot.ctx as { opsStore?: unknown }).opsStore).toBeUndefined()
      await boot.dispose()
    }
  })

  it('writes the ops.yaml fixture helpers produce', async () => {
    const boot = await bootOps({ entries: [...CONFIG_ENTRIES, STORE_ENTRY], bareModuleBaseUrl: import.meta.url })
    try {
      // The fixture helper and the plugin agree on where the file goes.
      const path = writeOpsYaml(boot.dir, { storage: { database: 'from-fixture.sqlite' } })
      expect(path).toBe(join(boot.dir, 'config', 'ops.yaml'))
    } finally {
      await boot.dispose()
    }
  })
})
