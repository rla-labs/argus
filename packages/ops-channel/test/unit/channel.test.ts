// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for the pure channel layers: access, routing and formatting.
 *
 * These are the rules a user notices — who may talk to the system, where a
 * message goes, and whether a long answer arrives whole.
 */
import { describe, expect, it } from 'vitest'
import type { AdapterLimits, ContentBlockLike } from '@argus-agent/types'
import { AccessPolicy, warningText, type AccessConfig } from '../../src/access.js'
import { decideRoute, unroutableText } from '../../src/routing.js'
import {
  budgetText,
  chunkText,
  formatOutput,
  interruptedText,
  panicText,
  prefixFor,
  progressText,
  scheduleSkippedText,
  shouldSendProgress,
  stalledText,
  stoppedText,
  summarise,
  textOf,
} from '../../src/format.js'
import { adminOf, allowedWithAdmin, parseAddress } from '../../src/config.js'

/** An access config, with defaults. */
function accessConfig(overrides: Partial<AccessConfig> = {}): AccessConfig {
  return {
    allowed_users: [],
    admin: undefined,
    warnIntervalMs: 60_000,
    ...overrides,
  }
}

/** Adapter limits, with defaults. */
const LIMITS: AdapterLimits = { maxTextLength: 100, maxFileBytes: 1_000 }

describe('AccessPolicy', () => {
  it('denies everything with no allowlist', () => {
    // Default deny. A deployment that has not said who may operate the system
    // has not authorized anyone.
    const policy = new AccessPolicy(accessConfig())
    expect(policy.check('telegram', '123').allowed).toBe(false)
    expect(policy.check('telegram', '123').reason).toBe('no_allowlist')
    expect(policy.isEmpty).toBe(true)
  })

  it('reads the users /allow added on every check', () => {
    let added = [{ channel: 'telegram', userId: '7' }]
    const policy = new AccessPolicy(accessConfig(), () => added)
    expect(policy.isAllowed('telegram', '7')).toBe(true)
    expect(policy.isEmpty).toBe(false)
    added = []
    expect(policy.check('telegram', '7').reason).toBe('no_allowlist')
  })

  it('knows the admin: the user, or anyone in the admin’s group chat', () => {
    const user = new AccessPolicy(accessConfig({ admin: { channel: 'telegram', chatId: '42' } }))
    expect(user.isAdmin({ channel: 'telegram', chatId: '42' }, '42')).toBe(true)
    expect(user.isAdmin({ channel: 'telegram', chatId: '-100' }, '42')).toBe(true)
    expect(user.isAdmin({ channel: 'telegram', chatId: '43' }, '43')).toBe(false)
    expect(user.isAdmin({ channel: 'slack', chatId: '42' }, '42')).toBe(false)
    const group = new AccessPolicy(accessConfig({ admin: { channel: 'telegram', chatId: '-100' } }))
    expect(group.isAdmin({ channel: 'telegram', chatId: '-100' }, '43')).toBe(true)
    expect(new AccessPolicy(accessConfig()).isAdmin({ channel: 'telegram', chatId: '42' }, '42')).toBe(false)
  })

  it('allows a listed user on a listed channel', () => {
    const policy = new AccessPolicy(
      accessConfig({ allowed_users: [{ channel: 'telegram', userId: '123' }] }),
    )
    expect(policy.isAllowed('telegram', '123')).toBe(true)
  })

  it('denies a listed user on a DIFFERENT channel', () => {
    const policy = new AccessPolicy(
      accessConfig({ allowed_users: [{ channel: 'telegram', userId: '123' }] }),
    )
    expect(policy.isAllowed('slack', '123')).toBe(false)
    expect(policy.check('slack', '123').reason).toBe('not_listed')
  })

  it('honours a wildcard channel', () => {
    const policy = new AccessPolicy(accessConfig({ allowed_users: [{ channel: '*', userId: '123' }] }))
    expect(policy.isAllowed('telegram', '123')).toBe(true)
    expect(policy.isAllowed('slack', '123')).toBe(true)
  })

  it('matches the user id EXACTLY', () => {
    // The classic allowlist bug: a prefix or substring match would let `123`
    // authorize `1234` and `91234`.
    const policy = new AccessPolicy(
      accessConfig({ allowed_users: [{ channel: 'telegram', userId: '123' }] }),
    )
    expect(policy.isAllowed('telegram', '1234')).toBe(false)
    expect(policy.isAllowed('telegram', '12')).toBe(false)
    expect(policy.isAllowed('telegram', '9123')).toBe(false)
    expect(policy.isAllowed('telegram', '')).toBe(false)
  })

  it('is case-sensitive on the user id', () => {
    const policy = new AccessPolicy(accessConfig({ allowed_users: [{ channel: 'c', userId: 'AbC' }] }))
    expect(policy.isAllowed('c', 'abc')).toBe(false)
  })

  it('allows any listed user among several', () => {
    const policy = new AccessPolicy(
      accessConfig({
        allowed_users: [
          { channel: 'telegram', userId: '1' },
          { channel: 'slack', userId: '2' },
        ],
      }),
    )
    expect(policy.isAllowed('telegram', '1')).toBe(true)
    expect(policy.isAllowed('slack', '2')).toBe(true)
    expect(policy.isAllowed('telegram', '2')).toBe(false)
    expect(policy.size).toBe(2)
  })

  it('rate-limits the admin warning', () => {
    const policy = new AccessPolicy(
      accessConfig({ admin: { channel: 'c', chatId: 'a' }, warnIntervalMs: 60_000 }),
    )
    // The first warning is always sent, whatever the clock reads.
    expect(policy.shouldWarn(0)).toBe(true)
    expect(policy.shouldWarn(1_000)).toBe(false)
    expect(policy.shouldWarn(2_000)).toBe(false)
    // The suppressed count is reported on the next warning, so an operator learns
    // how many attempts they did not see.
    expect(policy.suppressed).toBe(2)
    expect(policy.shouldWarn(61_000)).toBe(true)
    expect(policy.suppressed).toBe(0)
  })

  it('never warns without an admin address', () => {
    const policy = new AccessPolicy(accessConfig({ allowed_users: [{ channel: 'c', userId: '1' }] }))
    expect(policy.shouldWarn(0)).toBe(false)
  })
})

