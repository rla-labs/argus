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
import { Notice, type PageProps } from './ui.js'
import { NewProjectForm, ProjectsView, ProjectView } from './pages/projects.js'
import { RunsView, SchedulesView, SystemSection, TasksView } from './pages/work.js'

// ── the server's shapes ────────────────────────────────────────────────────

interface Overview {
  now: number
  panic: boolean
  slots: { used: number; limit: number; pending: number }
  projects: Array<{ id: string; description: string | null; status: string; model: string; running: boolean; waiting: boolean; dayPct: number | null; dayMicros: number; invalid: string | null }>
  spend: { dayMicros: number; dayLimitMicros: number | null; monthMicros: number; monthLimitMicros: number | null; trend: Array<{ day: string; micros: number }> }
  runs: Array<{ runId: string; who: string; model: string; steps: number; startedAt: number; micros: number }>
  approvals: Array<{ id: string; projectId: string | null; action: string; kind: string; at: number; always: string | null }>
  checkpoints: Array<{ runId: string; who: string; steps: number; reason: string; at: number }>
  schedules: Array<{ id: string; cron: string; who: string; what: string; enabled: boolean; next: number }>
  log: Array<{ at: number; actor: string; action: string; target: string | null }>
}

interface Settings {
  defaults: { tasks: string; frontDesk: string | null }
  keys: Array<{ provider: string; configured: boolean; writable: boolean }>
  projects: Array<{ id: string; model: string; tools: Record<string, string> & { web_hosts: string[] }; mcp: Array<{ name: string; access: string }>; instructions: string | null; dayUsd: number; monthUsd: number }>
  system: { timezone: string; dayUsd: number; monthUsd: number }
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
  note?: string
}

interface Me {
  userId: string
  name: string | null
  role: 'admin' | 'operator'
  login: string | null
  hasPassword: boolean
  mayResetPassword: boolean
  channels: string[]
  /** Commands only the admin may run; their buttons are not offered to an operator. */
  adminOnly: string[]
  /** Whether the user has an authenticator code (TOTP). */
  totp: boolean
  /** Public mode, and no code yet: setting one up is all the session may do. */
  totpRequired: boolean
  publicMode: boolean
}

interface UserRow {
  id: string
  name: string | null
  role: 'admin' | 'operator'
  disabled: boolean
  login: string | null
  channels: string[]
}

type View = 'overview' | 'approvals' | 'projects' | 'tasks' | 'schedules' | 'runs' | 'chat' | 'settings' | 'users' | 'setup'
const VIEWS: readonly View[] = ['overview', 'approvals', 'projects', 'tasks', 'schedules', 'runs', 'chat', 'settings', 'users']

/** The page and its part (`#projects/site-firma`) the address names. */
function fromHash(): { view: View; sub: string } {
  const [view, ...rest] = location.hash.slice(1).split('/')
  return { view: view === 'setup' ? 'setup' : (VIEWS.find((each) => each === view) ?? 'overview'), sub: decodeURIComponent(rest.join('/')) }
}
const GROUPS = ['read', 'write', 'shell', 'web', 'agents', 'git', 'other'] as const

// ── small pieces ───────────────────────────────────────────────────────────

/** A stroke icon per view. */
function Icon({ view }: { view: Exclude<View, 'setup'> }): VNode {
  const paths: Record<Exclude<View, 'setup'>, string> = {
    overview: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M2 12c0-3 4.5-5 10-5s10 2 10 5-4.5 5-10 5S2 15 2 12',
    approvals: 'M12 2 20 5v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5zM8.5 12l2.5 2.5 4.5-5',
    chat: 'M4 5h16v11H9l-5 4z',
    settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 6a2 2 0 1 0 0 .1M10 12a2 2 0 1 0 0 .1M18 18a2 2 0 1 0 0 .1',
    projects: 'M3 7h7l2 2h9v10H3zM3 7V5h6l2 2',
    tasks: 'M5 12l4 4L19 6M5 4h8M5 20h14',
    schedules: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
    runs: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    users: 'M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M2 21c0-4 3-7 7-7s7 3 7 7M16 3.5a4 4 0 0 1 0 7M18 14c2.5.8 4 3.5 4 7',
  }
  return html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d=${paths[view]}></path></svg>`
}


/** Approve / deny buttons for one pending approval. */
function ApprovalCard({ approval, admin, onDone }: { approval: Overview['approvals'][number]; admin: boolean; onDone: (message?: string) => void }): VNode {
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
      ${admin && approval.always !== null && approval.projectId !== null
        ? html`<button class="btn ghost" type="button" disabled=${busy} onClick=${() => answer('always')}>${t('approvals.always', { rule: approval.always.length > 40 ? `${approval.always.slice(0, 39)}…` : approval.always, project: approval.projectId })}</button>`
        : null}
    </div>
  </div>`
}

