// == ARGUS AGENT PROJECT ==
/** Unit tests for the run trail `/log` shows. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { runTrail } from '../../src/run-trail.js'

function call(callId: string, name: string, args: unknown): SessionEvent {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } } as unknown as SessionEvent
}

function failed(callId: string): SessionEvent {
  return { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, isError: true, content: [] } } } as unknown as SessionEvent
}

describe('runTrail', () => {
  it('keeps each call’s name and main argument, and marks the failed ones', () => {
    const trail = runTrail(
      [call('1', 'bash', { command: 'npm   test', timeout: 60 }), failed('1'), call('2', 'write', { content: 'x', path: 'src/a.ts' }), call('3', 'odd', 'not json')],
      '  All done.  ',
    )
    expect(trail).toEqual({
      tools: [
        { name: 'bash', arg: 'npm test', failed: true },
        { name: 'write', arg: 'src/a.ts', failed: false },
        { name: 'odd', arg: 'not json', failed: false },
      ],
      toolsTotal: 3,
      reply: 'All done.',
    })
  })

  it('caps the calls, the arguments and the reply', () => {
    const calls = Array.from({ length: 50 }, (_, i) => call(String(i), 'read', { path: 'p'.repeat(300) }))
    const trail = runTrail(calls, 'r'.repeat(2_000))
    expect(trail.tools).toHaveLength(40)
    expect(trail.toolsTotal).toBe(50)
    expect(trail.tools[0]?.arg).toHaveLength(100)
    expect(trail.reply).toHaveLength(600)
  })
})
