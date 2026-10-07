// == ARGUS AGENT PROJECT ==
/** Unit tests for the provider routes and the configuration-time model check. */
import { describe, expect, it } from 'vitest'
import { OpsProviders, buildRoutes } from '../../src/providers-row.js'

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
