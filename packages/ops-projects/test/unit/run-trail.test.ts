// == ARGUS AGENT PROJECT ==
/** Unit tests for the run trail `/log` shows. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { runAnswer, runTrail } from '../../src/run-trail.js'

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

function said(text: string, ...tools: string[]): SessionEvent {
  const content = [{ type: 'text', text }, ...tools.map((name, i) => ({ type: 'tool-call', id: `c${i}`, name, arguments: '{}' }))]
  return { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content } } } as unknown as SessionEvent
}

describe('runAnswer', () => {
  it('keeps the answer written next to a todo_write, not just the closing line', () => {
    // The Substack task in production: the list, a todo tick, then one closing sentence.
    const answer = runAnswer([said('Let me look.', 'web_fetch'), said('1. First article', 'todo_write'), said('All ten are recent.')])
    expect(answer).toBe('1. First article\n\nAll ten are recent.')
  })

  it('restarts after a real tool call, and is undefined with no text after it', () => {
    expect(runAnswer([said('Draft', 'todo_write'), said('Checking.', 'bash'), said('Final.')])).toBe('Final.')
    expect(runAnswer([said('Fetching.', 'web_fetch')])).toBeUndefined()
  })
})
