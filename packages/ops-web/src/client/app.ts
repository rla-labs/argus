// == ARGUS AGENT PROJECT ==
/**
 * The console. Four views — overview, approvals, chat, settings — over the
 * server's JSON. It changes nothing itself: every action is a command line or an
 * approval answer, sent to the server, which runs it as the signed-in person.
 */
import { html, render } from 'htm/preact'
import type { VNode } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { command, get, listen, post, SignedOut, type CommandOutcome } from './api.js'
import { clock, initialLanguage, lang, LANGUAGES, money, since, t, loadLanguage, type Language } from './i18n.js'
import { Constellation, Dial, Gauge, Trend } from './svg.js'

// ── the server's shapes ────────────────────────────────────────────────────

interface Overview {
  now: number
  panic: boolean
  slots: { used: number; limit: number; pending: number }
  projects: Array<{ id: string; description: string | null; status: string; model: string; running: boolean; waiting: boolean; dayPct: number | null; dayMicros: number; invalid: string | null }>
  spend: { dayMicros: number; dayLimitMicros: number | null; monthMicros: number; monthLimitMicros: number | null; trend: Array<{ day: string; micros: number }> }
  runs: Array<{ runId: string; who: string; model: string; steps: number; startedAt: number; micros: number }>
  approvals: Array<{ id: string; projectId: string | null; action: string; kind: string; at: number }>
  schedules: Array<{ id: string; cron: string; who: string; what: string; enabled: boolean; next: number }>
  log: Array<{ at: number; actor: string; action: string; target: string | null }>
}

interface Settings {
  defaults: { tasks: string; frontDesk: string | null }
  keys: Array<{ provider: string; configured: boolean; writable: boolean }>
  projects: Array<{ id: string; model: string; tools: Record<string, string> & { web_hosts: string[] }; dayUsd: number; monthUsd: number }>
}

interface ChatEntry {
  id: string
  at: number
  from: 'you' | 'argus'
  text: string
  files?: Array<{ id: string; name: string }>
  buttons?: Array<{ value: string; label: string }>
  questionId?: string
  answered?: string
}

type View = 'overview' | 'approvals' | 'chat' | 'settings'
const VIEWS: readonly View[] = ['overview', 'approvals', 'chat', 'settings']
const GROUPS = ['read', 'write', 'shell', 'web', 'agents', 'other'] as const

// ── small pieces ───────────────────────────────────────────────────────────

