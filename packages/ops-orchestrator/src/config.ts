// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/orchestrator/config` — the `orchestrator` section.
 *
 * @module @argus-agent/orchestrator/config
 */
import z from '@deepseek-ai/schemastery'
import type { Schema } from './schema-type.js'

/** The `orchestrator` section. */
export interface OrchestratorSection {
  /** Whether the orchestrator is mounted at all. */
  readonly enabled: boolean
  /** The model, as `provider/model`. Should be cheap and fast. */
  readonly model: string
  /** The preset id mounted into the orchestrator agent. */
  readonly preset: string
  /** Whether sending to a project makes it the chat's active project. */
  readonly switch_active_on_send: boolean
  /** Models `run_task` may be asked for. An empty list permits none. */
  readonly allowed_task_models: readonly string[]
  /** Whether the orchestrator session is reset every day. */
  readonly reset_daily: boolean
  /** The budget for the `orchestrator` scope, in USD per day. */
  readonly day_usd: number
  /** The longest a `note` may be. */
  readonly max_note_length: number
}

/** The `orchestrator` schema. */
export const orchestratorSchema: Schema = z
  .object({
    enabled: z.boolean().default(true),
    model: z.string().default('deepseek/deepseek-flash'),
    preset: z.string().default('ops-orchestrator'),
    switch_active_on_send: z.boolean().default(true),
    allowed_task_models: z.array(z.string()).default([]),
    reset_daily: z.boolean().default(true),
    day_usd: z.number().min(0).default(1),
    max_note_length: z.number().min(0).default(500),
  })
  .default({})

/** The tool names the orchestrator is allowed, in the order the prompt lists them. */
export const ORCHESTRATOR_TOOLS = [
  'list_projects',
  'send_to_project',
  'run_task',
  'project_status',
  'usage_summary',
  'answer',
] as const

/** One allowed tool name. */
export type OrchestratorTool = (typeof ORCHESTRATOR_TOOLS)[number]

/**
 * Build the section from the raw document.
 *
 * @param raw the raw parsed `ops.yaml`.
 * @returns the section, with its defaults.
 */
export function orchestratorOf(raw: Record<string, unknown>): OrchestratorSection {
  const parse = orchestratorSchema as unknown as (value: unknown) => OrchestratorSection
  return parse(raw['orchestrator'] ?? {})
}

/**
 * Split a `provider/model` reference.
 *
 * @param ref the reference.
 * @returns the parts, or `undefined` when it is malformed.
 */
export function splitModelRef(ref: string): { provider: string; model: string } | undefined {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }
}

/**
 * Whether `run_task` may be asked for a model.
 *
 * An empty list permits **none**, which is the safe default: a task with a model
 * chosen by a model is a cost decision made by the thing being cost-controlled.
 *
 * @param requested the requested model, when one was given.
 * @param allowed the configured list.
 * @returns whether it is permitted.
 */
export function taskModelAllowed(requested: string | undefined, allowed: readonly string[]): boolean {
  if (requested === undefined || requested.trim().length === 0) return true
  return allowed.includes(requested)
}
