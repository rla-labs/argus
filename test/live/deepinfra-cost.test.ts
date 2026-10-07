// == ARGUS AGENT PROJECT ==
/**
 * Metering against a REAL billed provider declared in `ops.yaml` → `providers:`
 * (DeepInfra). Every model request goes through a local pass-through proxy that
 * records what DeepInfra itself reported: the token usage and `usage.estimated_cost`
 * in USD. The test then checks that what Argus accounted in `usage_events` matches
 * DeepInfra's own numbers, request by request.
 *
 * Prices are DeepInfra's live list (`/models/list`), written into `pricing:` exactly
 * as an operator would.
 *
 * Opt-in: `pnpm test:live` with `ARGUS_LIVE=1` and `DEEPINFRA_API_KEY`. A run costs
 * well under $0.01. `ARGUS_LIVE_DEEPINFRA_MODELS` overrides the comma-separated models.
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootOps,
  BASE_ENTRIES,
  ConsoleChannelAdapter,
  OPTIONAL_ENTRIES,
  persistenceEntry,
  waitFor,
  type OpsBoot,
} from '@argus-agent/testkit'
import type { OpsStore } from '@argus-agent/store'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsChannel } from '@argus-agent/channel'

const env = process.env
const KEY = env['DEEPINFRA_API_KEY']
const LIVE = env['ARGUS_LIVE'] === '1' && KEY !== undefined && KEY.length > 0
const UPSTREAM = 'https://api.deepinfra.com/v1/openai'
const ADMIN = 'admin'
const MODELS = (env['ARGUS_LIVE_DEEPINFRA_MODELS'] ?? 'deepseek-ai/DeepSeek-V4-Flash,zai-org/GLM-5.3-Flash')
  .split(',')
  .map((model) => model.trim())

/** What DeepInfra reported for one request. */
interface Billed {
  readonly model: string
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly estimatedCostUsd: number
}

const billed: Billed[] = []
let proxy: Server
let boot: OpsBoot
let store: OpsStore
let meter: OpsMeter
let channel: OpsChannel
let dataDir: string
let seq = 0

interface DeepInfraUsage {
  prompt_tokens: number
  completion_tokens: number
  estimated_cost?: number
  prompt_tokens_details?: { cached_tokens?: number | null }
}

function record(model: string, usage: DeepInfraUsage | undefined): void {
  if (usage === undefined) return
  billed.push({
    model,
    promptTokens: usage.prompt_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: usage.completion_tokens,
    estimatedCostUsd: usage.estimated_cost ?? NaN,
  })
}

/** Forwards to DeepInfra and records the usage of every response, streamed or not. */
function startProxy(): Promise<number> {
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const model = body.length > 0 ? ((JSON.parse(body.toString()) as { model?: string }).model ?? '') : ''
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string' && !['host', 'content-length', 'connection', 'accept-encoding'].includes(name)) headers.set(name, value)
      }
      void (async () => {
        const upstream = await fetch(UPSTREAM + (req.url ?? ''), {
          method: req.method ?? 'GET',
          headers,
          ...(body.length > 0 ? { body } : {}),
        })
        const text = await upstream.text()
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
        res.end(text)
        if (!upstream.ok) return
        if ((upstream.headers.get('content-type') ?? '').includes('event-stream')) {
          let usage: DeepInfraUsage | undefined
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
            usage = (JSON.parse(line.slice(6)) as { usage?: DeepInfraUsage | null }).usage ?? usage
          }
          record(model, usage)
        } else {
          record(model, (JSON.parse(text) as { usage?: DeepInfraUsage }).usage)
        }
      })().catch((error: unknown) => {
        res.writeHead(502)
        res.end(String(error))
      })
    })
  })
  return new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as { port: number }).port)))
}

