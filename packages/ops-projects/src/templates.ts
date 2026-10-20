// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/projects/templates` — the kinds of project `/new` can start from.
 *
 * A template is the settings a kind of work needs (its tools, its unasked commands,
 * its limits) and the instructions its agent starts with. Four are built in; a
 * `<config_dir>/templates/<name>.yaml` adds one, or replaces a built-in of the
 * same name. A project file that says `template: <name>` follows it: what the file
 * does not set comes from the template, so a later change to the template reaches it.
 *
 * @module @argus-agent/projects/templates
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { leafPaths, parseProjectConfig } from './project-config.js'

/** A kind of project. */
export interface ProjectTemplate {
  readonly name: string
  /** One line for the list `/new` shows. */
  readonly summary: string
  /** The project's `description`, which the front desk routes on. */
  readonly description: string
  /** The project's first `INSTRUCTIONS.md`. */
  readonly instructions: string
  /** The rest of the project file: tools, approvals, limits, mcp... */
  readonly settings: Readonly<Record<string, unknown>>
}

/** Keys a template may not set: `/new` decides them. */
const RESERVED = ['id', 'cwd', 'provider', 'model']

// Commands that only read (`ls`, `cat`, `grep`, `find`, `df`, `ps`, …) need no rule:
// the gate counts them as reads (`isReadOnlyCommand`), and every template allows reads.

export const BUILT_IN_TEMPLATES: readonly ProjectTemplate[] = [
  {
    name: 'site',
    summary: 'a website or web app: edits files, builds, uses git, without asking',
    description: 'Builds and maintains a website: pages, styles, scripts, its build and its git history.',
    instructions: [
      '- Keep the site building: after a change, run the build (and the tests, if there are any) and fix what breaks before you report.',
      '- Make small changes. If the folder is a git repository and git is installed, commit each one with a message that says what changed and why.',
      '- Before you add a dependency, check whether the project already has something that does the job.',
      '- When you finish, say which files changed and how to see the result.',
    ].join('\n'),
    settings: {
      // Its commands run unasked: the sandbox keeps them to the project's folder (no keys,
      // no database, no other project) and /undo takes a run back. The web still asks, so
      // a page it reads cannot steer the commands it then runs.
      tools: { read: 'allow', write: 'allow', shell: 'allow', web: 'ask' },
      // Code takes long runs, up to 1000 steps. Every 50 steps the loop checker (judge.model,
      // when set) reads the run, and a loop it finds is reported while the run goes on.
      limits: { max_steps_total: 1000, loop_check_steps: 50, on_loop: 'notify' },
    },
  },
  {
    name: 'research',
    summary: 'research on the web, written up as sourced notes',
    description: 'Researches questions on the web and writes the findings up as sourced notes.',
    instructions: [
      '- Search and read several independent sources; prefer primary ones (the original paper, the official documentation, the company’s own page).',
      '- Write every finding with its source (title, link, date) in a markdown file in this folder, one file per question.',
      '- Keep what the sources say apart from what you conclude, and say how sure you are.',
      '- When sources disagree, say so and say which you believe and why.',
      '- Answer with a short summary and the name of the file.',
    ].join('\n'),
    settings: {
      tools: { read: 'allow', write: 'allow', shell: 'deny', web: 'allow' },
      limits: { max_steps_total: 300 },
    },
  },
  {
    name: 'reports',
    summary: 'recurring reports, kept as dated files',
    description: 'Writes recurring reports from data and the web, each as a dated file, compared with the last one.',
    instructions: [
      '- Save each report as reports/YYYY-MM-DD-<subject>.md, with the same headings every time.',
      '- Start with three lines: what changed since the last report, what needs attention, what is fine.',
      '- Compare with the previous report in reports/ and say what moved.',
      '- Give numbers with their source and the time they were read.',
      '- Answer with the summary lines and the file name; the full report is in the file.',
    ].join('\n'),
    settings: {
      tools: { read: 'allow', write: 'allow', shell: 'ask', web: 'allow' },
      limits: { max_steps_total: 150 },
    },
  },
  {
    name: 'devops',
    summary: 'checks and runs servers and services',
    description: 'Checks and maintains servers and services: their health, logs, disks, containers and updates.',
    instructions: [
      '- Look before you act: find out the state with read-only commands first, and say what you found.',
      '- Before a command that changes anything (a restart, an install, a deletion, a config edit), say what it will do and how to undo it.',
      '- Never delete data, and never stop a service you were not asked about.',
      '- Record each change you make (what, why, how to undo) in your memory.',
      '- Answer with what you checked, what you changed, and what still needs a person.',
    ].join('\n'),
    settings: {
      // It writes only its notes in its own folder; what changes a server is a command, and asks.
      tools: { read: 'allow', write: 'allow', shell: 'ask', web: 'ask' },
      approvals: {
        auto_allow: ['top -b -n 1', 'systemctl status *', 'journalctl *', 'docker ps', 'docker logs *', 'docker stats --no-stream', 'ping -c *', 'ss', 'ip addr', 'apt list *'],
      },
      limits: { max_steps_total: 300 },
    },
  },
]

