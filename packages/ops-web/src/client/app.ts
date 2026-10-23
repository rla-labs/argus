// == ARGUS AGENT PROJECT ==
/**
 * The console's shell: the bar at the top, the navigation, the command palette, the
 * theme and the language, and the page the address names. It changes nothing itself:
 * every action is a command line or an approval answer, sent to the server, which runs
 * it as the signed-in person. What a command answers shows as a toast where you are,
 * or as a dialog when it asks to confirm or offers a file.
 */
import { html, render } from 'htm/preact'
import type { VNode } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { command, get, listen, post, SignedOut, type CommandOutcome } from './api.js'
import { initialLanguage, lang, LANGUAGES, t, loadLanguage, type Language } from './i18n.js'
import { Icon, Logo, Modal, Toasts, toast, type IconName } from './kit.js'
import { go, href, useRoute, type Route } from './router.js'
import type { PageProps } from './ui.js'
import { ProjectView } from './pages/projects.js'
import { HomeView } from './pages/home.js'
import { InboxView } from './pages/inbox.js'
import { RunsView, SchedulesView, SystemSection, TasksView } from './pages/work.js'
import {
  ChannelsSection,
  ChatView,
  CreateAdmin,
  PasswordSection,
  SettingsView,
  SetupView,
  SignIn,
  TotpSection,
  UsersView,
  type Me,
  type Overview,
  type Settings,
} from './pages/legacy.js'

// ── theme ──────────────────────────────────────────────────────────────────

type Theme = 'system' | 'light' | 'dark'

/** The viewer's theme: a convenience kept in this browser only. */
function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem('argus.theme')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset['theme']
  else document.documentElement.dataset['theme'] = theme
  try {
    localStorage.setItem('argus.theme', theme)
  } catch {
    // Not remembered; it still applies to this page.
  }
}

// ── navigation ─────────────────────────────────────────────────────────────

interface NavItem {
  readonly route: Route
  readonly icon: IconName
  readonly label: string
  /** Which routes light it up. */
  readonly names: ReadonlyArray<Route['name']>
  /** Whether the bottom bar on a phone shows it. */
  readonly phone: boolean
}

function navItems(): NavItem[] {
  return [
    { route: { name: 'home' }, icon: 'projects', label: t('nav.projects'), names: ['home', 'project'], phone: true },
    { route: { name: 'inbox' }, icon: 'inbox', label: t('nav.inbox'), names: ['inbox'], phone: true },
    { route: { name: 'sessions' }, icon: 'sessions', label: t('nav.sessions'), names: ['sessions', 'chat'], phone: true },
    { route: { name: 'schedules' }, icon: 'schedules', label: t('nav.schedules'), names: ['schedules'], phone: false },
    { route: { name: 'costs' }, icon: 'costs', label: t('nav.costs'), names: ['costs'], phone: false },
    { route: { name: 'settings', sec: '' }, icon: 'settings', label: t('nav.settings'), names: ['settings', 'setup'], phone: true },
  ]
}

/** The words under the logo: where you are. */
function crumb(route: Route): string {
  if (route.name === 'project') return `${t('nav.projects')} / ${route.id}`
  const item = navItems().find((each) => each.names.includes(route.name))
  return item?.label ?? ''
}

// ── the command palette ────────────────────────────────────────────────────

interface PaletteItem {
  readonly kind: string
  readonly label: string
  readonly hint: string
  readonly act: () => void
}

/** Jump to a project, a page or an action by typing. */
function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }): VNode {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0)
    return items.filter((item) => words.every((word) => `${item.label} ${item.hint} ${item.kind}`.toLowerCase().includes(word))).slice(0, 8)
  }, [items, query])
  const pick = (item: PaletteItem | undefined): void => {
    if (item === undefined) return
    onClose()
    item.act()
  }
  return html`<${Modal} title=${t('palette.title')} onClose=${onClose}>
    <input class="in" autofocus style="font-size:16px;min-height:48px" aria-label=${t('palette.title')} placeholder=${t('palette.placeholder')} value=${query}
      aria-controls="palette-list" aria-activedescendant=${shown[index] === undefined ? undefined : `pal-${index}`}
      onInput=${(event: Event) => { setQuery((event.target as HTMLInputElement).value); setIndex(0) }}
      onKeyDown=${(event: KeyboardEvent) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(shown.length - 1, i + 1)) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(0, i - 1)) }
        else if (event.key === 'Enter') { event.preventDefault(); pick(shown[index]) }
      }} />
    <div id="palette-list" role="listbox" aria-label=${t('palette.title')} style="display:flex;flex-direction:column;gap:2px">
      ${shown.length === 0 ? html`<p class="empty" style="padding:8px 14px">${t('palette.none')}</p>` : null}
      ${shown.map((item, i) => html`<button type="button" id=${`pal-${i}`} role="option" class="pal" aria-selected=${i === index ? 'true' : 'false'} onClick=${() => pick(item)} onMouseEnter=${() => setIndex(i)}>
        <span class="chip">${item.kind}</span><span style="flex:1">${item.label}</span><span class="faint" style="font-size:12px">${item.hint}</span>
      </button>`)}
    </div>
    <p class="faint" style="font-size:12px">${t('palette.keys')}</p>
  <//>`
}