/** Continue / Stop for a run the loop checker found in a loop. */
function CheckpointCard({ checkpoint, onDone }: { checkpoint: Overview['checkpoints'][number]; onDone: (message?: string) => void }): VNode {
  const [busy, setBusy] = useState(false)
  const answer = async (value: string): Promise<void> => {
    setBusy(true)
    const result = await post(`/api/checkpoints/${encodeURIComponent(checkpoint.runId)}`, { value })
    setBusy(false)
    onDone(result.ok ? undefined : t('approvals.gone'))
  }
  return html`<div class="approval">
    <div class="head"><span class="mono" style="color:var(--amber)">${checkpoint.who} · ${t('checkpoint.title')}</span><span class="lbl">${clock(checkpoint.at)}</span></div>
    <p>${t('checkpoint.text', { steps: checkpoint.steps, reason: checkpoint.reason })}</p>
    <div class="btns">
      <button class="btn primary" type="button" disabled=${busy} onClick=${() => answer('continue')}>${t('checkpoint.continue')}</button>
      <button class="btn danger" type="button" disabled=${busy} onClick=${() => answer('stop')}>${t('checkpoint.stop')}</button>
    </div>
  </div>`
}

/** The sign-in form. Not `post`: a 401 here is a wrong password, not a lost session. */
function SignIn({ onSignedIn }: { onSignedIn: () => void }): VNode {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  // After the password, or a `/web` link (`/?step=code`), a user with a second factor gives the code.
  const [step, setStep] = useState<'password' | 'code'>(new URLSearchParams(location.search).get('step') === 'code' ? 'code' : 'password')
  const [error, setError] = useState<string | undefined>()
  const send = (path: string, body: unknown): Promise<Response> =>
    fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-argus': '1' }, body: JSON.stringify(body) })
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    const response = await send('/login', { login, password })
    setPassword('')
    if (response.status === 200) {
      setError(undefined)
      setStep('code')
    } else if (response.ok) onSignedIn()
    else setError(t(response.status === 429 ? 'signin.limited' : 'signin.invalid'))
  }
  const submitCode = async (event: Event): Promise<void> => {
    event.preventDefault()
    const response = await send('/login/code', { code })
    setCode('')
    if (response.ok) {
      history.replaceState(null, '', `/${location.hash}`)
      onSignedIn()
    } else setError(t(response.status === 429 ? 'signin.limited' : 'signin.badCode'))
  }
  if (step === 'code') {
    return html`<section class="hud signin"><h2>${t('signin.title')}</h2><p>${t('signin.codeText')}</p>
      ${error === undefined ? null : html`<div class="notice err" role="alert">${error}</div>`}
      <form style="display:flex;flex-direction:column;gap:12px;max-width:360px" onSubmit=${(event: Event) => void submitCode(event)}>
        <div class="field"><label class="lbl" for="s-code">${t('signin.code')}</label><input id="s-code" autocomplete="one-time-code" inputmode="text" required value=${code} onInput=${(e: Event) => setCode((e.target as HTMLInputElement).value)} /></div>
        <div class="btns"><button class="btn primary" type="submit">${t('signin.submit')}</button>
          <button class="btn ghost" type="button" onClick=${() => { history.replaceState(null, '', `/${location.hash}`); setError(undefined); setStep('password') }}>${t('signin.again')}</button></div>
      </form></section>`
  }
  return html`<section class="hud signin"><h2>${t('signin.title')}</h2><p>${t('signin.text')}</p>
    ${error === undefined ? null : html`<div class="notice err" role="alert">${error}</div>`}
    <form style="display:flex;flex-direction:column;gap:12px;max-width:360px" onSubmit=${(event: Event) => void submit(event)}>
      <div class="field"><label class="lbl" for="s-login">${t('signin.login')}</label><input id="s-login" autocomplete="username" required value=${login} onInput=${(e: Event) => setLogin((e.target as HTMLInputElement).value)} /></div>
      <div class="field"><label class="lbl" for="s-password">${t('signin.password')}</label><input id="s-password" type="password" autocomplete="current-password" required value=${password} onInput=${(e: Event) => setPassword((e.target as HTMLInputElement).value)} /></div>
      <div><button class="btn primary" type="submit">${t('signin.submit')}</button></div>
    </form></section>`
}

