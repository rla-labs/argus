// == ARGUS AGENT PROJECT ==
/** Undo through the projects service, as the governor and `/undo` use it. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootProjects } from '../helpers.js'

describe('undo', () => {
  it('snapshots before a run and puts the folder back', async () => {
    const { projects, dataDir } = await bootProjects({ projects: { alpha: {} } })
    const folder = join(dataDir, 'projects', 'alpha')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'a.txt'), 'before\n')
    await projects.snapshotBeforeRun('alpha', 'run-1')
    writeFileSync(join(folder, 'a.txt'), 'after\n')

    expect((await projects.undoList('alpha')).map((entry) => entry.id)).toEqual(['run-1'])
    expect(await projects.undo('alpha')).toMatchObject({ kind: 'run', id: 'run-1' })
    expect(readFileSync(join(folder, 'a.txt'), 'utf8')).toBe('before\n')
    expect(projects.snapshotBytes()).toBeGreaterThan(0)
    await expect(projects.undo('nope')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })

  it('a snapshot that fails does not hold up the run', async () => {
    const { projects, dataDir } = await bootProjects({ projects: { alpha: {} } })
    mkdirSync(join(dataDir, 'projects', 'alpha'), { recursive: true })
    // The state folder is a file: the repository cannot be created.
    mkdirSync(join(dataDir, 'state'), { recursive: true })
    writeFileSync(join(dataDir, 'state', 'alpha'), 'in the way')
    await expect(projects.snapshotBeforeRun('alpha', 'run-1')).resolves.toBeUndefined()
  })
})
