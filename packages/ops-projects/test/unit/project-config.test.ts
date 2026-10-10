// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for project configuration parsing and validation.
 *
 * The `cwd` check is the security-relevant one: a project must not be able to
 * point outside `<data_dir>/projects/`.
 */
import { describe, expect, it } from 'vitest'
import { OpsError } from '@argus-agent/types'
import {
  assertCwdInsideProjectsRoot,
  defaultProjectCwd,
  parseProjectConfig,
  parseProjectYaml,
  projectFallbackRef,
  projectModelRef,
  PROJECT_ID_PATTERN,
  ProjectConfigError,
} from '../../src/project-config.js'

const ROOT = '/data/projects'
const SOURCE = '/data/config/projects/site.yaml'

/** A minimal valid document. */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'site',
    cwd: '/data/projects/site',
    provider: 'fake',
    model: 'fake-model',
    ...overrides,
  }
}

/** Parse a document, expecting success. */
function parse(overrides: Record<string, unknown> = {}, expectedId = 'site') {
  return parseProjectConfig(doc(overrides), { sourcePath: SOURCE, projectsRoot: ROOT, expectedId })
}

/** Parse a document, expecting failure. */
function parseFails(overrides: Record<string, unknown>): ProjectConfigError {
  try {
    parse(overrides)
  } catch (error) {
    return error as ProjectConfigError
  }
  throw new Error('expected parseProjectConfig to throw')
}

describe('PROJECT_ID_PATTERN', () => {
  it('accepts a lowercase slug', () => {
    expect(PROJECT_ID_PATTERN.test('site')).toBe(true)
    expect(PROJECT_ID_PATTERN.test('site-firma')).toBe(true)
    expect(PROJECT_ID_PATTERN.test('a1')).toBe(true)
    expect(PROJECT_ID_PATTERN.test('x'.repeat(41))).toBe(true)
  })

  it('rejects anything that would escape a path or read badly', () => {
    expect(PROJECT_ID_PATTERN.test('')).toBe(false)
    expect(PROJECT_ID_PATTERN.test('a')).toBe(false)
    expect(PROJECT_ID_PATTERN.test('Site')).toBe(false)
    expect(PROJECT_ID_PATTERN.test('-site')).toBe(false)
    expect(PROJECT_ID_PATTERN.test('site_firma')).toBe(false)
    expect(PROJECT_ID_PATTERN.test('site/../etc')).toBe(false)
    expect(PROJECT_ID_PATTERN.test('..')).toBe(false)
    expect(PROJECT_ID_PATTERN.test('x'.repeat(42))).toBe(false)
  })
})

describe('assertCwdInsideProjectsRoot', () => {
  it('accepts a subdirectory', () => {
    expect(assertCwdInsideProjectsRoot('/data/projects/site', ROOT)).toBe('/data/projects/site')
    expect(assertCwdInsideProjectsRoot('/data/projects/site/nested', ROOT)).toBe(
      '/data/projects/site/nested',
    )
  })

  it('collapses traversal before checking, so .. cannot escape', () => {
    expect(() => assertCwdInsideProjectsRoot('/data/projects/../secrets', ROOT)).toThrow(
      ProjectConfigError,
    )
    expect(() => assertCwdInsideProjectsRoot('/data/projects/site/../../etc', ROOT)).toThrow(
      ProjectConfigError,
    )
    expect(() => assertCwdInsideProjectsRoot('/etc', ROOT)).toThrow(ProjectConfigError)
  })

  it('rejects the projects root itself', () => {
    // The root is where projects live, not a project: allowing it would make
    // every project share one folder.
    expect(() => assertCwdInsideProjectsRoot(ROOT, ROOT)).toThrow(/projects root itself/)
  })

  it('rejects a relative path', () => {
    expect(() => assertCwdInsideProjectsRoot('site', ROOT)).toThrow(/must be absolute/)
  })

  it('rejects a sibling that merely shares a prefix', () => {
    // `/data/projects-old` starts with `/data/projects` as a string, but is not
    // inside it. A naive `startsWith` would accept it.
    expect(() => assertCwdInsideProjectsRoot('/data/projects-old/site', ROOT)).toThrow(
      ProjectConfigError,
    )
  })

  it('reports the issue with a cwd path', () => {
    try {
      assertCwdInsideProjectsRoot('/etc', ROOT)
    } catch (error) {
      const issues = (error as ProjectConfigError).issues
      expect(issues).toHaveLength(1)
      expect(issues[0]?.path).toBe('cwd')
    }
  })

  it('is an OpsError with a stable code', () => {
    try {
      assertCwdInsideProjectsRoot('/etc', ROOT)
    } catch (error) {
      expect(OpsError.hasCode(error, 'PROJECT_CONFIG_INVALID')).toBe(true)
      expect((error as OpsError).code).toBe('PROJECT_CONFIG_INVALID')
    }
  })
})

