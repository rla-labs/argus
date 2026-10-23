// == ARGUS AGENT PROJECT ==
/** What the pages from before 0.7.3 still share: a table of runs, the new-project form. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { clock, money, since, t } from '../i18n.js'
import { Field, useData, type PageProps } from '../ui.js'

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
