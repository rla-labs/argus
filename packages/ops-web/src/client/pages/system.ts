// == ARGUS AGENT PROJECT ==
/**
 * Settings: everything that is Argus's rather than one project's, in sections, with
 * nothing to write in a file. A change is a command (`/config`, `/key`, `/ext`,
 * `/template`…), checked by the server as in the chat; what waits for a restart says so.
 */
import { html } from 'htm/preact'
import type { VNode } from 'preact'
import { useMemo, useState } from 'preact/hooks'
import { post } from '../api.js'
import { t } from '../i18n.js'
import { Icon, Modal, PageHead, Seg, StateChip, Toggle, toast } from '../kit.js'
import { href } from '../router.js'
import { useData, type PageProps } from '../ui.js'
import { when } from './home.js'
import { ChannelsSection, PasswordSection, TotpSection, UsersView, type Me } from './legacy.js'
import { encode, FieldEditor, runAll, showOutcome, type Field } from './project-settings.js'
import { SystemSection } from './work.js'

interface SystemSettings {
  readonly file: string
  readonly fields: readonly (Field & { readonly set: boolean; readonly apply: 'live' | 'restart' })[]
  readonly pending: readonly string[]
  readonly restartable: boolean
}

const SECTIONS = ['account', 'access', 'models', 'secrets', 'search', 'extensions', 'templates', 'budgets', 'channels', 'users', 'security', 'language', 'health', 'advanced'] as const
type Section = (typeof SECTIONS)[number]
const ADMIN_ONLY: ReadonlySet<Section> = new Set(['access', 'models', 'secrets', 'search', 'extensions', 'templates', 'budgets', 'users', 'language', 'advanced'])

/** The first-party extensions, from the official repository. */
const FIRST_PARTY = ['office', 'browser', 'pdf', 'diagrams', 'media', 'images'] as const
const OFFICIAL = 'https://github.com/rla-labs/argus-extensions'

interface Ctx {
  readonly system: SystemSettings | undefined
  readonly version: number
  readonly act: (lines: string | readonly string[], said?: string) => void
  readonly field: (key: string) => (Field & { readonly set: boolean; readonly apply: 'live' | 'restart' }) | undefined
}

/** Settings rows for a set of `ops.yaml` keys, each saved by itself. */
function ConfigRows({ keys, ctx, labels = {} }: { keys: readonly string[]; ctx: Ctx; labels?: Readonly<Record<string, string>> }): VNode {
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  return html`${keys.map((key) => {
    const field = ctx.field(key)
    if (field === undefined) return null
    const value = key in draft ? draft[key] : field.value
    const changed = key in draft && JSON.stringify(draft[key]) !== JSON.stringify(field.value)
    const wide = field.kind === 'list' || field.kind === 'map' || field.kind === 'value'
    return html`<div class=${`ri${wide ? ' wide' : ''}`} key=${key} style="align-items:flex-start">
      <div style="flex:1 1 240px;min-width:0"><b>${labels[key] ?? key}</b>${field.apply === 'restart' ? html` <span class="chip" style="padding:0 7px;line-height:18px">${t('sys.restartTag')}</span>` : null}
        <p class="help">${field.description ?? ''}${field.description === null ? '' : ' · '}${t('ps.default', { value: JSON.stringify(field.default) })}</p></div>
      <div class="ri-control cluster" style="gap:8px">
        <${FieldEditor} field=${field} value=${value} onChange=${(next: unknown) => setDraft({ ...draft, [key]: next })} />
        ${changed ? html`<button type="button" class="btn sm primary" onClick=${() => { ctx.act(`/config ${key} ${encode(value)}`); const { [key]: _drop, ...rest } = draft; setDraft(rest) }}>${t('settings.save')}</button>` : null}
        ${field.set && !changed ? html`<button type="button" class="btn sm" title=${t('sys.resetHelp')} onClick=${() => ctx.act(`/config reset ${key}`)}>${t('sys.reset')}</button>` : null}
      </div>
    </div>`
  })}`
}

// ── access ─────────────────────────────────────────────────────────────────

