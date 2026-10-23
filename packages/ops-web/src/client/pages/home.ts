// == ARGUS AGENT PROJECT ==
/**
 * The start page: what waits for you, a box to ask for something, and a card per
 * project, the ones that need you first. Also the new-project dialog.
 */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { command, post } from '../api.js'
import { clock, money, t } from '../i18n.js'
import { Bar, Icon, Modal, PageHead, StateChip, toast, type ChipState } from '../kit.js'
import { go, href } from '../router.js'
import { useData, type PageProps } from '../ui.js'
import type { Overview } from './legacy.js'

/** A project as the start page shows it. */
export interface ProjectCard {
  readonly id: string
  readonly description: string | null
  readonly status: string
  readonly model: string
  readonly running: boolean
  readonly waiting: boolean
  readonly invalid: string | null
  readonly dayMicros: number
  readonly dayLimitMicros: number | null
  readonly monthMicros: number
  readonly monthLimitMicros: number | null
  readonly lastRun: { readonly at: number; readonly status: string; readonly text: string | null; readonly stopReason: string | null; readonly steps: number } | null
  readonly step: number | null
  readonly next: { readonly at: number; readonly what: string } | null
  readonly pending: number
}

/** A project's state, in one word, and the colour it shows in. */
export function stateOf(project: Pick<ProjectCard, 'invalid' | 'running' | 'waiting' | 'pending' | 'status'>): { readonly chip: ChipState; readonly label: string; readonly rank: number } {
  if (project.waiting || project.pending > 0) return { chip: 'waiting', label: t('state.waiting'), rank: 0 }
  if (project.invalid !== null) return { chip: 'broken', label: t('state.invalid'), rank: 1 }
  if (project.status === 'paused') return { chip: 'paused', label: t('state.paused'), rank: 2 }
  if (project.running) return { chip: 'running', label: t('state.running'), rank: 3 }
  return { chip: 'idle', label: t('state.idle'), rank: 4 }
}