/** The first admin, from the one-time setup link. */
function CreateAdmin({ token, onCreated }: { token: string; onCreated: () => void }): VNode {
  const [name, setName] = useState('')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>()
  const errors: Record<string, string> = { short: 'password.short', login: 'password.badLogin', invalid: 'setup.invalid' }
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    const result = await post<{ error?: string }>('/api/setup', { token, name, login, password })
    setPassword('')
    if (result.ok) onCreated()
    else setError(t(errors[result.body.error ?? ''] ?? 'setup.invalid'))
  }
  return html`<section class="hud signin"><h2>${t('setup.adminTitle')}</h2><p>${t('setup.adminText')}</p>
    ${error === undefined ? null : html`<div class="notice err" role="alert">${error}</div>`}
    <form style="display:flex;flex-direction:column;gap:12px;max-width:360px" onSubmit=${(event: Event) => void submit(event)}>
      <div class="field"><label class="lbl" for="a-name">${t('users.name')}</label><input id="a-name" autocomplete="name" maxlength="80" value=${name} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} /></div>
      <div class="field"><label class="lbl" for="a-login">${t('signin.login')}</label><input id="a-login" autocomplete="username" required value=${login} onInput=${(e: Event) => setLogin((e.target as HTMLInputElement).value)} /></div>
      <div class="field"><label class="lbl" for="a-password">${t('password.new')}</label><input id="a-password" type="password" autocomplete="new-password" minlength="10" required value=${password} onInput=${(e: Event) => setPassword((e.target as HTMLInputElement).value)} /></div>
      <div><button class="btn primary" type="submit">${t('setup.create')}</button></div>
    </form></section>`
}

/** Set or change the signed-in user's web password. */
function PasswordSection({ me, onChanged }: { me: Me; onChanged: () => void }): VNode {
  const [login, setLogin] = useState(me.login ?? '')
  const [password, setPassword] = useState('')
  const [current, setCurrent] = useState('')
  const [message, setMessage] = useState<{ text: string; error: boolean } | undefined>()
  const errors: Record<string, string> = { short: 'password.short', login: 'password.badLogin', taken: 'password.taken', wrong: 'password.wrong' }
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    const result = await post<{ error?: string }>('/api/password', { login, password, ...(me.mayResetPassword ? {} : { current }) })
    setPassword('')
    setCurrent('')
    setMessage(result.ok ? { text: t('password.saved'), error: false } : { text: t(errors[result.body.error ?? ''] ?? 'password.wrong'), error: true })
    if (result.ok) onChanged()
  }
  return html`<section class="hud">
    <h2>${t('password.title')}</h2>
    <p class="muted" style="margin:0">${me.login === null ? t('password.none') : t('password.has', { login: me.login })}${me.login !== null && me.mayResetPassword ? ` ${t('password.reset')}` : ''}</p>
    ${message === undefined ? null : html`<div class=${`notice${message.error ? ' err' : ''}`} role="status">${message.text}</div>`}
    <form class="inline" onSubmit=${(event: Event) => void submit(event)}>
      <div class="field" style="flex:1 1 160px"><label class="lbl" for="p-login">${t('password.login')}</label><input id="p-login" autocomplete="username" required value=${login} onInput=${(e: Event) => setLogin((e.target as HTMLInputElement).value)} /></div>
      ${me.mayResetPassword
        ? null
        : html`<div class="field" style="flex:1 1 160px"><label class="lbl" for="p-current">${t('password.current')}</label><input id="p-current" type="password" autocomplete="current-password" required value=${current} onInput=${(e: Event) => setCurrent((e.target as HTMLInputElement).value)} /></div>`}
      <div class="field" style="flex:1 1 160px"><label class="lbl" for="p-new">${t('password.new')}</label><input id="p-new" type="password" autocomplete="new-password" minlength="10" required value=${password} onInput=${(e: Event) => setPassword((e.target as HTMLInputElement).value)} /></div>
      <button class="btn ghost" type="submit">${t('settings.save')}</button>
    </form>
  </section>`
}

