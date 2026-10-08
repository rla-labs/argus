// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/memory/memory-file` — the `MEMORY.md` format, and how a write happens.
 *
 * The format is deliberately plain: a markdown file of `##` sections. A project's
 * agent reads it directly if it wants to, a person can edit it in an editor, and
 * `git diff` on it is meaningful. A structured format would need a parser on every
 * side and would make hand-editing a way to break memory.
 *
 * @module @argus-agent/memory/memory-file
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One section of a memory file. */
export interface MemoryBlock {
  /** The `##` heading text, without the `##`. */
  readonly name: string
  /** The body, without the heading. */
  readonly body: string
}

/** A parsed memory file. */
export interface ParsedMemory {
  /** Text before the first `##`, usually a title or nothing. */
  readonly preamble: string
  /** The sections, in file order. */
  readonly sections: readonly MemoryBlock[]
}

/** The result of applying an update. */
export type UpdateResult =
  | { readonly ok: true; readonly text: string; readonly bytes: number; readonly summary: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Parse a memory file into its preamble and sections.
 *
 * A `###` heading is **content**, not a section: only `##` starts a section, so a
 * section can contain its own subheadings without them becoming siblings. That is
 * what lets a section hold a small list of related facts.
 *
 * @param text the file's text.
 * @returns the parsed form.
 */
export function parseMemory(text: string): ParsedMemory {
  const lines = text.split('\n')
  const preamble: string[] = []
  const sections: Array<{ name: string; body: string[] }> = []
  let current: { name: string; body: string[] } | undefined

  for (const line of lines) {
    // `##` exactly: `###` and `####` are content.
    const heading = /^##(?!#)\s*(.*)$/.exec(line)
    if (heading !== null) {
      current = { name: (heading[1] ?? '').trim(), body: [] }
      sections.push(current)
      continue
    }
    if (current === undefined) preamble.push(line)
    else current.body.push(line)
  }

  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map((section) => ({ name: section.name, body: section.body.join('\n').trim() })),
  }
}

/**
 * Render a parsed memory file back to text.
 *
 * @param memory the parsed form.
 * @returns the file's text, ending in a newline.
 */
export function renderMemory(memory: ParsedMemory): string {
  const parts: string[] = []
  if (memory.preamble.length > 0) parts.push(memory.preamble)
  for (const section of memory.sections) {
    parts.push(`## ${section.name}\n\n${section.body}`.trimEnd())
  }
  return `${parts.join('\n\n')}\n`
}

/**
 * Apply an update to a memory file's text.
 *
 * `replace` sets a section's body, creating it when it does not exist. `append`
 * adds to it, creating it when it does not exist — and inserting a separating blank
 * line only when the existing body is non-empty, so a section does not accumulate
 * leading blank lines.
 *
 * A section's **name** is preserved as it was, so `## Build` stays `## Build` even
 * if the agent writes `build`: renaming a section on every update would scatter one
 * topic across two headings.
 *
 * @param text the current file text.
 * @param section the section name.
 * @param content the new content.
 * @param mode replace or append.
 * @param limit the maximum file size in bytes.
 * @returns the new text, or a refusal.
 */
export function applyUpdate(
  text: string,
  section: string,
  content: string,
  mode: 'replace' | 'append',
  limit: number,
): UpdateResult {
  const name = section.trim()
  if (name.length === 0) {
    return { ok: false, code: 'MEMORY_INVALID', message: 'A section name is required, e.g. "Build".' }
  }
  if (name.includes('\n')) {
    return { ok: false, code: 'MEMORY_INVALID', message: 'A section name cannot contain a line break.' }
  }
  if (content.trim().length === 0 && mode === 'replace') {
    // Replacing with nothing is how a section is DELETED, which is a different
    // operation with a different name; refusing keeps `replace` unambiguous.
    return {
      ok: false,
      code: 'MEMORY_INVALID',
      message: 'The content is empty. To remove a section, say so explicitly with `mode: replace` and a note that it is obsolete, or leave it.',
    }
  }

  const parsed = parseMemory(text)
  const index = parsed.sections.findIndex((entry) => entry.name === name)
  const sections = [...parsed.sections]

  if (index === -1) {
    sections.push({ name, body: content.trim() })
  } else if (mode === 'replace') {
    sections[index] = { name: sections[index]!.name, body: content.trim() }
  } else {
    const existing = sections[index]!.body
    const body = existing.trim().length === 0 ? content.trim() : `${existing.trimEnd()}\n\n${content.trim()}`
    sections[index] = { name: sections[index]!.name, body }
  }

  const next = renderMemory({ preamble: parsed.preamble, sections })
  const bytes = Buffer.byteLength(next, 'utf8')

  if (bytes > limit) {
    return {
      ok: false,
      code: 'MEMORY_TOO_LARGE',
      message:
        `That update would make MEMORY.md ${bytes} bytes, over the ${limit}-byte limit. ` +
        'Condense the section: keep the decisions and the reasoning, drop the narration and the raw output.',
    }
  }

  const summary =
    index === -1
      ? `added section "${name}" (${content.trim().length} chars)`
      : mode === 'replace'
        ? `replaced section "${name}" (${sections[index]!.body.length} chars)`
        : `appended to section "${name}" (now ${sections[index]!.body.length} chars)`

  return { ok: true, text: next, bytes, summary }
}

