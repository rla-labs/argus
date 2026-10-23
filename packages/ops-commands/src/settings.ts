// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/commands/settings` — every setting, described from the schemas the
 * plugins register, so a form can be drawn for each key and nothing is file-only.
 *
 * A setting is a leaf of the schema: a value, a choice, a list or a map. Each one says
 * its type, its choices or bounds, its default, its value now, whether the file sets it,
 * and whether a change applies at once or after a restart.
 *
 * @module @argus-agent/commands/settings
 */

/** The part of a Schemastery schema this module reads. */
export interface SchemaNode {
  readonly type: string
  readonly meta?: { readonly default?: unknown; readonly description?: unknown; readonly min?: number; readonly max?: number }
  readonly dict?: Readonly<Record<string, SchemaNode>>
  readonly list?: readonly SchemaNode[]
  readonly inner?: SchemaNode
  readonly value?: unknown
}

/** How a setting's value is edited. */
export type SettingKind = 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'map' | 'value'

/** One setting. */
export interface SettingField {
  /** Dotted: `web.session_hours`. */
  readonly key: string
  readonly kind: SettingKind
  /** For `enum`, the choices. */
  readonly options: readonly string[]
  readonly min: number | null
  readonly max: number | null
  readonly default: unknown
  /** The value in effect: the file's, else the default. */
  readonly value: unknown
  /** Whether the file sets it. */
  readonly set: boolean
  readonly description: string | null
  /** When a change takes effect. */
  readonly apply: 'live' | 'restart' | 'next-message'
}

/** `ops.yaml` keys a change applies to at once (`/config` hands them to `/defaults`). */
export const LIVE_SYSTEM_KEYS: ReadonlySet<string> = new Set(['tasks.model', 'orchestrator.model', 'judge.model'])

/** `ops.yaml` keys that place Argus on disk: changed only by hand, with Argus stopped. */
export const FIXED_SYSTEM_KEYS: ReadonlySet<string> = new Set(['data_dir', 'config_dir', 'dsh_home'])

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** How a leaf is edited. */
function kindOf(node: SchemaNode): Pick<SettingField, 'kind' | 'options'> {
  if (node.type === 'string' || node.type === 'number' || node.type === 'boolean') return { kind: node.type, options: [] }
  if (node.type === 'union' && node.list !== undefined && node.list.length > 0 && node.list.every((each) => each.type === 'const' && typeof each.value === 'string')) {
    return { kind: 'enum', options: node.list.map((each) => each.value as string) }
  }
  if (node.type === 'array') return { kind: 'list', options: [] }
  if (node.type === 'dict') return { kind: 'map', options: [] }
  return { kind: 'value', options: [] }
}

/**
 * Every setting under a schema, with its value in a raw document.
 *
 * @param node the schema (an object).
 * @param raw the raw document at that point (the parsed file).
 * @param apply when a change to a key takes effect.
 * @param prefix the keys above.
 * @returns the settings, in the schema's order.
 */
export function describeSchema(node: SchemaNode, raw: unknown, apply: (key: string) => SettingField['apply'], prefix = ''): SettingField[] {
  if (node.type === 'object' && node.dict !== undefined) {
    const values = isRecord(raw) ? raw : {}
    return Object.entries(node.dict).flatMap(([name, child]) => describeSchema(child, values[name], apply, prefix.length === 0 ? name : `${prefix}.${name}`))
  }
  const fallback = node.meta?.default
  return [
    {
      key: prefix,
      ...kindOf(node),
      min: typeof node.meta?.min === 'number' ? node.meta.min : null,
      max: typeof node.meta?.max === 'number' ? node.meta.max : null,
      default: fallback === undefined ? null : fallback,
      value: raw === undefined ? (fallback === undefined ? null : fallback) : raw,
      set: raw !== undefined,
      description: typeof node.meta?.description === 'string' ? node.meta.description : null,
      apply: apply(prefix),
    },
  ]
}

/**
 * The schema of one key, a leaf or a section.
 *
 * @param node the root schema.
 * @param key dotted.
 * @returns the key's schema, or undefined when there is no such key.
 */
export function schemaAt(node: SchemaNode, key: string): SchemaNode | undefined {
  let at: SchemaNode | undefined = node
  for (const part of key.split('.')) {
    if (at?.type !== 'object' || at.dict === undefined) return undefined
    at = at.dict[part]
  }
  return at
}

/** When a change to an `ops.yaml` key takes effect. */
export function systemApply(key: string): SettingField['apply'] {
  return LIVE_SYSTEM_KEYS.has(key) ? 'live' : 'restart'
}

/**
 * The keys whose value in the file differs from what Argus started with and that need
 * a restart to take effect.
 *
 * @param root the root schema.
 * @param file the file as it is now.
 * @param boot the file as Argus read it at start.
 * @returns the keys, dotted.
 */
export function pendingRestart(root: SchemaNode, file: unknown, boot: unknown): string[] {
  const now = new Map(describeSchema(root, file, systemApply).map((field) => [field.key, field]))
  return describeSchema(root, boot, systemApply)
    .filter((field) => field.apply === 'restart' && JSON.stringify(field.value) !== JSON.stringify(now.get(field.key)?.value))
    .map((field) => field.key)
}
