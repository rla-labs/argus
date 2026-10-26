// == ARGUS AGENT PROJECT ==
/**
 * A project's settings, in sections, in plain words. A change is held until Save, which
 * sends it as the same commands the chat has (`/set`, `/model`, `/instructions`…), so
 * the server checks it as it checks those; what widens access says so before it is saved.
 */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { command, type CommandOutcome } from '../api.js'
import { t } from '../i18n.js'
import { Icon, Modal, Seg, StateChip, Toggle, toast } from '../kit.js'
import { href } from '../router.js'
import { useData } from '../ui.js'
import { when } from './home.js'

/** One setting, as the server describes it. */
export interface Field {
  readonly key: string
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'map' | 'value'
  readonly options: readonly string[]
  readonly min: number | null
  readonly max: number | null
  readonly default: unknown
  readonly value: unknown
  readonly description: string | null
  readonly own?: boolean
  readonly inherited?: boolean
}

interface Described {
  readonly id: string
  readonly template: string | null
  readonly model: string
  readonly fields: readonly Field[]
  readonly mcp: ReadonlyArray<{ name: string; kind: 'local' | 'remote'; target: string; access: string; tools: Readonly<Record<string, string>>; oauth: boolean; state: 'connected' | 'not connected' | 'failed' | null; extension: string | null }>
  readonly extensions: ReadonlyArray<{ name: string; version: string | null; summary: string | null; enabled: boolean; network: boolean }>
  readonly git: ReadonlyArray<{ name: string; url: string; protected: readonly string[]; token: boolean }>
  readonly mail: {
    readonly allowed_recipients: readonly string[]
    readonly max_per_day: number
    readonly read_folders: readonly string[]
    readonly account: { own: boolean; host: string; user: string } | null
    readonly mailbox: { own: boolean; host: string; user: string } | null
    readonly trusted_recipients: Readonly<Record<string, number>>
    readonly unattended_per_day: number
    readonly on_limit: 'ask' | 'block'
    /** Recipients reached in the last 24 hours: all, unasked, and unasked by address. */
    readonly used: { total: number; unattended: number; byAddress: Readonly<Record<string, number>> }
    readonly paused: { paused: boolean; auto: boolean }
    readonly outbox: ReadonlyArray<{ id: number; status: string; at: number; recipients: number; why: string | null; note: string | null }>
  }
  readonly memory: ReadonlyArray<{ name: string; chars: number }>
  readonly undo: ReadonlyArray<{ id: string; at: number; kind?: string; label?: string; runId?: string }>
}

interface Model {
  readonly ref: string
  readonly provider: string
  readonly model: string
  readonly ready: boolean
  readonly price: { input: number; output: number; source: string } | null
}

const SECTIONS = ['general', 'tools', 'extensions', 'connections', 'budget', 'memory', 'danger', 'advanced'] as const
type Section = (typeof SECTIONS)[number]

const TOOL_GROUPS = ['read', 'write', 'shell', 'web', 'agents', 'git', 'mail', 'mail_read', 'other'] as const
const RANK: Record<string, number> = { off: 0, deny: 0, ask: 1, allow: 2 }

/** A value as `/set` takes it: text quoted, lists and maps as JSON (YAML reads it). */
export function encode(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value ?? null)
}

/** Run command lines one after another, stopping at the first refusal. */
export async function runAll(lines: readonly string[]): Promise<{ ok: boolean; text: string; outcome?: CommandOutcome }> {
  let last: CommandOutcome | undefined
  for (const line of lines) {
    last = await command(line)
    // A refusal stops the rest; so does a question (a confirmation), which the dialog asks.
    if (last.error || last.buttons.length > 0) return { ok: false, text: last.text, outcome: last }
  }
  return { ok: true, text: last?.text ?? '', ...(last === undefined ? {} : { outcome: last }) }
}

/** Show a command's answer that needs more than a toast: the app's dialog. */
export function showOutcome(outcome: CommandOutcome): void {
  window.dispatchEvent(new CustomEvent('argus-outcome', { detail: outcome }))
}

/** A list of short texts, each a chip, with a box to add one. */
export function ChipList({ values, onChange, label, placeholder, mono = true }: { values: readonly string[]; onChange: (next: string[]) => void; label: string; placeholder: string; mono?: boolean }): VNode {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const value = draft.trim()
    if (value.length > 0 && !values.includes(value)) onChange([...values, value])
    setDraft('')
  }
  return html`<div class="cluster" style="gap:6px">
    ${values.map((value) => html`<span class=${`chip${mono ? ' mono' : ''}`} style="color:var(--text)">${value}<button type="button" class="chip-x" aria-label=${t('settings.remove')} onClick=${() => onChange(values.filter((each) => each !== value))}><${Icon} name="close" size=${12} /></button></span>`)}
    <input class="in" style="width:200px;min-height:32px;padding:4px 10px" aria-label=${label} placeholder=${placeholder} value=${draft}
      onInput=${(event: Event) => setDraft((event.target as HTMLInputElement).value)} onKeyDown=${(event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
    <button type="button" class="btn sm" onClick=${add}>${t('ps.add')}</button>
  </div>`
}

/** An editor for any setting, from its kind. */
export function FieldEditor({ field, value, onChange }: { field: Field; value: unknown; onChange: (next: unknown) => void }): VNode {
  const id = `f-${field.key}`
  switch (field.kind) {
    case 'boolean':
      return html`<${Toggle} checked=${value === true} label=${field.key} onChange=${onChange} />`
    case 'enum':
      return field.options.length <= 4
        ? html`<${Seg} label=${field.key} value=${String(value)} onChange=${onChange} options=${field.options.map((option) => ({ value: option, label: option }))} />`
        : html`<select id=${id} value=${String(value)} onChange=${(event: Event) => onChange((event.target as HTMLSelectElement).value)}>${field.options.map((option) => html`<option value=${option}>${option}</option>`)}</select>`
    case 'number':
      return html`<input id=${id} class="in mono" style="width:160px" type="number" min=${field.min ?? undefined} max=${field.max ?? undefined} step="any" value=${String(value ?? '')}
        onInput=${(event: Event) => { const text = (event.target as HTMLInputElement).value; onChange(text === '' ? null : Number(text)) }} />`
    case 'string':
      return html`<input id=${id} class="in" value=${String(value ?? '')} onInput=${(event: Event) => onChange((event.target as HTMLInputElement).value)} />`
    case 'list':
      return html`<${ChipList} values=${Array.isArray(value) ? value.map(String) : []} onChange=${onChange} label=${field.key} placeholder=${t('ps.addOne')} />`
    default:
      return html`<${JsonEditor} id=${id} value=${value} onChange=${onChange} />`
  }
}

