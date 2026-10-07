// == ARGUS AGENT PROJECT ==
/**
 * The providers row: every model provider dsh can reach, keyed from the environment.
 *
 * A model is configured as `provider/model` everywhere (a project, `tasks.model`,
 * `orchestrator.model`). This row gives each provider a route:
 *
 * - every provider in pi-ai's built-in catalog that authenticates with an API key
 *   (Anthropic, OpenAI, Google, DeepSeek, Z.ai, Groq, OpenRouter, …);
 * - every provider declared in `ops.yaml` → `providers:` (an OpenAI-compatible
 *   endpoint pi-ai does not ship, such as DeepInfra or a local Ollama).
 *
 * The key is always `<PROVIDER>_API_KEY` (`apiKeyEnvOf`). The row mounts the ONE
 * pi-ai adapter instance itself (the bundle disables the base's dormant row), and
 * provides `ctx.opsProviders`, whose `check` `ops-projects` registers as a
 * configuration-time model check: a model whose provider has no route, no key, or
 * no such model makes its project invalid, and the governor refuses it.
 *
 * Providers that authenticate by sign-in (Bedrock, Vertex, Azure, Codex, Copilot)
 * are not offered: a key cannot describe them.
 *
 * @module @argus-agent/argus-agent/providers-row
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { apiKeyEnvOf, type ModelProblem, type ModelRef } from '@argus-agent/types'

/** Stable Cordis plugin name. */
export const name = 'ops-providers'

export const inject = ['opsConfigRegistry', 'opsRawConfig', 'llm']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The model providers, once the providers row is mounted. */
    opsProviders: OpsProviders
  }
}

/** Catalog providers whose authentication a key cannot describe. */
export const SIGN_IN_PROVIDERS: ReadonlySet<string> = new Set([
  'amazon-bedrock',
  'google-vertex',
  'azure-openai-responses',
  'openai-codex',
  'github-copilot',
])

/** The wire protocols a declared provider may speak. */
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** One entry of `ops.yaml` → `providers:`. */
export interface DeclaredProvider {
  /** The endpoint. Required for a provider pi-ai does not ship; an override otherwise. */
  readonly base_url?: string
  readonly api?: (typeof PROTOCOLS)[number]
  /** Model ids. Required for a provider pi-ai does not ship; added to the catalog otherwise. */
  readonly models?: readonly string[]
  /** `none` for a local server that takes no key. */
  readonly key?: 'none'
}

/** The `providers:` section. */
export const providersSchema: z = z
  .dict(
    z.object({
      base_url: z.string().description('The endpoint, e.g. https://api.deepinfra.com/v1/openai'),
      api: z.union(PROTOCOLS).description('Wire protocol; default openai-completions'),
      models: z.array(z.string()).description('Model ids this provider serves'),
      key: z.const('none').description('`none` for a local server that takes no key'),
    }),
  )
  .default({})
  .description('Model providers beyond pi-ai\'s catalog, or additions to a catalog provider')

/** One provider route, as this row knows it. */
export interface ProviderRoute {
  readonly provider: string
  /** Declared in `ops.yaml` rather than shipped by pi-ai. */
  readonly declared: boolean
  /** The variable holding its key, or `null` for a keyless local server. */
  readonly keyEnv: string | null
  /** The model ids it serves. */
  readonly models: ReadonlySet<string>
  /** Why the declaration cannot be used, when it cannot. */
  readonly error?: string
}

/** The providers service, `ctx.opsProviders`. */
export class OpsProviders {
  constructor(
    private readonly routes: ReadonlyMap<string, ProviderRoute>,
    private readonly env: (name: string) => string | undefined = (name) => process.env[name],
  ) {}

  /** The variable holding a provider's key: `<PROVIDER>_API_KEY`. */
  keyEnvOf(provider: string): string {
    return apiKeyEnvOf(provider)
  }

  /**
   * Why a model cannot run, or `undefined`.
   * @param ref the model.
   * @returns the problem.
   */
  check(ref: ModelRef): ModelProblem | undefined {
    const name = `${ref.provider}/${ref.model}`
    if (SIGN_IN_PROVIDERS.has(ref.provider)) {
      return { code: 'PROVIDER_UNSUPPORTED', message: `${ref.provider} authenticates by sign-in, which Argus does not support; use a provider with an API key` }
    }
    const route = this.routes.get(ref.provider)
    if (route === undefined) {
      return {
        code: 'PROVIDER_UNKNOWN',
        message: `no provider "${ref.provider}": it is not in the catalog; declare it in ops.yaml under providers.${ref.provider} (base_url, models)`,
      }
    }
    if (route.error !== undefined) return { code: 'PROVIDER_UNKNOWN', message: `providers.${ref.provider} in ops.yaml: ${route.error}` }
    if (route.keyEnv !== null && (this.env(route.keyEnv) ?? '').length === 0) {
      return { code: 'PROVIDER_KEY_MISSING', message: `${name} needs an API key: set ${route.keyEnv} in the environment (.env), then restart` }
    }
    if (!route.models.has(ref.model)) {
      return {
        code: 'MODEL_UNKNOWN',
        message: `${ref.provider} has no model "${ref.model}"; check the id, or add it to providers.${ref.provider}.models in ops.yaml`,
      }
    }
    return undefined
  }

