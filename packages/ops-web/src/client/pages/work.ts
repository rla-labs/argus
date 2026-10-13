// == ARGUS AGENT PROJECT ==
/** The Tasks, Schedules and Runs & costs pages. Every change is a chat command. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { clock, money, since, t } from '../i18n.js'
import { CommandText, Field, useData, type PageProps } from '../ui.js'
import { RunsTable, type RunView } from './projects.js'

interface TaskView extends RunView {
  text: string | null
  running: boolean
}

interface ScheduleView {
  id: string
  cron: string
  projectId: string | null
  prompt: string
  enabled: boolean
  next: number
  model: string | null
}

interface ScopeSpend {
  scope: string
  dayMicros: number
  monthMicros: number
  dayLimitMicros: number | null
  monthLimitMicros: number | null
}

/** Spent of a limit, or just spent. */
function spent(micros: number, limit: number | null): string {
  return limit === null ? money(micros) : `${money(micros)} / ${money(limit)}`
}

/** A one-off task, its estimate, and the recent tasks with Stop. */
export function TasksView({ version, run, outcome, can }: PageProps): VNode {
  const data = useData<{ tasks: TaskView[] }>('/api/tasks', version)
  const [text, setText] = useState('')
  const [estimate, setEstimate] = useState(0)
  const now = Date.now()
  return html`
    ${outcome}
    ${can('task')
      ? html`<section class="hud">
          <h2>${t('tasks.new')}</h2>
          <p class="muted" style="margin:0">${t('tasks.hint')}</p>
          <form style="display:flex;flex-direction:column;gap:10px" onSubmit=${(event: Event) => { event.preventDefault(); if (text.trim().length > 0) { run(`/task ${text.trim()}`); setText('') } }}>
            <label class="sr" for="t-text">${t('tasks.new')}</label>
            <textarea id="t-text" rows="4" style="padding:10px" placeholder=${t('tasks.placeholder')} value=${text} onInput=${(event: Event) => setText((event.target as HTMLTextAreaElement).value)}></textarea>
            <div class="btns">
              <button class="btn primary" type="submit">${t('tasks.run')}</button>
              <button class="btn ghost" type="button" onClick=${() => setEstimate((v) => v + 1)}>${t('tasks.estimate')}</button>
            </div>
          </form>
          ${estimate === 0 ? null : html`<${CommandText} line="/estimate tasks" version=${version + estimate} />`}
        </section>`
      : null}
    <section class="hud">
      <h2>${t('tasks.title')}</h2>
      ${data === undefined || data === null
        ? html`<p class="empty">${t('common.loading')}</p>`
        : data.tasks.length === 0
          ? html`<p class="empty">${t('tasks.none')}</p>`
          : html`<div class="scroll"><table>
              <thead><tr><th scope="col" class="lbl">${t('tasks.what')}</th><th scope="col" class="lbl">${t('runs.started')}</th><th scope="col" class="lbl">${t('runs.status')}</th><th scope="col" class="lbl num">${t('runs.time')}</th><th scope="col" class="lbl num">${t('runs.cost')}</th><th></th></tr></thead>
              <tbody>${data.tasks.map(
                (task) => html`<tr>
                  <td>${task.text ?? '—'}<br /><span class="faint">${task.model}</span></td>
                  <td class="muted">${clock(task.startedAt)}</td>
                  <td>${task.running ? html`<span class="state running">${t('state.running')}</span>` : task.status}${task.stopReason === null ? null : html`<br /><span class="faint">${task.stopReason}</span>`}</td>
                  <td class="num">${since(task.startedAt, task.endedAt ?? now)}</td>
                  <td class="num">${money(task.micros)}</td>
                  <td class="num">${task.running && can('stop') ? html`<button class="btn danger" type="button" onClick=${() => run(`/stop ${task.runId}`)}>${t('runs.stop')}</button>` : null}</td>
                </tr>`,
              )}</tbody></table></div>`}
    </section>`
}