describe('defaultProjectCwd', () => {
  it('joins the projects root and the id', () => {
    expect(defaultProjectCwd('site', ROOT)).toBe('/data/projects/site')
  })
})

describe('parseProjectConfig', () => {
  it('parses a minimal document and applies every default', () => {
    const config = parse()
    expect(config).toMatchObject({
      id: 'site',
      cwd: '/data/projects/site',
      provider: 'fake',
      model: 'fake-model',
      fallback_model: null,
      preset: null,
      description: null,
      progress: false,
      sourcePath: SOURCE,
    })
    expect(config.limits).toEqual({
      max_steps_per_run: 60,
      max_wallclock_min: 45,
      max_tokens_per_request: 8000,
      max_subagent_depth: 1,
      loop_repeat_threshold: 5,
    })
    expect(config.budget).toEqual({
      day_usd: 3,
      month_usd: 40,
      info_pct: 50,
      soft_pct: 80,
      soft_action: 'warn',
      hard_action: 'pause',
    })
    expect(config.approvals).toEqual({ mode: 'ask', auto_allow: [], timeout_minutes: 30 })
    expect(config.memory).toEqual({ user_profile: true })
  })

  it('honours every explicit value', () => {
    const config = parse({
      fallback_model: 'deepseek/deepseek-flash',
      preset: 'standard',
      description: 'The company website.',
      progress: true,
      limits: { max_steps_per_run: 10, max_wallclock_min: 5, max_tokens_per_request: 100, max_subagent_depth: 2, loop_repeat_threshold: 3 },
      budget: { day_usd: 1, month_usd: 10, info_pct: 40, soft_pct: 70, soft_action: 'downgrade', hard_action: 'reject_new' },
      approvals: { mode: 'auto', auto_allow: ['git status'], timeout_minutes: 5 },
      memory: { user_profile: false },
    })
    expect(config.fallback_model).toBe('deepseek/deepseek-flash')
    expect(config.preset).toBe('standard')
    expect(config.progress).toBe(true)
    expect(config.limits.max_subagent_depth).toBe(2)
    expect(config.budget.soft_action).toBe('downgrade')
    expect(config.budget.hard_action).toBe('reject_new')
    expect(config.approvals).toEqual({ mode: 'auto', auto_allow: ['git status'], timeout_minutes: 5 })
    expect(config.memory.user_profile).toBe(false)
  })

  it('rejects an id that does not match the file name', () => {
    // The file name is the identity everywhere else, so a mismatch would make
    // `/p <id>` address a project whose file says something else.
    const error = parseFails({ id: 'other' })
    expect(error.issues[0]?.path).toBe('id')
    expect(error.issues[0]?.message).toContain('must match the file name')
  })

  it('rejects an invalid id', () => {
    const error = parseFails({ id: 'Site_Firma' })
    expect(error.issues.some((issue) => issue.path === 'id')).toBe(true)
  })

  it('rejects a missing provider or model', () => {
    const noProvider = parseFails({ provider: undefined })
    expect(noProvider.issues.some((issue) => issue.path === 'provider')).toBe(true)

    const emptyModel = parseFails({ model: '' })
    expect(emptyModel.issues.some((issue) => issue.path === 'model')).toBe(true)
  })

  it('rejects a cwd outside the projects root', () => {
    const error = parseFails({ cwd: '/etc' })
    expect(error.issues[0]?.path).toBe('cwd')
  })

  it('rejects a malformed fallback_model', () => {
    const error = parseFails({ fallback_model: 'no-slash' })
    expect(error.issues.some((issue) => issue.path === 'fallback_model')).toBe(true)
  })

  it('accepts an empty fallback_model as absent', () => {
    expect(parse({ fallback_model: '' }).fallback_model).toBeNull()
  })

  it('reports every problem at once', () => {
    const error = parseFails({ id: 'BAD', provider: undefined, cwd: '/etc', fallback_model: 'x' })
    const paths = error.issues.map((issue) => issue.path)
    expect(paths).toContain('id')
    expect(paths).toContain('provider')
    expect(paths).toContain('cwd')
    expect(paths).toContain('fallback_model')
  })

  it('rejects a non-mapping document', () => {
    expect(() =>
      parseProjectConfig(['id'], { sourcePath: SOURCE, projectsRoot: ROOT }),
    ).toThrow(/mapping at the top level/)
    expect(() =>
      parseProjectConfig(null, { sourcePath: SOURCE, projectsRoot: ROOT }),
    ).toThrow(ProjectConfigError)
  })

  it('rejects an out-of-range enum', () => {
    expect(() => parse({ approvals: { mode: 'sometimes' } })).toThrow(ProjectConfigError)
    expect(() => parse({ budget: { soft_action: 'shout' } })).toThrow(ProjectConfigError)
  })

  it('rejects a wrong type for a numeric limit', () => {
    expect(() => parse({ limits: { max_steps_per_run: 'many' } })).toThrow(ProjectConfigError)
  })
})

