// == ARGUS AGENT PROJECT ==
/**
 * A project's skills: read from `<state>/<id>/skills`, outside its folder, by a provider
 * in its agent's scope. A skill the agent writes in its own folder is not read.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { bootProjects } from '../helpers.js'

type Skills = { list(options?: { cwd?: string; scope?: unknown }): Promise<{ name: string }[]> }

function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n---\nDo ${name}.\n`)
}

describe('project skills', () => {
  it('lists the skills in the state folder, for that project only, and none from its own folder', async () => {
    const { projects, ctx } = await bootProjects({
      projects: { site: {}, other: {} },
      entries: [{ id: 'skill', name: '@deepseek-ai/dsh-skill' }],
    })
    const skills = (ctx as unknown as { skills: Skills }).skills
    writeSkill(projects.skillsDirOf('site')!, 'deploy')
    // What an agent allowed to write in its folder could write: the base's roots.
    const cwd = projects.configOf('site')!.cwd
    mkdirSync(join(cwd, '.git'), { recursive: true })
    writeSkill(join(cwd, '.agents', 'skills'), 'self-made')
    writeSkill(join(cwd, '.dsh', 'skills'), 'self-made-too')

    const names = async (id: string) => {
      const agent = await projects.ensureAgent(id)
      return (await skills.list({ cwd, scope: scopeOf(agent.ctx) })).map((skill) => skill.name)
    }
    expect(await names('site')).toEqual(['deploy'])
    expect(await names('other')).toEqual([])
  }, 60_000)
})