/** DeepInfra's live prices, as `pricing:` entries in USD per million tokens. */
async function livePrices(): Promise<Record<string, { input: number; cached: number; output: number }>> {
  const response = await fetch('https://api.deepinfra.com/models/list', { headers: { authorization: `Bearer ${KEY}` } })
  const list = (await response.json()) as Array<{
    model_name: string
    pricing?: {
      cents_per_input_token?: number
      cents_per_output_token?: number
      rate_per_input_token_cached?: number | null
      discount?: number | null
    }
  }>
  const result: Record<string, { input: number; cached: number; output: number }> = {}
  for (const model of MODELS) {
    const pricing = list.find((entry) => entry.model_name === model)?.pricing
    if (pricing?.cents_per_input_token === undefined || pricing.cents_per_output_token === undefined) {
      throw new Error(`DeepInfra lists no token price for ${model}`)
    }
    // cents per token → USD per million tokens. DeepInfra bills `list × (1 − discount)`
    // (verified: GLM-5.3-Flash at discount 0.5 billed 0.5×, GLM-5.2 at 0.25 billed 0.75×).
    const factor = 1 - (pricing.discount ?? 0)
    const input = pricing.cents_per_input_token * 10_000 * factor
    result[`deepinfra/${model}`] = {
      input,
      cached: input * (pricing.rate_per_input_token_cached ?? 1),
      output: pricing.cents_per_output_token * 10_000 * factor,
    }
  }
  return result
}

async function say(text: string): Promise<void> {
  seq += 1
  await channel.handleIncoming({
    id: `live-di:${seq}`,
    address: { channel: 'console', chatId: ADMIN },
    userId: ADMIN,
    text,
    timestamp: Date.now(),
  })
}

function rows<T>(sql: string, ...params: unknown[]): T[] {
  return store.db.prepare(sql).all(...params) as T[]
}