/** Every schedule, with Run, Enable/Disable, Remove, and a form for a new one. */
export function SchedulesView({ version, run, outcome, can }: PageProps): VNode {
  const data = useData<{ schedules: ScheduleView[] }>('/api/schedules', version)
  const projects = useData<{ projects: Array<{ id: string }> }>('/api/projects', version)
  const [target, setTarget] = useState('')
  const [cron, setCron] = useState('')
  const [prompt, setPrompt] = useState('')
  const add = (event: Event): void => {
    event.preventDefault()
    if (cron.trim().length === 0 || prompt.trim().length === 0) return
    run(`/cron add ${target.length === 0 ? '' : `${target} `}"${cron.trim().replace(/"/g, '')}" ${prompt.trim()}`)
    setCron('')
    setPrompt('')
  }
  return html`
    ${outcome}
    <section class="hud">
      <h2>${t('schedule.list')}</h2>
      ${data === undefined || data === null
        ? html`<p class="empty">${t('common.loading')}</p>`
        : data.schedules.length === 0
          ? html`<p class="empty">${t('schedule.empty')}</p>`
          : html`<div class="scroll"><table>
              <thead><tr><th scope="col" class="lbl">${t('schedule.when')}</th><th scope="col" class="lbl">${t('schedule.who')}</th><th scope="col" class="lbl">${t('tasks.what')}</th><th scope="col" class="lbl">${t('schedule.next')}</th><th></th></tr></thead>
              <tbody>${data.schedules.map(
                (row) => html`<tr class=${row.enabled ? '' : 'muted'}>
                  <td class="mono">${row.cron}</td>
                  <td>${row.projectId === null ? t('schedule.task') : html`<a class="link" href=${`#projects/${encodeURIComponent(row.projectId)}`}>${row.projectId}</a>`}</td>
                  <td>${row.prompt}${row.model === null ? null : html`<br /><span class="faint">${row.model}</span>`}</td>
                  <td>${row.enabled ? html`<span style="color:var(--cyan)">${clock(row.next)}</span>` : html`<span class="faint">${t('schedule.disabled')}</span>`}</td>
                  <td class="num">${can('cron')
                    ? html`<div class="btns" style="justify-content:flex-end">
                        <button class="btn ghost" type="button" onClick=${() => run(`/cron run ${row.id}`)}>${t('schedule.run')}</button>
                        <button class="btn ghost" type="button" onClick=${() => run(`/cron ${row.enabled ? 'disable' : 'enable'} ${row.id}`)}>${row.enabled ? t('schedule.disable') : t('schedule.enable')}</button>
                        <button class="btn danger" type="button" onClick=${() => run(`/cron remove ${row.id}`)}>${t('settings.remove')}</button>
                      </div>`
                    : null}</td>
                </tr>`,
              )}</tbody></table></div>`}
    </section>
    ${can('cron')
      ? html`<section class="hud">
          <h2>${t('schedule.add')}</h2>
          <p class="muted" style="margin:0">${t('schedule.addHint')}</p>
          <form class="inline" onSubmit=${add}>
            <div class="field" style="flex:1 1 160px"><label class="lbl" for="s-target">${t('schedule.who')}</label>
              <select id="s-target" value=${target} onChange=${(event: Event) => setTarget((event.target as HTMLSelectElement).value)}>
                <option value="">${t('schedule.task')}</option>
                ${(projects?.projects ?? []).map((project) => html`<option value=${project.id}>${project.id}</option>`)}
              </select></div>
            <${Field} id="s-cron" label=${t('schedule.when')} value=${cron} onInput=${setCron} placeholder="0 9 * * 1-5" grow="1 1 140px" />
            <${Field} id="s-prompt" label=${t('tasks.what')} value=${prompt} onInput=${setPrompt} grow="3 1 260px" />
            <button class="btn primary" type="submit">${t('schedule.addButton')}</button>
          </form>
        </section>`
      : null}`
}

