// == ARGUS AGENT PROJECT ==
/** The inbox: everything waiting for a decision, from every project, oldest first. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useState } from 'preact/hooks'
import { t } from '../i18n.js'
import { Icon, PageHead, Seg } from '../kit.js'
import { useData, type PageProps } from '../ui.js'
import { ApprovalItem, Attention, CheckpointItem, type ProjectCard } from './home.js'
import type { Overview } from './legacy.js'

type Filter = 'all' | 'approvals' | 'loops' | 'alerts'

export function InboxView({ version, overview, admin, refresh }: PageProps & { overview: Overview | undefined; admin: boolean; refresh: () => void }): VNode {
  const data = useData<{ projects: ProjectCard[] }>('/api/projects', version)
  const [filter, setFilter] = useState<Filter>('all')
  if (overview === undefined || data === undefined || data === null) return html`<p class="empty">${t('common.loading')}</p>`
  const approvals = [...overview.approvals].sort((a, b) => a.at - b.at)
  const loops = [...overview.checkpoints].sort((a, b) => a.at - b.at)
  const alerts = data.projects.filter((project) => project.status === 'paused' || project.invalid !== null)
  const counts = { all: approvals.length + loops.length + alerts.length, approvals: approvals.length, loops: loops.length, alerts: alerts.length }
  const show = (kind: Filter): boolean => filter === 'all' || filter === kind
  return html`
    <${PageHead} title=${t('nav.inbox')} sub=${t('inbox.sub')} />
    <${Seg} label=${t('inbox.filter')} value=${filter} onChange=${setFilter}
      options=${(['all', 'approvals', 'loops', 'alerts'] as const).map((value) => ({ value, label: `${t(`inbox.${value}`)} · ${counts[value]}` }))} />
    ${counts[filter] === 0
      ? html`<div class="panel corners pad empty-state"><span class="ok"><${Icon} name="check" size=${40} /></span><h2>${t('inbox.emptyTitle')}</h2><p class="muted">${t('inbox.emptyText')}</p></div>`
      : html`<div class="stack" style="gap:12px">
          ${show('loops') ? loops.map((checkpoint) => html`<${CheckpointItem} key=${checkpoint.runId} checkpoint=${checkpoint} onDone=${refresh} />`) : null}
          ${show('approvals') ? approvals.map((approval) => html`<${ApprovalItem} key=${approval.id} approval=${approval} admin=${admin} onDone=${refresh} />`) : null}
          ${show('alerts') ? html`<${Attention} overview=${{ ...overview, approvals: [], checkpoints: [] }} projects=${alerts} admin=${admin} onDone=${refresh} />` : null}
        </div>`}`
}
