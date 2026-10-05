// == ARGUS AGENT PROJECT ==
/**
 * Every package a plugin imports at RUNTIME must be a dependency or a peer.
 *
 * The image installs the workspace with `pnpm install --prod`, which links only
 * `dependencies` and `peerDependencies`. A value imported from a package that is
 * merely a `devDependency` still resolves in the development workspace, where
 * everything is installed, and then fails in the image with "failed to import".
 * Type-only imports are erased by the compiler and are exempt.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGES = join(import.meta.dirname, '..', '..', 'packages')
const BUILTIN = new Set(builtinModules)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  )
}

/** The package name of an import specifier: `@scope/name` or `name`. */
function packageOf(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

describe('runtime dependencies', () => {
  for (const dir of readdirSync(PACKAGES)) {
    const manifest = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    it(`${manifest.name} declares every package it imports at runtime`, () => {
      const declared = new Set([
        manifest.name,
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ])
      const missing = new Set<string>()
      for (const file of sourceFiles(join(PACKAGES, dir, 'src'))) {
        const text = readFileSync(file, 'utf8')
        // Static imports and re-exports, including side-effect imports; `import type`
        // and `export type` are skipped.
        const statics = text.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?'([^']+)'/g)
        const dynamics = text.matchAll(/\bimport\(\s*'([^']+)'/g)
        const specs = [
          ...[...statics].filter((m) => !m[1]).map((m) => m[2]!),
          ...[...dynamics].map((m) => m[1]!),
        ]
        for (const spec of specs) {
          if (spec.startsWith('.') || spec.startsWith('node:') || BUILTIN.has(spec)) continue
          if (!declared.has(packageOf(spec))) missing.add(packageOf(spec))
        }
      }
      expect([...missing], `imported at runtime but not a dependency or peer`).toEqual([])
    })
  }
})
