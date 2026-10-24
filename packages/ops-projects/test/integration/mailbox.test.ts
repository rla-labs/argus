// == ARGUS AGENT PROJECT ==
/**
 * The mailbox in a booted Argus: its tools are shown only to a project that has a mailbox
 * (and whose `mail_read` is not off), a mailbox set later reaches the agent at its next
 * message, and an attachment is written into the project's folder through the real
 * command sandbox, which a planted link cannot lead out of.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootProjects } from '../helpers.js'

const URL_TEXT = 'imaps://comenzi%40acme.ro:secret@mail.acme.ro:993'
const TOOLS = ['mail_list', 'mail_read', 'mail_save_attachment', 'mail_mark_read']

/** Boot with the sandbox and a credentials store over memory. */
async function boot(projects: Record<string, Record<string, unknown>>) {
  const booted = await bootProjects({ projects, entries: [{ id: 'sandbox', name: '@argus-agent/argus-agent/sandbox-row' }] })
  const values = new Map<string, string>()
  ;(booted.ctx as unknown as { provide(name: string, value: unknown): void }).provide('credentials', {
    set: async (ref: unknown, value: string) => void values.set(String(ref), value),
    unset: async (ref: unknown) => void values.delete(String(ref)),
    resolve: async (ref: unknown) => (values.has(String(ref)) ? { value: values.get(String(ref)) } : undefined),
  })
  return booted
}

describe('the mailbox tools', () => {
  it('are shown only to a project with a mailbox, from its next message, unless mail_read is off', async () => {
    const { projects } = await boot({ site: {}, quiet: { tools: { mail_read: 'off' } } })
    const { scopeOf } = await import('@deepseek-ai/dsh-scope')
    const sees = async (id: string): Promise<string[]> => {
      const agent = await projects.ensureAgent(id)
      return TOOLS.filter((name) => agent.ctx.tools.get(name, scopeOf(agent.ctx)) !== undefined)
    }
    expect(await sees('site')).toEqual([])
    await projects.mailbox.setAccount(null, URL_TEXT)
    expect(await sees('site')).toEqual(TOOLS)
    expect(await sees('quiet')).toEqual([])
    await projects.mailbox.removeAccount(null)
    expect(await sees('site')).toEqual([])
  }, 60_000)
})

describe('an attachment saved into the project', () => {
  it('lands under the folder through the sandbox, and a planted link cannot lead it out', async () => {
    const { projects } = await boot({ site: {} })
    const cwd = projects.configOf('site')!.cwd
    mkdirSync(cwd, { recursive: true })
    await projects.placeFile('site', cwd, 'mail/2026-10-24-4521/comanda.pdf', Buffer.from('%PDF-1.7'))
    expect(readFileSync(join(cwd, 'mail/2026-10-24-4521/comanda.pdf'), 'utf8')).toBe('%PDF-1.7')

    // The agent plants a link to somewhere else where the next attachment would go.
    const outside = mkdtempSync(join(tmpdir(), 'mailbox-outside-'))
    symlinkSync(outside, join(cwd, 'mail', '2026-10-25-9'))
    await expect(projects.placeFile('site', cwd, 'mail/2026-10-25-9/evil.txt', Buffer.from('x'))).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false)
  }, 60_000)
})