/** A map or any other value, as JSON. */
function JsonEditor({ id, value, onChange }: { id: string; value: unknown; onChange: (next: unknown) => void }): VNode {
  const [text, setText] = useState(JSON.stringify(value ?? null, null, 2))
  const [bad, setBad] = useState(false)
  return html`<div class="stack" style="gap:4px;width:100%">
    <textarea id=${id} class="in mono" rows=${Math.min(10, text.split('\n').length + 1)} value=${text} onInput=${(event: Event) => {
      const next = (event.target as HTMLTextAreaElement).value
      setText(next)
      try {
        onChange(JSON.parse(next))
        setBad(false)
      } catch {
        setBad(true)
      }
    }}></textarea>
    ${bad ? html`<span class="help bad">${t('ps.badJson')}</span>` : null}
  </div>`
}

/** A row: a title and its help on the left, its control on the right. */
function Row({ title, help, children, warn, wide = false }: { title: string; help?: string | null; children?: unknown; warn?: string | null; wide?: boolean }): VNode {
  return html`<div class=${`ri${wide ? ' wide' : ''}`} style="align-items:flex-start">
    <div style="flex:1 1 240px;min-width:0"><b>${title}</b>${help === undefined || help === null ? null : html`<p class="help">${help}</p>`}${warn === undefined || warn === null ? null : html`<p class="help" style="color:var(--warm)">${warn}</p>`}</div>
    <div class="ri-control">${children}</div>
  </div>`
}

// ── sections ───────────────────────────────────────────────────────────────

interface SectionProps {
  readonly data: Described
  readonly values: Readonly<Record<string, unknown>>
  readonly set: (key: string, value: unknown) => void
  readonly field: (key: string) => Field | undefined
  readonly act: (lines: string | readonly string[], said?: string) => void
  readonly admin: boolean
}

function ModelPicker({ value, onChange, models }: { value: string; onChange: (next: string) => void; models: readonly Model[] }): VNode {
  const [query, setQuery] = useState('')
  const shown = models.filter((model) => model.ref.toLowerCase().includes(query.toLowerCase())).slice(0, 40)
  const price = (model: Model): string =>
    model.price === null ? t('ps.noPrice') : model.price.input === 0 && model.price.output === 0 ? t('ps.free') : t('ps.price', { input: model.price.input, output: model.price.output })
  return html`<div class="stack" style="gap:8px;width:min(560px,100%)">
    <input class="in" aria-label=${t('ps.findModel')} placeholder=${t('ps.findModel')} value=${query} onInput=${(event: Event) => setQuery((event.target as HTMLInputElement).value)} />
    <div class="model-list">
      ${shown.map((model) => html`<button type="button" class="choice" aria-pressed=${model.ref === value ? 'true' : 'false'} disabled=${!model.ready && model.ref !== value} onClick=${() => onChange(model.ref)}>
        <span class="radio" aria-hidden="true"></span>
        <span style="flex:1;min-width:0"><span class="mono" style="font-weight:600">${model.model}</span><br /><span class="faint" style="font-size:12px">${model.provider} · ${price(model)}${model.ready ? '' : ` · ${t('ps.noKey')}`}</span></span>
      </button>`)}
      ${shown.length === 0 ? html`<p class="empty">${t('palette.none')}</p>` : null}
    </div>
    <a class="help" href="#/settings/models">${t('ps.addProvider')}</a>
  </div>`
}

function General({ data, values, set, field }: SectionProps): VNode {
  const models = useData<{ models: Model[] }>('/api/models', 0)
  const list = useMemo(() => {
    const all = models?.models ?? []
    return all.some((model) => model.ref === values['model']) ? all : [{ ref: String(values['model']), provider: String(values['model']).split('/')[0] ?? '', model: String(values['model']).split('/').slice(1).join('/'), ready: true, price: null }, ...all]
  }, [models, values['model']])
  return html`<section class="panel">
    <div class="pad" style="padding-bottom:8px"><h2>${t('ps.general')}</h2></div>
    <${Row} wide=${true} title=${t('ps.description')} help=${t('ps.descriptionHelp')}><input class="in" style="width:100%" value=${String(values['description'] ?? '')} onInput=${(event: Event) => set('description', (event.target as HTMLInputElement).value)} /><//>
    <${Row} wide=${true} title=${t('ps.model')} help=${t('ps.modelHelp')}><${ModelPicker} value=${String(values['model'])} onChange=${(next: string) => set('model', next)} models=${list} /><//>
    <${Row} title=${t('ps.fallback')} help=${field('fallback_model')?.description ?? t('ps.fallbackHelp')}>
      <select value=${String(values['fallback_model'] ?? '')} onChange=${(event: Event) => set('fallback_model', (event.target as HTMLSelectElement).value || null)}>
        <option value="">${t('ps.none')}</option>${list.map((model) => html`<option value=${model.ref}>${model.ref}</option>`)}
      </select><//>
    <${Row} wide=${true} title=${t('ps.instructions')} help=${t('settings.instructionsHint')}><textarea class="in" rows="5" style="width:100%" value=${String(values['instructions'] ?? '')} onInput=${(event: Event) => set('instructions', (event.target as HTMLTextAreaElement).value)}></textarea><//>
    <${Row} title=${t('ps.progress')} help=${t('ps.progressHelp')}><${Toggle} checked=${values['progress'] === true} label=${t('ps.progress')} onChange=${(next: boolean) => set('progress', next)} /><//>
    ${data.template === null ? null : html`<p class="help pad">${t('ps.template', { template: data.template })}</p>`}
  </section>`
}

