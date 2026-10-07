// == ARGUS AGENT PROJECT ==
/**
 * Phase A's exit criterion against the REAL services: a real Telegram bot and real
 * models through OpenRouter. Nothing is faked except the person typing: a bot
 * cannot message itself, so each "user message" is handed to `ops-channel` exactly
 * as the Telegram adapter hands it a polled update. Every reply goes out through
 * the real Bot API to the admin's chat, and every model call is billed.
 *
 * Opt-in, never part of `pnpm test` or CI: `pnpm test:live` with
 *
 * | Variable | Meaning |
 * |---|---|
 * | `ARGUS_LIVE=1` | Run at all. |
 * | `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`) | Billed. A run costs well under $0.05. |
 * | `TELEGRAM_BOT_TOKEN` (or `TELEGRAM_KEY`) | No other process may poll this bot. |
 * | `ARGUS_AGENT_ADMIN_ID` | Numeric Telegram user id that has sent `/start` to the bot. |
 * | `ARGUS_LIVE_MODELS` | Optional, comma-separated `openrouter/...` refs. |
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootOps,
  BASE_ENTRIES,
  OPTIONAL_ENTRIES,
  persistenceEntry,
  waitFor,
  type OpsBoot,
} from '@argus-agent/testkit'
import type { OpsStore } from '@argus-agent/store'
import type { OpsMeter } from '@argus-agent/meter'
import type { OpsChannel } from '@argus-agent/channel'
import type { ChannelAdapter, OutgoingMessage } from '@argus-agent/types'

const env = process.env
const OPENROUTER = env['OPENROUTER_API_KEY'] ?? env['OPENROUTER_KEY']
const TELEGRAM = env['TELEGRAM_BOT_TOKEN'] ?? env['TELEGRAM_KEY']
const ADMIN = env['ARGUS_AGENT_ADMIN_ID']
const LIVE = env['ARGUS_LIVE'] === '1' && OPENROUTER !== undefined && TELEGRAM !== undefined && ADMIN !== undefined

const MODELS = (env['ARGUS_LIVE_MODELS'] ?? 'openrouter/deepseek/deepseek-v4-flash,openrouter/z-ai/glm-5.3-flash')
  .split(',')
  .map((ref) => ref.trim())

interface Sent {
  readonly text: string
  readonly messageId: string
}

let boot: OpsBoot
let store: OpsStore
let meter: OpsMeter
let channel: OpsChannel
let dataDir: string
const sent: Sent[] = []
let messageSeq = 0
let billedAtStart = 0
let accountedTotal = 0

/** One message from the admin, as the adapter would hand it over. */
async function say(text: string): Promise<void> {
  messageSeq += 1
  await channel.handleIncoming({
    id: `live:${Date.now()}:${messageSeq}`,
    address: { channel: 'telegram', chatId: ADMIN as string },
    userId: ADMIN as string,
    text,
    timestamp: Date.now(),
  })
}

/**
 * What OpenRouter has billed the account so far, in USD. The per-key counter
 * (`/api/v1/key` → `usage`) lagged at 0 for minutes after a billed run, so the
 * account total is used; other use of the same account in the meantime only
 * makes it larger, which the tolerance below allows for.
 */
async function billedUsd(): Promise<number> {
  const response = await fetch('https://openrouter.ai/api/v1/credits', {
    headers: { authorization: `Bearer ${OPENROUTER}` },
  })
  const body = (await response.json()) as { data: { total_usage: number } }
  return body.data.total_usage
}

function rows<T>(sql: string, ...params: unknown[]): T[] {
  return store.db.prepare(sql).all(...params) as T[]
}

