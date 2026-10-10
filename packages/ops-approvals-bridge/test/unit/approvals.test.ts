// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for `ops-approvals-bridge`'s pure layers.
 *
 * The argv module is a **security boundary**: the allowlist decides what a project
 * runs without a human looking at it. Its tests are therefore mostly attacks.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyAction,
  isCompound,
  matchAllowList,
  matchesRule,
  parseAction,
  renderAction,
  tokenizeCommand,
} from '../../src/argv.js'
import { isInside } from '@argus-agent/types'
import { decideApproval, isGrant, policyOf } from '../../src/policy.js'
import {
  APPROVE,
  APPROVE_ALL,
  DENY,
  approvalButtons,
  approvalQuestion,
  decisionText,
  refusedText,
  sanitize,
} from '../../src/question.js'
import { approvalsOf } from '../../src/config.js'

// ── tokenizing ─────────────────────────────────────────────────────────────

describe('tokenizeCommand', () => {
  it.each([
    ['git status', ['git', 'status']],
    ['  git   status  ', ['git', 'status']],
    ['git status --short', ['git', 'status', '--short']],
    ['echo "hello world"', ['echo', 'hello world']],
    ["echo 'hello world'", ['echo', 'hello world']],
    ['echo  spaced', ['echo', 'spaced']],
    ['cmd\\ with\\ escapes', ['cmd with escapes']],
    ['a\tb', ['a', 'b']],
    ['', []],
    ['   ', []],
  ])('tokenizes %j', (line, expected) => {
    expect(tokenizeCommand(line)).toEqual(expected)
  })

  it('keeps shell metacharacters as ordinary characters', () => {
    // The whole reason token matching is safe: `;` is not special here, so it
    // becomes part of a token rather than starting a second command.
    expect(tokenizeCommand('git status; rm -rf /')).toEqual(['git', 'status;', 'rm', '-rf', '/'])
    expect(tokenizeCommand('a && b')).toEqual(['a', '&&', 'b'])
    expect(tokenizeCommand('a | b')).toEqual(['a', '|', 'b'])
    expect(tokenizeCommand('$(whoami)')).toEqual(['$(whoami)'])
    expect(tokenizeCommand('`id`')).toEqual(['`id`'])
  })

  it('returns nothing for an unterminated quote', () => {
    // Unusable, so it matches no rule and therefore asks.
    expect(tokenizeCommand('echo "unterminated')).toEqual([])
    expect(tokenizeCommand("echo 'unterminated")).toEqual([])
  })

  it('handles a quoted empty string as a token', () => {
    expect(tokenizeCommand('cmd ""')).toEqual(['cmd', ''])
  })
})

// ── matching ───────────────────────────────────────────────────────────────

describe('matchesRule', () => {
  it('matches a token-level prefix', () => {
    // The useful notion of prefix: `git status` covers `git status --short`.
    expect(matchesRule(['git', 'status', '--short'], ['git', 'status'])).toBe(true)
    expect(matchesRule(['git', 'status'], ['git', 'status'])).toBe(true)
  })

  it('requires an EXACT token match', () => {
    expect(matchesRule(['git', 'statuses'], ['git', 'status'])).toBe(false)
    expect(matchesRule(['git', 'push'], ['git', 'status'])).toBe(false)
    expect(matchesRule(['git', 'stat'], ['git', 'status'])).toBe(false)
  })

  it('requires enough tokens', () => {
    expect(matchesRule(['git'], ['git', 'status'])).toBe(false)
    expect(matchesRule([], ['git'])).toBe(false)
  })

  it('never matches an empty rule', () => {
    expect(matchesRule(['git', 'status'], [])).toBe(false)
  })

  it('is case-sensitive', () => {
    // A shell command is case-sensitive, so a rule must be too.
    expect(matchesRule(['Git', 'status'], ['git', 'status'])).toBe(false)
    expect(matchesRule(['GIT', 'STATUS'], ['git', 'status'])).toBe(false)
  })
})

describe('isCompound', () => {
  it('detects every chaining operator', () => {
    for (const operator of ['&&', '||', '&', ';', '|', '>', '>>', '<', '2>']) {
      expect(isCompound(tokenizeCommand(`a ${operator} b`)), operator).toBe(true)
    }
  })

  it('detects substitution inside a token', () => {
    // These attach to an argument, so they are not separate tokens.
    expect(isCompound(['echo', '$(whoami)'])).toBe(true)
    expect(isCompound(['echo', '`id`'])).toBe(true)
    expect(isCompound(['echo', '${HOME}'])).toBe(true)
  })

  it('detects redirection attached to a token', () => {
    expect(isCompound(['echo', '>file'])).toBe(true)
    expect(isCompound(['cmd', '<input'])).toBe(true)
  })

  it('accepts a simple command with options', () => {
    expect(isCompound(['git', 'status', '--short'])).toBe(false)
    expect(isCompound(['npm', 'test'])).toBe(false)
    expect(isCompound([])).toBe(false)
  })

  it('accepts a flag whose value contains a dash', () => {
    expect(isCompound(['cmd', '--opt=value'])).toBe(false)
  })
})

