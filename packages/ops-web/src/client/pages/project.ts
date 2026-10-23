// == ARGUS AGENT PROJECT ==
/**
 * A project's space: its conversation, its schedules, its files, its activity and its
 * settings, under a header that says what it is doing and how much it spent today.
 */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { upload } from '../api.js'
import { money, since, t } from '../i18n.js'
import { Bar, Icon, Seg, StateChip, Toggle, toast } from '../kit.js'
import { href } from '../router.js'
import { useData, type PageProps } from '../ui.js'
import { spentText, stateOf, when, type ProjectCard } from './home.js'
import type { Overview } from './legacy.js'
import { ProjectView as ProjectSettings } from './projects.js'
import { Thread } from './thread.js'

interface RunView {
  readonly runId: string
  readonly status: string
  readonly model: string
  readonly steps: number
  readonly startedAt: number
  readonly endedAt: number | null
  readonly micros: number
  readonly stopReason: string | null
}

interface ProjectDetail extends ProjectCard {
  readonly runs: readonly RunView[]
}

interface ScheduleView {
  readonly id: string
  readonly cron: string
  readonly projectId: string | null
  readonly prompt: string
  readonly enabled: boolean
  readonly next: number
}

const TABS = ['chat', 'schedules', 'files', 'activity', 'settings'] as const
type Tab = (typeof TABS)[number]

// ── schedules: a cron line from plain choices, and its next runs ──────────

type Frequency = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'

/** The cron line for a plain choice. */
export function cronOf(frequency: Frequency, time: string, weekday: number, monthday: number, custom: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number)
  switch (frequency) {
    case 'hourly':
      return `${m} * * * *`
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekdays':
      return `${m} ${h} * * 1-5`
    case 'weekly':
      return `${m} ${h} * * ${weekday}`
    case 'monthly':
      return `${m} ${h} ${monthday} * *`
    case 'custom':
      return custom.trim()
  }
}

/** The next runs of a plain choice, in the browser's time; none for a custom line. */
export function nextRuns(frequency: Frequency, time: string, weekday: number, monthday: number, from = new Date(), count = 5): Date[] {
  if (frequency === 'custom') return []
  const [h = 0, m = 0] = time.split(':').map(Number)
  const out: Date[] = []
  const at = new Date(from.getTime())
  if (frequency === 'hourly') {
    at.setMinutes(m, 0, 0)
    if (at <= from) at.setHours(at.getHours() + 1)
    while (out.length < count) {
      out.push(new Date(at.getTime()))
      at.setHours(at.getHours() + 1)
    }
    return out
  }
  at.setHours(h, m, 0, 0)
  if (at <= from) at.setDate(at.getDate() + 1)
  for (let guard = 0; out.length < count && guard < 800; guard++) {
    const day = at.getDay()
    const fits =
      frequency === 'daily' || (frequency === 'weekdays' && day > 0 && day < 6) || (frequency === 'weekly' && day === weekday) || (frequency === 'monthly' && at.getDate() === monthday)
    if (fits) out.push(new Date(at.getTime()))
    at.setDate(at.getDate() + 1)
  }
  return out
}

