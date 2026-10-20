// == ARGUS AGENT PROJECT ==
/** The Projects page and a project's own page. Every change is a chat command. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { clock, money, since, t } from '../i18n.js'
import { CommandText, Field, useData, type PageProps } from '../ui.js'

interface ProjectRow {
  id: string
  description: string | null
  status: string
  model: string
  running: boolean
  waiting: boolean
  invalid: string | null
  dayMicros: number
  monthMicros: number
  dayLimitMicros: number | null
  monthLimitMicros: number | null
}

export interface RunView {
  runId: string
  who: string
  status: string
  model: string
  steps: number
  startedAt: number
  endedAt: number | null
  micros: number
  stopReason: string | null
}

interface ProjectDetail extends ProjectRow {
  tools: (Record<string, string> & { web_hosts: string[] }) | null
  mcp: Array<{ name: string; access: string }>
  instructions: string | null
  runs: RunView[]
  approvals: Array<{ id: string }>
  schedules: Array<{ id: string; cron: string; what: string; enabled: boolean; next: number }>
}

const GROUPS = ['read', 'write', 'shell', 'web', 'agents', 'git', 'other'] as const

/** Spent of a limit, or just spent. */
function spent(micros: number, limit: number | null): string {
  return limit === null ? money(micros) : `${money(micros)} / ${money(limit)}`
}

/** A project's state, as a word. */
function State({ project }: { project: ProjectRow }): VNode {
  const state = project.invalid !== null ? 'invalid' : project.running ? 'running' : project.waiting ? 'waiting' : project.status === 'paused' ? 'paused' : 'idle'
  return html`<span class=${`state ${state}`} title=${project.invalid ?? ''}>${t(`state.${state}`)}</span>`
}

/** A table of runs; shared with the Tasks and Runs pages. */
export function RunsTable({ runs, now }: { runs: RunView[]; now: number }): VNode {
  if (runs.length === 0) return html`<p class="empty">${t('runs.noneYet')}</p>`
  return html`<div class="scroll"><table>
    <thead><tr><th scope="col" class="lbl">${t('runs.who')}</th><th scope="col" class="lbl">${t('runs.started')}</th><th scope="col" class="lbl">${t('runs.status')}</th><th scope="col" class="lbl">${t('runs.model')}</th><th scope="col" class="lbl num">${t('runs.steps')}</th><th scope="col" class="lbl num">${t('runs.time')}</th><th scope="col" class="lbl num">${t('runs.cost')}</th></tr></thead>
    <tbody>${runs.map(
      (run) => html`<tr>
        <td>${run.who}</td><td class="muted">${clock(run.startedAt)}</td>
        <td title=${run.stopReason ?? ''}>${run.status}${run.stopReason === null ? '' : html`<br /><span class="faint">${run.stopReason}</span>`}</td>
        <td class="muted">${run.model}</td><td class="num">${run.steps}</td>
        <td class="num">${since(run.startedAt, run.endedAt ?? now)}</td><td class="num">${money(run.micros)}</td>
      </tr>`,
    )}</tbody></table></div>`
}

/** A form for a new project, from a template. */
export function NewProjectForm({ version, run }: Pick<PageProps, 'version' | 'run'>): VNode {
  const templates = useData<{ templates: Array<{ name: string; summary: string }> }>('/api/templates', version)
  const [id, setId] = useState('')
  const [template, setTemplate] = useState('')
  const [model, setModel] = useState('')
  const create = (event: Event): void => {
    event.preventDefault()
    if (id.trim().length === 0) return
    run(['/new', id.trim(), template, model.trim()].filter((part) => part.length > 0).join(' '))
  }
  return html`<form class="inline" onSubmit=${create}>
    <${Field} id="n-id" label=${t('projects.id')} value=${id} onInput=${setId} placeholder="site-firma" />
    <div class="field" style="flex:1 1 200px"><label class="lbl" for="n-template">${t('projects.template')}</label>
      <select id="n-template" value=${template} onChange=${(event: Event) => setTemplate((event.target as HTMLSelectElement).value)}>
        <option value="">${t('projects.noTemplate')}</option>
        ${(templates?.templates ?? []).map((entry) => html`<option value=${entry.name}>${entry.name} — ${entry.summary}</option>`)}
      </select></div>
    <${Field} id="n-model" label=${t('projects.modelOptional')} value=${model} onInput=${setModel} placeholder=${t('settings.model')} />
    <button class="btn primary" type="submit">${t('projects.create')}</button>
  </form>`
}

