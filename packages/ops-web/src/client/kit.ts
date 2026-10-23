// == ARGUS AGENT PROJECT ==
/**
 * The console's parts: icons, state chips, toggles, segmented choices, a budget bar, a
 * dialog, and the toasts that say what an action did, where it was done.
 */
import { html } from 'htm/preact'
import type { ComponentChildren, VNode } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { t } from './i18n.js'

/** Stroke icons, 24×24. */
export const ICONS = {
  projects: 'M3 7h7l2 2h9v10H3zM3 7V5h6l2 2',
  inbox: 'M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
  sessions: 'M4 5h16v11H9l-5 4z',
  schedules: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  costs: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 6a2 2 0 1 0 0 .1M10 12a2 2 0 1 0 0 .1M18 18a2 2 0 1 0 0 .1',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-4-4',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12l4 4L19 6',
  close: 'M6 6l12 12M18 6L6 18',
  stop: 'M7 7h10v10H7z',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  shield: 'M12 2 20 5v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z',
  activity: 'M4 12h4l3-7 4 14 3-7h2',
} as const

export type IconName = keyof typeof ICONS

/** An icon; decorative unless it has a label. */
export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }): VNode {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden=${label === undefined ? 'true' : undefined} role=${label === undefined ? undefined : 'img'} aria-label=${label}><path d=${ICONS[name]}></path></svg>`
}

/** The hexagon and eye. */
export function Logo({ size = 34 }: { size?: number }): VNode {
  return html`<svg width=${size} height=${size} viewBox="0 0 40 40" aria-hidden="true"><polygon points="20,2 36,11 36,29 20,38 4,29 4,11" fill="none" stroke="var(--accent)" stroke-width="1.5"></polygon><path d="M8 20 Q20 9 32 20 Q20 31 8 20 Z" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"></path><circle cx="20" cy="20" r="5" fill="var(--warm)"></circle><circle cx="20" cy="20" r="2" fill="var(--bg)"></circle></svg>`
}

/** The states a chip shows. */
export type ChipState = 'running' | 'waiting' | 'paused' | 'idle' | 'broken' | 'ok'

/** A state as a coloured chip; `running` and `waiting` pulse. */
export function StateChip({ state, label }: { state: ChipState; label: string }): VNode {
  return html`<span class=${`chip st-${state}`}><span class="dot" aria-hidden="true"></span>${label}</span>`
}

/** An on/off switch. */
export function Toggle({ checked, label, onChange, disabled = false }: { checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }): VNode {
  return html`<button type="button" class="toggle" role="switch" aria-checked=${checked ? 'true' : 'false'} aria-label=${label} disabled=${disabled} onClick=${() => onChange(!checked)}></button>`
}

/** One of a few choices. A `hot` choice, when chosen, shows in the warning colour. */
export function Seg<T extends string>({ value, options, label, onChange, disabled = false }: { value: T; options: ReadonlyArray<{ value: T; label: string; hot?: boolean }>; label: string; onChange: (next: T) => void; disabled?: boolean }): VNode {
  return html`<div class="seg" role="group" aria-label=${label}>
    ${options.map((option) => html`<button type="button" class=${option.hot === true ? 'hot' : ''} aria-pressed=${option.value === value ? 'true' : 'false'} disabled=${disabled} onClick=${() => option.value !== value && onChange(option.value)}>${option.label}</button>`)}
  </div>`
}

/** Spent of a limit, as a bar that warns at 80% and turns red at 100%. */
export function Bar({ pct }: { pct: number }): VNode {
  const width = Math.max(0, Math.min(100, pct))
  return html`<div class="bar" aria-hidden="true"><div class=${pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : ''} style=${`width:${width}%`}></div></div>`
}

/** The page's title, its line under it, and its main action. */
export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ComponentChildren }): VNode {
  return html`<div class="page-head"><div><h1>${title}</h1>${sub === undefined ? null : html`<p>${sub}</p>`}</div>${children}</div>`
}

/**
 * A dialog over the page. Escape and a click outside close it; focus moves into it and
 * back to where it was.
 */
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children?: ComponentChildren; wide?: boolean }): VNode {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const first = box.current?.querySelector<HTMLElement>('input, textarea, select, button.primary, button')
    first?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      before?.focus()
    }
  }, [])
  return html`<div class="scrim" onClick=${(event: Event) => event.target === event.currentTarget && onClose()}>
    <div ref=${box} class="panel corners modal" role="dialog" aria-modal="true" aria-label=${title} style=${wide ? 'max-width:640px' : ''}>
      <h2>${title}</h2>
      ${children}
    </div>
  </div>`
}

// ── toasts ──────────────────────────────────────────────────────────────

interface ToastEntry {
  readonly id: number
  readonly text: string
  readonly error: boolean
}

let toasts: ToastEntry[] = []
let nextToast = 1
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((listener) => listener())

/**
 * Say what happened, briefly, in the corner. An error stays until closed; the rest go
 * after a few seconds.
 */
export function toast(text: string, error = false): void {
  const id = nextToast++
  toasts = [...toasts.slice(-3), { id, text, error }]
  notify()
  if (!error) setTimeout(() => dismiss(id), Math.min(9000, 3000 + text.length * 30))
}

function dismiss(id: number): void {
  toasts = toasts.filter((entry) => entry.id !== id)
  notify()
}

/** Where the toasts show; mounted once by the app. */
export function Toasts(): VNode {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = (): void => setTick((tick) => tick + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map((entry) => html`<div key=${entry.id} class=${`toast${entry.error ? ' err' : ''}`}>
      <span class=${entry.error ? 'bad' : 'ok'}><${Icon} name=${entry.error ? 'close' : 'check'} /></span>
      <span style="flex:1">${entry.text}</span>
      <button type="button" aria-label=${t('common.close')} onClick=${() => dismiss(entry.id)}><${Icon} name="close" size=${14} /></button>
    </div>`)}
  </div>`
}
