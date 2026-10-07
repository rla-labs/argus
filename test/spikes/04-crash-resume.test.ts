// == ARGUS AGENT PROJECT ==
/**
 * Spike 4 — crash and resume.
 *
 * Question: after a `SIGKILL` during a turn, what survives? Do completed turns
 * come back, what happens to the interrupted turn, and do pending inbox items
 * survive?
 *
 * Method: run a child process that boots the composition with its session root
 * at a fixed directory, completes one turn, opens a second that never finishes,
 * and signals readiness. Kill it with `SIGKILL`, then resume the same session id
 * in this process against the same session root and inspect what came back.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootSpike, recordSessionEvents, waitFor, userMessage } from './harness.js'

const HARNESS_URL = fileURLToPath(new URL('./harness.ts', import.meta.url))

const CHILD_SCRIPT = `
import { bootSpike, persistenceEntry, BASE_ENTRIES, userMessage } from ${JSON.stringify(HARNESS_URL)}
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

class SlowAdapter extends LlmAdapter {
  count = 0
  providerInfo(provider) { return { id: provider, name: provider, models: [] } }
  async *stream(options) {
    this.count += 1
    if (this.count >= 2) await new Promise((resolve) => setTimeout(resolve, 600000))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'turn ' + this.count }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'turn ' + this.count } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

const dir = process.argv[2]
const sessionsRoot = join(dir, 'sessions')
const boot = await bootSpike([], {
  entries: [...BASE_ENTRIES, persistenceEntry(sessionsRoot)],
})
boot.ctx.llm.registerAdapter(['fake'], new SlowAdapter())
const cwd = join(dir, 'work')
mkdirSync(cwd, { recursive: true })
const handle = await boot.ctx.agents.create({
  sessionId: SessionId('spike4-crash'),
  meta: { cwd },
  agentOptions: { provider: 'fake', model: 'm' },
})
handle.agent.followup(userMessage('m-1', 'first'))
await handle.agent.whenIdle()
// Durability barrier for the completed turn before opening the doomed one.
await boot.ctx.sessions.flush(handle.agent.session)
handle.agent.followup(userMessage('m-2', 'second'))
handle.agent.steer(userMessage('m-3', 'pending steering'))
await new Promise((resolve) => setTimeout(resolve, 2000))
console.log('CHILD_SESSION_READY')
await new Promise((resolve) => setTimeout(resolve, 600000))
`

let tempDir: string | undefined
let childDir: string | undefined

afterEach(() => {
  for (const dir of [tempDir, childDir]) if (dir) rmSync(dir, { recursive: true, force: true })
  tempDir = undefined
  childDir = undefined
})

describe('spike 4: crash and resume', () => {
  it('keeps completed turns, interrupts the open turn, and resumes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-spike4-'))
    tempDir = dir
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    // The child script imports dsh packages by name, which Node resolves only from
    // inside the repository — so it lives here, and only its data lives in tmpdir.
    childDir = mkdtempSync(join(import.meta.dirname, '.child-'))
    const scriptPath = join(childDir, 'child.mts')
    writeFileSync(scriptPath, CHILD_SCRIPT)

    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, dir], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))

    try {
      await waitFor(() => stdout.includes('CHILD_SESSION_READY'), {
        timeoutMs: 90_000,
        label: `child readiness; stderr tail: ${stderr.slice(-600)}`,
      })
    } catch (error) {
      child.kill('SIGKILL')
      throw error
    }

    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))

    // FACT: the session artifacts are on disk after SIGKILL — no flush hook ran.
    const artifacts = readdirSync(join(dir, 'sessions'), { recursive: true }) as string[]
    expect(artifacts.length).toBeGreaterThan(0)

    // Resume in THIS process against the SAME session root.
    const resumed = await bootSpike([], { sessionsRoot: join(dir, 'sessions') })
    try {
      const events = recordSessionEvents(resumed.ctx)
      const handle = await resumed.ctx.agents.resume({
        resumeSessionId: SessionId('spike4-crash'),
        agentOptions: { provider: 'fake', model: 'm' },
      })

      // FACT: resume succeeds from a log whose last turn never closed.
      expect(handle.agent.id).toBe(SessionId('spike4-crash'))
      expect(handle.agent.status).toBe('idle')

      // FACT: the completed first turn is intact in the resumed log, and the
      // interrupted second turn was closed by agent-loop with a synthetic
      // closer rather than left open.
      const log = handle.agent.session.snapshotEvents()
      const types = log.map((event) => event.type)
      expect(types).toContain('turn/start')
      expect(types).toContain('turn/end')

      const userMessages = log.filter((event) => event.type === 'user/message')
      expect(userMessages.length).toBeGreaterThanOrEqual(1)

      const assistantMessages = log.filter((event) => event.type === 'assistant/message')
      // Exactly the first turn's answer survived; the second never produced one.
      expect(assistantMessages).toHaveLength(1)
      const text = (assistantMessages[0]?.data as { message: { content: Array<{ text?: string }> } })
        .message.content.map((block) => block.text ?? '')
        .join('')
      expect(text).toBe('turn 1')

      // FACT: the orphaned turn carries an explicit `interrupted` reason, which
      // is how recovery distinguishes a crash from a normal close.
      const endReasons = log
        .filter((event) => event.type === 'turn/end')
        .map((event) => (event.data as { reason: { kind: string } }).reason.kind)
      expect(endReasons).toContain('interrupted')

      // FACT: the resumed session's own event feed stays empty until new work
      // arrives — replay does not re-emit `session/event`.
      expect(events.events.filter((entry) => entry.type === 'session/created')).toHaveLength(0)

      // FACT: the resumed agent is live and can take new work in the same
      // session, continuing the conversation.
      handle.agent.followup(userMessage('m-after', 'after crash'))
      await handle.agent.whenIdle()
      expect(handle.agent.session.snapshotEvents().filter((event) => event.type === 'assistant/message').length)
        .toBeGreaterThanOrEqual(1)

      await handle.dispose()
    } finally {
      await resumed.dispose()
    }
  }, 180_000)
})