function Tools({ data, values, set }: SectionProps): VNode {
  return html`<section class="panel">
    <div class="pad" style="padding-bottom:8px"><h2>${t('ps.sec.tools')}</h2><p class="help">${t('ps.toolsHelp')}</p></div>
    ${TOOL_GROUPS.map((group) => {
      const key = `tools.${group}`
      const value = String(values[key])
      const original = String(data.fields.find((each) => each.key === key)?.value)
      const options = group === 'mail' ? ['off', 'ask'] : group === 'other' ? ['deny', 'ask', 'allow'] : ['off', 'ask', 'allow']
      const all = options.includes(value) ? options : [...options, value]
      const widened = value === 'allow' && (RANK[value] ?? 0) > (RANK[original] ?? 0)
      return html`<${Row} key=${group} title=${t(`ps.tool.${group}`)} help=${t(`ps.toolHelp.${group}`)} warn=${widened ? t(`ps.widen.${group}`) === `ps.widen.${group}` ? t('ps.widen.any') : t(`ps.widen.${group}`) : null}>
        <${Seg} label=${t(`ps.tool.${group}`)} value=${value} onChange=${(next: string) => set(key, next)} options=${all.map((option) => ({ value: option, label: t(`ps.access.${option}`), hot: option === 'allow' && original !== 'allow' }))} />
      <//>`
    })}
    <${Row} wide=${true} title=${t('ps.autoAllow')} help=${t('ps.autoAllowHelp')}><${ChipList} values=${(values['approvals.auto_allow'] as string[]) ?? []} onChange=${(next: string[]) => set('approvals.auto_allow', next)} label=${t('ps.autoAllow')} placeholder="npm test" /><//>
    <${Row} wide=${true} title=${t('ps.webHosts')} help=${t('ps.webHostsHelp')}><${ChipList} values=${(values['tools.web_hosts'] as string[]) ?? []} onChange=${(next: string[]) => set('tools.web_hosts', next)} label=${t('ps.webHosts')} placeholder="docs.example.com" /><//>
    <${Row} title=${t('ps.approvalTimeout')} help=${t('ps.approvalTimeoutHelp')}><input class="in mono" style="width:120px" type="number" min="1" value=${String(values['approvals.timeout_minutes'] ?? '')} onInput=${(event: Event) => set('approvals.timeout_minutes', Number((event.target as HTMLInputElement).value))} /><//>
  </section>`
}

function Extensions({ data, act, admin }: SectionProps): VNode {
  return html`<section class="stack">
    <div class="cluster"><div style="flex:1"><h2>${t('projects.extensions')}</h2><p class="help">${t('ps.extensionsHelp')}</p></div>${admin ? html`<a class="btn sm" href="#/settings/extensions">${t('ps.manageExtensions')}</a>` : null}</div>
    ${data.extensions.length === 0 ? html`<div class="panel pad"><p class="empty">${t('ps.noExtensions')}</p></div>` : null}
    <div class="ext-grid">${data.extensions.map((extension) => html`<div class="panel pad stack" style="gap:8px">
      <div class="cluster"><b class="disp" style="font-size:16px;flex:1">${extension.name}</b><span class="mono faint">${extension.version ?? ''}</span>
        <${Toggle} checked=${extension.enabled} label=${extension.name} disabled=${!admin} onChange=${(on: boolean) => act(`/ext ${on ? 'enable' : 'disable'} ${data.id} ${extension.name}`)} /></div>
      <p class="help">${extension.summary ?? ''}</p>
      ${extension.network ? html`<span class="faint" style="font-size:12px">${t('ps.extensionNetwork')}</span>` : null}
    </div>`)}</div>
  </section>`
}

function Connections({ data, act, admin }: SectionProps): VNode {
  const [adding, setAdding] = useState(false)
  const [remote, setRemote] = useState({ name: 'origin', url: '' })
  const [token, setToken] = useState<{ remote: string; value: string } | undefined>()
  const [account, setAccount] = useState('')
  const [recipients, setRecipients] = useState<string[]>([...data.mail.allowed_recipients])
  const [box, setBox] = useState('')
  const [folders, setFolders] = useState<string[]>([...data.mail.read_folders])
  const [testTo, setTestTo] = useState('')
  useEffect(() => setRecipients([...data.mail.allowed_recipients]), [data.mail.allowed_recipients.join(',')])
  const stateChip = (state: Described['mcp'][number]['state']): VNode | null =>
    state === null ? null : html`<${StateChip} state=${state === 'connected' ? 'ok' : state === 'failed' ? 'broken' : 'waiting'} label=${t(`ps.oauth.${state.replace(' ', '')}`)} />`
  return html`<section class="panel">
      <div class="pad cluster" style="padding-bottom:8px"><div style="flex:1"><h2>${t('ps.mcp')}</h2><p class="help">${t('ps.mcpHelp')}</p></div>${admin ? html`<button type="button" class="btn sm primary" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${14} />${t('ps.addServer')}</button>` : null}</div>
      ${data.mcp.length === 0 ? html`<p class="empty pad">${t('ps.noServers')}</p>` : null}
      ${data.mcp.map((server) => html`<div class="ri">
        <div class="avatar" aria-hidden="true">${server.name.slice(0, 1).toUpperCase()}</div>
        <div style="flex:1 1 220px;min-width:0"><b>${server.name}</b><div class="faint mono" style="font-size:12px;overflow-wrap:anywhere">${server.target}</div>
          ${server.extension === null ? null : html`<div class="faint" style="font-size:12px">${t('ps.fromExtension', { name: server.extension })}</div>`}
          ${Object.keys(server.tools).length === 0 ? null : html`<div class="faint" style="font-size:12px">${Object.entries(server.tools).map(([tool, access]) => `${tool} ${access}`).join(', ')}</div>`}</div>
        ${stateChip(server.state)}
        <${Seg} label=${server.name} value=${server.access} disabled=${!admin} onChange=${(next: string) => act(`/set ${data.id} mcp.${server.name}.access ${next}`)} options=${['deny', 'ask', 'allow'].map((value) => ({ value, label: t(`ps.access.${value}`), hot: value === 'allow' }))} />
        ${admin && server.oauth ? html`<button type="button" class=${`btn sm ${server.state === 'connected' ? '' : 'primary'}`} onClick=${() => act(`/mcp ${server.state === 'connected' ? 'disconnect' : 'connect'} ${data.id} ${server.name}`)}>${server.state === 'connected' ? t('ps.disconnect') : t('ps.connect')}</button>` : null}
        ${admin && server.kind === 'local' ? html`<button type="button" class="btn sm" title=${t('ps.resetHomeHelp')} onClick=${() => act(`/mcp reset ${data.id} ${server.name}`)}>${t('ps.resetHome')}</button>` : null}
        ${admin && server.extension === null ? html`<button type="button" class="btn sm icon" aria-label=${t('settings.remove')} onClick=${() => act(`/set ${data.id} mcp.${server.name} null`)}><${Icon} name="close" size=${14} /></button>` : null}
      </div>`)}
    </section>
    <section class="panel">
      <div class="pad" style="padding-bottom:8px"><h2>${t('projects.git')}</h2><p class="help">${t('projects.gitHint')}</p></div>
      ${data.git.map((entry) => html`<div class="ri">
        <div style="flex:1 1 220px;min-width:0"><b>${entry.name}</b><div class="faint mono" style="font-size:12px">${entry.url}</div></div>
        <${StateChip} state=${entry.token ? 'ok' : 'waiting'} label=${entry.token ? t('ps.tokenSaved') : t('ps.noToken')} />
        ${admin ? html`<button type="button" class="btn sm" onClick=${() => setToken({ remote: entry.name, value: '' })}>${entry.token ? t('ps.changeToken') : t('ps.addToken')}</button>
          ${entry.token ? html`<button type="button" class="btn sm" onClick=${() => act(`/git forget ${data.id} ${entry.name}`)}>${t('projects.gitForget')}</button>` : null}
          <button type="button" class="btn sm icon" aria-label=${t('settings.remove')} onClick=${() => act(`/git remove ${data.id} ${entry.name}`)}><${Icon} name="close" size=${14} /></button>` : null}
      </div>`)}
      ${admin
        ? html`<form class="ri" onSubmit=${(event: Event) => { event.preventDefault(); if (remote.url.trim().length > 0) act(`/git remote ${data.id} ${remote.name.trim() || 'origin'} ${remote.url.trim()}`) }}>
            <div class="field" style="width:120px"><label for="g-name">${t('projects.gitRemote')}</label><input id="g-name" class="mono" value=${remote.name} onInput=${(event: Event) => setRemote({ ...remote, name: (event.target as HTMLInputElement).value })} /></div>
            <div class="field" style="flex:1 1 260px"><label for="g-url">${t('projects.gitUrl')}</label><input id="g-url" class="mono" placeholder="https://github.com/owner/repo.git" value=${remote.url} onInput=${(event: Event) => setRemote({ ...remote, url: (event.target as HTMLInputElement).value })} /></div>
            <button type="submit" class="btn sm" style="align-self:flex-end">${t('ps.addRemote')}</button>
          </form>`
        : null}
    </section>
    <section class="panel">
      <div class="pad" style="padding-bottom:8px"><h2>${t('projects.mail')}</h2><p class="help">${t('projects.mailHint')}</p></div>
      <${Row} title=${t('ps.mailAccount')} help=${data.mail.account === null ? t('ps.mailNone') : t(data.mail.account.own ? 'ps.mailOwn' : 'ps.mailShared', { user: data.mail.account.user, host: data.mail.account.host })}>
        ${admin ? html`<form class="cluster" autocomplete="off" onSubmit=${(event: Event) => { event.preventDefault(); if (account.trim().length > 0) { act(`/mail set ${data.id} ${account.trim()}`); setAccount('') } }}>
          <input class="in mono" type="password" style="width:260px" aria-label=${t('projects.mailAccount')} placeholder="smtps://user:password@host:465" value=${account} onInput=${(event: Event) => setAccount((event.target as HTMLInputElement).value)} />
          <button type="submit" class="btn sm">${t('settings.save')}</button>
          ${data.mail.account?.own === true ? html`<button type="button" class="btn sm danger" onClick=${() => act(`/mail remove ${data.id}`)}>${t('projects.mailRemove')}</button>` : null}
        </form>` : null}<//>
      <${Row} wide=${true} title=${t('ps.recipients')} help=${t('ps.recipientsHelp')}>
        <div class="stack" style="gap:8px"><${ChipList} values=${recipients} onChange=${setRecipients} label=${t('ps.recipients')} placeholder="office@firma.ro" />
          ${admin && recipients.join(',') !== data.mail.allowed_recipients.join(',') ? html`<div><button type="button" class="btn sm primary" onClick=${() => act(`/set ${data.id} mail.allowed_recipients ${encode(recipients)}`)}>${t('settings.save')}</button></div>` : null}</div><//>
      ${admin && data.mail.account !== null
        ? html`<${Row} title=${t('projects.mailTest')}><form class="cluster" onSubmit=${(event: Event) => { event.preventDefault(); if (testTo.trim().length > 0) act(`/mail test ${data.id} ${testTo.trim()}`) }}>
            <input class="in" style="width:220px" aria-label=${t('projects.mailTestTo')} placeholder="you@example.com" value=${testTo} onInput=${(event: Event) => setTestTo((event.target as HTMLInputElement).value)} /><button type="submit" class="btn sm">${t('projects.mailTest')}</button></form><//>`
        : null}
      <${MailSending} data=${data} act=${act} admin=${admin} />
      <${Row} title=${t('ps.mailbox')} help=${data.mail.mailbox === null ? t('ps.mailboxNone') : t(data.mail.mailbox.own ? 'ps.mailOwn' : 'ps.mailShared', { user: data.mail.mailbox.user, host: data.mail.mailbox.host })}>
        ${admin ? html`<form class="cluster" autocomplete="off" onSubmit=${(event: Event) => { event.preventDefault(); if (box.trim().length > 0) { act(`/mail set ${data.id} ${box.trim()}`); setBox('') } }}>
          <input class="in mono" type="password" style="width:260px" aria-label=${t('ps.mailbox')} placeholder="imaps://user:password@host:993" value=${box} onInput=${(event: Event) => setBox((event.target as HTMLInputElement).value)} />
          <button type="submit" class="btn sm">${t('settings.save')}</button>
          ${data.mail.mailbox !== null ? html`<button type="button" class="btn sm" onClick=${() => act(`/mail test ${data.id} imap`)}>${t('projects.mailTest')}</button>` : null}
          ${data.mail.mailbox?.own === true ? html`<button type="button" class="btn sm danger" onClick=${() => act(`/mail remove ${data.id} imap`)}>${t('projects.mailRemove')}</button>` : null}
        </form>` : null}<//>
      ${data.mail.mailbox === null
        ? null
        : html`<${Row} wide=${true} title=${t('ps.readFolders')} help=${t('ps.readFoldersHelp')}>
            <div class="stack" style="gap:8px"><${ChipList} values=${folders} onChange=${setFolders} label=${t('ps.readFolders')} placeholder="INBOX" />
              ${admin && folders.length > 0 && folders.join(',') !== data.mail.read_folders.join(',') ? html`<div><button type="button" class="btn sm primary" onClick=${() => act(`/set ${data.id} mail.read_folders ${encode(folders)}`)}>${t('settings.save')}</button></div>` : null}</div><//>`}
    </section>
    ${adding ? html`<${AddServer} id=${data.id} act=${act} onClose=${() => setAdding(false)} />` : null}
    ${token === undefined
      ? null
      : html`<${Modal} title=${t('ps.tokenFor', { remote: token.remote })} onClose=${() => setToken(undefined)}>
          <form class="stack" autocomplete="off" onSubmit=${(event: Event) => { event.preventDefault(); if (token.value.trim().length > 0) { act(`/git token ${data.id} ${token.remote} ${token.value.trim()}`); setToken(undefined) } }}>
            <div class="field"><label for="g-token">${t('ps.token')}</label><input id="g-token" type="password" class="mono" value=${token.value} onInput=${(event: Event) => setToken({ ...token, value: (event.target as HTMLInputElement).value })} /><p class="help">${t('ps.tokenHelp')}</p></div>
            <div class="cluster" style="justify-content:flex-end"><button type="button" class="btn" onClick=${() => setToken(undefined)}>${t('common.cancel')}</button><button type="submit" class="btn primary">${t('settings.save')}</button></div>
          </form>
        <//>`}`
}

/** Who gets mail unasked and how much, the pause, and the outbox: decided in code, shown here. */
function MailSending({ data, act, admin }: Pick<SectionProps, 'data' | 'act' | 'admin'>): VNode {
  const mail = data.mail
  const [trusted, setTrusted] = useState<Record<string, number>>({ ...mail.trusted_recipients })
  const [draft, setDraft] = useState('')
  const [limits, setLimits] = useState({ max: mail.max_per_day, unattended: mail.unattended_per_day, onLimit: mail.on_limit })
  const saved = JSON.stringify(mail.trusted_recipients)
  useEffect(() => setTrusted({ ...mail.trusted_recipients }), [saved])
  useEffect(() => setLimits({ max: mail.max_per_day, unattended: mail.unattended_per_day, onLimit: mail.on_limit }), [mail.max_per_day, mail.unattended_per_day, mail.on_limit])
  const add = (): void => {
    const address = draft.trim().toLowerCase()
    if (address.includes('@') && !address.startsWith('@') && trusted[address] === undefined) setTrusted({ ...trusted, [address]: 3 })
    setDraft('')
  }
  const limitsChanged = limits.max !== mail.max_per_day || limits.unattended !== mail.unattended_per_day || limits.onLimit !== mail.on_limit
  const saveLimits = (): void => act([
    ...(limits.max === mail.max_per_day ? [] : [`/set ${data.id} mail.max_per_day ${limits.max}`]),
    ...(limits.unattended === mail.unattended_per_day ? [] : [`/set ${data.id} mail.unattended_per_day ${limits.unattended}`]),
    ...(limits.onLimit === mail.on_limit ? [] : [`/set ${data.id} mail.on_limit ${limits.onLimit}`]),
  ])
  const statusChip = (status: string): VNode => html`<${StateChip} state=${status === 'waiting' ? 'waiting' : status === 'sent' ? 'ok' : status === 'failed' ? 'broken' : 'idle'} label=${t(`ps.outbox.${status}`) === `ps.outbox.${status}` ? status : t(`ps.outbox.${status}`)} />`
  return html`
    <${Row} wide=${true} title=${t('ps.trusted')} help=${t('ps.trustedHelp')}>
      <div class="stack" style="gap:8px">
        ${Object.entries(trusted).map(([address, limit]) => html`<div class="cluster" style="gap:8px">
          <span class="mono" style="flex:1 1 200px;overflow-wrap:anywhere">${address}</span>
          <span class="faint" style="font-size:12px">${t('ps.trustedUsed', { used: mail.used.byAddress[address] ?? 0 })}</span>
          <input class="in mono" style="width:80px" type="number" min="1" aria-label=${t('ps.trustedLimit', { address })} disabled=${!admin} value=${String(limit)} onInput=${(event: Event) => setTrusted({ ...trusted, [address]: Number((event.target as HTMLInputElement).value) })} />
          ${admin ? html`<button type="button" class="btn sm icon" aria-label=${t('settings.remove')} onClick=${() => { const next = { ...trusted }; delete next[address]; setTrusted(next) }}><${Icon} name="close" size=${14} /></button>` : null}
        </div>`)}
        ${admin ? html`<div class="cluster" style="gap:6px"><input class="in" style="width:220px" aria-label=${t('ps.trusted')} placeholder="ana@firma.ro" value=${draft} onInput=${(event: Event) => setDraft((event.target as HTMLInputElement).value)} onKeyDown=${(event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} /><button type="button" class="btn sm" onClick=${add}>${t('ps.add')}</button></div>` : null}
        ${admin && JSON.stringify(trusted) !== saved ? html`<div><button type="button" class="btn sm primary" onClick=${() => act(`/set ${data.id} mail.trusted_recipients ${encode(trusted)}`)}>${t('settings.save')}</button></div>` : null}
      </div><//>
    <${Row} wide=${true} title=${t('ps.mailLimits')} help=${t('ps.mailLimitsHelp', { total: mail.used.total, unattended: mail.used.unattended })}>
      <div class="stack" style="gap:8px">
        <div class="cluster" style="gap:12px">
          <div class="field" style="width:150px"><label for="m-max">${t('ps.maxPerDay')}</label><input id="m-max" class="in mono" type="number" min="1" disabled=${!admin} value=${String(limits.max)} onInput=${(event: Event) => setLimits({ ...limits, max: Number((event.target as HTMLInputElement).value) })} /></div>
          <div class="field" style="width:150px"><label for="m-un">${t('ps.unattendedPerDay')}</label><input id="m-un" class="in mono" type="number" min="0" disabled=${!admin} value=${String(limits.unattended)} onInput=${(event: Event) => setLimits({ ...limits, unattended: Number((event.target as HTMLInputElement).value) })} /></div>
        </div>
        <div class="field"><label>${t('ps.onLimit')}</label><div><${Seg} label=${t('ps.onLimit')} value=${limits.onLimit} disabled=${!admin} onChange=${(next: 'ask' | 'block') => setLimits({ ...limits, onLimit: next })} options=${[{ value: 'ask', label: t('ps.onLimit.ask') }, { value: 'block', label: t('ps.onLimit.block') }]} /></div></div>
        ${admin && limitsChanged ? html`<div><button type="button" class="btn sm primary" onClick=${saveLimits}>${t('settings.save')}</button></div>` : null}
      </div><//>
    <${Row} title=${t('ps.unasked')} help=${mail.paused.paused ? t(mail.paused.auto ? 'ps.pausedAuto' : 'ps.paused') : t('ps.unaskedOn')}>
      <div class="cluster">
        <${StateChip} state=${mail.paused.paused ? 'paused' : 'ok'} label=${mail.paused.paused ? t('ps.pausedChip') : t('ps.onChip')} />
        ${admin ? html`<button type="button" class="btn sm" onClick=${() => act(`/mail ${mail.paused.paused ? 'resume' : 'pause'} ${data.id}`)}>${mail.paused.paused ? t('ps.resume') : t('ps.pause')}</button>` : null}
      </div><//>
    <${Row} wide=${true} title=${t('ps.outbox')} help=${mail.outbox.some((row) => row.status === 'waiting') ? t('ps.outboxWaiting') : t('ps.outboxHelp')}>
      ${mail.outbox.length === 0
        ? html`<span class="faint">${t('ps.outboxEmpty')}</span>`
        : html`<div class="stack" style="gap:6px">${mail.outbox.map((row) => html`<div class="cluster" style="gap:8px">
            <span class="mono">#${row.id}</span>${statusChip(row.status)}<span class="faint" style="font-size:12px">${when(row.at)} · ${t('ps.outboxTo', { count: row.recipients })}</span>
            ${row.why === null && row.note === null ? null : html`<span class="faint" style="font-size:12px;flex-basis:100%">${[row.why, row.note].filter((each) => each !== null).join(' · ')}</span>`}
          </div>`)}
          ${mail.outbox.some((row) => row.status === 'waiting') ? html`<div><a class="btn sm" href=${href({ name: 'inbox' })}>${t('nav.inbox')}</a></div>` : null}</div>`}<//>`
}