/** Spending by scope against its budget, the budgets, the recent runs and the audit log. */
export function RunsView({ version, run, outcome, can }: PageProps): VNode {
  const data = useData<{ now: number; scopes: ScopeSpend[]; runs: RunView[]; log: Array<{ at: number; actor: string; action: string; target: string | null }> }>('/api/runs', version)
  const [scope, setScope] = useState('global')
  const [period, setPeriod] = useState('day')
  const [usd, setUsd] = useState('')
  const name = (scope: string): string => (scope === 'global' ? t('costs.global') : scope === 'adhoc' ? t('costs.adhoc') : scope === 'orchestrator' ? t('costs.frontDesk') : scope.replace(/^project:/, ''))
  if (data === undefined || data === null) return html`<p class="empty">${t('common.loading')}</p>`
  return html`
    ${outcome}
    <section class="hud">
      <h2>${t('costs.title')}</h2>
      <div class="scroll"><table>
        <thead><tr><th scope="col" class="lbl">${t('costs.scope')}</th><th scope="col" class="lbl num">${t('spend.today')}</th><th scope="col" class="lbl num">${t('spend.month')}</th></tr></thead>
        <tbody>${data.scopes.map(
          (row) => html`<tr><td>${name(row.scope)}</td><td class="num">${spent(row.dayMicros, row.dayLimitMicros)}</td><td class="num">${spent(row.monthMicros, row.monthLimitMicros)}</td></tr>`,
        )}</tbody></table></div>
      ${can('budget')
        ? html`<form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); if (usd.trim().length > 0) run(`/budget ${scope.replace(/^project:/, '')} set ${period} ${usd.trim()}`) }}>
            <div class="field"><label class="lbl" for="c-scope">${t('costs.scope')}</label>
              <select id="c-scope" value=${scope} onChange=${(event: Event) => setScope((event.target as HTMLSelectElement).value)}>
                ${data.scopes.filter((row) => row.scope !== 'orchestrator').map((row) => html`<option value=${row.scope}>${name(row.scope)}</option>`)}
              </select></div>
            <div class="field"><label class="lbl" for="c-period">${t('projects.period')}</label>
              <select id="c-period" value=${period} onChange=${(event: Event) => setPeriod((event.target as HTMLSelectElement).value)}><option value="day">${t('projects.day')}</option><option value="month">${t('projects.month')}</option></select></div>
            <${Field} id="c-usd" label=${t('projects.limitUsd')} value=${usd} onInput=${setUsd} placeholder="20" grow="1 1 100px" />
            <button class="btn ghost" type="submit">${t('costs.setLimit')}</button>
          </form>`
        : null}
    </section>
    <section class="hud"><h2>${t('costs.runs')}</h2><${RunsTable} runs=${data.runs} now=${data.now} /></section>
    <section class="hud"><h2>${t('log.title')}</h2>
      <ol class="log">${data.log.map((row) => html`<li><time>${clock(row.at)}</time><span>${row.action}${row.target === null ? '' : ` · ${row.target}`} <span class="faint">${row.actor}</span></span></li>`)}</ol>
    </section>`
}

/** Settings → System: stop everything or resume, health, free models. */
export function SystemSection({ version, run, can, panic }: PageProps & { panic: boolean }): VNode {
  const [model, setModel] = useState('')
  return html`<section class="hud">
    <h2>${t('system.title')}</h2>
    <p class="muted" style="margin:0">${panic ? t('system.panicked') : t('system.panicHint')}</p>
    <div class="btns">
      ${can('panic') && !panic ? html`<button class="btn danger" type="button" onClick=${() => run('/panic')}>${t('system.panic')}</button>` : null}
      ${can('resume-all') && panic ? html`<button class="btn primary" type="button" onClick=${() => run('/resume-all')}>${t('system.resume')}</button>` : null}
    </div>
    ${can('allow-free')
      ? html`<form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); if (model.trim().length > 0) run(`/allow-free ${model.trim()}`) }}>
          <${Field} id="sy-free" label=${t('system.allowFree')} value=${model} onInput=${setModel} placeholder="openrouter/deepseek/deepseek-flash:free" grow="1 1 280px" />
          <button class="btn ghost" type="submit">${t('system.allow')}</button>
        </form>`
      : null}
    <h2>${t('system.health')}</h2>
    <${CommandText} line="/health" version=${version} />
  </section>`
}
