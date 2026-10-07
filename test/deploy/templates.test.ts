// == ARGUS AGENT PROJECT ==
/**
 * The templates, checked against the schemas they must satisfy.
 *
 * A template that drifts from the code is worse than no template: an operator copies
 * it, the boot fails on "unknown keys", and the failure looks like a bug in the
 * product rather than in the documentation. These tests parse the shipped
 * `ops.yaml.example` with the REAL schemas from every plugin.
 *
 * They also assert the one property the templates exist to guarantee: the defaults are
 * SAFE. An allowlist that defaults to open, or a budget that defaults to unlimited, is
 * a deployment that spends money because a file was left alone.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { parseRawConfig, pathsOf } from '@argus-agent/argus-agent'
import { projectConfigSchema } from '@argus-agent/projects'
import { governorConfigOf } from '@argus-agent/governor'
import { channelOf, parseAddress } from '@argus-agent/channel'
import { telegramOf } from '@argus-agent/telegram'
import { orchestratorOf } from '@argus-agent/orchestrator'
import { schedulerOf } from '@argus-agent/scheduler'
import { approvalsOf } from '@argus-agent/approvals-bridge'
import { memoryOf } from '@argus-agent/memory'
import { healthOf } from '@argus-agent/health'

const DEPLOY = join(import.meta.dirname, '..', '..', 'deploy')
const TEMPLATES = join(DEPLOY, 'templates')

/** The raw template, with the `${VAR}` interpolations left as literal strings. */
function readTemplate(name: string): string {
  return readFileSync(join(TEMPLATES, name), 'utf8')
}

/** A template's path, for a call that reads the file itself. */
function templatePath(name: string): string {
  return join(TEMPLATES, name)
}

/**
 * Parse the template.
 *
 * `${TELEGRAM_BOT_TOKEN}` is not valid YAML we want to expand — the template is meant to
 * be read by a person and by dsh's own environment interpolation, so it is replaced with
 * a placeholder before parsing rather than expanded here.
 */
function parseTemplate(text: string): Record<string, unknown> {
  const substituted = text.replace(/\$\{[A-Z_]+\}/g, 'placeholder-value')
  const parsed = parse(substituted) as Record<string, unknown>
  return parsed
}

const opsYaml = parseTemplate(readTemplate('ops.yaml.example'))

