// == ARGUS AGENT PROJECT ==
/**
 * A conversation: a project's or a session's. What you write goes there and the
 * answers, questions and files come back there; a question's buttons answer it in place.
 */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { get, post, upload } from '../api.js'
import { clock, t } from '../i18n.js'
import { Icon, toast } from '../kit.js'

export interface ChatEntry {
  readonly id: string
  readonly at: number
  readonly from: 'you' | 'argus'
  readonly text: string
  readonly files?: ReadonlyArray<{ id: string; name: string }>
  readonly buttons?: ReadonlyArray<{ value: string; label: string }>
  readonly answered?: string
  readonly note?: string
}

/**
 * One conversation.
 *
 * @param thread `p:<project>` or `s:<session>`.
 * @param version bumped when the server says this person's chats changed.
 * @param uploadTo a project to upload files into (its `inbox/`), when there is one.
 * @param busy what the agent is doing now, shown under the last message.
 * @param empty what an empty conversation says.
 */
export function Thread({ thread, version, uploadTo, busy, empty, placeholder, onSent }: { thread: string; version: number; uploadTo?: string; busy?: string | null; empty: string; placeholder: string; onSent?: () => void }): VNode {
  const [entries, setEntries] = useState<ChatEntry[] | undefined>()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    void get<{ entries: ChatEntry[] }>(`/api/chat?thread=${encodeURIComponent(thread)}`).then((body) => {
      if (!live) return
      setEntries(body.entries)
      // On the screen means seen.
      void post('/api/chat/read', { thread })
    })
    return () => {
      live = false
    }
  }, [thread, version])
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [entries?.length, busy])
  // A draft the start page's box left for this conversation.
  useEffect(() => {
    try {
      const key = `argus.draft.${thread.slice(2)}`
      const draft = sessionStorage.getItem(key)
      if (draft !== null) {
        sessionStorage.removeItem(key)
        void send(draft)
      }
    } catch {
      // No storage: nothing was left.
    }
  }, [thread])

  async function send(value: string): Promise<void> {
    if (value.trim().length === 0 || sending) return
    setSending(true)
    const result = await post('/api/chat', { thread, text: value })
    setSending(false)
    if (!result.ok) toast(t('thread.notSent'), true)
    else {
      setText('')
      onSent?.()
    }
  }
  async function files(list: FileList | null | undefined): Promise<void> {
    if (uploadTo === undefined || list === null || list === undefined) return
    for (const file of Array.from(list)) {
      toast(t('projects.uploading', { name: file.name, pct: '0' }))
      const outcome = await upload(uploadTo, file, () => undefined)
      toast(outcome.ok ? t('thread.uploaded', { path: outcome.path ?? file.name }) : t('projects.uploadFailed', { error: outcome.error ?? '' }), !outcome.ok)
      if (outcome.ok && outcome.path !== undefined) setText((current) => `${current}${current.length === 0 || current.endsWith('\n') ? '' : '\n'}${outcome.path}`)
    }
  }

  return html`<section class=${`panel thread${dragging ? ' dragging' : ''}`} aria-label=${t('thread.label')}
      onDragOver=${(event: DragEvent) => { if (uploadTo !== undefined) { event.preventDefault(); setDragging(true) } }}
      onDragLeave=${() => setDragging(false)}
      onDrop=${(event: DragEvent) => { event.preventDefault(); setDragging(false); void files(event.dataTransfer?.files) }}>
    <div class="messages" aria-live="polite">
      ${entries === undefined ? html`<p class="empty">${t('common.loading')}</p>` : entries.length === 0 ? html`<p class="empty" style="padding:24px 4px">${empty}</p>` : null}
      ${(entries ?? []).map((entry) => html`<div key=${entry.id} class=${`bubble ${entry.from}`}>
        <div class="when">${entry.from === 'you' ? t('thread.you') : 'Argus'} · ${clock(entry.at)}</div>
        <div class="text">${entry.text}</div>
        ${(entry.files ?? []).map((file) => html`<a class="file" href=${`/api/files/${encodeURIComponent(file.id)}`} download=${file.name}><${Icon} name="out" size=${14} />${file.name}</a>`)}
        ${entry.buttons === undefined
          ? null
          : entry.answered !== undefined
            ? html`<div class="faint" style="font-size:12.5px;margin-top:8px">${entry.note ?? (entry.answered === 'timeout' ? t('chat.expired') : t('chat.answered', { value: entry.answered }))}</div>`
            : html`<div class="cluster" style="margin-top:10px">${entry.buttons.map((button, i) => html`<button type="button" class=${`btn sm ${i === 0 ? 'primary' : ''}`} onClick=${() => void post('/api/chat/press', { entryId: entry.id, value: button.value })}>${button.label}</button>`)}</div>`}
      </div>`)}
      ${busy === undefined || busy === null ? null : html`<div class="working"><span class="live" aria-hidden="true"><span></span><span></span><span></span><span></span></span>${busy}</div>`}
      <div ref=${end}></div>
    </div>
    <form class="composer" onSubmit=${(event: Event) => { event.preventDefault(); void send(text) }}>
      ${uploadTo === undefined
        ? null
        : html`<label class="btn icon" title=${t('thread.attach')}><span class="sr">${t('thread.attach')}</span><${Icon} name="plus" /><input type="file" multiple class="sr" onChange=${(event: Event) => { const input = event.target as HTMLInputElement; void files(input.files).then(() => { input.value = '' }) }} /></label>`}
      <label for=${`composer-${thread}`} class="sr">${placeholder}</label>
      <textarea id=${`composer-${thread}`} class="in" rows="2" placeholder=${placeholder} value=${text}
        onInput=${(event: Event) => setText((event.target as HTMLTextAreaElement).value)}
        onKeyDown=${(event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(text) } }}></textarea>
      <button type="submit" class="btn primary" disabled=${sending}>${t('ask.send')}</button>
    </form>
  </section>`
}