function Schedules({ id, version, run, can }: { id: string; version: number; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const data = useData<{ schedules: ScheduleView[] }>('/api/schedules', version)
  const [what, setWhat] = useState('')
  const [frequency, setFrequency] = useState<Frequency>('weekdays')
  const [time, setTime] = useState('09:00')
  const [weekday, setWeekday] = useState(1)
  const [monthday, setMonthday] = useState(1)
  const [custom, setCustom] = useState('30 8 * * 1-5')
  const mine = (data?.schedules ?? []).filter((row) => row.projectId === id).sort((a, b) => a.next - b.next)
  const cron = cronOf(frequency, time, weekday, monthday, custom)
  const upcoming = nextRuns(frequency, time, weekday, monthday)
  const days = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: new Intl.DateTimeFormat(document.documentElement.lang || 'en', { weekday: 'short' }).format(new Date(2026, 9, 18 + day)) }))
  const summary =
    frequency === 'custom'
      ? t('cron.custom')
      : t(`cron.say.${frequency}`, { time, minute: time.split(':')[1] ?? '00', day: days.find((each) => each.value === String(weekday))?.label ?? '', date: monthday })
  const add = (event: Event): void => {
    event.preventDefault()
    if (what.trim().length === 0 || cron.length === 0) return
    run(`/cron add ${id} "${cron.replace(/"/g, '')}" ${what.trim()}`)
    setWhat('')
  }
  return html`<div class="split">
    <section class="panel" aria-label=${t('schedule.list')} style="flex:1 1 380px;min-width:0">
      ${mine.length === 0 ? html`<p class="empty pad">${t('cron.none')}</p>` : null}
      ${mine.map((row) => html`<div class="ri" key=${row.id}>
        <div style="flex:1 1 200px;min-width:0"><b>${row.prompt}</b>
          <div class="muted mono" style="font-size:12.5px">${row.cron}</div>
          <div class=${row.enabled ? '' : 'faint'} style="font-size:12.5px">${row.enabled ? t('cron.next', { when: when(row.next) }) : t('schedule.disabled')}</div></div>
        ${can('cron') ? html`<button type="button" class="btn sm" onClick=${() => run(`/cron run ${row.id}`)}>${t('schedule.run')}</button>
          <${Toggle} checked=${row.enabled} label=${row.prompt} onChange=${(on: boolean) => run(`/cron ${on ? 'enable' : 'disable'} ${row.id}`)} />
          <button type="button" class="btn sm icon" aria-label=${t('settings.remove')} onClick=${() => run(`/cron remove ${row.id}`)}><${Icon} name="close" size=${14} /></button>` : null}
      </div>`)}
    </section>
    ${can('cron')
      ? html`<form class="panel corners pad stack" style="flex:1 1 420px;min-width:0" onSubmit=${add}>
          <h2>${t('cron.new')}</h2>
          <div class="field"><label for="c-what">${t('cron.what')}</label><textarea id="c-what" class="in" rows="2" placeholder=${t('cron.whatPlaceholder')} value=${what} onInput=${(event: Event) => setWhat((event.target as HTMLTextAreaElement).value)}></textarea></div>
          <div class="field"><span class="flabel">${t('cron.how')}</span>
            <${Seg} label=${t('cron.how')} value=${frequency} onChange=${setFrequency} options=${(['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'] as const).map((value) => ({ value, label: t(`cron.f.${value}`) }))} /></div>
          ${frequency === 'custom'
            ? html`<div class="field"><label for="c-custom">${t('cron.line')}</label><input id="c-custom" class="mono" value=${custom} onInput=${(event: Event) => setCustom((event.target as HTMLInputElement).value)} /><p class="help">${t('cron.lineHint')}</p></div>`
            : html`<div class="cluster" style="gap:14px;align-items:flex-end">
                <div class="field" style="width:150px"><label for="c-time">${frequency === 'hourly' ? t('cron.minute') : t('cron.time')}</label><input id="c-time" type="time" class="mono" value=${time} onInput=${(event: Event) => setTime((event.target as HTMLInputElement).value)} /></div>
                ${frequency === 'weekly' ? html`<div class="field"><span class="flabel">${t('cron.day')}</span><${Seg} label=${t('cron.day')} value=${String(weekday)} onChange=${(value: string) => setWeekday(Number(value))} options=${days} /></div>` : null}
                ${frequency === 'monthly' ? html`<div class="field" style="width:120px"><label for="c-date">${t('cron.date')}</label><input id="c-date" type="number" min="1" max="28" class="mono" value=${monthday} onInput=${(event: Event) => setMonthday(Math.min(28, Math.max(1, Number((event.target as HTMLInputElement).value) || 1)))} /></div>` : null}
              </div>`}
          <div class="callout info" style="flex-direction:column;gap:8px">
            <div class="cluster"><b>${summary}</b><span class="mono faint">${cron}</span></div>
            <div class="cluster" style="gap:6px">${upcoming.length === 0 ? html`<span class="faint">${t('cron.afterSave')}</span>` : upcoming.map((at) => html`<span class="chip" style="color:var(--text)">${when(at.getTime())}</span>`)}</div>
          </div>
          <div class="cluster"><button type="submit" class="btn primary" disabled=${what.trim().length === 0}>${t('cron.save')}</button></div>
        </form>`
      : null}
  </div>`
}

