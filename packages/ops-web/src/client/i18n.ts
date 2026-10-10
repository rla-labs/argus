// == ARGUS AGENT PROJECT ==
/**
 * Translations. `en.json` is the source; every other language has exactly its
 * keys (a test checks). A missing key shows the English text, then the key.
 */

/** The languages the interface ships. */
export const LANGUAGES = ['en', 'ro'] as const
export type Language = (typeof LANGUAGES)[number]

let english: Record<string, string> = {}
let current: Record<string, string> = {}
let language: Language = 'en'

/** The language to start in: the viewer's last choice, else the browser's, else English. */
export function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem('argus.lang')
    if (saved !== null && (LANGUAGES as readonly string[]).includes(saved)) return saved as Language
  } catch {
    // Storage can be unavailable (a private window); the browser's language decides.
  }
  const browser = (navigator.language || 'en').slice(0, 2)
  return (LANGUAGES as readonly string[]).includes(browser) ? (browser as Language) : 'en'
}

/** Load a language, remembering the choice. */
export async function loadLanguage(next: Language): Promise<void> {
  const load = async (code: string): Promise<Record<string, string>> => (await fetch(`/static/locales/${code}.json`)).json() as Promise<Record<string, string>>
  if (Object.keys(english).length === 0) english = await load('en')
  current = next === 'en' ? english : await load(next)
  language = next
  document.documentElement.lang = next
  try {
    localStorage.setItem('argus.lang', next)
  } catch {
    // Not remembered; it still applies to this page.
  }
}

/** The current language. */
export function lang(): Language {
  return language
}

/**
 * A text by key, with `{name}` placeholders filled.
 *
 * @param key the key in `en.json`.
 * @param vars the placeholder values.
 * @returns the text.
 */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const text = current[key] ?? english[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
}

/** Micro-USD as money, in the current language's format. */
export function money(micros: number): string {
  return new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: micros < 10_000 && micros > 0 ? 4 : 2 }).format(micros / 1_000_000)
}

/** A time of day. */
export function clock(at: number): string {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(at)
}

/** A duration since a moment, as `12m` or `1h 05m`. */
export function since(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