function Access({ ctx }: { ctx: Ctx }): VNode {
  const publicMode = ctx.field('web.public')?.value === true
  const url = String(ctx.field('web.public_url')?.value ?? '')
  const mode: 'private' | 'tailscale' | 'public' = publicMode ? 'public' : /\.ts\.net/.test(url) ? 'tailscale' : 'private'
  const [shown, setShown] = useState(mode)
  return html`<section class="panel pad stack">
    <div><h2>${t('sys.access')}</h2><p class="help">${t('sys.accessHelp')}</p></div>
    <div class="choices">${(['private', 'tailscale', 'public'] as const).map((each) => html`<button type="button" class="choice" aria-pressed=${shown === each ? 'true' : 'false'} onClick=${() => setShown(each)}>
      <span class="radio" aria-hidden="true"></span><span><b>${t(`sys.mode.${each}`)}</b>${each === mode ? html` <span class="chip st-running" style="padding:0 7px;line-height:18px">${t('sys.now')}</span>` : null}<br /><span class="muted" style="font-size:12.5px">${t(`sys.modeHelp.${each}`)}</span></span>
    </button>`)}</div>
    ${shown === 'private' ? html`<div class="stack" style="gap:8px"><p>${t('sys.privateHow')}</p><code class="action">ssh -N -L 3091:127.0.0.1:3091 user@server</code></div>` : null}
    ${shown === 'tailscale' ? html`<div class="stack" style="gap:8px"><p>${t('sys.tailscaleHow')}</p><code class="action">sudo tailscale serve --bg 3091</code><p class="help">${t('sys.tailscaleUrl')}</p></div>` : null}
    ${shown === 'public' ? html`<div class="callout"><span class="warn"><${Icon} name="shield" /></span><div class="stack" style="gap:6px"><b>${t('sys.publicWarnTitle')}</b><span>${t('sys.publicWarn')}</span><a href="https://github.com/rla-labs/argus/blob/main/docs/user/web.md" target="_blank" rel="noopener noreferrer">${t('sys.publicGuide')}</a></div></div>` : null}
    <${ConfigRows} keys=${['web.public_url', 'web.public', 'web.session_hours', 'web.idle_minutes']} ctx=${ctx} labels=${{ 'web.public_url': t('sys.publicUrl'), 'web.public': t('sys.publicMode'), 'web.session_hours': t('sys.sessionHours'), 'web.idle_minutes': t('sys.idleMinutes') }} />
  </section>`
}

// ── models and providers ───────────────────────────────────────────────────

interface Model {
  readonly ref: string
  readonly provider: string
  readonly model: string
  readonly ready: boolean
  readonly price: { input: number; output: number; source: string } | null
}

function Models({ ctx, version }: { ctx: Ctx; version: number }): VNode {
  const models = useData<{ models: Model[] }>('/api/models', version)
  const secrets = useData<{ groups: SecretGroup[] }>('/api/secrets', version)
  const [adding, setAdding] = useState(false)
  const [modelFor, setModelFor] = useState<string | undefined>()
  const byProvider = useMemo(() => {
    const map = new Map<string, Model[]>()
    for (const model of models?.models ?? []) map.set(model.provider, [...(map.get(model.provider) ?? []), model])
    return map
  }, [models])
  const keys = secrets?.groups.find((group) => group.group === 'models')?.secrets ?? []
  const ready = [...byProvider.entries()].filter(([, list]) => list.some((model) => model.ready))
  return html`<section class="panel">
      <div class="pad cluster" style="padding-bottom:8px"><div style="flex:1"><h2>${t('sys.models')}</h2><p class="help">${t('sys.modelsHelp')}</p></div><button type="button" class="btn sm primary" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${14} />${t('sys.addProvider')}</button></div>
      ${ready.length === 0 ? html`<p class="empty pad">${t('sys.noProviders')}</p>` : null}
      ${ready.map(([provider, list]) => html`<div class="ri" style="align-items:flex-start">
        <div style="flex:1 1 260px;min-width:0"><b>${provider}</b>
          <div class="cluster" style="gap:6px;margin-top:6px">${list.slice(0, 12).map((model) => html`<span class="chip mono" style="color:var(--text)" title=${model.price === null ? t('ps.noPrice') : t('ps.price', { input: model.price.input, output: model.price.output })}>${model.model}</span>`)}${list.length > 12 ? html`<span class="faint">+${list.length - 12}</span>` : null}</div></div>
        <button type="button" class="btn sm" onClick=${() => setModelFor(provider)}>${t('sys.addModel')}</button>
        ${keys.some((key) => key.used.startsWith(provider)) ? html`<button type="button" class="btn sm" onClick=${() => ctx.act(`/key remove ${provider}`)}>${t('sys.removeKey')}</button>` : null}
      </div>`)}
    </section>
    <section class="panel">
      <div class="pad" style="padding-bottom:8px"><h2>${t('sys.defaults')}</h2><p class="help">${t('sys.defaultsHelp')}</p></div>
      <${ConfigRows} keys=${['tasks.model', 'judge.model', 'unknown_model_policy']} ctx=${ctx} labels=${{ 'tasks.model': t('sys.tasksModel'), 'judge.model': t('sys.judgeModel'), 'unknown_model_policy': t('sys.unknownModel') }} />
    </section>
    ${adding ? html`<${AddProvider} ctx=${ctx} onClose=${() => setAdding(false)} />` : null}
    ${modelFor === undefined ? null : html`<${AddModel} ctx=${ctx} provider=${modelFor} onClose=${() => setModelFor(undefined)} />`}`
}