describe('warningText', () => {
  it('names the user and the channel', () => {
    const text = warningText('telegram', '999', 'not_listed', 0)
    expect(text).toContain('telegram')
    expect(text).toContain('999')
    expect(text).toContain('not in access.allowed_users')
  })

  it('reports the suppressed count', () => {
    expect(warningText('c', 'u', 'not_listed', 5)).toContain('5 further attempt(s)')
  })

  it('explains an empty allowlist', () => {
    expect(warningText('c', 'u', 'no_allowlist', 0)).toContain('No access.allowed_users')
  })

  it('never contains message content', () => {
    // The function has no way to receive content, which is the point.
    const text = warningText('c', 'u', 'not_listed', 0)
    expect(text).not.toContain('text')
  })
})

describe('decideRoute', () => {
  const allowed = { allowed: true }
  const denied = { allowed: false, reason: 'not_listed' as const }

  const cases: Array<[string, string, Parameters<typeof decideRoute>[1], string]> = [
    ['a command routes to command', '/status', { access: allowed, activeProject: undefined, hasOrchestrator: false, hasAttachments: false }, 'command'],
    ['a command ignores the active project', '/p beta', { access: allowed, activeProject: 'alpha', hasOrchestrator: true, hasAttachments: false }, 'command'],
    ['free text with a project routes to it', 'do the thing', { access: allowed, activeProject: 'alpha', hasOrchestrator: false, hasAttachments: false }, 'project'],
    ['free text with a project AND an orchestrator still goes to the project', 'hi', { access: allowed, activeProject: 'alpha', hasOrchestrator: true, hasAttachments: false }, 'project'],
    ['free text with no project goes to the orchestrator', 'hi', { access: allowed, activeProject: undefined, hasOrchestrator: true, hasAttachments: false }, 'orchestrator'],
    ['free text with neither gets help', 'hi', { access: allowed, activeProject: undefined, hasOrchestrator: false, hasAttachments: false }, 'help'],
    ['an empty active project is treated as absent', 'hi', { access: allowed, activeProject: '', hasOrchestrator: false, hasAttachments: false }, 'help'],
    ['a denied user is rejected before anything else', '/status', { access: denied, activeProject: 'alpha', hasOrchestrator: true, hasAttachments: false }, 'rejected'],
    ['a denied user with free text is rejected', 'hi', { access: denied, activeProject: 'alpha', hasOrchestrator: true, hasAttachments: false }, 'rejected'],
    ['attachments do not change the destination', 'hi', { access: allowed, activeProject: 'alpha', hasOrchestrator: false, hasAttachments: true }, 'project'],
  ]

  it.each(cases)('%s', (_name, text, state, expected) => {
    expect(decideRoute(text, state).kind).toBe(expected)
  })

  it('carries the command line', () => {
    const route = decideRoute('  /status alpha  ', {
      access: allowed,
      activeProject: undefined,
      hasOrchestrator: false,
      hasAttachments: false,
    })
    expect(route.line).toBe('/status alpha')
  })

  it('carries the project id', () => {
    const route = decideRoute('work', {
      access: allowed,
      activeProject: 'alpha',
      hasOrchestrator: false,
      hasAttachments: false,
    })
    expect(route.projectId).toBe('alpha')
  })

  it('carries the refusal reason', () => {
    const route = decideRoute('x', {
      access: { allowed: false, reason: 'no_allowlist' },
      activeProject: undefined,
      hasOrchestrator: false,
      hasAttachments: false,
    })
    expect(route.reason).toBe('no_allowlist')
  })
})