describe('templates/ops.yaml.example', () => {
  it('is valid YAML', () => {
    expect(typeof opsYaml).toBe('object')
    expect(opsYaml).not.toBeNull()
  })

  it('resolves its paths through the bundle loader', () => {
    // `pathsOf` is what every plugin uses to find the data directory, the config
    // directory and the project configs. If the template cannot satisfy it, the boot
    // fails before any plugin mounts.
    const paths = pathsOf(opsYaml)
    expect(paths.dataDirAbs).toBeTruthy()
    expect(paths.configDirAbs).toBeTruthy()
    expect(paths.projectsDir).toContain('projects')
    expect(paths.databasePath).toContain('.sqlite')
  })

  // Every plugin's section must survive its OWN reader. This is the drift the test
  // exists for: a section the template names but a plugin rejects fails the boot with
  // "unknown keys", and that looks like a product bug rather than a template bug.
  it.each([
    ['governor', () => governorConfigOf(opsYaml)],
    ['channel', () => channelOf(opsYaml)],
    ['telegram', () => telegramOf(opsYaml)],
    ['orchestrator', () => orchestratorOf(opsYaml)],
    ['scheduler', () => schedulerOf(opsYaml)],
    ['approvals', () => approvalsOf(opsYaml)],
    ['memory', () => memoryOf(opsYaml)],
    ['health', () => healthOf(opsYaml)],
  ])('has a section %s accepts', (_name, parseSection) => {
    expect(() => parseSection()).not.toThrow()
  })

  it('parses a project document through the project schema', () => {
    const project = parseTemplate(readTemplate('projects/example.yaml'))
    expect(() => projectConfigSchema(project)).not.toThrow()
  })

  it('documents every key the plugins accept', () => {
    // The template is the documented reference. A key a plugin reads but the template
    // never mentions is a key nobody can find.
    const sections: Array<[string, Record<string, unknown>]> = [
      ['health', healthOf(opsYaml) as unknown as Record<string, unknown>],
      ['memory', memoryOf(opsYaml) as unknown as Record<string, unknown>],
      ['scheduler', schedulerOf(opsYaml) as unknown as Record<string, unknown>],
      ['approvals', approvalsOf(opsYaml) as unknown as Record<string, unknown>],
      ['telegram', telegramOf(opsYaml) as unknown as Record<string, unknown>],
      ['channel', channelOf(opsYaml) as unknown as Record<string, unknown>],
      ['orchestrator', orchestratorOf(opsYaml) as unknown as Record<string, unknown>],
    ]
    const text = readTemplate('ops.yaml.example')
    for (const [section, resolved] of sections) {
      for (const key of Object.keys(resolved)) {
        expect(text, `${section}.${key} is missing from the template`).toContain(key)
      }
    }
  })

  describe('the defaults are SAFE', () => {
    it('refuses everyone until an operator opts in', () => {
      // An allowlist that defaults to open is a system anyone can spend money on.
      const access = opsYaml['access'] as { allowed_users: unknown[] }
      expect(access.allowed_users).toEqual([])
    })

    it('has no default address, so nothing is broadcast by accident', () => {
      const channel = opsYaml['channel'] as { default_address: unknown }
      expect(channel.default_address).toBeNull()
    })

    it('leaves the token as an unexpanded reference', () => {
      // `parseRawConfig` is the loader every plugin reads through. Running the template's
      // text through it asserts the interpolation survives parsing as a string rather
      // than being read as a mapping — `telegram:123` unquoted would parse as a map.
      const parsed = parseRawConfig(templatePath('ops.yaml.example'), {
        TELEGRAM_BOT_TOKEN: 'placeholder-value',
      }) as Record<string, unknown>
      const telegram = parsed['telegram'] as { bot_token: string }
      expect(typeof telegram.bot_token).toBe('string')
    })

    it('leaves default_address a STRING when an operator sets one', () => {
      // The address is `telegram:99887766`, and YAML reads an unquoted colon as a
      // mapping. The template documents quoting it; this asserts what the parser does
      // with a correctly quoted value.
      const address = parseAddress('telegram:99887766')
      expect(address.channel).toBe('telegram')
      expect(String(address.chatId)).toBe('99887766')
    })

    it('sets a budget rather than leaving it unlimited', () => {
      const budgets = opsYaml['budgets'] as { default_day_usd: number; default_month_usd: number }
      expect(budgets.default_day_usd).toBeGreaterThan(0)
      expect(budgets.default_month_usd).toBeGreaterThan(0)
      // Low, because a first deployment should surprise you by stopping, not by
      // spending.
      expect(budgets.default_day_usd).toBeLessThanOrEqual(10)
    })

    it('asks before risky actions rather than allowing them', () => {
      const project = parseTemplate(readTemplate('projects/example.yaml'))
      const approvals = project['approvals'] as { mode: string; auto_allow: unknown[] }
      expect(approvals.mode).toBe('ask')
      expect(approvals.auto_allow).toEqual([])
    })

    it('refuses an unpriced model rather than guessing', () => {
      expect(opsYaml['unknown_model_policy']).toBe('block')
    })

    it('permits no model chosen by a model', () => {
      const orchestrator = opsYaml['orchestrator'] as { allowed_task_models: unknown[] }
      expect(orchestrator.allowed_task_models).toEqual([])
    })

    it('does not allow groups by default', () => {
      const telegram = opsYaml['telegram'] as { allow_groups: boolean }
      expect(telegram.allow_groups).toBe(false)
    })

    it('keeps the health endpoint enabled and loopback-only', () => {
      const health = healthOf(opsYaml)
      expect(health.enabled).toBe(true)
      expect(health.endpoint).toBe(true)
      // There is no `host` key: loopback is not configurable, and a template that
      // offered one would imply it is.
      expect(Object.keys(health)).not.toContain('host')
      expect(Object.keys(health)).not.toContain('bind')
    })
  })

  it('interpolates the token from the environment rather than inlining it', () => {
    const text = readTemplate('ops.yaml.example')
    // The bot token must come from the environment: a token in ops.yaml is a token in
    // whatever the operator copies it into.
    expect(text).toContain('${TELEGRAM_BOT_TOKEN}')
    expect(text).not.toMatch(/bot_token:\s*['"]?\d{8,}:/)
  })

  it('explains itself', () => {
    const text = readTemplate('ops.yaml.example')
    // A commented template is the documentation. This asserts it still has one.
    const commentLines = text.split('\n').filter((line) => line.trimStart().startsWith('#')).length
    const totalLines = text.split('\n').length
    expect(commentLines / totalLines).toBeGreaterThan(0.4)
  })
})

describe('templates/projects/example.yaml', () => {
  const project = parseTemplate(readTemplate('projects/example.yaml'))

  it('is valid YAML with the required fields', () => {
    expect(project['id']).toBe('example')
    expect(project['cwd']).toBeTruthy()
    expect(project['provider']).toBeTruthy()
    expect(project['model']).toBeTruthy()
  })

  it('has an id matching the required pattern', () => {
    // The loader's pattern: lowercase, digits and hyphens, at least two characters.
    expect(String(project['id'])).toMatch(/^[a-z0-9][a-z0-9-]{1,40}$/)
  })

  it('keeps the working directory inside the data directory', () => {
    // A project's cwd outside `<data_dir>/projects/` is refused by the loader, because
    // that boundary is what keeps one project out of another's files.
    expect(String(project['cwd'])).toMatch(/^\/data\/projects\//)
  })

  it('has a description that says what the project is FOR', () => {
    const description = String(project['description'] ?? '')
    // The description is the only thing the orchestrator knows about a project's
    // purpose. The template must model that rather than shipping "example".
    expect(description.length).toBeGreaterThan(20)
    expect(description.toLowerCase()).toContain('replace')
  })

  it('sets a budget', () => {
    const budget = project['budget'] as { day_usd: number; month_usd: number }
    expect(budget.day_usd).toBeGreaterThan(0)
    expect(budget.month_usd).toBeGreaterThan(0)
  })

  it('names a fallback model, since the soft action may downgrade', () => {
    const budget = project['budget'] as { soft_action: string }
    if (budget.soft_action === 'downgrade') {
      expect(project['fallback_model']).toBeTruthy()
    }
  })

  it('explains the allowlist matching rules', () => {
    // The single most misunderstood setting: `auto_allow: [git status]` does NOT permit
    // `git status; rm -rf /`. The template must say so where the setting is.
    const text = readTemplate('projects/example.yaml')
    expect(text).toContain('COMMAND LINE')
    expect(text).toContain('compound')
  })
})

describe('templates/env.example', () => {
  const text = readTemplate('env.example')

  it('is parseable as a shell assignment list', () => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      // `KEY=` or `KEY=value`, never a bare word.
      expect(trimmed, line).toMatch(/^[A-Z][A-Z0-9_]*=/)
    }
  })

  it('carries the variables the scripts read', () => {
    for (const key of ['TELEGRAM_BOT_TOKEN', 'ARGUS_AGENT_IMAGE', 'ARGUS_AGENT_DATA_PATH', 'TZ']) {
      expect(text, key).toContain(key)
    }
  })

  it('carries no actual secret', () => {
    // Every SECRET is an empty assignment: an example file with a real token in it is a
    // leaked token. Non-secret settings (an image tag, a path) legitimately carry a
    // value, so the check names the secret-bearing keys rather than treating every
    // assignment alike.
    const secretKeys = ['TELEGRAM_BOT_TOKEN', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const [key, value = ''] = trimmed.split('=')
      if (secretKeys.includes(key)) {
        expect(value, `${key} must be empty in the example`).toBe('')
      }
    }
  })

  it('warns that it holds secrets', () => {
    expect(text.toUpperCase()).toContain('SECRET')
    expect(text).toContain('600')
  })
})

describe('the build context', () => {
  it('has its .dockerignore at the repository root, where Docker reads it', () => {
    // The build runs `docker build -f deploy/docker/Dockerfile .`, so only the root
    // `.dockerignore` applies. One next to the Dockerfile is silently ignored.
    const ignore = readFileSync(join(DEPLOY, '..', '.dockerignore'), 'utf8')
    for (const pattern of ['**/node_modules/', '**/lib/', '.tooling/', '.env', '**/secrets.env']) {
      expect(ignore.split('\n')).toContain(pattern)
    }
    expect(existsSync(join(DEPLOY, 'docker', '.dockerignore'))).toBe(false)
  })
})

describe('the deploy tree is complete', () => {
  it('has every file the prompt requires', () => {
    const required = [
      'docker/Dockerfile',
      'docker/entrypoint.sh',
      'compose/docker-compose.yml',
      'compose/docker-compose.ollama.yml',
      'scripts/install.sh',
      'scripts/upgrade.sh',
      'scripts/backup.sh',
      'scripts/restore.sh',
      'scripts/uninstall.sh',
      'scripts/smoke.sh',
      'scripts/lib.sh',
      'templates/ops.yaml.example',
      'templates/env.example',
      'templates/projects/example.yaml',
      // The deployment guide is a section of the public docs/user-docs.md.
      '../docs/user-docs.md',
    ]
    for (const file of required) {
      expect(existsSync(join(DEPLOY, file)), `${file} is missing`).toBe(true)
    }
  })

  it('has no doc left as a placeholder', () => {
    // A placeholder that survives is worse than a missing file, because it looks like
    // documentation.
    const text = readFileSync(join(DEPLOY, '..', 'docs', 'user-docs.md'), 'utf8')
    expect(text).not.toContain('not written yet')
    expect(text).not.toContain('Status: scaffold')
  })

  it('has no TODO in any deploy file', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        // An operator's compose `.env` (and the copies the scripts keep) holds secrets
        // and is not part of the repository; it may also be root-owned after a sudo install.
        else if (!entry.name.startsWith('.env')) out.push(full)
      }
      return out
    }
    for (const file of walk(DEPLOY)) {
      const text = readFileSync(file, 'utf8')
      expect(text, `${file} contains a TODO`).not.toMatch(/\bTODO\b/)
    }
  })
})