describe('the tools block', () => {
  it('defaults to today\'s behaviour with delegation hidden', () => {
    expect(parse().tools).toEqual({ read: 'allow', write: 'ask', shell: 'ask', web: 'ask', agents: 'off', other: 'ask', web_hosts: [] })
  })

  it('takes a group\'s access and the web hosts', () => {
    expect(parse({ tools: { web: 'allow', shell: 'deny', web_hosts: ['ycombinator.com'] } }).tools).toMatchObject({
      web: 'allow',
      shell: 'deny',
      read: 'allow',
      web_hosts: ['ycombinator.com'],
    })
  })

  it('refuses a misspelt group, a value it does not know, and off for other', () => {
    expect(parseFails({ tools: { webb: 'allow' } }).issues.map((issue) => issue.path)).toContain('tools.webb')
    expect(() => parse({ tools: { web: 'sometimes' } })).toThrow()
    expect(() => parse({ tools: { other: 'off' } })).toThrow()
  })
})

describe('parseProjectYaml', () => {
  it('parses valid YAML', () => {
    const config = parseProjectYaml(
      'id: site\ncwd: /data/projects/site\nprovider: fake\nmodel: m\ndescription: hello\n',
      { sourcePath: SOURCE, projectsRoot: ROOT, expectedId: 'site' },
    )
    expect(config.description).toBe('hello')
  })

  it('reports malformed YAML with a position', () => {
    try {
      parseProjectYaml('id: "unterminated\n', { sourcePath: SOURCE, projectsRoot: ROOT })
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectConfigError)
      expect((error as ProjectConfigError).message).toContain('not valid YAML')
    }
  })

  it('rejects an empty file', () => {
    expect(() => parseProjectYaml('', { sourcePath: SOURCE, projectsRoot: ROOT })).toThrow(
      ProjectConfigError,
    )
  })
})

describe('model references', () => {
  it('reads the project model', () => {
    expect(projectModelRef(parse())).toEqual({ provider: 'fake', model: 'fake-model' })
  })

  it('reads the fallback, when configured', () => {
    expect(projectFallbackRef(parse())).toBeUndefined()
    expect(projectFallbackRef(parse({ fallback_model: 'a/b' }))).toEqual({ provider: 'a', model: 'b' })
  })
})

describe('the budget defaults from ops.yaml', () => {
  const budgetDefaults = { day_usd: 10, month_usd: 150 }
  const withDefaults = (overrides: Record<string, unknown> = {}) =>
    parseProjectConfig(doc(overrides), { sourcePath: SOURCE, projectsRoot: ROOT, expectedId: 'site', budgetDefaults })

  it('apply to a project file that sets no budget, as the installer promises', () => {
    expect(withDefaults().budget).toMatchObject({ day_usd: 10, month_usd: 150 })
  })

  it('never override what the file sets, key by key', () => {
    expect(withDefaults({ budget: { day_usd: 2 } }).budget).toMatchObject({ day_usd: 2, month_usd: 150 })
  })

  it('leave the schema defaults when ops.yaml has none', () => {
    expect(parse().budget).toMatchObject({ day_usd: 3, month_usd: 40 })
  })
})