describe('unroutableText', () => {
  it('names both escapes', () => {
    const text = unroutableText()
    // The user's next action is one of two things; making them guess is the
    // failure this message exists to prevent.
    expect(text).toContain('/p')
    expect(text).toContain('/task')
  })
})

describe('prefixFor', () => {
  const cases: Array<[Parameters<typeof prefixFor>[0], string]> = [
    [{ kind: 'project', projectId: 'alpha' }, '[alpha] '],
    [{ kind: 'project' }, '[project] '],
    [{ kind: 'adhoc' }, '[task] '],
    [{ kind: 'orchestrator' }, ''],
  ]

  it.each(cases)('renders %o', (subject, expected) => {
    expect(prefixFor(subject)).toBe(expected)
  })
})

describe('textOf', () => {
  it('joins text blocks', () => {
    const blocks: ContentBlockLike[] = [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]
    expect(textOf(blocks)).toBe('one\ntwo')
  })

  it('skips non-text and empty blocks', () => {
    const blocks: ContentBlockLike[] = [
      { type: 'image' },
      { type: 'text', text: '' },
      { type: 'text', text: 'kept' },
    ]
    expect(textOf(blocks)).toBe('kept')
  })

  it('handles an empty list', () => {
    expect(textOf([])).toBe('')
  })
})

describe('formatOutput', () => {
  it('prefixes the text', () => {
    const out = formatOutput([{ type: 'text', text: 'done' }], { kind: 'project', projectId: 'alpha' }, LIMITS)
    expect(out.text).toBe('[alpha] done')
  })

  it('leaves a short message alone', () => {
    const out = formatOutput([{ type: 'text', text: 'short' }], { kind: 'adhoc' }, LIMITS)
    expect(out.files).toHaveLength(0)
    expect(out.text).toBe('[task] short')
  })

  it('converts long output to a markdown file with a summary', () => {
    // Truncating a project's answer would silently lose the end of it, which for
    // a report is the part that matters.
    const long = 'x'.repeat(500)
    const out = formatOutput([{ type: 'text', text: long }], { kind: 'project', projectId: 'alpha' }, LIMITS)
    expect(out.files).toHaveLength(1)
    expect(out.files[0]?.name).toBe('alpha-output.md')
    expect(out.text).toContain('sent as alpha-output.md')
    expect(out.text.length).toBeLessThan(LIMITS.maxTextLength)
  })

  it('stores the FULL text in the file, not the summary', () => {
    const long = `first line\n${'y'.repeat(500)}`
    const out = formatOutput([{ type: 'text', text: long }], { kind: 'adhoc' }, LIMITS)
    const bytes = out.files[0]?.bytes as Uint8Array
    expect(new TextDecoder().decode(bytes)).toContain('y'.repeat(500))
  })

  it('keeps the prefix on the summary line', () => {
    const out = formatOutput([{ type: 'text', text: 'z'.repeat(500) }], { kind: 'project', projectId: 'beta' }, LIMITS)
    expect(out.text.startsWith('[beta] ')).toBe(true)
  })

  it('attaches a produced file within the size limit', () => {
    const out = formatOutput(
      [{ type: 'text', text: 'done' }],
      { kind: 'adhoc' },
      LIMITS,
      [{ name: 'report.pdf', path: '/tmp/report.pdf', sizeBytes: 500 }],
    )
    expect(out.files.map((file) => file.name)).toEqual(['report.pdf'])
    expect(out.tooLarge).toHaveLength(0)
  })

  it('lists a file too large to attach', () => {
    const out = formatOutput(
      [{ type: 'text', text: 'done' }],
      { kind: 'adhoc' },
      LIMITS,
      [{ name: 'huge.bin', path: '/tmp/huge.bin', sizeBytes: 99_999 }],
    )
    expect(out.files).toHaveLength(0)
    expect(out.tooLarge).toEqual(['/tmp/huge.bin'])
    expect(out.text).toContain('/tmp/huge.bin')
    expect(out.text).toContain('Too large to send')
  })

  it('attaches a file with no known size', () => {
    // An unknown size is not a reason to refuse: the adapter enforces its own
    // limit and reports a failure the channel can surface.
    const out = formatOutput(
      [{ type: 'text', text: 'done' }],
      { kind: 'adhoc' },
      LIMITS,
      [{ name: 'x.txt', path: '/tmp/x.txt' }],
    )
    expect(out.files).toHaveLength(1)
  })

  it('counts the file list when deciding to convert', () => {
    // The length check must measure what will actually be sent.
    const text = 'a'.repeat(60)
    const out = formatOutput(
      [{ type: 'text', text }],
      { kind: 'adhoc' },
      LIMITS,
      [{ name: 'huge.bin', path: `/tmp/${'p'.repeat(80)}.bin`, sizeBytes: 99_999 }],
    )
    expect(out.files.some((file) => file.name.endsWith('.md'))).toBe(true)
  })
})