// ── a command's answer that needs more than a toast ────────────────────────

function OutcomeDialog({ outcome, run, onClose }: { outcome: CommandOutcome; run: (line: string) => void; onClose: () => void }): VNode {
  return html`<${Modal} title=${outcome.buttons.length > 0 ? t('outcome.confirm') : t('outcome.files')} onClose=${onClose}>
    <p class="text">${outcome.text}</p>
    ${(outcome.files ?? []).map((file) => html`<a class="btn" href=${`/api/files/${encodeURIComponent(file.id)}`} download=${file.name}>${file.name}</a>`)}
    <div class="cluster" style="justify-content:flex-end">
      <button type="button" class="btn" onClick=${onClose}>${outcome.buttons.length > 0 ? t('common.cancel') : t('common.close')}</button>
      ${outcome.buttons.map((button, i) => html`<button type="button" class=${`btn ${i === 0 ? 'primary' : ''}`} onClick=${() => { onClose(); run(button.command) }}>${button.label}</button>`)}
    </div>
  <//>`
}

// ── the app ────────────────────────────────────────────────────────────────

function App(): VNode {
  const [, setLang] = useState<Language>(lang())
  const [theme, setTheme] = useState<Theme>(savedTheme)
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined)
  const [me, setMe] = useState<Me | undefined>()
  const route = useRoute()
  const [overview, setOverview] = useState<Overview | undefined>()
  const [settings, setSettings] = useState<Settings | undefined>()
  const [chatVersion, setChatVersion] = useState(0)
  const [version, setVersion] = useState(0)
  const [connected, setConnected] = useState(true)
  const [dialog, setDialog] = useState<CommandOutcome | undefined>()
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState(false)
  const menuBox = useRef<HTMLDivElement>(null)

  const guard = useCallback(async (work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      if (error instanceof SignedOut) setSignedIn(false)
      else toast(t('common.error', { message: error instanceof Error ? error.message : String(error) }), true)
    }
  }, [])
  const loadOverview = useCallback(() => guard(async () => setOverview(await get<Overview>('/api/overview'))), [guard])
  const loadSettings = useCallback(() => guard(async () => setSettings(await get<Settings>('/api/settings'))), [guard])
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
  const run = useCallback(
    (line: string) =>
      void guard(async () => {
        const outcome = await command(line)
        if (outcome.buttons.length > 0 || (outcome.files ?? []).length > 0) setDialog(outcome)
        else toast(outcome.text, outcome.error)
        setVersion((v) => v + 1)
        await Promise.all([loadOverview(), loadSettings()])
      }),
    [guard, loadOverview, loadSettings],
  )

  useEffect(() => applyTheme(theme), [theme])
  useEffect(loadMe, [loadMe])
  const restricted = me?.totpRequired === true
  useEffect(() => {
    if (signedIn !== true || restricted) return undefined
    void loadOverview()
    void loadSettings()
    // A minute's tick keeps the clocks honest between events.
    const tick = setInterval(() => void loadOverview(), 60_000)
    const stop = listen(
      (topic) => {
        if (topic === 'overview' || topic === 'settings') setVersion((v) => v + 1)
        if (topic === 'overview') void loadOverview()
        else if (topic === 'settings') {
          // A command run anywhere may have changed you (a /link from Telegram).
          void loadSettings()
          loadMe()
        } else if (topic === 'chat') setChatVersion((v) => v + 1)
      },
      setConnected,
    )
    return () => {
      clearInterval(tick)
      stop()
    }
  }, [signedIn, restricted, loadOverview, loadSettings, loadMe])

  // Ctrl+K (⌘K) opens the palette anywhere; a click elsewhere closes the account menu.
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette((open) => !open)
      }
    }
    const click = (event: MouseEvent): void => {
      if (menuBox.current !== null && !menuBox.current.contains(event.target as Node)) setMenu(false)
    }
    document.addEventListener('keydown', key)
    document.addEventListener('click', click)
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('click', click)
    }
  }, [])

  const switchLanguage = (next: Language): void => void loadLanguage(next).then(() => setLang(next))
  const signOut = (): void => void post('/api/logout', {}).then(() => setSignedIn(false))
  const admin = me?.role === 'admin'
  const can = (name: string): boolean => admin || !(me?.adminOnly ?? []).includes(name)
  const page: PageProps = { version, run, outcome: null, can }
  const pending = (overview?.approvals.length ?? 0) + (overview?.checkpoints.length ?? 0)

  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) Argus` : 'Argus'
  }, [pending])

  const languageSelect = html`<label class="sr" for="lang">${t('lang.label')}</label>
    <select id="lang" value=${lang()} onChange=${(event: Event) => switchLanguage((event.target as HTMLSelectElement).value as Language)}>
      ${LANGUAGES.map((code) => html`<option value=${code}>${t(`lang.${code}`)}</option>`)}
    </select>`

  if (signedIn === undefined) return html`<p class="empty" style="padding:40px">${t('common.loading')}</p>`
  if (!signedIn) {
    const token = location.pathname === '/setup' ? new URLSearchParams(location.search).get('token') : null
    const created = (): void => {
      history.replaceState(null, '', '/#/setup')
      loadMe()
    }
    return html`<header class="top"><span class="brand"><${Logo} /><b>ARGUS</b></span><div class="end">${languageSelect}</div></header>
      <div class="panel corners signin">${token !== null ? html`<${CreateAdmin} token=${token} onCreated=${created} />` : html`<${SignIn} onSignedIn=${loadMe} />`}</div>`
  }
  if (me !== undefined && restricted) {
    return html`<header class="top"><span class="brand"><${Logo} /><b>ARGUS</b></span><div class="end">${languageSelect}</div></header>
      <div class="signin stack"><${TotpSection} me=${me} onChanged=${loadMe} /><div><button class="btn" type="button" onClick=${signOut}>${t('nav.signout')}</button></div></div>`
  }

  const items = navItems()
  const paletteItems: PaletteItem[] = [
    ...items.map((item) => ({ kind: t('palette.page'), label: item.label, hint: '', act: () => go(item.route) })),
    ...(overview?.projects ?? []).map((project) => ({ kind: t('palette.project'), label: project.id, hint: project.description ?? '', act: () => go({ name: 'project', id: project.id, tab: 'chat', sec: '' }) })),
    { kind: t('palette.page'), label: t('nav.chat'), hint: '', act: () => go({ name: 'chat' }) },
    ...(admin ? [{ kind: t('palette.action'), label: t('system.panic'), hint: '/panic', act: () => run('/panic') }] : []),
    { kind: t('palette.action'), label: t('nav.signout'), hint: '', act: signOut },
  ]
  // What a new install still lacks: a provider key, a first project.
  const unfinished = admin && settings !== undefined && (!settings.keys.some((entry) => entry.provider !== 'telegram' && entry.configured) || settings.projects.length === 0)
  const initials = (me?.name ?? me?.login ?? '?').split(/\s+/).map((word) => word[0] ?? '').join('').slice(0, 2).toUpperCase()

  return html`
    <a class="sr" href="#main">${t('nav.skip')}</a>
    <header class="top">
      <a class="brand" href="#/"><${Logo} /><span><b>ARGUS</b><span class="crumb">${crumb(route)}</span></span></a>
      <button type="button" class="btn search" aria-label=${t('palette.title')} onClick=${() => setPalette(true)}>
        <${Icon} name="search" size=${16} /><span>${t('palette.button')}</span><span class="kbd">Ctrl K</span>
      </button>
      <div class="end">
        <span class=${`chip status ${!connected || overview?.panic === true ? 'st-broken' : 'st-running'}`}><span class="dot" aria-hidden="true"></span>${!connected ? t('status.offline') : overview?.panic === true ? t('status.panic') : t('status.online', { used: overview?.slots.used ?? 0, limit: overview?.slots.limit ?? 0 })}</span>
        <a class="btn icon" href="#/inbox" aria-label=${t('nav.inboxCount', { count: pending })}><${Icon} name="bell" />${pending > 0 ? html`<span class="badge icon-badge">${pending}</span>` : null}</a>
        ${languageSelect}
        <div ref=${menuBox} style="position:relative">
          <button type="button" class="btn icon" style="border-radius:50%;background:var(--accent-soft);font-family:var(--disp)" aria-haspopup="menu" aria-expanded=${menu ? 'true' : 'false'} aria-label=${t('account.menu')} onClick=${() => setMenu(!menu)}>${initials}</button>
          ${menu
            ? html`<div class="menu" role="menu">
                <div class="who"><b>${me?.name ?? me?.login ?? ''}</b><div class="faint" style="font-size:12px">${me?.role === 'admin' ? t('users.admin') : t('users.operator')}</div></div>
                <a role="menuitem" href="#/settings/account" onClick=${() => setMenu(false)}><${Icon} name="settings" />${t('account.mine')}</a>
                ${(['system', 'light', 'dark'] as const).map((each) => html`<button type="button" role="menuitemradio" aria-checked=${theme === each ? 'true' : 'false'} onClick=${() => setTheme(each)}><${Icon} name=${each === 'dark' ? 'moon' : each === 'light' ? 'sun' : 'settings'} />${t(`theme.${each}`)}${theme === each ? html`<span class="ok" style="margin-left:auto"><${Icon} name="check" size=${14} /></span>` : null}</button>`)}
                <button type="button" role="menuitem" onClick=${signOut}><${Icon} name="out" />${t('nav.signout')}</button>
              </div>`
            : null}
        </div>
      </div>
    </header>
    <div class="layout">
      <nav class="rail" aria-label=${t('nav.label')}>
        ${items.map((item) => html`<a class="nav" href=${href(item.route)} aria-current=${item.names.includes(route.name) ? 'page' : undefined}>
          <${Icon} name=${item.icon} />${item.label}${item.icon === 'inbox' && pending > 0 ? html`<span class="badge">${pending}</span>` : null}
        </a>`)}
      </nav>
      <main id="main" tabindex="-1">
        ${unfinished && route.name !== 'setup' ? html`<div class="callout info" role="status"><span style="flex:1">${t('setup.banner')}</span><a class="btn sm primary" href="#/setup">${t('setup.bannerLink')}</a></div>` : null}
        ${pageFor(route, { page, overview, settings, me, admin, run, loadOverview, loadMe, chatVersion })}
      </main>
    </div>
    <nav class="tabbar" aria-label=${t('nav.label')}>
      ${items.filter((item) => item.phone).map((item) => html`<a href=${href(item.route)} aria-current=${item.names.includes(route.name) ? 'page' : undefined}>
        <${Icon} name=${item.icon} size=${22} />${item.label}${item.icon === 'inbox' && pending > 0 ? html`<span class="badge">${pending}</span>` : null}
      </a>`)}
    </nav>
    ${palette ? html`<${Palette} items=${paletteItems} onClose=${() => setPalette(false)} />` : null}
    ${dialog === undefined ? null : html`<${OutcomeDialog} outcome=${dialog} run=${run} onClose=${() => setDialog(undefined)} />`}
    <${Toasts} />`
}

interface PageContext {
  readonly page: PageProps
  readonly overview: Overview | undefined
  readonly settings: Settings | undefined
  readonly me: Me | undefined
  readonly admin: boolean
  readonly run: (line: string) => void
  readonly loadOverview: () => Promise<void>
  readonly loadMe: () => void
  readonly chatVersion: number
}

/** The page a route shows. */
function pageFor(route: Route, context: PageContext): VNode | null {
  const { page, overview, settings, me, admin, run, loadOverview, loadMe } = context
  const loading = html`<p class="empty">${t('common.loading')}</p>`
  switch (route.name) {
    case 'home':
      return html`<${HomeView} ...${page} overview=${overview} admin=${admin} refresh=${() => void loadOverview()} />`
    case 'project':
      return html`<${ProjectView} key=${route.id} id=${route.id} ...${page} />`
    case 'inbox':
      return html`<${InboxView} ...${page} overview=${overview} admin=${admin} refresh=${() => void loadOverview()} />`
    case 'sessions':
      return html`<${TasksView} ...${page} />`
    case 'chat':
      return html`<${ChatView} version=${context.chatVersion} />`
    case 'schedules':
      return html`<${SchedulesView} ...${page} />`
    case 'costs':
      return html`<${RunsView} ...${page} />`
    case 'setup':
      return admin && settings !== undefined && me !== undefined ? html`<${SetupView} data=${settings} me=${me} run=${run} outcome=${null} version=${page.version} onFinish=${() => go({ name: 'home' })} />` : loading
    case 'settings':
      if (settings === undefined || me === undefined) return loading
      return html`<${SettingsView} key=${JSON.stringify(settings.defaults)} data=${settings} run=${run} outcome=${null}
          account=${html`<${PasswordSection} me=${me} onChanged=${loadMe} /><${TotpSection} me=${me} onChanged=${loadMe} /><${ChannelsSection} me=${me} run=${run} />`} />
        <${SystemSection} ...${page} panic=${overview?.panic === true} />
        ${admin ? html`<${UsersView} ...${page} />` : null}`
  }
}

applyTheme(savedTheme())
void loadLanguage(initialLanguage()).then(() => render(html`<${App} />`, document.getElementById('app') as HTMLElement))
