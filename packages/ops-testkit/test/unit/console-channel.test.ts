// == ARGUS AGENT PROJECT ==
/**
 * Tests for the console channel adapter.
 *
 * The adapter is the fixture every routing and delivery test in `ops-channel`
 * will use, so its test controls (inject, answer, inspect) must be exact.
 */
import { describe, expect, it, vi } from 'vitest'
import { ConsoleChannelAdapter } from '../../src/console-channel.js'

/** Start an adapter and return it with its disposer. */
async function started(options?: ConstructorParameters<typeof ConsoleChannelAdapter>[0]) {
  const adapter = new ConsoleChannelAdapter(options)
  const messages: unknown[] = []
  const buttons: unknown[] = []
  const stop = await adapter.start(
    (message) => messages.push(message),
    (answer) => buttons.push(answer),
  )
  return { adapter, stop, messages, buttons }
}

describe('ConsoleChannelAdapter', () => {
  it('records sent messages and returns a message reference', async () => {
    const { adapter } = await started()
    const ref = await adapter.send({ channel: 'console', chatId: 'c1' }, { text: 'hello' })

    expect(ref).toEqual({ channel: 'console', chatId: 'c1', messageId: 'msg-1' })
    expect(adapter.sent).toHaveLength(1)
    expect(adapter.sent[0]?.message.text).toBe('hello')
    expect(adapter.sent[0]?.edited).toBe(false)
    expect(adapter.texts()).toEqual(['hello'])
  })

  it('assigns increasing message ids and sequence numbers', async () => {
    const { adapter } = await started()
    await adapter.send({ channel: 'console', chatId: 'c1' }, { text: 'a' })
    await adapter.send({ channel: 'console', chatId: 'c1' }, { text: 'b' })

    expect(adapter.sent.map((entry) => entry.ref.messageId)).toEqual(['msg-1', 'msg-2'])
    expect(adapter.sent.map((entry) => entry.sequence)).toEqual([0, 1])
  })

  it('delivers an injected message to the registered handler', async () => {
    const { adapter, messages } = await started()
    adapter.receive({ text: '/projects', userId: 'u1', chatId: 'c9' })

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      text: '/projects',
      userId: 'u1',
      address: { channel: 'console', chatId: 'c9' },
      isGroup: false,
    })
  })

  it('fills in defaults for an injected message', async () => {
    const { adapter, messages } = await started()
    adapter.receive({ text: 'hi', userId: 'u1' })

    expect(messages[0]).toMatchObject({
      id: expect.stringMatching(/^in-/),
      userId: 'u1',
      userName: 'u1',
      timestamp: expect.any(Number),
    })
    // A missing chatId defaults to a single conventional chat.
    expect((messages[0] as { address: { chatId: string } }).address.chatId).toBe('chat-1')
  })

  it('marks a group message', async () => {
    const { adapter, messages } = await started()
    adapter.receive({ text: 'hi', userId: 'u1', isGroup: true })
    expect((messages[0] as { isGroup: boolean }).isGroup).toBe(true)
  })

  it('refuses to receive before start or after stop', async () => {
    const adapter = new ConsoleChannelAdapter()
    expect(() => adapter.receive({ text: 'x', userId: 'u' })).toThrow(/start\(\) has not been called/)

    const { adapter: live, stop } = await started()
    await stop()
    expect(() => live.receive({ text: 'x', userId: 'u' })).toThrow(/has been stopped/)
  })

  it('treats an edit as an edit, not a new message', async () => {
    const { adapter } = await started()
    const ref = await adapter.send({ channel: 'console', chatId: 'c1' }, { text: 'step 1' })
    await adapter.edit(ref, { text: 'step 2' })

    expect(adapter.sent).toHaveLength(2)
    expect(adapter.sent[1]?.edited).toBe(true)
    expect(adapter.sent[1]?.message.text).toBe('step 2')
    // The edit reuses the original message id, which is what makes a progress
    // message an edit rather than a flood.
    expect(adapter.sent[1]?.ref.messageId).toBe(ref.messageId)
  })

  it('sends an editOf message through the edit path', async () => {
    const { adapter } = await started()
    const ref = await adapter.send({ channel: 'console', chatId: 'c1' }, { text: 'first' })
    const returned = await adapter.send(
      { channel: 'console', chatId: 'c1' },
      { text: 'updated', editOf: ref },
    )
    expect(returned.messageId).toBe(ref.messageId)
    expect(adapter.sent[1]?.edited).toBe(true)
  })

  it('surfaces a configured send failure', async () => {
    const failure = new Error('network down')
    const { adapter } = await started({ failSends: failure })
    await expect(adapter.send({ channel: 'console', chatId: 'c1' }, { text: 'x' })).rejects.toThrow(
      'network down',
    )
  })

  it('asks a question, sends its buttons, and resolves on an answer', async () => {
    const { adapter, buttons } = await started()
    const pending = adapter.ask({ channel: 'console', chatId: 'c1' }, {
      id: 'q1',
      text: 'Approve this?',
      buttons: [
        { value: 'approve', label: 'Approve' },
        { value: 'deny', label: 'Deny' },
      ],
    })

    // The question is sent as a normal message carrying the buttons.
    expect(adapter.sent).toHaveLength(1)
    expect(adapter.sent[0]?.message.buttons).toHaveLength(2)
    expect(adapter.pendingQuestion?.id).toBe('q1')
    expect(adapter.pendingCount).toBe(1)

    expect(adapter.answer('approve', 'u1')).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'button', value: 'approve' })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toMatchObject({ questionId: 'q1', value: 'approve', userId: 'u1' })
    expect(adapter.pendingCount).toBe(0)
  })

  it('resolves a question with timeout when the timer elapses', async () => {
    vi.useFakeTimers()
    try {
      const { adapter } = await started()
      const pending = adapter.ask({ channel: 'console', chatId: 'c1' }, {
        id: 'q-timeout',
        text: 'Approve?',
        buttons: [{ value: 'yes', label: 'Yes' }],
        timeoutMs: 1000,
      })
      expect(adapter.pendingCount).toBe(1)

      vi.advanceTimersByTime(1000)
      await expect(pending).resolves.toBe('timeout')
      expect(adapter.pendingCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports no pending question when none is asked', async () => {
    const { adapter } = await started()
    expect(adapter.pendingQuestion).toBeUndefined()
    expect(adapter.answer('anything')).toBe(false)
  })

  it('resolves outstanding questions with timeout on stop', async () => {
    const { adapter, stop } = await started()
    const pending = adapter.ask({ channel: 'console', chatId: 'c1' }, {
      id: 'q-stop',
      text: 'Approve?',
      buttons: [{ value: 'yes', label: 'Yes' }],
    })
    await stop()
    // A shutdown must not leave a caller awaiting forever.
    await expect(pending).resolves.toBe('timeout')
    expect(adapter.isStarted).toBe(false)
  })

  it('declares Telegram-like limits by default and accepts overrides', async () => {
    const { adapter } = await started()
    expect(adapter.limits.maxTextLength).toBe(4096)

    const custom = new ConsoleChannelAdapter({ name: 'tiny', limits: { maxTextLength: 10, maxFileBytes: 5 } })
    expect(custom.name).toBe('tiny')
    expect(custom.limits.maxTextLength).toBe(10)
  })

  it('clears recorded state between assertions', async () => {
    const { adapter } = await started()
    await adapter.send({ channel: 'console', chatId: 'c1' }, { text: 'a' })
    adapter.clear()
    expect(adapter.sent).toHaveLength(0)
    expect(adapter.texts()).toEqual([])
    // Ids restart, so a test that clears does not have to account for earlier ones.
    const ref = await adapter.send({ channel: 'console', chatId: 'c1' }, { text: 'b' })
    expect(ref.messageId).toBe('msg-1')
  })
})
