// == ARGUS AGENT PROJECT ==
/**
 * The schemastery schema type.
 *
 * Schemastery's default export is a `const` of its callable `Static` type, so
 * the general schema form is reachable as that value's type. Aliasing it here
 * keeps the public signatures readable without depending on the package's
 * internal type aliases.
 *
 * @module @argus-agent/web/schema-type
 */
import type z from '@deepseek-ai/schemastery'

/** Any schemastery schema. */
export type Schema = z
