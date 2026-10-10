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
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { apiKeyEnvOf, keyTail, type DoctorFinding, type ModelProblem, type ModelRef } from '@argus-agent/types'

/** Stable Cordis plugin name. */
export const name = 'ops-providers'

export const inject = ['opsConfigRegistry', 'opsRawConfig', 'llm', 'credentials']

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
  /** The endpoint from `ops.yaml`, when it sets one; a catalog route uses pi-ai's otherwise. */
  readonly baseUrl?: string
  /** The wire protocol from `ops.yaml`, for a declared provider. */
  readonly api?: string
}

/** How long `argus doctor` waits for a provider. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * A request that proves a key is accepted without spending anything: a model list,
 * or the account itself where the model list is public (OpenRouter) or the account
 * says more (DeepSeek's balance). `undefined` for a protocol with no such request.
 */
export function probeRequest(
  provider: string,
  baseUrl: string,
  api: string,
  key: string | undefined,
): { url: string; headers: Record<string, string> } | undefined {
  const base = baseUrl.replace(/\/+$/, '')
  const bearer: Record<string, string> = key === undefined ? {} : { authorization: `Bearer ${key}` }
  if (provider === 'openrouter') return { url: 'https://openrouter.ai/api/v1/key', headers: bearer }
  if (provider === 'deepseek') return { url: `${base}/user/balance`, headers: bearer }
  if (api === 'anthropic-messages') {
    return { url: `${base}/v1/models`, headers: { 'anthropic-version': '2023-06-01', ...(key === undefined ? {} : { 'x-api-key': key }) } }
  }
  if (api === 'google-generative-ai') return { url: `${base}/models`, headers: key === undefined ? {} : { 'x-goog-api-key': key } }
  if (api === 'openai-completions' || api === 'openai-responses') return { url: `${base}/models`, headers: bearer }
  return undefined
}

/** Where a key came from, and whether it can be changed from here. */
export interface KeyInfo {
  readonly configured: boolean
  /** The credentials store's layer name: the launch environment, the stored file, a `.env`. */
  readonly source?: string
  readonly writable: boolean
}

/**
 * The keys, as the providers see them.
 *
 * `has` and `info` are synchronous because a project's model is checked while
 * projects load; they read a snapshot the row keeps current. `value`, `set` and
 * `unset` go to dsh's credentials store, where pi-ai resolves a key on every request,
 * so a saved key is used by the next request without a restart.
 */
