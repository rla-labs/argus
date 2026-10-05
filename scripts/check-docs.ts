#!/usr/bin/env tsx
// == ARGUS AGENT PROJECT ==
/**
 * Documentation completeness gate.
 *
 * For every package directory under `packages/`, verify that the mandatory
 * documentation set exists and that no file still contains the `TODO`
 * placeholder. Exits non-zero with a per-file report otherwise.
 *
 * Usage:
 *   tsx scripts/check-docs.ts            # check every package
 *   tsx scripts/check-docs.ts ops-store  # check one package (dir name or @argus-agent name)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Files every package must ship, relative to the package directory. */
export const REQUIRED_DOC_FILES = [
  'README.md',
  'CHANGELOG.md',
  'docs/ARCHITECTURE.md',
  'docs/API.md',
  'docs/CONFIG.md',
  'docs/EVENTS.md',
  'docs/DATA.md',
  'docs/OPERATIONS.md',
  'docs/TESTING.md',
  'docs/DECISIONS.md',
] as const

/**
 * The placeholder that marks unwritten documentation. Any occurrence fails the
 * gate; docs must describe the package as built, never as planned.
 */
export const TODO_PLACEHOLDER = 'TODO'

/** One unmet documentation requirement. */
export interface DocProblem {
  package: string
  file: string
  problem: 'missing' | 'placeholder' | 'empty'
}

/** Locate the repository root from this script's own location. */
function repoRoot(): string {
  return resolve(import.meta.dirname, '..')
}

/**
 * List the package directories to check.
 * @param root repository root.
 * @param only optional filter: a package directory name or its npm name.
 * @returns absolute package directory paths, sorted.
 */
export function listPackages(root: string, only?: string): string[] {
  const packagesDir = join(root, 'packages')
  const names = readdirSync(packagesDir).filter((entry) => {
    return statSync(join(packagesDir, entry)).isDirectory()
  })
  const selected = only
    ? names.filter((name) => name === only || `@argus-agent/${name.replace(/^ops-/, '')}` === only)
    : names
  return selected.sort().map((name) => join(packagesDir, name))
}

/**
 * Check one package's documentation set.
 * @param packageDir absolute package directory.
 * @returns every unmet requirement for that package.
 */
export function checkPackage(packageDir: string): DocProblem[] {
  const name = packageDir.split('/').pop() ?? packageDir
  const problems: DocProblem[] = []
  for (const relative of REQUIRED_DOC_FILES) {
    const path = join(packageDir, relative)
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      problems.push({ package: name, file: relative, problem: 'missing' })
      continue
    }
    if (content.trim().length === 0) {
      problems.push({ package: name, file: relative, problem: 'empty' })
      continue
    }
    if (content.includes(TODO_PLACEHOLDER)) {
      problems.push({ package: name, file: relative, problem: 'placeholder' })
    }
  }
  return problems
}

/**
 * Check every selected package.
 * @param root repository root.
 * @param only optional single-package filter.
 * @returns every unmet requirement across the selection.
 */
export function checkAll(root: string, only?: string): DocProblem[] {
  return listPackages(root, only).flatMap((dir) => checkPackage(dir))
}

/**
 * Whether this checkout carries the documentation.
 *
 * The Markdown documentation is kept on the maintainer's machine and is not in the
 * public repository (`.gitignore`). A public clone has none of it, so there is
 * nothing to check — and failing there would fail every clone's `pnpm test`.
 * @param root repository root.
 * @returns whether the local documentation is present.
 */
export function hasLocalDocs(root: string): boolean {
  return existsSync(join(root, 'docs', 'developer-docs.md'))
}

function main(): void {
  const root = repoRoot()
  if (!hasLocalDocs(root)) {
    console.log('check-docs: skipped — the documentation is local-only and not in this checkout')
    return
  }
  const only = process.argv[2]
  const packages = listPackages(root, only)
  if (packages.length === 0) {
    console.error(`check-docs: no packages matched ${only ?? '<all>'}`)
    process.exit(1)
  }
  const problems = checkAll(root, only)
  if (problems.length === 0) {
    console.log(`check-docs: OK (${packages.length} package(s), ${REQUIRED_DOC_FILES.length} files each)`)
    return
  }
  console.error(`check-docs: ${problems.length} problem(s)\n`)
  for (const problem of problems) {
    const detail =
      problem.problem === 'missing'
        ? 'missing'
        : problem.problem === 'empty'
          ? 'empty'
          : `contains the "${TODO_PLACEHOLDER}" placeholder`
    console.error(`  packages/${problem.package}/${problem.file}: ${detail}`)
  }
  console.error('\nEvery package must document itself before it can be considered done.')
  process.exit(1)
}

if (import.meta.filename === process.argv[1]) main()
