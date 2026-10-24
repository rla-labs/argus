// == ARGUS AGENT PROJECT ==
/**
 * send_mail through dsh's real tool pipeline: an asked mail waits in the outbox while its
 * run ends; a person is shown the whole mail and only Approve or Deny, never "for the run"
 * or "always"; approved, exactly that mail goes with an account the agent never sees; a recipient not allowed is refused before any
 * question; a trusted recipient within its count gets it unasked, marked as automatic;
 * a task cannot mail at all.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootOps, BASE_ENTRIES, OPTIONAL_ENTRIES, persistenceEntry, waitFor, type ConsoleChannelAdapter, type OpsBoot } from '@argus-agent/testkit'
import type { OpsStore } from '@argus-agent/store'
import type { OpsProjects } from '@argus-agent/projects'
import type { OpsGovernor } from '@argus-agent/governor'
import type { OpsChannel } from '@argus-agent/channel'
import type { OpsMeter } from '@argus-agent/meter'
import { APPROVE } from '../../src/question.js'

const PASSWORD = 'mail-pa55-SECRET'
const boots: Array<{ boot: OpsBoot; channel: OpsChannel; governor: OpsGovernor; meter: OpsMeter }> = []
const dirs: string[] = []
afterEach(async () => {
  for (const entry of boots.splice(0)) {
    await entry.channel.dispose()
    entry.governor.dispose()
    await entry.meter.stop()
    await entry.boot.dispose()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function boot(call: Record<string, unknown>, project = 'mail: {allowed_recipients: [ana@acme.ro]}') {
  const dataDir = mkdtempSync(join(tmpdir(), 'ops-mail-'))
  dirs.push(dataDir)
  mkdirSync(join(dataDir, 'projects', 'alpha'), { recursive: true })
  mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
  writeFileSync(join(dataDir, 'config', 'projects', 'alpha.yaml'), `id: alpha\ncwd: ${JSON.stringify(join(dataDir, 'projects', 'alpha'))}\nprovider: fake\nmodel: fake-model\n${project}\n`)
  const booted = await bootOps({
    files: {
      'config/ops.yaml':
        `timezone: UTC\ndata_dir: ${JSON.stringify(dataDir)}\ntasks:\n  model: fake/fake-model\npricing:\n  fake/*: { input: 1, cached: 1, output: 1 }\n` +
        `budgets:\n  default_day_usd: 100\naccess:\n  allowed_users:\n    - { channel: console, userId: dev }\nchannel:\n  default_address: console:dev\napprovals:\n  timeout_minutes: 30\n  allow_run_grant: true\n`,
    },
    bareModuleBaseUrl: import.meta.url,
    fake: { script: [{ text: 'mailing', toolCalls: [{ name: 'send_mail', arguments: JSON.stringify(call), id: 'm1' }] }, { text: 'done' }] as never, repeatLast: true },
    replaceEntries: [
      ...BASE_ENTRIES,
      persistenceEntry(join(dataDir, 'sessions')),
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'default' } },
      { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
      { id: 'ops-store', name: '@argus-agent/store' },
      { id: 'ops-projects', name: '@argus-agent/projects' },
      { id: 'ops-meter', name: '@argus-agent/meter' },
      { id: 'ops-governor', name: '@argus-agent/governor' },
      { id: 'commands', name: '@deepseek-ai/dsh-commands' },
      { id: 'ops-commands', name: '@argus-agent/commands' },
      { id: 'ops-channel', name: '@argus-agent/channel' },
      OPTIONAL_ENTRIES.approval,
      { id: 'ops-approvals-bridge', name: '@argus-agent/approvals-bridge' },
      { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
    ],
  })
  const ctx = booted.ctx as unknown as { opsStore: OpsStore; opsProjects: OpsProjects; opsGovernor: OpsGovernor; opsChannel: OpsChannel; opsMeter: OpsMeter; provide(name: string, value: unknown): void }
  boots.push({ boot: booted, channel: ctx.opsChannel, governor: ctx.opsGovernor, meter: ctx.opsMeter })
  // dsh's credentials service, in memory; and a transport that records instead of connecting.
  const values = new Map<string, string>()
  ctx.provide('credentials', {
    set: async (ref: unknown, value: string) => void values.set(String(ref), value),
    unset: async (ref: unknown) => void values.delete(String(ref)),
    resolve: async (ref: unknown) => (values.has(String(ref)) ? { value: values.get(String(ref)) } : undefined),
  })
  const sent: Array<Record<string, unknown>> = []
  ;(ctx.opsProjects.mail as unknown as { transport: unknown }).transport = () => ({ sendMail: async (message: Record<string, unknown>) => (sent.push(message), { messageId: '<x@acme.ro>' }) })
  const { ConsoleChannelAdapter } = await import('@argus-agent/testkit')
  const adapter = new ConsoleChannelAdapter({ name: 'console' })
  ctx.opsChannel.register(adapter)
  await ctx.opsChannel.adapterStarted('console')
  return { opsStore: ctx.opsStore, opsProjects: ctx.opsProjects, opsGovernor: ctx.opsGovernor, opsChannel: ctx.opsChannel, dataDir, values, sent, adapter: adapter as ConsoleChannelAdapter }
}

const MAIL = { to: ['ana@acme.ro'], subject: 'Raport Q3', text: 'Bună ziua,\nraportul e atașat.\nCu drag, Argus', attachments: ['report.pdf'] }

describe('send_mail', () => {
  it('keeps an asked mail in the outbox while its run ends, shows it whole with Approve and Deny only, and sends that mail when approved', async () => {
    const b = await boot(MAIL)
    writeFileSync(join(b.dataDir, 'projects', 'alpha', 'report.pdf'), 'PDF')
    await b.opsProjects.mail.setAccount(null, `smtps://office%40acme.ro:${PASSWORD}@mail.acme.ro:465`)

    b.opsGovernor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'mail ana the report' }], priority: 0 })
    await waitFor(() => b.adapter.pendingCount > 0, { timeoutMs: 20_000, label: 'the question' })
    // The run does not wait for the answer: it ends, and frees its slot.
    await waitFor(() => b.opsGovernor.status().running.length === 0, { timeoutMs: 30_000, label: 'the run ended' })
    const question = b.adapter.sent.find((entry) => entry.message.text.startsWith('Approval needed'))!.message
    expect(question.text).toContain('waits in the outbox as #1; the run went on')
    expect(question.text).toContain('from: office@acme.ro (via mail.acme.ro)\nto: ana@acme.ro\nsubject: Raport Q3\nattachments: report.pdf (3 B)')
    expect(question.text).toContain('Bună ziua,\nraportul e atașat.\nCu drag, Argus')
    expect(question.text).not.toContain(PASSWORD)
    expect((question.buttons ?? []).map((button) => button.value)).toEqual([APPROVE, 'deny'])
    expect(JSON.stringify((await b.opsProjects.ensureAgent('alpha')).session.snapshotEvents())).toContain('it waits in the outbox as #1')
    expect(b.opsStore.mailOutbox.get(1)).toMatchObject({ project_id: 'alpha', status: 'waiting', recipients: 1 })
    expect(b.sent).toHaveLength(0)

    b.adapter.answer(APPROVE, 'dev')
    await waitFor(() => b.adapter.sent.some((entry) => entry.message.text === 'Mail #1 of alpha was sent to ana@acme.ro.'), { timeoutMs: 30_000, label: 'told it was sent' })
    expect(b.sent).toHaveLength(1)
    expect(b.sent[0]).toMatchObject({ from: 'office@acme.ro', to: ['ana@acme.ro'], subject: 'Raport Q3' })
    const decider = b.opsStore.approvals.recent(1)[0]!.decided_by
    expect(decider).not.toBeNull()
    expect(b.opsStore.mailOutbox.get(1)).toMatchObject({ status: 'sent', decided_by: decider })
    // The password is in the credentials store only: never in the session, the audit, the approvals or the folder.
    const session = await b.opsProjects.ensureAgent('alpha')
    expect(JSON.stringify(session.session.snapshotEvents())).not.toContain(PASSWORD)
    expect(JSON.stringify(b.opsStore.audit.recent(100))).not.toContain(PASSWORD)
    expect(JSON.stringify(b.opsStore.approvals.recent(10))).not.toContain(PASSWORD)
    expect(b.opsStore.approvals.recent(1)[0]!.status).toBe('granted')
    expect(b.opsStore.approvals.recent(1)[0]!.request_json).toContain('"always":null')
  }, 60_000)

  it('drops an asked mail that is denied, and says so', async () => {
    const b = await boot({ ...MAIL, attachments: [] })
    await b.opsProjects.mail.setAccount(null, `smtps://office%40acme.ro:${PASSWORD}@mail.acme.ro:465`)
    b.opsGovernor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'mail ana' }], priority: 0 })
    await waitFor(() => b.adapter.pendingCount > 0, { timeoutMs: 20_000, label: 'the question' })
    b.adapter.answer('deny', 'dev')
    await waitFor(() => b.adapter.sent.some((entry) => entry.message.text === 'Mail #1 of alpha was denied: nothing was sent.'), { timeoutMs: 30_000, label: 'told it was denied' })
    expect(b.opsStore.mailOutbox.get(1)).toMatchObject({ status: 'refused', decided_by: b.opsStore.approvals.recent(1)[0]!.decided_by })
    expect(b.opsStore.approvals.recent(1)[0]!.status).toBe('denied')
    expect(b.sent).toHaveLength(0)
  }, 60_000)

  it('refuses a recipient not allowed before any question', async () => {
    const b = await boot({ ...MAIL, to: ['eve@evil.com'], attachments: [] })
    await b.opsProjects.mail.setAccount('alpha', `smtps://u:${PASSWORD}@mail.acme.ro`)
    b.opsGovernor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'go' }], priority: 0 })
    // The run's last answer reaches the chat once the refused call is behind it.
    await waitFor(() => b.adapter.sent.some((entry) => entry.message.text.includes('done')), { timeoutMs: 30_000, label: 'the run ended' })
    await waitFor(() => b.opsGovernor.status().running.length === 0, { timeoutMs: 30_000, label: 'idle' })
    const events = JSON.stringify((await b.opsProjects.ensureAgent('alpha')).session.snapshotEvents())
    expect(events).toContain('Not in mail.allowed_recipients or mail.trusted_recipients of this project: eve@evil.com')
    expect(b.adapter.sent.some((entry) => entry.message.text.includes('Approval needed'))).toBe(false)
    expect(b.sent).toHaveLength(0)
  }, 60_000)

  it('goes unasked to a trusted recipient within its count, marked as automatic, and asks past it', async () => {
    const b = await boot({ ...MAIL, attachments: [] }, 'mail: {trusted_recipients: {ana@acme.ro: 1}}')
    await b.opsProjects.mail.setAccount(null, `smtps://office%40acme.ro:${PASSWORD}@mail.acme.ro:465`)
    b.opsGovernor.submit({ source: 'channel', target: { projectId: 'alpha' }, content: [{ type: 'text', text: 'report' }], priority: 0 })
    await waitFor(() => b.sent.length > 0 && b.opsGovernor.status().running.length === 0, { timeoutMs: 30_000, label: 'sent unasked' })
    expect(b.sent[0]).toMatchObject({ to: ['ana@acme.ro'], headers: { 'Auto-Submitted': 'auto-generated', 'X-Argus-Project': 'alpha' } })
    expect(b.adapter.sent.some((entry) => entry.message.text.includes('Approval needed'))).toBe(false)
    expect(b.opsStore.approvals.recent(10)).toHaveLength(0)

    // Its count is used: the next one is asked about, and says why.
    const next = await b.opsProjects.mailPreview('alpha', 'm2', { ...MAIL, attachments: [] })
    expect(next.unasked).toBeUndefined()
    expect(next.text).toContain('Asked because ana@acme.ro already got 1 unasked mail(s)')
  }, 60_000)

  it('is never allowed unasked: tools.mail allow and an allow exception are invalid, and a task cannot mail', async () => {
    const b = await boot(MAIL, 'tools: {mail: allow}')
    expect(b.opsProjects.invalidOf('alpha')?.reason).toContain('tools.mail: cannot be allow')
    const { parseProjectConfig } = await import('@argus-agent/projects')
    expect(() => parseProjectConfig({ id: 'x', cwd: join(b.dataDir, 'projects', 'x'), provider: 'p', model: 'm', tools: { exceptions: { send_mail: 'allow' } } }, { sourcePath: 's', projectsRoot: join(b.dataDir, 'projects') })).toThrow(/send_mail: cannot be allow/)
    const { taskToolPolicy, hiddenTools } = await import('@argus-agent/types')
    expect(hiddenTools(taskToolPolicy('ask'))).toContain('send_mail')
  }, 60_000)
})
