// == ARGUS AGENT PROJECT ==
/** The new-project form the setup steps show. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { t } from '../i18n.js'
import { Field, useData, type PageProps } from '../ui.js'

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
