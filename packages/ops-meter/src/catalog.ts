// == ARGUS AGENT PROJECT ==
/**
 * The price catalog: what a model costs when `ops.yaml` does not say.
 *
 * Built from the AI API Pricing dataset (aicostbudget.com, CC BY 4.0). The same
 * normalization serves the snapshot shipped with Argus and a later refresh from
 * the live export, so both produce identical entries.
 *
 * **Conservative by design.** A budget that underestimates is a budget that is
 * exceeded, so every price is the highest that can apply to a standard request:
 * the long-context tier when a model has one, and the peak-hour price when a
 * provider discounts off-peak hours. Batch, flex and priority modes are ignored
 * — dsh sends standard requests.
 *
 * @module @argus-agent/meter/catalog
 */

/** One model's price in the catalog, USD per million tokens. */
export interface CatalogEntry {
  /** The dataset's provider id, e.g. `deepseek`, `google-gemini`. */
  readonly provider: string
  /** The dataset's model id, e.g. `deepseek-flash`, `claude-haiku-4.5`. */
  readonly model: string
  readonly input: number
  /** Cache reads. Falls back to `input` when the provider publishes none. */
  readonly cached: number
  readonly output: number
  /** Cache writes (the standard 5-minute write when there are several). Falls back to `input`. */
  readonly cacheWrite: number
  /** `latest`, `active`, `legacy`, `retired`, … as the dataset reports it. */
  readonly status: string
  /** When the dataset last verified the price against the provider, `YYYY-MM-DD`. */
  readonly verifiedAt: string | null
  /** The provider's own pricing page. */
  readonly sourceUrl: string
}

/** Where a catalog came from, for attribution and for the operator. */
export interface CatalogMeta {
  readonly title: string
  readonly url: string
  readonly license: string
  /** When the dataset was retrieved, `YYYY-MM-DD`. */
  readonly retrievedAt: string
  /** What Argus changed, as CC BY 4.0 asks. */
  readonly changes: string
}

/** A whole catalog. */
export interface Catalog {
  readonly meta: CatalogMeta
  readonly entries: readonly CatalogEntry[]
}

/** One dataset row. Nested fields are JSON text in the CSV and parsed in the JSON export. */
export type DatasetRow = Record<string, unknown>

/** A component of a price, as the dataset's `pricing_components_json` lists them. */
interface Component {
  readonly component: string
  readonly amount: string | number
  readonly condition?: { readonly processing_mode?: string }
}

function parsed<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value as T
  try {
    return (JSON.parse(value) as T | null) ?? fallback
  } catch {
    return fallback
  }
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function max(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined)
  return present.length === 0 ? undefined : Math.max(...present)
}

/**
 * Normalize dataset rows into catalog entries.
 *
 * Rows that are not priced per token (OCR, speech, embeddings priced per page or
 * minute) and rows without both an input and an output price are skipped: a
 * model the catalog cannot price must stay unpriced, not be priced at a guess.
 *
 * @param rows the dataset rows.
 * @returns the entries, sorted by provider and model.
 */