/** Every project, and a form for a new one. */
export function ProjectsView({ version, run, outcome, can }: PageProps): VNode {
  const data = useData<{ projects: ProjectRow[] }>('/api/projects', version)
  return html`
    ${outcome}
    <section class="hud">
      <h2>${t('projects.title')}</h2>
      ${data === undefined || data === null
        ? html`<p class="empty">${t('common.loading')}</p>`
        : data.projects.length === 0
          ? html`<p class="empty">${t('projects.none')}</p>`
          : html`<div class="scroll"><table>
              <thead><tr><th scope="col" class="lbl">${t('settings.project')}</th><th scope="col" class="lbl">${t('projects.state')}</th><th scope="col" class="lbl">${t('runs.model')}</th><th scope="col" class="lbl num">${t('spend.today')}</th><th scope="col" class="lbl num">${t('spend.month')}</th></tr></thead>
              <tbody>${data.projects.map(
                (project) => html`<tr>
                  <td><a class="link" href=${`#projects/${encodeURIComponent(project.id)}`}>${project.id}</a>${project.description === null ? null : html`<br /><span class="faint">${project.description}</span>`}</td>
                  <td><${State} project=${project} /></td>
                  <td class="muted">${project.model}</td>
                  <td class="num">${spent(project.dayMicros, project.dayLimitMicros)}</td>
                  <td class="num">${spent(project.monthMicros, project.monthLimitMicros)}</td>
                </tr>`,
              )}</tbody></table></div>`}
    </section>
    ${can('new')
      ? html`<section class="hud">
          <h2>${t('projects.new')}</h2>
          <p class="muted" style="margin:0">${t('projects.newHint')}</p>
          <${NewProjectForm} version=${version} run=${run} />
        </section>`
      : null}`
}

/** One project's page. */
export function ProjectView({ id, version, run, outcome, can }: PageProps & { id: string }): VNode {
  const project = useData<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`, version)
  if (project === undefined) return html`<p class="empty">${t('common.loading')}</p>`
  if (project === null) return html`<section class="hud"><p>${t('projects.missing', { id })}</p><a class="link" href="#projects">${t('projects.back')}</a></section>`
  return html`
    ${outcome}
    <section class="hud">
      <div class="head"><h2>${project.id}</h2><${State} project=${project} /></div>
      ${project.description === null ? null : html`<p class="muted" style="margin:0">${project.description}</p>`}
      ${project.invalid === null ? null : html`<div class="notice err">${project.invalid}</div>`}
      ${project.approvals.length === 0 ? null : html`<a class="link" href="#approvals">${t('approvals.pending', { count: project.approvals.length })}</a>`}
      <div class="btns">
        ${can('stop') ? html`<button class="btn ghost" type="button" onClick=${() => run(`/stop ${id}`)}>${t('runs.stop')}</button>` : null}
        ${can('reset') ? html`<button class="btn ghost" type="button" onClick=${() => run(`/reset ${id}`)}>${t('projects.reset')}</button>` : null}
        ${can('archive') ? html`<button class="btn danger" type="button" onClick=${() => run(`/archive ${id}`)}>${t('projects.archive')}</button>` : null}
      </div>
      <${CommandText} line=${`/status ${id}`} version=${version} />
    </section>
    <div class="row">
      <${Money} project=${project} run=${run} can=${can} />
      <${Model} project=${project} run=${run} can=${can} />
    </div>
    ${project.tools === null ? null : html`<${Tools} project=${project} run=${run} can=${can} />`}
    <section class="hud"><h2>${t('costs.runs')}</h2><${RunsTable} runs=${project.runs} now=${Date.now()} /></section>
    ${project.schedules.length === 0
      ? null
      : html`<section class="hud"><h2>${t('schedule.list')}</h2>
          <ul class="plain">${project.schedules.map((row) => html`<li><span class="mono">${row.cron}</span> · ${row.what}${row.enabled ? html` · <span style="color:var(--cyan)">${clock(row.next)}</span>` : html` · <span class="faint">${t('schedule.disabled')}</span>`}</li>`)}</ul>
          <a class="link" href="#schedules">${t('schedule.manage')}</a></section>`}
    <${Instructions} project=${project} run=${run} can=${can} />
    <${Undo} id=${id} version=${version} run=${run} can=${can} />
    <${Extensions} id=${id} version=${version} run=${run} can=${can} />
    <${Git} id=${id} version=${version} run=${run} can=${can} />
    <${Memory} id=${id} version=${version} run=${run} can=${can} />
    <${Files} id=${id} version=${version} run=${run} />`
}