function AddServer({ id, act, onClose }: { id: string; act: SectionProps['act']; onClose: () => void }): VNode {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'remote' | 'local'>('remote')
  const [url, setUrl] = useState('')
  const [oauth, setOauth] = useState(true)
  const [line, setLine] = useState('')
  const valid = /^[a-z0-9][a-z0-9-]{0,40}$/.test(name) && (kind === 'remote' ? url.trim().startsWith('https://') : line.trim().length > 0)
  const save = (event: Event): void => {
    event.preventDefault()
    if (!valid) return
    const [program = '', ...args] = line.trim().split(/\s+/)
    const server = kind === 'remote' ? { url: url.trim(), ...(oauth ? { oauth: {} } : {}) } : { command: program, args }
    onClose()
    act(`/set ${id} mcp.${name} ${encode(server)}`, t('ps.serverAdded', { name }))
  }
  return html`<${Modal} title=${t('ps.addServer')} onClose=${onClose} wide=${true}>
    <form class="stack" onSubmit=${save}>
      <div class="field"><label for="s-name">${t('ps.serverName')}</label><input id="s-name" class="mono" placeholder="notion" value=${name} onInput=${(event: Event) => setName((event.target as HTMLInputElement).value.toLowerCase())} /></div>
      <${Seg} label=${t('ps.serverKind')} value=${kind} onChange=${setKind} options=${[{ value: 'remote', label: t('ps.remote') }, { value: 'local', label: t('ps.local') }]} />
      ${kind === 'remote'
        ? html`<div class="field"><label for="s-url">${t('ps.serverUrl')}</label><input id="s-url" class="mono" placeholder="https://mcp.notion.com/mcp" value=${url} onInput=${(event: Event) => setUrl((event.target as HTMLInputElement).value)} /></div>
            <div class="cluster"><${Toggle} checked=${oauth} label=${t('ps.oauthSignIn')} onChange=${setOauth} /><span>${t('ps.oauthSignIn')}</span></div>
            <p class="help">${t('ps.oauthHelp')}</p>`
        : html`<div class="field"><label for="s-line">${t('ps.serverCommand')}</label><input id="s-line" class="mono" placeholder="npx -y @modelcontextprotocol/server-memory" value=${line} onInput=${(event: Event) => setLine((event.target as HTMLInputElement).value)} /><p class="help">${t('ps.localHelp')}</p></div>`}
      <div class="cluster" style="justify-content:flex-end"><button type="button" class="btn" onClick=${onClose}>${t('common.cancel')}</button><button type="submit" class="btn primary" disabled=${!valid}>${t('ps.add')}</button></div>
    </form>
  <//>`
}

