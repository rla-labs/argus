// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/locales` — the interface's languages: the ones it ships (English,
 * Romanian) and the packs the admin adds, kept in `<config_dir>/locales/<code>.json`.
 *
 * A pack is the English file's keys with their translations; a key it lacks shows in
 * English. It is text the interface shows as text, never markup, so it is checked for
 * shape, not content.
 *
 * @module @argus-agent/web/locales
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A language's code: `de`, `pt-BR`. */
export const LOCALE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/

/** The languages the interface ships; a pack cannot replace them. */
export const SHIPPED: readonly string[] = ['en', 'ro']

/** A translation, at most. */
const MAX_TEXT = 4_000

/** One language, as the settings page lists it. */
export interface LocaleInfo {
  readonly code: string
  readonly name: string
  /** How many of the English keys it translates. */
  readonly keys: number
  readonly total: number
  readonly shipped: boolean
}

/** The interface's languages. */
export class Locales {
  /**
   * @param shippedDir where the shipped files are (`public/locales`).
   * @param packDir where packs go (`<config_dir>/locales`).
   */
  constructor(
    private readonly shippedDir: string,
    private readonly packDir: string,
  ) {}

  private read(path: string): Record<string, string> | undefined {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    } catch {
      return undefined
    }
  }

  /** The English keys, which every language translates. */
  private english(): Record<string, string> {
    return this.read(join(this.shippedDir, 'en.json')) ?? {}
  }

  /** A language's file: shipped, else a pack; `undefined` when there is none. */
  file(code: string): string | undefined {
    if (!LOCALE_CODE.test(code)) return undefined
    for (const dir of SHIPPED.includes(code) ? [this.shippedDir] : [this.packDir]) {
      const path = join(dir, `${code}.json`)
      if (existsSync(path)) return path
    }
    return undefined
  }

  /** Every language there is, the shipped ones first. */
  list(): LocaleInfo[] {
    const english = Object.keys(this.english())
    const packs = existsSync(this.packDir) ? readdirSync(this.packDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)) : []
    return [...SHIPPED, ...packs.filter((code) => LOCALE_CODE.test(code) && !SHIPPED.includes(code)).sort()].flatMap((code) => {
      const path = this.file(code)
      const strings = path === undefined ? undefined : this.read(path)
      if (strings === undefined) return []
      return [{ code, name: strings[`lang.${code}`] ?? strings['_name'] ?? code, keys: english.filter((key) => typeof strings[key] === 'string').length, total: english.length, shipped: SHIPPED.includes(code) }]
    })
  }

  /**
   * Add or replace a pack.
   *
   * @param code its language's code.
   * @param body the translations: the English keys, each with its text.
   * @returns why it was refused, or `undefined`.
   */
  save(code: string, body: unknown): string | undefined {
    if (!LOCALE_CODE.test(code)) return 'a language code is like de or pt-BR'
    if (SHIPPED.includes(code)) return `${code} ships with Argus and cannot be replaced`
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'a pack is a JSON object of the English keys and their texts'
    const english = this.english()
    const strings: Record<string, string> = {}
    for (const [key, text] of Object.entries(body as Record<string, unknown>)) {
      if (key === '_name' && typeof text === 'string' && text.length <= 64) strings[key] = text
      else if (!(key in english)) return `"${key}" is not a key of the interface`
      else if (typeof text !== 'string' || text.length > MAX_TEXT) return `"${key}" must be a text of at most ${MAX_TEXT} characters`
      else strings[key] = text
    }
    if (Object.keys(strings).filter((key) => key !== '_name').length === 0) return 'the pack translates nothing'
    mkdirSync(this.packDir, { recursive: true })
    writeFileSync(join(this.packDir, `${code}.json`), `${JSON.stringify(strings, null, 2)}\n`)
    return undefined
  }

  /** Remove a pack; a shipped language stays. */
  remove(code: string): boolean {
    if (!LOCALE_CODE.test(code) || SHIPPED.includes(code)) return false
    const path = join(this.packDir, `${code}.json`)
    if (!existsSync(path)) return false
    rmSync(path)
    return true
  }
}
