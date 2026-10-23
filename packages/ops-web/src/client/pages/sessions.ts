// == ARGUS AGENT PROJECT ==
/**
 * Sessions: conversations with no project, on the default model. Each remembers only
 * while it is open, and closes a day after its last message.
 */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { money, t } from '../i18n.js'
import { Icon, PageHead, StateChip } from '../kit.js'
import { useData, type PageProps } from '../ui.js'
import { when } from './home.js'
import { Thread } from './thread.js'

interface Session {
  readonly id: string
  readonly lastActive: number
  readonly running: boolean
  readonly text: string | null
  readonly micros: number
  readonly model: string | null
}

/** A new session's id, as `/task` makes them. */
function newId(): string {
  return `task-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** How long until a session closes: a day after its last message. */
function closesIn(lastActive: number): string {
  const hours = Math.max(0, Math.ceil((lastActive + 86_400_000 - Date.now()) / 3_600_000))
  return t('sessions.closesIn', { hours })
}

export function SessionsView({ version, chatVersion, run, can }: PageProps & { chatVersion: number }): VNode {
  const data = useData<{ sessions: Session[] }>('/api/sessions', version + chatVersion)
  const [open, setOpen] = useState<string | undefined>()
  const [fresh, setFresh] = useState<string | undefined>()
  const sessions = data?.sessions ?? []
  const current = open ?? fresh ?? sessions[0]?.id
  const shown = sessions.find((session) => session.id === current)
  const start = (): void => {
    const id = newId()
    setFresh(id)
    setOpen(id)
  }
  return html`
    <${PageHead} title=${t('nav.sessions')} sub=${t('sessions.sub')}>
      ${can('task') ? html`<button type="button" class="btn primary" onClick=${start}><${Icon} name="plus" size=${16} />${t('sessions.new')}</button>` : null}
    <//>
    <div class="split">
      <section class="panel" aria-label=${t('nav.sessions')} style="flex:1 1 260px;max-width:340px;min-width:0">
        ${fresh !== undefined && !sessions.some((session) => session.id === fresh)
          ? html`<button type="button" class="tree session" aria-current=${current === fresh ? 'true' : undefined} onClick=${() => setOpen(fresh)}><b>${t('sessions.untitled')}</b><span class="faint">${t('sessions.notStarted')}</span></button>`
          : null}
        ${sessions.length === 0 && fresh === undefined ? html`<p class="empty pad">${t('sessions.none')}</p>` : null}
        ${sessions.map((session) => html`<button type="button" key=${session.id} class="tree session" aria-current=${current === session.id ? 'true' : undefined} onClick=${() => setOpen(session.id)}>
          <span class="cluster" style="width:100%"><b class="tree-name">${session.text ?? session.id}</b>${session.running ? html`<${StateChip} state="running" label=${t('state.running')} />` : null}</span>
          <span class="faint">${when(session.lastActive)} · ${money(session.micros)} · ${closesIn(session.lastActive)}</span>
        </button>`)}
      </section>
      <div style="flex:999 1 460px;min-width:0" class="stack">
        ${current === undefined
          ? html`<div class="panel corners pad empty-state"><${Icon} name="sessions" size=${36} /><h2>${t('sessions.emptyTitle')}</h2><p class="muted">${t('sessions.emptyText')}</p>${can('task') ? html`<button type="button" class="btn primary" onClick=${start}>${t('sessions.new')}</button>` : null}</div>`
          : html`
            ${shown === undefined
              ? null
              : html`<div class="cluster"><span class="faint" style="font-size:12.5px">${closesIn(shown.lastActive)}${shown.model === null ? '' : ` · ${shown.model}`}</span>
                  <button type="button" class="btn sm danger" style="margin-left:auto" onClick=${() => { run(`/session close ${shown.id}`); setOpen(undefined); setFresh(undefined) }}>${t('sessions.close')}</button></div>`}
            <${Thread} key=${current} thread=${`s:${current}`} version=${chatVersion} busy=${shown?.running === true ? t('state.running') : null}
              empty=${t('sessions.first')} placeholder=${t('sessions.placeholder')} onSent=${() => setFresh(undefined)} />`}
      </div>
    </div>`
}
