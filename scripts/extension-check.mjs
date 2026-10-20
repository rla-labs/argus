// == ARGUS AGENT PROJECT ==
// The extension check `pnpm test:docker-extensions` and `pnpm test:native-vps` run, as
// the service's user: node extension-check.mjs <app root> <data dir> <repository>.
// Each extension in a folder of <repository> is installed as /ext install <repository>#<folder> does (confined, with the
// network), enabled in a project, and its test/smoke.sh run in that project's folder,
// confined; a project that did not enable it must not reach its programs.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const [app, data, repository] = process.argv.slice(2)
const require = createRequire(`${app}/packages/argus-agent/lib/sandbox-row.js`)
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { default: ArgusSandbox } = await import(`${app}/packages/argus-agent/lib/sandbox-row.js`)
const { Extensions, parseProjectConfig } = await import(`${app}/packages/ops-projects/lib/index.js`)

const sandbox = new ArgusSandbox(new Context())
let failed = 0
const check = (what, ok, detail = '') => { console.log(`${ok ? '  ok' : ' err'} ${what}${ok || detail === '' ? '' : `\n${detail}`}`); if (!ok) failed = 1 }

const extensions = new Extensions(`${data}/extensions`, async (argv, root) => (await sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: root })).argv)
// What ops-projects tells the sandbox for a project's folder, by hand: no harness here.
const extrasByRoot = new Map()
sandbox.setWorkspaceExtras((root) => extrasByRoot.get(root))
const shell = async (cwd, command) => {
  const { argv } = await sandbox.confine(['sh', '-c', command], { mode: 'workspace-write', workspaceRoot: cwd })
  const out = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 300_000 })
  return { code: out.status, text: `${out.stdout}${out.stderr}` }
}

// A copy the ops user owns: git refuses a repository another user owns.
const copy = `${data}/ext-src`
cpSync(repository, copy, { recursive: true })
for (const name of readdirSync(copy).filter((folder) => existsSync(`${copy}/${folder}/extension.yaml`))) {
  console.log(`== ${name}`)
  const started = Date.now()
  let entry
  try {
    entry = await extensions.install((await extensions.fetch(`${copy}#${name}`, null)).id, 'test')
  } catch (error) {
    check(`${name} installs, confined`, false, error.message)
    continue
  }
  check(`${name} installs, confined (${Math.round((Date.now() - started) / 1000)} s)`, extensions.verify().length === 0)
  const usable = extensions.usable().get(entry.name)
  const project = parseProjectConfig({ id: 'site', cwd: `${data}/projects/${entry.name}-site`, provider: 'p', model: 'm', extensions: [entry.name] }, { sourcePath: 's', projectsRoot: `${data}/projects`, extensions: new Map([[entry.name, usable]]) })
  const enabled = project.extensions[0]
  mkdirSync(project.cwd, { recursive: true })
  extrasByRoot.set(project.cwd, { reads: [enabled.dir], path: enabled.binDir === null ? [] : [enabled.binDir], env: enabled.env })
  const smoke = await shell(project.cwd, `sh ${enabled.dir}/test/smoke.sh`)
  check(`${entry.name}: its smoke test passes in a project that enabled it`, smoke.code === 0, smoke.text)
  const other = `${data}/projects/${entry.name}-other`
  mkdirSync(other, { recursive: true })
  for (const program of usable.manifest.bin.map((path) => path.split('/').pop())) {
    const byName = await shell(other, `${program} --version`)
    const byPath = await shell(other, `${enabled.binDir}/${program} --version`)
    check(`${entry.name}: ${program} is out of reach of a project that did not enable it`, byName.code !== 0 && byPath.code !== 0, `${byName.text}\n${byPath.text}`)
  }
}

console.log()
console.log(failed ? 'extension check: FAILED' : 'extension check: PASSED')
process.exit(failed)
