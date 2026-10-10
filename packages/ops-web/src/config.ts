// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/web/config` — the `web` section.
 *
 * @module @argus-agent/web/config
 */
import z from '@deepseek-ai/schemastery'
import type { Schema } from './schema-type.js'

/** The `web` section. */
export interface WebSection {
  /** Whether the web interface is served. */
  readonly enabled: boolean
  /**
   * The address to listen on. Loopback by default; the container sets
   * `ARGUS_AGENT_WEB_HOST=0.0.0.0`, which is its own network, and compose publishes
   * the port on the host's loopback only.
   */
  readonly host: string
  /** The port; 0 picks a free one (tests). */
  readonly port: number
  /**
   * The address the browser uses, for the `/web` link: the `tailscale serve` URL
   * (`https://<machine>.<tailnet>.ts.net`), a tunnel's, or the default.
   */
  readonly public_url: string
  /** How long a login lasts. */
  readonly session_hours: number
}

/** The `web` schema. */
export const webSchema: Schema = z
  .object({
    enabled: z.boolean().default(true),
    host: z.string().default(process.env['ARGUS_AGENT_WEB_HOST'] ?? '127.0.0.1'),
    port: z.number().min(0).max(65_535).default(3091),
    public_url: z.string().default(''),
    session_hours: z.number().min(1).max(24 * 30).default(24),
  })
  .default({})

/**
 * Build the section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults; `public_url` falls back to the local address.
 */
export function webOf(raw: Record<string, unknown>): WebSection {
  const parse = webSchema as unknown as (value: unknown) => WebSection
  const section = parse(raw['web'] ?? {})
  const fallback = `http://127.0.0.1:${section.port}`
  return { ...section, public_url: (section.public_url || fallback).replace(/\/+$/, '') }
}
