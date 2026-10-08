// == ARGUS AGENT PROJECT ==
/**
 * Unit tests for `ops-memory`'s pure layers.
 *
 * `paths.ts` is an isolation boundary — it builds the filesystem paths memory lives
 * at — so its tests are mostly attempts to escape it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_INJECT_TOKENS,
  estimateTokens,
  isSafeProjectId,
  memoryFile,
  projectStateDir,
  recallFile,
  userProfileFile,
} from '../../src/paths.js'
import { applyUpdate, diffSummary, parseMemory, readMemoryFile, removeSection, renderMemory, writeMemoryFileAtomic } from '../../src/memory-file.js'
import { composeInjection, hasContent, MEMORY_HEADING } from '../../src/truncate.js'
import { snippet, tokenizeQuery } from '../../src/recall.js'
import { memoryOf } from '../../src/config.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-mem-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ── paths: the isolation boundary ──────────────────────────────────────────

describe('isSafeProjectId', () => {
  it('accepts real project ids', () => {
    for (const id of ['alpha', 'site-firma', 'a1', 'my-project-2']) {
      expect(isSafeProjectId(id), id).toBe(true)
    }
  })

  it('REFUSES path traversal', () => {
    // The whole reason this check exists: an id is turned into a path component.
    for (const id of ['../other', '..', '../../etc', 'a/../../b', '.', './x']) {
      expect(isSafeProjectId(id), id).toBe(false)
    }
  })

  it('refuses an absolute path', () => {
    for (const id of ['/etc/passwd', '/tmp/x', 'C:\\x']) {
      expect(isSafeProjectId(id), id).toBe(false)
    }
  })

  it('refuses separators and other risky characters', () => {
    for (const id of ['a/b', 'a\\b', 'a b', 'a\nb', 'a\0b', 'a*b', 'a?b', 'a:b']) {
      expect(isSafeProjectId(id), id).toBe(false)
    }
  })

  it('refuses a single character', () => {
    // The pattern requires at least two, matching the project loader.
    expect(isSafeProjectId('a')).toBe(false)
  })

  it('refuses an empty id', () => {
    expect(isSafeProjectId('')).toBe(false)
  })

  it('refuses an uppercase id', () => {
    // Ids are slugs, and the loader lowercases nothing on the way in.
    expect(isSafeProjectId('Alpha')).toBe(false)
  })

  it('refuses an id starting with a dash', () => {
    expect(isSafeProjectId('-alpha')).toBe(false)
  })

  it('refuses an over-long id', () => {
    expect(isSafeProjectId('a'.repeat(42))).toBe(false)
  })
})

describe('path builders', () => {
  it('places memory under the state tree, NOT the workspace', () => {
    // The point of the layout: a project's file tools are rooted at its `cwd`, so
    // memory inside the workspace would be memory the agent can corrupt.
    const dir = projectStateDir('/data', 'alpha')
    expect(dir).toBe('/data/state/alpha')
    // `<data_dir>/projects/<id>` is the workspace; the state tree is a sibling.
    expect(dir.startsWith('/data/projects/')).toBe(false)
  })

  it('builds each file path', () => {
    expect(memoryFile('/data', 'alpha')).toBe('/data/state/alpha/MEMORY.md')
    expect(recallFile('/data', 'alpha')).toBe('/data/state/alpha/recall.sqlite')
  })

  it('places the user profile outside every project state directory', () => {
    // Global, so no project-derived path can reach it.
    expect(userProfileFile('/data')).toBe('/data/memory/USER.md')
    expect(userProfileFile('/data').startsWith('/data/state/')).toBe(false)
  })

  it('THROWS for an unsafe id rather than sanitizing', () => {
    // Sanitizing would map two ids onto one directory, which is how one project
    // ends up reading another's memory.
    expect(() => projectStateDir('/data', '../beta')).toThrow(/unsafe project id/)
    expect(() => memoryFile('/data', 'a/b')).toThrow()
    expect(() => recallFile('/data', '..')).toThrow()
  })

  it('cannot be escaped by a crafted id', () => {
    for (const id of ['../../etc/passwd', '..%2F..', 'a/../../../b']) {
      expect(() => projectStateDir('/data', id), id).toThrow()
    }
  })
})

describe('estimateTokens', () => {
  it('estimates four characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('rounds up, so a short text is never zero', () => {
    expect(estimateTokens('a')).toBe(1)
  })

  it('returns zero for an empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('has sensible defaults', () => {
    expect(DEFAULT_MAX_INJECT_TOKENS).toBe(2000)
    expect(DEFAULT_MAX_FILE_BYTES).toBe(16 * 1024)
  })
})

// ── the file format ────────────────────────────────────────────────────────

describe('parseMemory', () => {
  it('splits on ## headings', () => {
    const parsed = parseMemory('## A\n\nbody a\n\n## B\n\nbody b\n')
    expect(parsed.sections).toEqual([
      { name: 'A', body: 'body a' },
      { name: 'B', body: 'body b' },
    ])
  })

  it('keeps a preamble', () => {
    const parsed = parseMemory('# Title\n\nintro\n\n## A\n\nbody')
    expect(parsed.preamble).toBe('# Title\n\nintro')
    expect(parsed.sections).toHaveLength(1)
  })

  it('treats ### as content, not a section', () => {
    // So a section can hold its own subheadings without them becoming siblings.
    const parsed = parseMemory('## A\n\n### Sub\n\ntext\n\n## B\n\nother')
    expect(parsed.sections.map((section) => section.name)).toEqual(['A', 'B'])
    expect(parsed.sections[0]?.body).toContain('### Sub')
  })

  it('handles an empty file', () => {
    expect(parseMemory('')).toEqual({ preamble: '', sections: [] })
  })

  it('handles an empty section body', () => {
    expect(parseMemory('## A\n\n## B\n\nx').sections[0]).toEqual({ name: 'A', body: '' })
  })

  it('trims a heading', () => {
    expect(parseMemory('##   Spaced   \n\nx').sections[0]?.name).toBe('Spaced')
  })

  it('round-trips through renderMemory', () => {
    const original = '# Title\n\n## A\n\nbody a\n\n## B\n\nbody b'
    const rendered = renderMemory(parseMemory(original))
    expect(parseMemory(rendered).sections).toEqual(parseMemory(original).sections)
  })
})

describe('applyUpdate', () => {
  const LIMIT = 16 * 1024

  it('creates a section that does not exist', () => {
    const result = applyUpdate('', 'Build', 'npm test', 'replace', LIMIT)
    expect(result.ok).toBe(true)
    expect(result.ok && result.text).toContain('## Build')
    expect(result.ok && result.text).toContain('npm test')
  })

  it('replaces an existing section', () => {
    const before = '## Build\n\nold\n\n## Other\n\nkeep me'
    const result = applyUpdate(before, 'Build', 'new', 'replace', LIMIT)
    expect(result.ok && result.text).toContain('new')
    expect(result.ok && result.text).not.toContain('old')
    // The other section is untouched.
    expect(result.ok && result.text).toContain('keep me')
  })

  it('appends to an existing section', () => {
    const result = applyUpdate('## Build\n\nfirst', 'Build', 'second', 'append', LIMIT)
    expect(result.ok && result.text).toContain('first')
    expect(result.ok && result.text).toContain('second')
  })

  it('appends to an empty section without a blank-line pile-up', () => {
    const result = applyUpdate('## Build\n', 'Build', 'first', 'append', LIMIT)
    expect(result.ok).toBe(true)
    const body = result.ok ? parseMemory(result.text).sections[0]?.body : ''
    expect(body).toBe('first')
  })

  it('PRESERVES a section name as written', () => {
    // Renaming on every update would scatter one topic across two headings.
    const result = applyUpdate('## Build\n\nx', 'Build', 'y', 'replace', LIMIT)
    expect(result.ok && parseMemory(result.text).sections[0]?.name).toBe('Build')
  })

  it('keeps a preamble when updating', () => {
    const result = applyUpdate('# Title\n\n## A\n\nx', 'B', 'y', 'replace', LIMIT)
    expect(result.ok && result.text.startsWith('# Title')).toBe(true)
  })

  it('reports an added section in the summary', () => {
    expect(applyUpdate('', 'Build', 'x', 'replace', LIMIT).ok && (applyUpdate('', 'Build', 'x', 'replace', LIMIT) as { summary: string }).summary).toContain('added')
  })

  it('reports a replaced section', () => {
    const result = applyUpdate('## Build\n\nx', 'Build', 'y', 'replace', LIMIT)
    expect(result.ok && result.summary).toContain('replaced')
  })

  it('reports an appended section', () => {
    const result = applyUpdate('## Build\n\nx', 'Build', 'y', 'append', LIMIT)
    expect(result.ok && result.summary).toContain('appended')
  })

  it('REFUSES an update that exceeds the limit', () => {
    const result = applyUpdate('', 'Big', 'x'.repeat(20_000), 'replace', LIMIT)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('MEMORY_TOO_LARGE')
  })

  it('tells the agent to CONDENSE rather than just failing', () => {
    const result = applyUpdate('', 'Big', 'x'.repeat(20_000), 'replace', LIMIT)
    expect(result.ok === false && result.message).toMatch(/condense/i)
  })

  it('refuses an empty section name', () => {
    const result = applyUpdate('', '   ', 'x', 'replace', LIMIT)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('MEMORY_INVALID')
  })

  it('refuses a section name containing a line break', () => {
    // A newline would forge a second heading.
    expect(applyUpdate('', 'A\nB', 'x', 'replace', LIMIT).ok).toBe(false)
  })

  it('refuses an empty replace, which would silently delete a section', () => {
    const result = applyUpdate('## A\n\nkeep', 'A', '   ', 'replace', LIMIT)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('empty')
  })

  it('allows an empty append, which is a no-op rather than a deletion', () => {
    expect(applyUpdate('## A\n\nkeep', 'A', '', 'append', LIMIT).ok).toBe(true)
  })

  it('counts bytes, not characters', () => {
    // A multi-byte character is more than one byte; counting characters would let
    // a file exceed the limit.
    const emoji = '😀'.repeat(100)
    const result = applyUpdate('', 'E', emoji, 'replace', 200)
    expect(result.ok).toBe(false)
  })
})

describe('diffSummary', () => {
  it('reports an added section', () => {
    expect(diffSummary('## A\n\nx', '## A\n\nx\n\n## B\n\ny')).toContain('added: B')
  })

  it('reports a changed section', () => {
    expect(diffSummary('## A\n\nx', '## A\n\ny')).toContain('changed: A')
  })

  it('reports a removed section', () => {
    expect(diffSummary('## A\n\nx\n\n## B\n\ny', '## A\n\nx')).toContain('removed: B')
  })

  it('reports the byte change', () => {
    expect(diffSummary('## A\n\nx', '## A\n\nxx')).toMatch(/\d+→\d+ bytes/)
  })

  it('reports nothing changed for identical texts', () => {
    const summary = diffSummary('## A\n\nx', '## A\n\nx')
    expect(summary).not.toContain('added')
    expect(summary).not.toContain('changed')
    expect(summary).not.toContain('removed')
  })

  it('does not include the CONTENT, only the section names', () => {
    // An audit row records what changed, not the agent's prose: a reader must not
    // have to wonder whether the text came from the system.
    const summary = diffSummary('', '## Secrets\n\nmy password is hunter2')
    expect(summary).not.toContain('hunter2')
    expect(summary).toContain('Secrets')
  })
})

// ── atomic writes ──────────────────────────────────────────────────────────

describe('writeMemoryFileAtomic', () => {
  it('writes the file', () => {
    const dir = tempDir()
    const path = join(dir, 'MEMORY.md')
    writeMemoryFileAtomic(path, '## A\n\nx')
    expect(readFileSync(path, 'utf8')).toBe('## A\n\nx')
  })

  it('creates the directory', () => {
    const dir = tempDir()
    const path = join(dir, 'nested', 'deep', 'MEMORY.md')
    writeMemoryFileAtomic(path, 'x')
    expect(existsSync(path)).toBe(true)
  })

  it('leaves NO temporary file behind on success', () => {
    const dir = tempDir()
    const path = join(dir, 'MEMORY.md')
    writeMemoryFileAtomic(path, 'x')
    expect(existsSync(join(dir, '.MEMORY.md.tmp'))).toBe(false)
  })

  it('does not corrupt the target when the write fails', () => {
    // Simulated crash: the temporary path is a DIRECTORY, so `writeFileSync`
    // throws. The existing memory file must be untouched, and no litter left.
    const dir = tempDir()
    const path = join(dir, 'MEMORY.md')
    writeMemoryFileAtomic(path, 'the original content')
    mkdirSync(join(dir, '.MEMORY.md.tmp'), { recursive: true })

    expect(() => writeMemoryFileAtomic(path, 'the new content')).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('the original content')
  })

  it('overwrites atomically, so a reader sees old or new and never a mix', () => {
    // With `rename` the inode is replaced, so a reader holding the old path sees
    // one complete version. The assertion is that no intermediate state is
    // observable in the file itself.
    const dir = tempDir()
    const path = join(dir, 'MEMORY.md')
    for (let index = 0; index < 20; index += 1) {
      writeMemoryFileAtomic(path, `## V\n\nversion ${index}`)
      const content = readFileSync(path, 'utf8')
      expect(content).toMatch(/^## V\n\nversion \d+$/)
    }
  })

  it('writes with restrictive permissions', () => {
    const dir = tempDir()
    const path = join(dir, 'MEMORY.md')
    writeMemoryFileAtomic(path, 'x')
    // 0600: memory can contain internal decisions, and nothing else on the host
    // has a reason to read it.
    const mode = statSync(path).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })
})

describe('readMemoryFile', () => {
  it('returns an empty string for a missing file', () => {
    // Not an error: a project that has not written memory yet.
    expect(readMemoryFile(join(tempDir(), 'nope.md'))).toBe('')
  })

  it('reads an existing file', () => {
    const dir = tempDir()
    const path = join(dir, 'MEMORY.md')
    writeFileSync(path, '## A\n\nx')
    expect(readMemoryFile(path)).toBe('## A\n\nx')
  })
})

// ── truncation ─────────────────────────────────────────────────────────────

describe('composeInjection', () => {
  const estimate = estimateTokens
  const sections = [
    { name: 'Old', body: 'o'.repeat(400) },
    { name: 'Middle', body: 'm'.repeat(400) },
    { name: 'Recent', body: 'r'.repeat(400) },
  ]

  it('includes everything when it fits', () => {
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 10_000, estimate })
    expect(injection.truncated).toBe(false)
    expect(injection.included).toEqual(['Old', 'Middle', 'Recent'])
  })

  it('keeps the MOST RECENT sections under pressure', () => {
    // A project's recent decisions matter more than what it concluded long ago.
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 250, estimate })
    expect(injection.truncated).toBe(true)
    expect(injection.included).toContain('Recent')
    expect(injection.included).not.toContain('Old')
  })

  it('NEVER splits a section', () => {
    // A section cut mid-sentence could state half a decision, which is worse than
    // not stating it: the agent cannot tell.
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 250, estimate })
    for (const name of injection.included) {
      const body = sections.find((section) => section.name === name)?.body ?? ''
      expect(injection.text).toContain(body)
    }
  })

  it('ANNOUNCES the truncation', () => {
    // An agent that silently received half its memory will act on an incomplete
    // picture — and may "correct" a file whose contents it never saw.
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 250, estimate })
    expect(injection.text).toContain('Memory was truncated')
    expect(injection.text).toContain('Old')
  })

  it('tells the agent to READ rather than guess', () => {
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 250, estimate })
    expect(injection.text.toLowerCase()).toContain('do not overwrite')
  })

  it('keeps file order in the output', () => {
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 10_000, estimate })
    expect(injection.text.indexOf('Old')).toBeLessThan(injection.text.indexOf('Recent'))
  })

  it('includes the user profile first', () => {
    const injection = composeInjection({
      userProfile: 'prefers terse answers',
      sections: [],
      maxTokens: 10_000,
      estimate,
    })
    expect(injection.text).toContain('About the operator')
    expect(injection.text).toContain('prefers terse answers')
  })

  it('charges the profile against the budget', () => {
    // An enormous USER.md reduces how much project memory fits: honest accounting.
    const huge = 'p'.repeat(2_000)
    const withProfile = composeInjection({ userProfile: huge, sections, maxTokens: 600, estimate })
    const without = composeInjection({ userProfile: '', sections, maxTokens: 600, estimate })
    expect(withProfile.included.length).toBeLessThan(without.included.length)
  })

  it('produces nothing for no profile and no sections', () => {
    const injection = composeInjection({ userProfile: '', sections: [], maxTokens: 10_000, estimate })
    expect(hasContent(injection)).toBe(false)
  })

  it('heads the memory block', () => {
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 10_000, estimate })
    expect(injection.text).toContain(MEMORY_HEADING)
  })

  it('reports the estimated tokens it produced', () => {
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 10_000, estimate })
    expect(injection.tokens).toBeGreaterThan(0)
  })

  it('omits the truncation notice when nothing was omitted', () => {
    const injection = composeInjection({ userProfile: '', sections, maxTokens: 10_000, estimate })
    expect(injection.text).not.toContain('Memory was truncated')
  })
})

// ── recall ─────────────────────────────────────────────────────────────────

describe('tokenizeQuery', () => {
  it('splits into words and lowercases', () => {
    expect(tokenizeQuery('How Do I Build')).toEqual(['how', 'do', 'build'])
  })

  it('drops punctuation', () => {
    expect(tokenizeQuery('build, test; deploy!')).toEqual(['build', 'test', 'deploy'])
  })

  it('drops single characters', () => {
    // A one-character term matches nearly everything and ranks nothing.
    expect(tokenizeQuery('a be c')).toEqual(['be'])
  })

  it('keeps underscores, dashes and digits', () => {
    expect(tokenizeQuery('my_var my-var v2')).toEqual(['my_var', 'my-var', 'v2'])
  })

  it('returns nothing for only punctuation', () => {
    expect(tokenizeQuery('!!! ???')).toEqual([])
  })

  it('returns nothing for an empty query', () => {
    expect(tokenizeQuery('   ')).toEqual([])
  })

  it('handles non-ASCII words', () => {
    expect(tokenizeQuery('șir șirul')).toEqual(['șir', 'șirul'])
  })
})

describe('snippet', () => {
  it('collapses whitespace', () => {
    expect(snippet('a\n\n  b\tc')).toBe('a b c')
  })

  it('truncates with an ellipsis', () => {
    const result = snippet('x'.repeat(500), 100)
    expect(result.length).toBe(100)
    expect(result.endsWith('...')).toBe(true)
  })

  it('keeps the START, which states what a turn was about', () => {
    expect(snippet('the important beginning and then a lot more', 20).startsWith('the important')).toBe(true)
  })

  it('leaves a short text alone', () => {
    expect(snippet('short')).toBe('short')
  })
})

// ── config ─────────────────────────────────────────────────────────────────

describe('memoryOf', () => {
  it('applies every default', () => {
    const config = memoryOf({})
    expect(config.enabled).toBe(true)
    expect(config.max_inject_tokens).toBe(DEFAULT_MAX_INJECT_TOKENS)
    expect(config.max_file_bytes).toBe(DEFAULT_MAX_FILE_BYTES)
    expect(config.user_profile).toBe(true)
    expect(config.index_turns).toBe(true)
  })

  it('honours explicit values', () => {
    const config = memoryOf({
      memory: { enabled: false, max_inject_tokens: 500, max_file_bytes: 2048, user_profile: false },
    })
    expect(config.enabled).toBe(false)
    expect(config.max_inject_tokens).toBe(500)
    expect(config.max_file_bytes).toBe(2048)
    expect(config.user_profile).toBe(false)
  })

  it('rejects a token budget that is too small to be useful', () => {
    expect(() => memoryOf({ memory: { max_inject_tokens: 10 } })).toThrow()
  })

  it('rejects a file limit below a usable floor', () => {
    expect(() => memoryOf({ memory: { max_file_bytes: 10 } })).toThrow()
  })

  it('rejects a recall limit of zero', () => {
    expect(() => memoryOf({ memory: { recall_limit: 0 } })).toThrow()
  })
})

describe('removeSection (/forget)', () => {
  const text = '# Memory\n\n## Build\npnpm build\n\n## Deploy notes\nrsync to the VPS\n'

  it('removes the section, matched exactly or case-insensitively, and keeps the rest', () => {
    const removed = removeSection(text, 'deploy NOTES')
    expect(removed).toMatchObject({ ok: true, name: 'Deploy notes' })
    const after = (removed as { text: string }).text
    expect(after).toMatch(/## Build\s+pnpm build/)
    expect(after).not.toContain('rsync')
    expect(after.startsWith('# Memory')).toBe(true)
  })

  it('names the sections there are when none matches', () => {
    expect(removeSection(text, 'Nope')).toEqual({ ok: false, sections: ['Build', 'Deploy notes'] })
  })
})