/** The authenticator code (TOTP): set it up, or remove it. */
function TotpSection({ me, onChanged }: { me: Me; onChanged: () => void }): VNode {
  const [pending, setPending] = useState<{ secret: string; uri: string } | undefined>()
  const [recovery, setRecovery] = useState<string[] | undefined>()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | undefined>()
  const start = async (): Promise<void> => {
    const result = await post<{ secret: string; uri: string }>('/api/totp/start', {})
    if (result.ok) setPending(result.body)
  }
  const confirm = async (event: Event): Promise<void> => {
    event.preventDefault()
    const result = await post<{ recovery?: string[] }>('/api/totp/confirm', { code })
    setCode('')
    if (result.ok && result.body.recovery !== undefined) {
      setPending(undefined)
      setError(undefined)
      setRecovery(result.body.recovery)
    } else setError(t('totp.badCode'))
  }
  const disable = async (event: Event): Promise<void> => {
    event.preventDefault()
    const result = await post('/api/totp/disable', { code })
    setCode('')
    if (result.ok) onChanged()
    else setError(t('totp.badCode'))
  }
  const codeField = html`<div class="field" style="flex:1 1 160px"><label class="lbl" for="t-code">${t('signin.code')}</label><input id="t-code" autocomplete="one-time-code" required value=${code} onInput=${(e: Event) => setCode((e.target as HTMLInputElement).value)} /></div>`
  return html`<section class="hud">
    <h2>${t('totp.title')}</h2>
    ${error === undefined ? null : html`<div class="notice err" role="alert">${error}</div>`}
    ${recovery !== undefined
      ? html`<p class="muted" style="margin:0">${t('totp.recovery')}</p>
          <pre class="mono" style="margin:0">${recovery.join('\n')}</pre>
          <div><button class="btn primary" type="button" onClick=${() => { setRecovery(undefined); onChanged() }}>${t('totp.saved')}</button></div>`
      : pending !== undefined
        ? html`<p class="muted" style="margin:0">${t('totp.scan')}</p>
            <p class="mono" style="margin:0;word-break:break-all">${pending.secret}</p>
            <p style="margin:0"><a class="link" href=${pending.uri}>${t('totp.open')}</a></p>
            <form class="inline" onSubmit=${(event: Event) => void confirm(event)}>${codeField}<button class="btn primary" type="submit">${t('totp.confirm')}</button></form>`
        : me.totp
          ? html`<p class="muted" style="margin:0">${me.publicMode ? t('totp.onPublic') : t('totp.on')}</p>
              ${me.publicMode ? null : html`<form class="inline" onSubmit=${(event: Event) => void disable(event)}>${codeField}<button class="btn ghost" type="submit">${t('totp.disable')}</button></form>`}`
          : html`<p class="muted" style="margin:0">${me.totpRequired ? t('totp.required') : t('totp.off')}</p>
              <div><button class="btn primary" type="button" onClick=${() => void start()}>${t('totp.start')}</button></div>`}
  </section>`
}

/** The signed-in user's channels, and a code to connect another. */
function ChannelsSection({ me, run }: { me: Me; run: (line: string) => void }): VNode {
  return html`<section class="hud">
    <h2>${t('channels.title')}</h2>
    <p class="muted" style="margin:0">${me.channels.length === 0 ? t('channels.none') : t('channels.list', { channels: me.channels.join(', ') })}</p>
    <p class="muted" style="margin:0">${t('channels.hint')}</p>
    <div><button class="btn ghost" type="button" onClick=${() => run('/link')}>${t('channels.connect')}</button></div>
  </section>`
}

function UsersView({ version, run, outcome }: { version: number; run: (line: string) => void; outcome: VNode | null }): VNode {
  const [users, setUsers] = useState<UserRow[] | undefined>()
  const [name, setName] = useState('')
  useEffect(() => {
    void get<{ users: UserRow[] }>('/api/users').then((body) => setUsers(body.users))
  }, [version])
  return html`
    ${outcome}
    <section class="hud">
      <h2>${t('users.invite')}</h2>
      <p class="muted" style="margin:0">${t('users.inviteHint')}</p>
      <form class="inline" onSubmit=${(event: Event) => { event.preventDefault(); if (name.trim().length > 0) { run(`/users invite ${name.trim()}`); setName('') } }}>
        <div class="field" style="flex:1 1 220px"><label class="lbl" for="u-name">${t('users.name')}</label><input id="u-name" required maxlength="64" value=${name} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} /></div>
        <button class="btn primary" type="submit">${t('users.inviteButton')}</button>
      </form>
    </section>
    <section class="hud">
      <h2>${t('users.title')}</h2>
      ${users === undefined
        ? html`<p class="empty">${t('common.loading')}</p>`
        : html`<div class="scroll"><table>
            <thead><tr><th scope="col" class="lbl">${t('users.name')}</th><th scope="col" class="lbl">${t('users.role')}</th><th scope="col" class="lbl">${t('users.channels')}</th><th scope="col" class="lbl">${t('users.login')}</th><th></th></tr></thead>
            <tbody>${users.map(
              (user) => html`<tr class=${user.disabled ? 'muted' : ''}>
                <td>${user.name ?? user.login ?? user.id}${user.disabled ? html`<br /><span class="faint">${t('users.disabled')}</span>` : null}</td>
                <td>${t(`users.${user.role}`)}</td>
                <td class="mono">${user.channels.join(', ') || '—'}</td>
                <td class="mono">${user.login ?? '—'}</td>
                <td class="num">${user.role === 'admin'
                  ? null
                  : html`<div class="btns" style="justify-content:flex-end">
                      ${user.disabled
                        ? html`<button class="btn ghost" type="button" onClick=${() => run(`/users enable ${user.id}`)}>${t('users.enable')}</button>`
                        : html`<button class="btn ghost" type="button" onClick=${() => run(`/users reset ${user.id}`)}>${t('users.reset')}</button>
                            <button class="btn danger" type="button" onClick=${() => run(`/users remove ${user.id}`)}>${t('users.remove')}</button>`}
                    </div>`}</td>
              </tr>`,
            )}</tbody></table></div>`}
    </section>`
}

// ── views ──────────────────────────────────────────────────────────────────