/**
 * Remove one `##` section. The name matches exactly, or else case-insensitively when
 * exactly one section matches that way, so `/forget site build` finds "Build".
 *
 * @param text the file's text.
 * @param section the section's name.
 * @returns the new text and the removed section's exact name, or the section names
 *   when none matches.
 */
export function removeSection(
  text: string,
  section: string,
): { readonly ok: true; readonly text: string; readonly name: string } | { readonly ok: false; readonly sections: readonly string[] } {
  const parsed = parseMemory(text)
  const wanted = section.trim()
  let index = parsed.sections.findIndex((entry) => entry.name === wanted)
  if (index === -1) {
    const loose = parsed.sections.flatMap((entry, i) => (entry.name.toLowerCase() === wanted.toLowerCase() ? [i] : []))
    if (loose.length === 1) index = loose[0] as number
  }
  if (index === -1) return { ok: false, sections: parsed.sections.map((entry) => entry.name) }
  const name = (parsed.sections[index] as MemoryBlock).name
  const sections = parsed.sections.filter((_, i) => i !== index)
  return { ok: true, text: renderMemory({ preamble: parsed.preamble, sections }), name }
}

/**
 * Read a memory file, or `''` when it does not exist.
 *
 * A missing file is not an error: it is a project that has not written memory yet,
 * and the first update creates it.
 *
 * @param path the file path.
 * @returns the text.
 */
export function readMemoryFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Write a memory file atomically.
 *
 * A temporary file in the **same directory**, then `rename`. `rename` is atomic
 * within a filesystem, so a reader sees either the old file or the new one and never
 * a half-written one. A crash between the write and the rename leaves the temporary
 * file behind and the memory file untouched — which is the correct outcome, and a
 * test simulates exactly that.
 *
 * The temporary file is in the same directory because `rename` across filesystems is
 * a copy, which is not atomic. `/tmp` is frequently a different mount.
 *
 * @param path the target.
 * @param text the content.
 * @param suffix a suffix for the temporary file, so a test can find it.
 * @returns the path written to.
 */
export function writeMemoryFileAtomic(path: string, text: string, suffix = '.tmp'): string {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}${suffix}`)
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
    return path
  } catch (error) {
    // Best effort: a failed rename must not leave the temporary file as litter
    // beside the memory file, where the next reader might mistake it for content.
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* the original error is the one worth reporting */
    }
    throw error
  }
}

/** The last path component. */
function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * A one-line diff summary of an old and a new memory file.
 *
 * Recorded in the audit log, so "what did the agent change?" is answerable without
 * storing the whole file — and without storing anything the agent wrote into a
 * place a reader might mistake for a system record.
 *
 * @param before the previous text.
 * @param after the new text.
 * @returns the summary.
 */
export function diffSummary(before: string, after: string): string {
  const oldSections = new Set(parseMemory(before).sections.map((section) => section.name))
  const newSections = new Set(parseMemory(after).sections.map((section) => section.name))

  const added = [...newSections].filter((name) => !oldSections.has(name))
  const removed = [...oldSections].filter((name) => !newSections.has(name))
  const changed = [...newSections].filter((name) => {
    if (!oldSections.has(name)) return false
    const beforeBody = parseMemory(before).sections.find((section) => section.name === name)?.body ?? ''
    const afterBody = parseMemory(after).sections.find((section) => section.name === name)?.body ?? ''
    return beforeBody !== afterBody
  })

  const parts: string[] = []
  if (added.length > 0) parts.push(`added: ${added.join(', ')}`)
  if (changed.length > 0) parts.push(`changed: ${changed.join(', ')}`)
  if (removed.length > 0) parts.push(`removed: ${removed.join(', ')}`)

  const bytesBefore = Buffer.byteLength(before, 'utf8')
  const bytesAfter = Buffer.byteLength(after, 'utf8')
  parts.push(`${bytesBefore}→${bytesAfter} bytes`)

  return parts.join('; ')
}
