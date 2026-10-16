// == ARGUS AGENT PROJECT ==
/**
 * Layered templates: a project file that says `template:` holds only what it changed.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_TEMPLATES, layerTemplate, loadTemplates, parseProjectConfig, templateIssues, type ProjectTemplate } from '../../src/index.js'

const ROOT = '/data/projects'

function template(name: string, settings: Record<string, unknown>): ProjectTemplate {
  return { name, summary: name, description: name, instructions: '', settings }
}

const devops = template('devops', {
  tools: { read: 'allow', write: 'ask', shell: 'ask', web: 'ask', web_hosts: ['example.com'] },
  approvals: { auto_allow: ['docker ps', 'docker logs *'] },
  limits: { max_steps_per_run: 80 },
})

function parse(own: Record<string, unknown>, templates: ProjectTemplate[] = [devops]) {
  return parseProjectConfig(
    { id: 'ops', cwd: '/data/projects/ops', provider: 'fake', model: 'fake-model', ...own },
    { sourcePath: 'ops.yaml', projectsRoot: ROOT, templates: new Map(templates.map((t) => [t.name, t])) },
  )
}

describe('a project that follows a template', () => {
  it('takes what its file does not set from the template, and says so', () => {
    const config = parse({ template: 'devops' })
    expect(config.template).toBe('devops')
    expect(config.tools).toMatchObject({ read: 'allow', write: 'ask', shell: 'ask', web_hosts: ['example.com'] })
    expect(config.approvals.auto_allow).toEqual(['docker ps', 'docker logs *'])
    expect(config.limits.max_steps_per_run).toBe(80)
    expect(config.fromTemplate).toEqual(expect.arrayContaining(['tools.shell', 'tools.web_hosts', 'approvals.auto_allow', 'limits.max_steps_per_run']))
  })

  it('merges maps key by key; a list it sets replaces the template’s, so a rule can be removed', () => {
    const config = parse({ template: 'devops', tools: { shell: 'allow' }, approvals: { auto_allow: ['docker ps'] } })
    expect(config.tools).toMatchObject({ read: 'allow', write: 'ask', shell: 'allow' })
    expect(config.approvals.auto_allow).toEqual(['docker ps'])
    expect(config.fromTemplate).toContain('tools.write')
    expect(config.fromTemplate).not.toContain('tools.shell')
    expect(config.fromTemplate).not.toContain('approvals.auto_allow')
  })

  it('follows a later change of the template', () => {
    const changed = template('devops', { ...devops.settings, approvals: { auto_allow: ['docker ps', 'uptime -p'] } })
    expect(parse({ template: 'devops' }, [changed]).approvals.auto_allow).toEqual(['docker ps', 'uptime -p'])
  })

  it('checks the template’s rules like its own', () => {
    const bad = template('devops', { approvals: { auto_allow: ['rm * -rf'] } })
    expect(() => parse({ template: 'devops' }, [bad])).toThrow(/approvals.auto_allow.0/)
  })

  it('is invalid when its template does not exist', () => {
    expect(() => parse({ template: 'nope' })).toThrow(/template: no template "nope"; there are devops/)
  })

  it('a project without template: is unchanged', () => {
    const config = parse({ tools: { shell: 'allow' } })
    expect(config.template).toBeNull()
    expect(config.fromTemplate).toEqual([])
    expect(config.tools.write).toBe('ask')
    expect(config.approvals.auto_allow).toEqual([])
  })
})

describe('layerTemplate', () => {
  it('is what a detached project writes: the same effective settings', () => {
    const own = { tools: { shell: 'allow' }, budget: { day_usd: 1 } }
    const layered = layerTemplate(devops.settings, own)
    expect(parse(layered, []).tools).toEqual(parse({ template: 'devops', ...own }).tools)
    expect(parse(layered, []).approvals).toEqual(parse({ template: 'devops', ...own }).approvals)
  })
})

describe('templateIssues', () => {
  it('passes the built-in templates', () => {
    expect(templateIssues(new Map(BUILT_IN_TEMPLATES.map((t) => [t.name, t])))).toEqual([])
  })

  it('names a key no project has and a value that does not validate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'templates-'))
    writeFileSync(join(dir, 'typo.yaml'), 'summary: a typo\nlimits:\n  max_step_per_run: 10\ntools:\n  shell: allow\n')
    writeFileSync(join(dir, 'bad.yaml'), 'tools:\n  shell: sometimes\n')
    writeFileSync(join(dir, 'reserved.yaml'), 'model: x\n')
    const { templates, problems } = loadTemplates(dir)
    expect(problems).toEqual(['reserved.yaml: cannot set model: /new decides them'])
    const issues = templateIssues(new Map([...templates].filter(([name]) => ['typo', 'bad'].includes(name))))
    expect(issues).toHaveLength(2)
    expect(issues.join('\n')).toMatch(/template bad/)
    expect(issues).toContain('template typo: not a project setting: limits.max_step_per_run')
  })
})