describe.skipIf(!LIVE)('live: DeepInfra cost accounting matches DeepInfra’s own bill', () => {
  let console_: ConsoleChannelAdapter

  beforeAll(async () => {
    const port = await startProxy()
    const prices = await livePrices()
    dataDir = mkdtempSync(join(tmpdir(), 'argus-live-di-'))
    mkdirSync(join(dataDir, 'projects'), { recursive: true })
    mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
    const first = `deepinfra/${MODELS[0] as string}`
    const pricing = Object.entries(prices)
      .map(([ref, price]) => `  ${JSON.stringify(ref)}: ${JSON.stringify(price)}\n`)
      .join('')

    boot = await bootOps({
      dataDir,
      bareModuleBaseUrl: import.meta.url,
      fake: false,
      files: {
        'config/ops.yaml':
          `timezone: Europe/Bucharest\ndata_dir: ${JSON.stringify(dataDir)}\n` +
          `access:\n  allowed_users:\n    - { channel: console, userId: '${ADMIN}' }\n` +
          `channel:\n  default_address: "console:${ADMIN}"\n  progress_enabled: false\n` +
          `budgets:\n  default_day_usd: 1\n  default_month_usd: 2\n` +
          `unknown_model_policy: block\nprice_refresh: false\n` +
          `pricing:\n${pricing}` +
          `providers:\n  deepinfra:\n    base_url: http://127.0.0.1:${port}\n    models: ${JSON.stringify(MODELS)}\n` +
          `tasks:\n  model: ${first}\n` +
          `orchestrator:\n  enabled: false\n`,
      },
      replaceEntries: [
        ...BASE_ENTRIES.map((entry) =>
          entry.id === 'agent-default-model'
            ? { ...entry, config: { provider: 'deepinfra', model: MODELS[0] as string } }
            : entry,
        ),
        persistenceEntry(join(dataDir, 'sessions')),
        OPTIONAL_ENTRIES.approval,
        OPTIONAL_ENTRIES.agentPresets,
        { id: 'ops-config-registry', name: '@argus-agent/argus-agent/registry-row' },
        { id: 'ops-providers', name: '@argus-agent/argus-agent/providers-row' },
        { id: 'ops-store', name: '@argus-agent/store' },
        { id: 'ops-projects', name: '@argus-agent/projects' },
        { id: 'ops-meter', name: '@argus-agent/meter' },
        { id: 'ops-governor', name: '@argus-agent/governor' },
        OPTIONAL_ENTRIES.commands,
        { id: 'ops-commands', name: '@argus-agent/commands' },
        { id: 'ops-channel', name: '@argus-agent/channel' },
        { id: 'ops-approvals-bridge', name: '@argus-agent/approvals-bridge' },
        { id: 'ops-memory', name: '@argus-agent/memory' },
        { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
      ],
    })
    const ctx = boot.ctx as unknown as { opsStore: OpsStore; opsMeter: OpsMeter; opsChannel: OpsChannel }
    await waitFor(() => ctx.opsChannel !== undefined && ctx.opsMeter !== undefined, { timeoutMs: 60_000, label: 'ops chain' })
    store = ctx.opsStore
    meter = ctx.opsMeter
    channel = ctx.opsChannel
    console_ = new ConsoleChannelAdapter()
    channel.register(console_)
  }, 120_000)

  afterAll(async () => {
    await channel?.dispose()
    await meter?.stop()
    await boot?.dispose()
    proxy?.close()
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
  })

  for (const [index, model] of MODELS.entries()) {
    const project = `di-${index + 1}`
    const ref = `deepinfra/${model}`

    it(`${ref}: every request accounted at DeepInfra's billed cost`, async () => {
      const price = meter.priceOf({ provider: 'deepinfra', model })
      expect(price?.source).toBe('config')

      let before = console_.sent.length
      await say(`/new ${project} ${ref}`)
      await waitFor(() => console_.sent.length > before, { timeoutMs: 20_000, label: '/new reply' })
      expect(rows('SELECT id FROM projects WHERE id = ?', project)).toHaveLength(1)
      await say(`/p ${project}`)

      // Two turns: the second re-sends the first's prompt, so cached tokens are exercised.
      const billedBefore = billed.length
      for (const [turn, word] of ['ARGUS-DI-ONE', 'ARGUS-DI-TWO'].entries()) {
        before = console_.sent.length
        await say(`Reply with exactly the word ${word} and nothing else. Do not use any tool.`)
        await waitFor(
          () => rows("SELECT id FROM runs WHERE project_id = ? AND status != 'running'", project).length > turn,
          { timeoutMs: 180_000, label: `${ref} run ${turn + 1}` },
        )
        await waitFor(() => console_.sent.slice(before).some((sent) => sent.message.text.includes(word)), {
          timeoutMs: 30_000,
          label: `${word} delivered`,
        })
      }
      const runs = rows<{ id: string; status: string }>('SELECT id, status FROM runs WHERE project_id = ? ORDER BY rowid', project)
      expect(runs.map((run) => run.status)).toEqual(['completed', 'completed'])

      await meter.flush()
      const usage = rows<{ input_tokens: number; cached_tokens: number; output_tokens: number; cost_micros: number }>(
        `SELECT input_tokens, cached_tokens, output_tokens, cost_micros FROM usage_events
         WHERE run_id IN (${runs.map(() => '?').join(',')}) ORDER BY rowid`,
        ...runs.map((run) => run.id),
      )
      const truth = billed.slice(billedBefore).filter((entry) => entry.model === model)

      // One accounted event per billed request, with the same token counts.
      expect(usage.length).toBe(truth.length)
      let argusTotal = 0
      let deepinfraTotal = 0
      for (const [i, event] of usage.entries()) {
        const bill = truth[i] as Billed
        expect(event.input_tokens + event.cached_tokens).toBe(bill.promptTokens)
        expect(event.cached_tokens).toBe(bill.cachedTokens)
        expect(event.output_tokens).toBe(bill.completionTokens)
        // DeepInfra reports USD; Argus integer micro-USD, rounded once per request.
        expect(Math.abs(event.cost_micros - bill.estimatedCostUsd * 1_000_000)).toBeLessThanOrEqual(1)
        argusTotal += event.cost_micros
        deepinfraTotal += bill.estimatedCostUsd * 1_000_000
      }
      expect(argusTotal).toBeGreaterThan(0)
      expect(Number(meter.spending(`project:${project}`).dayMicros)).toBe(argusTotal)
      console.info(
        `${ref}: ${usage.length} requests, ` +
          `tokens in/cached/out ${truth.map((b) => `${b.promptTokens - b.cachedTokens}/${b.cachedTokens}/${b.completionTokens}`).join(', ')}; ` +
          `Argus ${argusTotal} µUSD vs DeepInfra ${deepinfraTotal.toFixed(2)} µUSD at ${JSON.stringify(price)}`,
      )
    }, 420_000)
  }
})
