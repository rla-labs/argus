// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/commands/templates` — the kinds of project `/new` can start from.
 *
 * A template is the settings a kind of work needs (its tools, its unasked commands,
 * its limits) and the instructions its agent starts with. Four are built in; a
 * `<config_dir>/templates/<name>.yaml` adds one, or replaces a built-in of the
 * same name.
 *
 * @module @argus-agent/commands/templates
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

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

/**
 * Commands every template lets run unasked. Only ones that read nothing outside
 * what the agent's own tools see: `cat` would read any file the folder rules keep
 * from it, so it asks.
 */
const LOOKING = ['ls', 'pwd', 'date']

export const BUILT_IN_TEMPLATES: readonly ProjectTemplate[] = [
  {
    name: 'site',
    summary: 'a website or web app: edits files, builds, uses git',
    description: 'Builds and maintains a website: pages, styles, scripts, its build and its git history.',
    instructions: [
      '- Keep the site building: after a change, run the build (and the tests, if there are any) and fix what breaks before you report.',
      '- Make small changes. If the folder is a git repository and git is installed, commit each one with a message that says what changed and why.',
      '- Before you add a dependency, check whether the project already has something that does the job.',
      '- When you finish, say which files changed and how to see the result.',
    ].join('\n'),
    settings: {
      tools: { read: 'allow', write: 'allow', shell: 'ask', web: 'ask' },
      // Not `npm run …` nor `git commit`: the agent writes package.json and .git/hooks,
      // so either would run code it wrote, unasked.
      approvals: { auto_allow: [...LOOKING, 'git status', 'git diff', 'git log'] },
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
      approvals: { auto_allow: [...LOOKING] },
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
      tools: { read: 'allow', write: 'ask', shell: 'ask', web: 'ask' },
      approvals: {
        auto_allow: [...LOOKING, 'uptime', 'df', 'free', 'du', 'ps', 'top -b -n 1', 'systemctl status', 'journalctl', 'docker ps', 'docker logs', 'docker stats --no-stream', 'ping -c', 'ss', 'ip addr'],
      },
      limits: { max_steps_per_run: 80 },
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