/** When, in words: "21:14", "yesterday 18:20", "12 Oct". */
export function when(at: number, now = Date.now()): string {
  const day = (time: number): string => new Date(time).toDateString()
  if (day(at) === day(now)) return clock(at)
  if (day(at) === day(now - 86_400_000)) return t('time.yesterday', { time: clock(at) })
  if (day(at) === day(now + 86_400_000)) return t('time.tomorrow', { time: clock(at) })
  return new Intl.DateTimeFormat(document.documentElement.lang || 'en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at)
}

/** Spent against a limit, as text. */
export function spentText(micros: number, limit: number | null): string {
  return limit === null ? money(micros) : `${money(micros)} / ${money(limit)}`
}

/** The line under a card's description: what it is doing or did last. */
function activity(project: ProjectCard): string {
  if (project.invalid !== null) return t('home.invalid')
  if (project.step !== null) return t('home.working', { step: project.step })
  if (project.lastRun === null) return t('home.never')
  const how = project.lastRun.stopReason ?? (project.lastRun.status === 'completed' ? t('home.done') : project.lastRun.status)
  return `${when(project.lastRun.at)} · ${project.lastRun.text ?? how}`
}

function Card({ project }: { project: ProjectCard }): VNode {
  const state = stateOf(project)
  const pct = project.dayLimitMicros === null || project.dayLimitMicros === 0 ? 0 : (project.dayMicros / project.dayLimitMicros) * 100
  return html`<a class=${`panel pcard${state.chip === 'running' ? ' run' : ''}`} href=${href({ name: 'project', id: project.id, tab: 'chat', sec: '' })}>
    <span class="pcard-head"><span class="disp pcard-name">${project.id}</span><${StateChip} state=${state.chip} label=${state.label} /></span>
    <span class="muted pcard-desc">${project.description ?? t('home.noDescription')}</span>
    <span class="pcard-spend"><span class="faint">${t('spend.today')}</span><span class="mono">${spentText(project.dayMicros, project.dayLimitMicros)}</span></span>
    <${Bar} pct=${pct} />
    <span class="pcard-foot">
      <span><${Icon} name="activity" size=${14} /><span class="muted">${activity(project)}</span></span>
      <span><${Icon} name="schedules" size=${14} /><span class="muted">${project.next === null ? t('home.noSchedule') : `${when(project.next.at)} · ${project.next.what}`}</span></span>
    </span>
  </a>`
}

/** What waits for you: approvals, loop checks, paused and broken projects. */
export function Attention({ overview, projects, admin, onDone, limit }: { overview: Overview; projects: readonly ProjectCard[]; admin: boolean; onDone: () => void; limit?: number }): VNode | null {
  const cards: VNode[] = [
    ...overview.checkpoints.map((checkpoint) => html`<${CheckpointItem} key=${`c-${checkpoint.runId}`} checkpoint=${checkpoint} onDone=${onDone} />`),
    ...overview.approvals.map((approval) => html`<${ApprovalItem} key=${`a-${approval.id}`} approval=${approval} admin=${admin} onDone=${onDone} />`),
    ...projects
      .filter((project) => project.status === 'paused' || project.invalid !== null)
      .map((project) => html`<div key=${`p-${project.id}`} class="panel att">
        <div class="cluster"><${StateChip} state=${project.invalid !== null ? 'broken' : 'paused'} label=${project.invalid !== null ? t('state.invalid') : t('attention.budget')} /><span class="mono faint">${project.id}</span></div>
        <b>${project.invalid !== null ? t('attention.invalidTitle') : t('attention.pausedTitle')}</b>
        ${project.invalid !== null ? html`<p class="help">${project.invalid}</p>` : html`<p class="help">${t('attention.pausedText', { spent: spentText(project.dayMicros, project.dayLimitMicros) })}</p>`}
        <div class="cluster"><a class="btn sm primary" href=${href({ name: 'project', id: project.id, tab: 'settings', sec: project.invalid !== null ? 'advanced' : 'budget' })}>${project.invalid !== null ? t('attention.fix') : t('attention.raise')}</a></div>
      </div>`),
  ]
  if (cards.length === 0) return null
  const shown = limit === undefined ? cards : cards.slice(0, limit)
  return html`<section aria-label=${t('attention.title')} class="stack" style="gap:10px">
    <div class="cluster"><p class="lbl warn">${t('attention.title')}</p>${limit !== undefined && cards.length > limit ? html`<a class="faint" href="#/inbox" style="font-size:12.5px">${t('attention.more', { count: cards.length - limit })}</a>` : null}</div>
    <div class="att-grid">${shown}</div>
  </section>`
}

/** One approval: what the agent wants, and the answers. */
export function ApprovalItem({ approval, admin, onDone }: { approval: Overview['approvals'][number]; admin: boolean; onDone: () => void }): VNode {
  const [busy, setBusy] = useState(false)
  const answer = async (value: string, said: string): Promise<void> => {
    setBusy(true)
    const result = await post(`/api/approvals/${encodeURIComponent(approval.id)}`, { value })
    setBusy(false)
    toast(result.ok ? said : t('approvals.gone'), !result.ok)
    onDone()
  }
  const kind = t(`approvalKind.${approval.kind}`) === `approvalKind.${approval.kind}` ? t('approvalKind.other') : t(`approvalKind.${approval.kind}`)
  return html`<div class="panel att">
    <div class="cluster"><${StateChip} state="waiting" label=${t('attention.approval')} /><span class="mono faint">${approval.projectId ?? t('home.task')}</span><span class="faint" style="margin-left:auto;font-size:12px">${when(approval.at)}</span></div>
    <b>${kind}</b>
    <code class="action">${approval.action}</code>
    ${approval.detail === null ? null : html`<pre class="mono output" style="max-height:16rem">${approval.detail}</pre>`}
    <div class="cluster">
      <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => void answer('approve', t('approvals.approved'))}>${t('approvals.approve')}</button>
      <button type="button" class="btn sm danger" disabled=${busy} onClick=${() => void answer('deny', t('approvals.denied'))}>${t('approvals.deny')}</button>
      ${approval.detail === null ? html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => void answer('approve-all', t('approvals.approved'))}>${t('approvals.approveAll')}</button>` : null}
      ${admin && approval.always !== null && approval.projectId !== null
        ? html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => void answer('always', t('approvals.alwaysDone', { rule: approval.always ?? '', project: approval.projectId ?? '' }))}>${t('approvals.always', { rule: (approval.always ?? '').length > 32 ? `${(approval.always ?? '').slice(0, 31)}…` : approval.always ?? '', project: approval.projectId })}</button>`
        : null}
    </div>
  </div>`
}

