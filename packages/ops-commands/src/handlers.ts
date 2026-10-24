// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/commands/handlers` — every command implementation.
 *
 * Each handler reads against its own `syntax` line: the spec and the code are
 * deliberately adjacent, because a command whose help text drifts from its parser
 * is worse than no help text.
 *
 * @module @argus-agent/commands/handlers
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml, parseDocument, stringify as toYaml } from 'yaml'
import { OpsError, TOOL_GROUPS, keyTail, type ModelRef, type Scope } from '@argus-agent/types'
import { RUN_TRAIL_ACTION, type RunTrail } from '@argus-agent/projects'
import {
  formatAge,
  formatDuration,
  formatUsd,
  isValidProjectId,
  parseDuration,
  parseModelRef,
  parseMoney,
  parsePeriod,
  parseScope,
  renderTable,
  restAfter,
  spreadOf,
  tokenize,
  truncate,
} from './parse.js'
import {
  errorResult,
  result,
  type CommandContext,
  type CommandResult,
  type CommandSpec,
} from './types.js'
import type { UserRow } from '@argus-agent/store'
import type { CommandsOptions } from './service.js'
import { BUILT_IN_TEMPLATES, GIT_REMOTE_PATTERN, describeAccount, describeMailbox, layerTemplate, loadTemplates, parseSource, remoteUrlProblem, type ExtensionManifest, type StagedExtension } from '@argus-agent/projects'
import type { CommandHandler } from './types.js'
import { describeSchema, FIXED_SYSTEM_KEYS, LIVE_SYSTEM_KEYS, schemaAt, systemApply, type SchemaNode } from './settings.js'

/** Return a failed parse as an error that shows the syntax. */
function failWith(spec: CommandSpec, message: string): CommandResult {
  return errorResult(`${message}\n\nSyntax: ${spec.syntax}`)
}

/** What a handler needs beyond its input. */
interface Deps {
  readonly options: CommandsOptions
  /** The service, for the helpers that own shared state. */
  readonly service: {
    activeProjectOf(address: { channel: string; chatId: string; threadId?: string }): string | undefined
    requestConfirmationFor(command: string, context: CommandContext, prompt: string): CommandResult
    specs(): readonly CommandSpec[]
    confirm(token: string, accepted: boolean, context: CommandContext): Promise<CommandResult>
    systemSettings(): ReturnType<import('./service.js').OpsCommands['systemSettings']>
    runCommand(line: string, context: CommandContext): Promise<CommandResult>
  }
}

/**
 * Build every command handler.
 *
 * @param deps the services and the shared helpers.
 * @returns the handlers, in registration order.
 */
