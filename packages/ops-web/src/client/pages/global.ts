// == ARGUS AGENT PROJECT ==
/** The Schedules and Costs pages: every project's, in one place. */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { money, since, t } from '../i18n.js'
import { Bar, Icon, PageHead, StateChip, Toggle } from '../kit.js'
import { href } from '../router.js'
import { useData, type PageProps } from '../ui.js'
import { spentText, when } from './home.js'
import type { Overview } from './legacy.js'

interface ScheduleView {
  readonly id: string
  readonly cron: string
  readonly projectId: string | null
  readonly prompt: string
  readonly enabled: boolean
  readonly next: number
  readonly model: string | null
}

/** Every schedule, soonest first, with the next day on a line. */
export function SchedulesPage({ version, run, can }: PageProps): VNode {
  const data = useData<{ schedules: ScheduleView[] }>('/api/schedules', version)
  const now = Date.now()
  const rows = [...(data?.schedules ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.next - b.next)
  const day = rows.filter((row) => row.enabled && row.next - now < 86_400_000 && row.next >= now)
  return html`
    <${PageHead} title=${t('nav.schedules')} sub=${t('glob.schedulesSub')} />
    <section class="panel corners pad stack" style="gap:12px">
      <p class="lbl">${t('glob.next24')}</p>
      <div class="timeline">
        ${day.length === 0 ? html`<p class="empty">${t('schedule.none')}</p>` : null}
        ${day.map((row) => html`<a class="tl-mark" href=${row.projectId === null ? '#/sessions' : href({ name: 'project', id: row.projectId, tab: 'schedules', sec: '' })} style=${`left:${((row.next - now) / 86_400_000) * 100}%`} title=${row.prompt}>
          <span class="tl-dot" aria-hidden="true"></span><span class="mono">${when(row.next)}</span><span class="faint">${row.projectId ?? t('schedule.task')}</span></a>`)}
      </div>
      <div class="cluster faint mono" style="justify-content:space-between"><span>${t('glob.now')}</span><span>+6h</span><span>+12h</span><span>+18h</span><span>+24h</span></div>
    </section>
    <section class="panel" aria-label=${t('schedule.list')}>
      ${rows.length === 0 ? html`<p class="empty pad">${t('schedule.empty')}</p>` : null}
      ${rows.map((row) => html`<div class="ri" key=${row.id}>
        <span class=${`mono${row.enabled ? '' : ' faint'}`} style="width:150px">${row.enabled ? when(row.next) : t('schedule.disabled')}</span>
        <div style="flex:1 1 240px;min-width:0"><b>${row.prompt}</b>
          <div class="faint" style="font-size:12.5px">${row.projectId === null ? t('schedule.task') : html`<a href=${href({ name: 'project', id: row.projectId, tab: 'schedules', sec: '' })}>${row.projectId}</a>`} · <span class="mono">${row.cron}</span>${row.model === null ? '' : ` · ${row.model}`}</div></div>
        ${can('cron')
          ? html`<button type="button" class="btn sm" onClick=${() => run(`/cron run ${row.id}`)}>${t('schedule.run')}</button>
              <${Toggle} checked=${row.enabled} label=${row.prompt} onChange=${(on: boolean) => run(`/cron ${on ? 'enable' : 'disable'} ${row.id}`)} />
              <button type="button" class="btn sm icon" aria-label=${t('settings.remove')} onClick=${() => run(`/cron remove ${row.id}`)}><${Icon} name="close" size=${14} /></button>`
          : null}
      </div>`)}
    </section>`
}

interface ScopeSpend {
  readonly scope: string
  readonly dayMicros: number
  readonly monthMicros: number
  readonly dayLimitMicros: number | null
  readonly monthLimitMicros: number | null
}

interface RunView {
  readonly runId: string
  readonly who: string
  readonly status: string
  readonly model: string
  readonly steps: number
  readonly startedAt: number
  readonly endedAt: number | null
  readonly micros: number
  readonly stopReason: string | null
}

/** What was spent, where, against which budget; the runs that cost it. */
export function CostsPage({ version, overview }: PageProps & { overview: Overview | undefined }): VNode {
  const data = useData<{ now: number; scopes: ScopeSpend[]; runs: RunView[] }>('/api/runs', version)
  if (data === undefined || data === null || overview === undefined) return html`<p class="empty">${t('common.loading')}</p>`
  const spend = overview.spend
  const top = Math.max(1, ...spend.trend.map((point) => point.micros))
  const projects = data.scopes.filter((scope) => scope.scope.startsWith('project:')).sort((a, b) => b.monthMicros - a.monthMicros)
  const others = data.scopes.filter((scope) => scope.scope === 'adhoc' || scope.scope === 'orchestrator')
  const dearest = [...data.runs].sort((a, b) => b.micros - a.micros)[0]
  const pct = (spent: number, limit: number | null): number => (limit === null || limit === 0 ? 0 : (spent / limit) * 100)
  const name = (scope: string): string => (scope === 'adhoc' ? t('nav.sessions') : scope === 'orchestrator' ? t('costs.frontDesk') : scope.replace(/^project:/, ''))
  return html`
    <${PageHead} title=${t('nav.costs')} sub=${t('glob.costsSub')} />
    <div class="tiles">
      <div class="panel corners tile"><p class="lbl">${t('spend.today')}</p><div class="disp tile-v">${money(spend.dayMicros)}</div><div class="faint">${spend.dayLimitMicros === null ? t('glob.noLimit') : t('glob.of', { limit: money(spend.dayLimitMicros) })}</div><${Bar} pct=${pct(spend.dayMicros, spend.dayLimitMicros)} /></div>
      <div class="panel tile"><p class="lbl">${t('spend.month')}</p><div class="disp tile-v">${money(spend.monthMicros)}</div><div class="faint">${spend.monthLimitMicros === null ? t('glob.noLimit') : t('glob.of', { limit: money(spend.monthLimitMicros) })}</div><${Bar} pct=${pct(spend.monthMicros, spend.monthLimitMicros)} /></div>
      <div class="panel tile"><p class="lbl">${t('glob.dearest')}</p><div class="disp tile-v">${dearest === undefined ? '—' : money(dearest.micros)}</div><div class="faint">${dearest === undefined ? '' : `${dearest.who} · ${when(dearest.startedAt)}`}</div></div>
    </div>
    <section class="panel pad stack" style="gap:10px">
      <p class="lbl">${t('glob.days', { count: spend.trend.length })}</p>
      <div class="cols" role="img" aria-label=${t('glob.days', { count: spend.trend.length })}>
        ${spend.trend.map((point, i) => html`<div class=${`col${i === spend.trend.length - 1 ? ' today' : ''}`} style=${`height:${Math.max(2, (point.micros / top) * 100)}%`} title=${`${point.day}: ${money(point.micros)}`}></div>`)}
      </div>
      <div class="cluster faint mono" style="justify-content:space-between"><span>${spend.trend[0]?.day ?? ''}</span><span>${t('spend.today')}</span></div>
    </section>
    <section class="panel" aria-label=${t('glob.byProject')}>
      <div class="pad" style="padding-bottom:8px"><h2>${t('glob.byProject')}</h2></div>
      ${[...projects, ...others].map((scope) => html`<div class="ri" key=${scope.scope}>
        <b style="width:160px;overflow:hidden;text-overflow:ellipsis">${name(scope.scope)}</b>
        <div style="flex:1 1 200px"><${Bar} pct=${pct(scope.monthMicros, scope.monthLimitMicros)} /></div>
        <span class="mono" style="width:170px;text-align:right">${spentText(scope.monthMicros, scope.monthLimitMicros)}</span>
        ${scope.scope.startsWith('project:') ? html`<a class="btn sm" href=${href({ name: 'project', id: scope.scope.slice('project:'.length), tab: 'settings', sec: 'budget' })}>${t('glob.budget')}</a>` : html`<span style="width:76px"></span>`}
      </div>`)}
    </section>
    <section class="panel" aria-label=${t('costs.runs')}>
      <div class="pad" style="padding-bottom:8px"><h2>${t('costs.runs')}</h2></div>
      ${data.runs.slice(0, 30).map((row) => html`<div class="ri" key=${row.runId}>
        <${StateChip} state=${row.status === 'running' ? 'running' : row.status === 'completed' ? 'ok' : row.status === 'failed' ? 'broken' : 'idle'} label=${t(`runStatus.${row.status}`) === `runStatus.${row.status}` ? row.status : t(`runStatus.${row.status}`)} />
        <div style="flex:1 1 220px;min-width:0"><b>${row.who}</b><div class="faint" style="font-size:12.5px">${when(row.startedAt)} · ${t('activity.line', { steps: row.steps, time: since(row.startedAt, row.endedAt ?? data.now), model: row.model })}</div></div>
        <span class="mono">${money(row.micros)}</span>
      </div>`)}
    </section>`
}
