// == ARGUS AGENT PROJECT ==
/** Pieces every page uses: a command's answer, a command's text, data that follows changes. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { command, get, type CommandOutcome } from './api.js'
import { t } from './i18n.js'

/** What every page gets from the app. */
export interface PageProps {
  /** Bumped after every command and every change event: refetch. */
  readonly version: number
  /** Run a command line as the signed-in user; its answer shows in `outcome`. */
  readonly run: (line: string) => void
  /** The last command's answer. */
  readonly outcome: VNode | null
  /** Whether the signed-in user may run a command (admin-only ones are hidden from operators). */
  readonly can: (command: string) => boolean
}

/** The answer to the last command, when there is one. */
export function Notice({ outcome, onButton }: { outcome: CommandOutcome | undefined; onButton: (line: string) => void }): VNode | null {
  if (outcome === undefined) return null
  return html`<div class=${`notice${outcome.error ? ' err' : ''}`} role="status">
    ${outcome.text}
    ${(outcome.files ?? []).map((file) => html`<div><a class="file" href=${`/api/files/${encodeURIComponent(file.id)}`} download=${file.name}>⤓ ${file.name}</a></div>`)}
    ${outcome.buttons.length === 0
      ? null
      : html`<div class="btns" style="margin-top:8px">${outcome.buttons.map((button) => html`<button class="btn ghost" type="button" onClick=${() => onButton(button.command)}>${button.label}</button>`)}</div>`}
  </div>`
}

/**
 * JSON from the server, refetched when `version` changes.
 *
 * @returns the data, `null` for a 404, or `undefined` while loading.
 */
export function useData<T>(path: string, version: number): T | null | undefined {
  const [data, setData] = useState<T | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    get<T>(path).then(
      (body) => live && setData(body),
      (error: unknown) => live && error instanceof Error && error.message === '404' && setData(null),
    )
    return () => {
      live = false
    }
  }, [path, version])
  return data
}

/** The text a read-only command answers, as in the chat (`/status`, `/memory`, `/files`). */
export function CommandText({ line, version }: { line: string; version: number }): VNode {
  const [text, setText] = useState<string | undefined>()
  useEffect(() => {
    let live = true
    void command(line).then((out) => live && setText(out.text))
    return () => {
      live = false
    }
  }, [line, version])
  return text === undefined ? html`<p class="empty">${t('common.loading')}</p>` : html`<pre class="mono output">${text}</pre>`
}

/** A labelled input in a form row. */
export function Field({ id, label, value, onInput, placeholder, grow = '1 1 180px', type = 'text' }: { id: string; label: string; value: string; onInput: (value: string) => void; placeholder?: string; grow?: string; type?: string }): VNode {
  return html`<div class="field" style=${`flex:${grow}`}><label class="lbl" for=${id}>${label}</label>
    <input id=${id} type=${type} class="mono" placeholder=${placeholder ?? ''} value=${value} onInput=${(event: Event) => onInput((event.target as HTMLInputElement).value)} /></div>`
}