function Money({ project, run, can }: { project: ProjectDetail; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const [period, setPeriod] = useState('day')
  const [usd, setUsd] = useState('')
  return html`<section class="hud grow1">
    <h2>${t('projects.budget')}</h2>
    <div class="row" style="gap:24px">
      <div><div class="lbl">${t('spend.today')}</div><div class="mono">${spent(project.dayMicros, project.dayLimitMicros)}</div></div>
      <div><div class="lbl">${t('spend.month')}</div><div class="mono">${spent(project.monthMicros, project.monthLimitMicros)}</div></div>
    </div>
    ${can('budget')
      ? html`<form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); if (usd.trim().length > 0) run(`/budget ${project.id} set ${period} ${usd.trim()}`) }}>
          <div class="field"><label class="lbl" for="b-period">${t('projects.period')}</label>
            <select id="b-period" value=${period} onChange=${(event: Event) => setPeriod((event.target as HTMLSelectElement).value)}><option value="day">${t('projects.day')}</option><option value="month">${t('projects.month')}</option></select></div>
          <${Field} id="b-usd" label=${t('projects.limitUsd')} value=${usd} onInput=${setUsd} placeholder="5" grow="1 1 100px" />
          <button class="btn ghost" type="submit">${t('settings.save')}</button>
        </form>`
      : null}
  </section>`
}

function Model({ project, run, can }: { project: ProjectDetail; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const [model, setModel] = useState(project.model)
  return html`<section class="hud grow1">
    <h2>${t('runs.model')}</h2>
    ${can('model')
      ? html`<form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); if (model.trim() !== project.model) run(`/model ${project.id} ${model.trim()}`) }}>
          <${Field} id="m-model" label=${t('settings.model')} value=${model} onInput=${setModel} grow="1 1 220px" />
          <button class="btn ghost" type="submit">${t('settings.save')}</button>
        </form>`
      : html`<div class="mono">${project.model}</div>`}
  </section>`
}

function Tools({ project, run, can }: { project: ProjectDetail; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const tools = project.tools as NonNullable<ProjectDetail['tools']>
  const editable = can('set')
  return html`<section class="hud">
    <h2>${t('settings.tools')}</h2>
    <p class="muted" style="margin:0">${t('settings.toolsHint')}</p>
    <div class="row" style="gap:14px">
      ${GROUPS.map(
        (group) => html`<div class="field"><label class="lbl" for=${`pt-${group}`}>${t(`tools.${group}`)}</label>
          <select id=${`pt-${group}`} disabled=${!editable} value=${tools[group]} onChange=${(event: Event) => run(`/set ${project.id} tools.${group} ${(event.target as HTMLSelectElement).value}`)}>
            ${(group === 'other' ? ['deny', 'ask', 'allow'] : ['off', 'deny', 'ask', 'allow']).map((value) => html`<option value=${value}>${value}</option>`)}
          </select></div>`,
      )}
      ${project.mcp.map(
        (server) => html`<div class="field"><label class="lbl" for=${`pm-${server.name}`}>${t('settings.mcp', { name: server.name })}</label>
          <select id=${`pm-${server.name}`} disabled=${!editable} value=${server.access} onChange=${(event: Event) => run(`/set ${project.id} mcp.${server.name}.access ${(event.target as HTMLSelectElement).value}`)}>
            ${['deny', 'ask', 'allow'].map((value) => html`<option value=${value}>${value}</option>`)}
          </select></div>`,
      )}
    </div>
    ${tools.web_hosts.length === 0 ? null : html`<p class="muted" style="margin:0">${t('projects.webHosts', { hosts: tools.web_hosts.join(', ') })}</p>`}
  </section>`
}

function Instructions({ project, run, can }: { project: ProjectDetail; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const [text, setText] = useState(project.instructions ?? '')
  const editable = can('instructions')
  return html`<section class="hud">
    <h2>${t('settings.instructions')}</h2>
    <p class="muted" style="margin:0">${t('settings.instructionsHint')}</p>
    <form style="display:flex;flex-direction:column;gap:10px" onSubmit=${(event: Event) => { event.preventDefault(); run(`/instructions ${project.id} ${text.trim() || 'clear'}`) }}>
      <label class="sr" for="pi-text">${t('settings.instructions')}</label>
      <textarea id="pi-text" rows="8" class="mono" readonly=${!editable} style="padding:10px;min-height:160px" value=${text} onInput=${(event: Event) => setText((event.target as HTMLTextAreaElement).value)}></textarea>
      ${editable ? html`<div><button class="btn ghost" type="submit">${t('settings.save')}</button></div>` : null}
    </form>
  </section>`
}

function Undo({ id, version, run, can }: { id: string; version: number; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const [which, setWhich] = useState('')
  return html`<section class="hud">
    <h2>${t('projects.undo')}</h2>
    <${CommandText} line=${`/undo ${id} list`} version=${version} />
    ${can('undo')
      ? html`<form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); run(`/undo ${id}${which.trim().length === 0 ? '' : ` ${which.trim()}`}`) }}>
          <${Field} id="u-which" label=${t('projects.undoWhich')} value=${which} onInput=${setWhich} placeholder="1" grow="0 1 120px" />
          <button class="btn ghost" type="submit">${t('projects.undoRun')}</button>
        </form>`
      : null}
  </section>`
}

