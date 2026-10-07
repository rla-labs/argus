// == ARGUS AGENT PROJECT ==
/**
 * The public user documentation: every relative link resolves.
 *
 * The documentation is several files that link to each other and into the repository.
 * A renamed heading or a moved file breaks a link silently, and a reader who lands on
 * the wrong place has no way to tell. These tests resolve every relative link, and its
 * `#anchor`, the way GitHub renders it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')
const USER_DOCS = join(ROOT, 'docs', 'user')
const PAGES = [join(ROOT, 'README.md'), ...readdirSync(USER_DOCS).filter((name) => name.endsWith('.md')).map((name) => join(USER_DOCS, name))]

/** The anchors GitHub gives a Markdown file's headings, duplicates numbered. */
function anchorsOf(text: string): Set<string> {
  const seen = new Map<string, number>()
  const anchors = new Set<string>()
  let fence = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fence = !fence
    if (fence) continue
    const heading = /^#{1,6} (.*)$/.exec(line)
    if (heading === null) continue
    const slug = (heading[1] as string).trim().toLowerCase().replace(/[^\p{L}\p{N}\- _]/gu, '').replace(/ /g, '-')
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    anchors.add(count === 0 ? slug : `${slug}-${count}`)
  }
  return anchors
}

/** Every Markdown link outside a code fence: `[text](target)`. */
function linksOf(text: string): string[] {
  const links: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fence = !fence
    if (fence) continue
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) links.push(match[1] as string)
  }
  return links
}

describe('the user documentation', () => {
  it.each(PAGES.map((page) => [page.slice(ROOT.length + 1), page]))('%s: every relative link resolves', (_name, page) => {
    const text = readFileSync(page, 'utf8')
    const broken: string[] = []
    for (const link of linksOf(text)) {
      if (/^[a-z]+:/i.test(link)) continue
      const [path, anchor] = link.split('#') as [string, string | undefined]
      const target = path.length === 0 ? page : resolve(dirname(page), path)
      if (!existsSync(target)) {
        broken.push(`${link} (no such file)`)
        continue
      }
      if (anchor !== undefined && target.endsWith('.md') && !anchorsOf(readFileSync(target, 'utf8')).has(anchor)) {
        broken.push(`${link} (no such heading)`)
      }
    }
    expect(broken).toEqual([])
  })

  it('has an index that links every page', () => {
    const index = readFileSync(join(USER_DOCS, 'README.md'), 'utf8')
    for (const page of readdirSync(USER_DOCS).filter((name) => name.endsWith('.md') && name !== 'README.md')) {
      expect(index, page).toContain(`(${page})`)
    }
  })

  it('has no placeholder left', () => {
    for (const page of PAGES) {
      const text = readFileSync(page, 'utf8')
      expect(text, page).not.toContain('not written yet')
      expect(text, page).not.toMatch(/\bTODO\b/)
    }
  })
})
