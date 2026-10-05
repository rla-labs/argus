// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/testkit/runner-entry` — the process a crash test kills.
 *
 * Boots the stack, submits the requests named in a file, touches a marker once they
 * are running, and then waits to be killed. It is deliberately small: everything
 * interesting happens in the plugins under test, and a runner with logic of its own
 * would be a second thing to debug.
 *
 * The protocol is files, because a socket is more machinery than the test needs:
 *
 * 1. The test writes `<dataDir>/requests.json`.
 * 2. This process submits each entry and waits until the runs are running.
 * 3. It touches `<dataDir>/running`, which is what the test waits on.
 * 4. It waits to be killed.
 *
 * @module @argus-agent/testkit/runner-entry
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './runner.js'

/** The environment variable carrying the module-resolution base. */
const RUNNER_BASE_URL = 'ARGUS_AGENT_RUNNER_BASE_URL'

/** One request the test wants submitted. */
interface RequestSpec {
  readonly id: string
  readonly project: string
  readonly text: string
}

/** Wait until a file appears. */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

/** The entry point. */
async function main(): Promise<void> {
  // Where `@argus-agent/*` resolves from. The entry lives inside the toolkit's `lib`,
  // and a workspace package is NOT linked into its own `node_modules` — so the
  // caller supplies a `file://` URL inside the deploying workspace, which does have
  // the links. Without it, seven plugins fail to import and the runner sees no
  // services at all.
  const baseUrl = process.env[RUNNER_BASE_URL]
  const handle = await run(baseUrl === undefined ? {} : { bareModuleBaseUrl: baseUrl })
  const dataDir = handle.dataDir
  const ctx = handle.boot.ctx as never as {
    opsStore: { runs: { active: () => unknown[] } }
    opsGovernor: { submit: (request: Record<string, unknown>) => { requestId: string } }
  }

  const requestsFile = join(dataDir, 'requests.json')
  const appeared = await waitForFile(requestsFile, 30_000)
  if (appeared) {
    const specs = JSON.parse(readFileSync(requestsFile, 'utf8')) as RequestSpec[]
    for (const spec of specs) {
      // The GOVERNOR writes the inbound row and generates the request id: that is
      // the only path to execution (ADR 0002), and a runner that inserted its own
      // row would create a duplicate and a request the governor never saw.
      ctx.opsGovernor.submit({
        source: 'channel',
        target: { projectId: spec.project },
        content: [{ type: 'text', text: spec.text }],
        priority: 0,
        replyTo: { channel: 'console', chatId: 'dev' },
      })
    }

    // Wait until the runs exist, so the test kills during them rather than before.
    await waitForFile(join(dataDir, 'running'), 1)
    const deadline = Date.now() + 30_000
    for (;;) {
      if (ctx.opsStore.runs.active().length >= specs.length) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    writeFileSync(join(dataDir, 'running'), String(specs.length))
  }

  // Wait to be killed. The test owns the process's lifetime.
  await new Promise<void>(() => {
    /* killed from outside */
  })
}

void main().catch((error: unknown) => {
  process.stderr.write(`runner failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