function Budget({ values, set, field }: SectionProps): VNode {
  const number = (key: string, width = 140): VNode => html`<input class="in mono" style=${`width:${width}px`} type="number" min=${field(key)?.min ?? 0} step="any" value=${String(values[key] ?? '')} onInput=${(event: Event) => set(key, Number((event.target as HTMLInputElement).value))} />`
  return html`<section class="panel">
    <div class="pad" style="padding-bottom:8px"><h2>${t('ps.budget')}</h2><p class="help">${t('ps.budgetHelp')}</p></div>
    <${Row} title=${t('ps.dayUsd')}>${number('budget.day_usd')}<//>
    <${Row} title=${t('ps.monthUsd')}>${number('budget.month_usd')}<//>
    <${Row} title=${t('ps.softPct')} help=${t('ps.softPctHelp')}>${number('budget.soft_pct', 100)}<//>
    <${Row} title=${t('ps.softAction')}><${Seg} label=${t('ps.softAction')} value=${String(values['budget.soft_action'])} onChange=${(next: string) => set('budget.soft_action', next)} options=${[{ value: 'warn', label: t('ps.soft.warn') }, { value: 'downgrade', label: t('ps.soft.downgrade') }]} /><//>
    <${Row} title=${t('ps.hardAction')}><${Seg} label=${t('ps.hardAction')} value=${String(values['budget.hard_action'])} onChange=${(next: string) => set('budget.hard_action', next)} options=${[{ value: 'pause', label: t('ps.hard.pause') }, { value: 'reject_new', label: t('ps.hard.reject') }]} /><//>
    <${Row} title=${t('ps.maxSteps')} help=${t('ps.maxStepsHelp')}>${number('limits.max_steps_total')}<//>
    <${Row} title=${t('ps.loopCheck')} help=${t('ps.loopCheckHelp')}>${number('limits.loop_check_steps')}<//>
    <${Row} title=${t('ps.onLoop')}><${Seg} label=${t('ps.onLoop')} value=${String(values['limits.on_loop'])} onChange=${(next: string) => set('limits.on_loop', next)} options=${['stop', 'notify', 'ask'].map((value) => ({ value, label: t(`ps.loop.${value}`) }))} /><//>
    <div class="pad" style="padding-bottom:4px"><h3>${t('ps.delegate')}</h3><p class="help">${t('ps.delegateHelp')}</p></div>
    <${Row} title=${t('ps.delegateModel')} help=${t('ps.delegateModelHelp')}><${Seg} label=${t('ps.delegateModel')} value=${String(values['delegate.model'])} onChange=${(next: string) => set('delegate.model', next)} options=${['sonnet', 'opus', 'haiku'].map((value) => ({ value, label: t(`ps.model.${value}`) }))} /><//>
    <${Row} title=${t('ps.delegateTurns')}>${number('delegate.max_turns')}<//>
    <${Row} title=${t('ps.delegateMinutes')}>${number('delegate.max_minutes')}<//>
    <${Row} title=${t('ps.delegateDay')}>${number('delegate.day_turns')}<//>
  </section>`
}