function Extensions({ id, version, run, can }: { id: string; version: number; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const [name, setName] = useState('')
  const act = (action: string) => {
    if (name.trim().length > 0) run(`/ext ${action} ${id} ${name.trim()}`)
  }
  return html`<section class="hud">
    <h2>${t('projects.extensions')}</h2>
    <${CommandText} line="/ext" version=${version} />
    ${can('ext-confirm')
      ? html`<form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); act('enable') }}>
          <${Field} id="x-name" label=${t('projects.extensionName')} value=${name} onInput=${setName} placeholder="office" grow="1 1 200px" />
          <button class="btn ghost" type="submit">${t('projects.extensionEnable')}</button>
          <button class="btn ghost" type="button" onClick=${() => act('disable')}>${t('projects.extensionDisable')}</button>
        </form>`
      : null}
  </section>`
}

function Git({ id, version, run, can }: { id: string; version: number; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const [remote, setRemote] = useState('origin')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const name = remote.trim() || 'origin'
  return html`<section class="hud">
    <h2>${t('projects.git')}</h2>
    <p class="muted" style="margin:0">${t('projects.gitHint')}</p>
    <${CommandText} line=${`/git ${id}`} version=${version} />
    ${can('key')
      ? html`<form class="inline" autocomplete="off" onSubmit=${(event: Event) => { event.preventDefault(); if (url.trim().length > 0) run(`/git remote ${id} ${name} ${url.trim()}`) }}>
          <${Field} id="g-remote" label=${t('projects.gitRemote')} value=${remote} onInput=${setRemote} grow="0 1 120px" />
          <${Field} id="g-url" label=${t('projects.gitUrl')} value=${url} onInput=${setUrl} placeholder="https://github.com/owner/repo.git" grow="1 1 260px" />
          <button class="btn ghost" type="submit">${t('settings.save')}</button>
        </form>
        <form class="inline" autocomplete="off" onSubmit=${(event: Event) => { event.preventDefault(); if (token.trim().length > 0) { run(`/git token ${id} ${name} ${token.trim()}`); setToken('') } }}>
          <${Field} id="g-token" type="password" label=${t('projects.gitToken', { remote: name })} value=${token} onInput=${setToken} grow="1 1 260px" />
          <button class="btn ghost" type="submit">${t('settings.save')}</button>
          <button class="btn ghost" type="button" onClick=${() => run(`/git forget ${id} ${name}`)}>${t('projects.gitForget')}</button>
          <button class="btn danger" type="button" onClick=${() => run(`/git remove ${id} ${name}`)}>${t('projects.gitRemove')}</button>
        </form>`
      : null}
  </section>`
}

function Memory({ id, version, run, can }: { id: string; version: number; run: (line: string) => void; can: (name: string) => boolean }): VNode {
  const [section, setSection] = useState('')
  return html`<section class="hud">
    <h2>${t('projects.memory')}</h2>
    <${CommandText} line=${`/memory ${id}`} version=${version} />
    ${can('forget')
      ? html`<form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); if (section.trim().length > 0) run(`/forget ${id} ${section.trim()}`) }}>
          <${Field} id="f-section" label=${t('projects.forgetSection')} value=${section} onInput=${setSection} grow="1 1 240px" />
          <button class="btn danger" type="submit">${t('projects.forget')}</button>
        </form>`
      : null}
  </section>`
}

function Files({ id, version, run }: { id: string; version: number; run: (line: string) => void }): VNode {
  const [folder, setFolder] = useState('')
  const [shown, setShown] = useState('')
  const [path, setPath] = useState('')
  return html`<section class="hud">
    <h2>${t('projects.files')}</h2>
    <form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); setShown(folder.trim()) }}>
      <${Field} id="fl-folder" label=${t('projects.folder')} value=${folder} onInput=${setFolder} grow="1 1 220px" />
      <button class="btn ghost" type="submit">${t('projects.show')}</button>
    </form>
    <${CommandText} line=${`/files ${id}${shown.length === 0 ? '' : ` ${shown}`}`} version=${version} />
    <form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); if (path.trim().length > 0) run(`/get ${id} ${path.trim()}`) }}>
      <${Field} id="fl-path" label=${t('projects.path')} value=${path} onInput=${setPath} placeholder="reports/summary.md" grow="1 1 260px" />
      <button class="btn ghost" type="submit">${t('projects.download')}</button>
    </form>
  </section>`
}
