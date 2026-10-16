// == ARGUS AGENT PROJECT ==
/**
 * Spike 8 — what `web_fetch` refuses.
 *
 * Question: can an agent's `web_fetch` reach the server's own services, the private
 * network or a cloud metadata endpoint? The bundle mounts dsh-base's `web` and
 * `web-fetch-http` rows, so this mounts the same two.
 */
import { describe, expect, it } from 'vitest'
import { bootSpike } from './harness.js'

type Web = { fetch(request: { url: string }): Promise<unknown> }

describe('spike 8: web_fetch and non-public addresses', () => {
  it('refuses loopback, private, link-local and metadata addresses, by IP or by name', async () => {
    const boot = await bootSpike([
      { id: 'timeout', name: '@deepseek-ai/dsh-timeout' },
      { id: 'http-proxy', name: '@deepseek-ai/dsh-http-proxy' },
      { id: 'web', name: '@deepseek-ai/dsh-web' },
      { id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http', config: { timeoutMs: 5_000 } },
    ])
    try {
      const web = (boot.ctx as unknown as { web: Web }).web
      // FACT: every resolved address must be public unicast, or the fetch fails with
      // WEB_BLOCKED_URL before a connection is made. `localhost` resolves to loopback.
      for (const url of ['http://127.0.0.1:3090/health', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'http://localhost:3091/', 'http://[fd00::1]/']) {
        await expect(web.fetch({ url }), url).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
      }
    } finally {
      await boot.dispose()
    }
  }, 30_000)
})