function Memory({ data, values, set, act, admin }: SectionProps): VNode {
  return html`<section class="panel">
    <div class="pad" style="padding-bottom:8px"><h2>${t('ps.memory')}</h2><p class="help">${t('ps.memoryHelp')}</p></div>
    ${data.memory.length === 0 ? html`<p class="empty pad">${t('ps.noMemory')}</p>` : null}
    ${data.memory.map((section) => html`<div class="ri"><div style="flex:1"><b>${section.name}</b><div class="faint" style="font-size:12px">${t('ps.chars', { count: section.chars })}</div></div>
      ${admin ? html`<button type="button" class="btn sm danger" onClick=${() => act(`/forget ${data.id} ${section.name}`)}>${t('projects.forget')}</button>` : null}</div>`)}
    <${Row} title=${t('ps.userProfile')} help=${t('ps.userProfileHelp')}><${Toggle} checked=${values['memory.user_profile'] === true} label=${t('ps.userProfile')} onChange=${(next: boolean) => set('memory.user_profile', next)} /><//>
    <div class="pad" style="padding-bottom:4px"><h3>${t('ps.undo')}</h3><p class="help">${t('ps.undoHelp')}</p></div>
    ${data.undo.length === 0 ? html`<p class="empty pad">${t('ps.noUndo')}</p>` : null}
    ${data.undo.map((point) => html`<div class="ri"><span class="mono faint">${when(point.at)}</span><span style="flex:1">${point.label ?? point.runId ?? point.id}</span>
      <button type="button" class="btn sm" onClick=${() => act(`/undo ${data.id} ${point.id}`)}>${t('ps.goBack')}</button></div>`)}
  </section>`
}