/**
 * Every template: the built-in ones and the deployment's own.
 *
 * @param dir the deployment's templates directory (`<config_dir>/templates`).
 * @returns the templates by name, and the files that could not be read.
 */
export function loadTemplates(dir: string): { templates: Map<string, ProjectTemplate>; problems: string[] } {
  const templates = new Map(BUILT_IN_TEMPLATES.map((template) => [template.name, template]))
  const problems: string[] = []
  const files = existsSync(dir) ? readdirSync(dir).filter((file) => /^[a-z0-9][a-z0-9-]*\.ya?ml$/.test(file)) : []
  for (const file of files.sort()) {
    try {
      const template = templateOf(file.replace(/\.ya?ml$/, ''), parseYaml(readFileSync(join(dir, file), 'utf8')))
      templates.set(template.name, template)
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`)
    }
  }
  return { templates, problems }
}

/**
 * A template from its file.
 *
 * @param name the file's name, without `.yaml`.
 * @param document the parsed file.
 * @returns the template.
 * @throws {Error} when the file is not a mapping or sets what `/new` decides.
 */
function templateOf(name: string, document: unknown): ProjectTemplate {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('must be a mapping')
  const { summary, description, instructions, ...settings } = document as Record<string, unknown>
  const reserved = RESERVED.filter((key) => key in settings)
  if (reserved.length > 0) throw new Error(`cannot set ${reserved.join(', ')}: /new decides them`)
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    name,
    summary: text(summary) || text(description),
    description: text(description),
    instructions: text(instructions),
    settings,
  }
}

/**
 * `argus doctor`: the templates whose settings a project could not hold.
 *
 * @param templates the loaded templates.
 * @returns one line per problem: a value that does not validate, a key no project has.
 */
export function templateIssues(templates: ReadonlyMap<string, ProjectTemplate>): string[] {
  const check = (settings: Readonly<Record<string, unknown>>, name: string) =>
    parseProjectConfig(
      { id: 'template-check', cwd: '/projects/template-check', provider: 'p', model: 'm', ...settings },
      { sourcePath: `template ${name}`, projectsRoot: '/projects' },
    )
  // Every key a project has, from one with the defaults: the schema keeps a key it does not know.
  const known = new Set(leafPaths(check({}, 'defaults')))
  return [...templates.values()].flatMap((template) => {
    try {
      check(template.settings, template.name)
    } catch (error) {
      return [(error as Error).message]
    }
    // A tool's exception and an MCP server are named freely; any other unknown key is a typo.
    const unknown = leafPaths(template.settings).filter((path) => !/^(mcp|tools\.exceptions)\./.test(path) && !known.has(path))
    return unknown.length === 0 ? [] : [`template ${template.name}: not a project setting: ${unknown.join(', ')}`]
  })
}
