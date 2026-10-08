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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml, parseDocument, stringify as toYaml } from 'yaml'
import type { ModelRef, Scope } from '@argus-agent/types'
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
  tokenize,
  truncate,
} from './parse.js'
import {
  ADDED_USERS_KEY,
  errorResult,
  result,
  type AddedUser,
  type CommandContext,
  type CommandResult,
  type CommandSpec,
} from './types.js'
import type { CommandsOptions } from './service.js'
import type { CommandHandler } from './types.js'

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
        syntax: '/stop [project-id]',
        detail:
          'Stops the turn that is running now. Queued messages are kept, so work that has not ' +
          'started still runs. With no argument, acts on this chat’s active project.',
        examples: ['/stop', '/stop site-firma'],
        mutating: true,
      },
      run(input, context): CommandResult {
        const argument = tokenize(input)[0]
        const projectId = projectOf(argument, context)
        if (projectId === undefined) {
          return failWith(
            { syntax: '/stop [project-id]' } as CommandSpec,
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
        const { requestId } = governor.submit({
          source: 'channel',
          target: { adhoc: { runId: randomRunId(), model: options.adhocModel } },
          content: [{ type: 'text', text }],
          priority: 0,
          replyTo: context.address,
          model: options.adhocModel,
        })
        return result(`Task queued (${truncate(requestId, 8)}). I will report when it finishes.`, {
          data: { requestId },
        })
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

    // ── /forget ────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'forget',
        description: 'Remove one section of a project’s memory',
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
        description: 'Show or change a budget',
        syntax: '/budget <scope> [+<usd> | unlock <duration> | set <day|month> <usd>]',
        detail:
          'With no action, shows the scope’s state. `+<usd>` adds temporary headroom and ' +
          're-dispatches, which is also what un-pauses a project the hard action stopped. ' +
          '`unlock <duration>` grants headroom that expires. `set <day|month> <usd>` changes ' +
          'the limit itself. Scope is global, adhoc or a project id.',
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
          return result(`Set the ${period} limit for ${scope} to $${formatUsd(money.value)}.`)
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
        description: 'Change a project’s model',
        syntax: '/model <project-id> <provider/model>',
        detail:
          'Records a runtime override. A live agent keeps its current model — dsh fixes the ' +
          'model at agent creation — so the change applies to the next agent, or immediately ' +
          'after /reset. A configuration reload reverts it, because the file is the durable intent.',
        examples: ['/model site-firma deepseek/deepseek-flash'],
        mutating: true,
      },
      async run(input, context): Promise<CommandResult> {
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
        if (!projects.setModel(projectId, parsed.value.text, context.userId)) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, `No project "${projectId}".`)
        }
        return result(
          `${projectId} now uses ${parsed.value.text}. ` +
            'A running agent keeps its old model until it is reset.\n' +
            priceLine(parsed.value),
        )
      },
    },

    // ── /new ───────────────────────────────────────────────────────────────
    {
      spec: {
        name: 'new',
        description: 'Create a project',
        syntax: '/new <id> [provider/model]',
        detail:
          'Creates the project folder, writes a project file from a template, and reloads the ' +
          'configuration so the project is usable at once. The id must be lowercase letters, ' +
          'digits and dashes. Without a model it uses tasks.model. A model whose provider has ' +
          'no API key (<PROVIDER>_API_KEY) or no price is refused.',
        examples: ['/new site-firma', '/new reports zai/glm-5.3-flash', '/new notes openrouter/deepseek/deepseek-v4-flash'],
        mutating: true,
      },
      async run(input, context): Promise<CommandResult> {
        const tokens = tokenize(input)
        const id = tokens[0]
        if (id === undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, 'new needs an id.')
        }
        if (!isValidProjectId(id)) {
          return failWith(
            { syntax: this.spec.syntax } as CommandSpec,
            `"${id}" is not a valid id. Use lowercase letters, digits and dashes, 2 to 41 characters.`,
          )
        }
        if (projects.configOf(id) !== undefined || store.projects.get(id) !== undefined) {
          return failWith({ syntax: this.spec.syntax } as CommandSpec, `Project "${id}" already exists.`)
        }

        const defaultModel = tokens[1] ?? `${options.adhocModel.provider}/${options.adhocModel.model}`
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
              description: `Created by ${context.userId} with /new.`,
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
        return result(
          `Created project ${id} using ${parsed.value.text}.\n` +
            `  folder  ${cwd}\n  file    ${file}\n` +
            `${priceLine(parsed.value)}\n` +
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
          'validate is not written. Keys are dotted: budget.day_usd, limits.max_steps_per_run, ' +
          'approvals.mode, approvals.auto_allow, description, fallback_model, preset, progress. ' +
          '`model` takes provider/model. id and cwd cannot be changed. A list is written ' +
          '[like, this]. Only the admin can run it.',
        examples: [
          '/set site-firma budget.day_usd 5',
          '/set site-firma approvals.auto_allow [git status, npm test]',
          '/set site-firma model openrouter/deepseek/deepseek-v4-flash',
          '/set site-firma description The company website and its blog',
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
        // A loaded project has every key, defaults included, so a key it lacks is a
        // typo that the file would keep and nothing would read.
        const loaded = projects.configOf(projectId)
        const known = loaded === undefined ? undefined : settingKeys(loaded)
        if (known !== undefined && key !== 'model' && !known.includes(key)) {
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
          doc.setIn(path, value.value)
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
        const later = ['model', 'provider', 'preset', 'fallback_model'].includes(path[0] ?? '')
          ? ' The running agent keeps the old one until /reset.'
          : ''
        return result(`${projectId}: ${key} = ${shown}. Written to ${file}.${later}`)
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
      run(input, context): CommandResult {
        const projectId = tokenize(input)[0] ?? ''
        // Checked again: the project may have started while the question was open.
        const refusal = archiveRefusal(projectId)
        if (refusal !== undefined) return errorResult(refusal)
        const file = (projects.configOf(projectId)?.sourcePath ?? projects.invalidOf(projectId)?.path) as string
        const dir = join(options.projectsConfigDir, 'archived')
        mkdirSync(dir, { recursive: true })
        // An earlier archive of the same id is kept, not overwritten.
        const name = existsSync(join(dir, `${projectId}.yaml`)) ? `${projectId}-${context.now}.yaml` : `${projectId}.yaml`
        renameSync(file, join(dir, name))
        options.reloadProjects()
        return result(
          `${projectId} is archived; its file is now ${join(dir, name)}.\n` +
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
          'With no argument, lists the users added here. With a user id, lets that user on ' +
          'this channel use the bot, after a confirmation. `remove` takes the access away. ' +
          'Users listed in access.allowed_users in ops.yaml are changed there, not here. ' +
          'Only the admin can run it.',
        examples: ['/allow', '/allow 123456789', '/allow remove 123456789'],
        mutating: true,
        adminOnly: true,
      },
      run(input, context): CommandResult {
        const tokens = tokenize(input)
        const added = store.runtimeState.get<AddedUser[]>(ADDED_USERS_KEY) ?? []
        if (tokens.length === 0) {
          if (added.length === 0) {
            return result('No user was added with /allow. The admin and access.allowed_users in ops.yaml can use the bot.')
          }
          return result(
            [
              'Added with /allow:',
              ...added.map((user) => `  ${user.channel} ${user.userId}`),
              '',
              'Plus the admin and access.allowed_users in ops.yaml.',
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
        const same = (user: AddedUser): boolean => user.channel === channel && user.userId === userId
        if (remove) {
          if (!added.some(same)) {
            return errorResult(`${userId} was not added with /allow. A user in access.allowed_users is removed in ops.yaml.`)
          }
          store.runtimeState.set(ADDED_USERS_KEY, added.filter((user) => !same(user)), context.now)
          return result(`${userId} can no longer use the bot on ${channel}.`)
        }
        if (added.some(same)) return result(`${userId} can already use the bot on ${channel}.`)
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
        const added = store.runtimeState.get<AddedUser[]>(ADDED_USERS_KEY) ?? []
        if (!added.some((user) => user.channel === channel && user.userId === userId)) {
          store.runtimeState.set(ADDED_USERS_KEY, [...added, { channel, userId }], context.now)
        }
        return result(`${userId} can now use the bot on ${channel}. /allow remove ${userId} takes it back.`)
      },
    },

    // ── /allow-free ────────────────────────────────────────────────────────
    {
      spec: {
        name: 'allow-free',
        description: 'Allow a free remote model to run',
        syntax: '/allow-free <provider/model>',
        detail:
          'A remote model priced at $0 — an OpenRouter :free variant, or a 0 in ops.yaml — is ' +
          'refused until you allow it, because free remote models are often rate-limited and may ' +
          'log or train on what they are sent, and a 0 that is a typo would disable every budget. ' +
          'Local providers (local_providers, default ollama) need nothing. Requires confirmation.',
        examples: ['/allow-free openrouter/deepseek/deepseek-flash:free'],
        mutating: true,
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
        if (options.scheduler === undefined) {
          return errorResult('The scheduler is not installed on this deployment.')
        }
        return options.scheduler.run(input, context)
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
        if (options.health !== undefined) return result(options.health.report().text)
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
  if (!/^[[{]/.test(text) && !/^(true|false|null|-?\d+(\.\d+)?)$/i.test(text)) return { ok: true, value: text }
  try {
    return { ok: true, value: parseYaml(text) as unknown }
  } catch (err) {
    return { ok: false, message: (err as Error).message.split('\n')[0] ?? 'unparseable' }
  }
}

/** Every settable key of a loaded project, dotted. */
function settingKeys(config: unknown, prefix = ''): string[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return [prefix]
  return Object.entries(config as Record<string, unknown>)
    .filter(([key]) => prefix.length > 0 || !['id', 'cwd', 'provider', 'sourcePath'].includes(key))
    .flatMap(([key, value]) => settingKeys(value, prefix.length === 0 ? key : `${prefix}.${key}`))
}

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
