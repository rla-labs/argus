// == ARGUS AGENT PROJECT ==
// Build argus-netlock (network: proxy) into lib/bin with the host's C compiler, static when
// it can be. Without a compiler the build goes on: `argus doctor` says the helper is
// missing and servers with `network: proxy` start with the network, warned about.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'lib', 'bin', 'argus-netlock')
const source = join(root, 'native', 'argus-netlock.c')
mkdirSync(dirname(out), { recursive: true })
rmSync(out, { force: true })
let failure = ''
for (const flags of [['-static'], []]) {
  try {
    execFileSync('cc', ['-O2', '-Wall', ...flags, '-o', out, source], { stdio: ['ignore', 'ignore', 'pipe'] })
    process.exit(0)
  } catch (error) {
    // The next way, or none; the last reason is shown.
    failure = String(error.stderr ?? error.message).trim()
  }
}
console.warn(`argus-netlock was not built; servers with network: proxy will run with the network (argus doctor warns): ${failure.split('\n').slice(0, 5).join(' | ')}`)