export interface KeyStore {
  has(name: string): boolean
  info(name: string): KeyInfo
  value(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  unset(name: string): Promise<void>
}

/**
 * A read-only key store over an environment, for a composition without dsh's
 * credentials store (and for tests).
 *
 * @param env reads a variable.
 * @returns the store.
 */
export function envKeys(env: (name: string) => string | undefined = (name) => process.env[name]): KeyStore {
  const has = (name: string): boolean => (env(name) ?? '').length > 0
  return {
    has,
    info: (name) => (has(name) ? { configured: true, source: 'environment', writable: false } : { configured: false, writable: false }),
    value: async (name) => env(name),
    set: async () => {
      throw new Error('keys cannot be saved here: there is no credentials store')
    },
    unset: async () => {
      throw new Error('keys cannot be removed here: there is no credentials store')
    },
  }
}

/** A key's status, for `/key` and `argus key list`. */
export interface KeyStatus {
  readonly provider: string
  /** The variable the key is stored under. */
  readonly name: string
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/** The outcome of saving or removing a key, as one sentence for a person. */
export interface KeyChange {
  readonly ok: boolean
  readonly message: string
}

/** The providers service, `ctx.opsProviders`. */
export class OpsProviders {
  constructor(
    private readonly routes: ReadonlyMap<string, ProviderRoute>,
    private readonly keys: KeyStore = envKeys(),
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /**
   * `argus doctor`: does each provider with a key accept it. One free request per
   * provider (`probeRequest`); a keyless declared provider is checked for reachability.
   *
   * @returns one finding per provider, or one failure when no provider has a key.
   */
  async doctor(): Promise<DoctorFinding[]> {
    const usable = [...this.routes.values()].filter(
      (route) => route.error === undefined && (route.keyEnv === null ? route.declared : this.keys.has(route.keyEnv)),
    )
    if (usable.length === 0) {
      return [{ ok: false, check: 'the model providers', detail: 'no provider has an API key', fix: 'send /key <provider> <key> in the chat, or set <PROVIDER>_API_KEY in .env (secrets.env on a native install) and restart' }]
    }
    return Promise.all(usable.map(async (route) => this.probe(route, route.keyEnv === null ? undefined : await this.keys.value(route.keyEnv))))
  }

  private async probe(route: ProviderRoute, key: string | undefined): Promise<DoctorFinding> {
    const check = route.keyEnv === null ? `${route.provider}: the endpoint` : `${route.provider}: the API key`
    const shipped = route.declared ? undefined : getBuiltinModels(route.provider as BuiltinProvider)[0]
    const baseUrl = route.baseUrl ?? shipped?.baseUrl
    const api = route.api ?? shipped?.api
    const request = baseUrl === undefined || api === undefined ? undefined : probeRequest(route.provider, baseUrl, api, key)
    if (request === undefined) return { ok: true, check, detail: 'set; not verified (this provider has no free check)' }
    const fixKey = `send the whole key again with /key ${route.provider} <key>`
    try {
      const response = await this.fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      // Google answers a bad key with 400 (API_KEY_INVALID) rather than 401.
      if (response.status === 401 || response.status === 403 || (response.status === 400 && api === 'google-generative-ai')) return { ok: false, check, detail: `refused (HTTP ${response.status})`, fix: fixKey }
      if (response.status === 402) return { ok: false, check, detail: 'the account has no credit (HTTP 402)', fix: `add credit to your ${route.provider} account` }
      if (!response.ok) return { ok: false, check, detail: `HTTP ${response.status} from ${request.url}` }
      if (route.provider === 'deepseek') {
        const body = (await response.json().catch(() => ({}))) as { is_available?: boolean }
        if (body.is_available === false) return { ok: false, check, detail: 'accepted, but the balance is empty', fix: 'top up at platform.deepseek.com' }
      }
      return { ok: true, check, detail: 'accepted' }
    } catch (error) {
      return {
        ok: false,
        check,
        detail: `could not reach ${request.url}: ${error instanceof Error ? error.message : String(error)}`,
        fix: route.declared ? `check providers.${route.provider}.base_url in ops.yaml, and that this host can reach it` : 'check that this host can reach the internet',
      }
    }
  }

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
    if (route.keyEnv !== null && !this.keys.has(route.keyEnv)) {
      return { code: 'PROVIDER_KEY_MISSING', message: `${name} needs an API key: send /key ${ref.provider} <key>` }
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
        hasKey: route.keyEnv === null || this.keys.has(route.keyEnv),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider))
  }

  /**
   * Every provider that takes a key, with whether it has one and where it is from.
   *
   * @returns the keyed providers first, then the rest, each sorted.
   */
  keyStatus(): KeyStatus[] {
    return [...this.routes.values()]
      .filter((route) => route.keyEnv !== null && route.error === undefined)
      .map((route) => ({ provider: route.provider, name: route.keyEnv as string, ...this.keys.info(route.keyEnv as string) }))
      .sort((a, b) => Number(b.configured) - Number(a.configured) || a.provider.localeCompare(b.provider))
  }

  /**
   * Save a provider's key, after the provider accepts it.
   *
   * The key is tried with the same free request `argus doctor` makes; a key the
   * provider refuses is not saved. A provider with no such request is saved
   * unverified, and the answer says so. The key itself never appears in an answer,
   * a log or an error: only its last four characters.
   *
   * @param provider the provider, as in `provider/model`.
   * @param key the key.
   * @returns what happened.
   */
  async setKey(provider: string, key: string): Promise<KeyChange> {
    const value = key.trim()
    const route = this.routes.get(provider)
    const refusal = this.keyRefusal(provider, route)
    if (refusal !== undefined) return { ok: false, message: refusal }
    const name = (route as ProviderRoute).keyEnv as string
    if (value.length === 0 || /\s/.test(value)) return { ok: false, message: 'A key is one word with no spaces.' }
    const fixed = this.envRefusal(name)
    if (fixed !== undefined) return { ok: false, message: fixed }

    const finding = await this.probe(route as ProviderRoute, value)
    if (!finding.ok) return { ok: false, message: `${provider} did not accept the key ${keyTail(value)}: ${finding.detail}. Nothing was saved.` }
    try {
      await this.keys.set(name, value)
    } catch (error) {
      return { ok: false, message: `The key could not be saved: ${errorText(error)}` }
    }
    const verified = finding.detail === 'accepted' ? 'accepted by the provider' : 'saved without a check (this provider has none)'
    return { ok: true, message: `${provider}: key ${keyTail(value)} ${verified}. The next request uses it.` }
  }