describe('matchAllowList — trailing tokens', () => {
  it('allows a permitted command with FLAGS', () => {
    // `git status --short` is the same command with an option.
    expect(matchAllowList(['git', 'status', '--short'], ['git status']).allowed).toBe(true)
    expect(matchAllowList(['git', 'status', '-s'], ['git status']).allowed).toBe(true)
  })

  it('REFUSES a bare word after the match', () => {
    // A positional argument could be a subcommand or a path the rule never named,
    // so the rule must be extended to name it explicitly.
    expect(matchAllowList(['git', 'status', 'rm'], ['git status']).allowed).toBe(false)
    expect(matchAllowList(['npm', 'test', 'install'], ['npm test']).allowed).toBe(false)
  })

  it('REFUSES a second command hidden behind a line break', () => {
    // A newline is a token separator with no metacharacter, so only the
    // whole-argv rule catches it.
    expect(matchAllowList(tokenizeCommand('git status\nrm -rf /'), ['git status']).allowed).toBe(false)
  })
})

describe('matchAllowList — the bypass attacks', () => {
  const rules = ['git status', 'npm test', 'ls -la']

  it('allows the permitted commands', () => {
    expect(matchAllowList(['git', 'status'], rules)).toEqual({ allowed: true, rule: 'git status' })
    expect(matchAllowList(['git', 'status', '--short'], rules).allowed).toBe(true)
    expect(matchAllowList(['npm', 'test'], rules).allowed).toBe(true)
  })

  it('REFUSES `git status; rm -rf /`', () => {
    // The attack the prompt names. A raw-string prefix match would allow it,
    // because the forbidden part comes after the permitted prefix. Token matching
    // fails at the second token: `status;` !== `status`.
    const argv = tokenizeCommand('git status; rm -rf /')
    expect(matchAllowList(argv, rules).allowed).toBe(false)
  })

  it('refuses a chained command with &&', () => {
    expect(matchAllowList(tokenizeCommand('git status && rm -rf /'), rules).allowed).toBe(false)
  })

  it('refuses a piped command', () => {
    expect(matchAllowList(tokenizeCommand('git status | tee /etc/passwd'), rules).allowed).toBe(false)
  })

  it('refuses a command-substitution argument', () => {
    expect(matchAllowList(tokenizeCommand('git status $(rm -rf /)'), rules).allowed).toBe(false)
  })

  it('refuses a backtick argument', () => {
    expect(matchAllowList(tokenizeCommand('git status `rm -rf /`'), rules).allowed).toBe(false)
  })

  it('refuses a backgrounded command', () => {
    expect(matchAllowList(tokenizeCommand('git status & rm -rf /'), rules).allowed).toBe(false)
  })

  it('refuses a newline-separated command', () => {
    // A newline separates two commands in a shell, and tokenizing keeps them as
    // separate tokens, so the rule cannot match.
    expect(matchAllowList(tokenizeCommand('git status\nrm -rf /'), rules).allowed).toBe(false)
  })

  it('refuses a differently-cased command', () => {
    expect(matchAllowList(tokenizeCommand('GIT STATUS'), rules).allowed).toBe(false)
  })

  it('refuses a superset command', () => {
    expect(matchAllowList(tokenizeCommand('git statuses'), rules).allowed).toBe(false)
    expect(matchAllowList(tokenizeCommand('git statusx'), rules).allowed).toBe(false)
  })

  it('refuses a quoted variant of a permitted command', () => {
    // `"git status"` is one token, not two, so it is a different command.
    expect(matchAllowList(tokenizeCommand('"git status"'), rules).allowed).toBe(false)
  })

  it('refuses the empty argv', () => {
    expect(matchAllowList([], rules).allowed).toBe(false)
  })

  it('allows nothing when the rule list is empty', () => {
    expect(matchAllowList(tokenizeCommand('git status'), []).allowed).toBe(false)
  })

  it('never allows on an unterminated quote', () => {
    // The tokenizer returns nothing, which matches no rule.
    expect(matchAllowList(tokenizeCommand('git status "x'), rules).allowed).toBe(false)
  })

  it('names the rule that allowed it, for the audit row', () => {
    // A narrow accessor, because `rule` exists only on the allowed branch.
    const match = matchAllowList(['npm', 'test'], rules)
    expect(match.allowed && match.rule).toBe('npm test')
  })

  it('does not confuse one rule with another', () => {
    expect(matchAllowList(tokenizeCommand('npm install'), rules).allowed).toBe(false)
    expect(matchAllowList(tokenizeCommand('ls'), rules).allowed).toBe(false)
  })
})