  /** Every route, sorted, with whether its key is set. */
  list(): Array<{ provider: string; declared: boolean; hasKey: boolean }> {
    return [...this.routes.values()]
      .map((route) => ({
        provider: route.provider,
        declared: route.declared,
        hasKey: route.keyEnv === null || (this.env(route.keyEnv) ?? '').length > 0,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider))
  }
}

/** pi-ai's catalog: model ids by provider, sign-in providers left out. */
function catalog(): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const provider of getBuiltinProviders()) {
    if (SIGN_IN_PROVIDERS.has(provider)) continue
    result.set(provider, getBuiltinModels(provider as BuiltinProvider).map((model) => model.id))
  }
  return result
}

/**
 * The routes, and the pi-ai adapter's `providers` configuration for them.
 *
 * @param declared `ops.yaml` → `providers:`.
 * @param shipped pi-ai's catalog.
 * @returns both.
 */
export function buildRoutes(
  declared: Readonly<Record<string, DeclaredProvider>>,
  shipped: ReadonlyMap<string, readonly string[]> = catalog(),
): { routes: Map<string, ProviderRoute>; profiles: Record<string, Record<string, unknown>> } {
  const routes = new Map<string, ProviderRoute>()
  const profiles: Record<string, Record<string, unknown>> = {}

  for (const [provider, models] of shipped) {
    const extra = declared[provider]
    const keyEnv = extra?.key === 'none' ? null : apiKeyEnvOf(provider)
    const all = [...new Set([...models, ...(extra?.models ?? [])])]
    routes.set(provider, { provider, declared: false, keyEnv, models: new Set(all) })
    profiles[provider] = {
      ...(keyEnv === null ? { headers: { Authorization: 'Bearer none' } } : { apiKeyEnv: keyEnv }),
      ...(extra?.base_url === undefined ? {} : { baseURL: extra.base_url }),
      // `models` REPLACES a catalog route's list, so additions restate the catalog.
      ...(extra?.models === undefined ? {} : { models: all.map((id) => ({ id })) }),
    }
  }

  for (const [provider, entry] of Object.entries(declared)) {
    if (shipped.has(provider) || SIGN_IN_PROVIDERS.has(provider)) continue
    const keyEnv = entry.key === 'none' ? null : apiKeyEnvOf(provider)
    const models = entry.models ?? []
    const error =
      entry.base_url === undefined
        ? 'base_url is required for a provider pi-ai does not ship'
        : models.length === 0
          ? 'models is required for a provider pi-ai does not ship'
          : undefined
    routes.set(provider, { provider, declared: true, keyEnv, models: new Set(models), ...(error === undefined ? {} : { error }) })
    if (error !== undefined) continue
    profiles[provider] = {
      api: entry.api ?? 'openai-completions',
      baseURL: entry.base_url,
      models: models.map((id) => ({ id })),
      ...(keyEnv === null ? { headers: { Authorization: 'Bearer none' } } : { apiKeyEnv: keyEnv }),
    }
  }
  return { routes, profiles }
}

/**
 * Mount the providers.
 *
 * @param ctx the row's context.
 */
export function apply(ctx: Context): void {
  const section = ctx.opsConfigRegistry.extend('providers', providersSchema)
  ctx.effect(() => section)

  const logger = ctx.logger('ops-providers')
  let declared: Record<string, DeclaredProvider>
  try {
    declared = (providersSchema as unknown as (value: unknown) => Record<string, DeclaredProvider>)(ctx.opsRawConfig['providers'])
  } catch (error) {
    // A malformed section is reported by the config loader; the catalog still works.
    logger.warn('providers in ops.yaml does not validate (%s); only the catalog providers are available', (error as Error).message)
    declared = {}
  }

  const { routes, profiles } = buildRoutes(declared)
  ctx.plugin(piAi, { providers: profiles } as never)

  const service = new OpsProviders(routes)
  ctx.provide('opsProviders', service)

  const keyed = service.list().filter((entry) => entry.hasKey)
  logger.info(
    '%d provider(s) available, %d with a key: %s',
    routes.size,
    keyed.length,
    keyed.map((entry) => entry.provider).join(', ') || '(none — set <PROVIDER>_API_KEY)',
  )
  for (const route of routes.values()) {
    if (route.error !== undefined) logger.warn('providers.%s in ops.yaml: %s', route.provider, route.error)
  }
}
