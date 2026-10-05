// == ARGUS AGENT PROJECT ==
/**
 * Channel addresses and message priorities.
 *
 * @module @argus-agent/types/channel
 */

/**
 * Where a message came from and where its result goes.
 *
 * Persisted as JSON in `runs.reply_chat` and `schedules.reply_chat`, so the
 * shape is stable and every field is a string.
 */
export interface ChannelAddress {
  /** Adapter name: `telegram`, later `slack`, `console` in tests. */
  readonly channel: string
  /** Platform chat identity. A string because platforms differ. */
  readonly chatId: string
  /** Optional thread or topic within the chat. */
  readonly threadId?: string
}

/**
 * Whether two addresses are the same.
 * @param a first address.
 * @param b second address.
 * @returns whether they address the same conversation.
 */
export function addressesEqual(a: ChannelAddress, b: ChannelAddress): boolean {
  return a.channel === b.channel && a.chatId === b.chatId && (a.threadId ?? '') === (b.threadId ?? '')
}

/**
 * Encode an address for storage.
 * @param address the address to encode.
 * @returns a JSON string.
 */
export function encodeAddress(address: ChannelAddress): string {
  return JSON.stringify(address)
}

/**
 * Decode an address read from storage.
 * @param value the stored JSON.
 * @returns the address, or `undefined` when the value is not a valid address.
 */
export function decodeAddress(value: string): ChannelAddress | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record['channel'] !== 'string' || record['channel'].length === 0) return undefined
  if (typeof record['chatId'] !== 'string' || record['chatId'].length === 0) return undefined
  const threadId = record['threadId']
  if (threadId !== undefined && typeof threadId !== 'string') return undefined
  return threadId === undefined
    ? { channel: record['channel'], chatId: record['chatId'] }
    : { channel: record['channel'], chatId: record['chatId'], threadId }
}

/**
 * A request's priority.
 *
 * `0` is a human waiting for an answer, `1` is a scheduled run, `2` is
 * background work. The dispatcher orders by priority and then by age, and
 * priority 1–2 requests may never occupy the slots reserved for priority 0.
 */
export type Priority = 0 | 1 | 2

/** A human is waiting: the highest priority. */
export const INTERACTIVE: Priority = 0

/** A scheduled run. */
export const SCHEDULED: Priority = 1

/** Background work. */
export const BACKGROUND: Priority = 2

/** Every priority, in dispatch order. */
export const PRIORITIES: readonly Priority[] = [INTERACTIVE, SCHEDULED, BACKGROUND]

/**
 * Admit a number as a {@link Priority}.
 * @param value the candidate.
 * @returns the priority, or `undefined` when out of range.
 */
export function asPriority(value: number): Priority | undefined {
  return value === 0 || value === 1 || value === 2 ? value : undefined
}

/** A human-readable name for a priority, for logs and status output. */
export function priorityName(priority: Priority): string {
  switch (priority) {
    case 0:
      return 'interactive'
    case 1:
      return 'scheduled'
    case 2:
      return 'background'
  }
}
