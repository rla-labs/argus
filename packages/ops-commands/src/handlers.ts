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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as toYaml } from 'yaml'
import type { ModelRef, Scope } from '@argus-agent/types'
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
import { errorResult, result, type CommandContext, type CommandResult, type CommandSpec } from './types.js'
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