/** A run the loop checker stopped to ask about. */
export function CheckpointItem({ checkpoint, onDone }: { checkpoint: Overview['checkpoints'][number]; onDone: () => void }): VNode {
  const [busy, setBusy] = useState(false)
  const answer = async (value: string): Promise<void> => {
    setBusy(true)
    const result = await post(`/api/checkpoints/${encodeURIComponent(checkpoint.runId)}`, { value })
    setBusy(false)
    toast(result.ok ? (value === 'continue' ? t('checkpoint.continued') : t('checkpoint.stopped')) : t('approvals.gone'), !result.ok)
    onDone()
  }
  return html`<div class="panel att">
    <div class="cluster"><${StateChip} state="waiting" label=${t('checkpoint.title')} /><span class="mono faint">${checkpoint.who}</span><span class="faint" style="margin-left:auto;font-size:12px">${when(checkpoint.at)}</span></div>
    <b>${t('checkpoint.text', { steps: checkpoint.steps, reason: '' }).replace(/[:\s]+$/, '')}</b>
    <p class="help">${checkpoint.reason}</p>
    <div class="cluster">
      <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => void answer('continue')}>${t('checkpoint.continue')}</button>
      <button type="button" class="btn sm danger" disabled=${busy} onClick=${() => void answer('stop')}>${t('checkpoint.stop')}</button>
    </div>
  </div>`
}

/** Ask for something: in a project's conversation, or a one-off task. */
function AskBox({ projects, run, can }: { projects: readonly ProjectCard[]; run: (line: string) => void; can: (name: string) => boolean }): VNode | null {
  const [where, setWhere] = useState('')
  const [text, setText] = useState('')
  if (!can('task') && projects.length === 0) return null
  const send = (): void => {
    const value = text.trim()
    if (value.length === 0) return
    setText('')
    if (where === '') run(`/task ${value}`)
    else {
      try {
        sessionStorage.setItem(`argus.draft.${where}`, value)
      } catch {
        // The draft is lost; the conversation opens all the same.
      }
      go({ name: 'project', id: where, tab: 'chat', sec: '' })
    }
  }
  return html`<section class="panel corners pad stack" style="gap:12px">
    <div class="cluster" style="gap:12px">
      <h2 style="font-size:17px">${t('ask.title')}</h2>
      <label for="ask-where" class="faint" style="font-size:13px">${t('ask.where')}</label>
      <select id="ask-where" value=${where} onChange=${(event: Event) => setWhere((event.target as HTMLSelectElement).value)}>
        ${can('task') ? html`<option value="">${t('ask.noProject')}</option>` : null}
        ${projects.filter((project) => project.invalid === null).map((project) => html`<option value=${project.id}>${project.id}</option>`)}
      </select>
      <span class="faint" style="font-size:12.5px">${where === '' ? t('ask.noProjectHint') : t('ask.projectHint', { project: where })}</span>
    </div>
    <div class="cluster" style="align-items:flex-end;gap:10px">
      <label for="ask-text" class="sr">${t('ask.title')}</label>
      <textarea id="ask-text" class="in" rows="2" style="flex:1 1 360px" placeholder=${where === '' ? t('ask.placeholderTask') : t('ask.placeholderProject')} value=${text}
        onInput=${(event: Event) => setText((event.target as HTMLTextAreaElement).value)}
        onKeyDown=${(event: KeyboardEvent) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send() } }}></textarea>
      <button type="button" class="btn primary" onClick=${send}>${t('ask.send')}</button>
    </div>
  </section>`
}

