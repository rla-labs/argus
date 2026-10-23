// == ARGUS AGENT PROJECT ==
/** Settings → System health: stop everything or resume, health, free models. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { t } from '../i18n.js'
import { CommandText, Field, type PageProps } from '../ui.js'

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