// ── files ──────────────────────────────────────────────────────────────────

interface FolderEntry {
  readonly name: string
  readonly dir: boolean
  readonly size: number
  readonly mtime: number
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`
}

const IMAGES = /\.(png|jpe?g|gif|webp)$/i

function Preview({ id, path }: { id: string; path: string }): VNode {
  const url = `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`
  const [text, setText] = useState<string | null | undefined>()
  const image = IMAGES.test(path)
  const pdf = /\.pdf$/i.test(path)
  useEffect(() => {
    setText(undefined)
    if (image || pdf) return
    void fetch(url, { credentials: 'same-origin' }).then(async (response) => {
      const length = Number(response.headers.get('content-length') ?? '0')
      // Large or binary: offered for download instead.
      if (!response.ok || length > 1_048_576) return setText(null)
      const body = await response.text()
      setText(body.includes('\u0000') ? null : body)
    })
  }, [url])
  return html`<div class="preview">
    <div class="preview-head"><span class="mono" style="flex:1;min-width:0;overflow-wrap:anywhere">${path}</span>
      <a class="btn sm" href=${`${url}&download=1`}>${t('projects.download')}</a></div>
    ${image
      ? html`<div class="pad"><img src=${url} alt=${path} style="max-width:100%;border-radius:8px" /></div>`
      : pdf
        ? html`<iframe src=${url} title=${path} sandbox="" style="width:100%;height:70vh;border:0"></iframe>`
        : text === undefined
          ? html`<p class="empty pad">${t('common.loading')}</p>`
          : text === null
            ? html`<p class="empty pad">${t('files.noPreview')}</p>`
            : html`<pre class="mono file-text">${text}</pre>`}
  </div>`
}

function Files({ id, version }: { id: string; version: number }): VNode {
  const [folder, setFolder] = useState('')
  const [open, setOpen] = useState<string | undefined>()
  const [tick, setTick] = useState(0)
  const [dragging, setDragging] = useState(false)
  const data = useData<{ entries: FolderEntry[]; more: boolean }>(`/api/projects/${encodeURIComponent(id)}/files?path=${encodeURIComponent(folder)}`, version + tick)
  const parts = folder === '' ? [] : folder.split('/')
  const send = async (list: FileList | null | undefined): Promise<void> => {
    for (const file of Array.from(list ?? [])) {
      const outcome = await upload(id, file, () => undefined)
      toast(outcome.ok ? t('projects.uploaded', { path: outcome.path ?? '' }) : t('projects.uploadFailed', { error: outcome.error ?? '' }), !outcome.ok)
    }
    setTick((n) => n + 1)
  }
  return html`<div class="split">
    <section class=${`panel files${dragging ? ' dragging' : ''}`} style="flex:1 1 300px;max-width:420px;min-width:0" aria-label=${t('projects.files')}
      onDragOver=${(event: DragEvent) => { event.preventDefault(); setDragging(true) }} onDragLeave=${() => setDragging(false)}
      onDrop=${(event: DragEvent) => { event.preventDefault(); setDragging(false); void send(event.dataTransfer?.files) }}>
      <div class="drop"><b>${t('files.drop')}</b><span class="faint">${t('files.dropHint')}</span>
        <label class="btn sm">${t('projects.upload')}<input type="file" multiple class="sr" onChange=${(event: Event) => void send((event.target as HTMLInputElement).files)} /></label></div>
      <nav class="crumbs" aria-label=${t('files.path')}>
        <button type="button" onClick=${() => { setFolder(''); setOpen(undefined) }}>${id}</button>
        ${parts.map((part, i) => html`<span class="faint">/</span><button type="button" onClick=${() => { setFolder(parts.slice(0, i + 1).join('/')); setOpen(undefined) }}>${part}</button>`)}
        <a class="btn sm" style="margin-left:auto" href=${`/api/projects/${encodeURIComponent(id)}/zip?path=${encodeURIComponent(folder || '.')}`} download>${t('files.zip')}</a>
      </nav>
      ${data === undefined ? html`<p class="empty pad">${t('common.loading')}</p>` : data === null || data.entries.length === 0 ? html`<p class="empty pad">${t('files.empty')}</p>` : null}
      ${(data?.entries ?? []).map((entry) => {
        const path = folder === '' ? entry.name : `${folder}/${entry.name}`
        return html`<button type="button" class="tree" aria-current=${open === path ? 'true' : undefined} onClick=${() => (entry.dir ? (setFolder(path), setOpen(undefined)) : setOpen(path))}>
          <${Icon} name=${entry.dir ? 'projects' : 'activity'} size=${15} /><span class="tree-name">${entry.name}${entry.dir ? '/' : ''}</span><span class="faint">${entry.dir ? '' : size(entry.size)}</span>
        </button>`
      })}
      ${data?.more === true ? html`<p class="help pad">${t('files.more')}</p>` : null}
    </section>
    <section class="panel" style="flex:999 1 420px;min-width:0" aria-label=${t('files.preview')}>
      ${open === undefined ? html`<p class="empty pad">${t('files.pick')}</p>` : html`<${Preview} key=${open} id=${id} path=${open} />`}
    </section>
  </div>`
}

// ── activity ───────────────────────────────────────────────────────────────

function Activity({ project }: { project: ProjectDetail }): VNode {
  const week = project.runs.filter((run) => Date.now() - run.startedAt < 7 * 86_400_000)
  const max = Math.max(1, ...project.runs.map((run) => run.micros))
  const chip = (run: RunView) => (run.status === 'running' ? 'running' : run.status === 'completed' ? 'ok' : run.status === 'stopped' || run.status === 'cancelled' ? 'paused' : 'broken')
  return html`<div class="stack">
    <div class="tiles">
      <div class="panel tile"><p class="lbl">${t('activity.runs7')}</p><div class="disp tile-v">${week.length}</div></div>
      <div class="panel tile"><p class="lbl">${t('activity.cost7')}</p><div class="disp tile-v">${money(week.reduce((sum, run) => sum + run.micros, 0))}</div></div>
      <div class="panel tile"><p class="lbl">${t('spend.month')}</p><div class="disp tile-v">${spentText(project.monthMicros, project.monthLimitMicros)}</div></div>
    </div>
    <section class="panel" aria-label=${t('costs.runs')}>
      ${project.runs.length === 0 ? html`<p class="empty pad">${t('runs.noneYet')}</p>` : null}
      ${project.runs.map((run) => html`<div class="ri" key=${run.runId}>
        <${StateChip} state=${chip(run)} label=${t(`runStatus.${run.status}`) === `runStatus.${run.status}` ? run.status : t(`runStatus.${run.status}`)} />
        <div style="flex:1 1 220px;min-width:0"><b>${when(run.startedAt)}</b>
          <div class="faint" style="font-size:12.5px">${t('activity.line', { steps: run.steps, time: since(run.startedAt, run.endedAt ?? Date.now()), model: run.model })}${run.stopReason === null ? '' : ` · ${run.stopReason}`}</div></div>
        <div style="width:150px" class="stack-tight"><span class="mono" style="text-align:right">${money(run.micros)}</span><${Bar} pct=${(run.micros / max) * 100} /></div>
      </div>`)}
    </section>
  </div>`
}

// ── the page ───────────────────────────────────────────────────────────────

export function ProjectSpace({ id, tab, version, chatVersion, run, can, overview, outcome }: PageProps & { id: string; tab: string; chatVersion: number; overview: Overview | undefined }): VNode {
  const project = useData<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`, version)
  const current: Tab = (TABS as readonly string[]).includes(tab) ? (tab as Tab) : 'chat'
  const schedules = overview?.schedules.filter((row) => row.who === id && row.enabled).length ?? 0
  const live = useMemo(() => overview?.runs.find((each) => each.who === id), [overview, id])
  if (project === undefined) return html`<p class="empty">${t('common.loading')}</p>`
  if (project === null) return html`<div class="panel pad stack"><p>${t('projects.missing', { id })}</p><a class="link" href="#/">${t('projects.back')}</a></div>`
  const state = stateOf(project)
  const pct = project.dayLimitMicros === null || project.dayLimitMicros === 0 ? 0 : (project.dayMicros / project.dayLimitMicros) * 100
  const tabLabel: Record<Tab, string> = { chat: t('space.chat'), schedules: t('space.schedules'), files: t('space.files'), activity: t('space.activity'), settings: t('space.settings') }
  return html`
    <div class="stack" style="gap:12px">
      <a href="#/" class="back"><${Icon} name="back" size=${14} />${t('space.all')}</a>
      <div class="cluster" style="gap:14px">
        <h1>${project.id}</h1>
        <${StateChip} state=${state.chip} label=${state.label} />
        <span class="chip mono">${project.model}</span>
        <div class="cluster" style="margin-left:auto;gap:12px">
          <div class="spend-mini"><span class="faint">${t('spend.today')}</span><span class="mono">${spentText(project.dayMicros, project.dayLimitMicros)}</span><${Bar} pct=${pct} /></div>
          ${project.running && can('stop') ? html`<button type="button" class="btn sm danger" onClick=${() => run(`/stop ${id}`)}><${Icon} name="stop" size=${14} />${t('runs.stop')}</button>` : null}
        </div>
      </div>
      ${project.description === null ? null : html`<p class="muted">${project.description}</p>`}
      ${project.invalid === null ? null : html`<div class="callout err">${project.invalid}</div>`}
    </div>
    <nav class="tabs" role="tablist" aria-label=${t('space.label')}>
      ${TABS.map((each) => html`<a role="tab" class="tab" aria-selected=${each === current ? 'true' : 'false'} href=${href({ name: 'project', id, tab: each, sec: '' })}>${tabLabel[each]}${each === 'schedules' && schedules > 0 ? html`<span class="chip" style="padding:0 7px;line-height:18px">${schedules}</span>` : null}</a>`)}
    </nav>
    ${current === 'chat'
      ? html`<div class="split">
          <div style="flex:999 1 520px;min-width:0"><${Thread} thread=${`p:${id}`} version=${chatVersion} uploadTo=${id}
            busy=${project.step === null ? null : t('home.working', { step: project.step })} empty=${t('space.empty', { id })} placeholder=${t('space.placeholder', { id })} /></div>
          <aside class="stack" style="flex:1 1 260px;min-width:0">
            <section class="panel corners pad stack" style="gap:12px">
              <div class="cluster"><p class="lbl">${t('space.now')}</p>${live === undefined ? null : html`<span class="live" style="margin-left:auto" aria-hidden="true"><span></span><span></span><span></span><span></span></span>`}</div>
              ${live === undefined
                ? html`<p class="muted">${project.lastRun === null ? t('home.never') : t('space.idle', { when: when(project.lastRun.at) })}</p>`
                : html`<div class="tiles3"><div><div class="faint">${t('runs.steps')}</div><div class="mono big">${live.steps}</div></div><div><div class="faint">${t('runs.time')}</div><div class="mono big">${since(live.startedAt, Date.now())}</div></div><div><div class="faint">${t('runs.cost')}</div><div class="mono big">${money(live.micros)}</div></div></div>
                  ${can('stop') ? html`<button type="button" class="btn sm danger" onClick=${() => run(`/stop ${id}`)}>${t('space.stopRun')}</button>` : null}`}
            </section>
            <section class="panel pad stack" style="gap:8px;font-size:13px">
              <p class="lbl">${t('space.brief')}</p>
              <div class="kv"><span class="faint">${t('space.nextRun')}</span><span>${project.next === null ? '—' : when(project.next.at)}</span></div>
              <div class="kv"><span class="faint">${t('spend.month')}</span><span class="mono">${spentText(project.monthMicros, project.monthLimitMicros)}</span></div>
              <div class="kv"><span class="faint">${t('space.waiting')}</span><span>${project.pending}</span></div>
              <a class="btn sm" href=${href({ name: 'project', id, tab: 'files', sec: '' })}>${t('space.openFiles')}</a>
            </section>
          </aside>
        </div>`
      : null}
    ${current === 'schedules' ? html`<${Schedules} id=${id} version=${version} run=${run} can=${can} />` : null}
    ${current === 'files' ? html`<${Files} id=${id} version=${version} />` : null}
    ${current === 'activity' ? html`<${Activity} project=${project} />` : null}
    ${current === 'settings' ? html`<${ProjectSettings} id=${id} version=${version} run=${run} outcome=${outcome} can=${can} />` : null}`
}