describe('summarise', () => {
  it('uses the first non-empty line', () => {
    expect(summarise('[a] ', '\n\nfirst\nsecond', 500, 'x.md')).toContain('first')
  })

  it('truncates a long first line', () => {
    const text = summarise('[a] ', 'q'.repeat(500), 500, 'x.md', 200)
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text).toContain('…')
  })

  it('names the file and the length', () => {
    expect(summarise('', 'body', 1234, 'out.md')).toContain('1234 characters')
  })
})

describe('shouldSendProgress', () => {
  it('sends the first update immediately', () => {
    // A long run must show something at once rather than a blank chat.
    expect(shouldSendProgress({ messageId: undefined, lastSentAt: 0, sent: false }, 0, 20_000)).toBe(true)
  })

  it('throttles later updates', () => {
    const state = { messageId: 'm', lastSentAt: 1_000, sent: true }
    expect(shouldSendProgress(state, 5_000, 20_000)).toBe(false)
    expect(shouldSendProgress(state, 21_000, 20_000)).toBe(true)
  })

  it('sends exactly at the interval', () => {
    expect(shouldSendProgress({ messageId: 'm', lastSentAt: 0, sent: true }, 20_000, 20_000)).toBe(true)
  })
})

describe('progressText', () => {
  it('reports steps against the limit', () => {
    // "12 steps" means nothing to an operator; "12 (limit 60 per run)" says how much rope is
    // left.
    const text = progressText({
      subject: { kind: 'project', projectId: 'alpha' },
      steps: 12,
      elapsedMs: 90_000,
      maxSteps: 60,
      costMicros: 1_500,
    })
    expect(text).toContain('[alpha]')
    expect(text).toContain('step    12 (limit 60 per run)')
    expect(text).toContain('1m 30s')
    expect(text).toContain('$0.0015')
  })

  it('renders under a minute in seconds', () => {
    const text = progressText({ subject: { kind: 'adhoc' }, steps: 1, elapsedMs: 5_000, maxSteps: 60, costMicros: 0 })
    expect(text).toContain('5s')
  })
})

describe('notice texts', () => {
  it('stoppedText names the reason', () => {
    const text = stoppedText({ kind: 'project', projectId: 'a' }, 'budget_stopped', 'the budget is exhausted')
    expect(text).toContain('[a]')
    expect(text).toContain('the budget is exhausted')
    expect(text).toContain('budget_stopped')
  })

  it('interruptedText names the run and reassures about finished work', () => {
    const text = interruptedText({ kind: 'adhoc' }, 'run-1')
    expect(text).toContain('run-1')
    expect(text).toContain('interrupted')
  })

  it('budgetText marks the level', () => {
    expect(budgetText('global', 'hard', 120, 12_000_000, 10_000_000)).toContain('⛔')
    expect(budgetText('global', 'soft', 85, 8_500_000, 10_000_000)).toContain('⚠️')
    expect(budgetText('global', 'info', 55, 5_500_000, 10_000_000)).toContain('ℹ️')
    expect(budgetText('global', 'hard', 120, 12_000_000, 10_000_000)).toContain('120%')
  })

  it('stalledText reports the wait and the reason', () => {
    const text = stalledText('req-1', 'alpha', 900_000, 'global_slots_full')
    expect(text).toContain('15 minute(s)')
    expect(text).toContain('global_slots_full')
  })

  it('stalledText handles an unknown reason', () => {
    expect(stalledText('req-1', null, 900_000, undefined)).toContain('not yet determined')
  })

  it('panicText reports the count and the time', () => {
    const text = panicText(3, 120)
    expect(text).toContain('3 agent(s)')
    expect(text).toContain('120 ms')
    expect(text).toContain('/resume-all')
  })

  it('scheduleSkippedText names the task and the reason', () => {
    const text = scheduleSkippedText('nightly', 'the project is paused')
    expect(text).toContain('nightly')
    expect(text).toContain('the project is paused')
  })
})

