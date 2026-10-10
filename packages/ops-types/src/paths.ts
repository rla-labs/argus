// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/types/paths` — whether a path stays inside an agent's folder.
 *
 * @module @argus-agent/types/paths
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Whether a path an agent names stays inside its folder.
 *
 * Relative paths resolve against the folder, as dsh's file tools resolve them, and
 * both sides go through `realpath` so a symlink inside the folder cannot point out of
 * it. A `~` path is outside:
 * it is not resolved here, and a backend that expands it would reach the home folder.
 *
 * @param root the agent's folder.
 * @param path the path, absolute or relative to `root`.
 * @returns whether it is `root` or below it.
 */
export function isInside(root: string, path: string): boolean {
  if (path.startsWith('~')) return false
  // The nearest part that exists is resolved, and the rest kept: a file not yet
  // made under a symlinked folder is still under the symlink's target.
  const real = (target: string): string => {
    try {
      return realpathSync(target)
    } catch {
      const parent = dirname(target)
      return parent === target ? target : join(real(parent), basename(target))
    }
  }
  const base = real(resolve(root))
  const rel = relative(base, real(resolve(base, path)))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
