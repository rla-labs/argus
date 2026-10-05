// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/channel/config` — the `access` and `channel` sections.
 *
 * @module @argus-agent/channel/config
 */
import z from '@deepseek-ai/schemastery'
import { decodeAddress, type ChannelAddress } from '@argus-agent/types'
import type { Schema } from './schema-type.js'
import type { AllowedUser } from './access.js'

/** The `access` section. */
export interface AccessSection {
  readonly allowed_users: readonly AllowedUser[]
  /** Where warnings go, as an address string. */
  readonly admin: string | null
  readonly warn_interval_minutes: number
}

/** The `channel` section. */
export interface ChannelSection {
  /** Where a message with no reply address goes. */
  readonly default_address: string | null
  /** Where an attachment is saved when there is no active project. */
  readonly attachment_scratch: string
  /** The interval between progress edits, in seconds. */
  readonly progress_interval_s: number
  /** Whether progress messages are sent at all. */
  readonly progress_enabled: boolean
}

/** The `access` schema. */
export const accessSchema: Schema = z
  .object({
    allowed_users: z
      .array(
        z.object({
          channel: z.string().required(),
          userId: z.string().required(),
        }),
      )
      .default([]),
    admin: z.union([z.string(), z.const(null)]).default(null),
    warn_interval_minutes: z.number().min(1).default(15),
  })
  .default({})

/** The `channel` schema. */
export const channelSchema: Schema = z
  .object({
    default_address: z.union([z.string(), z.const(null)]).default(null),
    attachment_scratch: z.string().default('scratch'),
    progress_interval_s: z.number().min(1).default(20),
    progress_enabled: z.boolean().default(true),
  })
  .default({})

/**
 * Build the access configuration from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function accessOf(raw: Record<string, unknown>): AccessSection {
  const parse = accessSchema as unknown as (value: unknown) => AccessSection
  return parse(raw['access'] ?? {})
}

/**
 * Build the channel configuration from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function channelOf(raw: Record<string, unknown>): ChannelSection {
  const parse = channelSchema as unknown as (value: unknown) => ChannelSection
  return parse(raw['channel'] ?? {})
}

/**
 * Decode a configured address string.
 *
 * Two forms are accepted, because an operator writing `ops.yaml` should not have
 * to guess at a JSON shape: the JSON object form the store uses, and the short
 * `channel:chatId` form that is easier to type and read.
 *
 * @param value the configured string; null, undefined or empty means absent.
 * @returns the address, or `undefined` when it is absent or malformed.
 */
export function parseAddress(value: string | null | undefined): ChannelAddress | undefined {
  // Accepts `undefined` as well as `null`: a section that was omitted entirely
  // produces `undefined` for its keys, and a plugin that threw on a missing
  // optional address would refuse to mount at all.
  if (value === null || value === undefined || value.trim().length === 0) return undefined
  const trimmed = value.trim()
  if (trimmed.startsWith('{')) return decodeAddress(trimmed)

  const separator = trimmed.indexOf(':')
  if (separator <= 0 || separator === trimmed.length - 1) return undefined
  const channel = trimmed.slice(0, separator)
  const rest = trimmed.slice(separator + 1)
  // A third segment is a thread id.
  const threadSeparator = rest.indexOf(':')
  return threadSeparator === -1
    ? { channel, chatId: rest }
    : { channel, chatId: rest.slice(0, threadSeparator), threadId: rest.slice(threadSeparator + 1) }
}