function AddProvider({ ctx, onClose }: { ctx: Ctx; onClose: () => void }): VNode {
  const [kind, setKind] = useState<'catalog' | 'custom'>('catalog')
  const [provider, setProvider] = useState('anthropic')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [models, setModels] = useState('')
  const [key, setKey] = useState('')
  const [noKey, setNoKey] = useState(false)
  const providers = ctx.field('providers')?.value as Record<string, unknown> | undefined
  const save = (event: Event): void => {
    event.preventDefault()
    if (kind === 'catalog') {
      if (key.trim().length === 0) return
      onClose()
      ctx.act(`/key ${provider} ${key.trim()}`)
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name) || !/^https?:\/\//.test(url.trim())) return
    const entry = { base_url: url.trim(), models: models.split(/[\s,]+/).filter((each) => each.length > 0), ...(noKey ? { key: 'none' } : {}) }
    onClose()
    ctx.act([`/config providers ${encode({ ...providers, [name]: entry })}`, ...(noKey || key.trim().length === 0 ? [] : [`/key ${name} ${key.trim()}`])], t('sys.providerAdded', { name }))
  }
  return html`<${Modal} title=${t('sys.addProvider')} onClose=${onClose} wide=${true}>
    <form class="stack" autocomplete="off" onSubmit=${save}>
      <${Seg} label=${t('sys.providerKind')} value=${kind} onChange=${setKind} options=${[{ value: 'catalog', label: t('sys.fromCatalog') }, { value: 'custom', label: t('sys.compatible') }]} />
      ${kind === 'catalog'
        ? html`<div class="field"><label for="p-provider">${t('sys.provider')}</label>
            <select id="p-provider" value=${provider} onChange=${(event: Event) => setProvider((event.target as HTMLSelectElement).value)}>${['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'groq', 'mistral', 'xai', 'together', 'fireworks', 'deepinfra', 'zai'].map((each) => html`<option value=${each}>${each}</option>`)}</select>
            <p class="help">${t('sys.catalogHelp')}</p></div>`
        : html`<div class="cluster" style="gap:12px;align-items:flex-end">
              <div class="field" style="width:180px"><label for="p-name">${t('ps.serverName')}</label><input id="p-name" class="mono" placeholder="vllm-office" value=${name} onInput=${(event: Event) => setName((event.target as HTMLInputElement).value.toLowerCase())} /></div>
              <div class="field" style="flex:1 1 260px"><label for="p-url">${t('sys.baseUrl')}</label><input id="p-url" class="mono" placeholder="http://10.0.0.5:8000/v1" value=${url} onInput=${(event: Event) => setUrl((event.target as HTMLInputElement).value)} /></div>
            </div>
            <div class="field"><label for="p-models">${t('sys.modelNames')}</label><input id="p-models" class="mono" placeholder="qwen3-coder, llama3.2" value=${models} onInput=${(event: Event) => setModels((event.target as HTMLInputElement).value)} /><p class="help">${t('sys.modelNamesHelp')}</p></div>
            <div class="cluster"><${Toggle} checked=${noKey} label=${t('sys.noKeyNeeded')} onChange=${setNoKey} /><span>${t('sys.noKeyNeeded')}</span></div>`}
      ${kind === 'custom' && noKey ? null : html`<div class="field"><label for="p-key">${t('sys.apiKey')}</label><input id="p-key" type="password" class="mono" value=${key} onInput=${(event: Event) => setKey((event.target as HTMLInputElement).value)} /><p class="help">${t('sys.apiKeyHelp')}</p></div>`}
      <div class="cluster" style="justify-content:flex-end"><button type="button" class="btn" onClick=${onClose}>${t('common.cancel')}</button><button type="submit" class="btn primary">${t('ps.add')}</button></div>
    </form>
  <//>`
}

function AddModel({ ctx, provider, onClose }: { ctx: Ctx; provider: string; onClose: () => void }): VNode {
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [free, setFree] = useState(false)
  const providers = (ctx.field('providers')?.value ?? {}) as Record<string, { models?: string[] }>
  const pricing = (ctx.field('pricing')?.value ?? {}) as Record<string, unknown>
  const save = (event: Event): void => {
    event.preventDefault()
    const name = model.trim()
    if (name.length === 0) return
    const current = providers[provider] ?? {}
    const lines = [`/config providers ${encode({ ...providers, [provider]: { ...current, models: [...new Set([...(current.models ?? []), name])] } })}`]
    if (free || (input.trim().length > 0 && output.trim().length > 0)) {
      const price = free ? { input: 0, cached: 0, output: 0 } : { input: Number(input), cached: Number(input), output: Number(output) }
      lines.push(`/config pricing ${encode({ ...pricing, [`${provider}/${name}`]: price })}`)
    }
    onClose()
    ctx.act(lines, t('sys.modelAdded', { name }))
  }
  return html`<${Modal} title=${t('sys.addModelTo', { provider })} onClose=${onClose}>
    <form class="stack" onSubmit=${save}>
      <div class="field"><label for="m-name">${t('sys.modelName')}</label><input id="m-name" class="mono" value=${model} onInput=${(event: Event) => setModel((event.target as HTMLInputElement).value)} /></div>
      <p class="help">${t('sys.priceHelp')}</p>
      <div class="cluster" style="gap:12px;align-items:flex-end">
        <div class="field" style="width:140px"><label for="m-in">${t('sys.priceIn')}</label><input id="m-in" class="mono" type="number" step="any" min="0" disabled=${free} value=${input} onInput=${(event: Event) => setInput((event.target as HTMLInputElement).value)} /></div>
        <div class="field" style="width:140px"><label for="m-out">${t('sys.priceOut')}</label><input id="m-out" class="mono" type="number" step="any" min="0" disabled=${free} value=${output} onInput=${(event: Event) => setOutput((event.target as HTMLInputElement).value)} /></div>
        <span class="cluster"><${Toggle} checked=${free} label=${t('ps.free')} onChange=${setFree} />${t('ps.free')}</span>
      </div>
      <div class="cluster" style="justify-content:flex-end"><button type="button" class="btn" onClick=${onClose}>${t('common.cancel')}</button><button type="submit" class="btn primary">${t('ps.add')}</button></div>
    </form>
  <//>`
}

// ── keys and secrets ───────────────────────────────────────────────────────

interface SecretGroup {
  readonly group: string
  readonly secrets: ReadonlyArray<{ name: string; used: string; state: 'set' | 'env' | 'missing'; set: string | null; remove: string | null }>
}

/** Ask for a secret's value and run the command that saves it. */
function SecretDialog({ title, command, onClose, act }: { title: string; command: string; onClose: () => void; act: Ctx['act'] }): VNode {
  const [value, setValue] = useState('')
  const signIn = command.startsWith('/mcp connect')
  return html`<${Modal} title=${title} onClose=${onClose}>
    <form class="stack" autocomplete="off" onSubmit=${(event: Event) => { event.preventDefault(); if (signIn || value.trim().length > 0) { onClose(); act(signIn ? command : `${command} ${value.trim()}`) } }}>
      ${signIn ? html`<p>${t('sys.signInHelp')}</p>` : html`<div class="field"><label for="s-value">${t('sys.value')}</label><input id="s-value" type="password" class="mono" value=${value} onInput=${(event: Event) => setValue((event.target as HTMLInputElement).value)} /><p class="help">${t('sys.valueHelp')}</p></div>`}
      <div class="cluster" style="justify-content:flex-end"><button type="button" class="btn" onClick=${onClose}>${t('common.cancel')}</button><button type="submit" class="btn primary">${signIn ? t('ps.connect') : t('settings.save')}</button></div>
    </form>
  <//>`
}

function Secrets({ ctx, version }: { ctx: Ctx; version: number }): VNode {
  const data = useData<{ groups: SecretGroup[] }>('/api/secrets', version)
  const [asking, setAsking] = useState<{ title: string; command: string } | undefined>()
  const [custom, setCustom] = useState(false)
  const [name, setName] = useState('')
  return html`<section class="panel">
      <div class="pad cluster" style="padding-bottom:8px"><div style="flex:1"><h2>${t('sys.secrets')}</h2><p class="help">${t('sys.secretsHelp')}</p></div><button type="button" class="btn sm primary" onClick=${() => setCustom(true)}><${Icon} name="plus" size=${14} />${t('sys.addSecret')}</button></div>
      ${data === undefined ? html`<p class="empty pad">${t('common.loading')}</p>` : (data?.groups.length ?? 0) === 0 ? html`<p class="empty pad">${t('sys.noSecrets')}</p>` : null}
      ${(data?.groups ?? []).map((group) => html`<div>
        <div class="pad" style="padding:12px 18px 4px;border-top:1px solid var(--line)"><p class="lbl">${t(`sys.group.${group.group}`)}</p></div>
        ${group.secrets.map((secret) => html`<div class="ri" style="border-top:0;padding-top:8px;padding-bottom:8px">
          <span class="mono" style="flex:1 1 200px;font-weight:600;overflow-wrap:anywhere">${secret.name}</span>
          <span class="faint" style="flex:1 1 200px;font-size:12.5px;overflow-wrap:anywhere">${secret.used}</span>
          <${StateChip} state=${secret.state === 'set' ? 'ok' : secret.state === 'env' ? 'idle' : 'waiting'} label=${t(`sys.secret.${secret.state}`)} />
          ${secret.set === null || secret.state === 'env' ? null : html`<button type="button" class="btn sm" onClick=${() => setAsking({ title: secret.name, command: secret.set ?? '' })}>${secret.state === 'missing' ? t('ps.add') : t('sys.replace')}</button>`}
          ${secret.remove === null || secret.state !== 'set' ? null : html`<button type="button" class="btn sm icon" aria-label=${t('settings.remove')} onClick=${() => ctx.act(secret.remove ?? '')}><${Icon} name="close" size=${14} /></button>`}
        </div>`)}
      </div>`)}
    </section>
    ${asking === undefined ? null : html`<${SecretDialog} title=${asking.title} command=${asking.command} act=${ctx.act} onClose=${() => setAsking(undefined)} />`}
    ${custom
      ? html`<${Modal} title=${t('sys.addSecret')} onClose=${() => setCustom(false)}>
          <div class="field"><label for="c-name">${t('sys.secretName')}</label><input id="c-name" class="mono" placeholder="CRM_TOKEN" value=${name} onInput=${(event: Event) => setName((event.target as HTMLInputElement).value.toUpperCase())} /><p class="help">${t('sys.secretNameHelp')}</p></div>
          <div class="cluster" style="justify-content:flex-end"><button type="button" class="btn" onClick=${() => setCustom(false)}>${t('common.cancel')}</button>
            <button type="button" class="btn primary" disabled=${!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)} onClick=${() => { setCustom(false); setAsking({ title: name, command: `/key ${name}` }) }}>${t('sys.next')}</button></div>
        <//>`
      : null}`
}

// ── web search ─────────────────────────────────────────────────────────────

function Search({ ctx, version }: { ctx: Ctx; version: number }): VNode {
  const current = String(ctx.field('web_search.provider')?.value ?? 'deepseek')
  const secrets = useData<{ groups: SecretGroup[] }>('/api/secrets', version)
  const [asking, setAsking] = useState<string | undefined>()
  const keyed = ['tavily', 'brave', 'serper'].includes(current)
  const key = secrets?.groups.find((group) => group.group === 'search')?.secrets.find((secret) => secret.used.startsWith(`web_search: ${current}`))
  const others = (ctx.system?.fields ?? []).filter((field) => field.key.startsWith('web_search.') && field.key !== 'web_search.provider' && field.key.includes(current)).map((field) => field.key)
  return html`<section class="panel pad stack">
    <div><h2>${t('sys.search')}</h2><p class="help">${t('sys.searchHelp')}</p></div>
    <div class="choices">${(['deepseek', 'tavily', 'brave', 'serper', 'searxng'] as const).map((each) => html`<button type="button" class="choice" aria-pressed=${current === each ? 'true' : 'false'} onClick=${() => each !== current && ctx.act(`/config web_search.provider ${each}`)}>
      <span class="radio" aria-hidden="true"></span><span><b>${each}</b><br /><span class="muted" style="font-size:12.5px">${t(`sys.searchHelp.${each}`)}</span></span></button>`)}</div>
    ${keyed
      ? html`<div class="callout ${key?.state === 'missing' ? '' : 'info'}" style="align-items:center"><span style="flex:1"><b>${t('sys.searchKey', { provider: current })}</b><br /><span class="help">${key === undefined || key.state === 'missing' ? t('sys.searchKeyMissing') : t('sys.searchKeySet')}</span></span>
          <button type="button" class=${`btn sm ${key?.state === 'missing' || key === undefined ? 'primary' : ''}`} onClick=${() => setAsking(current)}>${key === undefined || key.state === 'missing' ? t('ps.add') : t('sys.replace')}</button></div>`
      : null}
    ${others.length === 0 ? null : html`<div class="panel" style="box-shadow:none"><${ConfigRows} keys=${others} ctx=${ctx} /></div>`}
    ${asking === undefined ? null : html`<${SecretDialog} title=${t('sys.searchKey', { provider: asking })} command=${`/key ${asking}`} act=${ctx.act} onClose=${() => setAsking(undefined)} />`}
  </section>`
}

// ── extensions ─────────────────────────────────────────────────────────────

interface Installed {
  readonly name: string
  readonly version: string
  readonly source: string
  readonly commit: string
  readonly installedAt: number
  readonly summary: string | null
  readonly network: boolean
  readonly secrets: readonly string[]
  readonly tools: readonly string[]
  readonly projects: readonly string[]
}

function Extensions({ ctx, version }: { ctx: Ctx; version: number }): VNode {
  const data = useData<{ extensions: Installed[] }>('/api/extensions', version)
  const [url, setUrl] = useState('')
  const installed = data?.extensions ?? []
  const missing = FIRST_PARTY.filter((name) => !installed.some((each) => each.name === name))
  return html`<section class="stack">
    <div><h2>${t('projects.extensions')}</h2><p class="help">${t('sys.extensionsHelp')}</p></div>
    <div class="ext-grid">
      ${installed.map((extension) => html`<div class="panel pad stack" style="gap:8px">
        <div class="cluster"><b class="disp" style="font-size:16px;flex:1">${extension.name}</b><span class="mono faint">${extension.version}</span><${StateChip} state="ok" label=${t('sys.installed')} /></div>
        <p class="help">${extension.summary ?? ''}</p>
        <div class="faint" style="font-size:12px">${extension.projects.length === 0 ? t('sys.usedByNone') : t('sys.usedBy', { projects: extension.projects.join(', ') })}${extension.network ? ` · ${t('sys.network')}` : ''}${extension.secrets.length === 0 ? '' : ` · ${t('sys.needs', { secrets: extension.secrets.join(', ') })}`}</div>
        <div class="faint mono" style="font-size:11.5px;overflow-wrap:anywhere">${extension.source} · ${extension.commit} · ${when(extension.installedAt)}</div>
        <div class="cluster"><button type="button" class="btn sm" onClick=${() => ctx.act(`/ext update ${extension.name}`)}>${t('sys.update')}</button>
          <button type="button" class="btn sm danger" onClick=${() => ctx.act(`/ext remove ${extension.name}`)}>${t('sys.uninstall')}</button></div>
      </div>`)}
      ${missing.map((name) => html`<div class="panel pad stack" style="gap:8px;border-style:dashed">
        <div class="cluster"><b class="disp" style="font-size:16px;flex:1">${name}</b><${StateChip} state="idle" label=${t('sys.notInstalled')} /></div>
        <p class="help">${t(`sys.ext.${name}`)}</p>
        <div class="cluster"><button type="button" class="btn sm primary" onClick=${() => ctx.act(`/ext install ${OFFICIAL}#${name}`)}>${t('sys.install')}</button></div>
      </div>`)}
    </div>
    <form class="panel pad stack" style="gap:10px" onSubmit=${(event: Event) => { event.preventDefault(); if (url.trim().length > 0) ctx.act(`/ext install ${url.trim()}`) }}>
      <b>${t('sys.otherRepo')}</b><p class="help">${t('sys.otherRepoHelp')}</p>
      <div class="cluster"><input class="in mono" style="flex:1 1 320px" aria-label=${t('sys.otherRepo')} placeholder="https://github.com/owner/repo#folder@v1.0.0" value=${url} onInput=${(event: Event) => setUrl((event.target as HTMLInputElement).value)} /><button type="submit" class="btn sm">${t('sys.install')}</button></div>
    </form>
  </section>`
}

// ── templates ──────────────────────────────────────────────────────────────

interface Template {
  readonly name: string
  readonly summary: string
  readonly description: string
  readonly instructions: string
  readonly settings: Readonly<Record<string, unknown>>
  readonly builtIn: boolean
  readonly file: boolean
  readonly followers: readonly string[]
}

const TEMPLATE_KEYS: ReadonlyArray<{ key: string; kind: Field['kind']; options?: readonly string[] }> = [
  { key: 'summary', kind: 'string' },
  { key: 'description', kind: 'string' },
  ...['read', 'write', 'shell', 'web', 'agents', 'git'].map((group) => ({ key: `tools.${group}`, kind: 'enum' as const, options: ['off', 'ask', 'allow'] })),
  { key: 'budget.day_usd', kind: 'number' },
  { key: 'budget.month_usd', kind: 'number' },
  { key: 'approvals.auto_allow', kind: 'list' },
  { key: 'limits.max_steps_total', kind: 'number' },
]

function valueAt(settings: Readonly<Record<string, unknown>>, key: string): unknown {
  return key.split('.').reduce<unknown>((at, part) => (at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined), settings)
}

function Templates({ ctx, version }: { ctx: Ctx; version: number }): VNode {
  const data = useData<{ templates: Template[] }>('/api/templates', version)
  const [open, setOpen] = useState<string | undefined>()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const templates = data?.templates ?? []
  const current = templates.find((each) => each.name === (open ?? templates[0]?.name))
  if (current === undefined) return html`<p class="empty">${t('common.loading')}</p>`
  const whole: Record<string, unknown> = { ...current.settings, summary: current.summary, description: current.description, instructions: current.instructions }
  const changed = Object.keys(draft).filter((key) => JSON.stringify(draft[key]) !== JSON.stringify(valueAt(whole, key)))
  return html`<section class="stack">
    <div class="cluster"><div style="flex:1"><h2>${t('sys.templates')}</h2><p class="help">${t('sys.templatesHelp')}</p></div><button type="button" class="btn sm primary" onClick=${() => setCreating(true)}><${Icon} name="plus" size=${14} />${t('sys.newTemplate')}</button></div>
    <div class="split">
      <section class="panel" style="flex:1 1 220px;max-width:280px;min-width:0">
        ${templates.map((template) => html`<button type="button" class="tree session" aria-current=${template.name === current.name ? 'true' : undefined} onClick=${() => { setOpen(template.name); setDraft({}) }}>
          <b>${template.name}</b><span class="faint">${template.followers.length === 0 ? t('sys.noFollowers') : t('sys.followers', { count: template.followers.length })}${template.builtIn ? ` · ${t(template.file ? 'sys.builtInChanged' : 'sys.builtIn')}` : ''}</span></button>`)}
      </section>
      <section class="panel" style="flex:999 1 420px;min-width:0">
        <div class="pad cluster" style="padding-bottom:8px"><h3 style="flex:1">${current.name}</h3>
          <button type="button" class="btn sm" onClick=${() => { setFrom(current.name); setCreating(true) }}>${t('sys.duplicate')}</button>
          ${current.file ? html`<button type="button" class="btn sm danger" onClick=${() => ctx.act(`/template remove ${current.name}`)}>${current.builtIn ? t('sys.restoreBuiltIn') : t('settings.remove')}</button>` : null}</div>
        <div class="pad" style="padding-top:0"><div class="callout info">${current.followers.length === 0 ? t('sys.reachNone') : t('sys.reach', { projects: current.followers.join(', ') })}</div></div>
        ${TEMPLATE_KEYS.map(({ key, kind, options }) => {
          const value = key in draft ? draft[key] : valueAt(whole, key)
          return html`<div class=${`ri${kind === 'list' || kind === 'string' ? ' wide' : ''}`} key=${key}><div style="flex:1 1 220px"><b class="mono">${key}</b></div>
            <div class="ri-control"><${FieldEditor} field=${{ key, kind, options: options ?? [], min: null, max: null, default: null, value, description: null }} value=${value ?? (kind === 'list' ? [] : kind === 'enum' ? 'ask' : '')} onChange=${(next: unknown) => setDraft({ ...draft, [key]: next })} /></div></div>`
        })}
        <div class="ri wide"><div><b>${t('ps.instructions')}</b><p class="help">${t('sys.templateInstructions')}</p></div>
          <div class="ri-control"><textarea class="in" rows="4" value=${String('instructions' in draft ? draft['instructions'] : current.instructions)} onInput=${(event: Event) => setDraft({ ...draft, instructions: (event.target as HTMLTextAreaElement).value })}></textarea></div></div>
        ${changed.length === 0 ? null : html`<div class="pad cluster"><button type="button" class="btn primary" onClick=${() => { ctx.act(changed.map((key) => `/template set ${current.name} ${key} ${encode(draft[key])}`), t('sys.templateSaved', { name: current.name })); setDraft({}) }}>${t('settings.save')}</button><button type="button" class="btn" onClick=${() => setDraft({})}>${t('ps.discard')}</button></div>`}
      </section>
    </div>
    ${creating
      ? html`<${Modal} title=${t('sys.newTemplate')} onClose=${() => setCreating(false)}>
          <div class="field"><label for="t-name">${t('ps.serverName')}</label><input id="t-name" class="mono" placeholder="shop" value=${name} onInput=${(event: Event) => setName((event.target as HTMLInputElement).value.toLowerCase())} /></div>
          <div class="field"><label for="t-from">${t('sys.startFrom')}</label><select id="t-from" value=${from} onChange=${(event: Event) => setFrom((event.target as HTMLSelectElement).value)}>
            <option value="">${t('newProject.blankName')}</option>${templates.map((each) => html`<option value=${each.name}>${t('sys.copyOf', { name: each.name })}</option>`)}</select></div>
          <div class="cluster" style="justify-content:flex-end"><button type="button" class="btn" onClick=${() => setCreating(false)}>${t('common.cancel')}</button>
            <button type="button" class="btn primary" disabled=${!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)} onClick=${() => { setCreating(false); setOpen(name); ctx.act(`/template new ${name}${from === '' ? '' : ` from ${from}`}`) }}>${t('ps.add')}</button></div>
        <//>`
      : null}
  </section>`
}

// ── language ───────────────────────────────────────────────────────────────

function Language({ ctx, version }: { ctx: Ctx; version: number }): VNode {
  const data = useData<{ locales: Array<{ code: string; name: string; keys: number; total: number; shipped: boolean }> }>('/api/locales', version)
  const [code, setCode] = useState('')
  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(code)) {
      toast(t('sys.codeFirst'), true)
      return
    }
    let body: unknown
    try {
      body = JSON.parse(await file.text())
    } catch {
      toast(t('ps.badJson'), true)
      return
    }
    const result = await post<{ error?: string }>(`/api/locales/${encodeURIComponent(code)}`, body)
    toast(result.ok ? t('sys.packAdded', { code }) : (result.body.error ?? t('common.error', { message: String(result.status) })), !result.ok)
    ctx.act([])
  }
  return html`<section class="panel">
    <div class="pad" style="padding-bottom:8px"><h2>${t('sys.language')}</h2><p class="help">${t('sys.languageHelp')}</p></div>
    ${(data?.locales ?? []).map((locale) => html`<div class="ri"><b style="flex:1 1 160px">${locale.name} <span class="mono faint">${locale.code}</span></b>
      <span class="faint" style="font-size:12.5px">${t('sys.coverage', { keys: locale.keys, total: locale.total })}</span>
      <div style="width:120px" class="bar"><div style=${`width:${Math.round((locale.keys / Math.max(1, locale.total)) * 100)}%`}></div></div>
      ${locale.shipped ? html`<span class="chip">${t('sys.shipped')}</span>` : html`<button type="button" class="btn sm danger" onClick=${() => void post(`/api/locales/${encodeURIComponent(locale.code)}/remove`, {}).then(() => ctx.act([]))}>${t('settings.remove')}</button>`}
    </div>`)}
    <div class="pad stack" style="gap:10px;border-top:1px solid var(--line)">
      <b>${t('sys.addPack')}</b><p class="help">${t('sys.addPackHelp')}</p>
      <div class="cluster"><input class="in mono" style="width:120px" aria-label=${t('sys.code')} placeholder="de" value=${code} onInput=${(event: Event) => setCode((event.target as HTMLInputElement).value)} />
        <label class="btn sm">${t('sys.uploadPack')}<input type="file" accept="application/json,.json" class="sr" onChange=${(event: Event) => void upload((event.target as HTMLInputElement).files?.[0])} /></label>
        <a class="btn sm" href="/locales/en.json" download="en.json">${t('sys.downloadModel')}</a></div>
    </div>
  </section>`
}

// ── the page ───────────────────────────────────────────────────────────────

export function SettingsPage({ sec, version, run, can, me, admin, panic, loadMe, refresh }: PageProps & { sec: string; me: Me; admin: boolean; panic: boolean; loadMe: () => void; refresh: () => void }): VNode {
  const system = useData<SystemSettings>('/api/settings/system', admin ? version : -1)
  const sections = SECTIONS.filter((each) => admin || !ADMIN_ONLY.has(each))
  const section: Section = (sections as readonly string[]).includes(sec) ? (sec as Section) : sections[0] ?? 'account'
  const act: Ctx['act'] = (lines, said) =>
    void runAll(typeof lines === 'string' ? [lines] : lines).then((result) => {
      if (result.outcome !== undefined && (result.outcome.buttons.length > 0 || (result.outcome.files ?? []).length > 0 || /\/oauth\/start\//.test(result.outcome.text))) showOutcome(result.outcome)
      else if (!result.ok) toast(result.text, true)
      else if (typeof lines !== 'string' && lines.length === 0) undefined
      else toast(said ?? (result.text || t('ps.done')))
      refresh()
    })
  const ctx: Ctx = { system: system ?? undefined, version, act, field: (key) => system?.fields.find((field) => field.key === key) }
  const pending = system?.pending ?? []
  return html`
    <${PageHead} title=${t('nav.settings')} sub=${t('sys.sub')} />
    ${pending.length === 0
      ? null
      : html`<div class="callout" role="status"><span class="warn"><${Icon} name="settings" /></span><div style="flex:1"><b>${t('sys.restartNeeded')}</b><div class="help">${pending.join(', ')}</div></div>
          ${system?.restartable === true ? html`<button type="button" class="btn sm primary" onClick=${() => act('/restart')}>${t('sys.restartNow')}</button>` : html`<span class="help">${t('sys.restartByHand')}</span>`}</div>`}
    <div class="split">
      <nav aria-label=${t('ps.sections')} class="subnav">
        ${sections.map((each) => html`<a class="snav" aria-current=${each === section ? 'page' : undefined} href=${href({ name: 'settings', sec: each })}>${t(`sys.sec.${each}`)}</a>`)}
      </nav>
      <div class="stack" style="flex:999 1 520px;min-width:0">
        ${section === 'account' ? html`<${PasswordSection} me=${me} onChanged=${loadMe} />` : null}
        ${section === 'access' ? html`<${Access} ctx=${ctx} />` : null}
        ${section === 'models' ? html`<${Models} ctx=${ctx} version=${version} />` : null}
        ${section === 'secrets' ? html`<${Secrets} ctx=${ctx} version=${version} />` : null}
        ${section === 'search' ? html`<${Search} ctx=${ctx} version=${version} />` : null}
        ${section === 'extensions' ? html`<${Extensions} ctx=${ctx} version=${version} />` : null}
        ${section === 'templates' ? html`<${Templates} ctx=${ctx} version=${version} />` : null}
        ${section === 'budgets' ? html`<section class="panel"><div class="pad" style="padding-bottom:8px"><h2>${t('sys.budgets')}</h2><p class="help">${t('sys.budgetsHelp')}</p></div><${ConfigRows} keys=${(system?.fields ?? []).filter((field) => field.key.startsWith('budgets.')).map((field) => field.key)} ctx=${ctx} /></section>` : null}
        ${section === 'channels' ? html`<${ChannelsSection} me=${me} run=${run} /><section class="panel"><div class="pad" style="padding-bottom:8px"><h2>Telegram</h2><p class="help">${t('sys.telegramHelp')}</p></div><${ConfigRows} keys=${(system?.fields ?? []).filter((field) => field.key.startsWith('telegram.') || field.key.startsWith('access.')).map((field) => field.key)} ctx=${ctx} /></section>` : null}
        ${section === 'users' ? html`<${UsersView} version=${version} run=${run} outcome=${null} />` : null}
        ${section === 'security' ? html`<${TotpSection} me=${me} onChanged=${loadMe} />` : null}
        ${section === 'language' ? html`<${Language} ctx=${ctx} version=${version} />` : null}
        ${section === 'health' ? html`<${SystemSection} version=${version} run=${run} can=${can} outcome=${null} panic=${panic} />` : null}
        ${section === 'advanced' ? html`<${AdvancedSystem} ctx=${ctx} />` : null}
      </div>
    </div>`
}

function AdvancedSystem({ ctx }: { ctx: Ctx }): VNode {
  const [query, setQuery] = useState('')
  const keys = (ctx.system?.fields ?? []).filter((field) => field.key.includes(query.toLowerCase()) && !['data_dir', 'config_dir', 'dsh_home'].includes(field.key)).map((field) => field.key)
  return html`<section class="panel">
    <div class="pad stack" style="gap:10px;padding-bottom:8px"><h2>${t('ps.advanced')}</h2><p class="help">${t('sys.advancedHelp', { file: ctx.system?.file ?? 'ops.yaml' })}</p>
      <input class="in" aria-label=${t('ps.findKey')} placeholder=${t('sys.findKey')} value=${query} onInput=${(event: Event) => setQuery((event.target as HTMLInputElement).value)} /></div>
    <${ConfigRows} keys=${keys} ctx=${ctx} />
  </section>`
}