export function normalizeDataset(rows: readonly DatasetRow[]): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const row of rows) {
    const unit = String(row['pricing_unit'] ?? '')
    if (unit !== '' && unit !== '1M tokens') continue
    if (String(row['currency'] ?? 'USD') !== 'USD') continue

    // The CSV names nested fields `*_json` and carries them as text; the JSON
    // export names them without the suffix and carries them as objects.
    const standard = parsed<Component[]>(row['pricing_components_json'] ?? row['pricing_components'], []).filter(
      (c) => (c.condition?.processing_mode ?? 'standard') === 'standard',
    )
    const amounts = (...kinds: string[]) =>
      standard.filter((c) => kinds.includes(c.component)).map((c) => num(c.amount))
    const tiers = parsed<Array<Record<string, unknown>>>(row['pricing_tiers_json'] ?? row['pricing_tiers'], []).filter(
      (t) => (t['processing_mode'] ?? 'standard') === 'standard',
    )
    const periods = parsed<{ periods?: Array<Record<string, unknown>> } | null>(row['time_pricing_json'] ?? row['time_pricing'], null)
      ?.periods ?? []

    const input = max([
      num(row['input_price_per_1m_tokens']),
      ...amounts('input'),
      ...tiers.map((t) => num(t['input_price_per_1m_tokens'])),
      ...periods.map((p) => num(p['inputPrice'])),
    ])
    const output = max([
      num(row['output_price_per_1m_tokens']),
      ...amounts('output'),
      ...tiers.map((t) => num(t['output_price_per_1m_tokens'])),
      ...periods.map((p) => num(p['outputPrice'])),
    ])
    if (input === undefined || output === undefined) continue

    const cached =
      max([
        num(row['cached_input_price_per_1m_tokens']),
        ...amounts('cached_input', 'cache_read'),
        ...tiers.map((t) => num(t['cached_input_price_per_1m_tokens'])),
        ...periods.map((p) => num(p['cachedInputPrice'])),
      ]) ?? input
    const fiveMinute = max(amounts('cache_write_5m'))
    const cacheWrite = fiveMinute ?? max(amounts('cache_write')) ?? input

    entries.push({
      provider: String(row['provider_id']),
      model: String(row['model_id']),
      input,
      cached,
      output,
      cacheWrite,
      status: String(row['status'] ?? ''),
      verifiedAt: (row['last_verified_at'] as string | undefined) || null,
      sourceUrl: String(row['official_source_url'] ?? ''),
    })
  }
  return entries.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
}

/** Where the live dataset is published. */
export const DATASET_URL = 'https://aicostbudget.com/api/datasets/ai-api-pricing.json'

/** The attribution and the changes Argus makes, shared by the snapshot and a refresh. */
export const DATASET_META: Omit<CatalogMeta, 'retrievedAt'> = {
  title: 'AI API Pricing',
  url: 'https://aicostbudget.com/en/datasets/ai-api-pricing',
  license: 'CC BY 4.0',
  changes:
    'Token-priced models only; for each model the highest standard-mode price that can ' +
    'apply (long-context tier, peak hours); the 5-minute cache-write price.',
}

/**
 * Build a catalog from the dataset's JSON export (`{ metadata, records }`).
 *
 * @param document the parsed export.
 * @param fallbackDate the retrieval date to use when the export carries none.
 * @returns the catalog.
 * @throws when the document does not have the export's shape.
 */
export function catalogFromExport(document: unknown, fallbackDate: string): Catalog {
  const records = (document as { records?: unknown })?.records
  if (!Array.isArray(records)) throw new Error('the dataset export has no `records` list')
  const updated = (document as { metadata?: { last_updated?: unknown } }).metadata?.last_updated
  const retrievedAt = typeof updated === 'string' && /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(0, 10) : fallbackDate
  return { meta: { ...DATASET_META, retrievedAt }, entries: normalizeDataset(records as DatasetRow[]) }
}

/**
 * How the provider names Argus's adapters use map onto the dataset's.
 *
 * A direct provider maps to itself; OpenRouter's model ids are `vendor/model`,
 * so its vendor prefixes map too. A provider not listed here has no catalog
 * prices — its models need an entry in `ops.yaml`.
 */
export const CATALOG_PROVIDERS: Readonly<Record<string, string>> = {
  deepseek: 'deepseek',
  anthropic: 'anthropic',
  openai: 'openai',
}

/** OpenRouter vendor prefixes, mapped to the dataset's provider ids. */
export const OPENROUTER_VENDORS: Readonly<Record<string, string>> = {
  deepseek: 'deepseek',
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google-gemini',
  mistralai: 'mistral-ai',
  'x-ai': 'xai',
  moonshotai: 'moonshot-ai',
  cohere: 'cohere',
}

/**
 * The comparable form of a model id: lowercase, a trailing date snapshot
 * (`-20251001`) removed, and dots as dashes — so `claude-haiku-4-5-20251001`
 * and the dataset's `claude-haiku-4.5` meet.
 *
 * @param model a model id.
 * @returns the key to compare.
 */
export function modelKey(model: string): string {
  return model
    .toLowerCase()
    .replace(/-\d{8}$/, '')
    .replace(/\./g, '-')
}
