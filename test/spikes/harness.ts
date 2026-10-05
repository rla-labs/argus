// == ARGUS AGENT PROJECT ==
/**
 * Spike harness: boot a minimal dsh composition in-process for experiments.
 *
 * This is throwaway tooling for `test/spikes/*`. It composes a small entry list
 * (a subset of what `dsh-base` mounts) directly through `dsh-app-boot`'s
 * `boot()`, with a temporary Harness home so spikes never touch the developer's
 * real `~/.dsh`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'

/** One booted composition plus its cleanup. */
export interface SpikeBoot {
  ctx: Context
  /** Absolute temporary directory used as the Harness home and workspace root. */
  dir: string
  /** Stop the tree and delete the temporary directory. */
  dispose(): Promise<void>
}

/**
 * The minimal entry list every spike starts from.
 *
 * Deliberately small: the LLM runtime, the session store, projections, the
 * prompt assembler, the agent registry and the agent loop. `agent-loop` is what
 * registers the creation factory on `ctx.agents`, so without it
 * `ctx.agents.create()` rejects. `tools` requires `systemPrompt`, and
 * `agent-loop` requires `tools`, `systemPrompt` and `sessionProjections`.
 */
export const BASE_ENTRIES = [
  { id: 'llm', name: '@deepseek-ai/dsh-llm' },
  { id: 'session', name: '@deepseek-ai/dsh-session' },
  { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
  { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: '' } },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  { id: 'agent', name: '@deepseek-ai/dsh-agent' },
  {
    id: 'agent-default-model',
    name: '@deepseek-ai/dsh-agent-default-model',
    config: { provider: 'fake', model: 'fake-model' },
  },
  { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
]

/**
 * The session-persistence backend row. `@deepseek-ai/dsh-session-persistence`
 * defines the abstract `ctx.sessionPersistence` service but registers nothing;
 * mounting it would collide with the concrete backend. Only the JSONL backend
 * is mounted, with its root pointed into the spike's temporary directory.
 */
export function persistenceEntry(sessionsDir: string): ExtraEntry {
  return {
    id: 'session-persistence-jsonl',
    name: '@deepseek-ai/dsh-session-persistence-jsonl',
    config: { root: sessionsDir },
  }
}

/** Extra rows a spike wants mounted after {@link BASE_ENTRIES}. */
export type ExtraEntry = { id: string; name: string; config?: unknown }

/**
 * Boot a minimal dsh tree in a fresh temporary directory.
 * @param extras additional entry rows to mount.
 * @param options optional entry-list replacement and extra config files.
 * @returns the booted context and its cleanup handle.
 */
export async function bootSpike(
  extras: ExtraEntry[] = [],
  options: {
    entries?: unknown[]
    files?: Record<string, string>
    /** Session-persistence root; defaults to a fresh directory inside the temp dir. */
    sessionsRoot?: string
  } = {},
): Promise<SpikeBoot> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spike-'))
  const sessionsDir = options.sessionsRoot ?? join(dir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const defaults: ExtraEntry[] = [persistenceEntry(sessionsDir)]
  const entries = options.entries ?? [...BASE_ENTRIES, ...defaults, ...extras]
  for (const [name, content] of Object.entries(options.files ?? {})) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, renderEntries(entries))
  const ctx = await boot('dsh-spike', configPath, [], undefined, import.meta.url)
  return {
    ctx,
    dir,
    async dispose() {
      // `boot()` mounts the whole tree as one root fiber; disposing that fiber
      // unwinds every entry (the HMR-safe teardown contract AGENTS.md requires).
      await (ctx as unknown as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Render an entry list as the Cordis include's YAML dialect.
 * @param entries entry rows.
 * @returns the YAML document.
 */
export function renderEntries(entries: readonly unknown[]): string {
  return `${entries.map((entry) => renderEntry(entry as Record<string, unknown>)).join('\n')}\n`
}

function renderEntry(entry: Record<string, unknown>): string {
  const lines: string[] = []
  lines.push(`- id: ${entry.id as string}`)
  lines.push(`  name: ${quoteScalar(entry.name as string)}`)
  if (entry.disabled !== undefined) lines.push(`  disabled: ${JSON.stringify(entry.disabled)}`)
  if (entry.inject !== undefined) lines.push(`  inject: ${JSON.stringify(entry.inject)}`)
  if (entry.config !== undefined) {
    lines.push('  config:')
    for (const line of renderValue(entry.config, 2)) lines.push(`    ${line}`)
  }
  return lines.join('\n')
}

/**
 * Quote a scalar for the YAML dialect. Plugin specifiers start with `@`, which
 * YAML reserves, so they always need quoting.
 * @param value the raw scalar.
 * @returns a safely quoted YAML scalar.
 */
export function quoteScalar(value: string): string {
  return JSON.stringify(value)
}

function renderValue(value: unknown, depth: number): string[] {
  const pad = '  '.repeat(depth)
  if (value === null) return ['null']
  if (typeof value !== 'object') return [JSON.stringify(value)]
  if (Array.isArray(value)) {
    if (value.length === 0) return ['[]']
    return value.flatMap((item) => [`- ${renderValue(item, depth + 1)[0] ?? ''}`, ...renderValue(item, depth + 1).slice(1)])
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return ['{}']
  return entries.flatMap(([key, item]) => {
    const rendered = renderValue(item, depth + 1)
    if (rendered.length === 1 && !rendered[0]?.startsWith('-')) return [`${key}: ${rendered[0]}`]
    return [`${key}:`, ...rendered.map((line) => `${pad}${line}`)]
  })
}

/**
 * Wait until `predicate` is true, polling on the event loop.
 * @param predicate condition to wait for.
 * @param options timeout and poll interval in milliseconds.
 * @returns after the predicate first returns true.
 * @throws when the timeout elapses first.
 */
export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 10
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${options.label ?? 'condition'}`)
}

/**
 * Build a well-formed user message.
 *
 * `UserMessage` REQUIRES `role: 'user'` (see dsh-llm's `message.d.ts`), and
 * `dsh-session`'s `assertMessageEventShape` enforces it when a stored log is
 * replayed. A `followup` whose message omits `role` writes a log that
 * `ctx.agents.resume()` later refuses as corrupt, so every spike must build
 * messages through this helper rather than inline literals.
 *
 * @param id stable message id.
 * @param text the message text.
 * @returns a complete `UserMessage`.
 */
export function userMessage(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  }
}

/** Collect session events observed on the booted tree, keyed by session id. */
export interface EventRecorder {
  events: Array<{ sessionId: string; type: string; data: unknown }>
  ofType(type: string): Array<{ sessionId: string; type: string; data: unknown }>
  stop(): void
}

/**
 * Subscribe to every `session/event` on the tree.
 * @param ctx the booted root context.
 * @returns the recorder.
 */
export function recordSessionEvents(ctx: Context): EventRecorder {
  const events: Array<{ sessionId: string; type: string; data: unknown }> = []
  const dispose = ctx.on('session/event', (session, event) => {
    events.push({ sessionId: session.id as string, type: event.type, data: event.data })
  })
  return {
    events,
    ofType: (type) => events.filter((entry) => entry.type === type),
    stop: () => dispose(),
  }
}