describe('chunkText', () => {
  it('leaves a short text alone', () => {
    expect(chunkText('short', 100)).toEqual(['short'])
  })

  it('splits at a newline', () => {
    const text = `${'a'.repeat(90)}\n${'b'.repeat(90)}`
    const chunks = chunkText(text, 100)
    expect(chunks).toHaveLength(2)
    // The cut lands ON the newline, which then opens the next chunk. What matters
    // is that joining the chunks returns the original text exactly.
    expect(chunks[0]).toBe('a'.repeat(90))
    expect(chunks.join('')).toBe(text)
  })

  it('cuts hard when no newline is near the limit', () => {
    const chunks = chunkText('x'.repeat(250), 100)
    expect(chunks).toHaveLength(3)
    expect(chunks.join('')).toBe('x'.repeat(250))
  })

  it('never exceeds the limit', () => {
    for (const max of [10, 50, 100]) {
      for (const chunk of chunkText(`${'ab\n'.repeat(200)}`, max)) {
        expect(chunk.length).toBeLessThanOrEqual(max)
      }
    }
  })

  it('preserves every character', () => {
    // Joining the chunks must reproduce the original exactly: a split that drops
    // the boundary character would silently corrupt a long answer.
    for (const text of [`${'line one\n'.repeat(50)}end`, 'x'.repeat(250), 'a\nb\nc\nd\ne']) {
      expect(chunkText(text, 40).join(''), JSON.stringify(text.slice(0, 20))).toBe(text)
    }
  })
})

describe('adminOf and allowedWithAdmin', () => {
  it('reads a bare id as a Telegram chat', () => {
    expect(adminOf(888878901)).toEqual({ channel: 'telegram', chatId: '888878901' })
    expect(adminOf('888878901')).toEqual({ channel: 'telegram', chatId: '888878901' })
    expect(adminOf('-100123')).toEqual({ channel: 'telegram', chatId: '-100123' })
    expect(adminOf('slack:U1')).toEqual({ channel: 'slack', chatId: 'U1' })
    expect(adminOf(null)).toBeUndefined()
    expect(adminOf(1.5)).toBeUndefined()
  })

  it('puts the admin on the allowlist once', () => {
    const admin = { channel: 'telegram', chatId: '42' }
    expect(allowedWithAdmin([], admin)).toEqual([{ channel: 'telegram', userId: '42' }])
    const listed = [{ channel: '*', userId: '42' }]
    expect(allowedWithAdmin(listed, admin)).toBe(listed)
    // Same id on another channel is a different person.
    expect(allowedWithAdmin([{ channel: 'slack', userId: '42' }], admin)).toHaveLength(2)
    expect(allowedWithAdmin(listed, undefined)).toBe(listed)
  })
})

describe('parseAddress', () => {
  it('parses the short form', () => {
    expect(parseAddress('telegram:12345')).toEqual({ channel: 'telegram', chatId: '12345' })
  })

  it('parses a thread id', () => {
    expect(parseAddress('telegram:12345:99')).toEqual({ channel: 'telegram', chatId: '12345', threadId: '99' })
  })

  it('parses the JSON form the store uses', () => {
    expect(parseAddress('{"channel":"c","chatId":"1"}')).toEqual({ channel: 'c', chatId: '1' })
  })

  it('returns undefined for null, empty and malformed input', () => {
    for (const bad of [null, '', '   ', 'noseparator', ':123', 'telegram:']) {
      expect(parseAddress(bad), String(bad)).toBeUndefined()
    }
  })

  it('returns undefined for malformed JSON', () => {
    expect(parseAddress('{not json}')).toBeUndefined()
  })
})