function Danger({ data, act }: SectionProps): VNode {
  return html`<section class="panel" style="border-color:var(--bad-line)">
    <div class="pad" style="padding-bottom:8px"><h2 class="bad">${t('ps.danger')}</h2></div>
    <${Row} title=${t('ps.reset')} help=${t('ps.resetHelp')}><button type="button" class="btn sm" onClick=${() => act(`/reset ${data.id}`)}>${t('ps.resetButton')}</button><//>
    <${Row} title=${t('ps.archive')} help=${t('ps.archiveHelp')}><button type="button" class="btn sm danger" onClick=${() => act(`/archive ${data.id}`)}>${t('ps.archiveButton')}</button><//>
  </section>`
}

function Advanced({ data, values, set }: SectionProps): VNode {
  const [query, setQuery] = useState('')
  const shown = data.fields.filter((field) => field.key.includes(query.toLowerCase()))
  return html`<section class="panel">
    <div class="pad stack" style="gap:10px;padding-bottom:8px"><h2>${t('ps.advanced')}</h2><p class="help">${t('ps.advancedHelp')}</p>
      <input class="in" aria-label=${t('ps.findKey')} placeholder=${t('ps.findKey')} value=${query} onInput=${(event: Event) => setQuery((event.target as HTMLInputElement).value)} /></div>
    ${shown.map((field) => html`<div class="ri" key=${field.key} style="align-items:flex-start">
      <div style="flex:1 1 240px;min-width:0"><span class="mono" style="font-weight:600">${field.key}</span>
        ${field.own === true ? html` <span class="chip" style="padding:0 7px;line-height:18px">${t('ps.own')}</span>` : field.inherited === true ? html` <span class="chip" style="padding:0 7px;line-height:18px">${t('ps.fromTemplate')}</span>` : null}
        <div class="help">${field.description ?? ''}${field.description === null ? '' : ' · '}${t('ps.default', { value: JSON.stringify(field.default) })}</div></div>
      <div style="flex:0 1 auto;max-width:100%"><${FieldEditor} field=${field} value=${values[field.key]} onChange=${(next: unknown) => set(field.key, next)} /></div>
    </div>`)}
  </section>`
}

