// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/testkit` — deterministic, free integration testing for Argus Agent.
 *
 * Three things make that possible:
 *
 * 1. {@link FakeLlmAdapter} returns scripted responses and reports usage in the
 *    exact shape a real adapter does, so no provider is called.
 * 2. {@link FakeClock} moves time on command, so budget rollover, cron firing
 *    and approval timeouts are tested without sleeping.
 * 3. {@link bootOps} mounts a real dsh composition in a temporary directory and
 *    tears it down completely, so a test exercises real agent, session and event
 *    code rather than a mock of it.
 *
 * @example
 * ```ts
 * const boot = await bootOps({ fake: { script: [{ text: 'hello' }] } })
 * try {
 *   const handle = await boot.ctx.agents.create({
 *     sessionId: SessionId('t-1'),
 *     meta: { cwd: boot.dir },
 *     agentOptions: { provider: 'fake', model: 'fake-model' },
 *   })
 *   handle.agent.followup(userMessage('m-1', 'hi'))
 *   await handle.agent.whenIdle()
 * } finally {
 *   await boot.dispose()
 * }
 * ```
 *
 * @module @argus-agent/testkit
 */

export * from './fake-clock.js'
export * from './fake-llm.js'
export * from './console-channel.js'
export * from './harness.js'
export * from './fixtures.js'
export * from './assertions.js'
export * from './messages.js'
export * from './runner.js'
