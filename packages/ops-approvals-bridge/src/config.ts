// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/approvals-bridge/config` — the bridge's own settings.
 *
 * @module @argus-agent/approvals-bridge/config
 */
import z from '@deepseek-ai/schemastery'
import type { Schema } from './schema-type.js'

/** The bridge's settings, plus the ad-hoc policy. */
export interface ApprovalsSection {
  /** Whether the bridge answers approval requests at all. */
  readonly enabled: boolean
  /** The policy for a task with no project. `deny` by default. */
  readonly approvals_adhoc: 'auto' | 'ask' | 'deny'
  /** The default timeout, when a project does not set one. */
  readonly timeout_minutes: number
  /** How long to wait for the channel to answer, in seconds. */
  readonly ask_timeout_s: number
  /** Whether a run-scoped "approve all" is offered. */
  readonly allow_run_grant: boolean
  /** The longest action rendering in a question. */
  readonly max_action_length: number
}

/** The bridge's schema, including `approvals_adhoc`. */
export const approvalsSchema: Schema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * The policy for an ad-hoc task.
     *
     * `deny` by default: an unattended one-off has no project YAML to declare an
     * allowlist in, so there is nothing that could justify a grant.
     */
    approvals_adhoc: z.union([z.const('auto'), z.const('ask'), z.const('deny')]).default('deny'),
    timeout_minutes: z.number().min(1).default(30),
    ask_timeout_s: z.number().min(1).default(5),
    allow_run_grant: z.boolean().default(true),
    max_action_length: z.number().min(50).default(300),
  })
  .default({})

/**
 * Build the section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function approvalsOf(raw: Record<string, unknown>): ApprovalsSection {
  const parse = approvalsSchema as unknown as (value: unknown) => ApprovalsSection
  return parse(raw['approvals'] ?? {})
}
