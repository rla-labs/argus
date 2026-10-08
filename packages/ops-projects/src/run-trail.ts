// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/projects/run-trail` — what a run did, kept for `/log`.
 *
 * dsh keeps the full conversation in the session log, a compressed file whose format
 * is not a documented API. When a run ends, its events are still in memory here, so
 * a short summary is written to the audit log instead: the tools it called, each with
 * its main argument and whether it failed, and the start of its reply.
 *
 * @module @argus-agent/projects/run-trail
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The audit action a trail is recorded under; the target is `run:<run id>`. */
export const RUN_TRAIL_ACTION = 'run.trail'

/** At most this many tool calls are kept; `toolsTotal` says how many there were. */
const TOOLS_KEPT = 40
/** A tool's argument, and the reply, are cut to these lengths. */
const ARG_CHARS = 100
const REPLY_CHARS = 600

/** The arguments that say what a call was about, in the order they are looked for. */
const MAIN_ARGUMENTS = ['command', 'path', 'file_path', 'url', 'query', 'pattern', 'description', 'name']

/** One run's trail, as `/log` shows it. */
export interface RunTrail {
  readonly tools: ReadonlyArray<{ readonly name: string; readonly arg: string; readonly failed: boolean }>
  readonly toolsTotal: number
  readonly reply: string
}

/** The argument that says most about a call: a command, a path, a URL, … */
function mainArgument(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return cut(raw, ARG_CHARS)
  }
  if (parsed === null || typeof parsed !== 'object') return cut(String(parsed), ARG_CHARS)
  const args = parsed as Record<string, unknown>
  const key = MAIN_ARGUMENTS.find((name) => typeof args[name] === 'string') ?? Object.keys(args).find((name) => typeof args[name] === 'string')
  return key === undefined ? '' : cut(String(args[key]), ARG_CHARS)
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Summarise a run's events.
 *
 * @param events every event of the run, subagents' included.
 * @param reply the run's final text.
 * @returns the trail.
 */
export function runTrail(events: readonly SessionEvent[], reply: string): RunTrail {
  const failed = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/result' && event.data.message.isError === true) failed.add(event.data.message.toolCallId as string)
  }
  const calls = events.flatMap((event) =>
    event.type === 'tool/call'
      ? [{ name: event.data.name, arg: mainArgument(event.data.arguments), failed: failed.has(event.data.callId as string) }]
      : [],
  )
  const text = reply.trim()
  return { tools: calls.slice(0, TOOLS_KEPT), toolsTotal: calls.length, reply: text.length <= REPLY_CHARS ? text : `${text.slice(0, REPLY_CHARS - 1)}…` }
}
