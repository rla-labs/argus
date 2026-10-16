// == ARGUS AGENT PROJECT ==
/**
 * Spike 7 — skills per agent.
 *
 * Questions: can a skill provider be mounted for one project agent only, and what does
 * the base bundle's global provider see in a project folder today?
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { bootSpike } from './harness.js'

type Skills = { list(options?: { cwd?: string; scope?: unknown }): Promise<{ name: string }[]> }

/** Write a directory-bundle skill: `<root>/<name>/SKILL.md`. */
function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n---\nDo ${name}.\n`)
}

const names = async (skills: Skills, options: { cwd?: string; scope?: unknown }): Promise<string[]> =>
  (await skills.list(options)).map((skill) => skill.name)

describe('spike 7: skills per agent', () => {
  it('a provider mounted in an agent setup is seen by that agent only', async () => {
    const boot = await bootSpike([{ id: 'skill', name: '@deepseek-ai/dsh-skill' }])
    try {
      const skills = (boot.ctx as unknown as { skills: Skills }).skills
      writeSkill(join(boot.dir, 'a-skills'), 'alpha-skill')
      writeSkill(join(boot.dir, 'b-skills'), 'beta-skill')
      const agent = (id: string, dir: string) =>
        boot.ctx.agents.create({
          sessionId: SessionId(`spike7-${id}`),
          meta: { cwd: boot.dir },
          agentOptions: { provider: 'fake', model: 'm' },
          // FACT: dsh-skill-filesystem mounted through `agentCtx.plugin`, as Argus mounts
          // MCP, registers its provider in that agent's layer of the registry.
          setup: async (agentCtx) => {
            await agentCtx.plugin(skillFilesystem, { providerName: `spike7-${id}`, includeDefaultRoots: false, customSkillDirs: [dir], watch: false })
          },
        })
      const a = await agent('a', join(boot.dir, 'a-skills'))
      const b = await agent('b', join(boot.dir, 'b-skills'))

      expect(await names(skills, { cwd: boot.dir, scope: scopeOf(a.agent.ctx) })).toEqual(['alpha-skill'])
      expect(await names(skills, { cwd: boot.dir, scope: scopeOf(b.agent.ctx) })).toEqual(['beta-skill'])
      // FACT: the global layer (no scope) sees neither.
      expect(await names(skills, { cwd: boot.dir })).toEqual([])

      // FACT: disposing the agent unwinds its provider.
      const key = scopeOf(a.agent.ctx)
      await a.dispose()
      expect(await names(skills, { cwd: boot.dir, scope: key })).toEqual([])
      await b.dispose()
    } finally {
      await boot.dispose()
    }
  })

  it("the base bundle's global provider reads skills an agent writes in its project folder", async () => {
    const boot = await bootSpike([{ id: 'skill', name: '@deepseek-ai/dsh-skill' }])
    try {
      const skills = (boot.ctx as unknown as { skills: Skills }).skills
      const home = join(boot.dir, 'home')
      // As dsh-base mounts it: default roots on. The homes point into the temp dir.
      await boot.ctx.plugin(skillFilesystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
      const project = join(boot.dir, 'project')
      mkdirSync(join(project, '.git'), { recursive: true })
      // What an agent allowed to write in its folder could write.
      writeSkill(join(project, '.agents', 'skills'), 'self-made')

      // FACT: the project root is the nearest `.git` ancestor, and `<root>/.agents/skills`
      // is a default root, so the skill enters the agent's catalog. Step 6 of 0.5.0
      // turns these roots off; this expectation then flips.
      expect(await names(skills, { cwd: project })).toContain('self-made')
    } finally {
      await boot.dispose()
    }
  })
})
