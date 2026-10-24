// == ARGUS AGENT PROJECT ==
/**
 * The pages from before 0.7.3, kept working inside the new shell until each is redrawn:
 * the overview, approvals, the chat, settings, users, the setup steps, sign-in.
 */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { get, post } from '../api.js'
import { clock, t } from '../i18n.js'
import { NewProjectForm } from './projects.js'
// ── the server's shapes ────────────────────────────────────────────────────

export interface Overview {
  now: number
  panic: boolean
  slots: { used: number; limit: number; pending: number }
  projects: Array<{ id: string; description: string | null; status: string; model: string; running: boolean; waiting: boolean; dayPct: number | null; dayMicros: number; invalid: string | null }>
  spend: { dayMicros: number; dayLimitMicros: number | null; monthMicros: number; monthLimitMicros: number | null; trend: Array<{ day: string; micros: number }> }
  runs: Array<{ runId: string; who: string; model: string; steps: number; startedAt: number; micros: number }>
  approvals: Array<{ id: string; projectId: string | null; action: string; kind: string; at: number; always: string | null; detail: string | null }>
  checkpoints: Array<{ runId: string; who: string; steps: number; reason: string; at: number }>
  schedules: Array<{ id: string; cron: string; who: string; what: string; enabled: boolean; next: number }>
  log: Array<{ at: number; actor: string; action: string; target: string | null }>
}

export interface Settings {
  defaults: { tasks: string; frontDesk: string | null }
  keys: Array<{ provider: string; configured: boolean; writable: boolean }>
  projects: Array<{ id: string; model: string; tools: Record<string, string> & { web_hosts: string[] }; mcp: Array<{ name: string; access: string; tools: Record<string, string> }>; instructions: string | null; dayUsd: number; monthUsd: number }>
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

export interface Me {
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

const GROUPS = ['read', 'write', 'shell', 'web', 'agents', 'git', 'mail', 'mail_read', 'other'] as const

// ── small pieces ───────────────────────────────────────────────────────────

/** The sign-in form. Not `post`: a 401 here is a wrong password, not a lost session. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }): VNode {
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
export function CreateAdmin({ token, onCreated }: { token: string; onCreated: () => void }): VNode {
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
export function PasswordSection({ me, onChanged }: { me: Me; onChanged: () => void }): VNode {
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
export function TotpSection({ me, onChanged }: { me: Me; onChanged: () => void }): VNode {
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
export function ChannelsSection({ me, run }: { me: Me; run: (line: string) => void }): VNode {
  return html`<section class="hud">
    <h2>${t('channels.title')}</h2>
    <p class="muted" style="margin:0">${me.channels.length === 0 ? t('channels.none') : t('channels.list', { channels: me.channels.join(', ') })}</p>
    <p class="muted" style="margin:0">${t('channels.hint')}</p>
    <div><button class="btn ghost" type="button" onClick=${() => run('/link')}>${t('channels.connect')}</button></div>
  </section>`
}

export function UsersView({ version, run, outcome }: { version: number; run: (line: string) => void; outcome: VNode | null }): VNode {
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

export function ChatView({ version }: { version: number }): VNode {
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
export function SetupView({ data, me, run, outcome, version, onFinish }: { data: Settings; me: Me; run: (line: string) => void; outcome: VNode | null; version: number; onFinish: () => void }): VNode {
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

export function SettingsView({ data, run, outcome, account }: { data: Settings; run: (line: string) => void; outcome: VNode | null; account: VNode }): VNode {
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
                  </select>
                  ${Object.keys(server.tools).length === 0 ? null : html`<br /><span class="faint">${Object.entries(server.tools).map(([tool, access]) => `${tool} ${access}`).join(', ')}</span>`}`,
              )}</td>
            ${GROUPS.map(
              (group) => html`<td><label class="sr" for=${`t-${project.id}-${group}`}>${project.id} ${group}</label>
                <select id=${`t-${project.id}-${group}`} value=${project.tools[group]} onChange=${(e: Event) => run(`/set ${project.id} tools.${group} ${(e.target as HTMLSelectElement).value}`)}>
                  ${(group === 'other' ? ['deny', 'ask', 'allow'] : group === 'mail' ? ['off', 'deny', 'ask'] : ['off', 'deny', 'ask', 'allow']).map((value) => html`<option value=${value}>${value}</option>`)}
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