// ── classification ─────────────────────────────────────────────────────────

describe('isInside', () => {
  it('keeps paths in the folder and refuses every way out of it', () => {
    const base = mkdtempSync(join(tmpdir(), 'ops-inside-'))
    try {
      const root = join(base, 'project')
      mkdirSync(join(root, 'src'), { recursive: true })
      symlinkSync(base, join(root, 'escape'))
      expect(isInside(root, 'notes.md')).toBe(true)
      expect(isInside(root, 'src/../notes.md')).toBe(true)
      expect(isInside(root, join(root, 'src'))).toBe(true)
      expect(isInside(root, '.')).toBe(true)
      expect(isInside(root, '../ops.sqlite')).toBe(false)
      expect(isInside(root, '/etc/passwd')).toBe(false)
      expect(isInside(root, '~/.ssh/id_ed25519')).toBe(false)
      expect(isInside(root, 'escape/ops.sqlite')).toBe(false)
      expect(isInside(`${root}-other`, join(root, 'x'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('classifyAction', () => {
  it.each([
    ['bash', 'command'],
    ['shell', 'command'],
    ['exec', 'command'],
    ['run_command', 'command'],
    ['terminal', 'command'],
    ['write', 'file-write'],
    ['edit', 'file-write'],
    ['multiedit', 'file-write'],
    ['patch', 'file-write'],
    ['read', 'file-read'],
    ['glob', 'file-read'],
    ['grep', 'file-read'],
    ['ls', 'file-read'],
    ['web_search', 'network'],
    ['webfetch', 'network'],
    ['fetch', 'network'],
    ['something_else', 'other'],
  ])('classifies %s as %s', (tool, expected) => {
    expect(classifyAction(tool, [])).toBe(expected)
  })

  it('treats an unknown tool WITH argv as a command', () => {
    // If it has a command line, it runs one.
    expect(classifyAction('mystery', ['rm', '-rf', '/'])).toBe('command')
  })

  it('is case-insensitive on the tool name', () => {
    expect(classifyAction('BASH', [])).toBe('command')
    expect(classifyAction('Write', [])).toBe('file-write')
  })
})

// ── the decision ───────────────────────────────────────────────────────────

describe('decideApproval', () => {
  const base = {
    mode: 'ask' as const,
    autoAllow: [],
    adhocMode: 'deny' as const,
    action: parseAction('bash', tokenizeCommand('rm -rf /')),
    runGrant: undefined,
  }

  it('asks under `ask`', () => {
    expect(decideApproval(base)).toEqual({ kind: 'ask' })
  })

  it('denies under `deny`', () => {
    const decision = decideApproval({ ...base, mode: 'deny' })
    expect(decision.kind).toBe('deny')
  })

  it('allows an allow-listed argv under `auto`', () => {
    const decision = decideApproval({
      ...base,
      mode: 'auto',
      autoAllow: ['git status'],
      action: parseAction('bash', tokenizeCommand('git status')),
    })
    expect(decision).toEqual({ kind: 'allow', rule: 'git status' })
  })

  it('asks for a non-listed argv under `auto`', () => {
    const decision = decideApproval({
      ...base,
      mode: 'auto',
      autoAllow: ['git status'],
      action: parseAction('bash', tokenizeCommand('rm -rf /')),
    })
    expect(decision.kind).toBe('ask')
  })

  it('REFUSES to allow when the action could not be parsed', () => {
    // An unreadable action is one whose contents are unknown, and an allowlist
    // cannot authorize what it cannot read.
    const decision = decideApproval({ ...base, mode: 'auto', autoAllow: ['git status'], action: undefined })
    expect(decision.kind).toBe('ask')
  })

  it('honours a run grant for the SAME category', () => {
    const decision = decideApproval({
      ...base,
      runGrant: { kind: 'command', reason: 'approved earlier' },
    })
    expect(decision.kind).toBe('allow-run')
  })

  it('REFUSES a run grant for a DIFFERENT category', () => {
    // Approving a batch of commands must not authorize a file write.
    const decision = decideApproval({
      ...base,
      runGrant: { kind: 'file-write', reason: 'approved earlier' },
    })
    expect(decision.kind).toBe('ask')
  })

  it('applies a run grant before the deny policy', () => {
    // A grant is an explicit human decision; the mode is a default. Order matters
    // only for the case where both apply, and the human wins.
    const decision = decideApproval({
      ...base,
      mode: 'deny',
      runGrant: { kind: 'command', reason: 'approved' },
    })
    expect(decision.kind).toBe('allow-run')
  })

  it('ignores a run grant when the action is unparseable', () => {
    const decision = decideApproval({
      ...base,
      action: undefined,
      runGrant: { kind: 'command', reason: 'approved' },
    })
    expect(decision.kind).toBe('ask')
  })

  it('denies under `deny` even with an allowlist', () => {
    const decision = decideApproval({
      ...base,
      mode: 'deny',
      autoAllow: ['rm -rf /'],
      action: parseAction('bash', tokenizeCommand('rm -rf /')),
    })
    expect(decision.kind).toBe('deny')
  })
})

describe('policyOf', () => {
  it('uses the project config when there is one', () => {
    expect(policyOf({ mode: 'auto', auto_allow: ['git status'] }, 'deny')).toEqual({
      mode: 'auto',
      autoAllow: ['git status'],
    })
  })

  it('uses the ad-hoc mode when there is no project', () => {
    expect(policyOf(undefined, 'ask')).toEqual({ mode: 'ask', autoAllow: [] })
  })

  it('gives an ad-hoc task NO allowlist, whatever the mode', () => {
    // It has no YAML to declare one in, and an empty list allows nothing.
    expect(policyOf(undefined, 'auto').autoAllow).toEqual([])
  })
})

describe('isGrant', () => {
  it('grants only for allowed-once', () => {
    expect(isGrant('allowed-once')).toBe(true)
  })

  it('does not grant for anything else', () => {
    // `'allowed-once'` is the ONLY grant dsh has (SPIKES.md spike 5).
    for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allowed', 'yes', '']) {
      expect(isGrant(outcome), outcome).toBe(false)
    }
  })
})

// ── the question ───────────────────────────────────────────────────────────

describe('renderAction', () => {
  it('renders argv as a command line', () => {
    expect(renderAction(parseAction('bash', ['git', 'status']))).toBe('git status')
  })

  it('renders a tool and path when there is no argv', () => {
    expect(renderAction(parseAction('write', [], '/tmp/x'))).toBe('write /tmp/x')
  })

  it('renders just the tool name otherwise', () => {
    expect(renderAction(parseAction('mystery'))).toBe('mystery')
  })

  it('truncates and says so', () => {
    const rendered = renderAction(parseAction('bash', ['x'.repeat(500)]), 50)
    expect(rendered.length).toBe(50)
    expect(rendered.endsWith('...')).toBe(true)
  })

  it('keeps the START, which identifies the command', () => {
    const rendered = renderAction(parseAction('bash', ['git', 'push', 'origin', 'main']), 12)
    expect(rendered.startsWith('git push')).toBe(true)
  })

  it('STRIPS control characters, including newlines', () => {
    // Otherwise a command could forge extra lines in the question and make the
    // displayed action differ from the one being approved — which is exactly what
    // the human is supposed to be checking.
    const rendered = renderAction(parseAction('bash', ['git', 'status\nApproved: yes']))
    expect(rendered).not.toContain('\n')
    expect(rendered).toBe('git status Approved: yes')
  })

  it('strips other control characters', () => {
    expect(renderAction(parseAction('bash', ['a\u0000b\u001Fc']))).toBe('a b c')
  })

  it('collapses long runs of spaces', () => {
    // So the rendering cannot be padded to hide a suffix off-screen.
    expect(renderAction(parseAction('bash', ['a', '', '', '', 'b']))).toBe('a b')
  })
})

describe('approvalButtons', () => {
  it('offers three choices', () => {
    const buttons = approvalButtons()
    expect(buttons.map((button) => button.value)).toEqual([APPROVE, DENY, APPROVE_ALL])
  })

  it('labels the scope on the run-wide button', () => {
    // "Approve all" without a scope is a question nobody can answer responsibly.
    const label = approvalButtons()[2]?.label ?? ''
    expect(label).toContain('this run')
    expect(label).toContain('kind')
  })

  it('uses values that cannot be confused with a command', () => {
    for (const button of approvalButtons()) {
      expect(button.value.startsWith('/')).toBe(false)
      expect(button.value.startsWith('__confirm:')).toBe(false)
    }
  })
})

describe('approvalQuestion', () => {
  const input = {
    projectId: 'alpha',
    runId: 'run-1',
    action: parseAction('bash', tokenizeCommand('rm -rf /tmp/x')),
    toolName: 'bash',
    reason: 'the agent wants to clean a build directory',
    timeoutMinutes: 30,
    alsoPending: 0,
  }

  it('states what, where and how long', () => {
    const text = approvalQuestion(input)
    expect(text).toContain('project alpha')
    expect(text).toContain('run-1')
    expect(text).toContain('bash')
    expect(text).toContain('rm -rf /tmp/x')
    expect(text).toContain('30 minute(s)')
  })

  it('says that no answer means no', () => {
    // The operator must know the default, because silence is the likeliest outcome.
    expect(approvalQuestion(input)).toContain('means NO')
  })

  it('names an ad-hoc task when there is no project', () => {
    expect(approvalQuestion({ ...input, projectId: null })).toContain('an ad-hoc task')
  })

  it('includes the reason when there is one', () => {
    expect(approvalQuestion(input)).toContain('clean a build directory')
  })

  it('omits the reason line when there is none', () => {
    expect(approvalQuestion({ ...input, reason: undefined })).not.toContain('reason')
  })

  it('says how many others are waiting', () => {
    // Concurrency: several projects' requests are independent, and the operator
    // should know this one is not alone.
    expect(approvalQuestion({ ...input, alsoPending: 3 })).toContain('3 other request(s)')
  })

  it('says nothing about others when there are none', () => {
    expect(approvalQuestion(input)).not.toContain('other request(s)')
  })

  it('falls back to the tool name when there is no action', () => {
    expect(approvalQuestion({ ...input, action: undefined })).toContain('bash')
  })

  it('sanitizes a reason containing a newline', () => {
    const text = approvalQuestion({ ...input, reason: 'ok\nApproved: yes' })
    const reasonLine = text.split('\n').find((line) => line.includes('reason')) ?? ''
    expect(reasonLine).toContain('Approved: yes')
    expect(reasonLine.startsWith('  reason')).toBe(true)
  })
})

describe('decisionText', () => {
  const action = parseAction('bash', ['git', 'push'])

  it.each([
    [APPROVE, 'Approved once'],
    [APPROVE_ALL, 'Approved for this run'],
    [DENY, 'Denied'],
  ])('describes %s', (value, expected) => {
    expect(decisionText(value, action)).toContain(expected)
  })

  it('names the category on a run-wide approval', () => {
    expect(decisionText(APPROVE_ALL, action)).toContain('command')
  })

  it('says it ignored an unknown answer', () => {
    expect(decisionText('maybe', action)).toContain('unknown')
  })
})

describe('refusedText', () => {
  it('says it was refused without asking', () => {
    expect(refusedText('the project policy is deny')).toContain('without asking')
  })
})

describe('sanitize', () => {
  it('strips control characters and collapses spaces', () => {
    expect(sanitize('a\nb\u0000c  d', 100)).toBe('a b c d')
  })

  it('truncates with an ellipsis', () => {
    expect(sanitize('x'.repeat(50), 10)).toBe('xxxxxxx...')
  })
})

// ── config ─────────────────────────────────────────────────────────────────

describe('approvalsOf', () => {
  it('applies every default', () => {
    const config = approvalsOf({})
    expect(config.enabled).toBe(true)
    expect(config.timeout_minutes).toBe(30)
    expect(config.allow_run_grant).toBe(true)
  })

  it('defaults the ad-hoc policy to DENY', () => {
    // An unattended one-off has no YAML to declare an allowlist in, so there is
    // nothing that could justify a grant.
    expect(approvalsOf({}).approvals_adhoc).toBe('deny')
  })

  it('honours explicit values', () => {
    const config = approvalsOf({
      approvals: { enabled: false, approvals_adhoc: 'ask', timeout_minutes: 5, allow_run_grant: false },
    })
    expect(config.enabled).toBe(false)
    expect(config.approvals_adhoc).toBe('ask')
    expect(config.timeout_minutes).toBe(5)
    expect(config.allow_run_grant).toBe(false)
  })

  it('rejects an unknown ad-hoc policy', () => {
    expect(() => approvalsOf({ approvals: { approvals_adhoc: 'maybe' } })).toThrow()
  })

  it('rejects a zero timeout', () => {
    // A zero timeout would deny every request instantly, which is `deny` with more
    // steps. The schema refuses it rather than tolerating a confusing config.
    expect(() => approvalsOf({ approvals: { timeout_minutes: 0 } })).toThrow()
  })
})