export function buildHandlers(deps: Deps): CommandHandler[] {
  const { options } = deps
  const { store, projects, meter, governor } = options
  // Resolved lazily: `/help` must list every command, including ones registered
  // after this closure was built.
  const specs = (): readonly CommandSpec[] => deps.service.specs()

  /** `/link` codes: a code attaches the channel it is sent from to the user who asked for it. */
  const linkCodes = new Map<string, { userId: string; expiresAt: number }>()
  /** Wrong `/link` codes per sender, for the lock-out. */
  const linkFails = new Map<string, number[]>()

  /** Find a user by id, `channel:id`, name or web login name (case ignored). */
  function findUser(reference: string): UserRow | undefined {
    const byId = store.users.get(reference)
    if (byId !== undefined) return byId
    const colon = reference.indexOf(':')
    if (colon > 0) {
      const identity = store.users.identity(reference.slice(0, colon), reference.slice(colon + 1))
      if (identity !== undefined) return store.users.get(identity.user_id)
    }
    const lower = reference.toLowerCase()
    const named = store.users.list().filter((user) => user.name?.toLowerCase() === lower)
    if (named.length === 1) return named[0]
    const login = store.webAuth.loginByName(reference)
    return login === undefined ? undefined : store.users.get(login.user_id)
  }

  /** How a user is shown: their name, else their web login, else the id. */
  function userLabel(user: UserRow): string {
    return user.name ?? store.webAuth.login(user.id)?.login ?? user.id
  }

  /** Resolve the project a command acts on: the argument, else the chat's active one. */
  function projectOf(argument: string | undefined, context: CommandContext): string | undefined {
    if (argument !== undefined && argument.length > 0) return argument
    return context.activeProject ?? deps.service.activeProjectOf(context.address)
  }

  /**
   * One line saying what a model costs and where the price came from — or why it
   * will be refused. Shown when a model is chosen, so the operator never has to
   * look a price up.
   */
  function priceLine(model: { provider: string; model: string }): string {
    const name = `${model.provider}/${model.model}`
    const price = meter.priceOf(model)
    if (price === undefined) {
      return meter.unknownPolicy === 'warn'
        ? `Price: unknown — accounted at $0 (unknown_model_policy: warn). Add it to pricing in ops.yaml.`
        : `Price: unknown — requests will be refused until it is added to pricing in ops.yaml.`
    }
    if (price.source === 'local') return 'Price: $0 — a local provider.'
    if (meter.needsFreeConfirmation(model)) {
      return `Price: $0 — free remote model, refused until you send /allow-free ${name}`
    }
    const where =
      price.source === 'config'
        ? 'ops.yaml'
        : price.source === 'openrouter-free'
          ? 'OpenRouter free tier, confirmed'
          : price.source === 'openrouter'
            ? price.matchedBy.includes('highest')
              ? 'OpenRouter, highest-priced provider'
              : 'OpenRouter list price'
            : price.source === 'provider-catalog'
              ? 'provider price list'
              : price.source === 'deepinfra'
                ? `DeepInfra's price list, ${price.verifiedAt ?? 'n/a'}`
                : price.source === 'models.dev'
                  ? `models.dev, ${price.verifiedAt ?? 'n/a'}; its list price, a discount not included`
                  : `catalog, verified ${price.verifiedAt ?? 'n/a'}`
    const retired = price.status === 'retired' ? ' ⚠️ its provider has retired this model.' : ''
    return `Price: $${price.input} in / $${price.output} out per 1M tokens (${where}).${retired}`
  }

  /**
   * Why a model cannot be configured, or `undefined`: the checks every project model
   * must pass (a provider route, its API key, a price). An OpenRouter model's
   * provider ceiling is fetched first, so the price shown is the one charged.
   */
  async function modelRefusal(model: { provider: string; model: string }): Promise<string | undefined> {
    await meter.ensurePriced(model)
    return projects.checkModel(model)?.message
  }

  /**
   * Write one setting into a project's file and reload; put the file back if the project
   * no longer validates.
   *
   * @param projectId the project.
   * @param change what to change in the parsed file.
   * @returns why it was not written, or undefined.
   */
  function writeSetting(projectId: string, change: (doc: ReturnType<typeof parseDocument>) => void): string | undefined {
    const file = projects.configOf(projectId)?.sourcePath
    if (file === undefined) return `No project "${projectId}".`
    const original = readFileSync(file, 'utf8')
    const doc = parseDocument(original)
    change(doc)
    writeFileSync(file, doc.toString())
    let why: string | undefined
    try {
      options.reloadProjects()
      why = projects.invalidOf(projectId)?.reason
    } catch (err) {
      why = (err as Error).message
    }
    if (why === undefined) return undefined
    writeFileSync(file, original)
    options.reloadProjects()
    return why
  }

  /**
   * `/set <project> template none | <name>`: stop following a template (its settings are
   * written into the file, so nothing changes), or follow one.
   *
   * @param projectId the project.
   * @param file its file.
   * @param name `none`, or a template's name.
   * @returns what happened.
   */
  function setTemplate(projectId: string, file: string, name: string): CommandResult {
    const loaded = projects.configOf(projectId)
    if (loaded === undefined) return errorResult(`${projectId} does not validate; fix its file first, then /reload.`)
    const { templates } = loadTemplates(options.templatesDir)
    const original = readFileSync(file, 'utf8')
    const doc = parseDocument(original)
    let done: string
    if (name === 'none') {
      const template = loaded.template === null ? undefined : templates.get(loaded.template)
      if (template === undefined) return errorResult(`${projectId} follows no template.`)
      const layered = layerTemplate(template.settings, doc.toJS() as Record<string, unknown>)
      for (const key of Object.keys(template.settings)) doc.set(key, layered[key])
      doc.delete('template')
      done = `${projectId} no longer follows the ${template.name} template: its settings are written in ${file}.`
    } else {
      if (!templates.has(name)) return errorResult(`No template "${name}". Templates: ${[...templates.keys()].join(', ')}.`)
      doc.set('template', name)
      done = `${projectId} follows the ${name} template: what its file does not set comes from it.`
    }
    writeFileSync(file, doc.toString())
    let why: string | undefined
    try {
      options.reloadProjects()
      why = projects.invalidOf(projectId)?.reason
    } catch (err) {
      why = (err as Error).message
    }
    if (why === undefined) return result(done)
    writeFileSync(file, original)
    options.reloadProjects()
    return errorResult(`Not changed. ${why}`)
  }

  /** `project:<id>` as a scope string. */
  function scopeOf(projectId: string): Scope {
    return `project:${projectId}` as Scope
  }

  /** A project row plus its live state, or a reason it is missing. */
  function projectState(projectId: string):
    | { readonly found: true; readonly id: string; readonly status: string; readonly model: string; readonly running: boolean; readonly cost: ReturnType<typeof meter.spending> }
    | { readonly found: false; readonly text: string } {
    const row = store.projects.get(projectId)
    const config = projects.configOf(projectId)
    if (row === undefined && config === undefined) {
      return { found: false, text: `No project "${projectId}". Send /projects to see them.` }
    }
    return {
      found: true,
      id: projectId,
      status: row?.status ?? 'active',
      model: row?.model ?? config?.model ?? '?',
      running: projects.isRunning({ kind: 'project', projectId }),
      cost: meter.spending(scopeOf(projectId)),
    }
  }

  /** Why a project cannot be archived now, or `undefined`. */
  function archiveRefusal(projectId: string): string | undefined {
    if (projects.configOf(projectId) === undefined && projects.invalidOf(projectId) === undefined) {
      return `No project "${projectId}". Send /projects to see them.`
    }
    if (projects.isRunning({ kind: 'project', projectId })) {
      return `${projectId} is running. Stop it first with /stop ${projectId}.`
    }
    return undefined
  }

  /**
   * `/template set|new|remove`: write a template's file in config/templates/, checked as it
   * is loaded and against the projects that follow it, else put back.
   */
  function changeTemplate(verb: 'set' | 'new' | 'remove', input: string): CommandResult {
    const [, rawName, third, fourth] = tokenize(input)
    const name = rawName?.toLowerCase()
    if (name === undefined || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return errorResult('A template name is lowercase letters, digits and dashes.')
    const dir = options.templatesDir
    const file = join(dir, `${name}.yaml`)
    const { templates } = loadTemplates(dir)
    const following = projects.configuredIds().filter((id) => projects.configOf(id)?.template === name)
    const builtIn = BUILT_IN_TEMPLATES.some((template) => template.name === name)
    const original = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    const restore = (): void => {
      if (original === undefined) rmSync(file, { force: true })
      else writeFileSync(file, original)
    }
    const check = (): string | undefined => {
      const problem = loadTemplates(dir).problems.find((line) => line.startsWith(`${name}.`))
      if (problem !== undefined) return problem
      try {
        options.reloadProjects()
      } catch (err) {
        return (err as Error).message
      }
      const broken = following.find((id) => projects.invalidOf(id) !== undefined)
      return broken === undefined ? undefined : `${broken} would not validate:\n${projects.invalidOf(broken)?.reason ?? ''}`
    }
    const whole = (template: { summary: string; description: string; instructions: string; settings: Readonly<Record<string, unknown>> }): Record<string, unknown> => ({
      summary: template.summary,
      ...(template.description.length === 0 ? {} : { description: template.description }),
      ...(template.instructions.length === 0 ? {} : { instructions: template.instructions }),
      ...template.settings,
    })

    if (verb === 'remove') {
      if (original === undefined) return errorResult(builtIn ? `${name} is built in and has no file of its own to remove.` : `No template "${name}".`)
      if (!builtIn && following.length > 0) return errorResult(`${following.join(', ')} follow${following.length === 1 ? 's' : ''} ${name}: give ${following.length === 1 ? 'it' : 'them'} another template first (/set <project> template <name>).`)
      rmSync(file)
      const why = check()
      if (why !== undefined) {
        restore()
        options.reloadProjects()
        return errorResult(`Not removed. ${why}`)
      }
      return result(builtIn ? `${name} is the built-in template again.` : `${name} is removed.`)
    }

    if (verb === 'new') {
      if (templates.has(name)) return errorResult(`There is a template "${name}" already.`)
      let content: Record<string, unknown> = { summary: name }
      if (third === 'from' && fourth !== undefined) {
        const source = templates.get(fourth.toLowerCase())
        if (source === undefined) return errorResult(`No template "${fourth}".`)
        content = { ...whole(source), summary: `${source.summary} (copy)` }
      } else if (third === 'project' && fourth !== undefined) {
        const config = projects.configOf(fourth)
        if (config === undefined) return errorResult(`No project "${fourth}".`)
        const own = (parseYaml(readFileSync(config.sourcePath, 'utf8')) ?? {}) as Record<string, unknown>
        const { id: _id, cwd: _cwd, provider: _provider, model: _model, template: _template, ...settings } = own
        const instructions = options.memory?.()?.readInstructions(config.id) ?? ''
        content = { summary: config.description ?? `Like ${config.id}`, ...settings, ...(instructions.trim().length === 0 ? {} : { instructions }) }
      } else if (third !== undefined) return errorResult('new takes from <template> or project <project-id>, or nothing for a blank one.')
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, toYaml(content))
      const why = check()
      if (why !== undefined) {
        restore()
        return errorResult(`Not made. ${why}`)
      }
      return result(`Template ${name} made: ${file}. A project from it: /new <id> ${name}.`)
    }

    // set
    const template = templates.get(name)
    if (template === undefined) return errorResult(`No template "${name}".`)
    const key = third
    const text = restAfter(input, 3).trim()
    if (key === undefined || text.length === 0) return errorResult('set needs a key and a value.')
    const top = key.split('.')[0] ?? ''
    if (['id', 'cwd', 'provider', 'model', 'template'].includes(top)) return errorResult(`A template cannot set ${top}: /new decides it.`)
    const value = settingValue(text)
    if (!value.ok) return errorResult(`"${text}" is not a valid value: ${value.message}`)
    const doc = original === undefined ? parseDocument(toYaml(whole(template))) : parseDocument(original)
    doc.setIn(key.split('.'), value.value)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, doc.toString())
    const why = check()
    if (why !== undefined) {
      restore()
      options.reloadProjects()
      return errorResult(`Not changed. ${why}`)
    }
    const reach = following.length === 0 ? 'No project follows it.' : `${following.join(', ')} follow${following.length === 1 ? 's' : ''} it, from ${following.length === 1 ? 'its' : 'their'} next message, where ${following.length === 1 ? 'its' : 'their'} own file does not set ${key}.`
    return result(`${name}: ${key} = ${JSON.stringify(value.value)}. ${reach}${['instructions', 'description'].includes(key) ? ' Instructions and the description are a new project\'s start; the projects that exist keep theirs.' : ''}`)
  }

  /**
   * Resolve a path inside a project's folder, or say why not.
   *
   * Links are followed before the check, so a symlink the agent created cannot
   * lead a command outside the folder the project is confined to.
   */
  function insideProject(
    projectId: string,
    path: string,
  ):
    | { readonly ok: true; readonly path: string; readonly relative: string; readonly shown: string }
    | { readonly ok: false; readonly text: string } {
    const cwd = projects.configOf(projectId)?.cwd
    if (cwd === undefined) return { ok: false, text: `No project "${projectId}". Send /projects to see them.` }
    let root: string
    let real: string
    try {
      root = realpathSync(cwd)
    } catch {
      return { ok: false, text: `${projectId}'s folder does not exist yet. It is created with the first run.` }
    }
    try {
      real = realpathSync(resolve(root, path))
    } catch {
      return { ok: false, text: `No "${path}" in ${projectId}'s folder. /files ${projectId} lists it.` }
    }
    if (real !== root && !real.startsWith(root + sep)) {
      return { ok: false, text: `"${path}" is outside ${projectId}'s folder.` }
    }
    const rel = relative(root, real)
    return { ok: true, path: real, relative: rel, shown: rel.length === 0 ? `${projectId}/` : `${projectId}/${rel}` }
  }

  return [
    // ── /help ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'help',
        description: 'List the commands, or explain one',
        syntax: '/help [command]',
        detail:
          'With no argument, lists every command with its one-line description. ' +
          'With a command name, shows its syntax, what it does, and examples.',
        examples: ['/help', '/help budget'],
        mutating: false,
      },
      run(input, _context): CommandResult {
        const argument = tokenize(input)[0]?.toLowerCase()
        if (argument === undefined) {
          const rows = [['Command', 'What it does']]
          for (const spec of specs()) {
            const marker = spec.requires === undefined ? '' : ' *'
            rows.push([`/${spec.name}${marker}`, spec.description])
          }
          const optional = specs().some((spec) => spec.requires !== undefined)
            ? ['', '* needs a plugin that is not installed on this deployment.']
            : []
          return result([renderTable(rows).join('\n'), ...optional].join('\n'))
        }

        const all = specs()
        const spec = all.find((entry) => entry.name === argument.replace(/^\//, ''))
        if (spec === undefined) {
          const fallback = all[0] ?? { syntax: '/help [command]' }
          return failWith({ ...fallback, syntax: '/help [command]' } as CommandSpec, `No command "${argument}".`)
        }
        const lines = [spec.syntax, '', spec.detail]
        if (spec.examples.length > 0) lines.push('', 'Examples:', ...spec.examples.map((one) => `  ${one}`))
        if (spec.requires !== undefined) lines.push('', `Requires: ${spec.requires}`)
        return result(lines.join('\n'))
      },
    },

    // ── /start ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'start',
        description: 'What to do next',
        syntax: '/start',
        detail:
          'Telegram sends it when a chat with the bot is opened. Says whether there are ' +
          'projects, which one this chat talks to, and the next step.',
        examples: ['/start'],
        mutating: false,
      },
      run(_input, context): CommandResult {
        const ids = projects.configuredIds()
        const active = projectOf(undefined, context)
        const free = options.hasOrchestrator?.() === true
        const lines = ['Argus is running.', '']
        if (ids.length === 0) {
          lines.push(
            'You have no projects yet.',
            '/new <id> creates one: a folder with its own agent, memory and budget.',
            '/task <text> runs a one-off task.',
          )
          if (free) lines.push('Or just write what you need.')
        } else {
          lines.push(`Projects: ${ids.join(', ')}.`)
          if (active !== undefined) lines.push(`Messages in this chat go to ${active}. /p <id> switches.`)
          else if (free) lines.push('Write what you need and I will route it, or pick a project with /p <id>.')
          else lines.push('Pick the project this chat talks to with /p <id>.')
        }
        lines.push('', '/help lists every command.')
        return result(lines.join('\n'))
      },
    },

    // ── /projects ──────────────────────────────────────────────────────────
    {
      spec: {
        name: 'projects',
        description: 'List every project with its state and cost',
        syntax: '/projects',
        detail:
          "Lists each project's id, status, model, whether it is running, and what it has " +
          'spent today and this month.',
        examples: ['/projects'],
        mutating: false,
      },
      run(): CommandResult {
        const ids = projects.configuredIds()
        const invalid = projects.invalidProjects()
        if (ids.length === 0 && invalid.length === 0) {
          return result('No projects yet. Create one with /new <id>.')
        }
        const now = options.now()
        const rows = [['Project', 'Status', 'State', 'Model', 'Today', 'Month']]
        for (const id of ids) {
          const state = projectState(id)
          if (!state.found) continue
          rows.push([
            id,
            state.status,
            state.running ? 'running' : 'idle',
            state.model,
            `$${formatUsd(state.cost.dayMicros)}`,
            `$${formatUsd(state.cost.monthMicros)}`,
          ])
        }
        void now
        // An invalid project is listed, not hidden: it still exists, it is only
        // ignored until its file validates.
        for (const project of invalid) {
          const cost = meter.spending(scopeOf(project.id))
          rows.push([project.id, 'invalid', '-', '-', `$${formatUsd(cost.dayMicros)}`, `$${formatUsd(cost.monthMicros)}`])
        }
        const total = meter.spending('global')
        rows.push(['', '', '', 'total', `$${formatUsd(total.dayMicros)}`, `$${formatUsd(total.monthMicros)}`])
        const note =
          invalid.length === 0
            ? ''
            : `\n\n${invalid.length} project file(s) do not validate and are ignored. Fix them, then /reload.`
        return result(renderTable(rows).join('\n') + note)
      },
    },

    // ── /p ─────────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'p',
        description: 'Show or set this chat’s active project',
        syntax: '/p [project-id]',
        detail:
          'With no argument, shows the active project. With an id, makes it the default for ' +
          'commands in this chat — so /status and /stop need no argument.',
        examples: ['/p', '/p site-firma'],
        mutating: true,
      },
      run(input, context): CommandResult {
        const argument = tokenize(input)[0]
        if (argument === undefined) {
          const active = projectOf(undefined, context)
          return active === undefined
            ? result('No active project in this chat. Set one with /p <id>.')
            : result(`Active project: ${active}`)
        }
        if (argument.toLowerCase() === 'none' || argument.toLowerCase() === 'clear') {
          store.chatContext.setActive(context.address.channel, context.address.chatId, null, context.now)
          return result('Active project cleared.')
        }
        if (store.projects.get(argument) === undefined && projects.configOf(argument) === undefined) {
          return failWith(
            { syntax: '/p [project-id]' } as CommandSpec,
            `No project "${argument}". Send /projects to see them.`,
          )
        }
        store.chatContext.setActive(context.address.channel, context.address.chatId, argument, context.now)
        return result(`Active project: ${argument}`)
      },
    },

    // ── /status ────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'status',
        description: 'Show what is running, what is queued, and the slots',
        syntax: '/status [project-id]',
        detail:
          'With an id, shows that project in detail. With none, shows the whole system: ' +
          'running runs, pending requests with the reason each is waiting, slot usage and panic mode.',
        examples: ['/status', '/status site-firma'],
        mutating: false,
      },
      run(input, context): CommandResult {
        const argument = tokenize(input)[0]
        const now = options.now()
        const status = governor.status()

        if (argument !== undefined) {
          const state = projectState(argument)
          if (!state.found) return errorResult(state.text)
          const run = status.running.find(
            (entry) => entry.owner.kind === 'project' && entry.owner.projectId === argument,
          )
          const lines = [
            `Project ${argument}`,
            `  status    ${state.status}`,
            `  model     ${state.model}`,
            `  state     ${state.running ? 'running' : 'idle'}`,
            `  today     $${formatUsd(state.cost.dayMicros)}  (${state.cost.dayTotals.requests} requests)`,
            `  month     $${formatUsd(state.cost.monthMicros)}`,
          ]
          if (run !== undefined) {
            lines.push(
              `  run       ${run.runId}`,
              `  steps     ${run.steps}`,
              `  elapsed   ${formatDuration(now - run.startedAt)}`,
            )
          }
          const budget = status.budgets.find((entry) => entry.scope === scopeOf(argument))
          if (budget !== undefined) {
            lines.push(
              `  budget    ${budget.level}${budget.pct === undefined ? '' : ` (${budget.pct.toFixed(0)}%)`}`,
            )
          }
          return result(lines.join('\n'))
        }

        const lines: string[] = []
        lines.push(`Panic mode: ${status.panic ? 'ON — nothing is admitted' : 'off'}`)
        lines.push(
          `Slots: ${status.slots.globalUsed}/${status.slots.globalLimit} global ` +
            `(${status.slots.reserved} reserved), ${status.slots.adhocUsed}/${status.slots.adhocLimit} adhoc`,
        )

        if (status.running.length === 0) {
          lines.push('', 'Nothing is running.')
        } else {
          const rows = [['Run', 'Owner', 'Model', 'Steps', 'Elapsed']]
          for (const run of status.running) {
            rows.push([
              truncate(run.runId, 12),
              ownerText(run.owner),
              run.provider,
              String(run.steps),
              formatDuration(now - run.startedAt),
            ])
          }
          lines.push('', 'Running:', ...renderTable(rows))
        }

        if (status.pending.length > 0) {
          const rows = [['Request', 'Project', 'Prio', 'Waiting', 'Blocked by']]
          for (const pending of status.pending) {
            rows.push([
              truncate(pending.requestId, 12),
              pending.projectId ?? 'adhoc',
              String(pending.priority),
              formatAge(pending.submittedAt, now),
              pending.blockedBy ?? '—',
            ])
          }
          lines.push('', 'Pending:', ...renderTable(rows))
        }

        const hot = status.budgets.filter((budget) => budget.level !== 'ok')
        if (hot.length > 0) {
          lines.push('')
          for (const budget of hot) {
            lines.push(
              `Budget ${budget.scope}: ${budget.level} ` +
                `($${formatUsd(budget.spentMicros)} of $${formatUsd(budget.limitMicros ?? 0)}, ${budget.period})`,
            )
          }
        }
        void context
        return result(lines.join('\n'))
      },
    },

    // ── /stop ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'stop',
        description: 'Cancel a project’s current turn',
        syntax: '/stop [project-id | task-run-id]',
        detail:
          'Stops the turn that is running now. Queued messages are kept, so work that has not ' +
          'started still runs. With no argument, acts on this chat’s active project. A task’s ' +
          'run id (from /runs all) stops that task.',
        examples: ['/stop', '/stop site-firma', '/stop 3f2a9c1e-…'],
        mutating: true,
      },
      run(input, context): CommandResult {
        const argument = tokenize(input)[0]
        const task = governor.status().running.find((run) => run.owner.kind === 'adhoc' && (run.runId === argument || run.owner.runId === argument))
        if (task !== undefined && task.owner.kind === 'adhoc') {
          return governor.stop({ runId: task.owner.runId }) ? result(`Stopping the task ${argument ?? ''}.`) : result(`The task ${argument ?? ''} is not running.`)
        }
        const projectId = projectOf(argument, context)
        if (projectId === undefined) {
          return failWith(
            { syntax: '/stop [project-id | task-run-id]' } as CommandSpec,
            'No project given and this chat has no active project.',
          )
        }
        if (!governor.stop({ projectId })) {
          return result(`${projectId} is not running.`)
        }
        return result(`Stopping ${projectId}. Queued messages were kept.`)
      },
    },

    // ── /task ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'task',
        description: 'Run a one-off task in a scratch folder',
        syntax: '/task <text>',
        detail:
          'Submits the text as an ad-hoc task. The text is forwarded VERBATIM — no component ' +
          'rewrites it. The task runs in its own scratch folder, not in any project.',
        examples: ['/task list the CSV files in /data and summarise them'],
        mutating: true,
      },
      run(input, context): CommandResult {
        // `restAfter(raw, 0)` keeps the text exactly as typed, including its
        // internal spacing: this is the one command whose argument is prose.
        const text = restAfter(input, 0)
        if (text.trim().length === 0) {
          return failWith({ syntax: '/task <text>' } as CommandSpec, 'A task needs some text.')
        }
        const session = randomRunId()
        const { requestId } = governor.submit({
          source: 'channel',
          target: { adhoc: { runId: session, model: governor.adhocModel() } },
          content: [{ type: 'text', text }],
          priority: 0,
          replyTo: context.address,
          model: governor.adhocModel(),
        })
        return result(`Task queued (${truncate(requestId, 8)}). I will report when it finishes. To go on with it: /session ${session} <text>.`, {
          data: { requestId, session },
        })
      },
    },

    // ── /session ───────────────────────────────────────────────────────────
    {
      spec: {
        name: 'session',
        description: 'Go on with a one-off task, or close it',
        syntax: '/session [<id> <text> | close <id>]',
        detail:
          'A one-off task keeps its agent and its folder for a day after its last message, so ' +
          'you can go on with it: it remembers the conversation, and nothing else. With ' +
          'nothing, lists the open sessions. With an id and text, sends the text to that ' +
          'session VERBATIM (a new id starts one). `close` ends it: its agent goes, and its ' +
          'folder with the files it made. A session also ends after a day without a message, ' +
          'and when Argus restarts.',
        examples: ['/session', '/session task-abc123 now sort it by price', '/session close task-abc123'],
        mutating: true,
      },
      async run(input, context): Promise<CommandResult> {
        const [first, second] = tokenize(input)
        if (first === undefined) {
          const open = projects.sessions()
          if (open.length === 0) return result('No session is open. /task <text> starts one.')
          const now = options.now()
          return result(['Open sessions:', ...open.map((session) => `  ${session.id}  ${session.running ? 'working' : `last message ${formatAge(session.lastActive, now)}`}`)].join('\n'))
        }
        if (first === 'close') {
          if (second === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'close needs a session id.')
          return (await projects.closeSession(second, context.userId)) ? result(`${second} is closed: its agent and its folder are gone.`) : errorResult(`No session ${second}.`)
        }
        if (!/^task-[a-z0-9-]{4,60}$/.test(first)) return errorResult(`"${first}" is not a session id. /session lists them.`)
        const text = restAfter(input, 1)
        if (text.trim().length === 0) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'A session needs some text.')
        const known = projects.sessions().some((session) => session.id === first)
        // An id that ran before and is not open any more ended: its memory is gone.
        if (!known && projects.sessionEnded(first)) {
          return errorResult(`${first} has ended: it was idle for a day, closed, or Argus restarted, and what it remembered is gone. /task <text> starts a new one.`)
        }
        const { requestId } = governor.submit({
          source: 'channel',
          target: { adhoc: { runId: first, model: governor.adhocModel() } },
          content: [{ type: 'text', text }],
          priority: 0,
          replyTo: context.address,
          model: governor.adhocModel(),
        })
        return result(known ? `Sent to ${first}.` : `Session ${first} started.`, { data: { requestId, session: first } })
      },
    },

    // ── /usage ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'usage',
        description: 'Show cost and tokens, with a per-model breakdown',
        syntax: '/usage [scope] [day|month]',
        detail:
          'Scope is global, adhoc or a project id; it defaults to this chat’s active project. ' +
          'The period defaults to the current day.',
        examples: ['/usage', '/usage global month', '/usage site-firma day'],
        mutating: false,
      },
      run(input, context): CommandResult {
        const tokens = tokenize(input)
        const scopeText = tokens.find((token) => parsePeriod(token) === undefined) ?? ''
        const periodText = tokens.find((token) => parsePeriod(token) !== undefined)
        const parsedScope = parseScope(scopeText, projectOf(undefined, context))
        if (!parsedScope.ok) return failWith({ syntax: '/usage [scope] [day|month]' } as CommandSpec, parsedScope.message)
        const period = periodText === undefined ? 'day' : (parsePeriod(periodText) ?? 'day')

        const labels = meter.currentLabels()
        const from = period === 'day' ? labels.day : `${labels.month}-01`
        const report = meter.report({ fromDay: from, toDay: labels.day, scope: parsedScope.value.scope as Scope })
        const rows = report.byScope.map((row) => [
          row.scope,
          `$${formatUsd(row.cost_micros)}`,
          String(row.input_tokens),
          String(row.cached_tokens),
          String(row.output_tokens),
        ])
        const byModel = meter.reportByModel({ fromDay: from, toDay: labels.day, scope: parsedScope.value.scope as Scope })
        const lines = [
          `Usage for ${parsedScope.value.scope} (${period === 'day' ? labels.day : labels.month})`,
          '',
          ...(rows.length === 0
            ? ['No usage in this period.']
            : renderTable([['Scope', 'Cost', 'In', 'Cached', 'Out'], ...rows])),
        ]
        if (byModel.length > 0) {
          lines.push(
            '',
            'By model:',
            ...renderTable([
              ['Model', 'Cost', 'Requests'],
              ...byModel.map((row) => [
                `${row.provider}/${row.model}`,
                `$${formatUsd(row.cost_micros)}`,
                String(row.requests),
              ]),
            ]),
          )
        }
        lines.push('', `Total: $${formatUsd(report.totalMicros)}`)
        return result(lines.join('\n'))
      },
    },

    // ── /runs ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'runs',
        description: 'List recent runs: how each ended and what it cost',
        syntax: '/runs [project-id | all]',
        detail:
          `Lists the last ${RUNS_SHOWN} runs: when each started, how it ended, its steps, ` +
          'how long it took and what it cost. With no argument, uses this chat’s active ' +
          'project; with none set, or with "all", lists every run, one-off tasks included.',
        examples: ['/runs', '/runs site-firma', '/runs all'],
        mutating: false,
      },
      async run(input, context): Promise<CommandResult> {
        const argument = tokenize(input)[0]
        const projectId = argument?.toLowerCase() === 'all' ? undefined : projectOf(argument, context)
        if (projectId !== undefined) {
          const state = projectState(projectId)
          if (!state.found) return errorResult(state.text)
        }
        const runs =
          projectId === undefined ? store.runs.recent(RUNS_SHOWN) : store.runs.byOwner(scopeOf(projectId), RUNS_SHOWN)
        const subject = projectId ?? 'all projects and tasks'
        if (runs.length === 0) return result(`No runs yet for ${subject}.`)

        // Usage is written in batches; a run that just ended would read as $0.
        await meter.flush()
        const now = options.now()
        const rows = [['#', ...(projectId === undefined ? ['Owner'] : []), 'Started', 'Status', 'Steps', 'Took', 'Cost']]
        for (const [index, run] of runs.entries()) {
          const cost = store.usage.totalsByRun(run.id).cost_micros
          rows.push([
            String(index + 1),
            ...(projectId === undefined ? [truncate(run.owner_key.replace(/^project:/, ''), 16)] : []),
            formatAge(run.started_at, now),
            run.status,
            String(run.steps),
            formatDuration((run.ended_at ?? now) - run.started_at),
            `$${formatUsd(cost)}`,
          ])
        }
        const again = projectId === undefined ? '/log all <#>' : `/log ${projectId} <#>`
        return result([`Recent runs: ${subject}`, '', ...renderTable(rows), '', `What one did: ${again}`].join('\n'))
      },
    },

    // ── /approvals ─────────────────────────────────────────────────────────
    {
      spec: {
        name: 'approvals',
        description: 'Show the approvals waiting for an answer, and the last decisions',
        syntax: '/approvals',
        detail:
          'Lists every action waiting for your approval, and the last decisions taken. ' +
          'Answer a waiting one with the buttons on its question; no answer before the ' +
          'timeout means no.',
        examples: ['/approvals'],
        mutating: false,
      },
      run(): CommandResult {
        const now = options.now()
        const pending = store.approvals.listPending()
        const decided = store.approvals
          .recent(APPROVALS_SHOWN * 4)
          .filter((row) => row.status !== 'pending')
          .slice(0, APPROVALS_SHOWN)

        const lines: string[] = []
        if (pending.length === 0) lines.push('Nothing is waiting for your approval.')
        else {
          lines.push(`Waiting for your answer (${pending.length}):`)
          lines.push(
            ...renderTable([
              ['Asked', 'Project', 'Action'],
              ...pending.map((row) => [formatAge(row.created_at, now), row.project_id ?? 'task', actionOf(row.request_json)]),
            ]),
          )
          lines.push('Answer with the buttons on the question. No answer by the timeout means no.')
        }
        if (decided.length > 0) {
          lines.push('', 'Last decisions:')
          lines.push(
            ...renderTable([
              ['When', 'Project', 'Action', 'Outcome', 'By'],
              ...decided.map((row) => [
                formatAge(row.decided_at ?? row.created_at, now),
                row.project_id ?? 'task',
                actionOf(row.request_json),
                row.status,
                row.decided_by ?? 'policy',
              ]),
            ]),
          )
        }
        return result(lines.join('\n'))
      },
    },

    // ── /memory ────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'memory',
        description: 'Show what a project remembers',
        syntax: '/memory [project-id]',
        detail:
          'Shows the project’s durable memory, the notes it keeps across resets. With no ' +
          'argument, uses this chat’s active project. A long memory is sent as a file.',
        examples: ['/memory', '/memory site-firma'],
        mutating: false,
        requires: 'ops-memory',
      },
      run(input, context): CommandResult {
        const memory = options.memory?.()
        if (memory === undefined) return errorResult('Project memory (ops-memory) is not installed on this deployment.')
        const projectId = projectOf(tokenize(input)[0], context)
        if (projectId === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'No project given and this chat has no active project.')
        }
        const state = projectState(projectId)
        if (!state.found) return errorResult(state.text)
        const text = memory.readMemory(projectId).trim()
        if (text.length === 0) return result(`${projectId} has no memory yet. It writes notes there as it works.`)
        if (text.length > MEMORY_INLINE_CHARS) {
          return result(`${projectId}'s memory is ${text.length} characters, attached as a file.`, {
            files: [{ name: `${projectId}-MEMORY.md`, content: text }],
          })
        }
        return result(`Memory of ${projectId}:\n\n${text}`)
      },
    },

    // ── /instructions ──────────────────────────────────────────────────────
    {
      spec: {
        name: 'instructions',
        description: 'See or change what a project is told to do (admin to change)',
        syntax: '/instructions [project-id] | /instructions <project-id> <text…> | /instructions <project-id> clear',
        detail:
          'A project’s instructions are in its agent’s system prompt on every request: its ' +
          'role, its rules, how to answer. With a project and text, the text (every line ' +
          'after the id) replaces them and applies from the next request. clear removes ' +
          'them. With no project, shows this chat’s active one’s. The agent cannot change ' +
          'them; it keeps its own notes in /memory. Changing them is the admin’s.',
        examples: ['/instructions', '/instructions site-firma', '/instructions site-firma Answer in Romanian. Never touch the blog/ folder.'],
        // Not audited here: the memory service audits every change, and a view is no change.
        mutating: false,
        requires: 'ops-memory',
      },
      run(input, context): CommandResult {
        const memory = options.memory?.()
        if (memory === undefined) return errorResult('Project instructions need ops-memory, which is not installed on this deployment.')
        const match = /^\s*(\S+)(?:\s+([\s\S]*\S))?\s*$/.exec(input)
        const projectId = projectOf(match?.[1], context)
        if (projectId === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'No project given and this chat has no active project.')
        }
        const state = projectState(projectId)
        if (!state.found) return errorResult(state.text)
        const text = match?.[2]
        if (text === undefined) {
          const current = memory.readInstructions(projectId).trim()
          if (current.length === 0) return result(`${projectId} has no instructions. Give it some: /instructions ${projectId} <text>`)
          if (current.length > MEMORY_INLINE_CHARS) {
            return result(`${projectId}'s instructions are ${current.length} characters, attached as a file.`, { files: [{ name: `${projectId}-INSTRUCTIONS.md`, content: current }] })
          }
          return result(`Instructions of ${projectId}:\n\n${current}`)
        }
        if (!context.isAdmin) return errorResult('Only the admin can change a project’s instructions.')
        const written = memory.writeInstructions(projectId, text.toLowerCase() === 'clear' ? '' : text, context.userId)
        if (!written.ok) return errorResult(written.message)
        return result(written.bytes === 0 ? `${projectId}: instructions removed.` : `${projectId}: instructions saved (${written.bytes} bytes). They apply from its next request.`)
      },
    },

    // ── /skill ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'skill',
        description: 'See a project\'s skills, or add and remove one (admin)',
        syntax: '/skill [project-id] | /skill add <project-id> <name> <text…> | /skill remove <project-id> <name>',
        detail:
          'A skill is a how-to its agent loads when a task calls for it: the agent sees each ' +
          'skill\'s name and first line, and reads the rest on demand. A project\'s skills are ' +
          'kept outside its folder, so its agent cannot write itself one. add takes the ' +
          'SKILL.md text on the lines after the name: either a file with its own front matter ' +
          '(name, description), or plain text whose first line is the description. It applies ' +
          'from the agent\'s next step. Adding and removing are the admin\'s.',
        examples: ['/skill site-firma', '/skill add site-firma deploy Deploy the site to production.\nRun npm run build, then rsync dist/ to the server.', '/skill remove site-firma deploy'],
        mutating: true,
      },
      run(input, context): CommandResult {
        const match = /^\s*(add|remove)\s+(\S+)\s+(\S+)(?:[ \t]+|\s*\n)?([\s\S]*)$/.exec(input)
        const action = match?.[1]
        const projectId = action === undefined ? projectOf(tokenize(input)[0], context) : match?.[2]
        if (projectId === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'No project given and this chat has no active project.')
        const state = projectState(projectId)
        if (!state.found) return errorResult(state.text)
        const dir = projects.skillsDirOf(projectId)
        if (dir === undefined) return errorResult('Skills need the state directory, which this deployment does not have.')
        if (action === undefined) {
          const skills = existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, 'SKILL.md'))).sort() : []
          if (skills.length === 0) return result(`${projectId} has no skills. Add one: /skill add ${projectId} <name> <text>`)
          const lines = skills.map((name) => `  ${name.padEnd(20)} ${/^description:\s*(.*)$/m.exec(readFileSync(join(dir, name, 'SKILL.md'), 'utf8'))?.[1]?.trim() ?? ''}`)
          return result(`Skills of ${projectId}:\n${lines.join('\n')}\n\nKept in ${dir}.`)
        }
        if (!context.isAdmin) return errorResult('Only the admin can change a project’s skills.')
        const name = match?.[3] ?? ''
        if (!SKILL_NAME.test(name)) return errorResult(`"${name}" is not a skill name: lowercase letters, digits and dashes, up to 64.`)
        const folder = join(dir, name)
        if (action === 'remove') {
          if (!existsSync(folder)) return errorResult(`${projectId} has no skill "${name}".`)
          rmSync(folder, { recursive: true, force: true })
          return result(`${projectId}: skill ${name} removed.`)
        }
        const skill = skillFile(name, match?.[4] ?? '')
        if (!skill.ok) return errorResult(skill.message)
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, 'SKILL.md'), skill.text)
        return result(`${projectId}: skill ${name} saved (${Buffer.byteLength(skill.text)} bytes). Its agent sees it from its next step.`)
      },
    },

    // ── /estimate ──────────────────────────────────────────────────────────
    {
      spec: {
        name: 'estimate',
        description: 'What a run of a project usually costs, and how many the budget leaves',
        syntax: '/estimate [project-id | tasks]',
        detail:
          'From the project’s last finished runs (up to 30): what a typical run cost, a big ' +
          'one (the 90th percentile) and the largest, with their steps and time; then what ' +
          'is left of its budget and how many typical and big runs that is. tasks does the ' +
          'same for one-off tasks. It is history, not a forecast: a task unlike the past ' +
          'ones can cost more. With no argument, uses this chat’s active project.',
        examples: ['/estimate', '/estimate site-firma', '/estimate tasks'],
        mutating: false,
      },
      run(input, context): CommandResult {
        const argument = tokenize(input)[0]
        const tasks = argument?.toLowerCase() === 'tasks'
        const projectId = tasks ? undefined : projectOf(argument, context)
        if (!tasks && projectId === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'No project given and this chat has no active project.')
        }
        let model: ModelRef
        let scope: Scope
        let runs: ReturnType<typeof store.runs.recent>
        if (projectId !== undefined) {
          const state = projectState(projectId)
          if (!state.found) return errorResult(state.text)
          const config = projects.configOf(projectId)
          model = config === undefined ? governor.adhocModel() : { provider: config.provider, model: config.model }
          scope = scopeOf(projectId)
          runs = store.runs.byOwner(scope, ESTIMATE_RUNS * 2)
        } else {
          model = governor.adhocModel()
          scope = 'adhoc' as Scope
          runs = store.runs.recent(ESTIMATE_RUNS * 10).filter((run) => run.owner_key.startsWith('adhoc:'))
        }
        const name = projectId ?? 'Tasks'
        const finished = runs
          .filter((run) => run.ended_at !== null && run.status !== 'running')
          .slice(0, ESTIMATE_RUNS)
          .map((run) => ({ cost: store.usage.totalsByRun(run.id).cost_micros, steps: run.steps, ms: (run.ended_at as number) - run.started_at }))
          .filter((run) => run.cost > 0)
        const price = priceLine(model)
        const cost = spreadOf(finished.map((run) => run.cost))
        if (cost === undefined) {
          return result(`${name}: no finished run with a cost yet, so nothing to go by.\n${model.provider}/${model.model}. ${price}`)
        }
        const steps = spreadOf(finished.map((run) => run.steps)) as { typical: number; big: number }
        const time = spreadOf(finished.map((run) => run.ms)) as { typical: number; big: number }
        const lines = [
          `${name}: from its last ${finished.length} finished run${finished.length === 1 ? '' : 's'}, on ${model.provider}/${model.model}`,
          `  typical  $${formatUsd(cost.typical)}  (${steps.typical} steps, ${formatDuration(time.typical)})`,
          `  big      $${formatUsd(cost.big)}  (${steps.big} steps, ${formatDuration(time.big)})`,
          `  largest  $${formatUsd(cost.most)}`,
        ]
        const budget = governor.budgetState(scope, options.now())
        if (budget.limitMicros !== undefined) {
          const left = Math.max(0, Number(budget.limitMicros) + Number(budget.overrideMicros) - Number(budget.spentMicros))
          const runsOf = (each: number): number => (each > 0 ? Math.floor(left / each) : 0)
          lines.push(`Left this ${budget.period}: $${formatUsd(left)}, about ${runsOf(cost.typical)} typical or ${runsOf(cost.big)} big runs.`)
        } else {
          lines.push('Its budget is unlimited.')
        }
        lines.push(price, 'This is history, not a forecast: work unlike the past runs can cost more.')
        return result(lines.join('\n'))
      },
    },

    // ── /log ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'log',
        description: 'Show what one run did: the request, the tools, the reply',
        syntax: '/log [project-id | all] [#]',
        detail:
          'Shows one run: what was asked, the tools it called (failed ones marked ✗), the ' +
          'approvals it asked for, the start of its reply, and what it cost. # is the run’s ' +
          'number in /runs, 1 for the latest, which is the default. With no project, uses ' +
          'this chat’s active one; with none set, or with "all", counts every run.',
        examples: ['/log', '/log site-firma', '/log site-firma 3', '/log all 2'],
        mutating: false,
      },
      async run(input, context): Promise<CommandResult> {
        const tokens = tokenize(input)
        const last = tokens[tokens.length - 1]
        const position = last !== undefined && /^\d+$/.test(last) ? Number(tokens.pop()) : 1
        const argument = tokens[0]
        const projectId = argument?.toLowerCase() === 'all' ? undefined : projectOf(argument, context)
        if (projectId !== undefined) {
          const state = projectState(projectId)
          if (!state.found) return errorResult(state.text)
        }
        if (position < 1 || position > RUNS_SHOWN) return errorResult(`# is a run's number in /runs, 1 to ${RUNS_SHOWN}.`)
        const runs = projectId === undefined ? store.runs.recent(position) : store.runs.byOwner(scopeOf(projectId), position)
        const run = runs[position - 1]
        if (run === undefined) return errorResult(`There is no run #${position} for ${projectId ?? 'all projects and tasks'}. See /runs.`)

        await meter.flush()
        const now = options.now()
        const usage = store.usage.totalsByRun(run.id)
        const owner = run.owner_key.replace(/^project:/, '')
        const lines = [
          `Run #${position} of ${owner}: ${run.status}${run.stop_reason === null ? '' : ` (${run.stop_reason})`}`,
          `Started ${formatAge(run.started_at, now)}, took ${formatDuration((run.ended_at ?? now) - run.started_at)}, ` +
            `${run.steps} step(s), ${run.provider}/${run.model}, $${formatUsd(usage.cost_micros)}`,
        ]
        const request = run.inbound_id === null ? undefined : store.inbound.get(run.inbound_id)
        const asked = request === undefined ? undefined : requestText(request.payload)
        if (asked !== undefined) lines.push('', `Asked: ${truncate(asked, LOG_REQUEST_CHARS)}`)

        const trailRow = store.audit.byTarget(`run:${run.id}`, 10).find((row) => row.action === RUN_TRAIL_ACTION)
        const trail = trailRow?.details_json == null ? undefined : (JSON.parse(trailRow.details_json) as RunTrail)
        if (trail !== undefined && trail.tools.length > 0) {
          lines.push('', `Tools (${trail.toolsTotal}):`)
          for (const [index, tool] of trail.tools.entries()) {
            lines.push(`${index + 1}. ${tool.name}${tool.arg.length > 0 ? `: ${tool.arg}` : ''}${tool.failed ? ' ✗' : ''}`)
          }
          if (trail.toolsTotal > trail.tools.length) lines.push(`… and ${trail.toolsTotal - trail.tools.length} more`)
        } else if (trail !== undefined) {
          lines.push('', 'No tools: it answered directly.')
        }

        const approvals = store.approvals.byRun(run.id)
        if (approvals.length > 0) {
          lines.push('', 'Approvals:')
          for (const approval of approvals) lines.push(`- ${truncate(actionOf(approval.request_json), 80)}: ${approval.status}`)
        }

        if (trail !== undefined && trail.reply.length > 0) lines.push('', 'Reply:', trail.reply)
        if (trail === undefined) {
          lines.push('', run.status === 'running' ? 'Still running: the tools and the reply show here when it ends.' : 'No details were kept for this run.')
        }
        return result(lines.join('\n'))
      },
    },

    // ── /undo ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'undo',
        description: 'Put a project’s folder back as it was before a run',
        syntax: '/undo [project-id] [list | # | run-id]',
        detail:
          'Before each run Argus records the project’s folder. /undo puts it back as it was ' +
          'before the last run: changed and deleted files return, files the run created go. ' +
          'list shows the last 20 runs, with what each changed; # (from the list) or a run id ' +
          'goes back further. The state an undo replaces is recorded too, so an undo can be ' +
          'undone. Skipped, and left alone: node_modules, .venv, dist, what .gitignore and ' +
          '.argusignore list, and files over snapshots.max_file_mb. Not while the project runs.',
        examples: ['/undo site-firma', '/undo site-firma list', '/undo site-firma 3'],
        mutating: true,
      },
      async run(input, context): Promise<CommandResult> {
        const tokens = tokenize(input)
        const named = tokens[0] !== undefined && (projects.configOf(tokens[0]) !== undefined || store.projects.get(tokens[0]) !== undefined)
        const projectId = named ? tokens.shift() : projectOf(undefined, context)
        if (projectId === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'No project given and this chat has no active project.')
        const state = projectState(projectId)
        if (!state.found) return errorResult(state.text)
        const which = tokens[0]
        try {
          const entries = await projects.undoList(projectId)
          if (which?.toLowerCase() === 'list') {
            if (entries.length === 0) return result(`${projectId} has no snapshots yet: one is taken before each run.`)
            const now = options.now()
            const lines = [`Snapshots of ${projectId}, newest first (/undo ${projectId} # goes back to before that one):`]
            for (const [index, entry] of entries.entries()) {
              const what = entry.kind === 'undo' ? 'the state an undo replaced' : `run ${truncate(entry.id, 8)}`
              const asked = entry.kind === 'run' ? store.inbound.get(entry.id) : undefined
              const text = asked === undefined ? undefined : requestText(asked.payload)
              const { files, added, removed } = entry.changes
              const changed = files === 0 ? 'no changes' : `${files} file(s), +${added} −${removed}`
              lines.push(`${index + 1}. ${formatAge(entry.at, now)}: ${what}; since then ${changed}${text === undefined ? '' : `\n   Asked: ${truncate(text.split('\n')[0] ?? '', 80)}`}`)
            }
            return result(lines.join('\n'))
          }
          if (state.running) return errorResult(`${projectId} is running. Stop it first with /stop ${projectId}, then /undo.`)
          const target =
            which === undefined
              ? undefined
              : /^\d+$/.test(which)
                ? entries[Number(which) - 1]?.id
                : entries.find((entry) => entry.id === which || entry.id.startsWith(which))?.id
          if (which !== undefined && target === undefined) return errorResult(`No snapshot "${which}" for ${projectId}. See /undo ${projectId} list.`)
          const restored = await projects.undo(projectId, target)
          if (restored === undefined) return result(`${projectId} has no snapshots yet: one is taken before each run.`)
          const what = restored.kind === 'undo' ? 'the state an earlier undo replaced' : `before run ${truncate(restored.id, 8)}`
          return result(`${projectId} is back to ${what} (${formatAge(restored.at, options.now())}). To undo this, see /undo ${projectId} list.`)
        } catch (error) {
          if (error instanceof OpsError) return errorResult(error.message)
          throw error
        }
      },
    },

    // ── /forget ────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'forget',
        description: 'Remove one section of a project’s memory (admin)',
        syntax: '/forget <project-id> [section]',
        detail:
          'A project’s memory is a list of sections (“## Build”, “## Conventions”, …). ' +
          'With no section, lists them; with one, removes it after a confirmation. The ' +
          'name is matched without regard to case. A running agent keeps what it already ' +
          'read until /reset; later sessions do not see the section.',
        examples: ['/forget site-firma', '/forget site-firma Deploy notes'],
        mutating: true,
        destructive: true,
        requires: 'ops-memory',
      },
      run(input, context): CommandResult {
        const memory = options.memory?.()
        if (memory === undefined) return errorResult('Project memory (ops-memory) is not installed on this deployment.')
        const projectId = tokenize(input)[0]
        if (projectId === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'forget needs a project id.')
        const state = projectState(projectId)
        if (!state.found) return errorResult(state.text)
        const section = restAfter(input, 1).trim()
        const sections = memory.sections(projectId)
        if (section.length === 0) {
          if (sections.length === 0) return result(`${projectId} has no memory sections.`)
          return result(
            [`Sections of ${projectId}'s memory:`, ...sections.map((entry) => `- ${entry.name} (${entry.chars} chars)`), '', `Remove one: /forget ${projectId} <section>`].join('\n'),
          )
        }
        if (context.isAdmin !== true) return errorResult('Only the admin can remove memory.')
        const match = sections.find((entry) => entry.name === section) ?? sections.find((entry) => entry.name.toLowerCase() === section.toLowerCase())
        if (match === undefined) {
          return errorResult(`${projectId}'s memory has no section "${section}". Send /forget ${projectId} to list them.`)
        }
        return deps.service.requestConfirmationFor(
          `/forget-confirm ${projectId} ${match.name}`,
          context,
          `Remove the section "${match.name}" (${match.chars} chars) from ${projectId}'s memory? /memory ${projectId} shows it first.`,
        )
      },
    },

    // ── /forget-confirm ────────────────────────────────────────────────────
    {
      spec: {
        name: 'forget-confirm',
        description: 'Internal: the confirmed form of /forget',
        syntax: '/forget-confirm <project-id> <section>',
        detail: 'Removes the section the confirmation asked about. Not meant to be typed.',
        examples: [],
        mutating: true,
        adminOnly: true,
        requires: 'ops-memory',
      },
      run(input, context): CommandResult {
        const memory = options.memory?.()
        if (memory === undefined) return errorResult('Project memory (ops-memory) is not installed on this deployment.')
        const projectId = tokenize(input)[0] ?? ''
        const removed = memory.forgetSection(projectId, restAfter(input, 1).trim(), context.userId)
        if (!removed.ok) return errorResult(`That section is no longer in ${projectId}'s memory.`)
        return result(`Removed "${removed.name}" from ${projectId}'s memory. A running agent keeps what it already read until /reset ${projectId}.`)
      },
    },

    // ── /files ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'files',
        description: 'List the files in a project’s folder',
        syntax: '/files [project-id] [folder]',
        detail:
          'Lists one folder of the project: subfolders first, then files, newest first. ' +
          'The folder is relative to the project’s own; nothing outside it can be listed. ' +
          'With no project, uses this chat’s active one. /get sends a file.',
        examples: ['/files', '/files site-firma', '/files site-firma reports'],
        mutating: false,
      },
      run(input, context): CommandResult {
        const tokens = tokenize(input)
        // The first token is a project only when it names one, so `/files reports`
        // lists a folder of the active project.
        const named = tokens[0] !== undefined && projectState(tokens[0]).found
        const projectId = named ? tokens[0] : projectOf(undefined, context)
        if (projectId === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'No project given and this chat has no active project.')
        }
        const folder = restAfter(input, named ? 1 : 0).trim()
        const target = insideProject(projectId, folder)
        if (!target.ok) return errorResult(target.text)

        let entries
        try {
          entries = readdirSync(target.path, { withFileTypes: true })
        } catch (err) {
          return errorResult(`Cannot list ${target.shown}: ${(err as Error).message}`)
        }
        if (entries.length === 0) return result(`${target.shown} is empty.`)

        const now = options.now()
        const listed = entries.map((entry) => {
          let stat
          try {
            stat = statSync(join(target.path, entry.name))
          } catch {
            stat = undefined
          }
          const isDir = stat?.isDirectory() ?? entry.isDirectory()
          return { name: isDir ? `${entry.name}/` : entry.name, isDir, size: stat?.size ?? 0, mtime: stat?.mtimeMs ?? 0 }
        })
        listed.sort((a, b) =>
          a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.isDir ? a.name.localeCompare(b.name) : b.mtime - a.mtime,
        )
        const shown = listed.slice(0, FILES_SHOWN)
        const lines = [
          target.shown,
          '',
          ...renderTable([
            ['Name', 'Size', 'Modified'],
            ...shown.map((entry) => [
              truncate(entry.name, 40),
              entry.isDir ? '' : sizeText(entry.size),
              formatAge(entry.mtime, now),
            ]),
          ]),
        ]
        if (listed.length > shown.length) lines.push(`…and ${listed.length - shown.length} more.`)
        const prefix = folder.length === 0 ? '' : `${target.relative}/`
        lines.push('', `/get ${projectId} ${prefix}<name> sends a file.`)
        return result(lines.join('\n'))
      },
    },

    // ── /get ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'get',
        description: 'Send a file from a project’s folder',
        syntax: '/get <project-id> <path>',
        detail:
          'Sends one file from the project’s folder as an attachment. The path is relative ' +
          'to the project’s folder; a path, or a link, that leads outside it is refused. A ' +
          'file larger than the channel can send is named instead.',
        examples: ['/get site-firma report.md', '/get site-firma out/summary.pdf'],
        mutating: false,
      },
      run(input): CommandResult {
        const projectId = tokenize(input)[0]
        const path = restAfter(input, 1).trim()
        if (projectId === undefined || path.length === 0) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'get needs a project id and a path.')
        }
        const target = insideProject(projectId, path)
        if (!target.ok) return errorResult(target.text)
        const stat = statSync(target.path)
        if (!stat.isFile()) {
          return errorResult(`${target.shown} is not a file. /files ${projectId} ${target.relative} lists it.`)
        }
        return result(`${target.shown} (${sizeText(stat.size)})`, {
          files: [{ name: basename(target.path), path: target.path, sizeBytes: stat.size }],
        })
      },
    },

    // ── /budget ────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'budget',
        description: 'Show or change a budget (admin to change)',
        syntax: '/budget <scope> [+<usd> | unlock <duration> | set <day|month> <usd>]',
        detail:
          'With no action, shows the scope’s state. `+<usd>` adds temporary headroom and ' +
          're-dispatches, which is also what un-pauses a project the hard action stopped. ' +
          '`unlock <duration>` grants headroom that expires. `set <day|month> <usd>` changes ' +
          'the limit itself, and resumes a paused project it leaves under its limit. Scope is global, adhoc or a project id.',
        examples: ['/budget site-firma', '/budget site-firma +5', '/budget site-firma unlock 2h', '/budget global set day 20'],
        mutating: true,
      },
      run(input, context): CommandResult {
        const tokens = tokenize(input)
        const scopeToken = tokens[0] ?? ''
        const parsedScope = parseScope(scopeToken, projectOf(undefined, context))
        if (!parsedScope.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, parsedScope.message)
        const scope = parsedScope.value.scope as Scope
        const action = tokens[1]
        const now = options.now()

        if (action !== undefined && context.isAdmin !== true) return errorResult('Only the admin can change a budget. Anyone can see it: /budget ' + scopeToken)
        if (action === undefined) {
          const state = governor.budgetState(scope, now)
          const lines = [
            `Budget for ${scope} (${state.period})`,
            `  level     ${state.level}`,
            state.limitMicros === undefined
              ? '  limit     unlimited'
              : `  limit     $${formatUsd(state.limitMicros)}`,
            `  spent     $${formatUsd(state.spentMicros)}`,
            state.pct === undefined ? '  used      —' : `  used      ${state.pct.toFixed(1)}%`,
          ]
          if (state.overrideMicros > 0) {
            lines.push(
              `  override  +$${formatUsd(state.overrideMicros)}` +
                (state.overrideUntil === undefined
                  ? ' (permanent)'
                  : ` (expires in ${formatDuration(state.overrideUntil - now)})`),
            )
          }
          if (state.downgraded) lines.push('  downgraded to the fallback model')
          return result(lines.join('\n'))
        }

        if (action.startsWith('+')) {
          const money = parseMoney(action.slice(1))
          if (!money.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, money.message)
          governor.override(scope, { addMicros: money.value })
          return result(
            `Added $${formatUsd(money.value)} to ${scope}. ` +
              'Queued work was re-dispatched; a paused project was resumed.',
          )
        }

        if (action === 'unlock') {
          const durationText = tokens[2]
          if (durationText === undefined) {
            return failWith({ syntax: this.spec.syntax } as CommandSpec, 'unlock needs a duration, for example 2h.')
          }
          const duration = parseDuration(durationText)
          if (!duration.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, duration.message)
          const amountText = tokens[3]
          let addMicros: number | undefined
          if (amountText !== undefined) {
            const money = parseMoney(amountText.replace(/^\+/, ''))
            if (!money.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, money.message)
            addMicros = money.value
          }
          governor.override(scope, {
            ...(addMicros === undefined ? {} : { addMicros }),
            untilMs: now + duration.value.ms,
          })
          return result(`Unlocked ${scope} for ${formatDuration(duration.value.ms)}.`)
        }

        if (action === 'set') {
          const period = tokens[2] === undefined ? undefined : parsePeriod(tokens[2])
          const amountText = tokens[3]
          if (period === undefined || amountText === undefined) {
            return failWith(
              { syntax: this.spec.syntax } as CommandSpec,
              'set needs a period and an amount, for example: set day 20.',
            )
          }
          const money = parseMoney(amountText)
          if (!money.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, money.message)
          store.budgets.upsert({
            scope,
            period,
            limit_micros: money.value,
            info_pct: 50,
            soft_pct: 80,
            action_soft: store.budgets.get(scope, period)?.action_soft ?? 'warn',
            action_hard: store.budgets.get(scope, period)?.action_hard ?? 'pause',
          })
          const resumed = governor.limitChanged(scope)
          return result(`Set the ${period} limit for ${scope} to $${formatUsd(money.value)}.${resumed === undefined ? '' : ` ${resumed} is no longer over its budget: resumed.`}`)
        }

        return failWith(
          { syntax: this.spec.syntax } as CommandSpec,
          `"${action}" is not a budget action. Use +<usd>, unlock <duration>, or set <day|month> <usd>.`,
        )
      },
    },

    // ── /model ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'model',
        description: 'Change a project’s model (admin)',
        syntax: '/model <project-id> <provider/model>',
        detail:
          'Writes the model into the project\u2019s file, as /set <project> model does. Its agent ' +
          'switches at its next message, in the same conversation; a run in progress finishes first.',
        examples: ['/model site-firma deepseek/deepseek-flash'],
        mutating: true,
        adminOnly: true,
      },
      async run(input): Promise<CommandResult> {
        const tokens = tokenize(input)
        const projectId = tokens[0]
        const modelText = tokens[1]
        if (projectId === undefined || modelText === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'model needs a project id and a provider/model.')
        }
        const parsed = parseModelRef(modelText)
        if (!parsed.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, parsed.message)
        const refusal = await modelRefusal(parsed.value)
        if (refusal !== undefined) return errorResult(refusal)
        const why = writeSetting(projectId, (doc) => {
          doc.set('provider', parsed.value.provider)
          doc.set('model', parsed.value.model)
        })
        if (why !== undefined) return errorResult(`Not changed. ${why}`)
        return result(`${projectId} now uses ${parsed.value.text}, from its next message.\n` + priceLine(parsed.value))
      },
    },

    // ── /new ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'new',
        description: 'Create a project (admin)',
        syntax: '/new <id> [template] [provider/model]',
        detail:
          'Creates the project folder, writes its project file, and reloads the configuration ' +
          'so the project is usable at once. The id must be lowercase letters, digits and ' +
          'dashes. A template (site, research, reports, devops, or one in config/templates/) ' +
          'sets the tools, the commands that run unasked, and the first instructions; send ' +
          '/new alone to list them. The project follows its template: what you change with /set ' +
          'is its own, the rest follows later changes to the template. Without a model it uses tasks.model. A model whose ' +
          'provider has no API key or no price is refused.',
        examples: ['/new', '/new site-firma site', '/new market research zai/glm-5.3-flash', '/new notes openrouter/deepseek/deepseek-v4-flash'],
        mutating: true,
      },
      async run(input, context): Promise<CommandResult> {
        const tokens = tokenize(input)
        const id = tokens[0]
        const { templates, problems } = loadTemplates(options.templatesDir)
        if (id === undefined) {
          const list = [...templates.values()].map((template) => `  ${template.name.padEnd(10)} ${template.summary}`)
          const broken = problems.length > 0 ? `\n\nNot loaded:\n${problems.map((line) => `  ${line}`).join('\n')}` : ''
          return result(`Create a project: ${this.spec.syntax}\n\nTemplates:\n${list.join('\n')}${broken}\n\nWithout a template the project asks before writing, running or browsing.`)
        }
        if (context.isAdmin !== true) return errorResult('Only the admin can create a project.')
        if (!isValidProjectId(id)) {
          return failWith(
            { syntax: this.spec.syntax } as CommandSpec,
            `"${id}" is not a valid id. Use lowercase letters, digits and dashes, 2 to 41 characters.`,
          )
        }
        if (projects.configOf(id) !== undefined || store.projects.get(id) !== undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, `Project "${id}" already exists.`)
        }

        // A model has a slash; any other word is a template.
        const rest = tokens.slice(1)
        const templateName = rest.find((token) => !token.includes('/'))
        const template = templateName === undefined ? undefined : templates.get(templateName.toLowerCase())
        if (templateName !== undefined && template === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, `No template "${templateName}". Templates: ${[...templates.keys()].join(', ')}.`)
        }
        if (rest.length > (templateName === undefined ? 1 : 2)) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'new takes an id, a template and a model, no more.')
        const adhoc = governor.adhocModel()
        const defaultModel = rest.find((token) => token.includes('/')) ?? `${adhoc.provider}/${adhoc.model}`
        const parsed = parseModelRef(defaultModel)
        if (!parsed.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, parsed.message)
        // Refused before any file is written: no route, no API key, no price.
        const refusal = await modelRefusal(parsed.value)
        if (refusal !== undefined) return errorResult(`Cannot create "${id}": ${refusal}`)

        const cwd = join(options.projectsRoot, id)
        const file = join(options.projectsConfigDir, `${id}.yaml`)
        if (existsSync(file)) {
          return errorResult(`A project file already exists at ${file}.`)
        }

        try {
          mkdirSync(cwd, { recursive: true })
          writeFileSync(
            file,
            toYaml({
              id,
              cwd,
              // The template's settings stay in the template, so a later improvement reaches the project.
              ...(template === undefined ? {} : { template: template.name }),
              description: template?.description || `Created by ${context.userId} with /new.`,
              provider: parsed.value.provider,
              model: parsed.value.model,
            }),
          )
          options.reloadProjects()
        } catch (err) {
          return errorResult(`Could not create "${id}": ${(err as Error).message}`)
        }

        if (projects.configOf(id) === undefined) {
          const invalid = projects.invalidOf(id)
          return errorResult(
            invalid === undefined
              ? `Wrote ${file} but the configuration did not reload it. Check the file, then /reload.`
              : `Wrote ${file} but it does not validate:\n${invalid.reason}\nFix it, then /reload.`,
          )
        }
        // The template's instructions; a project without memory installed simply has none.
        const instructions = template === undefined || template.instructions.length === 0 ? undefined : options.memory?.()?.writeInstructions(id, template.instructions, context.userId)
        const from = template === undefined ? '' : ` from the ${template.name} template`
        const told = instructions?.ok === true ? `Its instructions: /instructions ${id}.\n` : ''
        return result(
          `Created project ${id}${from} using ${parsed.value.text}.\n` +
            `  folder  ${cwd}\n  file    ${file}\n` +
            `${priceLine(parsed.value)}\n${told}` +
            `Make it active with /p ${id}, then send it work.`,
        )
      },
    },

    // ── /set ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'set',
        description: 'Change a project setting (admin)',
        syntax: '/set <project-id> <key> <value>',
        detail:
          'Writes the setting into the project’s file and reloads it, so the change is ' +
          'durable and checked by the same rules as at startup. A value that does not ' +
          'validate is not written. Keys are dotted: budget.day_usd, limits.max_steps_total, limits.loop_check_steps (0 is none), limits.on_loop (stop, notify, ask), ' +
          'approvals.mode, approvals.auto_allow, description, fallback_model, preset, progress. ' +
          '`model` takes provider/model. id and cwd cannot be changed. A list is written ' +
          '[like, this], whole: it replaces the template\'s. `template none` writes the ' +
          'template\'s settings into the file and stops following it; `template <name>` follows ' +
          'one. Only the admin can run it.',
        examples: [
          '/set site-firma budget.day_usd 5',
          '/set clipuri limits.max_steps_total 15',
          '/set site-firma approvals.auto_allow [git status, npm test]',
          '/set site-firma model openrouter/deepseek/deepseek-v4-flash',
          '/set site-firma description The company website and its blog',
          '/set site-firma template none',
        ],
        mutating: true,
        adminOnly: true,
      },
      async run(input): Promise<CommandResult> {
        const [projectId, key] = tokenize(input)
        const text = restAfter(input, 2).trim()
        if (projectId === undefined || key === undefined || text.length === 0) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'set needs a project id, a key and a value.')
        }
        const file = projects.configOf(projectId)?.sourcePath ?? projects.invalidOf(projectId)?.path
        if (file === undefined) return errorResult(`No project "${projectId}". Send /projects to see them.`)
        const path = key.split('.')
        if (path[0] === 'id' || path[0] === 'cwd') {
          return errorResult(`${key} cannot be changed: it is the project's identity and its folder.`)
        }
        if (key === 'template') return setTemplate(projectId, file, text)
        // A loaded project has every key, defaults included, so a key it lacks is a
        // typo that the file would keep and nothing would read.
        const loaded = projects.configOf(projectId)
        const known = loaded === undefined ? undefined : settingKeys(loaded)
        // A tool's exception is a new key by nature: any tool name may get one; so is a
        // rule for one tool of a server the project has.
        // A whole MCP server is added with its map and removed with null.
        const server = /^mcp\.[a-z0-9][a-z0-9-]{0,40}$/.test(key)
        const exception = server || /^tools\.exceptions\.[a-z0-9_-]+$/i.test(key) || (/^mcp\.[a-z0-9-]+\.tools\.[A-Za-z0-9_*?-]+$/.test(key) && loaded?.mcp[path[1] ?? ''] !== undefined)
        if (known !== undefined && key !== 'model' && !exception && !known.includes(key)) {
          return errorResult(`"${key}" is not a project setting. Known: ${known.join(', ')}.`)
        }

        const original = readFileSync(file, 'utf8')
        const doc = parseDocument(original)
        let shown = text
        if (key === 'model') {
          const parsed = parseModelRef(text)
          if (!parsed.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, parsed.message)
          const refusal = await modelRefusal(parsed.value)
          if (refusal !== undefined) return errorResult(refusal)
          doc.set('provider', parsed.value.provider)
          doc.set('model', parsed.value.model)
        } else {
          const value = settingValue(text)
          if (!value.ok) return errorResult(`"${text}" is not a valid value: ${value.message}`)
          if (server && value.value === null) {
            if (!doc.hasIn(path)) return errorResult(`${projectId} has no MCP server ${path[1]} in its file${loaded?.mcp[path[1] ?? '']?.extension === undefined ? '' : `: it comes with the ${loaded.mcp[path[1] ?? '']?.extension?.name} extension (/ext disable)`}.`)
            doc.deleteIn(path)
          } else if (server && (value.value === null || typeof value.value !== 'object' || Array.isArray(value.value))) {
            return errorResult(`An MCP server is a map: {url: https://…} or {command: npx, args: [...]}; null removes it.`)
          } else doc.setIn(path, value.value)
          shown = JSON.stringify(value.value)
        }

        writeFileSync(file, doc.toString())
        const restore = (why: string): CommandResult => {
          writeFileSync(file, original)
          options.reloadProjects()
          return errorResult(`Not changed. ${why}`)
        }
        try {
          options.reloadProjects()
        } catch (err) {
          return restore((err as Error).message)
        }
        const invalid = projects.invalidOf(projectId)
        if (invalid !== undefined) return restore(`With ${key} = ${shown} the project does not validate:\n${invalid.reason}`)
        // Read when the agent is built, which happens again at its next message.
        const later = ['model', 'provider', 'preset', 'fallback_model', 'mcp', 'tools', 'extensions'].includes(path[0] ?? '')
          ? ' Its agent uses it from its next message; a run in progress finishes first.'
          : ''
        const template = loaded?.template ?? null
        const own = template !== null && loaded!.fromTemplate.some((inherited) => inherited === key || inherited.startsWith(`${key}.`))
          ? ` It is the project's own now: changes to the ${template} template no longer reach it.`
          : ''
        return result(`${projectId}: ${key} = ${shown}. Written to ${file}.${own}${later}`)
      },
    },

    // ── /web ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'web',
        description: 'A sign-in link for the web interface',
        syntax: '/web',
        detail:
          'Sends a link that signs you in to the web interface. It works once and for ten ' +
          'minutes; the sign-in then lasts web.session_hours. For those ten minutes you can ' +
          'also set or reset your web password (Settings), to sign in without a link. The interface is meant for a ' +
          'private network: open it through tailscale serve, a VPN or an SSH tunnel.',
        examples: ['/web'],
        mutating: false,
      },
      run(_input, context): CommandResult {
        const web = options.web?.()
        if (web === undefined) return errorResult('The web interface is not running (web.enabled in ops.yaml).')
        if (context.user === undefined) return errorResult('Only a user of Argus gets a sign-in link.')
        return result(
          `Open within 10 minutes; it works once:\n${web.loginLink(context.user.id)}\n` +
          'Signed in this way, you can set or reset your web password in Settings.',
        )
      },
    },

    // ── /defaults ──────────────────────────────────────────────────────────
    {
      spec: {
        name: 'defaults',
        description: 'See or change the models for tasks, the front desk and the judge',
        syntax: '/defaults [tasks|frontdesk|judge <provider/model>]',
        detail:
          'With nothing, shows the model a /task runs on and the front desk’s model. ' +
          'With a target and a model (admin), checks the model like /model (a key and a ' +
          'price), writes it to ops.yaml (tasks.model or orchestrator.model, comments ' +
          'kept), and applies it at once: the next task runs on it, and the front desk ' +
          'starts a fresh conversation on it with the next message. `judge` is the loop checker\'s model ' +
          '(judge.model): every limits.loop_check_steps steps it reads a run and says whether it goes in circles; ' +
          'a model different from the projects\' own is best.',
        examples: ['/defaults', '/defaults tasks deepseek/deepseek-flash', '/defaults frontdesk openrouter/z-ai/glm-5.3-flash', '/defaults judge anthropic/claude-sonnet-5-5'],
        mutating: true,
      },
      async run(input, context): Promise<CommandResult> {
        const [target, modelText, ...extra] = tokenize(input)
        const adhoc = governor.adhocModel()
        const desk = options.frontDesk?.()
        const judge = governor.judgeModel()
        if (target === undefined) {
          return result(
            `Tasks:      ${adhoc.provider}/${adhoc.model}\n` +
              `Front desk: ${desk === undefined ? 'not running' : desk.currentModel()}\n` +
              `Judge:      ${judge === undefined ? 'none (no loop check)' : `${judge.provider}/${judge.model}`}\n\n` +
              'Change one: /defaults tasks|frontdesk|judge <provider/model>',
          )
        }
        if (context.isAdmin !== true) return errorResult('Only the admin can change the defaults.')
        const keyPath = target === 'tasks' ? ['tasks', 'model'] : target === 'frontdesk' ? ['orchestrator', 'model'] : target === 'judge' ? ['judge', 'model'] : undefined
        if (keyPath === undefined || modelText === undefined || extra.length > 0) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'defaults needs tasks, frontdesk or judge, and one provider/model.')
        }
        if (target === 'frontdesk' && desk === undefined) return errorResult('There is no front desk in this deployment.')
        const parsed = parseModelRef(modelText)
        if (!parsed.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, parsed.message)
        const refusal = await modelRefusal(parsed.value)
        if (refusal !== undefined) return errorResult(refusal)

        // The file first: a value that cannot be kept is not applied either.
        const file = options.configPath?.()
        if (file === undefined) return errorResult('The configuration file is not known, so nothing was changed.')
        try {
          const doc = parseDocument(readFileSync(file, 'utf8'))
          doc.setIn(keyPath, parsed.value.text)
          writeFileSync(file, doc.toString())
        } catch (err) {
          return errorResult(`Could not write ${file}: ${(err as Error).message}. Nothing was changed.`)
        }
        if (target === 'tasks') governor.setAdhocModel(parsed.value)
        else if (target === 'judge') governor.setJudgeModel(parsed.value)
        else desk?.setModel(parsed.value.text)
        const label = { tasks: 'Tasks', frontdesk: 'Front desk', judge: 'Judge' }[target]
        const when =
          target === 'tasks'
            ? 'The next task runs on it.'
            : target === 'judge'
              ? 'It reads the runs of the projects with limits.loop_check_steps set, from their next check.'
              : 'The front desk starts a fresh conversation on it with your next message.'
        return result(`${label}: ${parsed.value.text}, written to ${file}. ${when}\n${priceLine(parsed.value)}`)
      },
    },

    // ── /config ────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'config',
        description: 'See or change a setting in ops.yaml (admin)',
        syntax: '/config [key [value] | reset <key>]',
        detail:
          'With nothing, lists what ops.yaml sets and what waits for a restart. With a key, ' +
          'shows its value, default and meaning. With a value, checks the whole file with it ' +
          'and writes it, keeping the comments; a value that does not validate is not written. ' +
          'A list is written [like, this], a map {like: this}. `reset` removes the key, so its ' +
          'default applies. The models (tasks.model, orchestrator.model, judge.model) apply at ' +
          'once; anything else after /restart. data_dir, config_dir and dsh_home are changed by ' +
          'hand, with Argus stopped.',
        examples: ['/config', '/config web.session_hours', '/config web.session_hours 48', '/config reset web.session_hours'],
        mutating: true,
        adminOnly: true,
      },
      async run(input, context): Promise<CommandResult> {
        if (context.isAdmin !== true) return errorResult('Only the admin can change the configuration.')
        const settings = deps.service.systemSettings()
        const schema = options.configSchema?.()
        if (settings === undefined || schema === undefined) return errorResult('The configuration file is not known, so nothing can be shown or changed.')
        const [first, second] = tokenize(input)
        if (first === undefined) {
          const set = settings.fields.filter((field) => field.set)
          return result(
            `${settings.file} sets:\n${set.map((field) => `  ${field.key} = ${JSON.stringify(field.value)}`).join('\n') || '  nothing: every default applies'}` +
              (settings.pending.length === 0 ? '' : `\n\nWaiting for a restart: ${settings.pending.join(', ')}. ${settings.restartable ? 'Send /restart.' : 'Restart Argus.'}`),
          )
        }
        const reset = first === 'reset'
        const key = reset ? second : first
        if (key === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'reset needs a key.')
        if (FIXED_SYSTEM_KEYS.has(key)) return errorResult(`${key} places Argus on disk: change it by hand in ${settings.file}, with Argus stopped.`)
        const node = schemaAt(schema as SchemaNode, key)
        const field = settings.fields.find((each) => each.key === key)
        if (node === undefined) return errorResult(`"${key}" is not a setting. Send /config to see what the file sets.`)
        const text = reset ? '' : restAfter(input, 1).trim()
        if (!reset && text.length === 0) {
          if (field === undefined) return result(`${key} is a section: ${describeSchema(node, undefined, systemApply, key).map((each) => each.key).join(', ')}.`)
          return result(
            `${key} = ${JSON.stringify(field.value)}${field.set ? '' : ' (the default)'}\n` +
              `Default: ${JSON.stringify(field.default)}${field.kind === 'enum' ? `\nOne of: ${field.options.join(', ')}` : ''}` +
              `${field.min === null && field.max === null ? '' : `\nRange: ${field.min ?? '…'} to ${field.max ?? '…'}`}` +
              `${field.description === null ? '' : `\n${field.description}`}\nApplies ${field.apply === 'live' ? 'at once' : 'after a restart'}.`,
          )
        }
        if (!reset && LIVE_SYSTEM_KEYS.has(key)) return deps.service.runCommand(`/defaults ${key === 'tasks.model' ? 'tasks' : key === 'judge.model' ? 'judge' : 'frontdesk'} ${text}`, context)
        const value = reset ? { ok: true as const, value: undefined } : settingValue(text)
        if (!value.ok) return errorResult(`"${text}" is not a valid value: ${value.message}`)
        const original = readFileSync(settings.file, 'utf8')
        const doc = parseDocument(original)
        if (reset) doc.deleteIn(key.split('.'))
        else doc.setIn(key.split('.'), value.value)
        try {
          options.validateConfig?.(doc.toJS())
        } catch (err) {
          return errorResult(`Not changed: with ${key} = ${text} the configuration does not validate.\n${(err as Error).message}`)
        }
        try {
          writeFileSync(settings.file, doc.toString())
        } catch (err) {
          return errorResult(`Could not write ${settings.file}: ${(err as Error).message}. Nothing was changed.`)
        }
        const done = reset ? `${key} removed: its default (${JSON.stringify(field?.default ?? null)}) applies` : `${key} = ${JSON.stringify(value.value)}`
        return result(`${done}. Written to ${settings.file}. It applies after a restart${options.restart === undefined ? '.' : ': send /restart.'}`)
      },
    },

    // ── /restart ───────────────────────────────────────────────────────────
    {
      spec: {
        name: 'restart',
        description: 'Restart Argus, after the runs in progress (admin)',
        syntax: '/restart',
        detail:
          'Waits for the runs in progress to finish, at most two minutes, then stops; Docker or ' +
          'systemd starts it again, with the settings in ops.yaml. Requires confirmation. ' +
          'Without Docker or systemd nothing would start it again, so it refuses.',
        examples: ['/restart'],
        mutating: true,
        destructive: true,
        adminOnly: true,
      },
      run(_input, context): CommandResult {
        if (context.isAdmin !== true) return errorResult('Only the admin can restart Argus.')
        if (options.restart === undefined) return errorResult('Argus runs without Docker or systemd here, so nothing would start it again. Restart it by hand.')
        const running = governor.status().running.length
        return deps.service.requestConfirmationFor(
          '/restart-confirm',
          context,
          `Restart Argus? ${running === 0 ? 'Nothing is running.' : `The ${running} run${running === 1 ? '' : 's'} in progress finish first, at most two minutes.`}`,
        )
      },
    },
    {
      spec: {
        name: 'restart-confirm',
        description: 'Internal: the confirmed form of /restart',
        syntax: '/restart-confirm',
        detail: 'Restarts as the confirmation asked. Not meant to be typed.',
        examples: [],
        mutating: true,
        adminOnly: true,
      },
      run(_input, context): CommandResult {
        if (context.isAdmin !== true || options.restart === undefined) return errorResult('Not restarted.')
        options.restart()
        return result('Restarting once the runs in progress finish. The page reconnects by itself.')
      },
    },

    // ── /key ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'key',
        description: 'See, save or remove a model provider’s API key (admin)',
        syntax: '/key [provider [key] | NAME value | remove <provider|NAME>]',
        detail:
          'With nothing, lists the providers and which have a key. With a provider and a ' +
          'key, deletes your message at once, checks the key with the provider (a free ' +
          'request), and saves it only if accepted; the next request uses it, no restart. ' +
          'The reply names the key by its last four characters. A key set in the server’s ' +
          '.env wins and cannot be changed from here. A NAME in capitals saves a secret ' +
          'for an MCP server instead (a project’s mcp block reads it as ${NAME}); it is ' +
          'not checked. Only the admin can run it.',
        examples: ['/key', '/key openrouter sk-or-v1-…', '/key GITHUB_TOKEN ghp_…', '/key remove groq'],
        mutating: true,
        adminOnly: true,
        secret: true,
      },
      async run(input): Promise<CommandResult> {
        const keys = options.keys?.()
        if (keys === undefined) return errorResult('Keys cannot be managed here: the providers are not loaded.')
        const [first, second, ...rest] = tokenize(input)
        if (first === undefined) {
          const all = keys.keyStatus()
          const set = all.filter((entry) => entry.configured)
          const lines = set.map((entry) => `${entry.provider.padEnd(12)} ${entry.writable ? 'saved here' : 'from the server’s environment'}`)
          const without = all.filter((entry) => !entry.configured).map((entry) => entry.provider)
          return result(
            `${set.length === 0 ? 'No provider has a key yet.' : `API keys:\n${lines.join('\n')}`}\n\n` +
              `Without a key: ${without.join(', ')}.\n` +
              'Save one: /key <provider> <key>. Your message is deleted at once.',
          )
        }
        const change =
          first === 'remove'
            ? second === undefined
              ? undefined
              : await keys.removeKey(second)
            : second === undefined || rest.length > 0
              ? undefined
              : await keys.setKey(first, second)
        if (change === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'key needs a provider and one key, or remove and a provider.')
        if (!change.ok) return errorResult(change.message)
        // A project whose provider had no key was invalid; now it may load.
        options.reloadProjects()
        return result(change.message)
      },
    },

    // ── /tools ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'tools',
        description: 'Show which tools a project may use',
        syntax: '/tools [project-id]',
        detail:
          'Shows each tool group with its setting: off (the agent does not see it), deny ' +
          '(refused), ask (you are asked) or allow (runs unasked). A read or write outside ' +
          'the project’s folder asks even under allow. Change one with /set <project> ' +
          'tools.<group> <value>; web_hosts lists the sites web_fetch reaches unasked. ' +
          'One tool can differ from its group: /set <project> tools.exceptions.<tool> <value>. ' +
          'MCP servers are listed with their access; change one with /set <project> ' +
          'mcp.<server>.access <value>, or one of its tools (a name or a glob such as read_*) ' +
          'with /set <project> mcp.<server>.tools.<tool> <value>: the most specific match wins. ' +
          'With no project, uses this chat’s active one.',
        examples: ['/tools', '/tools site-firma'],
        mutating: false,
      },
      async run(input, context): Promise<CommandResult> {
        const projectId = projectOf(tokenize(input)[0], context)
        if (projectId === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'No project given and this chat has no active project.')
        }
        const config = projects.configOf(projectId)
        if (config === undefined) return errorResult(`No project "${projectId}". Send /projects to see them.`)
        const { tools } = config
        // What the project's file does not set, it takes from its template, and follows its changes.
        const inherited = new Set(config.fromTemplate)
        const from = (key: string): string => (inherited.has(key) ? ` (${config.template})` : '')
        const width = config.template === null ? 6 : 9 + config.template.length
        const rows = (Object.keys(TOOL_GROUPS) as Array<keyof typeof TOOL_GROUPS>).map(
          (group) => `${group.padEnd(7)} ${(tools[group] + from(`tools.${group}`)).padEnd(width)} ${TOOL_GROUPS[group].join(', ')}`,
        )
        rows.push(`${'other'.padEnd(7)} ${(tools.other + from('tools.other')).padEnd(width)} any tool not listed above`)
        const hosts = tools.web_hosts.length > 0 ? `\nweb_fetch unasked: ${tools.web_hosts.join(', ')}${from('tools.web_hosts')}` : ''
        // The backend web_search goes to (web_search.provider in ops.yaml), and what it lacks.
        const backend = options.search?.()?.status()
        const charged = backend === undefined ? '' : backend.priceMicros === undefined ? ' Each search is charged as a DeepSeek request.' : ` Each search is charged $${(backend.priceMicros / 1_000_000).toFixed(4)}.`
        const search = tools.web === 'off' || backend === undefined ? '' : backend.ready ? `\nweb_search goes to ${backend.provider}.${charged}` : `\nweb_search goes to ${backend.provider}, which cannot search: ${backend.fix ?? ''}. Without it every search fails.`
        const commands = config.approvals.auto_allow.length > 0 ? `\nCommands unasked: ${config.approvals.auto_allow.join(', ')}${from('approvals.auto_allow')}` : ''
        const exceptions = Object.entries(tools.exceptions).map(([name, access]) => `${name} ${access}${from(`tools.exceptions.${name}`)}`)
        const named = exceptions.length > 0 ? `\nExceptions (over the group): ${exceptions.join(', ')}` : ''
        const signIns = new Map<string, string>()
        for (const [name, server] of Object.entries(config.mcp)) {
          if (server.oauth === null) continue
          const status = await projects.oauth.status(projectId, name)
          signIns.set(name, status.state === 'connected' ? ', signed in' : status.state === 'failed' ? `, signed out: its provider refused the grant (/mcp connect ${projectId} ${name})` : `, not connected: left out (/mcp connect ${projectId} ${name})`)
        }
        const servers = Object.entries(config.mcp).map(([name, server]) => {
          const line = `${name.padEnd(12)} ${server.access.padEnd(6)} ${server.extension === undefined ? (server.command ?? server.url ?? '') : `the ${server.extension.name} extension, confined`}${signIns.get(name) ?? ''}${from(`mcp.${name}.access`)}`
          const rules = Object.entries(server.tools).map(([tool, access]) => `${tool} ${access}${from(`mcp.${name}.tools.${tool}`)}`)
          return rules.length === 0 ? line : `${line}\n${' '.repeat(13)}tools: ${rules.join(', ')}`
        })
        const mcp = servers.length > 0 ? `\n\nMCP servers (tools mcp__<server>__…):\n${servers.join('\n')}` : ''
        const enabled = config.extensions.map((extension) => `${extension.name.padEnd(12)} ${extension.binDir === null ? 'no programs' : readdirSync(extension.binDir).sort().join(', ')}`)
        const programs = enabled.length > 0 ? `\n\nExtensions (their programs run in the shell, confined, under shell's access and the commands unasked):\n${enabled.join('\n')}` : ''
        const { limits } = config
        const onLoop = { stop: 'stops it', notify: 'tells you and it goes on', ask: 'asks you' }[limits.on_loop]
        const loopCheck =
          limits.loop_check_steps === 0
            ? `no loop check${from('limits.loop_check_steps')}`
            : `a loop check every ${limits.loop_check_steps} steps${from('limits.loop_check_steps')}${governor.judgeModel() === undefined ? ' (off: no model, /defaults judge)' : ''}, and a loop it finds ${onLoop}${from('limits.on_loop')}`
        const limitsLine = `\nLimits per run: at most ${limits.max_steps_total} steps${from('limits.max_steps_total')}, ${loopCheck}; stopped after ${limits.loop_repeat_threshold} identical calls in a row${from('limits.loop_repeat_threshold')}, ${limits.stall_steps === 0 ? 'no stall check' : `or ${limits.stall_steps} steps with nothing new`}${from('limits.stall_steps')}`
        const follows = config.template === null ? '' : `\n(${config.template}): from the ${config.template} template, which /template ${config.template} shows; /set makes a value the project's own.`
        return result(
          `${projectId}: tools\n${rows.join('\n')}${hosts}${search}${commands}${named}${limitsLine}${mcp}${programs}${follows}\n\n` +
            `Change one: /set ${projectId} tools.web allow`,
        )
      },
    },

    // ── /rule ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'rule',
        description: 'Let a project run a command, or fetch a site, unasked (admin)',
        syntax: '/rule <project-id> <command…> | /rule <project-id> host <host>',
        detail:
          'Adds a rule to the project\'s file, as "Always allow" does: a command to ' +
          'approvals.auto_allow (exactly that command; a final * takes any further plain ' +
          'arguments), or a host to tools.web_hosts. The project then keeps the whole list as ' +
          'its own. A scheduled run that was blocked offers this as a button. Only the admin.',
        examples: ['/rule servers docker logs *', '/rule news host news.ycombinator.com'],
        mutating: true,
        adminOnly: true,
      },
      run(input): CommandResult {
        const [projectId, first] = tokenize(input)
        const config = projectId === undefined ? undefined : projects.configOf(projectId)
        if (config === undefined || first === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'rule needs a project and a command, or host and a host name.')
        const host = first === 'host'
        const entry = restAfter(input, host ? 2 : 1).trim().replace(/\s+/g, ' ')
        // Plain words only, so the rule reads back as the tokens it was written as.
        const plain = host ? /^(\*\.)?[a-z0-9.-]+$/i.test(entry) : /^[\w./:=@+-]+( [\w./:=@+-]+)*( \*)?$/.test(entry)
        if (!plain || entry.length > 120) return errorResult(`"${entry}" cannot be a rule: ${host ? 'a host name' : 'plain words, optionally ending in *'}, up to 120 characters.`)
        const key = host ? ['tools', 'web_hosts'] : ['approvals', 'auto_allow']
        const current = host ? config.tools.web_hosts : config.approvals.auto_allow
        if (current.includes(entry)) return result(`${projectId} already allows ${entry}.`)
        const written = writeSetting(config.id, (doc) => doc.setIn(key, [...current, entry]))
        if (written !== undefined) return errorResult(`Not changed. ${written}`)
        return result(`${projectId} now ${host ? 'fetches' : 'runs'} ${entry} unasked. Undo: /set ${projectId} ${key.join('.')} ${JSON.stringify(current)}`)
      },
    },

    // ── /template ──────────────────────────────────────────────────────────
    {
      spec: {
        name: 'template',
        description: 'Show the project templates, or change one (admin)',
        syntax: '/template [name] | set <name> <key> <value> | new <name> [from <template> | project <project-id>] | remove <name>',
        detail:
          'Without a name, lists the templates: the built-in ones and those in config/templates/. ' +
          'With one, shows its settings, the instructions a new project starts with, and the ' +
          'projects that follow it. A project follows its template in what its own file does ' +
          'not set. The admin changes one with set (a key: summary, description, instructions, ' +
          'or a setting such as budget.day_usd; a built-in one gets a file of its own in ' +
          'config/templates/ that stands for it), which reaches the projects that follow it at ' +
          'their next message; makes one with new (blank, a copy of another, or from a project\'s ' +
          'file); and removes one with remove, refused while a project follows it (removing the ' +
          'file of a built-in brings the built-in back).',
        examples: ['/template', '/template devops', '/template set research budget.day_usd 2', '/template new shop from site', '/template remove shop'],
        mutating: true,
      },
      run(input, context): CommandResult {
        const [verb] = tokenize(input)
        if (verb === 'set' || verb === 'new' || verb === 'remove') {
          if (context.isAdmin !== true) return errorResult('Only the admin can change the templates.')
          return changeTemplate(verb, input)
        }
        const name = tokenize(input)[0]?.toLowerCase()
        const { templates, problems } = loadTemplates(options.templatesDir)
        if (name === undefined) {
          const list = [...templates.values()].map((template) => `  ${template.name.padEnd(10)} ${template.summary}`)
          const broken = problems.length > 0 ? `\n\nNot loaded:\n${problems.map((line) => `  ${line}`).join('\n')}` : ''
          return result(`Templates:\n${list.join('\n')}${broken}\n\nOne in full: /template <name>. A project from one: /new <id> <name>.`)
        }
        const template = templates.get(name)
        if (template === undefined) return errorResult(`No template "${name}". Templates: ${[...templates.keys()].join(', ')}.`)
        const following = projects.configuredIds().filter((id) => projects.configOf(id)?.template === template.name)
        const settings = Object.keys(template.settings).length === 0 ? '  (the defaults)\n' : `${toYaml(template.settings).trimEnd().replace(/^/gm, '  ')}\n`
        return result(
          `${template.name}: ${template.summary}\n\nSettings:\n${settings}\n` +
            `Instructions a new project starts with:\n${template.instructions || '(none)'}\n\n` +
            `Followed by: ${following.length > 0 ? following.join(', ') : 'no project'}`,
        )
      },
    },

    // ── /ext ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'ext',
        description: 'Extensions: skills and tools installed once (admin to change)',
        syntax: '/ext [list] | /ext install <git-url | path>[#folder][@ref] | /ext update <name>[@ref] | /ext remove <name> | /ext enable|disable <project-id> <name>',
        detail:
          'An extension is a git repository with an extension.yaml: MCP tools, skills and ' +
          'instructions, installed once for every project to use. install fetches it (an ' +
          'https:// URL, or the absolute path of a repository on the server), pinned to a commit, ' +
          'shows what it brings and asks; its install commands then run in the command sandbox, ' +
          'writing only in its own folder. update fetches its source again and shows what changes ' +
          'in what it may do. enable gives a project its tools (run confined to the project\'s ' +
          'folder), skills and instructions, from its next message (a run in progress finishes first); disable takes ' +
          'them away. Seeing them is anyone\'s; the rest is the admin\'s.',
        examples: ['/ext enable site-firma office', '/ext', '/ext install https://github.com/rla-labs/argus-extensions#office', '/ext install /srv/ext/office@v1.2.0', '/ext update office', '/ext remove office'],
        mutating: true,
      },
      async run(input, context): Promise<CommandResult> {
        const extensions = projects.extensions
        if (extensions === undefined) return errorResult('Extensions are not available on this deployment.')
        const [action = 'list', argument] = tokenize(input)
        if (action === 'list') {
          const installed = extensions.installed()
          if (installed.length === 0) return result('No extension is installed. Install one: /ext install <git-url | path>')
          const broken = new Map(extensions.verify().map((entry) => [entry.name, entry.problem]))
          const lines = installed.map((entry) => {
            const problem = broken.get(entry.name)
            const manifest = problem === undefined ? extensions.manifestOf(entry.name) : undefined
            const what = manifest === undefined ? `NOT USED: ${problem}` : `${manifest.summary}${describeParts(manifest).length > 0 ? `\n    ${describeParts(manifest).join('; ')}` : ''}`
            const users = projects.configuredIds().filter((id) => projects.configOf(id)?.extensions.some((extension) => extension.name === entry.name))
            return `${entry.name} ${entry.version} (${entry.commit.slice(0, 7)})\n    ${what}\n    from ${entry.source}${entry.ref === null ? '' : `@${entry.ref}`}\n    used by ${users.length > 0 ? users.join(', ') : 'no project (/ext enable <project> ' + entry.name + ')'}`
          })
          return result(`Extensions:\n${lines.join('\n')}`)
        }
        if (!context.isAdmin) return errorResult('Only the admin can install, update, remove, enable or disable an extension.')
        if (action === 'enable' || action === 'disable') {
          const name = tokenize(input)[2]
          const config = argument === undefined ? undefined : projects.configOf(argument)
          if (config === undefined || name === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, `${action} needs a project and an extension: /ext ${action} <project-id> <name>.`)
          const listed = [...config.extensions.map((extension) => extension.name), ...config.extensionsMissing]
          if (action === 'enable') {
            if (!extensions.usable().has(name)) return errorResult(`No usable extension "${name}": /ext lists the installed ones.`)
            if (listed.includes(name)) return result(`${argument} already uses ${name}.`)
          } else if (!listed.includes(name)) return result(`${argument} does not use ${name}.`)
          const next = action === 'enable' ? [...listed, name] : listed.filter((other) => other !== name)
          // Disabled, its servers' settings in the file have nothing left to apply to.
          const servers = action === 'disable' ? Object.keys(extensions.usable().get(name)?.manifest.mcp ?? {}) : []
          const written = writeSetting(config.id, (doc) => {
            doc.setIn(['extensions'], next)
            for (const server of servers) doc.deleteIn(['mcp', server])
          })
          if (written !== undefined) return errorResult(`Not changed. ${written}`)
          const said = `${argument} ${action === 'enable' ? 'uses' : 'no longer uses'} ${name}. Its agent ${action === 'enable' ? 'gets' : 'loses'} the tools, skills and instructions from its next message, in the same conversation. /tools ${argument} shows its tools.`
          // Its rules are offered, never applied: a press is the admin's /rule.
          const rules = action === 'enable' ? (extensions.usable().get(name)?.manifest.rules ?? []) : []
          return rules.length === 0
            ? result(said)
            : { ...result(`${said}\n${name} suggests letting these run unasked in ${argument}: ${rules.join(', ')}.`), buttons: rules.map((rule) => ({ label: `Allow “${rule}” in ${argument}`, command: `/rule ${argument} ${rule}` })) }
        }
        if (argument === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, `${action} needs ${action === 'install' ? 'a git URL or a path' : 'an extension\'s name'}.`)
        try {
          if (action === 'install' || action === 'update') {
            let source: string
            let ref: string | null
            if (action === 'install') {
              const parsed = parseSource(argument)
              if (!parsed.ok) return errorResult(parsed.message)
              ;({ source, ref } = parsed)
            } else {
              const [name = '', asked] = argument.split('@')
              const entry = extensions.get(name)
              if (entry === undefined) return errorResult(`No extension "${name}" is installed. /ext lists them.`)
              source = entry.source
              ref = asked ?? entry.ref
            }
            const staged = await extensions.fetch(source, ref)
            if (action === 'update' && staged.manifest.name !== argument.split('@')[0]) {
              extensions.discard(staged.id)
              return errorResult(`${source} is now the extension "${staged.manifest.name}", not "${argument.split('@')[0]}".`)
            }
            return deps.service.requestConfirmationFor(`/ext-confirm ${staged.id}`, context, describeStaged(staged))
          }
          if (action === 'remove') {
            if (extensions.get(argument) === undefined) return errorResult(`No extension "${argument}" is installed. /ext lists them.`)
            return deps.service.requestConfirmationFor(`/ext-remove-confirm ${argument}`, context, `Remove the extension ${argument}? Its files are deleted; install it again to get it back.`)
          }
        } catch (err) {
          if (err instanceof OpsError) return errorResult(err.message)
          throw err
        }
        return failWith({ syntax: this.spec.syntax } as CommandSpec, `No /ext ${action}.`)
      },
    },

    // ── /ext-confirm ───────────────────────────────────────────────────────
    {
      spec: {
        name: 'ext-confirm',
        description: 'Internal: the confirmed form of /ext install and /ext update',
        syntax: '/ext-confirm <staging-id>',
        detail: 'Runs the install the confirmation asked for. Not meant to be typed.',
        examples: [],
        mutating: true,
        adminOnly: true,
      },
      async run(input, context): Promise<CommandResult> {
        const extensions = projects.extensions
        if (extensions === undefined) return errorResult('Extensions are not available on this deployment.')
        try {
          const entry = await extensions.install(tokenize(input)[0] ?? '', context.userId)
          options.reloadProjects()
          return result(`Installed ${entry.name} ${entry.version} (${entry.commit.slice(0, 7)}) in ${join(extensions.dir, entry.path)}.`)
        } catch (err) {
          if (err instanceof OpsError) return errorResult(err.message)
          throw err
        }
      },
    },

    // ── /ext-remove-confirm ────────────────────────────────────────────────
    {
      spec: {
        name: 'ext-remove-confirm',
        description: 'Internal: the confirmed form of /ext remove',
        syntax: '/ext-remove-confirm <name>',
        detail: 'Removes the extension the confirmation asked about. Not meant to be typed.',
        examples: [],
        mutating: true,
        adminOnly: true,
      },
      run(input): CommandResult {
        const name = tokenize(input)[0] ?? ''
        if (projects.extensions?.remove(name) !== true) return errorResult(`No extension "${name}" is installed.`)
        options.reloadProjects()
        const users = projects.configuredIds().filter((id) => projects.configOf(id)?.extensionsMissing.includes(name))
        return result(`Removed the extension ${name}.${users.length > 0 ? ` ${users.join(', ')} still list it and run without it: /ext disable <project> ${name}.` : ''}`)
      },
    },

    // ── /git ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'git',
        description: 'A project’s git remotes and their tokens (admin to change)',
        syntax: '/git [project-id] | /git remote <project-id> <name> <https-url> | /git token <project-id> <remote> <token> | /git forget <project-id> <remote> | /git remove <project-id> <remote>',
        detail:
          'A project clones, pulls and pushes through its remotes, and Argus does it: the ' +
          'token never reaches the agent, its shell or the conversation. remote adds one, or ' +
          'changes its URL (which forgets its token). token deletes your message at once and ' +
          'saves the token for that project and that remote only: no other project can use ' +
          'it. forget removes the token; remove the remote, its token and its copy. Seeing ' +
          'them is anyone’s; the rest is the admin’s.',
        examples: ['/git site-firma', '/git remote site-firma origin https://github.com/acme/site.git', '/git token site-firma origin github_pat_…', '/git forget site-firma origin'],
        mutating: true,
        secret: 3,
      },
      async run(input, context): Promise<CommandResult> {
        const git = projects.git
        const [action, projectId, remote, value, ...rest] = tokenize(input)
        const actions = ['remote', 'token', 'forget', 'remove']
        if (action === undefined || !actions.includes(action)) {
          const id = projectOf(action, context)
          const config = id === undefined ? undefined : projects.configOf(id)
          if (config === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, id === undefined ? 'Which project? /git <project-id>' : `No project "${id}". Send /projects to see them.`)
          const remotes = Object.entries(config.git.remotes)
          if (remotes.length === 0) return result(`${config.id} has no git remote. Add one: /git remote ${config.id} origin https://github.com/<owner>/<repo>.git`)
          const lines = await Promise.all(
            remotes.map(async ([name, entry]) => `${name.padEnd(10)} ${entry.url}\n${''.padEnd(11)}${(await git.hasToken(config.id, name)) ? 'token saved' : `no token (/git token ${config.id} ${name} <token>)`}; protected: ${entry.protected.length > 0 ? entry.protected.join(', ') : 'none'}`),
          )
          return result(`${config.id}'s git remotes:\n${lines.join('\n')}`)
        }
        if (!context.isAdmin) return errorResult('Only the admin can change a project’s git remotes and tokens.')
        const config = projectId === undefined ? undefined : projects.configOf(projectId)
        if (config === undefined || remote === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, projectId === undefined || config !== undefined ? `${action} needs a project and a remote.` : `No project "${projectId}". Send /projects to see them.`)
        const known = config.git.remotes[remote]
        if (action === 'remote') {
          if (value === undefined || rest.length > 0) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'remote needs a name and one https:// URL.')
          if (!GIT_REMOTE_PATTERN.test(remote)) return errorResult(`"${remote}" is not a remote name: lowercase letters, digits and dashes.`)
          const problem = remoteUrlProblem(value)
          if (problem !== undefined) return errorResult(problem.replace(/^url: /, ''))
          const written = writeSetting(config.id, (doc) => doc.setIn(['git', 'remotes', remote, 'url'], value))
          if (written !== undefined) return errorResult(`Not changed. ${written}`)
          // A token belongs to the URL it was given for.
          const forgot = known !== undefined && known.url !== value && (await git.forget(config.id, remote))
          return result(`${config.id}: remote ${remote} = ${value}.${forgot ? ' Its token was for the old URL and is forgotten.' : ''}${forgot || known === undefined ? ` Save its token: /git token ${config.id} ${remote} <token>` : ''}`)
        }
        if (known === undefined) return errorResult(`${config.id} has no remote "${remote}". /git ${config.id} lists them.`)
        if (action === 'token') {
          if (value === undefined || rest.length > 0 || value.length < 8) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'token needs the token, one word with no spaces.')
          await git.setToken(config.id, remote, value)
          return result(`${config.id}: the token ${keyTail(value)} for ${remote} (${new URL(known.url).host}) is saved. Only ${config.id}'s git operations on ${remote} use it.`)
        }
        if (action === 'forget') {
          return result((await git.forget(config.id, remote)) ? `${config.id}: the token for ${remote} is forgotten.` : `${config.id}: ${remote} has no token.`)
        }
        const written = writeSetting(config.id, (doc) => {
          doc.deleteIn(['git', 'remotes', remote])
          if (Object.keys(config.git.remotes).length === 1) doc.deleteIn(['git'])
        })
        if (written !== undefined) return errorResult(`Not changed. ${written}`)
        await git.remove(config.id, remote)
        return result(`${config.id}: the remote ${remote}, its token and its copy are removed. The project's own folder is unchanged.`)
      },
    },

    // ── /mail ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'mail',
        description: 'A project’s mail accounts and settings (admin to change)',
        syntax: '/mail [project-id|default] | /mail set <project-id|default> <smtps-url|imaps-url> | /mail remove <project-id|default> [imap] | /mail test <project-id|default> <address|imap> | /mail pause|resume <project-id|all> | /mail outbox <project-id>',
        detail:
          'A project sends mail with send_mail, and Argus does it: the account never reaches ' +
          'the agent, its shell or the conversation. A mail goes unasked only to the ' +
          'project’s mail.trusted_recipients, each within its own daily count and all of them ' +
          'within mail.unattended_per_day; past a limit mail.on_limit asks or refuses, and every ' +
          'other mail is shown to a person first. pause stops unasked mail (for a project, or ' +
          'all) until resume; it pauses itself after 3 failed unasked mails in a row. A mail ' +
          'that needs a person waits in the outbox, and its run goes on; outbox shows what ' +
          'waits and what was decided lately. set deletes your message at once and saves the account, as ' +
          'smtps://user:password@host:465 (or smtp://…:587, with STARTTLS required), for that ' +
          'project or as the default for all. An imaps://user:password@host:993 URL sets the ' +
          'mailbox the project reads instead (mail_list, mail_read, mail_save_attachment, ' +
          'mail_mark_read; the folders in mail.read_folders). Who it may write to, and how much, ' +
          'is in the project’s file: mail.allowed_recipients, mail.max_per_day, ' +
          'mail.max_attachment_mb. test sends one mail with the account to the address you ' +
          'give, or, with imap, signs in to the mailbox. Seeing it is anyone’s; the rest is ' +
          'the admin’s.',
        examples: ['/mail site-firma', '/mail outbox site-firma', '/mail pause all', '/mail resume site-firma', '/mail set default smtps://office%40acme.ro:…@mail.acme.ro:465', '/mail set site-firma imaps://comenzi%40acme.ro:…@mail.acme.ro:993', '/mail test site-firma ana@acme.ro', '/mail test site-firma imap', '/mail remove site-firma imap'],
        mutating: true,
        secret: 2,
      },
      async run(input, context): Promise<CommandResult> {
        const mail = projects.mail
        const [action, target, value, ...rest] = tokenize(input)
        const actions = ['set', 'remove', 'test', 'pause', 'resume', 'outbox']
        if (action === undefined || !actions.includes(action)) {
          if (action === 'default') {
            const found = await mail.accountOf(null)
            const box = await projects.mailbox.accountOf(null)
            return result(
              `${found === undefined ? 'No default mail account. Set one: /mail set default smtps://user:password@host:465' : `The default mail account: ${describeAccount(found.account)}. A project with no account of its own sends with it.`}\n` +
                (box === undefined ? 'No default mailbox. Set one: /mail set default imaps://user:password@host:993' : `The default mailbox: ${describeMailbox(box.account)}. A project with no mailbox of its own reads it.`),
            )
          }
          const id = projectOf(action, context)
          const config = id === undefined ? undefined : projects.configOf(id)
          if (config === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, id === undefined ? 'Which project? /mail <project-id>' : `No project "${id}". Send /projects to see them.`)
          const found = await mail.accountOf(config.id)
          const box = await projects.mailbox.accountOf(config.id)
          const { allowed_recipients: allowed, max_per_day: perDay, max_attachment_mb: mb, from, read_folders: folders, trusted_recipients: trusted, unattended_per_day: unattended, on_limit: onLimit } = config.mail
          const counts = mail.counts(config.id)
          const paused = mail.pausedOf(config.id)
          const trustedLines = Object.entries(trusted).map(([address, perAddress]) => `${address} ${counts.byAddress.get(address) ?? 0}/${perAddress}`)
          return result(
            `${config.id}'s mail:
` +
              `account     ${found === undefined ? `none (/mail set ${config.id} <smtps-url>, or a default)` : `${describeAccount(found.account)}${found.own ? '' : ' (the default)'}`}
` +
              `from        ${from ?? (found === undefined ? '-' : found.account.user)}
` +
              `may write   ${allowed.length === 0 ? `nobody yet (/set ${config.id} mail.allowed_recipients [ana@example.com, @example.com])` : allowed.join(', ')}
` +
              `unasked     ${trustedLines.length === 0 ? 'nobody (mail.trusted_recipients)' : `${trustedLines.join(', ')}; ${counts.unattended}/${unattended} in all; past a limit: ${onLimit}`}${paused.paused ? ` — PAUSED${paused.auto ? ' after failures' : ''} (/mail resume ${config.id})` : ''}
` +
              `limits      ${perDay} recipients a day (${counts.total} in the last 24 hours), ${mb} MB of attachments a mail
` +
              `send_mail   ${config.tools.mail}${config.tools.mail === 'ask' ? ': unasked only to trusted recipients, every other mail shown to a person first (it waits in the outbox)' : ''}
` +
              `mailbox     ${box === undefined ? `none (/mail set ${config.id} <imaps-url>, or a default)` : `${describeMailbox(box.account)}${box.own ? '' : ' (the default)'}, reads ${folders.join(', ')}`}
` +
              `reading     ${box === undefined ? 'no mailbox: its tools are hidden' : config.tools.mail_read}`,
          )
        }
        if (action === 'outbox') {
          const config = target === undefined ? undefined : projects.configOf(target)
          if (config === undefined || value !== undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, target === undefined ? 'Which project? /mail outbox <project-id>' : `No project "${target}". Send /projects to see them.`)
          const rows = projects.outboxOf(config.id)
          if (rows.length === 0) return result(`${config.id}'s outbox is empty: no mail has waited for a person.`)
          const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
          return result(
            `${config.id}'s outbox, newest first (times UTC):\n` +
              rows.map((row) => `#${row.id}  ${row.status.padEnd(8)}  ${when(row.created_at)}  ${row.recipients} recipient(s)${row.why === null ? '' : `  asked: ${row.why}`}${row.note === null ? '' : `  (${row.note})`}`).join('\n') +
              (rows.some((row) => row.status === 'waiting') ? '\nA waiting mail is answered where it was asked, or in the web\'s inbox.' : ''),
          )
        }
        if (!context.isAdmin) return errorResult('Only the admin can change a mail account.')
        if (action === 'pause' || action === 'resume') {
          if (target === undefined || value !== undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, `${action} needs a project, or all.`)
          const projectId = target === 'all' ? null : target
          if (projectId !== null && projects.configOf(projectId) === undefined) return errorResult(`No project "${target}". Send /projects to see them.`)
          const actor = context.user?.id ?? context.userId
          if (action === 'pause') mail.pause(projectId, actor)
          else mail.resume(projectId, actor)
          return result(action === 'pause' ? `Unasked mail is paused for ${projectId ?? 'every project'}: each mail is asked about (or refused, with mail.on_limit: block) until /mail resume ${target}.` : `Unasked mail is resumed for ${projectId ?? 'every project'}.`)
        }
        if (target === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, `${action} needs a project, or default.`)
        const projectId = target === 'default' ? null : target
        if (projectId !== null && projects.configOf(projectId) === undefined) return errorResult(`No project "${target}". Send /projects to see them.`)
        const who = projectId ?? 'the default'
        if (action === 'set') {
          if (value === undefined || rest.length > 0) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'set needs the account, as one smtps:// or imaps:// URL.')
          const saved = /^imaps?:/i.test(value.trim()) ? await projects.mailbox.setAccount(projectId, value) : await mail.setAccount(projectId, value)
          return saved.ok ? result(saved.message) : errorResult(`Not saved. ${saved.message}`)
        }
        if (action === 'remove') {
          if (value === 'imap' && rest.length === 0) return result((await projects.mailbox.removeAccount(projectId)) ? `${who}: the mailbox is removed.` : `${who} has no mailbox of its own.`)
          if (value !== undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'remove takes a project, or default, and imap for the mailbox.')
          return result((await mail.removeAccount(projectId)) ? `${who}: the mail account is removed.` : `${who} has no mail account of its own.`)
        }
        if (value === 'imap' && rest.length === 0) {
          const tested = await projects.mailbox.test(projectId, projectId === null ? 'INBOX' : (projects.configOf(projectId)?.mail.read_folders[0] ?? 'INBOX'))
          return tested.ok ? result(tested.message) : errorResult(tested.message)
        }
        if (value === undefined || rest.length > 0) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'test needs one address to send to, or imap.')
        const sent = await mail.test(projectId, value)
        return sent.ok ? result(sent.message) : errorResult(sent.message)
      },
    },

    // ── /mcp ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'mcp',
        description: 'A project’s MCP servers: sign one in, out, or start it afresh (admin)',
        syntax: '/mcp connect <project-id> <server> | /mcp disconnect <project-id> <server> | /mcp reset <project-id> <server>',
        detail:
          'connect signs a remote server in with OAuth (its oauth: block in the project’s ' +
          'file): it answers with a link to the web, for the admin, which goes to the ' +
          'provider and back; Argus keeps the grant, refreshes it, and the agent never sees ' +
          'a token. Each project has its own grant for each server. disconnect revokes it ' +
          'at the provider when it can, and forgets it. reset empties a local server’s own ' +
          'home (its logins and caches, which the agent cannot read); the project’s agent ' +
          'is let go if idle, and the next message starts the server afresh. /tools ' +
          '<project> shows each server and whether it is connected. Only the admin.',
        examples: ['/mcp connect site-firma notion', '/mcp disconnect site-firma notion', '/mcp reset site-firma browser'],
        mutating: true,
        adminOnly: true,
      },
      async run(input): Promise<CommandResult> {
        const [action, projectId, server] = tokenize(input)
        if (!['connect', 'disconnect', 'reset'].includes(action ?? '') || projectId === undefined || server === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'Which action, which project, and which server?')
        const config = projects.configOf(projectId)
        if (config === undefined) return errorResult(`No project "${projectId}". Send /projects to see them.`)
        const found = config.mcp[server]
        if (found === undefined) return errorResult(`${projectId} has no MCP server "${server}". /tools ${projectId} lists them.`)
        if (action === 'connect') {
          const web = options.web?.()
          if (web === undefined) return errorResult('Connecting signs in through the web interface, which is not running (web.enabled in ops.yaml).')
          const prepared = projects.oauth.prepare(projectId, server)
          if (!prepared.ok) return errorResult(prepared.message)
          return result(
            `Open within 10 minutes, signed in to Argus as the admin, in the browser where you can sign in to ${new URL(found.url ?? 'https://x').host}; it works once:\n` +
              `${web.publicUrl}/oauth/start/${prepared.key}\n` +
              `The provider sends you back to ${web.publicUrl}/oauth/callback, which must be among the client's redirect URIs.`,
          )
        }
        if (action === 'disconnect') {
          return (await projects.oauth.disconnect(projectId, server)) ? result(`${projectId}: ${server} is signed out, and its grant forgotten. Its tools are gone from the project's next message.`) : errorResult(`${projectId}: ${server} is not connected.`)
        }
        if (found.command === null) return errorResult(`${server} is a remote server: it keeps nothing here.`)
        if ((await projects.resetMcpHome(projectId, server)) === 'busy') return errorResult(`${projectId} is in a run. Try again when it ends, or /cancel ${projectId}.`)
        return result(`${projectId}: ${server}'s home is empty. The server starts afresh at the project's next message.`)
      },
    },

    // ── /archive ───────────────────────────────────────────────────────────
    {
      spec: {
        name: 'archive',
        description: 'Archive a project (admin)',
        syntax: '/archive <project-id>',
        detail:
          'Moves the project’s file to projects/archived/ and reloads, so the project ' +
          'stops taking work. Nothing is deleted: its folder, memory, history and costs ' +
          'stay. To bring it back, move the file back and send /reload. A running project ' +
          'must be stopped first. Requires confirmation. Only the admin can run it.',
        examples: ['/archive site-firma'],
        mutating: true,
        destructive: true,
        adminOnly: true,
      },
      run(input, context): CommandResult {
        const projectId = tokenize(input)[0]
        if (projectId === undefined) return failWith({ syntax: this.spec.syntax } as CommandSpec, 'archive needs a project id.')
        const refusal = archiveRefusal(projectId)
        if (refusal !== undefined) return errorResult(refusal)
        return deps.service.requestConfirmationFor(
          `/archive-confirm ${projectId}`,
          context,
          `Archive ${projectId}? It stops taking work. Its folder, memory and history are kept.`,
        )
      },
    },

    // ── /archive-confirm ───────────────────────────────────────────────────
    {
      spec: {
        name: 'archive-confirm',
        description: 'Internal: the confirmed form of /archive',
        syntax: '/archive-confirm <project-id>',
        detail: 'Runs the archive the confirmation asked for. Not meant to be typed.',
        examples: [],
        mutating: true,
        adminOnly: true,
      },
      async run(input, context): Promise<CommandResult> {
        const projectId = tokenize(input)[0] ?? ''
        // Checked again: the project may have started while the question was open.
        const refusal = archiveRefusal(projectId)
        if (refusal !== undefined) return errorResult(refusal)
        const file = (projects.configOf(projectId)?.sourcePath ?? projects.invalidOf(projectId)?.path) as string
        // Its git tokens go: an archived project does not push, and bringing it back asks for them again.
        const remotes = Object.keys(projects.configOf(projectId)?.git.remotes ?? {})
        await projects.git.removeAll(projectId, remotes)
        const dir = join(options.projectsConfigDir, 'archived')
        mkdirSync(dir, { recursive: true })
        // An earlier archive of the same id is kept, not overwritten.
        const name = existsSync(join(dir, `${projectId}.yaml`)) ? `${projectId}-${context.now}.yaml` : `${projectId}.yaml`
        renameSync(file, join(dir, name))
        options.reloadProjects()
        return result(
          `${projectId} is archived; its file is now ${join(dir, name)}.${remotes.length > 0 ? ' Its git tokens are forgotten.' : ''}\n` +
            `To bring it back, move that file to ${join(options.projectsConfigDir, `${projectId}.yaml`)} and send /reload.`,
        )
      },
    },

    // ── /allow ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'allow',
        description: 'Let another user use the bot (admin)',
        syntax: '/allow [<user-id> | remove <user-id>]',
        detail:
          'With no argument, lists the users. With a user id, lets that user on this channel ' +
          'use the bot, after a confirmation. `remove` disables the user on every channel; ' +
          '/allow <user-id> enables them again. The admin cannot be removed. ' +
          'Only the admin can run it.',
        examples: ['/allow', '/allow 123456789', '/allow remove 123456789'],
        mutating: true,
        adminOnly: true,
      },
      run(input, context): CommandResult {
        const tokens = tokenize(input)
        if (tokens.length === 0) {
          return result(
            [
              'Users:',
              ...store.users.list().map((user) => {
                const identities = store.users.identities(user.id).map((identity) => `${identity.channel} ${identity.external_id}`)
                return `  ${user.role.padEnd(8)} ${identities.join(', ') || user.id}${user.name === null ? '' : ` (${user.name})`}${user.disabled_at === null ? '' : '  disabled'}`
              }),
            ].join('\n'),
          )
        }
        const remove = tokens[0]?.toLowerCase() === 'remove'
        const userId = remove ? tokens[1] : tokens[0]
        if (userId === undefined || !/^[\w@.:-]{1,64}$/.test(userId)) {
          return failWith(
            { syntax: this.spec.syntax } as CommandSpec,
            'A user id is letters, digits and - _ . : @, up to 64 characters.',
          )
        }
        const channel = context.address.channel
        const identity = store.users.resolve(channel, userId)
        const user = identity === undefined ? undefined : store.users.get(identity.user_id)
        if (remove) {
          if (user === undefined || user.disabled_at !== null) return errorResult(`${userId} is not a user on ${channel}.`)
          if (user.role === 'admin') return errorResult('The admin cannot be removed.')
          store.users.disable(user.id, context.now)
          return result(`${userId} can no longer use the bot, on any channel.`)
        }
        if (user !== undefined && user.disabled_at === null) return result(`${userId} can already use the bot on ${channel}.`)
        return deps.service.requestConfirmationFor(
          `/allow-confirm ${userId}`,
          context,
          `Let ${userId} use the bot on ${channel}? They can run commands, spend the budgets and talk to every project.`,
        )
      },
    },

    // ── /allow-confirm ─────────────────────────────────────────────────────
    {
      spec: {
        name: 'allow-confirm',
        description: 'Internal: the confirmed form of /allow',
        syntax: '/allow-confirm <user-id>',
        detail: 'Adds the user the confirmation asked about. Not meant to be typed.',
        examples: [],
        mutating: true,
        adminOnly: true,
      },
      run(input, context): CommandResult {
        const userId = tokenize(input)[0] ?? ''
        const channel = context.address.channel
        store.transaction(() => {
          const identity = store.users.resolve(channel, userId)
          if (identity !== undefined) {
            store.users.enable(identity.user_id)
            return
          }
          const id = randomUUID()
          store.users.create({ id, role: 'operator' }, context.now)
          store.users.link({ channel, external_id: userId, user_id: id }, context.now)
        })()
        return result(`${userId} can now use the bot on ${channel}. /allow remove ${userId} takes it back.`)
      },
    },

    // ── /users ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'users',
        description: 'List, invite, disable and reset users (admin)',
        syntax: '/users [invite <name> | remove <user> | enable <user> | reset <user> | name <user> <name> | tailscale <user> <login|none>]',
        detail:
          'With no argument, lists the users: name, role, channels, web login, disabled. ' +
          '`invite <name>` creates an operator and gives a sign-in link valid 24 hours, to send ' +
          'them; with it they set a web password. `remove` disables a user on every channel and ' +
          'signs them out; `enable` takes them back. `reset` removes their web password and authenticator code, signs ' +
          'them out and gives a new 24-hour link. A <user> is a name, a web login name, an id, ' +
          'or channel:id (telegram:123456789). The admin cannot be removed. `tailscale` links a ' +
          'Tailscale login (you@github) to a user: with web.tailscale_identity on, opening the ' +
          'interface through tailscale serve signs them in, no password.',
        examples: ['/users', '/users invite Ana', '/users reset Ana', '/users remove telegram:123456789'],
        mutating: true,
        adminOnly: true,
      },
      run(input, context): CommandResult {
        const tokens = tokenize(input)
        const verb = tokens[0]?.toLowerCase()
        if (verb === undefined) {
          return result(
            [
              'Users:',
              ...store.users.list().map((user) => {
                const channels = store.users.identities(user.id).filter((identity) => identity.channel !== 'web').map((identity) => `${identity.channel}:${identity.external_id}`)
                const login = store.webAuth.login(user.id)?.login
                return (
                  `  ${userLabel(user)}  ${user.role}` +
                  `${channels.length === 0 ? '' : `  ${channels.join(', ')}`}` +
                  `${login === undefined ? '' : `  web: ${login}`}` +
                  `${user.disabled_at === null ? '' : '  disabled'}` +
                  `  (${user.id})`
                )
              }),
            ].join('\n'),
          )
        }
        const web = options.web?.()
        if (verb === 'invite') {
          const name = input.trim().slice('invite'.length).trim()
          if (name.length === 0 || name.length > 64) return failWith(this.spec, 'Give the person a name, up to 64 characters.')
          if (web === undefined) return errorResult('The web interface is not running (web.enabled in ops.yaml): an invitation is a web sign-in.')
          const id = randomUUID()
          store.users.create({ id, name, role: 'operator' }, context.now)
          return result(
            `${name} is an operator now. Send them this link; it works once, within 24 hours, and lets them set a web password:\n${web.inviteLink(id)}\n` +
              'On Telegram, they can then connect with /link from the web.',
          )
        }
        if (!['remove', 'enable', 'reset', 'name', 'tailscale'].includes(verb)) return failWith(this.spec, `Unknown /users ${verb}.`)
        const reference = tokens[1]
        const user = reference === undefined ? undefined : findUser(reference)
        if (user === undefined) return errorResult(`No user ${reference ?? ''}. /users lists them.`.replace('  ', ' '))
        const label = userLabel(user)
        if (verb === 'name') {
          const name = input.trim().replace(/^name\s+\S+\s*/i, '').trim()
          if (name.length === 0 || name.length > 64) return failWith(this.spec, 'A name is 1 to 64 characters.')
          store.users.setName(user.id, name)
          return result(`${label} is called ${name} now.`)
        }
        if (verb === 'enable') {
          return store.users.enable(user.id) ? result(`${label} can use Argus again.`) : result(`${label} is not disabled.`)
        }
        if (verb === 'tailscale') {
          const login = tokens[2]?.toLowerCase()
          if (login === undefined) return failWith(this.spec, 'tailscale needs a Tailscale login (you@github, you@example.com) or none.')
          for (const identity of store.users.identities(user.id).filter((each) => each.channel === 'tailscale')) store.users.unlink('tailscale', identity.external_id)
          if (login === 'none') return result(`${label} has no Tailscale login now.`)
          if (!/^[^\s@]+@[^\s@]+$/.test(login)) return errorResult(`"${login}" is not a Tailscale login: it looks like you@github or you@example.com.`)
          const owner = store.users.identity('tailscale', login)
          if (owner !== undefined && owner.user_id !== user.id) return errorResult(`${login} is ${userLabel(store.users.get(owner.user_id) ?? user)}'s already.`)
          store.users.link({ channel: 'tailscale', external_id: login, user_id: user.id }, options.now())
          return result(`${label} signs in as ${login} on Tailscale, where web.tailscale_identity is on: no password on their own devices.`)
        }
        if (user.role === 'admin') return errorResult(`The admin cannot be ${verb === 'remove' ? 'removed' : 'reset'} here.`)
        if (verb === 'remove') {
          if (!store.users.disable(user.id, context.now)) return result(`${label} is already disabled.`)
          store.webAuth.deleteUserSessions(user.id)
          return result(`${label} can no longer use Argus, on any channel, and is signed out of the web.`)
        }
        if (web === undefined) return errorResult('The web interface is not running (web.enabled in ops.yaml).')
        if (user.disabled_at !== null) return errorResult(`${label} is disabled; /users enable ${reference ?? ''} first.`)
        store.transaction(() => {
          store.webAuth.deleteLogin(user.id)
          store.webAuth.deleteTotp(user.id)
          store.webAuth.deleteUserSessions(user.id)
        })()
        return result(`${label}'s web password and authenticator code are removed and they are signed out. Send them this link; it works once, within 24 hours, and lets them set a new one:\n${web.inviteLink(user.id)}`)
      },
    },

    // ── /link ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'link',
        description: 'Connect another channel (Telegram) to your user',
        syntax: '/link [<code>]',
        detail:
          'Without a code, gives a code valid 10 minutes. Send `/link <code>` from the other ' +
          'channel (to the bot in Telegram, for instance): that account becomes yours, with ' +
          'your role. It is the one message Argus accepts from an account it does not know yet. ' +
          'An account that is already someone else\'s is not moved.',
        examples: ['/link', '/link K7QX2M9P'],
        mutating: true,
      },
      run(input, context): CommandResult {
        const code = tokenize(input)[0]?.toUpperCase()
        const now = context.now
        for (const [key, entry] of linkCodes) if (entry.expiresAt < now) linkCodes.delete(key)
        if (code === undefined) {
          if (context.user === undefined) return errorResult('Only a user of Argus can ask for a code.')
          const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
          const fresh = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('')
          linkCodes.set(fresh, { userId: context.user.id, expiresAt: now + 10 * 60_000 })
          return result(`Send this from the account to connect (to the bot in Telegram, for instance) within 10 minutes:\n/link ${fresh}`)
        }
        const sender = `${context.address.channel}:${context.userId}`
        const fails = (linkFails.get(sender) ?? []).filter((at) => at > now - 15 * 60_000)
        if (fails.length >= 5) return errorResult('Too many wrong codes. Wait a quarter of an hour.')
        const entry = linkCodes.get(code)
        if (entry === undefined) {
          linkFails.set(sender, [...fails, now])
          return errorResult('That code is not valid: it was used already, or it is older than 10 minutes. Ask for a new one with /link.')
        }
        linkCodes.delete(code)
        linkFails.delete(sender)
        const owner = store.users.get(entry.userId)
        if (owner === undefined || owner.disabled_at !== null) return errorResult('The user who asked for that code cannot use Argus any more.')
        const existing = store.users.identity(context.address.channel, context.userId)
        if (existing !== undefined) {
          return existing.user_id === owner.id
            ? result(`This ${context.address.channel} account is already ${userLabel(owner)}'s.`)
            : errorResult(`This ${context.address.channel} account belongs to another user; it is not moved. The admin can /users remove that user first.`)
        }
        store.users.link({ channel: context.address.channel, external_id: context.userId, user_id: owner.id }, now)
        return result(`Connected: this ${context.address.channel} account is ${userLabel(owner)}'s, with the ${owner.role}'s rights. Notices and approvals for you arrive here too.`)
      },
    },

    // ── /allow-free ────────────────────────────────────────────────────────
    {
      spec: {
        name: 'allow-free',
        description: 'Allow a free remote model to run (admin)',
        syntax: '/allow-free <provider/model>',
        detail:
          'A remote model priced at $0 — an OpenRouter :free variant, or a 0 in ops.yaml — is ' +
          'refused until you allow it, because free remote models are often rate-limited and may ' +
          'log or train on what they are sent, and a 0 that is a typo would disable every budget. ' +
          'Local providers (local_providers, default ollama) need nothing. Requires confirmation.',
        examples: ['/allow-free openrouter/deepseek/deepseek-flash:free'],
        mutating: true,
        adminOnly: true,
        destructive: true,
      },
      run(input, context): CommandResult {
        const parsed = parseModelRef(tokenize(input)[0] ?? '')
        if (!parsed.ok) return failWith({ syntax: this.spec.syntax } as CommandSpec, parsed.message)
        if (!meter.needsFreeConfirmation(parsed.value)) {
          const price = meter.priceOf(parsed.value)
          return result(
            price === undefined
              ? `${parsed.value.text} has no price at all; free confirmation does not apply. Add it to pricing in ops.yaml.`
              : `${parsed.value.text} needs no confirmation. ${priceLine(parsed.value)}`,
          )
        }
        return deps.service.requestConfirmationFor(
          `/allow-free-confirm ${parsed.value.text}`,
          context,
          `Allow ${parsed.value.text} at $0? Free remote models are often rate-limited and may log or ` +
            'train on what they are sent. Its usage will be accounted at $0.',
        )
      },
    },

    // ── /allow-free-confirm ────────────────────────────────────────────────
    {
      spec: {
        name: 'allow-free-confirm',
        description: 'Internal: the confirmed form of /allow-free',
        syntax: '/allow-free-confirm <provider/model>',
        detail: 'Records the confirmation /allow-free asked for. Not meant to be typed.',
        examples: [],
        mutating: true,
        adminOnly: true,
      },
      run(input, context): CommandResult {
        const parsed = parseModelRef(tokenize(input)[0] ?? '')
        if (!parsed.ok) return errorResult(parsed.message)
        meter.confirmFree(parsed.value, context.userId)
        governor.requestDispatch()
        return result(`${parsed.value.text} may now run. Its usage is accounted at $0.`)
      },
    },

    // ── /reload ────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'reload',
        description: 'Re-read the project files',
        syntax: '/reload',
        detail:
          'Re-reads every project file, so an edited or fixed file takes effect without a restart. ' +
          'A file that does not validate marks that project invalid and ignored; every other ' +
          'project keeps running. A project whose file was removed is archived, never deleted.',
        examples: ['/reload'],
        mutating: true,
      },
      run(): CommandResult {
        let report
        try {
          report = options.reloadProjects()
        } catch (err) {
          return errorResult(`Could not reload the projects: ${(err as Error).message}`)
        }
        const lines = [`Reloaded: ${report.synced.length} project(s) loaded.`]
        if (report.fixed.length > 0) lines.push(`Valid again: ${report.fixed.join(', ')}`)
        if (report.restored.length > 0) lines.push(`Restored: ${report.restored.join(', ')}`)
        if (report.archived.length > 0) lines.push(`Archived (file removed): ${report.archived.join(', ')}`)
        for (const project of report.invalid) {
          lines.push('', `Invalid, ignored: ${project.id} — ${project.path}`)
          for (const issue of project.reason.split('\n')) lines.push(`  ${issue}`)
        }
        return result(lines.join('\n'))
      },
    },

    // ── /cron ──────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'cron',
        description: 'Manage scheduled tasks',
        syntax: '/cron list | add <project> <schedule> <text> | remove <id> | enable <id> | disable <id>',
        detail: 'Delegates to ops-scheduler. Without that plugin, the command reports it is unavailable.',
        examples: ['/cron list', '/cron add site-firma "0 9 * * *" check the build'],
        mutating: true,
        requires: 'ops-scheduler',
      },
      run(input, context): CommandResult {
        const scheduler = options.scheduler?.()
        if (scheduler === undefined) {
          return errorResult('The scheduler is not installed on this deployment.')
        }
        return scheduler.run(input, context)
      },
    },

    // ── /health ────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'health',
        description: 'Show subsystem health',
        syntax: '/health',
        detail: 'Delegates to ops-health. Without that plugin, reports a summary of what it can see.',
        examples: ['/health'],
        mutating: false,
        requires: 'ops-health',
      },
      run(): CommandResult {
        const health = options.health?.()
        if (health !== undefined) return result(health.report().text)
        // A degraded fallback rather than an error: the governor's own view is
        // still useful, and a missing health plugin is not a failure.
        const status = governor.status()
        return result(
          [
            'ops-health is not installed; showing what the governor can see.',
            `  panic     ${status.panic ? 'ON' : 'off'}`,
            `  running   ${status.running.length}`,
            `  pending   ${status.pending.length}`,
            `  slots     ${status.slots.globalUsed}/${status.slots.globalLimit}`,
          ].join('\n'),
        )
      },
    },

    // ── /panic ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'panic',
        description: 'Stop everything and refuse new work',
        syntax: '/panic',
        detail:
          'Cancels every running agent, rejects everything queued, and refuses new requests. ' +
          'Requires confirmation. It survives a restart until /resume-all.',
        examples: ['/panic'],
        mutating: true,
        destructive: true,
      },
      run(_input, context): CommandResult {
        return deps.service.requestConfirmationFor(
          // The CONFIRMED form is a command of its own, so answering Yes runs it
          // through the same registry and audit path as anything else. Pointing
          // at `/panic` again would ask the user to confirm forever.
          '/panic-confirm',
          context,
          'Stop every running agent and refuse all new work?',
        )
      },
    },

    // ── /panic --yes (the confirmed form) ──────────────────────────────────
    {
      spec: {
        name: 'panic-confirm',
        description: 'Internal: the confirmed form of /panic',
        syntax: '/panic-confirm',
        detail: 'Runs the panic the confirmation asked for. Not meant to be typed.',
        examples: [],
        mutating: true,
      },
      run(): CommandResult {
        // Fire and forget: the kill switch must not make the reply wait, and the
        // channel learns the outcome through `ops/panic`.
        void governor.panic()
        return result('Panic engaged. Nothing new will run until /resume-all.')
      },
    },

    // ── /resume-all ────────────────────────────────────────────────────────
    {
      spec: {
        name: 'resume-all',
        description: 'Clear panic mode and resume',
        syntax: '/resume-all',
        detail: 'Clears panic mode and re-dispatches anything that is still queued.',
        examples: ['/resume-all'],
        mutating: true,
      },
      run(): CommandResult {
        if (!governor.isPanic) return result('Panic mode is already off.')
        governor.resumeAll()
        return result('Resumed. Queued work will be admitted again.')
      },
    },

    // ── /confirm ───────────────────────────────────────────────────────────
    {
      spec: {
        name: 'confirm',
        description: 'Answer a confirmation',
        syntax: '/confirm <token> <yes|no>',
        detail:
          'Answers a confirmation a destructive command asked for. A channel turns its ' +
          'Yes/No buttons into this line, so an answer runs through the same dispatch, ' +
          'audit and access path as anything else.',
        examples: ['/confirm 9f8e7d6c yes'],
        mutating: true,
      },
      run(input, context): Promise<CommandResult> {
        const [token, answer] = tokenize(input)
        if (token === undefined || answer === undefined) {
          return Promise.resolve(
            failWith(
              { syntax: '/confirm <token> <yes|no>' } as CommandSpec,
              'confirm needs a token and an answer.',
            ),
          )
        }
        return deps.service.confirm(token, answer.toLowerCase() === 'yes', context)
      },
    },

    // ── /reset ─────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'reset',
        description: 'Start a project’s conversation over',
        syntax: '/reset <project-id>',
        detail:
          'Disposes the project’s agent and clears its recorded session, so the next message ' +
          'starts a fresh conversation. The old session stays on disk and is referenced in the ' +
          'audit log. Requires confirmation.',
        examples: ['/reset site-firma'],
        mutating: true,
        destructive: true,
      },
      run(input, context): CommandResult {
        const projectId = tokenize(input)[0]
        if (projectId === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'reset needs a project id.')
        }
        if (projectState(projectId).found === false) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, `No project "${projectId}".`)
        }
        return deps.service.requestConfirmationFor(
          `/reset-confirm ${projectId}`,
          context,
          `Start ${projectId}'s conversation over? Its history will not be deleted, but the project will no longer continue it.`,
        )
      },
    },

    // ── /reset-confirm ─────────────────────────────────────────────────────
    {
      spec: {
        name: 'reset-confirm',
        description: 'Internal: the confirmed form of /reset',
        syntax: '/reset-confirm <project-id>',
        detail: 'Runs the reset the confirmation asked for. Not meant to be typed.',
        examples: [],
        mutating: true,
      },
      run(input, context): Promise<CommandResult> {
        const projectId = tokenize(input)[0]
        if (projectId === undefined) return Promise.resolve(errorResult('reset-confirm needs a project id.'))
        return projects.reset(projectId, context.userId).then(() =>
          result(`${projectId}'s conversation was reset. The next message starts fresh.`),
        )
      },
    },
  ]
}

