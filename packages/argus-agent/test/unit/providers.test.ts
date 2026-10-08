// == ARGUS AGENT PROJECT ==
/** Unit tests for the provider routes and the configuration-time model check. */
import { describe, expect, it } from 'vitest'
import { OpsProviders, buildRoutes, probeRequest } from '../../src/providers-row.js'

const shipped = new Map([
  ['zai', ['glm-5.3-flash']],
  ['openrouter', ['deepseek/deepseek-v4-flash']],
])

function providers(declared: Parameters<typeof buildRoutes>[0], env: Record<string, string> = {}) {
  const { routes, profiles } = buildRoutes(declared, shipped)
  return { service: new OpsProviders(routes, (name) => env[name]), profiles }
}

describe('provider routes', () => {
  it('keys every catalog provider by <PROVIDER>_API_KEY', () => {
    const { profiles } = providers({})
    expect(profiles['zai']).toEqual({ apiKeyEnv: 'ZAI_API_KEY' })
    expect(profiles['openrouter']).toEqual({ apiKeyEnv: 'OPENROUTER_API_KEY' })
  })

  it('declares an OpenAI-compatible provider pi-ai does not ship', () => {
    const { profiles, service } = providers(
      { deepinfra: { base_url: 'https://api.deepinfra.com/v1/openai', models: ['deepseek-ai/DeepSeek-V4-Flash'] } },
      { DEEPINFRA_API_KEY: 'k' },
    )
    expect(profiles['deepinfra']).toEqual({
      api: 'openai-completions',
      baseURL: 'https://api.deepinfra.com/v1/openai',
      models: [{ id: 'deepseek-ai/DeepSeek-V4-Flash' }],
      apiKeyEnv: 'DEEPINFRA_API_KEY',
    })
    expect(service.check({ provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4-Flash' })).toBeUndefined()
  })

  it('adds declared models to a catalog provider without dropping its catalog', () => {
    const { profiles, service } = providers({ openrouter: { models: ['new/model'] } }, { OPENROUTER_API_KEY: 'k' })
    expect(profiles['openrouter']?.['models']).toEqual([{ id: 'deepseek/deepseek-v4-flash' }, { id: 'new/model' }])
    expect(service.check({ provider: 'openrouter', model: 'new/model' })).toBeUndefined()
    expect(service.check({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' })).toBeUndefined()
  })

  it('takes no key for a local server', () => {
    const { profiles, service } = providers({ ollama: { base_url: 'http://ollama:11434/v1', models: ['qwen3'], key: 'none' } })
    expect(profiles['ollama']).toMatchObject({ headers: { Authorization: 'Bearer none' } })
    expect(service.check({ provider: 'ollama', model: 'qwen3' })).toBeUndefined()
  })
})

describe('OpsProviders.check', () => {
  it('names the variable to set when the key is missing', () => {
    expect(providers({}).service.check({ provider: 'zai', model: 'glm-5.3-flash' })).toEqual({
      code: 'PROVIDER_KEY_MISSING',
      message: 'zai/glm-5.3-flash needs an API key: set ZAI_API_KEY in the environment (.env), then restart',
    })
  })

  it('refuses an unknown provider, a sign-in provider, an unknown model and a broken declaration', () => {
    const { service } = providers({ broken: { models: ['x'] } }, { ZAI_API_KEY: 'k', BROKEN_API_KEY: 'k' })
    expect(service.check({ provider: 'nope', model: 'x' })?.code).toBe('PROVIDER_UNKNOWN')
    expect(service.check({ provider: 'amazon-bedrock', model: 'x' })?.code).toBe('PROVIDER_UNSUPPORTED')
    expect(service.check({ provider: 'zai', model: 'glm-9' })?.code).toBe('MODEL_UNKNOWN')
    expect(service.check({ provider: 'broken', model: 'x' })).toMatchObject({
      code: 'PROVIDER_UNKNOWN',
      message: expect.stringContaining('base_url is required'),
    })
    expect(service.check({ provider: 'zai', model: 'glm-5.3-flash' })).toBeUndefined()
  })

  it('lists the routes with whether each has a key', () => {
    expect(providers({}, { ZAI_API_KEY: 'k' }).service.list()).toEqual([
      { provider: 'openrouter', declared: false, hasKey: false },
      { provider: 'zai', declared: false, hasKey: true },
    ])
  })
})

describe('argus doctor: the provider keys', () => {
  const declared = { deepinfra: { base_url: 'https://api.deepinfra.com/v1/openai/', models: ['m'] } }

  function doctor(env: Record<string, string>, answer: (url: string) => Response | Promise<Response>) {
    const urls: string[] = []
    const { routes } = buildRoutes(declared, shipped)
    const fetch = (async (url: string) => {
      urls.push(url)
      return answer(url)
    }) as unknown as typeof globalThis.fetch
    return { urls, run: () => new OpsProviders(routes, (name) => env[name], fetch).doctor() }
  }

  it('fails, with the fix, when no provider has a key', async () => {
    const [finding] = await doctor({}, () => new Response('{}')).run()
    expect(finding).toMatchObject({ ok: false, fix: expect.stringContaining('_API_KEY') })
  })

  it('asks each provider with a key, for free, and reports what it said', async () => {
    const { urls, run } = doctor({ OPENROUTER_API_KEY: 'k', DEEPINFRA_API_KEY: 'bad' }, (url) =>
      new Response('{}', { status: url.includes('deepinfra') ? 401 : 200 }),
    )
    const findings = await run()
    expect(urls.sort()).toEqual(['https://api.deepinfra.com/v1/openai/models', 'https://openrouter.ai/api/v1/key'])
    expect(findings).toContainEqual({ ok: true, check: 'openrouter: the API key', detail: 'accepted' })
    expect(findings).toContainEqual(
      expect.objectContaining({ ok: false, check: 'deepinfra: the API key', detail: 'refused (HTTP 401)', fix: expect.stringContaining('DEEPINFRA_API_KEY') }),
    )
  })

  it('reports no credit, and an unreachable endpoint', async () => {
    const credit = await doctor({ OPENROUTER_API_KEY: 'k' }, () => new Response('{}', { status: 402 })).run()
    expect(credit[0]).toMatchObject({ ok: false, detail: expect.stringContaining('no credit') })
    const down = await doctor({ DEEPINFRA_API_KEY: 'k' }, () => Promise.reject(new Error('ECONNREFUSED'))).run()
    expect(down[0]).toMatchObject({ ok: false, detail: expect.stringContaining('ECONNREFUSED'), fix: expect.stringContaining('providers.deepinfra.base_url') })
  })

  it('builds a free request for each protocol', () => {
    expect(probeRequest('deepseek', 'https://api.deepseek.com', 'openai-completions', 'k')).toEqual({
      url: 'https://api.deepseek.com/user/balance',
      headers: { authorization: 'Bearer k' },
    })
    expect(probeRequest('anthropic', 'https://api.anthropic.com', 'anthropic-messages', 'k')?.headers).toMatchObject({ 'x-api-key': 'k' })
    expect(probeRequest('google', 'https://g/v1beta', 'google-generative-ai', 'k')).toEqual({ url: 'https://g/v1beta/models', headers: { 'x-goog-api-key': 'k' } })
    expect(probeRequest('local', 'http://ollama:11434/v1', 'openai-completions', undefined)).toEqual({ url: 'http://ollama:11434/v1/models', headers: {} })
    expect(probeRequest('x', 'https://x', 'bedrock-converse', 'k')).toBeUndefined()
  })
})