/** The new-project dialog: a name, what it is for, a template. */
export function NewProject({ version, onClose, onCreated }: { version: number; onClose: () => void; onCreated: () => void }): VNode {
  const templates = useData<{ templates: Array<{ name: string; summary: string }> }>('/api/templates', version)
  const [id, setId] = useState('')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState('')
  const valid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const create = async (event: Event): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const made = await command(['/new', id, template].filter((part) => part.length > 0).join(' '))
    if (made.error) {
      setBusy(false)
      setError(made.text)
      return
    }
    if (description.trim().length > 0) {
      const described = await command(`/set ${id} description ${JSON.stringify(description.trim())}`)
      if (described.error) toast(described.text, true)
    }
    toast(t('newProject.created', { id }))
    onClose()
    onCreated()
    go({ name: 'project', id, tab: 'chat', sec: '' })
  }
  const choices = [{ name: '', summary: t('newProject.blank') }, ...(templates?.templates ?? [])]
  return html`<${Modal} title=${t('projects.new')} onClose=${onClose} wide=${true}>
    <form class="stack" onSubmit=${(event: Event) => void create(event)}>
      ${error === undefined ? null : html`<div class="callout err" role="alert">${error}</div>`}
      <div class="field"><label for="np-id">${t('newProject.id')}</label>
        <input id="np-id" class="mono" required pattern="[a-z0-9][a-z0-9-]{0,62}" placeholder="site-firma" value=${id} onInput=${(event: Event) => setId((event.target as HTMLInputElement).value.toLowerCase())} />
        <p class="help">${t('newProject.idHint')}</p></div>
      <div class="field"><label for="np-desc">${t('newProject.description')}</label>
        <input id="np-desc" placeholder=${t('newProject.descriptionPlaceholder')} value=${description} onInput=${(event: Event) => setDescription((event.target as HTMLInputElement).value)} /></div>
      <div class="field"><span style="font-size:13px;font-weight:600">${t('newProject.template')}</span>
        <div class="choices">${choices.map((choice) => html`<button type="button" class="choice" aria-pressed=${template === choice.name ? 'true' : 'false'} onClick=${() => setTemplate(choice.name)}>
          <span class="radio" aria-hidden="true"></span><span><b>${choice.name === '' ? t('newProject.blankName') : choice.name}</b><br /><span class="muted" style="font-size:12.5px">${choice.summary}</span></span>
        </button>`)}</div>
      </div>
      <div class="cluster" style="justify-content:flex-end"><button type="button" class="btn" onClick=${onClose}>${t('common.cancel')}</button><button type="submit" class="btn primary" disabled=${!valid || busy}>${t('projects.create')}</button></div>
    </form>
  <//>`
}

/** The start page. */
export function HomeView({ version, run, can, overview, admin, refresh }: PageProps & { overview: Overview | undefined; admin: boolean; refresh: () => void }): VNode {
  const data = useData<{ projects: ProjectCard[] }>('/api/projects', version)
  const [creating, setCreating] = useState(false)
  if (data === undefined || data === null || overview === undefined) return html`<p class="empty">${t('common.loading')}</p>`
  const projects = [...data.projects].sort((a, b) => stateOf(a).rank - stateOf(b).rank || a.id.localeCompare(b.id))
  const working = projects.filter((project) => project.running).length
  const waiting = overview.approvals.length + overview.checkpoints.length
  const sub = [t('home.count', { count: projects.length }), working > 0 ? t('home.workingCount', { count: working }) : null, waiting > 0 ? t('home.waitingCount', { count: waiting }) : null].filter((part) => part !== null).join(' · ')
  return html`
    <${PageHead} title=${t('nav.projects')} sub=${sub}>
      <div class="spend-mini"><span class="faint">${t('spend.today')}</span><span class="mono">${spentText(overview.spend.dayMicros, overview.spend.dayLimitMicros)}</span>
        <${Bar} pct=${overview.spend.dayLimitMicros === null || overview.spend.dayLimitMicros === 0 ? 0 : (overview.spend.dayMicros / overview.spend.dayLimitMicros) * 100} /></div>
      ${can('new') ? html`<button type="button" class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" size=${16} />${t('projects.new')}</button>` : null}
    <//>
    <${Attention} overview=${overview} projects=${projects} admin=${admin} onDone=${refresh} limit=${3} />
    <${AskBox} projects=${projects} run=${run} can=${can} />
    ${projects.length === 0
      ? html`<div class="panel corners pad empty-state"><${Icon} name="projects" size=${36} /><h2>${t('home.emptyTitle')}</h2><p class="muted">${t('home.emptyText')}</p>
          ${can('new') ? html`<button type="button" class="btn primary" onClick=${() => setCreating(true)}>${t('projects.new')}</button>` : null}</div>`
      : html`<section class="pgrid" aria-label=${t('nav.projects')}>
          ${projects.map((project) => html`<${Card} key=${project.id} project=${project} />`)}
          ${can('new') ? html`<button type="button" class="pcard pcard-new" onClick=${() => setCreating(true)}><${Icon} name="plus" size=${28} /><b>${t('projects.new')}</b><span class="faint" style="font-size:12.5px">${t('home.newHint')}</span></button>` : null}
        </section>`}
    ${creating ? html`<${NewProject} version=${version} onClose=${() => setCreating(false)} onCreated=${refresh} />` : null}`
}