function OverviewView({ data, refresh, run, admin }: { data: Overview; refresh: () => void; run: (line: string) => void; admin: boolean }): VNode {
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
          <div class="head"><h2>${t('approvals.title')}</h2><span class="lbl" style="color:var(--amber)">${t('approvals.pending', { count: data.approvals.length + data.checkpoints.length })}</span></div>
          ${gone === undefined ? null : html`<div class="notice err">${gone}</div>`}
          ${data.approvals.length + data.checkpoints.length === 0 ? html`<p class="empty">${t('approvals.none')}</p>` : null}
          ${data.checkpoints.map((checkpoint) => html`<${CheckpointCard} key=${checkpoint.runId} checkpoint=${checkpoint} onDone=${(message?: string) => { setGone(message); refresh() }} />`)}
          ${data.approvals.slice(0, 2).map((approval) => html`<${ApprovalCard} key=${approval.id} approval=${approval} admin=${admin} onDone=${(message?: string) => { setGone(message); refresh() }} />`)}
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

function ApprovalsView({ data, refresh, admin }: { data: Overview; refresh: () => void; admin: boolean }): VNode {
  const [gone, setGone] = useState<string | undefined>()
  return html`<section class="hud">
    <div class="head"><h2>${t('approvals.title')}</h2><span class="lbl">${t('approvals.pending', { count: data.approvals.length + data.checkpoints.length })}</span></div>
    ${gone === undefined ? null : html`<div class="notice err">${gone}</div>`}
    ${data.approvals.length + data.checkpoints.length === 0 ? html`<p class="empty">${t('approvals.none')}</p>` : null}
    ${data.checkpoints.map((checkpoint) => html`<${CheckpointCard} key=${checkpoint.runId} checkpoint=${checkpoint} onDone=${(message?: string) => { setGone(message); refresh() }} />`)}
    ${data.approvals.map((approval) => html`<${ApprovalCard} key=${approval.id} approval=${approval} admin=${admin} onDone=${(message?: string) => { setGone(message); refresh() }} />`)}
  </section>`
}

function ChatView({ version }: { version: number }): VNode {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Open on the screen means seen.
    void get<{ entries: ChatEntry[] }>('/api/chat').then((body) => {
      setEntries(body.entries)
      void post('/api/chat/read', {})
    })
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
              ? html`<div class="lbl" style="margin-top:8px">${entry.note ?? (entry.answered === 'timeout' ? t('chat.expired') : t('chat.answered', { value: entry.answered }))}</div>`
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

/** The models for tasks and the front desk. */
function DefaultsSection({ data, run, bare = false }: { data: Settings; run: (line: string) => void; bare?: boolean }): VNode {
  const [tasks, setTasks] = useState(data.defaults.tasks)
  const [desk, setDesk] = useState(data.defaults.frontDesk ?? '')
  return html`<${Box} bare=${bare}>
    ${bare ? null : html`<h2>${t('settings.defaults')}</h2>`}
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
  <//>`
}

/** A settings box, or only its contents inside a setup step. */
function Box({ bare, children }: { bare: boolean; children?: unknown }): VNode {
  return bare ? html`<div style="display:flex;flex-direction:column;gap:10px">${children}</div>` : html`<section class="hud grow1">${children}</section>`
}

/** Keys: a form to save one, and the ones saved. */
function KeysSection({ keys, run, title, hint, bare = false }: { keys: Settings['keys']; run: (line: string) => void; title: string; hint?: string; bare?: boolean }): VNode {
  const [provider, setProvider] = useState(keys[0]?.provider ?? '')
  const [key, setKey] = useState('')
  return html`<${Box} bare=${bare}>
    ${bare ? null : html`<h2>${title}</h2>`}
    ${hint === undefined ? null : html`<p class="muted" style="margin:0">${hint}</p>`}
    <form class="inline" autocomplete="off" onSubmit=${(event: Event) => { event.preventDefault(); if (key.trim().length > 0) { run(`/key ${provider} ${key.trim()}`); setKey('') } }}>
      ${keys.length === 1
        ? null
        : html`<div class="field"><label class="lbl" for=${`k-provider-${title}`}>${t('settings.keyProvider')}</label>
            <select id=${`k-provider-${title}`} value=${provider} onChange=${(e: Event) => setProvider((e.target as HTMLSelectElement).value)}>${keys.map((entry) => html`<option value=${entry.provider}>${entry.provider}</option>`)}</select></div>`}
      <div class="field" style="flex:1 1 200px"><label class="lbl" for=${`k-value-${title}`}>${t('settings.keyValue')}</label><input id=${`k-value-${title}`} type="password" class="mono" value=${key} onInput=${(e: Event) => setKey((e.target as HTMLInputElement).value)} /></div>
      <button class="btn ghost" type="submit">${t('settings.save')}</button>
    </form>
    <ul class="plain">${keys.filter((entry) => entry.configured).map(
      (entry) => html`<li style="display:flex;gap:10px;align-items:center"><span style="flex:1">${entry.provider} · <span class="muted">${entry.writable ? t('settings.keySet') : t('settings.keyEnv')}</span></span>
        ${entry.writable ? html`<button class="btn danger" type="button" onClick=${() => run(`/key remove ${entry.provider}`)}>${t('settings.remove')}</button>` : null}</li>`,
    )}</ul>
  <//>`
}

/** One step of the setup page. */
function Step({ title, done, hint, children }: { title: string; done: boolean; hint: string; children?: unknown }): VNode {
  return html`<section class="hud">
    <h2>${done ? html`<span style="color:var(--cyan)" aria-label=${t('setup.done')}>✓ </span>` : null}${title}</h2>
    <p class="muted" style="margin:0">${hint}</p>
    ${children}
  </section>`
}

/** What a new install needs, each step a command, and what is done already. */
function SetupView({ data, me, run, outcome, version, onFinish }: { data: Settings; me: Me; run: (line: string) => void; outcome: VNode | null; version: number; onFinish: () => void }): VNode {
  const providers = data.keys.filter((entry) => entry.provider !== 'telegram')
  const telegram = data.keys.filter((entry) => entry.provider === 'telegram')
  return html`
    ${outcome}
    <section class="hud"><h2>${t('setup.title')}</h2><p class="muted" style="margin:0">${t('setup.intro')}</p></section>
    <${Step} title=${t('setup.admin')} done=${true} hint=${t('setup.adminDone', { login: me.login ?? '' })} />
    <${Step} title=${t('setup.key')} done=${providers.some((entry) => entry.configured)} hint=${t('setup.keyHint')}>
      <${KeysSection} keys=${providers} run=${run} title="provider" bare=${true} />
    <//>
    <${Step} title=${t('setup.models')} done=${false} hint=${t('setup.modelsHint')}>
      <${DefaultsSection} key=${JSON.stringify(data.defaults)} data=${data} run=${run} bare=${true} />
    <//>
    ${telegram.length === 0
      ? null
      : html`<${Step} title=${t('setup.telegram')} done=${me.channels.some((channel) => channel.startsWith('telegram:'))} hint=${t('setup.telegramHint')}>
          <${KeysSection} keys=${telegram} run=${run} title="telegram" bare=${true} />
          <p class="muted" style="margin:0">${me.channels.length === 0 ? t('channels.none') : t('channels.list', { channels: me.channels.join(', ') })} ${t('channels.hint')}</p>
          <div><button class="btn ghost" type="button" onClick=${() => run('/link')}>${t('channels.connect')}</button></div>
        <//>`}
    <${Step} title=${t('setup.project')} done=${data.projects.length > 0} hint=${t('setup.projectHint')}>
      <${NewProjectForm} version=${version} run=${run} />
      ${data.projects.length === 0
        ? null
        : html`<p class="muted" style="margin:0">${t('setup.projects')} ${data.projects.map((project, index) => html`${index === 0 ? '' : ', '}<a class="link" href=${`#projects/${encodeURIComponent(project.id)}`}>${project.id}</a>`)}</p>`}
    <//>
    <${Step} title=${t('setup.system')} done=${true} hint=${t('setup.systemText', { timezone: data.system.timezone, day: data.system.dayUsd, month: data.system.monthUsd })} />
    <div class="btns"><button class="btn primary" type="button" onClick=${onFinish}>${t('setup.finish')}</button></div>`
}

function SettingsView({ data, run, outcome, account }: { data: Settings; run: (line: string) => void; outcome: VNode | null; account: VNode }): VNode {
  const instructed = data.projects.filter((project) => project.instructions !== null)
  const [instructionsOf, setInstructionsOf] = useState(instructed[0]?.id ?? '')
  const [instructions, setInstructions] = useState(instructed[0]?.instructions ?? '')
  const pick = (id: string): void => {
    setInstructionsOf(id)
    setInstructions(data.projects.find((project) => project.id === id)?.instructions ?? '')
  }
  return html`
    ${outcome}
    ${account}
    <div class="row">
      <${DefaultsSection} data=${data} run=${run} />
      <${KeysSection} keys=${data.keys} run=${run} title=${t('settings.keys')} hint=${t('settings.keysHint')} />
    </div>
    <section class="hud">
      <h2>${t('settings.tools')}</h2>
      <p class="muted" style="margin:0">${t('settings.toolsHint')}</p>
      <div class="scroll"><table>
        <thead><tr><th scope="col" class="lbl">${t('settings.project')}</th>${GROUPS.map((group) => html`<th scope="col" class="lbl">${t(`tools.${group}`)}</th>`)}<th scope="col" class="lbl">${t('settings.budget')}</th></tr></thead>
        <tbody>${data.projects.map(
          (project) => html`<tr>
            <td>${project.id}<br /><span class="faint">${project.model}</span>
              ${project.mcp.map(
                (server) => html`<br /><label class="faint" for=${`m-${project.id}-${server.name}`}>${t('settings.mcp', { name: server.name })}</label>
                  <select id=${`m-${project.id}-${server.name}`} value=${server.access} onChange=${(e: Event) => run(`/set ${project.id} mcp.${server.name}.access ${(e.target as HTMLSelectElement).value}`)}>
                    ${['deny', 'ask', 'allow'].map((value) => html`<option value=${value}>${value}</option>`)}
                  </select>`,
              )}</td>
            ${GROUPS.map(
              (group) => html`<td><label class="sr" for=${`t-${project.id}-${group}`}>${project.id} ${group}</label>
                <select id=${`t-${project.id}-${group}`} value=${project.tools[group]} onChange=${(e: Event) => run(`/set ${project.id} tools.${group} ${(e.target as HTMLSelectElement).value}`)}>
                  ${(group === 'other' ? ['deny', 'ask', 'allow'] : ['off', 'deny', 'ask', 'allow']).map((value) => html`<option value=${value}>${value}</option>`)}
                </select></td>`,
            )}
            <td>$${project.dayUsd} / $${project.monthUsd}</td>
          </tr>`,
        )}</tbody></table></div>
    </section>
    ${instructed.length === 0
      ? null
      : html`<section class="hud">
          <h2>${t('settings.instructions')}</h2>
          <p class="muted" style="margin:0">${t('settings.instructionsHint')}</p>
          <form style="display:flex;flex-direction:column;gap:10px" onSubmit=${(event: Event) => { event.preventDefault(); run(`/instructions ${instructionsOf} ${instructions.trim() || 'clear'}`) }}>
            <div class="field"><label class="lbl" for="i-project">${t('settings.project')}</label>
              <select id="i-project" value=${instructionsOf} onChange=${(e: Event) => pick((e.target as HTMLSelectElement).value)}>${instructed.map((project) => html`<option value=${project.id}>${project.id}</option>`)}</select></div>
            <label class="sr" for="i-text">${t('settings.instructions')}</label>
            <textarea id="i-text" rows="8" class="mono" style="padding:10px;min-height:160px" value=${instructions} onInput=${(e: Event) => setInstructions((e.target as HTMLTextAreaElement).value)}></textarea>
            <div><button class="btn ghost" type="submit">${t('settings.save')}</button></div>
          </form>
        </section>`}`
}

// ── the app ────────────────────────────────────────────────────────────────

function App(): VNode {
  const [, setLang] = useState<Language>(lang())
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined)
  const [me, setMe] = useState<Me | undefined>()
  const [{ view, sub }, setPlace] = useState(fromHash)
  const [overviewData, setOverview] = useState<Overview | undefined>()
  const [settingsData, setSettings] = useState<Settings | undefined>()
  const [chatVersion, setChatVersion] = useState(0)
  const [unread, setUnread] = useState(0)
  const [pageVersion, setPageVersion] = useState(0)
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
  const loadUnread = useCallback(() => guard(async () => setUnread((await get<{ count: number }>('/api/chat/unread')).count)), [guard])
  const run = useCallback(
    (line: string) =>
      void guard(async () => {
        setOutcome(await command(line))
        setPageVersion((v) => v + 1)
        // The answer shows at the top of the page.
        window.scrollTo({ top: 0 })
        await Promise.all([loadOverview(), loadSettings()])
      }),
    [guard, loadOverview, loadSettings],
  )

  const loadMe = useCallback(
    () =>
      void get<Me>('/api/me').then(
        (body) => {
          setMe(body)
          setSignedIn(true)
        },
        () => setSignedIn(false),
      ),
    [],
  )
  useEffect(loadMe, [loadMe])
  // Public mode, no authenticator code yet: setting one up is all there is.
  const restricted = me?.totpRequired === true
  useEffect(() => {
    if (signedIn !== true || restricted) return undefined
    void loadOverview()
    void loadSettings()
    void loadUnread()
    // A minute's tick keeps the clocks honest between events.
    const tick = setInterval(() => void loadOverview(), 60_000)
    const stop = listen(
      (topic) => {
        if (topic === 'overview' || topic === 'settings') setPageVersion((v) => v + 1)
        if (topic === 'overview') void loadOverview()
        else if (topic === 'settings') {
          // A command run anywhere may have changed you (a /link from Telegram).
          void loadSettings()
          loadMe()
        }
        else if (topic === 'chat') {
          setChatVersion((v) => v + 1)
          void loadUnread()
        }
      },
      setConnected,
    )
    return () => {
      clearInterval(tick)
      stop()
    }
  }, [signedIn, restricted, loadOverview, loadSettings, loadUnread, loadMe])

  // A link (`#projects/site-firma`) moves between pages as the menu does.
  useEffect(() => {
    const follow = (): void => {
      setPlace(fromHash())
      setOutcome(undefined)
    }
    window.addEventListener('hashchange', follow)
    // The address may have changed between the first render and this listener.
    setPlace(fromHash())
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  const go = (next: View): void => {
    setPlace({ view: next, sub: '' })
    setOutcome(undefined)
    history.replaceState(null, '', `#${next}`)
  }
  const can = (name: string): boolean => me?.role === 'admin' || !(me?.adminOnly ?? []).includes(name)
  const page: PageProps = { version: pageVersion, run, outcome: html`<${Notice} outcome=${outcome} onButton=${run} />`, can }
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
    const token = location.pathname === '/setup' ? new URLSearchParams(location.search).get('token') : null
    if (token !== null) {
      const created = (): void => {
        history.replaceState(null, '', '/#setup')
        setPlace({ view: 'setup', sub: '' })
        loadMe()
      }
      return html`${header}<${CreateAdmin} token=${token} onCreated=${created} />`
    }
    return html`${header}<${SignIn} onSignedIn=${loadMe} />`
  }
  if (me !== undefined && restricted) {
    return html`${header}<div class="signin" style="display:flex;flex-direction:column;gap:12px"><${TotpSection} me=${me} onChanged=${loadMe} />
      <div><button class="btn ghost" type="button" onClick=${() => void post('/api/logout', {}).then(() => setSignedIn(false))}>${t('nav.signout')}</button></div></div>`
  }
  // What a new install still lacks: a provider key, a first project.
  const unfinished = me?.role === 'admin' && settingsData !== undefined && (!settingsData.keys.some((entry) => entry.provider !== 'telegram' && entry.configured) || settingsData.projects.length === 0)

  const pending = (overviewData?.approvals.length ?? 0) + (overviewData?.checkpoints.length ?? 0)
  return html`${header}
    <div class="layout">
      <nav class="rail" aria-label=${t('nav.label')}>
        ${VIEWS.filter((each) => each !== 'users' || me?.role === 'admin').map(
          (each) => html`<button type="button" aria-current=${view === each ? 'page' : undefined} onClick=${() => go(each)}>
            <${Icon} view=${each} />${t(`nav.${each}`)}${each === 'approvals' && pending > 0 ? html`<span class="count">${pending}</span>` : null}
            ${each === 'chat' && unread > 0 && view !== 'chat' ? html`<span class="count" aria-label=${t('chat.unread', { count: unread })}>${unread}</span>` : null}
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
        ${view === 'overview' && unfinished ? html`<div class="notice" role="status">${t('setup.banner')} <a class="link" href="#setup">${t('setup.bannerLink')}</a></div>` : null}
        ${view === 'setup' && me?.role === 'admin' && settingsData !== undefined ? html`<${SetupView} data=${settingsData} me=${me} run=${run} outcome=${html`<${Notice} outcome=${outcome} onButton=${run} />`} version=${pageVersion} onFinish=${() => go('overview')} />` : null}
        ${view === 'overview' ? (overviewData === undefined ? html`<p class="empty">${t('common.loading')}</p>` : html`<${Notice} outcome=${outcome} onButton=${run} /><${OverviewView} data=${overviewData} refresh=${loadOverview} run=${run} admin=${me?.role === 'admin'} />`) : null}
        ${view === 'approvals' && overviewData !== undefined ? html`<${ApprovalsView} data=${overviewData} refresh=${loadOverview} admin=${me?.role === 'admin'} />` : null}
        ${view === 'chat' ? html`<${ChatView} version=${chatVersion} />` : null}
        ${view === 'settings' ? (settingsData === undefined ? html`<p class="empty">${t('common.loading')}</p>` : html`<${SettingsView} key=${JSON.stringify(settingsData.defaults)} data=${settingsData} run=${run} outcome=${html`<${Notice} outcome=${outcome} onButton=${run} />`}
            account=${me === undefined ? null : html`<${PasswordSection} me=${me} onChanged=${loadMe} /><${TotpSection} me=${me} onChanged=${loadMe} /><${ChannelsSection} me=${me} run=${run} />`} />`) : null}
        ${view === 'users' && me?.role === 'admin' ? html`<${UsersView} ...${page} />` : null}
        ${view === 'tasks' ? html`<${TasksView} ...${page} />` : null}
        ${view === 'schedules' ? html`<${SchedulesView} ...${page} />` : null}
        ${view === 'runs' ? html`<${RunsView} ...${page} />` : null}
        ${view === 'settings' && settingsData !== undefined ? html`<${SystemSection} ...${page} outcome=${null} panic=${overviewData?.panic === true} />` : null}
        ${view === 'projects' ? (sub.length === 0 ? html`<${ProjectsView} ...${page} />` : html`<${ProjectView} key=${sub} id=${sub} ...${page} />`) : null}
      </main>
    </div>`
}

void loadLanguage(initialLanguage()).then(() => render(html`<${App} />`, document.getElementById('app') as HTMLElement))
