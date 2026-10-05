// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for `ops.yaml` loading, environment interpolation and validation.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { ConfigRegistry, OpsConfigError, rootSchema } from '../../src/config.js'
import { interpolateEnv, loadOpsConfig, resolveConfigPath, resolveUnderDataDir } from '../../src/loader.js'

const temps: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-config-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('rootSchema', () => {
  it('requires a timezone and defaults the paths', () => {
    const parsed = rootSchema({ timezone: 'Europe/Bucharest' }) as Record<string, unknown>
    expect(parsed['timezone']).toBe('Europe/Bucharest')
    expect(parsed['data_dir']).toBe('/data')
    expect(parsed['config_dir']).toBe('config')
    expect(parsed['dsh_home']).toBe('dsh-home')
  })

  it('rejects a document without a timezone', () => {
    expect(() => rootSchema({})).toThrow(/timezone/)
  })
})

describe('ConfigRegistry', () => {
  it('accepts contributed sections and rejects duplicates', () => {
    const registry = new ConfigRegistry()
    const dispose = registry.extend('concurrency', z.object({ global_max_running: z.number().default(4) }))
    expect(registry.names).toEqual(['concurrency'])
    expect(() => registry.extend('concurrency', z.object({}))).toThrow(/duplicate/)
    dispose()
    expect(registry.names).toEqual([])
  })

  it('names an unknown top-level key instead of ignoring it', () => {
    const registry = new ConfigRegistry()
    registry.extend('concurrency', z.object({ global_max_running: z.number() }))
    let error: OpsConfigError | undefined
    try {
      registry.validate({ timezone: 'UTC', concurreny: {} })
    } catch (caught) {
      error = caught as OpsConfigError
    }
    expect(error).toBeInstanceOf(OpsConfigError)
    expect(error?.code).toBe('OPS_CONFIG_INVALID')
    expect(error?.issues[0]?.path).toBe('concurreny')
    expect(error?.issues[0]?.message).toContain('known keys are')
  })

  it('reports a schema violation as an issue', () => {
    const registry = new ConfigRegistry()
    let error: OpsConfigError | undefined
    try {
      registry.validate({ timezone: 42 })
    } catch (caught) {
      error = caught as OpsConfigError
    }
    expect(error).toBeInstanceOf(OpsConfigError)
  })

  it('rejects a non-mapping document', () => {
    const registry = new ConfigRegistry()
    expect(() => registry.validate(['timezone'])).toThrow(/mapping/)
    expect(() => registry.validate(null)).toThrow(/mapping/)
  })
})

describe('interpolateEnv', () => {
  it('substitutes references from the environment', () => {
    expect(interpolateEnv('token: ${MY_TOKEN}', { MY_TOKEN: 'secret' })).toBe('token: secret')
  })

  it('substitutes repeatedly and leaves unrelated text alone', () => {
    expect(interpolateEnv('a: ${X}\nb: ${X}\nc: $X', { X: '1' })).toBe('a: 1\nb: 1\nc: $X')
  })

  it('fails naming every unresolved variable', () => {
    let error: OpsConfigError | undefined
    try {
      interpolateEnv('a: ${MISSING_A}\nb: ${MISSING_B}', {})
    } catch (caught) {
      error = caught as OpsConfigError
    }
    expect(error).toBeInstanceOf(OpsConfigError)
    expect(error?.issues.map((issue) => issue.path)).toEqual(['${MISSING_A}', '${MISSING_B}'])
  })
})

describe('resolveUnderDataDir', () => {
  it('keeps absolute paths and joins relative ones', () => {
    expect(resolveUnderDataDir('/srv/data', '/data')).toBe('/srv/data')
    expect(resolveUnderDataDir('config', '/data')).toBe('/data/config')
  })
})

describe('resolveConfigPath', () => {
  it('prefers ARGUS_AGENT_CONFIG', () => {
    expect(resolveConfigPath({ ARGUS_AGENT_CONFIG: '/etc/ops.yaml' })).toBe('/etc/ops.yaml')
  })

  it('falls back to <data_dir>/config/ops.yaml', () => {
    expect(resolveConfigPath({ ARGUS_AGENT_DATA_DIR: '/srv/ops' })).toBe('/srv/ops/config/ops.yaml')
  })

  it('defaults the data directory to /data', () => {
    expect(resolveConfigPath({})).toBe('/data/config/ops.yaml')
  })

  it('still reads the pre-rename DSH_OPS_* names, with the new names winning', () => {
    expect(resolveConfigPath({ DSH_OPS_CONFIG: '/old/ops.yaml' })).toBe('/old/ops.yaml')
    expect(resolveConfigPath({ DSH_OPS_DATA_DIR: '/old' })).toBe('/old/config/ops.yaml')
    expect(resolveConfigPath({ ARGUS_AGENT_CONFIG: '/new/ops.yaml', DSH_OPS_CONFIG: '/old/ops.yaml' })).toBe('/new/ops.yaml')
  })
})

describe('loadOpsConfig', () => {
  it('loads, validates and derives every path', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.yaml')
    writeFileSync(path, 'timezone: Europe/Bucharest\ndata_dir: /srv/ops\n')
    const config = loadOpsConfig(new ConfigRegistry(), { path, env: {} })
    expect(config.timezone).toBe('Europe/Bucharest')
    expect(config.dataDirAbs).toBe('/srv/ops')
    expect(config.projectsDir).toBe('/srv/ops/config/projects')
    expect(config.databasePath).toBe('/srv/ops/ops.sqlite')
    expect(config.scratchDir).toBe('/srv/ops/scratch')
    expect(config.stateDir).toBe('/srv/ops/state')
    expect(config.backupsDir).toBe('/srv/ops/backups')
    expect(config.dshHomeAbs).toBe('/srv/ops/dsh-home')
  })

  it('interpolates the environment before parsing', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.yaml')
    writeFileSync(path, 'timezone: ${OPS_TZ}\n')
    const config = loadOpsConfig(new ConfigRegistry(), { path, env: { OPS_TZ: 'UTC' } })
    expect(config.timezone).toBe('UTC')
  })

  it('names the file when it is missing', () => {
    const dir = tempDir()
    let error: OpsConfigError | undefined
    try {
      loadOpsConfig(new ConfigRegistry(), { path: join(dir, 'nope.yaml'), env: {} })
    } catch (caught) {
      error = caught as OpsConfigError
    }
    expect(error).toBeInstanceOf(OpsConfigError)
    expect(error?.message).toContain('nope.yaml')
    expect(error?.message).toContain('ARGUS_AGENT_CONFIG')
  })

  it('reports malformed YAML as a config error, not a crash', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.yaml')
    writeFileSync(path, 'timezone: "unterminated\n')
    expect(() => loadOpsConfig(new ConfigRegistry(), { path, env: {} })).toThrow(OpsConfigError)
  })

  it('includes contributed plugin sections in the validated result', () => {
    const dir = tempDir()
    const path = join(dir, 'ops.yaml')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(path, 'timezone: UTC\nconcurrency:\n  global_max_running: 2\n')
    const registry = new ConfigRegistry()
    registry.extend('concurrency', z.object({ global_max_running: z.number().default(4) }))
    const config = loadOpsConfig(registry, { path, env: {} })
    expect(config.raw['concurrency']).toEqual({ global_max_running: 2 })
  })
})