describe.skipIf(!LIVE)('Phase A, live: real Telegram bot, real models via OpenRouter', () => {
  beforeAll(async () => {
    env['OPENROUTER_API_KEY'] = OPENROUTER
    env['TELEGRAM_BOT_TOKEN'] = TELEGRAM
    billedAtStart = await billedUsd()
    dataDir = mkdtempSync(join(tmpdir(), 'argus-live-'))
    mkdirSync(join(dataDir, 'projects'), { recursive: true })
    mkdirSync(join(dataDir, 'config', 'projects'), { recursive: true })
    const first = MODELS[0] as string

    boot = await bootOps({
      dataDir,
      bareModuleBaseUrl: import.meta.url,
      fake: false,
      files: {
        'config/ops.yaml':
          `timezone: Europe/Bucharest\ndata_dir: ${JSON.stringify(dataDir)}\n` +
          `access:\n  allowed_users:\n    - { channel: telegram, userId: '${ADMIN}' }\n` +
          `channel:\n  default_address: "telegram:${ADMIN}"\n  progress_enabled: false\n` +
          `telegram:\n  bot_token: \${TELEGRAM_BOT_TOKEN}\n` +
          `budgets:\n  default_day_usd: 1\n  default_month_usd: 2\n` +
          `unknown_model_policy: block\nprice_refresh: true\n` +
          `tasks:\n  model: ${first}\n` +
          `orchestrator:\n  enabled: true\n  model: ${first}\n  day_usd: 1\n` +
          `health:\n  enabled: true\n  endpoint: false\n  daily_report: false\n  backup: false\n`,
      },
      // The bundle's rows, minus logging: the providers row mounts the routes.
      replaceEntries: [
        ...BASE_ENTRIES.map((entry) =>
          entry.id === 'agent-default-model'
            ? { ...entry, config: { provider: 'openrouter', model: first.slice('openrouter/'.length) } }
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
        { id: 'ops-telegram', name: '@argus-agent/telegram' },
        { id: 'ops-orchestrator', name: '@argus-agent/orchestrator' },
        { id: 'ops-scheduler', name: '@argus-agent/scheduler' },
        { id: 'ops-approvals-bridge', name: '@argus-agent/approvals-bridge' },
        { id: 'ops-memory', name: '@argus-agent/memory' },
        { id: 'ops-health', name: '@argus-agent/health' },
        { id: 'ops-config', name: '@argus-agent/argus-agent/loader-row' },
      ],
    })
    const ctx = boot.ctx as unknown as { opsStore: OpsStore; opsMeter: OpsMeter; opsChannel: OpsChannel }
    await waitFor(() => ctx.opsChannel !== undefined && ctx.opsMeter !== undefined, { timeoutMs: 60_000, label: 'ops chain' })
    store = ctx.opsStore
    meter = ctx.opsMeter
    channel = ctx.opsChannel

    // The REAL adapter, polling with the real token. Its `send` is observed, not
    // replaced: a recorded message id is Telegram's own acceptance of the message.
    await waitFor(() => channel.adapters().some((adapter) => adapter.name === 'telegram'), {
      timeoutMs: 30_000,
      label: 'telegram adapter',
    })
    const telegram = channel.adapters().find((adapter) => adapter.name === 'telegram') as ChannelAdapter & {
      isConnected(): boolean
      error?: string
    }
    const send = telegram.send.bind(telegram)
    telegram.send = async (to, message: OutgoingMessage) => {
      const ref = await send(to, message)
      sent.push({ text: message.text, messageId: ref.messageId })
      return ref
    }
    await waitFor(() => telegram.isConnected(), { timeoutMs: 30_000, label: `telegram connected (${telegram.error ?? ''})` })
  }, 120_000)

  afterAll(async () => {
    console.info(
      `reconcile later: OpenRouter credits total_usage was ${billedAtStart} USD at the start; ` +
        `this run accounted ${accountedTotal} µUSD (ceiling prices, so the bill should be at most that)`,
    )
    await channel?.dispose()
    await meter?.stop()
    await boot?.dispose()
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
  })

  it('answers /help over the real Bot API', async () => {
    const before = sent.length
    await say('/help')
    await waitFor(() => sent.length > before, { timeoutMs: 20_000, label: '/help reply' })
    expect(sent.slice(before).map((entry) => entry.text).join('\n')).toContain('/new')
    expect(Number(sent[before]?.messageId)).toBeGreaterThan(0)
  }, 30_000)

  for (const [index, ref] of MODELS.entries()) {
    const model = ref.slice('openrouter/'.length)
    const project = `demo-${index + 1}`

    it(`runs ${ref} end to end, accounted at OpenRouter's price`, async () => {
      // Prices come from OpenRouter's live list, fetched at boot.
      await waitFor(() => meter.priceOf({ provider: 'openrouter', model }) !== undefined, {
        timeoutMs: 60_000,
        label: `a price for ${ref}`,
      })
      let before = sent.length
      await say(`/new ${project} ${ref}`)
      await waitFor(() => sent.length > before, { timeoutMs: 20_000, label: '/new reply' })
      // `/new` fetched the provider ceiling before answering, and says so.
      expect(sent.slice(before).map((entry) => entry.text).join('\n')).toContain('OpenRouter, highest-priced provider')
      expect(rows<{ id: string }>('SELECT id FROM projects WHERE id = ?', project)).toHaveLength(1)
      await say(`/p ${project}`)

      before = sent.length
      await say('Reply with exactly the word ARGUS-LIVE-OK and nothing else. Do not use any tool.')

      await waitFor(
        () => rows<{ status: string }>("SELECT status FROM runs WHERE project_id = ? AND status != 'running'", project).length > 0,
        { timeoutMs: 120_000, label: `the ${ref} run` },
      )
      const [run] = rows<{ id: string; status: string; provider: string; model: string }>(
        'SELECT id, status, provider, model FROM runs WHERE project_id = ?',
        project,
      )
      expect(run).toMatchObject({ status: 'completed', provider: 'openrouter', model })

      // The answer reached the admin's chat.
      await waitFor(() => sent.slice(before).some((entry) => entry.text.includes('ARGUS-LIVE-OK')), {
        timeoutMs: 30_000,
        label: 'the answer on Telegram',
      })

      // Accounted: every request priced at the highest price among the model's
      // OpenRouter providers (read now: the ceiling lands within a minute of /new).
      await waitFor(() => meter.priceOf({ provider: 'openrouter', model })?.matchedBy.includes('highest') === true, {
        timeoutMs: 90_000,
        label: `the provider ceiling for ${ref}`,
      })
      const price = meter.priceOf({ provider: 'openrouter', model })
      await meter.flush()
      const usage = rows<{ input_tokens: number; cached_tokens: number; output_tokens: number; cost_micros: number }>(
        'SELECT input_tokens, cached_tokens, output_tokens, cost_micros FROM usage_events WHERE run_id = ?',
        (run as { id: string }).id,
      )
      expect(usage.length).toBeGreaterThan(0)
      let total = 0
      for (const event of usage) {
        expect(event.input_tokens + event.output_tokens).toBeGreaterThan(0)
        const expected =
          event.input_tokens * (price?.input ?? NaN) +
          event.cached_tokens * (price?.cached ?? NaN) +
          event.output_tokens * (price?.output ?? NaN)
        expect(Math.abs(event.cost_micros - expected)).toBeLessThanOrEqual(1)
        total += event.cost_micros
      }
      expect(total).toBeGreaterThan(0)
      expect(Number(meter.spending(`project:${project}`).dayMicros)).toBe(total)

      // OpenRouter's own usage counters lag by over a quarter of an hour, so the bill
      // is reconciled by hand afterwards, from these lines and the one afterAll prints.
      accountedTotal += total
      console.info(`${ref}: run ${(run as { id: string }).id} accounted ${total} µUSD at ${JSON.stringify(price)}`)
    }, 300_000)
  }

  it('answers /status with the projects it ran', async () => {
    const before = sent.length
    await say('/status')
    await waitFor(() => sent.length > before, { timeoutMs: 20_000, label: '/status reply' })
    expect(Number(sent[before]?.messageId)).toBeGreaterThan(0)
  }, 30_000)
})