// ── the page ───────────────────────────────────────────────────────────────

const SECTION_OF: Record<Section, (props: SectionProps) => VNode> = { general: General, tools: Tools, extensions: Extensions, connections: Connections, budget: Budget, memory: Memory, danger: Danger, advanced: Advanced }

export function ProjectSettings({ id, sec, version, instructions, admin, refresh }: { id: string; sec: string; version: number; instructions: string | null; admin: boolean; refresh: () => void }): VNode {
  const data = useData<Described>(`/api/projects/${encodeURIComponent(id)}/settings`, version)
  const [changes, setChanges] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const section: Section = (SECTIONS as readonly string[]).includes(sec) ? (sec as Section) : 'general'
  useEffect(() => setChanges({}), [id])
  if (data === undefined) return html`<p class="empty">${t('common.loading')}</p>`
  if (data === null) return html`<p class="empty">${t('projects.missing', { id })}</p>`

  const base: Record<string, unknown> = { ...Object.fromEntries(data.fields.map((field) => [field.key, field.value])), model: data.model, instructions: instructions ?? '' }
  const values = { ...base, ...changes }
  const pending = Object.keys(changes).filter((key) => JSON.stringify(changes[key]) !== JSON.stringify(base[key]))
  const set = (key: string, value: unknown): void => setChanges((current) => ({ ...current, [key]: value }))
  const act = (lines: string | readonly string[], said?: string): void =>
    void runAll(typeof lines === 'string' ? [lines] : lines).then((result) => {
      // A confirmation (archive, reset, forget) or a link (an OAuth sign-in) is answered in the dialog.
      const signIn = (typeof lines === 'string' ? lines : (lines[0] ?? '')).startsWith('/mcp connect')
      if (result.outcome !== undefined && (result.outcome.buttons.length > 0 || (signIn && result.ok) || (result.outcome.files ?? []).length > 0)) showOutcome(result.outcome)
      else if (!result.ok) toast(result.text, true)
      else toast(said ?? result.text ?? t('ps.done'))
      refresh()
    })
  const save = async (): Promise<void> => {
    setSaving(true)
    const lines = pending.map((key) =>
      key === 'model' ? `/model ${id} ${String(values[key])}` : key === 'instructions' ? `/instructions ${id} ${String(values[key]).trim() || 'clear'}` : `/set ${id} ${key} ${encode(values[key])}`,
    )
    const outcome = await runAll(lines)
    setSaving(false)
    if (outcome.ok) {
      toast(t('ps.saved', { id }))
      setChanges({})
      refresh()
    } else toast(outcome.text, true)
  }
  const label = (each: Section): string => t(`ps.sec.${each}`)
  const Body = SECTION_OF[section]
  return html`<div class="split">
    <nav aria-label=${t('ps.sections')} class="subnav">
      ${SECTIONS.map((each) => html`<a class=${`snav${each === 'danger' ? ' bad' : ''}`} aria-current=${each === section ? 'page' : undefined} href=${href({ name: 'project', id, tab: 'settings', sec: each })}>${label(each)}</a>`)}
    </nav>
    <div class="stack" style="flex:999 1 520px;min-width:0">
      <${Body} data=${data} values=${values} set=${set} field=${(key: string) => data.fields.find((each) => each.key === key)} act=${act} admin=${admin} />
      ${pending.length === 0
        ? null
        : html`<div class="savebar" role="region" aria-label=${t('ps.unsaved', { count: pending.length })}>
            <b style="flex:1">${t('ps.unsaved', { count: pending.length })}</b>
            <button type="button" class="btn sm" onClick=${() => setChanges({})}>${t('ps.discard')}</button>
            <button type="button" class="btn sm primary" disabled=${saving || !admin} onClick=${() => void save()}>${t('settings.save')}</button>
          </div>`}
    </div>
  </div>`
}