/**
 * A `/set` value.
 *
 * Only a number, a boolean, null, a [list] or a {map} is read as YAML. Anything else
 * is the text as typed: as YAML, `fix #3` would lose its end to a comment and
 * `Site: blog` would become a map.
 */
function settingValue(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  // A quoted string is taken as JSON: how a form sends text that looks like a number or a list.
  if (text.startsWith('"')) {
    try {
      const value = JSON.parse(text) as unknown
      if (typeof value === 'string') return { ok: true, value }
    } catch {
      // Not JSON: the text as it is.
    }
  }
  if (!/^[[{]/.test(text) && !/^(true|false|null|-?\d+(\.\d+)?)$/i.test(text)) return { ok: true, value: text }
  try {
    return { ok: true, value: parseYaml(text) as unknown }
  } catch (err) {
    return { ok: false, message: (err as Error).message.split('\n')[0] ?? 'unparseable' }
  }
}

/** A server's tool rules, after its access: `; read_* allow, erase deny`. */
function toolRules(tools: Readonly<Record<string, string>>): string {
  const rules = Object.entries(tools).map(([tool, access]) => `${tool} ${access}`)
  return rules.length === 0 ? '' : `; ${rules.join(', ')}`
}

/** What an extension may do, one part each: its tools, skills, secrets, network. */
function describeParts(manifest: ExtensionManifest): string[] {
  const servers = Object.entries(manifest.mcp).map(([name, server]) => `${name} (${commandLine(server)}, access ${server.access}${toolRules(server.tools)})`)
  return [
    ...(servers.length > 0 ? [`tools: ${servers.join(', ')}`] : []),
    ...(manifest.skills.length > 0 ? [`skills: ${manifest.skills.join(', ')}`] : []),
    ...(manifest.requires.secrets.length > 0 ? [`secrets: ${manifest.requires.secrets.join(', ')}`] : []),
    ...(manifest.requires.network ? ['needs the network'] : []),
    ...(manifest.bin.length > 0 ? [`programs in the project's shell: ${manifest.bin.map((path) => path.split('/').pop()).join(', ')}`] : []),
    ...Object.entries(manifest.env).map(([key, value]) => `sets ${key}=${value}`),
    ...(manifest.rules.length > 0 ? [`offers the rules: ${manifest.rules.join(', ')}`] : []),
  ]
}

/**
 * The question `/ext install` and `/ext update` ask: what the extension brings, and for an
 * update, what changes in what it may do.
 *
 * @param staged the fetched extension.
 * @returns the question.
 */
function describeStaged(staged: StagedExtension): string {
  const { manifest, installed } = staged
  const head = installed === undefined
    ? `Install ${manifest.name} ${manifest.version} (${staged.commit.slice(0, 7)}) from ${staged.source}?`
    : `Update ${manifest.name} ${installed.version} (${installed.commit.slice(0, 7)}) to ${manifest.version} (${staged.commit.slice(0, 7)})?`
  const lines = [head, manifest.summary, '']
  const servers = Object.entries(manifest.mcp)
  lines.push(servers.length === 0 ? 'Tools: none' : `Tools (MCP servers, run confined to the project's folder):\n${servers.map(([name, server]) => `  ${name}: ${commandLine(server)}, access ${server.access}${toolRules(server.tools)}`).join('\n')}`)
  lines.push(`Skills: ${manifest.skills.length === 0 ? 'none' : manifest.skills.join(', ')}`)
  if (manifest.bin.length > 0) lines.push(`Programs a project's shell can run (confined, with the usual approvals): ${manifest.bin.map((path) => `${path.split('/').pop()} (${path})`).join(', ')}`)
  if (Object.keys(manifest.env).length > 0) lines.push(`Sets for a project's commands: ${Object.entries(manifest.env).map(([key, value]) => `${key}=${value}`).join(', ')}`)
  if (manifest.rules.length > 0) lines.push(`Offers, at enable, the rules: ${manifest.rules.join(', ')} (applied only if you press them)`)
  lines.push(`Secrets it reads: ${manifest.requires.secrets.length === 0 ? 'none' : manifest.requires.secrets.join(', ')}`)
  lines.push(`Network: ${manifest.requires.network ? 'yes' : 'not needed'}`)
  if (manifest.install.length > 0) lines.push(`Runs now, in the sandbox (only its own folder, with the network):\n${manifest.install.map((line) => `  ${line}`).join('\n')}`)
  if (manifest.instructions.length > 0) lines.push(`Adds to the instructions of a project that enables it:\n  ${manifest.instructions.length > 300 ? `${manifest.instructions.slice(0, 300)}…` : manifest.instructions}`)
  if (installed !== undefined) {
    const was = staged.installedManifest === undefined ? [] : describeParts(staged.installedManifest)
    const now = describeParts(manifest)
    const gone = was.filter((part) => !now.includes(part))
    const added = now.filter((part) => !was.includes(part))
    lines.push('', gone.length + added.length === 0 ? 'What it may do does not change.' : `What changes:\n${[...gone.map((part) => `  - ${part}`), ...added.map((part) => `  + ${part}`)].join('\n')}`)
  }
  return lines.join('\n')
}

/** A skill's name, as dsh requires it: kebab-case. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
/** The largest SKILL.md `/skill add` writes. */
const SKILL_MAX_BYTES = 32_768

/**
 * The SKILL.md `/skill add` writes: the text as sent when it has its own front matter
 * (which must name the skill and describe it), or the text with front matter made from
 * its first line.
 *
 * @param name the skill's name.
 * @param text what was sent after the name.
 * @returns the file, or why not.
 */
function skillFile(name: string, text: string): { ok: true; text: string } | { ok: false; message: string } {
  const body = text.trim()
  if (body.length === 0) return { ok: false, message: 'A skill needs its text after the name: the first line says what it is for.' }
  if (Buffer.byteLength(body) > SKILL_MAX_BYTES) return { ok: false, message: `A skill is at most ${SKILL_MAX_BYTES / 1024} KB.` }
  if (body.startsWith('---')) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1]
    if (front === undefined) return { ok: false, message: 'The front matter does not end with ---.' }
    if (/^name:\s*["']?([^"'\s]+)/m.exec(front)?.[1] !== name) return { ok: false, message: `The front matter must say name: ${name}.` }
    if (!/^description:\s*\S/m.test(front)) return { ok: false, message: 'The front matter must have a description.' }
    return { ok: true, text: `${body}\n` }
  }
  const [first = '', ...rest] = body.split('\n')
  return { ok: true, text: `---\nname: ${name}\ndescription: ${JSON.stringify(first.trim())}\n---\n${rest.join('\n').trim() || first.trim()}\n` }
}

/** Every settable key of a loaded project, dotted. */
function settingKeys(config: unknown, prefix = ''): string[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return [prefix]
  return Object.entries(config as Record<string, unknown>)
    .filter(([key]) => prefix.length > 0 || !['id', 'cwd', 'provider', 'sourcePath', 'template', 'fromTemplate', 'extensionsMissing'].includes(key))
    .flatMap(([key, value]) => settingKeys(value, prefix.length === 0 ? key : `${prefix}.${key}`))
}

/** How many past runs `/estimate` reads. */
const ESTIMATE_RUNS = 30
/** How many rows `/runs` shows. */
const RUNS_SHOWN = 10
/** How many past decisions `/approvals` shows. */
const APPROVALS_SHOWN = 5
/** How many entries `/files` shows. */
const FILES_SHOWN = 40
/** A memory longer than this is sent as a file: a chat message is no place to read it. */
const MEMORY_INLINE_CHARS = 3_000
/** How much of the request `/log` shows. */
const LOG_REQUEST_CHARS = 300

/** The action an approval row is about, from its recorded request. */
function actionOf(requestJson: string): string {
  try {
    const request = JSON.parse(requestJson) as { action?: unknown; toolName?: unknown }
    const action = typeof request.action === 'string' ? request.action : String(request.toolName ?? '?')
    return truncate(action.replace(/\s+/g, ' '), 48)
  } catch {
    return '?'
  }
}

/** The text of an inbound request, from its stored envelope. */
function requestText(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { content?: Array<{ type?: string; text?: string }> }
    const text = (parsed.content ?? []).flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
    return text.length > 0 ? text.replace(/\s+/g, ' ').trim() : undefined
  } catch {
    return undefined
  }
}

/** A byte count as a short human size. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A run id for an ad-hoc task. */
function randomRunId(): string {
  return `task-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** How an owner renders in a table. */
function ownerText(owner: { kind: string; projectId?: string; runId?: string }): string {
  if (owner.kind === 'project') return owner.projectId ?? 'project'
  if (owner.kind === 'adhoc') return `adhoc:${truncate(owner.runId ?? '', 10)}`
  return 'orchestrator'
}

export { ownerText, randomRunId }
export type { ModelRef }

/** An extension server's command line as a person reads it: its folder is `<extension>`. */
function commandLine(server: { readonly command: string; readonly args: readonly string[] }): string {
  return [server.command, ...server.args].join(' ').replaceAll('${EXTENSION_DIR}', '<extension>')
}