  /**
   * Remove a provider's stored key.
   *
   * @param provider the provider.
   * @returns what happened.
   */
  async removeKey(provider: string): Promise<KeyChange> {
    const route = this.routes.get(provider)
    const refusal = this.keyRefusal(provider, route)
    if (refusal !== undefined) return { ok: false, message: refusal }
    const name = (route as ProviderRoute).keyEnv as string
    if (!this.keys.has(name)) return { ok: false, message: `${provider} has no key.` }
    const fixed = this.envRefusal(name)
    if (fixed !== undefined) return { ok: false, message: fixed }
    try {
      await this.keys.unset(name)
    } catch (error) {
      return { ok: false, message: `The key could not be removed: ${errorText(error)}` }
    }
    return { ok: true, message: `${provider}: key removed.${this.keys.has(name) ? ` A key from ${this.keys.info(name).source ?? 'another place'} still applies.` : ''}` }
  }

  /** Why a provider's key cannot be managed at all, or `undefined`. */
  private keyRefusal(provider: string, route: ProviderRoute | undefined): string | undefined {
    if (SIGN_IN_PROVIDERS.has(provider)) return `${provider} authenticates by sign-in, which Argus does not support.`
    if (route === undefined) return `No provider "${provider}". Send /key to see them.`
    if (route.error !== undefined) return `providers.${provider} in ops.yaml: ${route.error}`
    if (route.keyEnv === null) return `${provider} takes no key (key: none in ops.yaml).`
    return undefined
  }

  /** A refusal for a key the launch environment supplies, which wins over a saved one. */
  private envRefusal(name: string): string | undefined {
    const info = this.keys.info(name)
    if (!info.configured || info.writable) return undefined
    return `${name} is set in the server's environment (.env, or secrets.env on a native install), which wins over a key saved here. Delete that line on the server and restart once; after that the key is managed from here.`
  }
}

/** An error's message, never its stack. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    routes.set(provider, { provider, declared: false, keyEnv, models: new Set(all), ...(extra?.base_url === undefined ? {} : { baseUrl: extra.base_url }) })
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
    routes.set(provider, {
      provider,
      declared: true,
      keyEnv,
      models: new Set(models),
      ...(error === undefined ? {} : { error }),
      ...(entry.base_url === undefined ? {} : { baseUrl: entry.base_url, api: entry.api ?? 'openai-completions' }),
    })
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
export async function apply(ctx: Context): Promise<void> {
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

  // The snapshot is taken BEFORE the service is published, so the first project
  // load already sees a key saved in the store, not only one in the environment.
  const names = [...new Set([...routes.values()].flatMap((route) => (route.keyEnv === null ? [] : [route.keyEnv])))]
  const keys = await credentialKeys(ctx, names)
  const service = new OpsProviders(routes, keys)
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

/**
 * A key store over dsh's credentials service, with the synchronous snapshot the
 * model check needs. The snapshot follows `credentials/reference-updated`, which
 * fires for a save, a removal and an edit of the file on disk.
 *
 * @param ctx the row's context.
 * @param names every variable a route reads its key from.
 * @returns the store.
 */
async function credentialKeys(ctx: Context, names: readonly string[]): Promise<KeyStore> {
  const credentials = ctx.credentials
  const snapshot = new Map<string, KeyInfo>()
  const refresh = async (name: string): Promise<void> => {
    try {
      const info = await credentials.describe(credentialRef(name))
      snapshot.set(name, { configured: info.configured, writable: info.writable, ...(info.source === undefined ? {} : { source: info.source }) })
    } catch {
      // A name the store cannot address is simply not configured.
      snapshot.set(name, { configured: false, writable: false })
    }
  }
  await Promise.all(names.map(refresh))
  ctx.on('credentials/reference-updated', (ref) => {
    const name = String(ref)
    if (snapshot.has(name)) void refresh(name)
  })
  return {
    has: (name) => snapshot.get(name)?.configured === true,
    info: (name) => snapshot.get(name) ?? { configured: false, writable: false },
    value: async (name) => (await credentials.resolve(credentialRef(name)))?.value,
    set: async (name, value) => {
      await credentials.set(credentialRef(name), value)
      await refresh(name)
    },
    unset: async (name) => {
      await credentials.unset(credentialRef(name))
      await refresh(name)
    },
  }
}