/** A stroke icon per view. */
function Icon({ view }: { view: View }): VNode {
  const paths: Record<View, string> = {
    overview: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M2 12c0-3 4.5-5 10-5s10 2 10 5-4.5 5-10 5S2 15 2 12',
    approvals: 'M12 2 20 5v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5zM8.5 12l2.5 2.5 4.5-5',
    chat: 'M4 5h16v11H9l-5 4z',
    settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 6a2 2 0 1 0 0 .1M10 12a2 2 0 1 0 0 .1M18 18a2 2 0 1 0 0 .1',
  }
  return html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d=${paths[view]}></path></svg>`
}

/** The answer to the last command, when there is one. */
function Notice({ outcome, onButton }: { outcome: CommandOutcome | undefined; onButton: (line: string) => void }): VNode | null {
  if (outcome === undefined) return null
  return html`<div class=${`notice${outcome.error ? ' err' : ''}`} role="status">
    ${outcome.text}
    ${outcome.buttons.length === 0
      ? null
      : html`<div class="btns" style="margin-top:8px">${outcome.buttons.map((button) => html`<button class="btn ghost" type="button" onClick=${() => onButton(button.command)}>${button.label}</button>`)}</div>`}
  </div>`
}

/** Approve / deny buttons for one pending approval. */
function ApprovalCard({ approval, onDone }: { approval: Overview['approvals'][number]; onDone: (message?: string) => void }): VNode {
  const [busy, setBusy] = useState(false)
  const answer = async (value: string): Promise<void> => {
    setBusy(true)
    const result = await post(`/api/approvals/${encodeURIComponent(approval.id)}`, { value })
    setBusy(false)
    onDone(result.ok ? undefined : t('approvals.gone'))
  }
  return html`<div class="approval">
    <div class="head"><span class="mono" style="color:var(--amber)">${approval.projectId ?? 'task'} · ${approval.kind}</span><span class="lbl">${clock(approval.at)}</span></div>
    <code class="action">${approval.action}</code>
    <div class="btns">
      <button class="btn primary" type="button" disabled=${busy} onClick=${() => answer('approve')}>${t('approvals.approve')}</button>
      <button class="btn ghost" type="button" disabled=${busy} onClick=${() => answer('approve-all')}>${t('approvals.approveAll')}</button>
      <button class="btn danger" type="button" disabled=${busy} onClick=${() => answer('deny')}>${t('approvals.deny')}</button>
    </div>
  </div>`
}

// ── views ──────────────────────────────────────────────────────────────────

function OverviewView({ data, refresh, run }: { data: Overview; refresh: () => void; run: (line: string) => void }): VNode {
  const upcoming = data.schedules.filter((row) => row.enabled && row.next - data.now < 24 * 3_600_000).sort((a, b) => a.next - b.next)
  const [gone, setGone] = useState<string | undefined>()
  return html`
    <div class="row">
      <section class="hud grow2">
        <div class="head"><h2>${t('constellation.title')}</h2><span class="lbl">${t('constellation.hint')}</span></div>
        ${data.projects.length === 0 ? html`<p class="empty">${t('constellation.none')}</p>` : null}
        <${Constellation} stars=${data.projects} />
      </section>
      <div class="grow1" style="display:flex;flex-direction:column;gap:20px">
        <section class="hud">
          <h2>${t('spend.title')}</h2>
          <div class="row" style="align-items:center;gap:16px">
            <${Gauge} spent=${data.spend.dayMicros} limit=${data.spend.dayLimitMicros} />
            <div style="display:flex;flex-direction:column;gap:12px;flex:1 1 120px">
              <div><div class="lbl">${t('spend.today')}</div><div class="mono">${money(data.spend.dayMicros)}</div></div>
              <div><div class="lbl">${t('spend.month')}</div><div class="mono">${money(data.spend.monthMicros)}${data.spend.monthLimitMicros === null ? '' : ` / ${money(data.spend.monthLimitMicros)}`}</div></div>
            </div>
          </div>
          <${Trend} points=${data.spend.trend} />
          <div class="lbl">${t('spend.trend')}</div>
        </section>
        <section class="hud">
          <div class="head"><h2>${t('approvals.title')}</h2><span class="lbl" style="color:var(--amber)">${t('approvals.pending', { count: data.approvals.length })}</span></div>
          ${gone === undefined ? null : html`<div class="notice err">${gone}</div>`}
          ${data.approvals.length === 0 ? html`<p class="empty">${t('approvals.none')}</p>` : null}
          ${data.approvals.slice(0, 2).map((approval) => html`<${ApprovalCard} key=${approval.id} approval=${approval} onDone=${(message?: string) => { setGone(message); refresh() }} />`)}
        </section>
      </div>
    </div>
    <div class="row">
      <section class="hud grow2">
        <h2>${t('runs.title')}</h2>
        ${data.runs.length === 0
          ? html`<p class="empty">${t('runs.none')}</p>`
          : html`<div class="scroll"><table>
              <thead><tr><th scope="col" class="lbl">${t('runs.who')}</th><th scope="col" class="lbl">${t('runs.model')}</th><th scope="col" class="lbl num">${t('runs.steps')}</th><th scope="col" class="lbl num">${t('runs.time')}</th><th scope="col" class="lbl num">${t('runs.cost')}</th><th></th></tr></thead>
              <tbody>${data.runs.map(
                (row) => html`<tr>
                  <td>${row.who}</td><td class="muted">${row.model}</td><td class="num" style="color:var(--orange-soft)">${row.steps}</td>
                  <td class="num">${since(row.startedAt, data.now)}</td><td class="num">${money(row.micros)}</td>
                  <td class="num">${row.who === 'task' || row.who === 'front desk' ? null : html`<button class="btn danger" type="button" onClick=${() => run(`/stop ${row.who}`)}>${t('runs.stop')}</button>`}</td>
                </tr>`,
              )}</tbody></table></div>`}
      </section>
      <section class="hud grow1">
        <h2>${t('schedule.title')}</h2>
        <div class="row" style="align-items:center;gap:14px">
          <${Dial} now=${data.now} runs=${upcoming.map((row) => ({ at: row.next }))} />
          ${upcoming.length === 0
            ? html`<p class="empty">${t('schedule.none')}</p>`
            : html`<ul class="plain" style="flex:1 1 120px">${upcoming.slice(0, 6).map((row) => html`<li><span style="color:var(--cyan)">${clock(row.next)}</span> ${row.who}<br /><span class="muted">${row.what}</span></li>`)}</ul>`}
        </div>
      </section>
      <section class="hud grow1">
        <h2>${t('log.title')}</h2>
        <ol class="log">${data.log.map((row) => html`<li><time>${clock(row.at)}</time><span>${row.action}${row.target === null ? '' : ` · ${row.target}`}</span></li>`)}</ol>
      </section>
    </div>`
}

function ApprovalsView({ data, refresh }: { data: Overview; refresh: () => void }): VNode {
  const [gone, setGone] = useState<string | undefined>()
  return html`<section class="hud">
    <div class="head"><h2>${t('approvals.title')}</h2><span class="lbl">${t('approvals.pending', { count: data.approvals.length })}</span></div>
    ${gone === undefined ? null : html`<div class="notice err">${gone}</div>`}
    ${data.approvals.length === 0 ? html`<p class="empty">${t('approvals.none')}</p>` : null}
    ${data.approvals.map((approval) => html`<${ApprovalCard} key=${approval.id} approval=${approval} onDone=${(message?: string) => { setGone(message); refresh() }} />`)}
  </section>`
}

function ChatView({ version }: { version: number }): VNode {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void get<{ entries: ChatEntry[] }>('/api/chat').then((body) => setEntries(body.entries))
  }, [version])
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [entries.length])
  const sendText = async (): Promise<void> => {
    const value = text
    if (value.trim().length === 0) return
    setText('')
    await post('/api/chat', { text: value })
  }
  return html`<section class="hud chat">
    <div class="head"><h2>${t('chat.title')}</h2><span class="lbl">${t('chat.hint')}</span></div>
    <div class="messages" aria-live="polite">
      ${entries.length === 0 ? html`<p class="empty">${t('chat.empty')}</p>` : null}
      ${entries.map(
        (entry) => html`<div class=${`msg ${entry.from}`}>
          <span class="when">${entry.from === 'you' ? '' : 'Argus · '}${clock(entry.at)}</span>${entry.text}
          ${(entry.files ?? []).map((file) => html`<div><a class="file" href=${`/api/files/${encodeURIComponent(file.id)}`} download=${file.name}>⤓ ${file.name}</a></div>`)}
          ${entry.buttons === undefined
            ? null
            : entry.answered !== undefined
              ? html`<div class="lbl" style="margin-top:8px">${entry.answered === 'timeout' ? t('chat.expired') : t('chat.answered', { value: entry.answered })}</div>`
              : html`<div class="btns" style="margin-top:8px">${entry.buttons.map((button) => html`<button class="btn ghost" type="button" onClick=${() => post('/api/chat/press', { entryId: entry.id, value: button.value })}>${button.label}</button>`)}</div>`}
        </div>`,
      )}
      <div ref=${end}></div>
    </div>
    <form class="composer" onSubmit=${(event: Event) => { event.preventDefault(); void sendText() }}>
      <label for="chat-input" class="sr">${t('chat.placeholder')}</label>
      <textarea id="chat-input" rows="2" placeholder=${t('chat.placeholder')} value=${text}
        onInput=${(event: Event) => setText((event.target as HTMLTextAreaElement).value)}
        onKeyDown=${(event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendText() } }}></textarea>
      <button class="btn primary" type="submit">${t('chat.send')}</button>
    </form>
  </section>`
}

function SettingsView({ data, run, outcome }: { data: Settings; run: (line: string) => void; outcome: VNode | null }): VNode {
  const [tasks, setTasks] = useState(data.defaults.tasks)
  const [desk, setDesk] = useState(data.defaults.frontDesk ?? '')
  const [provider, setProvider] = useState(data.keys[0]?.provider ?? '')
  const [key, setKey] = useState('')
  return html`
    ${outcome}
    <div class="row">
      <section class="hud grow1">
        <h2>${t('settings.defaults')}</h2>
        <form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); run(`/defaults tasks ${tasks.trim()}`) }}>
          <div class="field" style="flex:1 1 220px"><label class="lbl" for="d-tasks">${t('settings.tasks')}</label><input id="d-tasks" class="mono" placeholder=${t('settings.model')} value=${tasks} onInput=${(e: Event) => setTasks((e.target as HTMLInputElement).value)} /></div>
          <button class="btn ghost" type="submit">${t('settings.save')}</button>
        </form>
        ${data.defaults.frontDesk === null
          ? null
          : html`<form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); run(`/defaults frontdesk ${desk.trim()}`) }}>
              <div class="field" style="flex:1 1 220px"><label class="lbl" for="d-desk">${t('settings.frontdesk')}</label><input id="d-desk" class="mono" placeholder=${t('settings.model')} value=${desk} onInput=${(e: Event) => setDesk((e.target as HTMLInputElement).value)} /></div>
              <button class="btn ghost" type="submit">${t('settings.save')}</button>
            </form>`}
      </section>
      <section class="hud grow1">
        <h2>${t('settings.keys')}</h2>
        <p class="muted" style="margin:0">${t('settings.keysHint')}</p>
        <form class="inline" autocomplete="off" onSubmit=${(event: Event) => { event.preventDefault(); if (key.trim().length > 0) { run(`/key ${provider} ${key.trim()}`); setKey('') } }}>
          <div class="field"><label class="lbl" for="k-provider">${t('settings.keyProvider')}</label>
            <select id="k-provider" value=${provider} onChange=${(e: Event) => setProvider((e.target as HTMLSelectElement).value)}>${data.keys.map((entry) => html`<option value=${entry.provider}>${entry.provider}</option>`)}</select></div>
          <div class="field" style="flex:1 1 200px"><label class="lbl" for="k-value">${t('settings.keyValue')}</label><input id="k-value" type="password" class="mono" value=${key} onInput=${(e: Event) => setKey((e.target as HTMLInputElement).value)} /></div>
          <button class="btn ghost" type="submit">${t('settings.save')}</button>
        </form>
        <ul class="plain">${data.keys.filter((entry) => entry.configured).map(
          (entry) => html`<li style="display:flex;gap:10px;align-items:center"><span style="flex:1">${entry.provider} · <span class="muted">${entry.writable ? t('settings.keySet') : t('settings.keyEnv')}</span></span>
            ${entry.writable ? html`<button class="btn danger" type="button" onClick=${() => run(`/key remove ${entry.provider}`)}>${t('settings.remove')}</button>` : null}</li>`,
        )}</ul>
      </section>
    </div>
    <section class="hud">
      <h2>${t('settings.tools')}</h2>
      <p class="muted" style="margin:0">${t('settings.toolsHint')}</p>
      <div class="scroll"><table>
        <thead><tr><th scope="col" class="lbl">${t('settings.project')}</th>${GROUPS.map((group) => html`<th scope="col" class="lbl">${t(`tools.${group}`)}</th>`)}<th scope="col" class="lbl">${t('settings.budget')}</th></tr></thead>
        <tbody>${data.projects.map(
          (project) => html`<tr>
            <td>${project.id}<br /><span class="faint">${project.model}</span></td>
            ${GROUPS.map(
              (group) => html`<td><label class="sr" for=${`t-${project.id}-${group}`}>${project.id} ${group}</label>
                <select id=${`t-${project.id}-${group}`} value=${project.tools[group]} onChange=${(e: Event) => run(`/set ${project.id} tools.${group} ${(e.target as HTMLSelectElement).value}`)}>
                  ${(group === 'other' ? ['deny', 'ask', 'allow'] : ['off', 'deny', 'ask', 'allow']).map((value) => html`<option value=${value}>${value}</option>`)}
                </select></td>`,
            )}
            <td>$${project.dayUsd} / $${project.monthUsd}</td>
          </tr>`,
        )}</tbody></table></div>
    </section>`
}

// ── the app ────────────────────────────────────────────────────────────────

function App(): VNode {
  const [, setLang] = useState<Language>(lang())
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined)
  const [view, setView] = useState<View>(() => (VIEWS.find((v) => `#${v}` === location.hash) ?? 'overview'))
  const [overviewData, setOverview] = useState<Overview | undefined>()
  const [settingsData, setSettings] = useState<Settings | undefined>()
  const [chatVersion, setChatVersion] = useState(0)
  const [connected, setConnected] = useState(true)
  const [outcome, setOutcome] = useState<CommandOutcome | undefined>()
  const [failure, setFailure] = useState<string | undefined>()

  const guard = useCallback(async (work: () => Promise<void>) => {
    try {
      await work()
      setFailure(undefined)
    } catch (error) {
      if (error instanceof SignedOut) setSignedIn(false)
      else setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [])
  const loadOverview = useCallback(() => guard(async () => setOverview(await get<Overview>('/api/overview'))), [guard])
  const loadSettings = useCallback(() => guard(async () => setSettings(await get<Settings>('/api/settings'))), [guard])
  const run = useCallback(
    (line: string) =>
      void guard(async () => {
        setOutcome(await command(line))
        await Promise.all([loadOverview(), loadSettings()])
      }),
    [guard, loadOverview, loadSettings],
  )

  useEffect(() => {
    void get('/api/me').then(() => setSignedIn(true), () => setSignedIn(false))
  }, [])
  useEffect(() => {
    if (signedIn !== true) return undefined
    void loadOverview()
    void loadSettings()
    // A minute's tick keeps the clocks honest between events.
    const tick = setInterval(() => void loadOverview(), 60_000)
    const stop = listen(
      (topic) => {
        if (topic === 'overview') void loadOverview()
        else if (topic === 'settings') void loadSettings()
        else if (topic === 'chat') setChatVersion((v) => v + 1)
      },
      setConnected,
    )
    return () => {
      clearInterval(tick)
      stop()
    }
  }, [signedIn, loadOverview, loadSettings])

  const go = (next: View): void => {
    setView(next)
    setOutcome(undefined)
    history.replaceState(null, '', `#${next}`)
  }
  const switchLanguage = (next: Language): void => void loadLanguage(next).then(() => setLang(next))

  if (signedIn === undefined) return html`<p class="empty" style="padding:40px">${t('common.loading')}</p>`
  const header = html`<header class="top">
    <div class="brand">
      <svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true"><polygon points="20,2 36,11 36,29 20,38 4,29 4,11" fill="none" stroke="#3BD5FF" stroke-width="1.5"></polygon><path d="M8 20 Q20 9 32 20 Q20 31 8 20 Z" fill="rgba(59,213,255,.12)" stroke="#3BD5FF" stroke-width="1.5"></path><circle cx="20" cy="20" r="5" fill="#FF8A3D"></circle><circle cx="20" cy="20" r="2" fill="#04070D"></circle></svg>
      <div><b><span class="a">ARGUS</span> <span class="b">AGENT</span></b><div class="lbl">${t('brand.sub')}</div></div>
    </div>
    ${signedIn
      ? html`<span class=${`pill${overviewData?.panic === true || !connected ? ' warn' : ''}`}><span class="dot" aria-hidden="true"></span>${!connected ? t('status.offline') : overviewData?.panic === true ? t('status.panic') : t('status.online')}</span>`
      : null}
    <div class="btns" role="group" aria-label=${t('lang.label')}>
      ${LANGUAGES.map((code) => html`<button type="button" class=${`btn ${lang() === code ? 'primary' : 'ghost'}`} aria-pressed=${lang() === code} onClick=${() => switchLanguage(code)}>${code.toUpperCase()}</button>`)}
    </div>
  </header>`

  if (!signedIn) {
    return html`${header}<section class="hud signin"><h2>${t('signin.title')}</h2><p>${t('signin.text')}</p></section>`
  }

  const pending = overviewData?.approvals.length ?? 0
  return html`${header}
    <div class="layout">
      <nav class="rail" aria-label=${t('nav.label')}>
        ${VIEWS.map(
          (each) => html`<button type="button" aria-current=${view === each ? 'page' : undefined} onClick=${() => go(each)}>
            <${Icon} view=${each} />${t(`nav.${each}`)}${each === 'approvals' && pending > 0 ? html`<span class="count">${pending}</span>` : null}
          </button>`,
        )}
        <button type="button" onClick=${() => void post('/api/logout', {}).then(() => setSignedIn(false))}>${t('nav.signout')}</button>
        ${overviewData === undefined
          ? null
          : html`<div class="hud" style="margin-top:16px;padding:14px">
              <div class="lbl">${t('governor.title')}</div>
              <div class="mono">${t('governor.slots', { used: overviewData.slots.used, limit: overviewData.slots.limit })}</div>
              ${overviewData.slots.pending === 0 ? null : html`<div class="mono muted">${t('governor.queued', { count: overviewData.slots.pending })}</div>`}
            </div>`}
      </nav>
      <main>
        ${failure === undefined ? null : html`<div class="notice err">${t('common.error', { message: failure })}</div>`}
        ${view === 'overview' ? (overviewData === undefined ? html`<p class="empty">${t('common.loading')}</p>` : html`<${Notice} outcome=${outcome} onButton=${run} /><${OverviewView} data=${overviewData} refresh=${loadOverview} run=${run} />`) : null}
        ${view === 'approvals' && overviewData !== undefined ? html`<${ApprovalsView} data=${overviewData} refresh=${loadOverview} />` : null}
        ${view === 'chat' ? html`<${ChatView} version=${chatVersion} />` : null}
        ${view === 'settings' ? (settingsData === undefined ? html`<p class="empty">${t('common.loading')}</p>` : html`<${SettingsView} key=${JSON.stringify(settingsData.defaults)} data=${settingsData} run=${run} outcome=${html`<${Notice} outcome=${outcome} onButton=${run} />`} />`) : null}
      </main>
    </div>`
}

void loadLanguage(initialLanguage()).then(() => render(html`<${App} />`, document.getElementById('app') as HTMLElement))
